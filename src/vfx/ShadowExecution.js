import { Group, PointLight, Vector3 } from 'three';

import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import { copyColor } from '../utils/color.js';
import { Easing } from '../utils/math.js';
import { CinderStreaks } from './CinderStreaks.js';
import { DarkPillar } from './DarkPillar.js';
import { PhantomBlades } from './PhantomBlades.js';
import { RiteRings } from './RiteRings.js';
import { ShadowPool } from './ShadowPool.js';
import { ShadowShards } from './ShadowShards.js';
import { ShadowSwirl } from './ShadowSwirl.js';
import { SlashTrails } from './SlashTrails.js';
import { SmokeWisps } from './SmokeWisps.js';

const _at = /* @__PURE__ */ new Vector3();
const _dir = /* @__PURE__ */ new Vector3();
const _axis = /* @__PURE__ */ new Vector3();
const _centre = /* @__PURE__ */ new Vector3();
const _travel = /* @__PURE__ */ new Vector3();

/**
 * The Shadow Execution (`C`) — five katanas, one body, and nothing left.
 *
 * ## The move, from the outside
 *
 * A body is marked. The ground under it goes violet and the dark stands up out
 * of it, and out of that dark a katana resolves — then a second, then a third,
 * until five of them are **circling the body**, points inward, turning. The
 * ring winds up: it turns faster and closes in, each blade dragging a crescent
 * behind it until the body is inside a cage of them. Then all five go in **at
 * once**. They are held there while the aura tears itself apart around them,
 * and then they come out together — and what they were in comes apart into
 * violet ash on the way.
 *
 * ## Why it is not the crimson rite in another colour
 *
 * `vfx/CrimsonRite.js` is the other multi-blade finisher in this project and
 * every beat of it is deliberately the opposite of this one:
 *
 *  - **three blades against five.** Three is a set the eye counts; five is a
 *    ring it reads as a cage.
 *  - **hanging against circling.** The rite's blades are *presented* — they
 *    hold their bearings and are then used. These turn from the frame they
 *    arrive, and the turn accelerates: the body is being circled, and the wind
 *    up is the whole first half of the ability. See `PhantomBlades#_orbit`.
 *  - **one after another against all at once.** The rite's rhythm is its
 *    thrusts landing a fifth of a second apart, so the eye can count them.
 *    Here there is a single enormous impact — five points arriving on one
 *    frame, which is not three copies of one blow but a different event.
 *  - **crimson against violet, wet against dry.** The rite throws blood: the
 *    opaque, falling, *wet* layer of `vfx/BloodMist.js`. This throws
 *    `vfx/ShadowShards.js` — hard black pieces of something breaking. One is a
 *    body being opened, the other is a body being **unmade**, and the dissolve
 *    at the end is the same statement made a second time.
 *
 * ## The layers, and what each is doing
 *
 * The reference breaks the effect into six panels and then composites them.
 * These are those six, in the order the frame is painted, plus the steel:
 *
 *  1. `vfx/ShadowPool.js` — **the light on the floor.** No shape at all, and
 *     that is its whole job: it is the source everything else is seen against.
 *     Take it out and the ability is dark shapes over dark ground.
 *  2. `vfx/RiteRings.js` — **the shockwave.** The reference's third panel is
 *     not one ring: it is a train of them with the ground split into glowing
 *     radial cracks between, and the whole disc scorched. That is what says the
 *     move happened *in the world* rather than in front of it.
 *  3. `vfx/DarkPillar.js` — **the column.** The vertical. Every other layer
 *     here is flat on the floor or wrapped round the body, and without one
 *     thing standing up out of the middle the composite has no height.
 *  4. `vfx/SmokeWisps.js` — **the aura.** The reference's fourth panel: slow
 *     black plumes curling upward with violet caught inside them. The *slow*
 *     layer, and the one that says this is still happening.
 *  5. `vfx/ShadowSwirl.js` — **the torn shadow.** Fast and horizontal where the
 *     wisps are slow and vertical. Also the only other layer that subtracts.
 *  6. `vfx/ShadowShards.js` — **the shatter.** The second panel. The only thing
 *     here with mass.
 *  7. `vfx/CinderStreaks.js` — **the embers.** The sixth panel: the fine, fast,
 *     loose layer. Without something small and quick between the big shapes,
 *     six elements in one place read as six decals that happen to be adjacent.
 *  8. `vfx/SlashTrails.js` — **the crescents.** The first panel, and the layer
 *     the whole move is read off. Struck three ways: dragged behind the blades
 *     as they circle, thrown along each thrust, and opened wide on the way out.
 *  9. `vfx/PhantomBlades.js` — **the katanas.** The character's own weapon,
 *     borrowed off the equipment library, because the one thing that cannot be
 *     faked beside the real blade is the real blade.
 *
 * One light serves all nine.
 *
 * ## What this class owns, and what it does not
 *
 * The timing between the beats, and nothing else. It does not know when an
 * execution starts — that is `animation/Attack.js` reading `hits` off the
 * settings block — and it does not know what being run through costs:
 * `core/App.js` wires `onImpale` and `onSever` to the same paths every other
 * attack goes through, so a body taken by this goes down exactly as one taken
 * by anything else does. What it *does* own is the gap the animation cannot
 * express: the clip marks two frames and the move has two more impacts, both of
 * them seconds after the cast has finished, on this class's own clock.
 */
