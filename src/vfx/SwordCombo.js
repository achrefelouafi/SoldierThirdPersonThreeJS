import { Group, MathUtils, PointLight, Vector3 } from 'three';

import { settings } from '../config/settings.js';
import { copyColor } from '../utils/color.js';
import { BladeImpact } from './BladeImpact.js';
import { RiftBurst } from './RiftBurst.js';
import { ShockRing } from './ShockRing.js';
import { SlashWave } from './SlashWave.js';

const _from = new Vector3();
const _to = new Vector3();
const _direction = new Vector3();

/**
 * Everything the three-hit combo throws, and the order it throws it in.
 *
 * ## The move, from the outside
 *
 * `Z` locks a body up to eleven metres off and plays `SwordCombo.fbx`, whose
 * three sweeps this class dresses. The first two are thrown *at* the target
 * from where the character is standing — a crescent leaves the blade, crosses
 * the ground and opens on the chest. The third is the character arriving in
 * person: the warp dashes the body onto its mark between the second cut and the
 * third (`settings.swordCombo.warpFrom`), and the finisher lands with an edge
 * on it, which is the one of the three that takes the body apart.
 *
 * That shape — reach, reach, close — is the whole reason the move is worth
 * having next to the slash hit. It is also why the first two beats deliberately
 * do not kill: a combo whose opening beat can finish the job has no third beat.
 *
 * ## What owns what
 *
 * This class owns the *look* and the *timing between* the beats, and nothing
 * else. It does not know:
 *
 *  - **when a beat happens** — that is `animation/Attack.js` reading `hits` off
 *    the settings block and calling back on the frame each sweep crosses the
 *    front;
 *  - **what being hit means** — `core/App.js` wires `onWound` and `onFinish` to
 *    the same two paths every other attack goes through, so a body opened by
 *    this combo falls exactly as one opened by anything else does.
 *
 * What it does own is the gap the animation cannot express: a thrown cut takes
 * time to *get* there. The blow is therefore not dealt on the frame the sweep
 * plays — it is dealt on the frame the crescent lands (`_onArrive`), which for
 * a target at ten metres is about a fifth of a second later. That decoupling is
 * the single thing that makes the ranged beats read as projectiles rather than
 * as decals fired from a distance.
 *
 * ## The four systems under it
 *
 * `vfx/SlashWave.js` draws and carries the crescents. `vfx/BladeImpact.js` is
 * the flash and the shower, reused unchanged — it is already what a blade
 * arriving looks like. `vfx/RiftBurst.js` is the finisher's own shape, and the
 * only thing in the move that is not a cut — five stacked layers of its own,
 * which is where nearly all of the third beat's weight on screen comes from.
 * `vfx/ShockRing.js` puts the wave on the floor under it. One light serves all
 * four.
 */
export class SwordCombo {
  /**
   * @param {object} [options]
   * @param {{heightAt: (x: number, z: number) => number, uniforms: object}|null} [options.terrain]
   * @param {((enemy: object, dirX: number, dirZ: number, beat: number) => void)|null} [options.onWound]
   *   a thrown cut reached a body that is still standing
   */
  constructor({ terrain = null, onWound = null } = {}) {
    this.terrain = terrain;
    this.onWound = onWound;

    /** Everything it is, in world space. Add it to the scene. */
    this.group = new Group();
    this.group.name = 'SwordCombo';

    this.waves = new SlashWave({ onArrive: (wave) => this._onArrive(wave) });
    this.group.add(this.waves.mesh);

    this.rift = new RiftBurst();
    this.group.add(this.rift.group);

    this.impact = new BladeImpact();
    this.group.add(this.impact.mesh);

    this.shock = new ShockRing({ terrain });
    this.group.add(this.shock.mesh);

    // One light for the whole move: it rides the newest crescent while one is
    // in the air and jumps to the contact on every landing. Never casts — a
    // shadow map re-rendered for a light that lives half a second costs more
    // than every mesh above it put together.
    this.light = new PointLight(0x66b4ff, 0, 14, 1.8);
    this.light.name = 'SwordComboLight';
    this.light.castShadow = false;
    this.group.add(this.light);

    /** What is left of the light's own flash, 0..1, and where it flashed. */
    this._flash = 0;
    this._flashAt = new Vector3();
  }

