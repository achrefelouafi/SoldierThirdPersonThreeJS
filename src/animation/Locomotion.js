import { LoopRepeat, MathUtils } from 'three';
import { settings } from '../config/settings.js';
import { damp } from '../utils/math.js';

/**
 * The idle / walk / run blend.
 *
 * All three clips play all the time; only their weights move. That is what
 * makes the transitions continuous — there is no moment where one action is
 * stopped and another started, so a stop-start-stop input can never catch the
 * body mid-fade with nothing playing.
 *
 * ## Everything twice: once armed, once not
 *
 * The body stands, walks and runs differently depending on what is in its
 * hands, so each of the three is really a *pair* — the plain clip and the one
 * holding a rifle — cross-faded by the single `stance` weight `setStance`
 * drives. They are blended rather than switched for the same reason the gaits
 * are: the weapon swap is a burn with a beat of its own, and a pose that cut on
 * that beat would land a frame ahead of the thing it is reacting to.
 *
 * ## And the walk once more, sideways
 *
 * The rifle walk is really a *set*: the forward cycle and the sidestep, chosen
 * by how far off its own heading the body is actually travelling (`setSpeed`'s
 * `lateral`). Squared up to the lens with a gun up, a body goes where the stick
 * says and faces where the camera does, and the two disagree by up to a right
 * angle — which through a forward walk cycle is a moonwalk, the single most
 * obvious thing a third-person shooter can get wrong. `WalkSideRifle.fbx`
 * strafes to the character's left; right is the same cycle run backwards, on
 * exactly the terms the backpedal already runs the forward one.
 *
 * It is one weight, `strafe`, signed: its magnitude is how much of the walk the
 * sidestep carries and its sign is which way. Damping the *signed* number is
 * what makes a left-to-right reversal safe — the clip's weight passes through
 * zero at the instant its direction flips, so the frame where the cycle turns
 * around is a frame nobody can see.
 *
 * A twin that failed to load is not an error — `_weightFor` falls back to the
 * plain clip per state, so a rig with a rifle walk and no rifle run runs
 * normally with a gun rather than sliding along in a T-pose. `unposed` is the
 * one number that says how much of the pose is currently being carried by a
 * clip with no rifle in it, and `animation/RifleAim.js` lays its additive hold
 * layer over exactly that much. Which means adding the missing twin is a clip
 * and a line in `CharacterController` and nothing else: the layer stands down
 * on its own, in proportion, as the clip takes over.
 *
 * Two things keep the feet on the ground:
 *
 *  - **Phase lock.** The plain walk is the master cycle and every other gait —
 *    the run, and the rifle twins — is slaved to its normalised phase each
 *    frame, so they all contact the floor on the same foot at the same instant.
 *    Crossfading two free-running gait cycles is what produces the four-legged
 *    shuffle in the middle of a blend, and the weapon swap crossfades two walks
 *    directly into each other. The sidestep is locked to the walk's *rate*
 *    rather than to its phase, because it is the one clip that has to be able
 *    to turn around — see `_lockPhase`.
 *  - **Stride rate.** Playback is scaled by how fast the body is *actually*
 *    travelling against the speed the clip was authored for
 *    (`clipWalkSpeed`/`clipRunSpeed`), so raising `walkSpeed` or `runSpeed` in
 *    the editor re-times the legs instead of skating them.
 */
