import {
  AnimationClip,
  AnimationUtils,
  LoopRepeat,
  MathUtils,
  PropertyBinding,
  Quaternion,
  Vector3
} from 'three';

import { settings } from '../config/settings.js';
import { damp } from '../utils/math.js';

const UP = /* @__PURE__ */ new Vector3(0, 1, 0);

const _right = /* @__PURE__ */ new Vector3();
const _yawQuat = /* @__PURE__ */ new Quaternion();
const _pitchQuat = /* @__PURE__ */ new Quaternion();
const _delta = /* @__PURE__ */ new Quaternion();
const _world = /* @__PURE__ */ new Quaternion();
const _parent = /* @__PURE__ */ new Quaternion();

/**
 * Joints the rifle layers are allowed to touch.
 *
 * Everything from the waist up, fingers included, and nothing from the waist
 * down. That line is the whole design: the legs go on doing what the gait says
 * — walking, running, turning — while the torso does what the gun says. A layer
 * that reached the hips would take the body's travel over, and a body that
 * stops walking when it raises a rifle is the tell that this is two animations
 * fighting rather than one body doing two things.
 */
const UPPER = /(Spine|Neck|Head|Shoulder|Arm|Hand)/;
const LOWER = /(UpLeg|Leg|Foot|Toe|Hips)/;

/**
 * The body's half of holding a rifle: the pose, the recoil and the aim.
 *
 * Three things stacked on the gait, in the order they are resolved.
 *
 * ## 1. The hold — an additive pose
 *
 * There is one rifle clip on this rig and it is a *stand*. The moment the body
 * walks, the arms go back to swinging at its sides and the gun swings with
 * them. The fix is the oldest layering trick there is: take the rifle stand,
 * subtract the plain stand from it, and what is left is not a pose at all but a
 * *difference* — "what holding a rifle does to a body, whatever that body is
 * otherwise doing". Added on top of the walk, the legs walk and the arms hold a
 * rifle. It is `AnimationUtils.makeClipAdditive` and three lines, and it is the
 * difference between a mode that works standing still and one that works.
 *
 * Its weight is the inverse of the idle's: standing, the rifle stand is already
 * the pose and adding the difference to it would apply it twice.
 *
 * ## 2. The recoil — the same thing, per round
 *
 * `FiringRifle.fbx` made additive against its own first frame is the *kick*
 * with the aim taken out of it. One cycle is timed to one round (`shoot`), so
 * the shoulder moves on the beat the round leaves rather than on the clip's own
 * authored rhythm.
 *
 * ## 3. The aim — procedural, and the only part that is not a clip
 *
 * No clip can point a gun at an arbitrary point in the world, so the last step
 * is done by hand: the yaw and pitch from the body's heading to the reticle,
 * shared out up the spine and written onto the bones *after* the mixer has run.
 * That ordering is not incidental — the mixer overwrites every joint's local
 * rotation each frame, so anything procedural has to come after it or it is
 * simply erased. See `apply`.
 */
export class RifleAim {
  /**
   * @param {import('three').AnimationMixer} mixer
   * @param {import('./CharacterController.js').CharacterController} character
   * @param {{fire?: import('three').AnimationClip, idle?: import('three').AnimationClip, idleRifle?: import('three').AnimationClip}} clips
   */
  constructor(mixer, character, clips = {}) {
    this.character = character;

    /** The recoil layer, or null if the clip never loaded. */
    this.fire = this._additive(mixer, clips.fire, clips.fire, 'rifle-fire');
    /** The "this body is holding a rifle" difference, over the gait. */
    this.hold = this._additive(mixer, clips.idleRifle, clips.idle, 'rifle-hold');

    /** How much of the aim is in force, 0..1 — the whole layer's master. */
    this.weight = 0;
    this._wanted = 0;

    /** Where the torso is pointing, relative to the hips, in radians. */
    this._yaw = 0;
    this._pitch = 0;
    this._yawTarget = 0;
    this._pitchTarget = 0;

    /** Seconds since the last round, for the recoil layer's own fade. */
    this._sinceShot = Infinity;
    this._fireWeight = 0;

    /** short bone name → its share of the twist. Resolved on first use. */
    this._chain = null;
  }

  /** Whether the recoil clip is there. The aim itself works without it. */
  get available() {
    return Boolean(this.fire);
  }