export class ShadowExecution {
  /**
   * @param {object} [options]
   * @param {{heightAt: (x: number, z: number) => number, uniforms: object}|null} [options.terrain]
   * @param {(() => import('three').Object3D|null)|null} [options.blade] where to
   *   borrow the katana from — see `vfx/PhantomBlades.js`
   * @param {((enemy: object, dirX: number, dirZ: number) => void)|null} [options.onImpale]
   *   the frame the five points arrive, on a body that is still standing
   * @param {((enemy: object, dirX: number, dirZ: number) => void)|null} [options.onSever]
   *   they came out, and the body goes with them
   * @param {((metres: number) => void)|null} [options.onShake] what the lens
   *   takes from each of the two impacts
   */
  constructor({ terrain = null, blade = null, onImpale = null, onSever = null, onShake = null } = {}) {
    this.terrain = terrain;
    this.onImpale = onImpale;
    this.onSever = onSever;
    this.onShake = onShake;

    /** Everything it is, in world space. Add it to the scene. */
    this.group = new Group();
    this.group.name = 'ShadowExecution';

    this.pool = new ShadowPool({ terrain });
    this.rings = new RiteRings({ terrain });
    this.column = new DarkPillar();
    this.wisps = new SmokeWisps();
    this.swirl = new ShadowSwirl();
    this.shards = new ShadowShards();
    this.cinders = new CinderStreaks();
    this.trails = new SlashTrails();
    this.blades = new PhantomBlades({
      source: blade,
      onPierce: (pierced) => this._onPierce(pierced)
    });

    this.group.add(
      this.pool.mesh,
      this.rings.mesh,
      // Two meshes, so the column hands over a group rather than a mesh.
      this.column.group,
      this.wisps.mesh,
      this.swirl.mesh,
      this.shards.mesh,
      this.cinders.mesh,
      this.trails.mesh,
      this.blades.group
    );

    // One light for the whole execution. Never casts: a shadow map re-rendered
    // for a light that lives three seconds costs more than all nine layers
    // above it put together, and nothing in the reference throws a shadow.
    //
    // It is also doing a job nothing else here can. Four of the nine layers
    // *darken*, and a body standing in the middle of them would otherwise be
    // dimmer than it was before the ability started — which would read as the
    // effect happening behind it rather than to it.
    this.light = new PointLight(0x8b5cff, 0, 16, 1.9);
    this.light.name = 'ShadowExecutionLight';
    this.light.castShadow = false;
    this.light.layers.set(LAYER.WORLD);
    this.group.add(this.light);

    /** @type {'idle'|'mark'|'circle'|'drive'|'pin'|'sever'|'settle'} */
    this.state = 'idle';
    /** Seconds in the current state. */
    this.timer = 0;

    /** The body this is being worked on. Held across every beat of it. */
    this._target = null;
    /** Where it was standing when the mark was struck — the floor's own ground. */
    this._ground = new Vector3();
    /** The ring's middle: the ground with `height` on it, re-read every frame. */
    this._ring = new Vector3();
    /** How many points have arrived. Five of them land on one frame. */
    this._pierced = 0;
    /** Seconds since the last crescent was dragged off a circling blade. */
    this._sinceTrail = 0;
    /** How far up the column had come, for an outro that can start anywhere. */
    this._head = 0;
    /** What is left of the light's own flash, 0..1, and where it flashed. */
    this._flash = 0;
    this._flashAt = new Vector3();

    /**
     * The gesture handed to `SlashTrails`, rebuilt per stroke.
     *
     * A scratch rather than the config object itself, because the radius of a
     * crescent dragged off a circling blade is the radius the blade is actually
     * at *now* — which the editor cannot know and must not be made to.
     */
    this._shape = {
      count: 2,
      spread: 0,
      radius: 1,
      sweep: 1,
      width: 0.3,
      life: 0.4,
      pitch: 0
    };
    /** What the ring is doing this frame, handed to `PhantomBlades#update`. */
    this._drive = { spin: 1, draw: 1, centre: this._ring };
  }