export class Locomotion {
  /**
   * @param {import('three').AnimationMixer} mixer
   * @param {{idle: import('three').AnimationClip, walk: import('three').AnimationClip, run: import('three').AnimationClip, idleRifle?: import('three').AnimationClip, walkRifle?: import('three').AnimationClip, walkSideRifle?: import('three').AnimationClip, runRifle?: import('three').AnimationClip}} clips
   *   the rifle clips are each optional and each independent: a state
   *   without one resolves to its plain clip, which is the right thing for a
   *   rig whose export failed to load or was never authored
   * @param {{weight: number, takeover: number}[]} overrides full-body moves that
   *   mask the gait while they hold the pose — the two jumps and the kick. Only
   *   those two numbers are read, so anything that resolves them qualifies.
   */
  constructor(mixer, clips, overrides = []) {
    this.mixer = mixer;
    this.overrides = overrides.filter(Boolean);

    this.idle = this._action(clips.idle);
    this.idleRifle = this._action(clips.idleRifle);
    this.walk = this._action(clips.walk);
    this.walkRifle = this._action(clips.walkRifle);
    this.walkSideRifle = this._action(clips.walkSideRifle);
    this.run = this._action(clips.run);
    this.runRifle = this._action(clips.runRifle);

    /** Ground speed the blend is resolving toward, m/s. */
    this.speed = 0;
    /**
     * Which way the body is actually travelling relative to where it points:
     * +1 forward, -1 backward.
     *
     * There is one walk on this rig and it goes forward. Backing away from
     * something with a rifle up is a body travelling one way while facing the
     * other, and the cheapest honest answer — the one games have used since
     * there were games — is to run the same cycle in reverse. It is not a
     * backpedal animation and it does not pretend to be; it is the feet going
     * the way the ground is, which is the part a player actually reads.
     */
    this.direction = 1;
    /** Smoothed weights, so a shove on the input does not pop the pose. */
    this.weights = { idle: 1, walk: 0, run: 0 };
    /**
     * How much of the walk the sidestep is carrying and which way, -1..+1.
     *
     * +1 is a full strafe to the character's *left* — the way the clip itself
     * goes, which is why that end of the range is the one that needs no trick —
     * -1 to its right, 0 a body walking where it is pointing. Signed rather
     * than a magnitude and a flag so that a reversal crosses zero, and along
     * the model's own +X so that the sign means the same thing here as it does
     * to the clip it weights. See the class note.
     */
    this.strafe = 0;
    this._strafeTarget = 0;
    /**
     * The sidestep's own place in its cycle, 0..1, and the walk phase it was
     * last stepped against.
     *
     * The one gait that is not simply handed the walk's phase — see
     * `_lockPhase`.
     */
    this._sidePhase = 0;
    this._walkPhase = 0;
    /** How far the stand is toward the rifle idle, 0..1, and where it is going. */
    this.stance = 0;
    this._stanceTarget = 0;

    if (this.idle) this.idle.weight = 1;
  }

  _action(clip) {
    if (!clip) return null;
    const action = this.mixer.clipAction(clip);
    action.setLoop(LoopRepeat, Infinity);
    action.enabled = true;
    action.setEffectiveWeight(0);
    action.play();
    return action;
  }

  /**
   * Ground speed in m/s, from the controller.
   *
   * @param {number} speed always positive — it is the blend's input, and a
   *   walk is a walk whichever way it is going
   * @param {number} [direction] +1 travelling forward, -1 backward. Only ever
   *   anything but +1 while something is holding the heading off the direction
   *   of travel, which today is the rifle (see `direction`).
   * @param {number} [lateral] how much of that travel is sideways and which
   *   way, -1..+1, +1 being straight out to the character's left. Same
   *   condition as `direction` and the same source: it is only ever anything
   *   but 0 while the aim owns the heading (see `strafe`).
   */
  setSpeed(speed, direction = 1, lateral = 0) {
    this.speed = Math.max(0, speed);
    this.direction = direction < 0 ? -1 : 1;
    this._strafeTarget = MathUtils.clamp(lateral, -1, 1);
  }

  /**
   * Which stand the body holds, named by the weapon that is drawn.
   *
   * Anything that is not `'rifle'` — including no weapon at all — is the plain
   * stand, so a catalog entry with a stance nobody has authored a clip for
   * degrades to the pose every other clip was made against rather than to
   * nothing. Called by `equipment/WeaponSwitch.js` on the beat the new weapon
   * appears, not at either end of the swap.
   *
   * @param {string|null} name a catalog item's `stance`
   * @param {{immediate?: boolean}} [options] `immediate` skips the cross-fade.
   *   For the boot path: the body has not been seen yet, and easing out of a
   *   pose nobody watched it hold is half a second of it settling into the
   *   stand it should already have been in.
   */
  setStance(name, { immediate = false } = {}) {
    // One weight for all three pairs, and it is enough that *any* twin loaded:
    // a rig with a rifle walk but no rifle stand still wants the stance to
    // move, and `_weightFor` falls back per clip.
    const armed = this.idleRifle || this.walkRifle || this.walkSideRifle || this.runRifle;
    this._stanceTarget = name === 'rifle' && armed ? 1 : 0;
    if (immediate) this.stance = this._stanceTarget;
  }

