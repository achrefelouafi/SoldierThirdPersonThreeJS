import { Group, PointLight } from 'three';

import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import { copyColor } from '../utils/color.js';
import { Easing } from '../utils/math.js';
import { DarkPillar } from './DarkPillar.js';
import { DistortionRings } from './DistortionRings.js';
import { ShadowPool } from './ShadowPool.js';
import { ShadowSwirl } from './ShadowSwirl.js';
import { SmokeWisps } from './SmokeWisps.js';

/**
 * Shadow Boost: the dark comes up and stays on you.
 *
 * ## The other self-cast, and why it is not the first one recoloured
 *
 * `vfx/Ascendance.js` is the light: it is called *down* out of the sky, it is
 * gold, it is drawn in clean hard-edged geometry — a struck circle, a shaft, a
 * fan of petals — and it is bright everywhere. This is its opposite in every
 * one of those, on purpose, because two self-cast boons that differ only by a
 * colour picker are one ability with a bug:
 *
 *  - it comes **up out of the floor** rather than down out of the sky;
 *  - its silhouette is **soft** — smoke, not glass;
 *  - and its middle is **darker than the world behind it**, which no additive
 *    effect in this project has ever been.
 *
 * That last one is the whole engineering problem. See `vfx/DarkPillar.js` and
 * `vfx/ShadowSwirl.js` for how it is paid for: two of the five layers are on
 * `NormalBlending` and lie over the frame rather than adding to it, and the
 * three that do add are what the dark is dark *against*.
 *
 * ## Five layers, and why each of them is there
 *
 * Read the reference this is built from and it is five stacked passes; this is
 * those five, in the order they are drawn:
 *
 *  1. **the base glow** (`vfx/ShadowPool.js`) — a soft violet pool on the
 *     floor. It has no shape at all, and that is its job: it is the light
 *     source the other four are seen against.
 *  2. **the ground distortion** (`vfx/DistortionRings.js`) — concentric fronts
 *     running outward, each with a dark trough behind it so the floor reads as
 *     standing up in rings rather than being drawn on.
 *  3. **the dark energy column** (`vfx/DarkPillar.js`) — the event itself. Two
 *     tubes: one that darkens, one that crackles.
 *  4. **the rising wisps** (`vfx/SmokeWisps.js`) — slow curling smoke, the
 *     layer that says the effect is *ongoing* rather than something that
 *     happened a moment ago. That is the hardest thing for a timed buff to say.
 *  5. **the swirling shadow** (`vfx/ShadowSwirl.js`) — torn puffs going round
 *     the body, fast and horizontal against the wisps' slow vertical.
 *
 * Plus a light, which is not a layer but is the only part of this that touches
 * anything else in the scene: the body standing in the column is rimmed by it.
 *
 * ## The beats
 *
 *  - **gather** — the pool opens at the feet and the ground starts to ring.
 *    Nothing has come up yet.
 *  - **erupt** — the column tears up out of the floor, fast.
 *  - **the frame it breaks through** — the flash, a burst of shadow thrown
 *    outward, the knock on the lens, and the boon itself. All on one frame,
 *    because that is the only way any of it reads.
 *  - **hold** — `duration` seconds. This is the ability. The column stands, the
 *    wisps climb, the shadow goes round, and all of it travels with the body.
 *  - **fade** — the column is drawn back down into the ground it came out of.
 *
 * ## What it owns, and what it does not
 *
 * Five layers, a light and a clock. It does **not** own what the boon *does*:
 * `power` is a number between 0 and 1 and `core/App.js` is what spends it — on
 * the pace of the body and on the weight of its blows, alongside the light's
 * own. Nothing here knows the character exists past where it is standing.
 */