  /** Live tuning, read per frame so the editor's edits land immediately. */
  get config() {
    return settings.swordCombo;
  }

  /** Whether anything at all is still on screen. */
  get active() {
    return this.waves.active || this.rift.active || this._flash > 0;
  }

  /* ------------------------------------------------------------------ */
  /* the beats                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * One of the two opening beats: a crescent leaves the blade.
   *
   * The aim is taken at the chest rather than at the feet the body's position
   * actually reports, because a cut that lands at ankle height is a cut that
   * missed. `hit` is the entry from `settings.swordCombo.hits` that fired,
   * which is where the crescent's tilt and size come from — the first beat
   * comes down a steep diagonal and the second goes across, and those two
   * numbers are the whole difference on screen.
   *
   * @param {Vector3} origin where the edge was on the frame it left
   * @param {object} target the body it was thrown at
   * @param {object} hit the `hits` entry that fired
   */
  throwWave(origin, target, hit) {
    const config = this.config;
    if (!config.wave.enabled || !target) return;

    _from.copy(origin);
    _to.copy(target.position);
    _to.y += Math.max(0, config.wave.aimHeight);

    this.waves.throw({
      from: _from,
      to: _to,
      target,
      roll: MathUtils.degToRad(hit.roll ?? 0),
      size: hit.size ?? config.wave.size,
      speed: hit.speed ?? config.wave.speed,
      life: config.wave.life,
      spin: MathUtils.degToRad(hit.spin ?? 0),
      beat: hit.beat ?? 0
    });

    // A small flash off the steel on the way out, thrown along the line the
    // crescent left on — the cut has to be seen *leaving* as well as landing,
    // or the wave reads as having spawned in mid-air.
    _direction.subVectors(_to, _from);
    if (_direction.lengthSq() > 1e-6) _direction.normalize();
    this.impact.burst(
      _from.x,
      _from.y,
      _from.z,
      _direction.x,
      _direction.y,
      _direction.z,
      config.impact,
      Math.max(0, config.launchFlash)
    );
    this._lightUp(_from, config.light.launch);
  }

  /**
   * The third beat: the blade is here, and the body comes apart.
   *
   * Everything opens on the same frame because they are the same event — the
   * shell, the rings, the flash, the shower, the wave on the floor and the
   * hit-stop `core/App.js` is running in parallel. Staggering any of them would
   * turn one blow into a sequence of small ones.
   *
   * The big stationary crescent hung on the contact point is the same
   * `SlashWave` the opening beats fly, thrown at zero speed with nothing to
   * travel to: it is the arc the sword actually swept, left hanging in the air
   * where it swept it. Reusing the wave for it rather than drawing a second
   * kind of arc is what keeps the finisher legibly part of the same combo.
   *
   * @param {number} x world, at the point of contact
   * @param {number} y
   * @param {number} z
   * @param {number} dx unit direction the blade was travelling, on the ground
   * @param {number} dz
   * @param {object} hit the `hits` entry that fired
   */
  finish(x, y, z, dx, dz, hit) {
    const config = this.config;

    _from.set(x, y, z);
    _direction.set(dx, 0, dz);
    if (_direction.lengthSq() > 1e-6) _direction.normalize();
    else _direction.set(0, 0, 1);

    if (config.rift.enabled) {
      this.rift.open(
        x,
        y,
        z,
        _direction.x,
        _direction.y,
        _direction.z,
        config.rift,
        Math.max(0, hit.strength ?? 1)
      );
    }

    if (config.wave.enabled) {
      // Parked *slightly* short of the contact so the arc reads as having been
      // swept through the body rather than as having stopped inside it. `to` is
      // only there to give the crescent its heading — at zero speed the wave
      // never travels to it (see `SlashWave#throw`).
      _to.copy(_from).addScaledVector(_direction, -0.15);
      this.waves.throw({
        from: _to,
        to: _from,
        target: null,
        roll: MathUtils.degToRad(hit.roll ?? 0),
        size: hit.size ?? config.wave.size,
        speed: 0,
        life: config.wave.finishLife,
        spin: MathUtils.degToRad(hit.spin ?? 0)
      });
    }

    this.impact.burst(
      x,
      y,
      z,
      _direction.x,
      _direction.y,
      _direction.z,
      config.impact,
      Math.max(0, config.finishFlash)
    );

    if (config.shock.enabled) this.shock.burst(x, z, config.shock, Math.max(0, hit.strength ?? 1));

    this._lightUp(_from, config.light.finish);
  }

