import {
  AdditiveBlending,
  BoxGeometry,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3
} from 'three';

import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import { getColor } from '../utils/color.js';
import { sweepBodies } from './Hitboxes.js';

const FORWARD = /* @__PURE__ */ new Vector3(0, 0, 1);

/**
 * What kind of round is in the air.
 *
 * The pool does not know what either one is *worth* — that is
 * `combat/Gunplay.js`'s, like everything else about what a hit means. What it
 * knows is the two facts it needs to draw and move one: a held round falls at
 * its own rate and is drawn several times heavier, because a shot that took
 * three seconds to earn must be visible leaving the barrel.
 */
export const ORDINARY = 0;
export const FOCUSED = 1;

const _from = /* @__PURE__ */ new Vector3();
const _to = /* @__PURE__ */ new Vector3();
const _step = /* @__PURE__ */ new Vector3();
const _point = /* @__PURE__ */ new Vector3();
const _direction = /* @__PURE__ */ new Vector3();
const _tail = /* @__PURE__ */ new Vector3();
const _scale = /* @__PURE__ */ new Vector3();
const _quaternion = /* @__PURE__ */ new Quaternion();
const _matrix = /* @__PURE__ */ new Matrix4();

/**
 * The rounds in the air.
 *
 * ## Why they are rounds and not traces
 *
 * A rifle in a game is almost always a *hitscan*: the trigger is pulled, a ray
 * is cast, and whatever it touched is hit on that frame. It is exact and it is
 * free, and it is also why so many shooters feel like clicking on things. What
 * is drawn here instead is a body with a speed: it leaves the muzzle, it takes
 * a measurable moment to cross forty metres, and it falls a little on the way.
 * Three things fall out of that and they are the whole reason for it — a target
 * can be missed by being *late*, a tracer is an object in the world rather than
 * a line drawn between two answers, and the round can be seen to arrive.
 *
 * ## What it costs to do that honestly
 *
 * At 155 m/s a round covers two and a half metres in a sixtieth of a second, so
 * the position it lands on each frame is nowhere near the path it took to get
 * there. Testing that *point* against a body would put half the rounds fired at
 * close range straight through it. Every step is therefore swept: the segment
 * from where the round was to where it would be is the thing tested, against
 * the bodies (`combat/Hitboxes.js`) and against the height field, and the
 * nearest of the two answers is where the round actually stopped.
 *
 * ## What it does not own
 *
 * What a hit *means*. The round reports where it landed and on whom, and
 * whoever fired it decides what that costs — see `combat/Gunplay.js`. This
 * file has no idea what a head shot is worth, or that there is such a thing.
 */