export class ShadowBoost {
  /**
   * @param {object} [options]
   * @param {{uniforms: object}|null} [options.terrain] the height field the
   *   pool and the rings lie on
   * @param {((shake: number) => void)|null} [options.onErupt] the frame the
   *   column breaks through — the lens is knocked from here
   * @param {(() => void)|null} [options.onExpire] the frame the boon runs out
   */
  constructor({ terrain = null, onErupt = null, onExpire = null } = {}) {
    this.terrain = terrain;
    this.onErupt = onErupt;
    this.onExpire = onExpire;

    /** Everything it is, in world space. Add it to the scene. */
    this.group = new Group();
    this.group.name = 'ShadowBoost';

    this.pool = new ShadowPool({ terrain });
    this.rings = new DistortionRings({ terrain });
    this.column = new DarkPillar();
    this.wisps = new SmokeWisps();
    this.swirl = new ShadowSwirl();
    this.group.add(
      this.pool.mesh,
      this.rings.mesh,
      // Two meshes, so this one hands over a group rather than a mesh.
      this.column.group,
      this.wisps.mesh,
      this.swirl.mesh
    );

    // The only part of the ability that touches the rest of the scene. It rides
    // at chest height so the body is lit from inside the column rather than
    // uplit off the floor, and it never casts — a shadow map re-rendered for
    // ten seconds of a light this small costs more than the five layers put
    // together.
    //
    // A dark aura still needs one. Without it the character standing in the
    // middle of this is exactly as dark as they were before it started, and the
    // effect reads as happening behind them.
    this.light = new PointLight(0x7c4dff, 0, 10, 1.8);
    this.light.name = 'ShadowBoostLight';
    this.light.castShadow = false;
    this.light.layers.set(LAYER.WORLD);
    this.group.add(this.light);

    /** @type {'idle'|'gather'|'erupt'|'hold'|'fade'} */
    this.state = 'idle';
    /** Seconds in the current state. */
    this.timer = 0;

    /** Where the column stands, re-read every frame — the boon travels. */
    this._x = 0;
    this._y = 0;
    this._z = 0;
    /** The body's height, for where the light hangs. */
    this._height = 1.8;

    /** What is left of the white from the moment it broke through, 0..1. */
    this._breakFlash = 0;
    /**
     * And how far up the column had come.
     *
     * Only the outro reads it, and only because the ability can be cancelled
     * *during* the eruption: an outro that started its retraction from 1 would
     * answer a cancel by throwing a full column out of the ground and then
     * pulling it back down.
     */
    this._head = 0;
    /**
     * Whether the boon was ever actually granted.
     *
     * The outro is played by a cancel as well as by the clock running out, and
     * a cancel during the gather never reached the eruption. Without this the
     * player would be handed a second of the boon for a press they took back.
     */
    this._granted = false;
  }

  /** Whether anything of the ability is on screen. */
  get active() {
    return this.state !== 'idle';
  }

  /** Whether the *boon* is up — which is not the same as anything being drawn. */
  get held() {
    return this.state === 'hold' || (this.state === 'fade' && this._granted);
  }

  /**
   * How much of the boon is in force, 0..1.
   *
   * Full for the whole hold and running out over the fade rather than switching
   * off, because the two things it is spent on are the body's *pace* and the
   * weight of its blows — and a walk that drops from a sprint to a stroll on one
   * frame reads as a bug in the controller rather than as a buff ending.
   */
  get power() {
    if (this.state === 'hold') return 1;
    if (this.state !== 'fade' || !this._granted) return 0;
    return 1 - Math.min(1, this.timer / Math.max(1e-3, settings.shadowBoost.beats.fade));
  }

  /** Seconds of the boon left, for the chip that counts them down. */
  get remaining() {
    if (this.state !== 'hold') return 0;
    return Math.max(0, settings.shadowBoost.duration - this.timer);
  }

  /* ------------------------------------------------------------------ */

  /**
   * Call it up under yourself.
   *
   * Refused while anything of it is still on screen — including the fade, which
   * is deliberate: a second cast during the outro would leave two columns
   * arguing over one body, and the answer to "can I re-up early" should be the
   * same every time it is asked.
   *
   * @param {number} x world, where the body is standing
   * @param {number} y the ground under it
   * @param {number} z
   * @returns {boolean} whether it started
   */
  cast(x, y, z) {
    if (this.active || !settings.shadowBoost.enabled) return false;

    this._x = x;
    this._y = y;
    this._z = z;

    // A different set of veins, wisps and warps every time. It costs four
    // numbers and it is the whole difference between an ability and a clip.
    this.pool.reseed();
    this.rings.reseed();
    this.column.reseed();
    this.wisps.reseed();

    this._breakFlash = 0;
    this._granted = false;
    this._head = 0;
    this._enter('gather');
    return true;
  }

  /**
   * Send it away.
   *
   * @param {object} [options]
   * @param {boolean} [options.immediate] skip the outro — for leaving the stage,
   *   where there is nothing on screen for an outro to play over
   */
  dismiss({ immediate = false } = {}) {
    if (!this.active) return;
    if (immediate) {
      this._enter('idle');
      this._clear();
      return;
    }
    // Whatever it was doing, it is now going away. From the gather that means a
    // pool closing with nothing ever having come up out of it, which is the
    // right answer to a cancel.
    this._enter('fade');
  }