  /**
   * How much of the pose is being carried by a clip that knows nothing about a
   * rifle, 0..1.
   *
   * Read by `animation/RifleAim.js` to weight its additive hold layer: the
   * layer's whole job is to put a rifle in the hands of a clip that was
   * authored without one, so it must apply to exactly this share and no more.
   * Applied over a clip that *is* holding a rifle it would fold the arms in
   * twice.
   */
  get unposed() {
    // The plain clips' own weights, unmasked: `_weightFor` is already the one
    // place that knows which states have a rifle twin and how much of each is
    // on the pose right now, and asking it is what keeps this number honest as
    // clips are added rather than making every new twin two edits.
    const share = this._weightFor('idle') + this._weightFor('walk') + this._weightFor('run');
    return MathUtils.clamp(share, 0, 1);
  }

  /**
   * Park the blend on the first frame of the idle, now rather than over a fade.
   *
   * `update` damps every weight so a shove on the input cannot pop the pose,
   * which is right for a body being driven and wrong for one about to be *held*
   * still: a pose frozen mid-fade is a soup of three clips, and gear aligned
   * against it is aligned against nothing. Rewinding the clips as well makes the
   * held frame the same one every time, so a placement judged in one session is
   * judged against the same silhouette in the next.
   */
  rest() {
    this.speed = 0;
    this.direction = 1;
    this.strafe = this._strafeTarget = 0;
    this._sidePhase = this._walkPhase = 0;
    this.weights = { idle: 1, walk: 0, run: 0 };
    // The stance snaps here for the same reason the weights do: a stand held
    // half way between two idles is a pose nobody authored, and gear judged
    // against it is judged against nothing.
    this.stance = this._stanceTarget;
    for (const key of [
      'idle',
      'idleRifle',
      'walk',
      'walkRifle',
      'walkSideRifle',
      'run',
      'runRifle'
    ]) {
      const action = this[key];
      if (!action) continue;
      action.setEffectiveWeight(this._weightFor(key));
      action.setEffectiveTimeScale(1);
      action.time = 0;
    }
  }

  /**
   * One action's share of the blend, with the stand and the walk each split
   * between their two clips.
   *
   * A missing twin collapses to the plain clip rather than to nothing, so a rig
   * whose rifle walk failed to export walks normally with a gun rather than
   * sliding along in a T-pose.
   */
  _weightFor(key, mask = 1) {
    const stance = this.stance;
    if (key === 'idle') return this.weights.idle * mask * (this.idleRifle ? 1 - stance : 1);
    if (key === 'idleRifle') return this.weights.idle * mask * stance;
    // The walk splits twice over: once between the plain cycle and the rifle
    // one, by the stance, and then that rifle share again between walking and
    // strafing. `_sidestep` is 0 without the clip, so a rig that never loaded
    // it splits exactly once and this reads as it always did.
    const sidestep = this._sidestep;
    if (key === 'walk') {
      const covered = (this.walkRifle ? 1 - sidestep : 0) + sidestep;
      return this.weights.walk * mask * (1 - stance * covered);
    }
    if (key === 'walkRifle') return this.weights.walk * mask * stance * (1 - sidestep);
    if (key === 'walkSideRifle') return this.weights.walk * mask * stance * sidestep;
    if (key === 'run') return this.weights.run * mask * (this.runRifle ? 1 - stance : 1);
    if (key === 'runRifle') return this.weights.run * mask * stance;
    return this.weights[key] * mask;
  }