export class Projectiles {
  /**
   * @param {object} [options]
   * @param {number} [options.capacity] rounds in the air at once. Well past
   *   what a ten-round-a-second rifle can put up at this speed; the ring simply
   *   overwrites the oldest if it is ever reached.
   * @param {{heightAt: (x: number, z: number) => number}|null} [options.terrain]
   */
  constructor({ capacity = 96, terrain = null } = {}) {
    this.capacity = capacity;
    this.terrain = terrain;

    /** @type {Float32Array} position, velocity and age, one row per round. */
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.live = new Uint8Array(capacity);
    /** `ORDINARY` or `FOCUSED`, per round. */
    this.kind = new Uint8Array(capacity);

    this._next = 0;
    /** How many are in the air, for the HUD and for an early-out. */
    this.count = 0;

    this.material = new MeshBasicMaterial({
      color: 0xffffff,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      // The grade and the tone map come after the bloom, and a tracer is a
      // light source rather than a surface: it is authored past 1 on purpose
      // and must reach the bloom threshold with that value intact.
      toneMapped: false,
      fog: false
    });

    // A box rather than a billboard: a tracer is only ever seen along or across
    // its own length, and at three centimetres wide the difference between a
    // stretched box and a camera-facing quad is nothing at all.
    this.mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), this.material, capacity);
    this.mesh.name = 'Tracers';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.count = 0;
  }

  /**
   * Put a round in the air.
   *
   * @param {Vector3} origin the muzzle
   * @param {Vector3} direction unit, spread already applied
   * @param {number} [speed] m/s — the settings' own unless overridden
   * @param {number} [kind] `ORDINARY` or `FOCUSED`
   */
  fire(origin, direction, speed = settings.gunplay.fire.speed, kind = ORDINARY) {
    // The ring rather than a search: a slot still in flight is the oldest round
    // on the field, and dropping it is the right thing to lose.
    const i = this._next;
    this._next = (this._next + 1) % this.capacity;

    this.px[i] = origin.x;
    this.py[i] = origin.y;
    this.pz[i] = origin.z;
    this.vx[i] = direction.x * speed;
    this.vy[i] = direction.y * speed;
    this.vz[i] = direction.z * speed;
    this.age[i] = 0;
    this.live[i] = 1;
    this.kind[i] = kind;
    return i;
  }

  /**
   * Advance every round, resolve what it ran into, and draw the streaks.
   *
   * @param {number} dt seconds
   * @param {Iterable<object>} enemies who is standing
   * @param {{onBody?: Function, onGround?: Function}} [hooks]
   */
  update(dt, enemies, hooks = {}) {
    const config = settings.gunplay;
    const tracer = config.tracer;
    const focus = config.focus;
    const drop = config.fire.drop;
    const life = Math.max(0.05, tracer.life);

    let drawn = 0;

    for (let i = 0; i < this.capacity; i++) {
      if (!this.live[i]) continue;

      const focused = this.kind[i] === FOCUSED;

      if (dt > 0) {
        this.age[i] += dt;
        this.vy[i] -= (focused ? focus.drop : drop) * dt;

        _from.set(this.px[i], this.py[i], this.pz[i]);
        _step.set(this.vx[i] * dt, this.vy[i] * dt, this.vz[i] * dt);
        _to.copy(_from).add(_step);

        // Bodies first, then the floor: a round that would have gone through
        // someone standing on a rise has hit the someone, not the rise.
        const body = sweepBodies(enemies, _from, _to);
        const ground = this._sweepGround(_from, _to);

        if (body && (!ground || body.distance <= ground)) {
          _direction.copy(_step).normalize();
          _point.copy(_from).addScaledVector(_direction, body.distance);
          hooks.onBody?.(body.enemy, _point, _direction, body.head, this.kind[i]);
          this.live[i] = 0;
          continue;
        }

        if (ground !== null) {
          _direction.copy(_step).normalize();
          _point.copy(_from).addScaledVector(_direction, ground);
          hooks.onGround?.(_point, _direction, this.kind[i]);
          this.live[i] = 0;
          continue;
        }

        this.px[i] = _to.x;
        this.py[i] = _to.y;
        this.pz[i] = _to.z;

        if (this.age[i] >= life) {
          this.live[i] = 0;
          continue;
        }
      }

      drawn = this._draw(i, drawn, tracer, focused ? Math.max(1, focus.tracer) : 1);
    }

    this.count = drawn;
    this.mesh.count = drawn;
    if (drawn > 0) this.mesh.instanceMatrix.needsUpdate = true;

    // Re-read every frame, because the whole point of the settings file is that
    // a colour is a live control — and there is exactly one material here.
    this.material.color.copy(getColor(tracer.color)).multiplyScalar(tracer.brightness);
  }

  /**
   * Where a step crossed the height field, in metres along it, or null.
   *
   * The floor is a displaced plane driven by a noise field, so there is nothing
   * to raycast against that would be cheaper or more honest than asking the
   * field itself. The crossing is found by the sign change over the step and
   * then bisected — six passes puts it inside a centimetre at any step length
   * this can produce.
   */
  _sweepGround(from, to) {
    const terrain = this.terrain;
    if (!terrain) return null;

    const above = from.y - terrain.heightAt(from.x, from.z);
    const below = to.y - terrain.heightAt(to.x, to.z);
    // Already under the floor when the step began: the round was fired into a
    // slope from inside it, and the honest answer is that it stopped at once.
    if (above <= 0) return 0;
    if (below > 0) return null;

    let low = 0;
    let high = 1;
    for (let pass = 0; pass < 6; pass++) {
      const mid = (low + high) * 0.5;
      _point.lerpVectors(from, to, mid);
      if (_point.y - terrain.heightAt(_point.x, _point.z) > 0) low = mid;
      else high = mid;
    }

    return from.distanceTo(to) * (low + high) * 0.5;
  }

  /**
   * Lay one instance down as a streak behind the round.
   *
   * @param {number} scale what the tracer is multiplied by — 1 for an ordinary
   *   round and `focus.tracer` for a held one. There is one material for the
   *   whole pool, so a round cannot be given its own *colour*; what it can be
   *   given is size, and at three and a half times the width that is enough to
   *   pick the shot out of a burst.
   * @returns the next slot
   */
  _draw(i, slot, tracer, scale) {
    _direction.set(this.vx[i], this.vy[i], this.vz[i]);
    const speed = _direction.length();
    if (speed < 1e-4) return slot;
    _direction.multiplyScalar(1 / speed);

    const width = tracer.width * scale;
    // A young round has not travelled far enough to have a full streak behind
    // it, and one drawn at full length would be sticking out of the barrel
    // before it had left it.
    const length = Math.min(tracer.length * scale, speed * this.age[i] + width);
    _tail
      .set(this.px[i], this.py[i], this.pz[i])
      .addScaledVector(_direction, -length * 0.5);

    _quaternion.setFromUnitVectors(FORWARD, _direction);
    _scale.set(width, width, length);
    _matrix.compose(_tail, _quaternion, _scale);
    this.mesh.setMatrixAt(slot, _matrix);
    return slot + 1;
  }

  /** Take everything in the air back — for a field that has just been cleared. */
  clear() {
    this.live.fill(0);
    this.kind.fill(ORDINARY);
    this.count = 0;
    this.mesh.count = 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