  /** Everything off, now. */
  _clear() {
    this.pool.clear();
    this.rings.clear();
    this.column.clear();
    this.wisps.clear();
    this.swirl.clear();
    this.light.intensity = 0;
    this._breakFlash = 0;
    this._granted = false;
  }

  /* ------------------------------------------------------------------ */
  /* the frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number} dt seconds, on the simulation's clock — the boon is combat,
   *   so it slows with the hit-stop of the blows it is making heavier
   * @param {number} elapsed the shared clock, for everything that turns
   * @param {{x: number, y: number, z: number}} position where the body is
   * @param {number} groundY the floor under it
   * @param {number} height the body's own height, for where the light hangs
   */
  update(dt, elapsed, position, groundY, height = 1.8) {
    const config = settings.shadowBoost;

    // The swirl outlives the ability by a second or two, so it is driven
    // whether or not it is up — and it is synced *before* anything can emit
    // into it, or a puff born by this frame's eruption is stamped with a clock
    // the shader has not been given yet.
    this.swirl.sync(elapsed, config.swirl);

    if (this.active) {
      // The column belongs to the body, not to the ground it was cast on: it
      // travels, which is what makes a timed buff something you fight inside
      // rather than something you stand still in.
      this._x = position.x;
      this._y = groundY;
      this._z = position.z;
      this._height = height;
    }

    this._advance(dt, elapsed, config);
  }

  /** The beat itself. Everything with a clock in it is in here. */
  _advance(dt, elapsed, config) {
    if (!this.active) {
      this.pool.update(config.glow, { fade: 0, scale: 0 }, elapsed);
      this.rings.update(config.rings, { fade: 0, scale: 0 }, elapsed);
      this.column.update(config.column, { fade: 0, head: 0 }, elapsed);
      this.wisps.update(config.wisps, { fade: 0, scale: 0 }, elapsed);
      this.light.intensity = 0;
      return;
    }

    this.timer += dt;

    const beats = config.beats;
    /** 0..1 through the current beat. */
    const t = (seconds) => Math.min(1, this.timer / Math.max(1e-3, seconds));

    /** The pool and the rings on the floor. */
    let groundFade = 0;
    let groundScale = 1;
    /** The column. */
    let head = 0;
    let width = 1;
    let edge = 0;
    /** The wisps. */
    let wispFade = 0;
    let wispScale = 1;
    /** Puffs a second into the vortex. */
    let swirlRate = 0;
    /** Master on the light. */
    let glow = 0;

    switch (this.state) {
      case 'gather': {
        const u = t(beats.gather);
        // The floor answers first. Nothing is allowed to come up until
        // something has said where — the same rule the light's seal follows,
        // arrived at from the other end.
        groundFade = Easing.outQuad(u);
        groundScale = Easing.outBack(u);
        // A few puffs already turning, so the air is doing something before the
        // ground opens.
        swirlRate = config.swirl.gatherRate * u;
        wispFade = u * 0.35;
        wispScale = 0.6 + 0.4 * u;
        glow = u * 0.4;
        if (u >= 1) this._enter('erupt');
        break;
      }

      case 'erupt': {
        const u = t(beats.erupt);
        groundFade = 1;
        // Fast out of the floor and slowing as it reaches its height — the
        // opposite curve to the light's descent, which accelerates. A thing
        // *thrown* out of the ground has all its speed at the start.
        head = Easing.outCubic(u);
        // Widest as it comes through. The column closes to its resting bore
        // over the first moment of the hold, which reads as it settling.
        width = 1 + config.column.arrivalWidth * (1 - u * 0.35);
        // The hot lip riding the top of the column while it is still climbing.
        edge = 1 - u * 0.35;
        swirlRate = config.swirl.gatherRate + (config.swirl.rate - config.swirl.gatherRate) * u;
        wispFade = 0.35 + 0.4 * u;
        wispScale = 1;
        glow = 0.4 + 0.6 * u;
        if (u >= 1) {
          this._erupt(config);
          // The break-through has its own frame: everything it fires is placed
          // from `hold`'s first update rather than from the tail of this one.
          head = 1;
        }
        break;
      }

      case 'hold': {
        // Settling: the bore closes over the first moment and then it simply
        // stands, breathing, for the rest of the duration.
        const settle = Math.min(1, this.timer / Math.max(1e-3, beats.settle));
        head = 1;
        width = 1 + config.column.arrivalWidth * 0.65 * (1 - Easing.outQuad(settle));
        edge = 0;
        groundFade = 1;
        wispFade = 1;
        swirlRate = config.swirl.rate;
        glow = 1;
        // And the last second announces itself: the column pulses harder as the
        // boon runs down, so the player is told it is going rather than finding
        // out when their blows stop landing as hard.
        const left = config.duration - this.timer;
        if (left <= config.warn && config.warn > 0) {
          const warn = 1 - Math.max(0, left) / config.warn;
          glow *= 1 + 0.5 * warn * (0.5 - 0.5 * Math.cos(elapsed * 22));
        }
        if (this.timer >= config.duration) {
          this.onExpire?.();
          this._enter('fade');
        }
        break;
      }

      case 'fade': {
        const u = t(beats.fade);
        const inv = 1 - u;
        // Drawn back *down* into the ground rather than dimmed: the head sinks
        // to the floor, which is the eruption run backwards and the only
        // reading that says the dark went back where it came from.
        head = this._head * (1 - Easing.inCubic(u));
        width = 1 - 0.3 * u;
        edge = 0;
        groundFade = inv;
        groundScale = 1 - 0.35 * Easing.inCubic(u);
        wispFade = inv * inv;
        wispScale = 1 - 0.2 * u;
        // Nothing new into the vortex. What is already turning lives out its
        // own life, which is what leaves shadow drifting off the ground for a
        // moment after the column has gone.
        swirlRate = 0;
        glow = inv;
        if (u >= 1) {
          this._enter('idle');
          this._clear();
          return;
        }
        break;
      }

      default:
        break;
    }

    this._breakFlash = Math.max(0, this._breakFlash - dt / Math.max(0.02, config.column.flashTime));
    // Only outside the outro: inside it this is what the outro is reading.
    if (this.state !== 'fade') this._head = head;

    /* ---- place, and dress ---- */
    this.pool.place(this._x, this._y, this._z);
    this.rings.place(this._x, this._y, this._z);
    this.column.place(this._x, this._y, this._z);
    this.wisps.place(this._x, this._y, this._z);

    // Squared, so the white is gone by the frame after the one it broke through
    // on. A linear decay on something this bright reads as the column cooling.
    const flash = this._breakFlash * this._breakFlash;

    this.pool.update(config.glow, { fade: groundFade, scale: groundScale, flash }, elapsed);
    this.rings.update(
      config.rings,
      { fade: groundFade, scale: groundScale, punch: flash },
      elapsed
    );
    this.column.update(config.column, { head, width, flash, edge, fade: 1 }, elapsed);
    this.wisps.update(config.wisps, { fade: wispFade, scale: wispScale }, elapsed);

    if (swirlRate > 0) {
      this.swirl.emit(
        this._x,
        this._y,
        this._z,
        config.glow.radius * config.swirl.spread,
        swirlRate,
        dt,
        config.swirl
      );
    }

    this._syncLight(config, glow);
  }