  /**
   * A thrown crescent got where it was going.
   *
   * The flash is thrown along the crescent's own heading, so the star of spikes
   * `BladeImpact` draws points the way the cut was travelling — an impact that
   * is radially symmetric has no direction in it, and this one arrived from
   * somewhere very specific.
   */
  _onArrive(wave) {
    const config = this.config;
    const at = wave.position;

    this.impact.burst(
      at.x,
      at.y,
      at.z,
      wave.direction.x,
      wave.direction.y,
      wave.direction.z,
      config.impact,
      Math.max(0, config.arriveFlash)
    );
    this._lightUp(at, config.light.arrive);

    // And the blow itself, on this frame rather than on the one the sweep
    // played. Whoever wired `onWound` decides what that costs.
    if (wave.target?.alive) {
      this.onWound?.(wave.target, wave.direction.x, wave.direction.z, wave.beat ?? 0);
    }
  }

  /**
   * Put the light here, this bright, and start it decaying.
   *
   * `strength` is a fraction of `light.intensity`, and a dimmer event does not
   * move the light: while a crescent is still bright on someone's chest, the
   * next one leaving the blade must not drag the glow back to the character.
   * Brightest wins, and only the winner says where.
   */
  _lightUp(at, strength) {
    if (strength <= this._flash) return;
    this._flashAt.copy(at);
    this._flash = Math.min(1, strength);
  }

  /* ------------------------------------------------------------------ */

  /**
   * Advance everything.
   *
   * @param {number} dt the simulation's step — the whole move slows with the
   *   hit-stop it causes, which is most of why the finisher lands as hard as it
   *   does
   * @param {number} elapsed the simulation's clock, for the impacts' own timing
   */
  update(dt, elapsed) {
    const config = this.config;

    // The impacts are stamped with the simulation's clock rather than a real
    // one, so a hit holds through the hit-stop it caused instead of ageing out
    // three times too fast while the world is frozen around it.
    this.impact.sync(elapsed, config.impact);
    this.waves.update(dt, config.wave);
    this.rift.update(dt, config.rift);
    this.shock.update(dt, config.shock);

    /* ---- the light ---- */
    // A crescent in the air carries the light with it; once none is left the
    // flash simply decays wherever it last landed.
    const newest = this.waves.waves[this.waves.waves.length - 1];
    if (newest && !newest.arrived) this._flashAt.copy(newest.position);

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

  /** Everything on screen, gone — for leaving the stage and for a reset. */
  clear() {
    this.waves.clear();
    this.rift.clear();
    this.impact.clear();
    this.shock.clear();
    this._flash = 0;
    this.light.intensity = 0;
    this.light.visible = false;
  }

  dispose() {
    this.waves.dispose();
    this.rift.dispose();
    this.impact.dispose();
    this.shock.dispose();
    this.group.parent?.remove(this.group);
  }
}
