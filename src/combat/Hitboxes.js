import { Vector3 } from 'three';

import { settings } from '../config/settings.js';

const _head = /* @__PURE__ */ new Vector3();
const _neck = /* @__PURE__ */ new Vector3();
const _hips = /* @__PURE__ */ new Vector3();
const _left = /* @__PURE__ */ new Vector3();
const _right = /* @__PURE__ */ new Vector3();
const _feet = /* @__PURE__ */ new Vector3();
const _toHead = /* @__PURE__ */ new Vector3();
const _oc = /* @__PURE__ */ new Vector3();
const _pq = /* @__PURE__ */ new Vector3();
const _op = /* @__PURE__ */ new Vector3();
/** The swept segment's own direction — never `_oc`, which the tests scribble on. */
const _sweep = /* @__PURE__ */ new Vector3();

/** The answer `nearestBody` fills in, reused so a frame of fire allocates nothing. */
const _closest = { enemy: null, distance: 0, head: false };

/**
 * What a round can actually hit, and where it hit it.
 *
 * ## Three shapes, not a mesh
 *
 * A skinned body is twenty thousand triangles being pushed around by a
 * skeleton, and testing a bullet against it would mean re-deriving the skinned
 * positions on the CPU every frame for every enemy — the one thing the whole
 * renderer is arranged to avoid. So the body is stood in for by a sphere and
 * two capsules read straight off four joints: the head, the neck, the hips and
 * the feet. They cost four world-matrix reads per body and they are the same
 * shapes every shooter has used since Quake.
 *
 * The head sphere is the one that matters. It is what makes aiming a skill
 * rather than a formality, and it is deliberately a shade larger than a head:
 * a hitbox that matches the silhouette exactly *feels* smaller than it is,
 * because the player is aiming at a moving thing through a reticle that has
 * spread on it. `settings.gunplay.hitbox` is where that judgement lives.
 *
 * ## Why the volumes are not cached
 *
 * They are rebuilt on every query rather than once a frame, because a body's
 * pose is only ever one frame old and a query is four bone reads. Caching them
 * would buy nothing and would introduce the one bug this file must not have:
 * a volume that no longer matches the body it is standing in for.
 */

/**
 * The nearest body a ray runs into, and whether it went through the head.
 *
 * @param {Iterable<object>} enemies the population — anything with `alive`
 *   and a `bones` map indexed by short joint name
 * @param {Vector3} origin
 * @param {Vector3} direction unit
 * @param {number} maxDistance metres
 * @param {object|null} [ignore] a body to skip
 * @returns {{enemy: object, distance: number, head: boolean}|null} the shared
 *   answer object — read it before the next call
 */
export function nearestBody(enemies, origin, direction, maxDistance, ignore = null) {
  const box = settings.gunplay.hitbox;
  let best = null;
  let bestDistance = maxDistance;

  for (const enemy of enemies) {
    if (!enemy.alive || enemy === ignore) continue;
    if (!readJoints(enemy)) continue;

    // The head first and on its own terms: a round that clips the top of the
    // torso capsule *and* the head sphere is a head shot, so the sphere is
    // allowed to win ties rather than being ordered against the body by depth.
    const head = raySphere(origin, direction, _head, box.headRadius);
    if (head >= 0 && head < bestDistance) {
      bestDistance = head;
      best = enemy;
      _closest.head = true;
      _closest.enemy = enemy;
      _closest.distance = head;
      continue;
    }

    const torso = rayCapsule(origin, direction, _hips, _neck, box.torsoRadius);
    const legs = rayCapsule(origin, direction, _feet, _hips, box.legRadius);
    const body = torso < 0 ? legs : legs < 0 ? torso : Math.min(torso, legs);
    if (body < 0 || body >= bestDistance) continue;

    bestDistance = body;
    best = enemy;
    _closest.head = false;
    _closest.enemy = enemy;
    _closest.distance = body;
  }

  return best ? _closest : null;
}

/**
 * The same question asked of a segment rather than of a ray — what a round in
 * flight covered between two frames.
 *
 * A bullet at 155 m/s crosses two and a half metres in a sixty-hertz frame, so
 * testing the *point* it arrived at would miss a body it went straight through.
 * Everything here is swept for that reason.
 *
 * @param {Iterable<object>} enemies
 * @param {Vector3} from where the round was
 * @param {Vector3} to where it would be
 * @returns {{enemy: object, distance: number, head: boolean}|null}
 */
