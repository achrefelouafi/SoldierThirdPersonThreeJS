import { Group, PointLight, Vector3 } from 'three';

import { settings } from '../config/settings.js';
import { copyColor } from '../utils/color.js';
import { Easing } from '../utils/math.js';
import { BloodMist } from './BloodMist.js';
import { CinderStreaks } from './CinderStreaks.js';
import { InkAura } from './InkAura.js';
import { PhantomBlades } from './PhantomBlades.js';
import { RiteRings } from './RiteRings.js';
import { SlashTrails } from './SlashTrails.js';

const _at = /* @__PURE__ */ new Vector3();
const _dir = /* @__PURE__ */ new Vector3();
const _axis = /* @__PURE__ */ new Vector3();
const _centre = /* @__PURE__ */ new Vector3();

/**
 * The Crimson Rite (`V`) — everything it calls up, and the order it calls it in.
 *
 * ## The move, from the outside
 *
 * A body is marked. The ground under it goes dark, ink stands up out of it, and
 * three katanas resolve out of that ink pointed inward. They go in one after
 * another — three separate thrusts, each with its own streak, its own cloud and
 * its own ring on the floor — and on the third they all tear out at once
 * through the far side. What is left is not a corpse; it burns away where it
 * stood.
 *
 * ## The six layers, and why each is there
 *
 * The reference breaks a katana effect into five panels and then composites
 * them. This class is that composite, plus the thing doing the cutting — and
 * every layer is here because it is doing a job none of the others can:
 *
 *  1. `vfx/SlashTrails.js` — **the strokes.** What the eye actually reads the
 *     move off. Everything else is a consequence of these.
 *  2. `vfx/BloodMist.js` — **the mist.** The only opaque thing in the ability,
 *     and therefore the only source of *weight*. Light has no mass.
 *  3. `vfx/RiteRings.js` — **the floor.** Concentric shocks and the cracks
 *     between them. It is what puts the move in the world rather than in front
 *     of it; without it the whole thing is happening in mid-air.
 *  4. `vfx/InkAura.js` — **the dark.** The only layer that *subtracts*, and so
 *     the only thing giving the other five something to be bright against.
 *  5. `vfx/CinderStreaks.js` — **the cinders.** The loose, fine, fast layer.
 *     Without something small and quick between the big shapes, four elements
 *     in one place read as four decals that happen to be adjacent.
 *  6. `vfx/PhantomBlades.js` — **the katanas.** The character's own weapon,
 *     borrowed off the equipment library, because the one thing that cannot be
 *     faked next to the real blade is the real blade.
 *
 * One light serves all six.
 *
 * ## What this class owns, and what it does not
 *
 * It owns the *timing between* the beats and nothing else. It does not know:
 *
 *  - **when a rite starts** — that is `animation/Attack.js` reading `hits` off
 *    the settings block and calling back on the frames the clip marks;
 *  - **what being stabbed costs** — `core/App.js` wires `onStab` and `onRend`
 *    to the same paths every other attack goes through, so a body taken by this
 *    goes down exactly as one taken by anything else does.
 *
 * What it does own is the gap the animation cannot express. The clip has two
 * frames marked in it; the move has *four* impacts. Three of them are thrusts
 * that happen on this class's own clock, well after the cast has finished, and
 * each is dealt on the frame its point actually arrives rather than on the frame
 * it was ordered — see `PhantomBlades#onPierce`. That decoupling is the single
 * thing that makes the stabs read as steel going into somebody instead of as
 * three copies of one hit.
 */