  /**
   * Where the torso should be pointing, and how much of that to apply.
   *
   * Both angles are targets rather than positions: the twist is damped toward
   * them so that whipping the mouse across the screen turns a body rather than
   * snapping a torso. Which is also why the *legs* are turned by someone else
   * (`animation/ThirdPersonController.js`) — the torso leads and the feet
   * follow, exactly as they do on a person.
   *
   * @param {number} yaw radians from the body's heading to the reticle
   * @param {number} pitch radians above the horizon
   * @param {number} weight 0..1 — the gun coming up, and going away
   */
  set(yaw, pitch, weight) {
    const config = settings.gunplay.aim;
    const maxYaw = MathUtils.degToRad(config.maxYaw);
    const maxPitch = MathUtils.degToRad(config.maxPitch);

    this._yawTarget = MathUtils.clamp(yaw, -maxYaw, maxYaw);
    this._pitchTarget = MathUtils.clamp(pitch, -maxPitch, maxPitch);
    this._wanted = MathUtils.clamp(weight, 0, 1);
  }

  /**
   * A round has just left. Restart the recoil cycle on its beat.
   *
   * The clip is re-timed rather than played at its authored pace: one cycle is
   * made to last exactly one shot interval, so at ten rounds a second the
   * shoulder is kicked ten times rather than four, and turning the fire rate
   * down in the editor slows the kick with it for free.
   */
  shoot() {
    this._sinceShot = 0;
    const action = this.fire;
    if (!action) return;

    const duration = action.getClip().duration;
    const rate = Math.max(0.5, settings.gunplay.fire.rate);
    action.timeScale = duration > 0 ? duration * rate : 1;
    action.time = 0;
    action.paused = false;
    action.enabled = true;
  }

  /** @param {number} dt the simulation's clock — recoil slows with the world */
  update(dt) {
    const config = settings.gunplay.aim;

    this.weight = damp(this.weight, this._wanted, Math.max(1e-9, config.enter), dt);
    this._yaw = damp(this._yaw, this._yawTarget, Math.max(1e-9, config.rate), dt);
    this._pitch = damp(this._pitch, this._pitchTarget, Math.max(1e-9, config.rate), dt);

    this._sinceShot += dt;

    // The hold only applies to the share of the pose that is being carried by a
    // clip with no rifle in it — the run, today. Over the rifle stand or the
    // rifle walk it would fold the arms in a second time, and the blend asks
    // that question itself (`Locomotion#unposed`) rather than this file
    // guessing which clips exist.
    if (this.hold) {
      const gait = this.character.locomotion;
      this.hold.setEffectiveWeight(this.weight * (gait ? gait.unposed : 1));
    }

    if (this.fire) {
      // Held for one shot interval and a little over, so an automatic burst is
      // one continuous kick rather than ten that each fade out.
      const window = 1 / Math.max(0.5, settings.gunplay.fire.rate) + 0.12;
      const wanted = this._sinceShot < window ? 1 : 0;
      // On instantly, off over about a tenth of a second: a kick that eased in
      // would arrive after the round it belongs to.
      this._fireWeight = wanted > this._fireWeight
        ? wanted
        : damp(this._fireWeight, wanted, 0.000002, dt);
      this.fire.setEffectiveWeight(this.weight * this._fireWeight);
    }
  }

  /**
   * Write the twist onto the skeleton.
   *
   * Must be called *after* `mixer.update` and before anything reads a bone's
   * world transform — the muzzle, the equipment, the render. Each joint's world
   * rotation is turned by its share of the angle and converted straight back
   * into the local space its parent leaves it in, walking down the chain so
   * that a joint is always read against a parent that has already been turned.
   *
   * There is no IK here and there should not be: the gun is not being placed on
   * a target, the *body* is being pointed at one, and the round is fired from
   * wherever that leaves the muzzle (see `combat/Gunplay.js`). A solver would
   * be a great deal of machinery in service of a lie the player cannot see.
   */
  apply() {
    if (this.weight <= 1e-3) return;

    const chain = this._resolveChain();
    if (!chain.length) return;

    const yaw = this._yaw * this.weight;
    const pitch = this._pitch * this.weight;
    const facing = this.character.facing;

    // The body's own right, in world space: 0 faces +Z, so forward is
    // (sin, cos) and right is its perpendicular.
    _right.set(Math.cos(facing), 0, -Math.sin(facing));

    for (const link of chain) {
      const bone = link.bone;
      const share = link.share;

      _yawQuat.setFromAxisAngle(UP, yaw * share);
      // Negated: turning the body's forward about its own right by a positive
      // angle points it at the floor, and a positive pitch means "look up".
      _pitchQuat.setFromAxisAngle(_right, -pitch * share);
      _delta.copy(_yawQuat).multiply(_pitchQuat);

      bone.getWorldQuaternion(_world);
      _delta.multiply(_world);

      if (bone.parent) {
        bone.parent.getWorldQuaternion(_parent);
        bone.quaternion.copy(_parent.invert().multiply(_delta));
      } else {
        bone.quaternion.copy(_delta);
      }
      // The next joint up reads its parent's world transform, and
      // `getWorldQuaternion` walks the chain and recomposes it from exactly
      // this local rotation — so the turn just written is what the joint above
      // is measured against, and the shares compound the way they should.
      bone.updateMatrix();
    }
  }