  /** Live tuning, read per frame so the editor's edits land immediately. */
  get config() {
    return settings.shadowExecution;
  }

  /** Whether anything at all is still on screen. */
  get active() {
    return this.state !== 'idle';
  }

  /* ------------------------------------------------------------------ */
  /* the beats                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * The first beat: the ground under a body goes violet, and the ring gathers.
   *
   * Nothing is hurt here and nothing is committed — this is the beat where both
   * parties know what is coming and neither can stop it. It is also where the
   * katanas *arrive*, one at a time on `blades.stagger`, and that stagger is
   * the ability's opening statement: five blades that appeared together would
   * be a formation, and five that arrive one after another are a sentence being
   * spoken.
   *
   * An execution that is still settling is interrupted rather than refused;
   * anything earlier is refused, so a second press during a beat that is still
   * happening cannot restart it.
   *
   * @param {{position: Vector3}|null} target
   * @returns {boolean} whether the mark was struck
   */
  mark(target) {
    const config = this.config;
    if (!config.enabled || !target) return false;
    if (this.state !== 'idle' && this.state !== 'settle') return false;

    this._target = target;
    this._takeGround(target);

    // A different set of wisps, veins and warps every cast. It costs four
    // numbers and it is the whole difference between an ability and a clip.
    this.pool.reseed();
    this.column.reseed();
    this.wisps.reseed();

    // The first ring is struck on the *mark* rather than on the impact, and
    // small: it is the ground being claimed, not anything landing on it.
    this.rings.burst(this._ground.x, this._ground.z, config.rings, config.markRing);

    this.blades.summon(this._ring, 0, config.blades);

    this._pierced = 0;
    this._sinceTrail = 0;
    this._head = 0;
    this._lightUp(this._ring, config.light.mark);
    this._enter('mark');
    return true;
  }

  /**
   * The second beat: the ring winds up.
   *
   * Callable from a mark that is only half gathered, and deliberately so — the
   * frame that fires this is a frame in a clip, and the clip is the authority
   * on when the hand comes down. A ring whose fifth blade is still resolving is
   * snapped into motion here, which reads as the summons being *overtaken by
   * its own urgency*. The alternative is five katanas waiting politely for
   * their own smoke.
   *
   * @param {{position: Vector3}|null} [target] re-aims it, if the body has moved
   *   since the mark was struck
   * @returns {boolean} whether anything started
   */
  cast(target = null) {
    const config = this.config;
    if (!config.enabled) return false;
    if (this.state === 'circle' || this.state === 'drive' || this.state === 'pin') return false;

    // A cast with no mark under it marks first. It costs one frame of gather
    // instead of the full beat, and it is far better than a press that does
    // nothing because a beat was missed.
    if (this.state !== 'mark') {
      if (!this.mark(target ?? this._target)) return false;
    } else if (target) {
      this._target = target;
    }
    if (!this._target) return false;

    this._enter('circle');
    return true;
  }

  /**
   * Stop it, wherever it had got to.
   *
   * @param {object} [options]
   * @param {boolean} [options.immediate] drop everything on the spot — for
   *   leaving the stage, where a settle would only be paused halfway through
   *   and resumed on the way back
   */
  dismiss({ immediate = false } = {}) {
    if (immediate) {
      this.clear();
      return;
    }
    if (!this.active || this.state === 'settle') return;
    this.blades.banish();
    this._target = null;
    this._enter('settle');
  }

  /** Everything off, immediately — for leaving the stage and for a reset. */
  clear() {
    this.state = 'idle';
    this.timer = 0;
    this._target = null;
    this._pierced = 0;
    this._sinceTrail = 0;
    this._head = 0;
    this._flash = 0;
    this.pool.clear();
    this.rings.clear();
    this.column.clear();
    this.wisps.clear();
    this.swirl.clear();
    this.shards.clear();
    this.cinders.clear();
    this.trails.clear();
    this.blades.clear();
    this.light.intensity = 0;
    this.light.visible = false;
  }

  dispose() {
    this.pool.dispose();
    this.rings.dispose();
    this.column.dispose();
    this.wisps.dispose();
    this.swirl.dispose();
    this.shards.dispose();
    this.cinders.dispose();
    this.trails.dispose();
    this.blades.dispose();
    this.group.parent?.remove(this.group);
  }