export class CrimsonRite {
  /**
   * @param {object} [options]
   * @param {{heightAt: (x: number, z: number) => number, uniforms: object}|null} [options.terrain]
   * @param {(() => import('three').Object3D|null)|null} [options.blade] where to
   *   borrow the katana from — see `vfx/PhantomBlades.js`
   * @param {((enemy: object, dirX: number, dirZ: number, index: number) => void)|null} [options.onStab]
   *   a point reached a body that is still standing
   * @param {((enemy: object, dirX: number, dirZ: number) => void)|null} [options.onRend]
   *   the blades came out, and the body goes with them
   * @param {((metres: number) => void)|null} [options.onShake] what the lens
   *   takes from each of the four impacts
   */
  constructor({ terrain = null, blade = null, onStab = null, onRend = null, onShake = null } = {}) {
    this.terrain = terrain;
    this.onStab = onStab;
    this.onRend = onRend;
    this.onShake = onShake;

    /** Everything it is, in world space. Add it to the scene. */
    this.group = new Group();
    this.group.name = 'CrimsonRite';

    this.rings = new RiteRings({ terrain });
    this.aura = new InkAura();
    this.mist = new BloodMist();
    this.trails = new SlashTrails();
    this.cinders = new CinderStreaks();
    this.blades = new PhantomBlades({
      source: blade,
      onPierce: (pierced) => this._onPierce(pierced)
    });

    this.group.add(
      this.rings.mesh,
      this.aura.mesh,
      this.mist.mesh,
      this.trails.mesh,
      this.cinders.mesh,
      this.blades.group
    );

    // One light for the whole rite. Never casts: a shadow map re-rendered for a
    // light that lives two seconds costs more than all six layers above it put
    // together.
    this.light = new PointLight(0xff2a1c, 0, 14, 1.9);
    this.light.name = 'CrimsonRiteLight';
    this.light.castShadow = false;
    this.group.add(this.light);

    /** @type {'idle'|'mark'|'rite'|'rend'|'settle'} */
    this.state = 'idle';
    /** Seconds in the current state. */
    this.timer = 0;

    /** The body this rite is being worked on. Held across every beat of it. */
    this._target = null;
    /** Where it was standing when the mark was struck — the aura's own ground. */
    this._ground = new Vector3();
    /** How many thrusts have been *ordered*, and how many have *landed*. */
    this._ordered = 0;
    this._pierced = 0;
    /** When the next thrust is due, on this rite's own clock. */
    this._nextStab = 0;
    /** Seconds since the last point went in — the wait before the tear-out. */
    this._sinceLast = 0;
    /** What is left of the light's own flash, 0..1, and where it flashed. */
    this._flash = 0;
    this._flashAt = new Vector3();
  }

  /** Live tuning, read per frame so the editor's edits land immediately. */
  get config() {
    return settings.crimsonRite;
  }

  /** Whether anything at all is still on screen. */
  get active() {
    return this.state !== 'idle';
  }

  /* ------------------------------------------------------------------ */
  /* the beats                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * The first beat: the ground under a body goes dark, and blades gather in it.
   *
   * Nothing is hurt here and nothing is committed — this is the beat where both
   * parties know what is coming and neither can stop it. Taking it out would
   * leave three katanas that simply appear mid-thrust, which is a projectile
   * rather than a summons.
   *
   * A rite that is still settling is interrupted rather than refused: the move
   * runs a little over two seconds and the ink takes longer, so two presses in
   * a row would otherwise leave the second one stabbing a body with no aura
   * round it. Anything earlier than that is refused — a second press during a
   * beat that is still happening must not restart it.
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

    this.aura.reseed();
    this.aura.place(this._ground.x, this._ground.y, this._ground.z);

    // The first ring is struck on the *mark* rather than on the first thrust,
    // and small: it is the ground being claimed, not anything landing on it.
    this.rings.burst(this._ground.x, this._ground.z, config.rings, config.markRing);

    _centre.copy(this._ground);
    _centre.y += config.height;
    this.blades.summon(_centre, 0, config.blades);

    this._ordered = 0;
    this._pierced = 0;
    this._nextStab = 0;
    this._sinceLast = 0;
    this._lightUp(_centre, config.light.mark);
    this._enter('mark');
    return true;
  }

  /**
   * The second beat: the thrusts begin.
   *
   * Callable from a mark that is only half wound up, and deliberately so — the
   * frame that fires this is a frame in a clip, and the clip is the authority
   * on when the hand comes down. A rite whose aura is still rising is snapped
   * into motion here, which reads as the summoning being *interrupted by its
   * own urgency*. The alternative is blades that wait politely for their own
   * smoke.
   *
   * @param {{position: Vector3}|null} [target] re-aims the rite, if the body has
   *   moved since the mark was struck
   * @returns {boolean} whether anything started
   */
  cast(target = null) {
    const config = this.config;
    if (!config.enabled) return false;
    if (this.state === 'rite' || this.state === 'rend') return false;

    // A cast with no mark under it marks first. It costs one frame of gather
    // instead of the full beat, and it is far better than a press that does
    // nothing because a rune-equivalent was missed.
    if (this.state !== 'mark') {
      if (!this.mark(target ?? this._target)) return false;
    } else if (target) {
      this._target = target;
    }
    if (!this._target) return false;

    this._ordered = 0;
    this._pierced = 0;
    this._nextStab = 0;
    this._sinceLast = 0;
    this._enter('rite');
    return true;
  }