  /**
   * How much of the rifle walk the sidestep has, 0..1 — and none of it if the
   * clip never loaded, which leaves such a rig leaning into its strafes through
   * the forward cycle exactly as it did before the clip existed.
   */
  get _sidestep() {
    return this.walkSideRifle ? Math.abs(this.strafe) : 0;
  }

  /**
   * Resolve weights and stride rate for this frame.
   *
   * Must run *before* the mixer is updated: the phase lock reads `walk.time`,
   * and writing `run.time` after the update would leave the run one frame stale
   * against the walk it is supposed to be locked to.
   */
  update(dt) {
    const config = settings.locomotion;
    const speed = this.speed;

    // Two nested blends: idle → walk below walking pace, then walk → run above
    // it. Expressed as one product so the three weights always sum to 1.
    const toWalk = MathUtils.clamp(speed / Math.max(0.01, config.walkSpeed), 0, 1);
    const toRun = MathUtils.clamp(
      (speed - config.walkSpeed) / Math.max(0.01, config.runSpeed - config.walkSpeed),
      0,
      1
    );

    const target = {
      run: toRun,
      walk: (1 - toRun) * toWalk,
      idle: (1 - toRun) * (1 - toWalk)
    };

    // The jump takes the pose over rather than replacing the blend: the gait is
    // still resolving underneath at whatever speed the body launched with, so
    // landing rejoins a run in stride instead of popping out of an idle. Only
    // one jump is ever up, but the two overlap by a blend or two when a hop is
    // still fading as a long jump launches — the loudest of them wins the pose.
    //
    // Standing and travelling are masked separately, because a jump may leave
    // some of the gait deliberately alive (`takeover`): an in-place clip that
    // took the whole pose would plant the legs while the controller keeps
    // carrying the body, which looks like a stop it never made. What survives is
    // the walk or the run — the idle has no motion to preserve.
    const standing = 1 - this._jumpWeight();
    const travelling = 1 - this._jumpTakeover();
    const mask = { idle: standing, walk: travelling, run: travelling };

    for (const key of ['idle', 'walk', 'run']) {
      this.weights[key] = damp(this.weights[key], target[key], config.blendRate, dt);
    }
    // The stand is one weight split across two clips, on the same curve as
    // everything else — see `setStance`.
    this.stance = damp(this.stance, this._stanceTarget, config.stanceRate, dt);
    // And the walk is one more weight split across two clips, on the gait's own
    // curve: the stick swinging from one side of the aim to the other is the
    // same kind of change as the stick swinging from a walk into a run.
    this.strafe = damp(this.strafe, this._strafeTarget, config.blendRate, dt);

    this.idle?.setEffectiveWeight(this._weightFor('idle', mask.idle));
    this.idleRifle?.setEffectiveWeight(this._weightFor('idleRifle', mask.idle));
    this.walk?.setEffectiveWeight(this._weightFor('walk', mask.walk));
    this.walkRifle?.setEffectiveWeight(this._weightFor('walkRifle', mask.walk));
    this.walkSideRifle?.setEffectiveWeight(this._weightFor('walkSideRifle', mask.walk));
    this.run?.setEffectiveWeight(this._weightFor('run', mask.run));
    this.runRifle?.setEffectiveWeight(this._weightFor('runRifle', mask.run));

    // The pace the blended pose travels at when played at rate 1 — the *clips'*
    // authored speeds, not the designer's `walkSpeed`/`runSpeed`. Dividing the
    // real speed by that is the multiplier that keeps the feet planted: double
    // the run speed and the legs turn over twice as fast to cover it.
    const nominal = MathUtils.lerp(
      Math.max(0.01, config.clipWalkSpeed),
      Math.max(0.01, config.clipRunSpeed),
      toRun
    );
    // …then the per-gait trim, blended on the same curve as the weights, so the
    // walk end of the blend can be re-timed without dragging the run with it.
    // The division is only as good as the two clip speeds above; this is the
    // knob for the part of the mismatch those numbers do not explain. Trim
    // before the clamp, so a trimmed rate is still bounded.
    const trim = MathUtils.lerp(config.walkAnimSpeed, config.runAnimSpeed, toRun);
    // …and the sign last, after the clamp: a reversed cycle is still bounded
    // by the same two numbers, it simply runs the other way.
    const stride =
      speed > config.idleThreshold
        ? MathUtils.clamp((speed / nominal) * trim, config.strideMin, config.strideMax) *
          this.direction
        : 1;

    this.walk?.setEffectiveTimeScale(stride);
    this.walkRifle?.setEffectiveTimeScale(stride);
    this.walkSideRifle?.setEffectiveTimeScale(stride);
    this.run?.setEffectiveTimeScale(stride);
    this.runRifle?.setEffectiveTimeScale(stride);

    this._lockPhase();
  }