  /* ------------------------------------------------------------------ */
  /* the frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number} dt seconds, on the *simulation's* clock — the whole move is
   *   combat, so it slows with the hit-stop it causes and stops with `P`
   * @param {number} elapsed the shared clock, for the smoke's crawl and the
   *   particles' own timing
   */
  update(dt, elapsed) {
    const config = this.config;

    // Before anything can emit into them, so a particle born by this frame's
    // impact is stamped with a clock the shaders already agree with.
    this.swirl.sync(elapsed, config.swirl);
    this.shards.sync(elapsed, config.shards);
    this.cinders.sync(elapsed, config.cinders);

    this._advance(dt, elapsed, config);

    this.rings.update(dt, config.rings);
    this.trails.update(dt, elapsed, config.trails);
    this.blades.update(dt, elapsed, config.blades, this._drive);
    this._updateLight(dt, config);
  }

  /* ------------------------------------------------------------------ */

  /** The beat itself. Everything with a clock in it is in here. */
  _advance(dt, elapsed, config) {
    if (!this.active) {
      this.pool.update(config.glow, { fade: 0, scale: 0 }, elapsed);
      this.column.update(config.column, { fade: 0, head: 0 }, elapsed);
      this.wisps.update(config.wisps, { fade: 0, scale: 0 }, elapsed);
      return;
    }

    this.timer += dt;

    // The ring follows the body. A cage of blades that stayed where the body
    // used to be is the one failure that would give the whole move away, and it
    // is one line: everything downstream resolves off `_ring`.
    this._takeGround(this._target);

    const beats = config.beats;
    /** 0..1 through the current beat. */
    const t = (seconds) => Math.min(1, this.timer / Math.max(1e-3, seconds));

    /** The floor: the pool and how wide it lies. */
    let fade = 1;
    let scale = 1;
    /** The column: how far up it has come, how wide its bore, its hot lip. */
    let head = 0;
    let width = 1;
    let edge = 0;
    /** The aura. */
    let wispFade = 1;
    let wispScale = 1;
    /** Puffs a second into the vortex, and embers a second out of the ground. */
    let swirlRate = config.swirl.rate;
    let drift = config.cinders.drift;
    /** What the ring of blades is doing: how fast it turns, how far out it is. */
    let spin = 1;
    let draw = 1;
    /** Crescents a second dragged off the circling blades. */
    let arcs = 0;

    switch (this.state) {
      case 'mark': {
        const u = t(beats.mark);
        // Welling up rather than switching on.
        fade = Easing.outQuad(u);
        scale = 0.6 + 0.4 * u;
        wispFade = u * 0.5;
        wispScale = 0.55 + 0.45 * u;
        swirlRate = config.swirl.gatherRate * u;
        drift *= u * 0.5;
        // The blades are already turning, slowly — a ring that only started
        // moving on the cast would read as two abilities bolted together.
        spin = config.blades.gatherSpin;
        // The mark is not normally left to run out: the clip's second beat
        // fires the wind-up somewhere in the middle of it. Reaching the end is
        // the cast having lost what it was for — the body died to something
        // else in the meantime — and it folds away rather than circling grass.
        if (this.timer >= beats.mark + beats.charge) this.dismiss();
        break;
      }

      case 'circle': {
        // A body that died to something else mid-wind-up: there is nothing left
        // to put a blade into, so the ring goes and the dark sinks.
        if (this._target && !this._target.alive) {
          this.dismiss();
          break;
        }

        const u = t(beats.circle);
        const wind = Easing.inCubic(u);
        // The whole first half of the ability, in two numbers. The ring
        // accelerates from a drift to a blur and closes in as it does, so the
        // eye is watching something *tighten* rather than something rotate.
        spin = config.blades.gatherSpin + (config.blades.windSpin - config.blades.gatherSpin) * wind;
        draw = 1 - (1 - config.blades.tighten) * Easing.outQuad(u);
        // And the crescents come faster as it winds, which is what turns the
        // ring into the cage the reference's first panel is full of.
        arcs = config.orbitArc.rate * (0.25 + 0.75 * wind);

        // The column stands up over the wind-up rather than arriving with the
        // blades: it is the vertical the whole composite is hung on, and it has
        // to be there *before* the impact or the impact has nothing to be in
        // the middle of.
        head = Easing.outCubic(u);
        width = 1 + config.column.arrivalWidth * (1 - u) * 0.6;
        edge = 1 - u * 0.4;
        wispFade = 0.5 + 0.5 * u;
        swirlRate = config.swirl.gatherRate + (config.swirl.rate - config.swirl.gatherRate) * u;
        drift *= 0.5 + 0.5 * u;

        if (u >= 1) this._impale(config);
        break;
      }

      case 'drive': {
        // The thrusts are in the air. Nothing here decides when they land —
        // `PhantomBlades` reports each point back on the frame it actually
        // arrives (`_onPierce`), which is the whole reason five katanas going
        // in reads as steel rather than as damage with a decal on it.
        head = 1;
        edge = 0;
        // The ring stops dead on the frame it is let go, and stays closed. A
        // blade that did not get a thrust must not answer the launch by sailing
        // back out to its resting radius while its siblings are going in.
        spin = 0;
        draw = config.blades.tighten;
        // The safety valve. Everything from here depends on points arriving,
        // and one that never does would leave the move holding a body and its
        // own key forever — so rather than enumerating the ways that could
        // happen, it gives up waiting and finishes with whatever landed.
        if (this.timer >= beats.abandon) this._sever(config);
        break;
      }

      case 'pin': {
        // Five points in, and the body held on them. The pause before the tear,
        // and it is doing real work: without it the impact and the finish are
        // one event and the move has two beats instead of four.
        const u = t(beats.pin);
        head = 1;
        // Thrown wide by what went into it, and closing again.
        width = 1 + config.column.pinWidth * (1 - Easing.outQuad(u));
        scale = 1 + 0.25 * (1 - u);
        swirlRate = config.swirl.rate * 1.6;
        drift *= 2.2;
        spin = 0;
        draw = config.blades.tighten;
        if (u >= 1) this._sever(config);
        break;
      }

      case 'sever': {
        const u = t(beats.sever);
        // Everything thrown outward by what left through it, and beginning to
        // go. The column widens as it dies rather than narrowing: it is being
        // burst, not switched off.
        scale = 1 + 0.6 * Easing.outQuad(u);
        fade = 1 - 0.3 * u;
        head = 1 - 0.25 * u;
        width = 1 + config.column.severWidth * Easing.outQuad(u);
        wispFade = 1 - 0.3 * u;
        swirlRate = config.swirl.rate * (1 - u);
        drift *= 1.6 * (1 - u);
        if (u >= 1) {
          this.blades.banish();
          this._target = null;
          this._enter('settle');
        }
        break;
      }

      case 'settle': {
        const u = t(beats.settle);
        // Sinking back into the ground it came out of, and drawing in as it
        // goes: dark that only fades reads as a light being turned down.
        fade = 1 - Easing.outQuad(u);
        scale = 1.4 - 0.55 * u;
        head = this._head * (1 - Easing.inCubic(u));
        wispFade = (1 - u) * (1 - u);
        wispScale = 1 - 0.25 * u;
        // Nothing new into the vortex. What is already turning lives out its
        // own life, which leaves shadow drifting off the ground for a moment
        // after everything else has gone.
        swirlRate = 0;
        drift *= (1 - u) * 0.35;
        if (u >= 1) {
          this.state = 'idle';
          this.timer = 0;
          this.blades.clear();
        }
        break;
      }

      default:
        break;
    }

    // What the ring of blades is doing, handed to them rather than decided by
    // them — see `PhantomBlades#update`.
    this._drive.spin = spin;
    this._drive.draw = draw;

    // Only outside the outro: inside it this is what the outro is reading.
    if (this.state !== 'settle') this._head = head;

    /* ---- place, and dress ---- */
    this.pool.place(this._ground.x, this._ground.y, this._ground.z);
    this.column.place(this._ground.x, this._ground.y, this._ground.z);
    this.wisps.place(this._ground.x, this._ground.y, this._ground.z);

    // Squared, so the white is gone by the frame after the one it flashed on. A
    // linear decay on something this bright reads as the effect cooling.
    const flash = this._flash * this._flash;

    this.pool.update(config.glow, { fade, scale, flash }, elapsed);
    this.column.update(config.column, { head, width, flash, edge, fade: 1 }, elapsed);
    this.wisps.update(config.wisps, { fade: wispFade, scale: wispScale }, elapsed);

    if (swirlRate > 0) {
      this.swirl.emit(
        this._ground.x,
        this._ground.y,
        this._ground.z,
        config.glow.radius * config.swirl.spread,
        swirlRate,
        dt,
        config.swirl
      );
    }

    // The slow drift of embers up out of the dark, for as long as there is any.
    // A rate rather than a count, so it is a number in seconds and does not
    // change with the frame rate.
    if (drift > 0) {
      this.cinders.emit(
        this._ground.x,
        this._ground.y + config.cinders.driftHeight,
        this._ground.z,
        config.glow.radius * config.cinders.driftSpread,
        drift,
        dt,
        config.cinders,
        config.cinders.driftStrength
      );
    }

    if (arcs > 0) this._dragArcs(dt, arcs, config);
  }