  /**
   * Stop it, wherever it had got to.
   *
   * @param {{immediate?: boolean}} [options] `immediate` drops everything on the
   *   spot — for leaving the stage, where a settle would only be paused halfway
   *   through and resumed on the way back
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
    this._ordered = 0;
    this._pierced = 0;
    this._nextStab = 0;
    this._sinceLast = 0;
    this._flash = 0;
    this.rings.clear();
    this.aura.clear();
    this.mist.clear();
    this.trails.clear();
    this.cinders.clear();
    this.blades.clear();
    this.light.intensity = 0;
    this.light.visible = false;
  }

  dispose() {
    this.rings.dispose();
    this.aura.dispose();
    this.mist.dispose();
    this.trails.dispose();
    this.cinders.dispose();
    this.blades.dispose();
    this.group.parent?.remove(this.group);
  }

  /* ------------------------------------------------------------------ */
  /* the frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number} dt seconds, on the *simulation's* clock — the whole rite is
   *   combat, so it slows with the hit-stop it causes and stops with `P`
   * @param {number} elapsed the shared clock, for the ink's crawl and the
   *   particles' own timing
   */
  update(dt, elapsed) {
    const config = this.config;

    // Before anything can emit into them, so a particle born by this frame's
    // thrust is stamped with a clock the shaders already agree with.
    this.mist.sync(elapsed, config.mist);
    this.cinders.sync(elapsed, config.cinders);

    this._advance(dt, elapsed, config);

    this.rings.update(dt, config.rings);
    this.trails.update(dt, elapsed, config.trails);
    this.blades.update(dt, elapsed, config.blades);
    this._updateLight(dt, config);
  }

  /* ------------------------------------------------------------------ */

