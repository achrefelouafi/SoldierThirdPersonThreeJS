import { Group, PointLight } from 'three';

import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import { copyColor } from '../utils/color.js';
import { Easing, smoothstep } from '../utils/math.js';
import { HolyEmbers } from './HolyEmbers.js';
import { LightPillar } from './LightPillar.js';
import { ManifestBurst } from './ManifestBurst.js';
import { RadiantRibbons } from './RadiantRibbons.js';
import { SummonSeal } from './SummonSeal.js';

/**
 * Ascendance: the light comes down and stays on you.
 *
 * ## The one ability that is not aimed at anybody
 *
 * Every other thing on the `術` panel is pointed at a body — three cuts thrown
 * at one, a column of void brought up through one. This is the opposite
 * and is the reason it exists: it is cast on *yourself*, it
 * hits nothing, and what it leaves behind is ten seconds in which everything
 * else in the game is better. So it is the only move in the project whose
 * payload is a *duration* rather than an impact, and the only one whose effect
 * is felt through the other moves rather than on its own.
 *
 * ## Five layers, and why each of them is there
 *
 * The effect is built the way a stylised summon is built anywhere — as separate
 * passes that read as one event only because they are on the same beat:
 *
 *  1. **the sigil** (`vfx/SummonSeal.js`, the same circle the fist comes
 *     through, lying on the floor instead of hanging in the air) — the ground
 *     answering first. Nothing is allowed to come down until something has said
 *     where.
 *  2. **the pillar** (`vfx/LightPillar.js`) — a shaft out of the sky, arriving.
 *     This is the event itself; everything before it is anticipation and
 *     everything after it is consequence.
 *  3. **the ribbons** (`vfx/RadiantRibbons.js`) — trails winding up the column
 *     for as long as the boon is up. They are the layer that says the effect is
 *     *ongoing* rather than something that happened a moment ago, which is the
 *     hardest thing for a ten-second buff to say.
 *  4. **the burst** (`vfx/ManifestBurst.js`) — one frame of white on the floor,
 *     the moment the shaft lands.
 *  5. **the embers** (`vfx/HolyEmbers.js`) — motes rising the whole time. The
 *     loose layer between the four hard-edged ones.
 *
 * Plus a light, which is not a layer but is the only part of it that touches
 * anything else in the scene: the body standing in the column is lit by it.
 *
 * ## The beats
 *
 *  - **gather** — the sigil writes itself at the feet, one turn of the circle.
 *  - **descend** — the shaft comes down out of the sky, accelerating.
 *  - **the frame it lands** — the burst, a spray of embers, the flash, and the
 *    boon itself. Everything on one frame, because that is the only way any of
 *    it reads.
 *  - **hold** — `duration` seconds. This is the ability. The column stands, the
 *    ribbons climb, the sigil turns, and it all travels with the body.
 *  - **fade** — the shaft is drawn back up into the sky and the circle folds.
 *
 * ## What it owns, and what it does not
 *
 * It owns five layers, a light and a clock. It does **not** own what the boon
 * *does*: `power` is a number between 0 and 1 and `core/App.js` is what spends
 * it — on the pace of the body and on the weight of its blows. Nothing here
 * knows the character exists past where it is standing.
 */