  /**
   * The frame the column breaks through.
   *
   * Everything that says "that happened" fires from here, together, because
   * together is the only way any of it reads: the floor, the air, the flash and
   * the lens. And the boon starts on this frame rather than on the cast, which
   * is what makes the gather a *cost* — the seconds are bought with the moment
   * of standing still that pays for them.
   */
  _erupt(config) {
    this.swirl.spray(
      this._x,
      this._y,
      this._z,
      config.glow.radius * config.swirl.spread,
      config.swirl.burst,
      config.swirl,
      1.5
    );
    this._breakFlash = 1;
    this._granted = true;
    this.onErupt?.(config.shake);
    this._enter('hold');
  }

  /**
   * The light, doing the one job nothing else here can.
   *
   * Three of the five layers add and light nothing; the other two *darken*. So
   * without this the body in the middle of a column of shadow would be dimmer
   * than it was before the ability started and lit by nothing at all, which is
   * the one outcome that would make the effect read as a mistake.
   */
  _syncLight(config, glow) {
    const light = config.light;
    copyColor(this.light.color, light.color);
    this.light.distance = light.distance;
    this.light.decay = light.decay;
    this.light.position.set(this._x, this._y + this._height * light.height, this._z);
    this.light.intensity =
      light.intensity * Math.max(0, glow) + light.flash * this._breakFlash * this._breakFlash;
  }

  /** Move into a state, and start its clock. */
  _enter(state) {
    this.state = state;
    this.timer = 0;
  }

  dispose() {
    this.pool.dispose();
    this.rings.dispose();
    this.column.dispose();
    this.wisps.dispose();
    this.swirl.dispose();
    this.group.parent?.remove(this.group);
  }
}