  /**
   * The crescents the circling blades leave behind them.
   *
   * This is the reference's first panel and it is the only place in the project
   * a stroke is struck by something *travelling* rather than by a blow landing.
   * The trick that makes it read is where the arc is centred: a stroke sweeps
   * about `axis` at `shape.radius` from a pivot a radius back down its own
   * radial, so feeding it the blade's own tangent, world up, and the radius the
   * blade is actually orbiting at puts the pivot **on the body**. Every
   * crescent is therefore a piece of the circle the blade is on, and a handful
   * of them at once is the cage.
   *
   * `rate` is crescents a second **per blade**, not across the ring: what the
   * eye is reading is one continuous trail behind each katana, so the number
   * that matters is how often *one* of them leaves a mark. Five blades at nine
   * a second with a stroke living just over half a second is about twenty-five
   * alive at once, which is what `SlashTrails`'s pool is sized for.
   */
  _dragArcs(dt, rate, config) {
    this._sinceTrail += dt;
    const gap = 1 / Math.max(0.1, rate);
    if (this._sinceTrail < gap) return;
    this._sinceTrail = 0;

    const live = this.blades.blades;
    // The radius the ring is actually at this frame, not the one the editor
    // typed: the wind-up closes it, and a crescent drawn at the resting radius
    // would sit outside the blade that supposedly cut it.
    const radius = Math.max(0.2, config.blades.standoff * this._drive.draw);
    const turn = Math.sign(config.blades.orbit || 1);

    for (const blade of live) {
      if (blade.state !== 'poised' && blade.state !== 'gather') continue;
      if (blade.form < 0.5) continue;

      _at.copy(blade.holder.position);
      // The tangent of its own circle, which is the direction it is genuinely
      // moving. `_orbit` puts the blade at `angle`, so this is that circle
      // differentiated and nothing more.
      _travel.set(-Math.sin(blade.angle), 0, Math.cos(blade.angle)).multiplyScalar(turn);
      // And the plane the crescent is swept in, tilted off the vertical by a
      // different amount every time.
      //
      // Straight up is the honest axis — the ring is level, so the arc a blade
      // leaves is level too — and a set of level arcs is a *collar*: a dozen
      // hoops stacked at one height round the waist, which is the one thing the
      // reference's first panel is not. Its crescents cross at every angle and
      // pass over and behind the figure. Tilting the sweep plane per stroke
      // costs two random numbers and is the whole difference between a cage and
      // a hula hoop.
      const tilt = config.orbitArc.tilt;
      _axis
        .set((Math.random() - 0.5) * tilt, 1, (Math.random() - 0.5) * tilt)
        .normalize();
      this.trails.fan(
        _at,
        _travel,
        _axis,
        config.trails,
        this._shapeFor(config.orbitArc, radius),
        config.orbitArc.strength
      );
    }
  }