export function sweepBodies(enemies, from, to) {
  _sweep.copy(to).sub(from);
  const length = _sweep.length();
  if (length < 1e-6) return null;
  _sweep.multiplyScalar(1 / length);
  return nearestBody(enemies, from, _sweep, length);
}

/* -------------------------------------------------------------------- */

/**
 * Read the four joints a body is stood in for by, into the module scratch.
 *
 * `false` for a rig that is missing any of them — which is the honest answer:
 * a body whose skeleton this file does not recognise should be unhittable
 * rather than hittable at a guessed position.
 */
function readJoints(enemy) {
  const bones = enemy.bones;
  const head = bones.get('Head');
  const neck = bones.get('Neck');
  const hips = bones.get('Hips');
  if (!head || !neck || !hips) return false;

  head.getWorldPosition(_head);
  neck.getWorldPosition(_neck);
  hips.getWorldPosition(_hips);

  // The head joint sits at the base of the skull, not in the middle of it, so
  // the sphere is carried on up the neck's own direction by half a head.
  _toHead.copy(_head).sub(_neck);
  const reach = _toHead.length();
  if (reach > 1e-4) {
    _toHead.multiplyScalar(1 / reach);
    _head.addScaledVector(_toHead, settings.gunplay.hitbox.headRadius * 0.9);
  }

  const left = bones.get('LeftFoot');
  const right = bones.get('RightFoot');
  if (left && right) {
    left.getWorldPosition(_left);
    right.getWorldPosition(_right);
    _feet.addVectors(_left, _right).multiplyScalar(0.5);
  } else {
    // No feet on this rig: stand the leg capsule on the ground under the hips.
    _feet.set(_hips.x, enemy.position.y, _hips.z);
  }

  return true;
}

/**
 * Where a ray enters a sphere, or -1.
 *
 * The near root only: a round that starts inside a head has already hit it.
 */
function raySphere(origin, direction, center, radius) {
  _oc.copy(origin).sub(center);
  const b = _oc.dot(direction);
  const c = _oc.lengthSq() - radius * radius;
  if (c > 0 && b > 0) return -1; // outside, and pointing away
  const discriminant = b * b - c;
  if (discriminant < 0) return -1;
  const t = -b - Math.sqrt(discriminant);
  return t < 0 ? 0 : t;
}

/**
 * Where a ray enters a capsule, or -1.
 *
 * Resolved as the closest approach between the ray and the capsule's axis —
 * which is exact for the cylinder and a hair generous at the two caps. That is
 * the right way round to be wrong: the caps are the shoulders and the hips,
 * and a round that grazes a shoulder should count.
 */
function rayCapsule(origin, direction, p, q, radius) {
  _pq.copy(q).sub(p);
  _op.copy(origin).sub(p);

  const pqLenSq = _pq.lengthSq();
  if (pqLenSq < 1e-8) return raySphere(origin, direction, p, radius);

  const pqd = _pq.dot(direction);
  const pqop = _pq.dot(_op);
  const dop = direction.dot(_op);

  // Closest approach of the two lines, then the axis parameter clamped to the
  // segment — a body is a capsule, not an infinite pipe.
  const denominator = pqLenSq - pqd * pqd;
  let t;
  if (Math.abs(denominator) < 1e-8) {
    t = -dop; // parallel: any point will do
  } else {
    t = (pqd * pqop - dop * pqLenSq) / denominator;
  }
  if (t < 0) t = 0;

  let s = (pqop + pqd * t) / pqLenSq;
  if (s < 0) s = 0;
  else if (s > 1) s = 1;
  // With the axis clamped, the ray's own closest point moves — re-solve it.
  t = (p.x + _pq.x * s - origin.x) * direction.x +
    (p.y + _pq.y * s - origin.y) * direction.y +
    (p.z + _pq.z * s - origin.z) * direction.z;
  if (t < 0) t = 0;

  const cx = origin.x + direction.x * t - (p.x + _pq.x * s);
  const cy = origin.y + direction.y * t - (p.y + _pq.y * s);
  const cz = origin.z + direction.z * t - (p.z + _pq.z * s);
  const distanceSq = cx * cx + cy * cy + cz * cz;
  if (distanceSq > radius * radius) return -1;

  // Back off the closest approach to the surface, so the impact is drawn on
  // the body rather than in the middle of it.
  const back = Math.sqrt(Math.max(0, radius * radius - distanceSq));
  return Math.max(0, t - back);
}