  /** How much of the pose the full-body moves have taken between them, 0..1. */
  _jumpWeight() {
    let weight = 0;
    for (const move of this.overrides) weight = Math.max(weight, move.weight);
    return Math.min(1, weight);
  }

  /** The same, less whatever gait each of them chose to leave playing. */
  _jumpTakeover() {
    let weight = 0;
    for (const move of this.overrides) weight = Math.max(weight, move.takeover);
    return Math.min(1, weight);
  }

  /**
   * Slave every other cycle to the walk's normalised phase (see the class note).
   *
   * The rifle walk is locked to the plain one for exactly the reason the run is,
   * and more urgently: the two are cross-fading *into each other* through the
   * weapon swap, and two walk cycles free-running against each other put the
   * body on four legs for the length of the burn.
   */
  _lockPhase() {
    if (!this.walk) return;
    const walkDuration = this.walk.getClip().duration;
    if (walkDuration <= 0) return;

    // Wrapped rather than taken modulo: a reversed walk runs its clock
    // backwards, and a negative time handed to the others would be read as a
    // seek past the start of the clip rather than as the end of it.
    const phase = MathUtils.euclideanModulo(this.walk.time, walkDuration) / walkDuration;

    for (const action of [this.walkRifle, this.run, this.runRifle]) {
      if (!action) continue;
      const duration = action.getClip().duration;
      if (duration > 0) action.time = phase * duration;
    }

    // The sidestep gets the walk's *rate* instead of its phase, and its own
    // sign: the clip strafes left, so going right is that cycle read backwards
    // — the same trick the backpedal plays on the forward walk, for the same
    // reason. Which is why it cannot simply be handed the phase like the
    // others. Reading it as a mirror (`1 - phase`) would be a jump of half a
    // cycle every time the mirror turned over, and one of the two things that
    // turns it over is the *walk* reversing, which happens while the sidestep
    // is carrying nearly the whole pose. So the walk's step is taken unsigned,
    // given the strafe's sign and accumulated: the cycle rate still comes from
    // the master clock, so the two never drift apart or shuffle against each
    // other, and reversing it is a change of direction rather than a cut.
    //
    // The other thing that turns it over — the strafe crossing zero — is free
    // either way: the clip's weight is |strafe|, so it is at nothing exactly
    // when its direction changes.
    if (this.walkSideRifle) {
      // Shortest way round, so the wrap at the end of the cycle reads as the
      // small step it is rather than as a lap in the other direction.
      const step = MathUtils.euclideanModulo(phase - this._walkPhase + 0.5, 1) - 0.5;
      this._sidePhase = MathUtils.euclideanModulo(
        this._sidePhase + Math.abs(step) * Math.sign(this.strafe),
        1
      );
      const duration = this.walkSideRifle.getClip().duration;
      if (duration > 0) this.walkSideRifle.time = this._sidePhase * duration;
    }

    this._walkPhase = phase;
  }

  /** Whichever clip currently dominates — for HUDs and debugging. */
  get state() {
    if (this._jumpWeight() > 0.5) return 'jump';
    const { idle, walk, run } = this.weights;
    if (run >= walk && run >= idle) return 'run';
    return walk >= idle ? 'walk' : 'idle';
  }
}