  /**
   * The frame all five go in.
   *
   * They are ordered together and they arrive together, which is the single
   * decision that separates this from the rite: `PhantomBlades#stab` is called
   * once per blade on one frame, every thrust runs the same beat, and every
   * point therefore lands on the same frame. What comes back is five calls to
   * `_onPierce` in one update — five wounds, one impact.
   */
  _impale(config) {
    _at.copy(this._ring);

    let ordered = 0;
    const live = this.blades.count;
    for (let i = 0; i < live; i++) {
      if (this.blades.stab(i, _at)) ordered++;
    }

    if (ordered > 0) {
      this._enter('drive');
      return;
    }

    // No blades at all — the katana was not resident when this was thrown.
    // The move still has to happen: eight of its nine layers do not involve a
    // blade, and an execution that silently did nothing because a model was
    // missing would be far worse than one drawn without its steel. So the five
    // thrusts are dealt from bearings of their own and everything else fires
    // exactly as it would have.
    const spokes = Math.max(1, Math.round(config.blades.count));
    for (let i = 0; i < spokes; i++) {
      const angle = (i / spokes) * Math.PI * 2;
      // Inward and very slightly downward, which is the line a blade hanging on
      // the ring would have come in on.
      _dir.set(-Math.cos(angle), -0.12, -Math.sin(angle)).normalize();
      this._pierce(_at, _dir, config);
    }
    this._enter('pin');
  }

  /**
   * A blade's point reached the body — the callback `PhantomBlades` fires on
   * the frame the thrust actually lands.
   *
   * It exists separately from `_pierce` only because the *position* of a thrust
   * that had a blade is the blade's, and one that did not still has to come
   * from somewhere. Everything after that is identical, and it has to be: an
   * execution drawn without its steel must land exactly as hard as one with it.
   */
  _onPierce(blade) {
    this._pierce(blade.holder.position, blade.dir, this.config);
    // The first point to arrive is the one that starts the hold. The other four
    // are on the same frame, and a beat restarted five times would be a beat
    // five frames long.
    if (this.state === 'drive') this._enter('pin');
  }