  /** Drop the layer, now — the gun has gone away, or the body has. */
  cancel() {
    this.weight = 0;
    this._wanted = 0;
    this._yaw = 0;
    this._pitch = 0;
    this._yawTarget = 0;
    this._pitchTarget = 0;
    this._fireWeight = 0;
    this._sinceShot = Infinity;
    this.hold?.setEffectiveWeight(0);
    this.fire?.setEffectiveWeight(0);
  }

  /* ------------------------------------------------------------------ */

  /**
   * The joints the twist is shared across, in order from the hips up.
   *
   * The shares are normalised, so the joint at the end of the chain points
   * exactly at the reticle however the split is written — which is why
   * `settings.gunplay.aim.shares` stops at `Spine2`: the arms hang off it, and
   * a share handed to anything above it is a share of the aim the *gun* never
   * gets.
   *
   * Resolved once and cached against the object it was built from.
   */
  _resolveChain() {
    const shares = settings.gunplay.aim.shares;
    if (this._chain && this._chain.source === shares) return this._chain.links;

    const links = [];
    let total = 0;
    for (const name of Object.keys(shares)) total += Math.max(0, shares[name]);
    if (total <= 0) total = 1;

    for (const name of Object.keys(shares)) {
      const bone = this.character.getBone(name);
      if (!bone) continue;
      links.push({ bone, share: Math.max(0, shares[name]) / total });
    }

    this._chain = { source: shares, links };
    return links;
  }

  /**
   * One additive action, built out of a clip and the pose to measure it against.
   *
   * The clip is filtered to the upper body and to rotations only *before* the
   * subtraction, because everything that survives that filter is a thing the
   * layer is allowed to move — and a translation track that got through would
   * be a bone length being added to another bone length.
   *
   * @returns {import('three').AnimationAction|null}
   */
  _additive(mixer, clip, reference, name) {
    if (!clip || !reference) return null;

    const target = upperBodyRotations(clip, name);
    if (!target) return null;

    // The reference is filtered the same way so the two track lists line up —
    // `makeClipAdditive` matches them by name, and an unmatched target track
    // would be left absolute in an otherwise additive clip.
    const base = reference === clip ? target : upperBodyRotations(reference, `${name}-base`);
    if (!base) return null;

    AnimationUtils.makeClipAdditive(target, 0, base, 30);

    const action = mixer.clipAction(target);
    action.setLoop(LoopRepeat, Infinity);
    action.enabled = true;
    action.setEffectiveWeight(0);
    action.play();
    return action;
  }
}

/**
 * A clip cut down to the rotations of the joints above the waist.
 *
 * @param {import('three').AnimationClip} clip
 * @param {string} name
 * @returns {AnimationClip|null} a new clip — the source is never touched
 */
function upperBodyRotations(clip, name) {
  const tracks = [];

  for (const track of clip.tracks) {
    if (!track.name.endsWith('.quaternion')) continue;
    const node = PropertyBinding.parseTrackName(track.name).nodeName;
    const short = node.split(':').pop().replace(/^mixamorig/i, '');
    if (!UPPER.test(short) || LOWER.test(short)) continue;
    tracks.push(track.clone());
  }

  if (!tracks.length) {
    console.warn(`[RifleAim] "${name}" has nothing above the waist to layer`);
    return null;
  }

  return new AnimationClip(name, clip.duration, tracks);
}