  /** The beat itself. Everything with a clock in it is in here. */
  _advance(dt, elapsed, config) {
    if (!this.active) {
      this.aura.update(config.aura, { fade: 0, scale: 0 }, elapsed);
      return;
    }

    this.timer += dt;
    const beats = config.beats;
    /** 0..1 through the current beat. */
    const t = (seconds) => Math.min(1, this.timer / Math.max(1e-3, seconds));

    // How much ink there is, how wide it stands and how far up it has come.
    let fade = 1;
    let scale = 1;
    let reach = 1;
    /** Cinders a second drifting up out of the aura, this frame. */
    let drift = config.cinders.drift;

    switch (this.state) {
      case 'mark': {
        const u = t(beats.mark);
        // Welling up rather than switching on. `outQuad` on the height and a
        // slower ramp on the width, so the ink climbs before it spreads.
        fade = Easing.outQuad(u);
        scale = 0.65 + 0.35 * u;
        reach = Easing.outCubic(u);
        drift *= u;
        // The mark is not normally left to run out: the clip's second beat
        // fires the thrusts somewhere in the middle of it. Reaching the end is
        // the cast having lost what it was for — the body died to something
        // else in the meantime — and it folds away rather than stabbing at
        // grass. Keep `charge` comfortably longer than the gap between the two
        // beats or the ink will sink before the rite lands.
        if (this.timer >= beats.mark + beats.charge) this.dismiss();
        break;
      }

      case 'rite': {
        // A body that died to something else mid-rite: there is nothing left to
        // put a blade into, so the blades go and the ink sinks.
        if (this._target && !this._target.alive && this._pierced < config.stabs) {
          this.dismiss();
          break;
        }

        // Order the thrusts, one at a time, on this class's own clock. The
        // blades report back when their points actually arrive — see
        // `_onPierce` — which is a different frame and the one that counts.
        while (this._ordered < config.stabs && this.timer >= this._nextStab) {
          _at.copy(this._target?.position ?? this._ground);
          _at.y += config.height;

          if (this.blades.stab(this._ordered, _at)) {
            this._ordered++;
            this._nextStab += Math.max(0.02, beats.between);
            continue;
          }

          // No blade took it. There are two ways that happens and they want
          // opposite answers.
          //
          // If there are no blades *at all* — the katana was not resident when
          // the rite was thrown — the move still has to happen: five of its six
          // layers do not involve a blade, and a rite that silently did nothing
          // because a model was missing would be far worse than one drawn
          // without its steel. So the thrust is dealt from a bearing of its own
          // and everything else fires exactly as it would have.
          if (this.blades.count === 0) {
            const angle = (this._ordered / Math.max(1, config.stabs)) * Math.PI * 2;
            // Inward and very slightly downward, which is the line a blade
            // hanging on the ring would have come in on.
            _dir.set(-Math.cos(angle), -0.15, -Math.sin(angle)).normalize();
            this._pierce(_at, _dir);
            this._ordered++;
            this._nextStab += Math.max(0.02, beats.between);
            continue;
          }

          // Otherwise every blade is busy — which only happens when `stabs` has
          // been set higher than `blades.count` in the editor. Wait for one to
          // come free rather than dropping the thrust; `abandon` below is what
          // guarantees the wait cannot be forever.
          break;
        }

        // Every point is in and the body has been held on them for a moment.
        // The hold is short and it is doing real work: it is the pause before
        // the tear, and without it the third stab and the finish are one event.
        if (this._pierced >= config.stabs) {
          this._sinceLast += dt;
          if (this._sinceLast >= beats.hold) this._rend();
          break;
        }

        // And the safety valve. Everything above depends on points arriving,
        // and a point that never arrives would leave the rite holding a body
        // and its own key forever. Rather than trying to enumerate the ways
        // that could happen, the rite simply gives up waiting and tears out
        // with whatever landed — which is a worse-looking finish exactly once,
        // instead of an ability that has to be reloaded to use again.
        if (this.timer >= beats.abandon) this._rend();
        break;
      }

      case 'rend': {
        const u = t(beats.rend);
        // Thrown wide by what left through it, and beginning to go.
        scale = 1 + 0.55 * Easing.outQuad(u);
        fade = 1 - 0.35 * u;
        drift *= 1 - u * 0.5;
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
        // goes: ink that only fades reads as a light being turned down.
        fade = 1 - Easing.outQuad(u);
        scale = 1.35 - 0.5 * u;
        reach = 1 - 0.55 * u;
        drift *= (1 - u) * 0.4;
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

    // On the *shared* clock rather than the rite's own: the ink's crawl is a
    // property of the world, and restarting it on every cast would make the
    // field jump the moment a second rite is thrown near the first.
    this.aura.update(config.aura, { fade, scale, reach }, elapsed);

    // The slow drift of cinders out of the aura, for as long as there is one.
    // A rate rather than a count, so it is a number in seconds and does not
    // change with the frame rate.
    if (drift > 0) {
      this.cinders.emit(
        this._ground.x,
        this._ground.y + config.cinders.driftHeight,
        this._ground.z,
        config.aura.radius * config.cinders.driftSpread,
        drift,
        dt,
        config.cinders,
        config.cinders.driftStrength
      );
    }
  }

  /**
   * A blade's point reached the body — the callback `PhantomBlades` fires on
   * the frame the thrust actually lands.
   *
   * It exists separately from `_pierce` below only because the *position* of a
   * thrust that had a blade is the blade's, and one that did not still has to
   * come from somewhere. Everything after that is identical, and it has to be:
   * a rite drawn without its steel must land exactly as hard as one with it.
   */
  _onPierce(blade) {
    this._pierce(blade.holder.position, blade.dir);
  }

  /**
   * A point reached the body.
   *
   * Everything opens on this frame because it is one event: the streak, the
   * cloud, the shock on the floor, the shower of cinders, the light, the knock
   * on the lens, and whatever `onStab` costs. Staggering any of them would turn
   * one thrust into a sequence of small ones.
   *
   * @param {Vector3} point where the steel went in
   * @param {Vector3} direction the unit line it came in on
   */
  _pierce(point, direction) {
    const config = this.config;
    this._pierced++;
    this._sinceLast = 0;

    _at.copy(point);
    _dir.copy(direction);
    // World up for the sweep's axis. `SlashTrails` takes off whatever part of
    // it is parallel to the travel, so a thrust that came in at a slope still
    // gets a stroke lying in the plane it was actually thrown in.
    _axis.set(0, 1, 0);

    this.trails.fan(_at, _dir, _axis, config.trails, config.stabArc, config.stabArc.strength);
    this.mist.burst(_at.x, _at.y, _at.z, _dir.x, _dir.y, _dir.z, config.mist, config.stabMist);
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
    this.rings.burst(this._ground.x, this._ground.z, config.rings, config.stabRing);

    this._lightUp(_at, config.light.stab);
    this.onShake?.(config.stabShake);

    // And the blow itself, on this frame rather than on the one the thrust was
    // ordered. Whoever wired `onStab` decides what it costs — and the first two
    // deliberately must not kill, or the rite has no third beat.
    if (this._target?.alive) {
      this.onStab?.(this._target, _dir.x, _dir.z, this._pierced - 1);
    }
  }

  /**
   * The last beat: everything comes out at once, and the body goes with it.
   *
   * This is the frame the whole move has been building to, and it is the only
   * one where all six layers fire together at full strength. The tear-out
   * strokes are wide where the thrusts' were narrow (`rendArc` against
   * `stabArc`) — the same look, a completely different gesture, which is the
   * cheapest way to make a finisher feel like a different kind of thing from
   * the blows that set it up.
   */
  _rend() {
    const config = this.config;

    _centre.copy(this._target?.position ?? this._ground);
    _centre.y += config.height;

    // Every blade's own way out, each throwing a stroke along it. Thrown before
    // the wrench so the strokes are struck on the line the blade is about to
    // take rather than the one it has already left.
    let thrown = 0;
    for (const blade of this.blades.blades) {
      if (blade.state === 'hidden') continue;
      _dir.subVectors(blade.exit, blade.holder.position);
      if (_dir.lengthSq() < 1e-8) continue;
      _dir.normalize();
      _at.copy(blade.holder.position);
      _axis.set(0, 1, 0);
      this.trails.fan(_at, _dir, _axis, config.trails, config.rendArc, config.rendArc.strength);
      thrown++;
    }

    // No blades to take their lines from — the rite is being drawn without its
    // steel. The strokes are the one layer that cannot simply be skipped, since
    // they are what the whole move is read off, so they are thrown on evenly
    // spread bearings out of the body instead.
    if (thrown === 0) {
      const spokes = Math.max(1, Math.round(config.stabs));
      for (let i = 0; i < spokes; i++) {
        const angle = (i / spokes) * Math.PI * 2;
        _dir.set(Math.cos(angle), 0.35, Math.sin(angle)).normalize();
        _at.copy(_centre);
        _axis.set(0, 1, 0);
        this.trails.fan(_at, _dir, _axis, config.trails, config.rendArc, config.rendArc.strength);
      }
    }

    this.blades.wrench();

    // And the cloud, the floor and the shower — all of them centred on the body
    // rather than on any one blade, because what is happening now is happening
    // to the body.
    this.mist.burst(
      _centre.x,
      _centre.y,
      _centre.z,
      0,
      1,
      0,
      config.mist,
      config.rendMist
    );
    this.cinders.spray(
      _centre.x,
      _centre.y,
      _centre.z,
      config.cinders.rendCount,
      config.cinders,
      config.cinders.rendStrength,
      config.cinders.rendRadius
    );
    this.rings.burst(this._ground.x, this._ground.z, config.rings, config.rendRing);

    this._lightUp(_centre, config.light.rend);
    this.onShake?.(config.rendShake);

    // The body. It opens *before* the kill so everything above is centred on
    // one that is still standing on its own feet — a corpse's position is the
    // ragdoll's, and by the next frame it is already sliding out of the rite it
    // was supposed to be taken by.
    if (this._target?.alive) {
      // Straight down, near enough: three blades leaving in three directions
      // have no net bearing between them, and `settings.crimsonRite.impulse` is
      // tuned so the body is pulled off its feet rather than thrown anywhere.
      this.onRend?.(this._target, 0, 1);
    }

    this._enter('rend');
  }

  /**
   * Put the light here, this bright, and start it decaying.
   *
   * `strength` is a fraction of `light.intensity`, and a dimmer event does not
   * move the light: while the tear-out is still bright on a body, a stray
   * cinder must not drag the glow back to where the first thrust landed.
   * Brightest wins, and only the winner says where.
   */
  _lightUp(at, strength) {
    if (strength <= this._flash) return;
    this._flashAt.copy(at);
    this._flash = Math.min(1, strength);
  }

  _updateLight(dt, config) {
    if (this._flash > 0) {
      this._flash = Math.max(0, this._flash - dt / Math.max(0.02, config.light.decay));
    }
    // Squared, so the fall is fast at the top and long in the tail — the shape
    // light actually leaves a room with.
    this.light.intensity = this._flash * this._flash * config.light.intensity;
    this.light.distance = config.light.range;
    this.light.position.copy(this._flashAt);
    copyColor(this.light.color, config.light.color);
    this.light.visible = this.light.intensity > 0.001;
  }

  /** Where the body is standing, and the floor under it. */
  _takeGround(target) {
    const position = target.position;
    this._ground.set(
      position.x,
      this.terrain ? this.terrain.heightAt(position.x, position.z) : position.y,
      position.z
    );
  }

  _enter(state) {
    this.state = state;
    this.timer = 0;
  }
}