  /**
   * A point reached the body.
   *
   * Every layer opens on this frame because it is one event: the crescent along
   * the thrust, the shatter thrown past it, the embers off the steel, and — for
   * the first of the five only — the shock on the floor, the light, the knock
   * on the lens and whatever `onImpale` costs. Staggering any of them would
   * turn one impact into a sequence of small ones, which is the rite's move and
   * not this one.
   *
   * @param {Vector3} point where the steel went in
   * @param {Vector3} direction the unit line it came in on
   */
  _pierce(point, direction, config) {
    const first = this._pierced === 0;
    this._pierced++;

    _at.copy(point);
    _dir.copy(direction);
    // World up for the sweep's axis. `SlashTrails` takes off whatever part of
    // it is parallel to the travel, so a thrust that came in at a slope still
    // gets a stroke lying in the plane it was actually thrown in.
    _axis.set(0, 1, 0);

    this.trails.fan(
      _at,
      _dir,
      _axis,
      config.trails,
      this._shapeFor(config.stabArc),
      config.stabArc.strength
    );
    this.shards.shed(
      _at.x,
      _at.y,
      _at.z,
      _dir.x,
      _dir.y,
      _dir.z,
      config.shards.stabCount,
      config.shards,
      config.shards.stabStrength
    );
    this.cinders.shed(
      _at.x,
      _at.y,
      _at.z,
      _dir.x,
      _dir.y,
      _dir.z,
      config.cinders.stabCount,
      config.cinders,
      config.cinders.stabStrength
    );

    if (!first) return;

    // The one impact, dressed once. Five points arriving is not five events.
    _centre.copy(this._ring);
    this.rings.burst(this._ground.x, this._ground.z, config.rings, config.impaleRing);
    this.swirl.spray(
      this._ground.x,
      this._ground.y,
      this._ground.z,
      config.glow.radius * config.swirl.spread,
      config.swirl.impaleBurst,
      config.swirl,
      1.4
    );
    this.shards.burst(
      _centre.x,
      _centre.y,
      _centre.z,
      config.shards.impaleCount,
      config.shards,
      config.shards.impaleStrength,
      config.shards.impaleRadius
    );
    this._lightUp(_centre, config.light.impale);
    this.onShake?.(config.impaleShake);

    // And the blow itself, on the frame the points arrive rather than the one
    // they were ordered on. What it costs is entirely whoever wired `onImpale` —
    // and `settings.shadowExecution.wound` is tuned so that it deliberately
    // cannot kill, or the move has no last beat.
    if (this._target?.alive) this.onImpale?.(this._target, _dir.x, _dir.z);
  }

  /**
   * The last beat: they all come out at once, and the body goes with them.
   *
   * This is the frame the whole move has been building to, and the only one
   * where all nine layers fire together at full strength. The tear-out
   * crescents are wide where the thrusts' were narrow (`severArc` against
   * `stabArc`) — the same look, a completely different gesture, which is the
   * cheapest way to make a finisher feel like a different kind of thing from
   * the blow that set it up.
   */
  _sever(config) {
    _centre.copy(this._ring);

    // Every blade's own way out, each throwing a crescent along it. Thrown
    // before the wrench so the strokes are struck on the line the blade is
    // about to take rather than the one it has already left.
    let thrown = 0;
    for (const blade of this.blades.blades) {
      if (blade.state === 'hidden') continue;
      _dir.subVectors(blade.exit, blade.holder.position);
      if (_dir.lengthSq() < 1e-8) continue;
      _dir.normalize();
      _at.copy(blade.holder.position);
      _axis.set(0, 1, 0);
      this.trails.fan(
        _at,
        _dir,
        _axis,
        config.trails,
        this._shapeFor(config.severArc),
        config.severArc.strength
      );
      thrown++;
    }

    // No blades to take their lines from — drawn without its steel. The
    // crescents are the one layer that cannot simply be skipped, since they are
    // what the move is read off, so they are thrown on evenly spread bearings
    // out of the body instead.
    if (thrown === 0) {
      const spokes = Math.max(1, Math.round(config.blades.count));
      for (let i = 0; i < spokes; i++) {
        const angle = (i / spokes) * Math.PI * 2;
        _dir.set(Math.cos(angle), 0.3, Math.sin(angle)).normalize();
        _at.copy(_centre);
        _axis.set(0, 1, 0);
        this.trails.fan(
          _at,
          _dir,
          _axis,
          config.trails,
          this._shapeFor(config.severArc),
          config.severArc.strength
        );
      }
    }

    this.blades.wrench();

    // And the shatter, the floor, the vortex and the shower — all of them
    // centred on the body rather than on any one blade, because what is
    // happening now is happening to the body.
    this.shards.burst(
      _centre.x,
      _centre.y,
      _centre.z,
      config.shards.severCount,
      config.shards,
      config.shards.severStrength,
      config.shards.severRadius
    );
    this.cinders.spray(
      _centre.x,
      _centre.y,
      _centre.z,
      config.cinders.severCount,
      config.cinders,
      config.cinders.severStrength,
      config.cinders.severRadius
    );
    this.swirl.spray(
      this._ground.x,
      this._ground.y,
      this._ground.z,
      config.glow.radius * config.swirl.spread,
      config.swirl.severBurst,
      config.swirl,
      1.8
    );
    this.rings.burst(this._ground.x, this._ground.z, config.rings, config.severRing);

    this._lightUp(_centre, config.light.sever);
    this.onShake?.(config.severShake);

    // The body. It goes *before* the state change so everything above is
    // centred on one still standing on its own feet — a corpse's position is
    // the ragdoll's, and by the next frame it is already sliding out of the
    // cage it was supposed to be taken in.
    if (this._target?.alive) {
      // Straight down, near enough: five blades leaving on five bearings have
      // no net direction between them, and `settings.shadowExecution.impulse`
      // is tuned so the body is pulled off its feet rather than thrown anywhere.
      this.onSever?.(this._target, 0, 1);
    }

    this._enter('sever');
  }