export class Ascendance {
  /**
   * @param {object} [options]
   * @param {{uniforms: object}|null} [options.terrain] the height field the
   *   sigil and the burst lie on
   * @param {((shake: number) => void)|null} [options.onManifest] the frame the
   *   light lands — the lens is knocked from here
   * @param {(() => void)|null} [options.onExpire] the frame the boon runs out
   */
  constructor({ terrain = null, onManifest = null, onExpire = null } = {}) {
    this.terrain = terrain;
    this.onManifest = onManifest;
    this.onExpire = onExpire;

    /** Everything it is, in world space. Add it to the scene. */
    this.group = new Group();
    this.group.name = 'Ascendance';

    // The same seal the fist comes through, bound to the height field: this one
    // is drawn on the floor at somebody's feet rather than hung over their head.
    this.seal = new SummonSeal({ terrain });
    this.pillar = new LightPillar();
    this.ribbons = new RadiantRibbons();
    this.flash = new ManifestBurst({ terrain });
    this.embers = new HolyEmbers();
    this.group.add(
      this.seal.mesh,
      this.pillar.mesh,
      this.ribbons.mesh,
      this.flash.mesh,
      this.embers.mesh
    );

    // The only part of the ability that touches the rest of the scene. It rides
    // at chest height so the body in the column is lit from inside it rather
    // than uplit off the floor, and it never casts — a shadow map re-rendered
    // for ten seconds of a light this small costs more than the five layers put
    // together.
    this.light = new PointLight(0xffc861, 0, 10, 1.8);
    this.light.name = 'AscendanceLight';
    this.light.castShadow = false;
    this.light.layers.set(LAYER.WORLD);
    this.group.add(this.light);

    /** @type {'idle'|'gather'|'descend'|'hold'|'fade'} */
    this.state = 'idle';
    /** Seconds in the current state. */
    this.timer = 0;

    /** Where the column stands, re-read every frame — the boon travels. */
    this._x = 0;
    this._y = 0;
    this._z = 0;
    /** The body's height, for where the light hangs. */
    this._height = 1.8;

    /** What is left of the white from the moment it landed, 0..1. */
    this._landFlash = 0;
    /**
     * How much of the circle was drawn last frame.
     *
     * Only the outro reads it, and only because the ability can be cancelled
     * *during* the write: a seal that snapped to fully drawn on the frame it
     * was told to fold would be the one moment in the move that looked wrong.
     */
    this._open = 1;
    /**
     * And how far down the shaft had come.
     *
     * Same reason, and the more visible of the two: the ability can be
     * cancelled during the gather, when there is no shaft at all, and an outro
     * that started its retraction from 1 would answer a cancel by dropping a
     * full column out of the sky and then pulling it back up.
     */
    this._head = 0;
    /**
     * Whether the boon was ever actually granted.
     *
     * The outro is played by a cancel as well as by the clock running out, and
     * a cancel during the gather never reached the light. Without this the
     * player would be handed a second of haste for a press they took back.
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
    return 1 - Math.min(1, this.timer / Math.max(1e-3, settings.ascendance.beats.fade));
  }

  /** Seconds of the boon left, for the chip that counts them down. */
  get remaining() {
    if (this.state !== 'hold') return 0;
    return Math.max(0, settings.ascendance.duration - this.timer);
  }

  /* ------------------------------------------------------------------ */

  /**
   * Call it down on yourself.
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
    if (this.active || !settings.ascendance.enabled) return false;

    this._x = x;
    this._y = y;
    this._z = z;

    // A different circle and a different set of streaks every time. It costs
    // two numbers and it is the whole difference between an ability and a clip.
    this.seal.reseed();
    this.pillar.reseed();
    this.ribbons.reseed();

    this._landFlash = 0;
    this._granted = false;
    this._open = 0;
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
    // Whatever it was doing, it is now going away. From the gather that means
    // an unfinished circle folding, which is the right answer to a cancel.
    this._enter('fade');
  }

  /** Everything off, now. */
  _clear() {
    this.seal.clear();
    this.pillar.clear();
    this.ribbons.clear();
    this.flash.clear();
    this.embers.clear();
    this.light.intensity = 0;
    this._landFlash = 0;
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
    const config = settings.ascendance;

    // Both of these outlive the ability by a second or two, so they are driven
    // whether or not it is up — and they sit either side of the beat for the
    // same reason the fist's dust does. The embers have to be synced *before*
    // anything can emit into them, or a mote born by this frame's landing is
    // stamped with a clock the shader has not been given yet; the burst has to
    // be aged *after*, or one opened by that same landing is not drawn until
    // the next frame.
    this.embers.sync(elapsed, config.embers);

    if (this.active) {
      // The column belongs to the body, not to the ground it was cast on: it
      // travels, which is what makes a ten-second buff something you fight
      // inside rather than something you stand still in.
      this._x = position.x;
      this._y = groundY;
      this._z = position.z;
      this._height = height;
    }

    this._advance(dt, elapsed, config);
    this.flash.update(dt, config.burst);
  }

  /** The beat itself. Everything with a clock in it is in here. */
  _advance(dt, elapsed, config) {
    if (!this.active) {
      this.seal.update(config.sigil, { fade: 0, scale: 0 }, elapsed);
      this.pillar.update(config.pillar, { fade: 0, head: 0 }, elapsed);
      this.ribbons.update(config.ribbons, { fade: 0, scale: 0 }, elapsed);
      this.light.intensity = 0;
      return;
    }

    this.timer += dt;

    const beats = config.beats;
    /** 0..1 through the current beat. */
    const t = (seconds) => Math.min(1, this.timer / Math.max(1e-3, seconds));

    /** The sigil. */
    let open = 1;
    let sealScale = 1;
    let charge = 0;
    /** The shaft. */
    let head = 0;
    let width = 1;
    let pillarFade = 1;
    /** The ribbons. */
    let ribbonFade = 0;
    let ribbonScale = 1;
    /** Motes a second off the floor. */
    let emberRate = 0;
    /** Master on the light. */
    let glow = 0;

    switch (this.state) {
      case 'gather': {
        const u = t(beats.gather);
        // The circle is *written*, one turn, anticlockwise from the top, and it
        // irises out on the same beat — so it arrives in the order a hand would
        // have struck it (`vfx/SummonSeal.js`).
        open = u;
        sealScale = Easing.outBack(u);
        charge = u * 0.4;
        // A few motes lifting already, so the ground is doing something before
        // the sky answers. Nothing else is on screen yet.
        emberRate = config.embers.gatherRate * u;
        ribbonFade = 0;
        glow = u * 0.35;
        // And the sky has already started to answer, well above the frame.
        //
        // The descent has to be split across two beats or it cannot be seen at
        // all: the lens sees about four metres of air over the body's head, so
        // a shaft that covers its whole height inside `descend` spends all but
        // the last fraction of that beat above the top of the screen. So the
        // far half of the fall is made part of the *gather* — faint, distant,
        // and mostly out of shot — and `descend` is left with only the stretch
        // that actually crosses the frame.
        head = config.pillar.gatherHead * Easing.outQuad(u);
        pillarFade = smoothstep(0.45, 1, u) * 0.45;
        if (u >= 1) this._enter('descend');
        break;
      }

      case 'descend': {
        const u = t(beats.descend);
        charge = 0.4 + 0.6 * u;
        // Accelerating, which is what a dropped thing does — but not `t²`, which
        // was the first thing tried and the wrong one: it spends more than half
        // the beat with the head above the top of the frame, so the light reads
        // as switching on at the last instant rather than as arriving. This is
        // the flattest curve that still accelerates.
        // Accelerating, which is what a dropped thing does. It picks up where
        // the gather left it, so the whole of this beat is the light coming
        // down *through* the shot rather than toward it.
        const from = config.pillar.gatherHead;
        head = from + (1 - from) * Math.pow(u, 1.5);
        pillarFade = 0.45 + 0.55 * Math.min(1, u * 4);
        // Widest as it arrives. The column narrows to its resting bore over the
        // first moment of the hold, which reads as the light settling.
        width = 1 + config.pillar.arrivalWidth * u;
        emberRate = config.embers.gatherRate;
        ribbonFade = Easing.outQuad(u) * 0.5;
        ribbonScale = 0.7 + 0.3 * u;
        glow = 0.35 + 0.65 * u;
        if (u >= 1) {
          this._manifest(config);
          // The landing has its own frame: everything it fires is placed from
          // `hold`'s first update rather than from the tail of this one.
          head = 1;
        }
        break;
      }

      case 'hold': {
        // Settling: the bore closes over the first moment and then it simply
        // stands, breathing, for the rest of the ten seconds.
        const settle = Math.min(1, this.timer / Math.max(1e-3, beats.settle));
        head = 1;
        width = 1 + config.pillar.arrivalWidth * (1 - Easing.outQuad(settle));
        charge = 1;
        ribbonFade = Easing.outQuad(settle);
        emberRate = config.embers.rate;
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
        // However much of it had been struck when it was told to fold.
        open = this._open;
        // Drawn back up into the sky rather than dimmed: the front rises from
        // the floor, which is the descent run backwards and the only reading
        // that says the light *left* rather than that it was switched off.
        head = this._head * (1 - Easing.inCubic(u));
        width = 1 - 0.35 * u;
        charge = inv * 0.6;
        sealScale = 1 - Easing.inCubic(u);
        ribbonFade = inv;
        ribbonScale = 1 - 0.25 * u;
        // Nothing new off the floor. What is already in the air lives out its
        // own life, which is what leaves the ground still glittering for a
        // moment after the column has gone.
        emberRate = 0;
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

    this._landFlash = Math.max(
      0,
      this._landFlash - dt / Math.max(0.02, config.pillar.flashTime)
    );

    this._open = open;
    // Only outside the outro: inside it these are what the outro is reading.
    if (this.state !== 'fade') this._head = head;

    /* ---- place, and dress ---- */
    this.seal.place(this._x, this._y + config.sigil.lift, this._z);
    this.pillar.place(this._x, this._y, this._z);
    this.ribbons.place(this._x, this._y, this._z);

    this.seal.update(config.sigil, { open, scale: sealScale, charge, fade: 1 }, elapsed);
    this.pillar.update(
      config.pillar,
      // Squared, so the white is gone by the frame after the one it landed on.
      // A linear decay on something this bright reads as the shaft cooling.
      { head, width, flash: this._landFlash * this._landFlash, fade: pillarFade },
      elapsed
    );
    this.ribbons.update(config.ribbons, { fade: ribbonFade, charge, scale: ribbonScale }, elapsed);

    if (emberRate > 0) {
      this.embers.emit(
        this._x,
        this._y,
        this._z,
        config.sigil.radius * config.embers.spread,
        emberRate,
        dt,
        config.embers
      );
    }

    this._syncLight(config, glow);
  }

  /**
   * The frame the light lands.
   *
   * Everything that says "that happened" fires from here, together, because
   * together is the only way any of it reads: the floor, the air, the flash and
   * the lens. And the boon starts on this frame rather than on the cast, which
   * is what makes the descent a *cost* — the ten seconds are bought with the
   * second of standing still that pays for them.
   */
  _manifest(config) {
    this.flash.burst(this._x, this._y, this._z, config.burst);
    this.embers.spray(
      this._x,
      this._y,
      this._z,
      config.sigil.radius * config.embers.spread,
      config.embers.burst,
      config.embers,
      1.6
    );
    this._landFlash = 1;
    this._granted = true;
    this.onManifest?.(config.shake);
    this._enter('hold');
  }

  /**
   * The light, doing the one job nothing else here can.
   *
   * Every layer of this ability is additive and lights nothing; the body
   * standing in the middle of them would be exactly as dark as it was before
   * the sky opened. This is what puts the gold on it. It rides at chest height
   * so the light comes from *inside* the column rather than off the floor.
   */
  _syncLight(config, glow) {
    const light = config.light;
    copyColor(this.light.color, light.color);
    this.light.distance = light.distance;
    this.light.decay = light.decay;
    this.light.position.set(
      this._x,
      this._y + this._height * light.height,
      this._z
    );
    this.light.intensity =
      light.intensity * Math.max(0, glow) + light.flash * this._landFlash * this._landFlash;
  }

  /** Move into a state, and start its clock. */
  _enter(state) {
    this.state = state;
    this.timer = 0;
  }

  dispose() {
    this.seal.dispose();
    this.pillar.dispose();
    this.ribbons.dispose();
    this.flash.dispose();
    this.embers.dispose();
    this.group.parent?.remove(this.group);
  }
}