  /**
   * The gesture, filled in from a block in the settings.
   *
   * One scratch object rather than a new one per stroke: this is called up to
   * five times on an impact frame and several times a second while the ring is
   * turning, and `SlashTrails` reads every field before returning.
   */
  _shapeFor(arc, radius = null) {
    const shape = this._shape;
    shape.count = arc.count;
    shape.spread = arc.spread;
    shape.radius = radius ?? arc.radius;
    shape.sweep = arc.sweep;
    shape.width = arc.width;
    shape.life = arc.life;
    shape.pitch = arc.pitch;
    return shape;
  }

  /**
   * Put the light here, this bright, and start it decaying.
   *
   * `strength` is a fraction of `light.intensity`, and a dimmer event does not
   * move the light: while the tear-out is still burning on a body, a stray
   * ember must not drag the glow back to where the points went in. Brightest
   * wins, and only the winner says where.
   */
  _lightUp(at, strength) {
    if (strength <= this._flash) return;
    this._flashAt.copy(at);
    this._flash = Math.min(1, strength);
  }

  _updateLight(dt, config) {
    if (this._flash > 0) {
      this._flash = Math.max(0, this._flash - dt / Math.max(0.02, config.light.fall));
    }
    const light = config.light;
    // The standing glow while the dark is up, plus whatever is left of the last
    // flash. Without the first term the body in the middle of four subtracting
    // layers would be lit by nothing at all between the beats.
    const held = this.active && this.state !== 'settle' ? light.hold : 0;
    // Squared, so the fall is fast at the top and long in the tail — the shape
    // light actually leaves a room with.
    this.light.intensity = light.intensity * (held + this._flash * this._flash);
    this.light.distance = light.range;
    this.light.decay = light.decay;
    // A flash sits where the thing that caused it happened. The *standing* glow
    // does not: the ring's middle is inside the body, and a point light in
    // there lights none of it — every normal on the outside faces away. So
    // between the beats it sits low, on the floor the dark is coming out of,
    // and up-lights the body the way the pool does. That is also the reading
    // the reference has: the figure is lit from underneath.
    if (this._flash > 0.001) {
      this.light.position.copy(this._flashAt);
    } else {
      this.light.position.set(this._ground.x, this._ground.y + light.height, this._ground.z);
    }
    copyColor(this.light.color, light.color);
    this.light.visible = this.light.intensity > 0.001;
  }

  /**
   * Where the body is standing, the floor under it, and the middle of the ring.
   *
   * Re-read every frame rather than taken once at the mark: an execution runs
   * for the better part of three seconds and the body is free to stagger for
   * most of it.
   */
  _takeGround(target) {
    const position = target?.position;
    if (position) {
      this._ground.set(
        position.x,
        this.terrain ? this.terrain.heightAt(position.x, position.z) : position.y,
        position.z
      );
    }
    this._ring.copy(this._ground);
    this._ring.y += this.config.height;
  }

  _enter(state) {
    this.state = state;
    this.timer = 0;
  }
}
