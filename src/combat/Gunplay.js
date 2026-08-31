import { Box3, Group, MathUtils, Matrix4, Raycaster, Vector2, Vector3 } from 'three';

import { settings } from '../config/settings.js';
import { isRanged } from '../equipment/EquipmentCatalog.js';
import { Crosshair } from '../ui/Crosshair.js';
import { FocusedBurst } from '../vfx/FocusedBurst.js';
import { ImpactSparks, MuzzleFlash } from '../vfx/GunFX.js';
import { nearestBody } from './Hitboxes.js';
import { FOCUSED, ORDINARY, Projectiles } from './Projectiles.js';

/** The middle of the screen, in NDC. The reticle is nailed to it. */
const CENTRE = /* @__PURE__ */ new Vector2(0, 0);

/**
 * The bits of `PointerEvent#buttons`: the trigger, the sights, the shoulder.
 *
 * The mask rather than `event.button`, because the mouse's buttons are chorded
 * and this mode holds two of them at once — see `_syncButtons`.
 */
const LEFT = 1;
const RIGHT = 2;
const MIDDLE = 4;

const _chest = /* @__PURE__ */ new Vector3();
const _muzzle = /* @__PURE__ */ new Vector3();
const _barrel = /* @__PURE__ */ new Vector3();
const _shot = /* @__PURE__ */ new Vector3();
const _tangent = /* @__PURE__ */ new Vector3();
const _bitangent = /* @__PURE__ */ new Vector3();
const _probe = /* @__PURE__ */ new Vector3();
const _spray = /* @__PURE__ */ new Vector3();
const _hand = /* @__PURE__ */ new Vector3();
const _face = /* @__PURE__ */ new Vector3();
const _candidate = /* @__PURE__ */ new Vector3();
const _local = /* @__PURE__ */ new Matrix4();
const _relative = /* @__PURE__ */ new Matrix4();
const _box = /* @__PURE__ */ new Box3();
const _corner = /* @__PURE__ */ new Box3();

/**
 * The shooter.
 *
 * ## What it is
 *
 * One object that is switched on by drawing the rifle and off by putting it
 * away, and while it is on it owns four things nothing else on the stage does:
 * where the lens sits, where the reticle's ray lands, which way the torso
 * points, and what happens when the trigger goes down. Everything else it does
 * is delegated — the rounds are `combat/Projectiles.js`, the pose is
 * `animation/RifleAim.js`, the shoulder is `core/CameraRig.js`, the reticle is
 * `ui/Crosshair.js`. This is the file that decides *when*.
 *
 * ## The geometry of a third-person shooter
 *
 * The reticle is not on the gun. It is a ray from the **lens**, out through the
 * middle of the screen, and where it lands is where the round is sent. The
 * muzzle is somewhere else entirely — half a metre down and to the side, riding
 * a hand that is swinging through a walk cycle — so the round leaves it on a
 * direction resolved *to the point the ray hit*, not along the barrel. That
 * convergence is the whole trick, and it is why the camera is pushed onto a
 * shoulder in the first place: with the lens on the body's axis the body is
 * standing in front of its own aim, and there is nowhere honest to put a
 * reticle at all.
 *
 * One thing follows from it that is worth knowing before it surprises you: at
 * very close range the round can pass to the side of something the reticle is
 * sitting on, because the muzzle and the lens genuinely disagree about where
 * that thing is. Every third-person shooter has this and none of them fix it.
 *
 * ## The pointer
 *
 * The pointer belongs to the stage, not to the gun: it is captured on the
 * first click and turns the view whatever is in the hand
 * (`core/PointerLook.js`), and `Escape` gives it back for a menu. What is the
 * gun's is only what the buttons then *mean* — the left one fires, the right
 * one sights, the middle one crosses the shoulder. Both of the first two down
 * together is the ordinary case rather than the odd one, which is why they are
 * read as a mask instead of off the event that changed them — see
 * `_syncButtons`.
 *
 * Nothing here answers while the pointer is free. The press that takes it is
 * spent on taking it, and the mode waits: a click that both focuses the window
 * and empties a magazine is how a player loses one to an alt-tab.
 *
 * ## The held shot
 *
 * One thing the right button does that is not the sights. Held for
 * `settings.gunplay.focus.charge` seconds with the feet planted and the trigger
 * untouched, a bar fills under the reticle, and the release that would
 * ordinarily just drop the sights sends a single round instead — no cone on it
 * at all, and whatever it lands on is taken apart by `vfx/FocusedBurst.js`.
 *
 * It is deliberately built out of the state that was already here rather than
 * out of a fourth button: the gesture a player makes to take a careful shot is
 * *already* holding the sights and standing still, and the only thing this adds
 * is that doing it for three seconds is worth something. Every one of the three
 * conditions that hold the charge is a condition the ordinary shot already
 * cares about, so there is nothing new to learn and nothing new to bind.
 */
export class Gunplay {
  /**
   * @param {object} options
   * @param {import('three').PerspectiveCamera} options.camera
   * @param {import('../core/CameraRig.js').CameraRig} options.rig
   * @param {import('../animation/CharacterController.js').CharacterController} options.character
   * @param {import('../animation/ThirdPersonController.js').ThirdPersonController} options.controller
   * @param {import('./EnemyManager.js').EnemyManager} options.enemies
   * @param {{heightAt: (x: number, z: number) => number}|null} [options.terrain]
   * @param {() => (import('../equipment/WeaponSwitch.js').WeaponSwitch|null)} options.weapons
   *   what is drawn. A function, because the loadout does not exist until the
   *   character screen is built and this does.
   * @param {() => (import('../equipment/EquipmentManager.js').EquipmentManager|null)} options.equipment
   *   where the gun itself is, for the muzzle
   * @param {import('../core/PointerLook.js').PointerLook} options.look who has
   *   the pointer. Read, never taken: the mode fires off a pointer the stage
   *   captured rather than capturing one of its own.
   * @param {() => boolean} [options.blocked] whether something else has the
   *   body — the studio, a marked ability
   * @param {(point: Vector3, direction: Vector3, count: number, speed: number) => void} [options.onBlood]
   * @param {(seconds: number, scale: number) => void} [options.onHitStop]
   */
  constructor({
    camera,
    rig,
    character,
    controller,
    enemies,
    terrain = null,
    weapons,
    equipment,
    look,
    blocked = () => false,
    onBlood = null,
    onHitStop = null
  }) {
    this.camera = camera;
    this.rig = rig;
    this.character = character;
    this.controller = controller;
    this.enemies = enemies;
    this.terrain = terrain;
    this.weapons = weapons;
    this.equipment = equipment;
    this.look = look;
    this.blocked = blocked;
    this.onBlood = onBlood;
    this.onHitStop = onHitStop;

    this.group = new Group();
    this.group.name = 'Gunplay';

    this.projectiles = new Projectiles({ terrain });
    this.sparks = new ImpactSparks();
    this.flash = new MuzzleFlash();
    // What the held shot leaves where it lands. Handed the height field because
    // the cracks it writes are struck into the *ground* under the contact and a
    // web four metres across on a slope has to lie on it.
    this.burst = new FocusedBurst({ terrain });
    this.group.add(
      this.projectiles.mesh,
      this.sparks.points,
      this.flash.group,
      this.burst.group
    );

    this.crosshair = new Crosshair();
    this.raycaster = new Raycaster();

    /** Where the reticle's ray landed this frame, in world space. */
    this.aimPoint = new Vector3();
    /** Whether it landed on a body. The reticle goes hot off this. */
    this.onBody = false;

    /** Seconds until the next round may leave. */
    this._cooldown = 0;
    /** Degrees of spread piled up by firing, over and above the base. */
    this._bloom = 0;

    /** Whether the trigger is down, and whether the sights are up. */
    this._trigger = false;
    this._sights = false;
    /**
     * One buffered press, on exactly the terms `core/Input.js` buffers a jump.
     *
     * The trigger is state — held, it keeps firing — but the *first* round of a
     * press is an edge, and an edge can fall down the gap between two frames. A
     * tap that goes down and up inside one long frame would otherwise be a
     * round the player fired and never saw leave, which is the single most
     * unforgivable thing a gun can do.
     */
    this._pressed = false;
    /** Which buttons were down at the last pointer event, as a `buttons` mask. */
    this._buttons = 0;

    /**
     * Seconds of held sights banked toward the focused shot.
     *
     * Runs past `focus.charge` rather than stopping at it, so `focus.hold` has
     * something to measure — see `_advanceCharge`.
     */
    this._charge = 0;
    /**
     * One buffered release, on exactly the terms `_pressed` buffers a press.
     *
     * The release of a full bar is an *edge*, and an edge can fall down the gap
     * between two frames. A player who earned the shot and let go inside one
     * long frame would otherwise have spent three seconds on nothing, which is
     * a worse thing for a gun to do than dropping an ordinary round.
     */
    this._release = false;

    /**
     * The blow the blast hands a ragdoll, rebuilt in place per body caught
     * rather than allocated — a burst that felled four of them is four
     * allocations on the one frame that cannot afford any.
     */
    this._blastForce = { impulse: 0, lift: 0, spin: 0, slices: false };

    /** The rifle model the muzzle was last measured on, and where it came out. */
    this._muzzleModel = null;
    this._muzzleLocal = new Vector3();

    this._bind();
  }

  /* ------------------------------------------------------------------ */

  /** Whether the rifle is the weapon in the hand. */
  get drawn() {
    const weapons = this.weapons();
    return Boolean(weapons && isRanged(weapons.current));
  }

  /** Whether the whole mode is up: the gun is out and nothing else wants the body. */
  get active() {
    return settings.gunplay.enabled && this.drawn && !this.blocked();
  }

  /**
   * Whether the body is sprinting: the run modifier down and the legs actually
   * carrying it somewhere.
   *
   * The state that takes the *aim* off the body, not just the shot. Nobody
   * holds a rifle on a target at a flat run, and the whole mode is built on the
   * promise that the round goes where the reticle is — so rather than let that
   * promise quietly get worse, the sprint takes the aim off the body outright:
   * the torso stops tracking (`animation/RifleAim.js` drops to nothing and
   * `RifleRun.fbx` carries the pose on its own) and the sights come down. The
   * trigger is already gone by then, and the reticle with it — both go the
   * moment the feet do, see `steady` — so what the sprint adds is the pose to
   * match: a body that has visibly given up on aiming rather than one still
   * holding a dead gun on a target.
   *
   * Read off the *modifier* rather than off the speed alone, because the key is
   * the intent: a body decelerating out of a sprint has stopped sprinting the
   * moment shift comes up, and a player who let go to take a shot should not
   * have to wait out the ramp for their reticle. The speed is only there to
   * keep a shift held while standing still from disarming a stationary shooter.
   */
  get sprinting() {
    const input = this.controller.input;
    if (!input?.running) return false;
    return this.controller.speed > settings.locomotion.idleThreshold;
  }

  /**
   * Whether the feet are planted — the body standing still, at either gait.
   *
   * The trigger's own condition, and a stricter one than `sprinting`. A round
   * sent from a walk is sent by a body rising and falling under its own stride,
   * and this whole mode is built on the promise that the round goes where the
   * reticle is. So movement is not paid for in spread and left for the player
   * to discover by missing: walking, running, sprinting, the shot is simply not
   * offered until they stop. One rule, and the only pace that shoots is none.
   *
   * Read off the smoothed speed rather than off the movement keys, because what
   * disqualifies the shot is the body *travelling*, not the intent to — a
   * player who lets go of W is still visibly walking for the length of the
   * ramp. It is the same number the legs go idle on (`animation/Locomotion.js`),
   * so the trigger comes back on the frame the walk cycle ends, which is the
   * frame the player is watching for.
   */
  get steady() {
    return this.controller.speed <= settings.locomotion.idleThreshold;
  }

  /** Whether the pointer is ours. The stage's answer, not this file's. */
  get locked() {
    return this.look?.locked === true;
  }

  /**
   * Whether the sights are actually up — the mode live and the right button
   * held.
   *
   * The one thing outside this file that has to know: the look is slowed while
   * a longer lens is on the eye (`core/PointerLook.js`), and the slowing is
   * the rig's, not the gun's.
   */
  get sighting() {
    return this.active && this._sights;
  }

  /**
   * Whether the conditions of the held shot are all in force.
   *
   * The sights up, the feet planted, the trigger up, and nothing else holding
   * the body. Any one of them breaking empties the bar outright rather than
   * pausing it — a charge that could be parked and picked up again is not a
   * held breath, it is a resource, and this is meant to cost the player the one
   * thing a shooter actually values: standing still, in the open, for three
   * seconds.
   *
   * The trigger is read as *held* rather than as rounds fired, because between
   * two rounds of an automatic burst there is a tenth of a second in which no
   * round is leaving — and a bar that crept up a percent in every one of those
   * gaps would be a bar flickering under the reticle for the whole magazine.
   */
  get holding() {
    if (!this.active || !this._sights || !this.steady) return false;
    if (this._trigger || this._pressed) return false;
    for (const move of this.character.attacks ?? []) {
      if (move.locked) return false;
    }
    return true;
  }

  /** How much of the charge has been served, 0..1. What the bar draws. */
  get charge() {
    const wanted = Math.max(0.05, settings.gunplay.focus.charge);
    return MathUtils.clamp(this._charge / wanted, 0, 1);
  }

  /** Whether the bar is full and the release would send the round. */
  get charged() {
    return settings.gunplay.focus.enabled && this._charge >= settings.gunplay.focus.charge;
  }

  /** Which shoulder the lens is over, as the settings hold it. */
  get shoulder() {
    return settings.gunplay.shoulder < 0 ? 'left' : 'right';
  }

  /**
   * Cross the lens to the other shoulder.
   *
   * A setting rather than a state, so the rig damps across it on its own and
   * the editor's own control means exactly what the key does.
   */
  swapShoulder() {
    settings.gunplay.shoulder = settings.gunplay.shoulder < 0 ? 1 : -1;
    return this.shoulder;
  }

  /**
   * Drop whatever the buttons were saying.
   *
   * Not the pointer itself — that is the stage's and outlives any one weapon.
   * What is dropped is this file's reading of it: a trigger held through a
   * holster, a sights held through the character screen.
   */
  standDown() {
    this._trigger = false;
    this._pressed = false;
    this._sights = false;
    // The charge goes with the sights, and the buffered release with it: a bar
    // filled before the pointer was handed back must not fire the moment it
    // comes back, at a target the player has not looked at since.
    this._charge = 0;
    this._release = false;
  }

  /* ------------------------------------------------------------------ */
  /* the frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Resolve the aim, and hand it to the body.
   *
   * Runs *before* the controller, because the heading it writes is what the
   * controller turns the body toward this frame — a frame late and the torso
   * would be chasing a body that was chasing the lens.
   *
   * @param {number} dt the simulation's clock
   */
  aim(dt) {
    const config = settings.gunplay;
    const live = this.active;
    const sprinting = live && this.sprinting;

    // The pointer being handed back takes the buttons with it, and it is a
    // *key* that hands it back: no pointer event says it happened, so a
    // trigger held through `Esc` would go on firing and a right button held
    // through it would hold the sights up, both until the mouse next moved.
    // Read every frame rather than off the lock's own event, because that is
    // the only clock this file has that `Esc` cannot slip past.
    if (!this.locked) this.standDown();

    // The sights go down with the aim: a lens zoomed onto a reticle that is not
    // on the screen is the mode half-left, which reads as a bug rather than as
    // a rule. The shoulder stays, though — dropping the whole rig back to the
    // walk camera would swing the view every time the player broke into a run.
    this.rig.setAim(live, live && this._sights && !sprinting);

    if (!live) {
      this.controller.aimYaw = null;
      this.character.rifle?.set(0, 0, 0);
      this.character.rifle?.update(dt);
      this.crosshair.show(false);
      // The pointer stays where it is: it is the stage's, and putting the
      // rifle away is not a reason to hand the player back a cursor they did
      // not ask for. Only what the buttons were saying goes.
      this.standDown();
      return;
    }

    this._resolveAim(config.aim);

    // The body squares up to the lens rather than to the point being aimed at:
    // at any range past a few metres they are the same answer, and the lens is
    // the stable one — a target crossing in front at two metres would otherwise
    // whip the whole body round after it.
    this.controller.aimYaw = this.rig.azimuth + Math.PI;

    const rifle = this.character.rifle;
    if (rifle) {
      this._chestAt(_chest);
      _shot.copy(this.aimPoint).sub(_chest);
      const length = _shot.length();
      if (length > 1e-4) {
        _shot.multiplyScalar(1 / length);
        const yaw = Math.atan2(_shot.x, _shot.z);
        const delta =
          MathUtils.euclideanModulo(yaw - this.character.facing + Math.PI, Math.PI * 2) - Math.PI;
        // The angles are handed over even at zero weight, so the twist goes on
        // damping toward the reticle under a pose that is not showing it — and
        // the torso is already where it belongs the instant the sprint ends,
        // rather than swinging round from wherever it was left.
        rifle.set(delta, Math.asin(MathUtils.clamp(_shot.y, -1, 1)), sprinting ? 0 : 1);
      }
      rifle.update(dt);
    }
  }

  /**
   * Fire, advance what is in the air, and draw the reticle.
   *
   * Runs at the end of the frame, after the skeleton has been posed and the
   * gear has ridden it — the muzzle is a point on a model hanging off a hand,
   * and asking for it any earlier is asking where the gun was last frame.
   *
   * @param {number} dt the simulation's clock
   * @param {number} raw real seconds — what the flash and the reticle run on
   */
  update(dt, raw) {
    const live = this.active;

    // Before anything can land, so a burst opened by a round arriving later in
    // this same frame is stamped with a clock its own shaders already agree
    // with — see `vfx/FocusedBurst.js#sync`.
    this.burst.sync(dt);

    if (live) {
      // The pose was written by `character.update`; the mounts were scaled
      // after it. This is the frame's final answer to where the gun is.
      this.character.root.updateMatrixWorld(true);
      this._advanceSpread(dt);
      this._advanceCharge(dt);
      this._pullTrigger();
      this._releaseFocus();
    } else {
      this._trigger = false;
      // And anything buffered goes with it: a press taken while the gun was
      // still out must not go off the next time it is drawn. The charge is in
      // that list — three seconds banked before a holster are not three seconds
      // the next draw inherits.
      this._pressed = false;
      this._charge = 0;
      this._release = false;
      this._bloom = 0;
    }

    // Rounds already in the air are advanced whatever the gun is doing: putting
    // the rifle away does not un-fire them.
    this.projectiles.update(dt, this.enemies.enemies, {
      onBody: (enemy, point, direction, head, kind) =>
        this._hitBody(enemy, point, direction, head, kind),
      onGround: (point, direction, kind) => this._hitGround(point, direction, kind)
    });
    this.sparks.update(dt);
    this.flash.update(raw, this.camera);
    // After the rounds, so a burst opened by one of them this frame is placed
    // and lit on the frame it opened rather than on the one after.
    this.burst.update(this.camera, settings.gunplay.focus.burst);

    this._drawReticle(live, raw);
  }

  /* ------------------------------------------------------------------ */
  /* aiming                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Where the middle of the screen lands, and on what.
   *
   * Two candidates and the nearer wins: a body, tested against the analytic
   * volumes in `combat/Hitboxes.js`, and the ground, walked along the height
   * field. Neither is a scene raycast — the floor is a plane displaced in a
   * vertex shader, so there is no geometry on the CPU to intersect that would
   * be either cheaper or more truthful than asking the field itself.
   *
   * With nothing hit the point is simply the far end of the ray, which is the
   * right answer rather than a fallback: aiming at the sky should send the
   * round at the sky.
   */
  _resolveAim(config) {
    this.raycaster.setFromCamera(CENTRE, this.camera);
    const origin = this.raycaster.ray.origin;
    const direction = this.raycaster.ray.direction;
    const range = Math.max(1, config.range);

    let distance = range;
    let onBody = false;

    const body = nearestBody(this.enemies.enemies, origin, direction, range);
    if (body) {
      distance = body.distance;
      onBody = true;
    }

    const ground = this._marchGround(origin, direction, distance, config.step);
    if (ground !== null && ground < distance) {
      distance = ground;
      onBody = false;
    }

    // Never nearer than the body the round is fired from.
    //
    // The lens sits behind the character, so a point resolved a metre in front
    // of the *lens* is a metre and a half *behind* the muzzle — and a shot aimed
    // at it would leave the barrel pointing back at the player. It can only
    // happen when the camera is jammed into a slope, which nothing collides
    // against, but "can only happen rarely" is not a reason to fire backwards.
    this.aimPoint
      .copy(origin)
      .addScaledVector(direction, Math.max(this.rig.distance + 1.5, distance));
    this.onBody = onBody;
  }

  /**
   * Where a ray meets the height field, in metres along it, or null.
   *
   * Marched with a step that grows with distance, because the error that
   * matters is *angular*: a metre of overshoot at eighty metres is invisible
   * and a metre at two is the difference between the reticle sitting on the
   * ground and floating over it. Whatever the march finds is then bisected, so
   * the coarse step only decides what is found, never how precisely.
   */
  _marchGround(origin, direction, limit, step) {
    const terrain = this.terrain;
    if (!terrain) return null;

    let previous = 0;
    // The lens is inside a hill — nothing collides it against the floor. The
    // honest answer is "the ground tells you nothing this frame", not "you are
    // aiming at your own feet".
    if (origin.y - terrain.heightAt(origin.x, origin.z) <= 0) return null;

    let t = Math.max(0.2, step);
    for (let pass = 0; pass < 160 && t < limit; pass++) {
      _probe.copy(origin).addScaledVector(direction, t);
      const above = _probe.y - terrain.heightAt(_probe.x, _probe.z);

      if (above <= 0) {
        // Between `previous` and `t`. Eight passes puts it under a centimetre
        // at any step this march can produce.
        let low = previous;
        let high = t;
        for (let i = 0; i < 8; i++) {
          const mid = (low + high) * 0.5;
          _probe.copy(origin).addScaledVector(direction, mid);
          if (_probe.y - terrain.heightAt(_probe.x, _probe.z) > 0) low = mid;
          else high = mid;
        }
        return (low + high) * 0.5;
      }

      previous = t;
      // The step grows with distance, because the error that matters is
      // angular: a metre of overshoot at eighty metres cannot be seen, and a
      // metre at two is the reticle floating over the ground.
      t += Math.max(step, t * 0.07);
    }

    return null;
  }

  /** The point the aim is measured from: the chest, or the best guess at it. */
  _chestAt(out) {
    const bone = this.character.getBone('Spine2') ?? this.character.getBone('Spine1');
    if (bone) return bone.getWorldPosition(out);
    return out
      .copy(this.character.position)
      .setY(this.character.position.y + this.character.height * 0.78);
  }

  /* ------------------------------------------------------------------ */
  /* firing                                                              */
  /* ------------------------------------------------------------------ */

  /** The cone the next round leaves in, in degrees. */
  get spread() {
    const fire = settings.gunplay.fire;
    if (this._sights) return Math.max(0, fire.adsSpread + this._bloom * 0.4);

    // How much of the movement penalty is in force, by how fast the body is
    // going against its own run speed. A player who stops to shoot is rewarded
    // for it, which is the entire lesson this number teaches.
    const pace = MathUtils.clamp(
      this.controller.speed / Math.max(0.1, settings.locomotion.runSpeed),
      0,
      1
    );
    return Math.max(0, MathUtils.lerp(fire.spread, fire.moveSpread, pace) + this._bloom);
  }

  /** Let the cooldown and the accumulated bloom run down. */
  _advanceSpread(dt) {
    const fire = settings.gunplay.fire;
    this._cooldown = Math.max(0, this._cooldown - dt);
    this._bloom = Math.max(0, this._bloom - fire.bloomRecover * dt);
  }

  /** Send a round, if the trigger is down and the gun is ready for one. */
  _pullTrigger() {
    const fire = settings.gunplay.fire;
    // Taken whether or not it can be answered — a press left in the buffer
    // fires later, at a moment the player did not ask for.
    const pressed = this._pressed;
    this._pressed = false;
    if ((!this._trigger && !pressed) || this._cooldown > 0) return;
    // A move that has taken the body over is holding both hands: the trigger is
    // refused for the length of it rather than the whole mode being dropped,
    // because the lens and the reticle belong to the gun and the gun is still
    // in the hand. The press is not buffered — a round that went off a second
    // after a kick landed is a round nobody asked for.
    for (const move of this.character.attacks ?? []) {
      if (move.locked) return;
    }
    // And any pace at all, on the same terms and for the same reason: the gun
    // is in the hand but the body is not behind it. The press is spent above
    // rather than buffered, so coming to a halt does not fire the round that
    // was refused half a second ago — see `steady`.
    if (!this.steady) return;

    // Semi-automatic: the press is spent here rather than held, so the button
    // has to come back up before another round will leave.
    if (!fire.auto) this._trigger = false;
    this._cooldown = 1 / Math.max(0.5, fire.rate);
    // And the held shot is off. The charge is a breath held, and a round fired
    // in the middle of one is the breath let go — the rule costs nothing to
    // learn, because a player who fires while charging finds out on the frame
    // they do it and every shooter alive already expects it.
    this._charge = 0;

    if (!this._resolveMuzzle(_muzzle, _barrel)) return;

    // The direction that makes the whole mode work: from where the round
    // actually is to where the reticle actually landed — never along the
    // barrel, which is pointing wherever the walk cycle left the hand.
    //
    // With one guard on it. If the point somehow ended up behind the gun, the
    // round is sent along the *view* instead: it is the answer the reticle was
    // drawn from, and it is never wrong about which way is forward.
    _shot.copy(this.aimPoint).sub(_muzzle);
    const view = this.raycaster.ray.direction;
    if (_shot.lengthSq() < 0.25 || _shot.dot(view) <= 0) _shot.copy(view);
    _shot.normalize();
    this._scatter(_shot, this.spread);

    this.projectiles.fire(_muzzle, _shot, fire.speed);
    this.flash.flash(_muzzle, _barrel);
    this.character.rifle?.shoot();

    // The kick. Up, and scattered a little either way, so a held burst climbs
    // and wanders rather than tracing a straight line up the screen.
    this.rig.punch(
      MathUtils.degToRad(fire.recoilPitch),
      MathUtils.degToRad(fire.recoilYaw) * (Math.random() * 2 - 1)
    );
    this.rig.shake(fire.shake);
    // The reticle is drawn from this value later in the same frame, so it opens
    // on the round that opened it rather than on the one after.
    this._bloom = Math.min(fire.bloomMax, this._bloom + fire.bloom);
  }

  /**
   * Push a direction off true by up to `degrees`, uniformly over the cone.
   *
   * The radius is drawn as `sqrt(random)` for the same reason the enemy ring
   * is: a plain uniform radius crowds the rounds into the middle, and a spread
   * whose middle is far more likely than its edge is not a spread, it is an
   * accurate gun with a nervous tic.
   */
  _scatter(direction, degrees) {
    if (degrees <= 1e-4) return direction;

    // Any perpendicular will do; +Y unless the shot is very nearly vertical.
    _tangent.set(0, 1, 0);
    if (Math.abs(direction.y) > 0.99) _tangent.set(1, 0, 0);
    _bitangent.crossVectors(direction, _tangent).normalize();
    _tangent.crossVectors(_bitangent, direction).normalize();

    const radius = Math.tan(MathUtils.degToRad(degrees)) * Math.sqrt(Math.random());
    const angle = Math.random() * Math.PI * 2;

    return direction
      .addScaledVector(_bitangent, Math.cos(angle) * radius)
      .addScaledVector(_tangent, Math.sin(angle) * radius)
      .normalize();
  }

  /* ------------------------------------------------------------------ */
  /* the held shot                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Bank a frame of held aim, or throw the lot away.
   *
   * There is no decay and there is no partial credit: the bar either fills or
   * it empties. A charge that drained smoothly would be the kinder rule and it
   * would also be the one that makes the shot *cheaper* — a player could serve
   * two of the three seconds, take a step, and serve the rest, which is not the
   * thing being asked for. What is being asked for is three seconds of standing
   * still, and the only honest way to price that is to make an interruption
   * cost all of it.
   */
  _advanceCharge(dt) {
    const focus = settings.gunplay.focus;
    if (!focus.enabled || !this.holding) {
      this._charge = 0;
      return;
    }

    this._charge += dt;

    // The window, when there is one. Past `charge + hold` the shot lapses and
    // the bar starts again, so a player who earned it and then wandered off
    // does not come back to a loaded gun. At `hold` 0 there is no window: the
    // offer stands for as long as the button is down, which is the default and
    // the kinder rule of the two.
    const window = Math.max(0, focus.hold);
    if (window <= 0) {
      this._charge = Math.min(this._charge, focus.charge);
      return;
    }
    if (this._charge >= focus.charge + window) this._charge = 0;
  }

  /** Spend the buffered release, if there is one to spend. */
  _releaseFocus() {
    const release = this._release;
    this._release = false;
    if (release) this._fireFocused();
  }

  /**
   * The one round the three seconds bought.
   *
   * Everything the ordinary trigger does, minus the one thing that makes it a
   * gun rather than a promise: there is no `_scatter` call. The spread is not
   * *reduced* for this shot, it does not exist — the round leaves on the exact
   * line from the muzzle to where the reticle landed, which is the whole thing
   * the player stood still for.
   */
  _fireFocused() {
    const focus = settings.gunplay.focus;
    // Spent whether or not it can be answered, exactly as a buffered press is:
    // a shot refused because a kick landed must not go off a second later.
    this._charge = 0;
    if (!focus.enabled) return;

    for (const move of this.character.attacks ?? []) {
      if (move.locked) return;
    }
    if (!this.steady) return;
    if (!this._resolveMuzzle(_muzzle, _barrel)) return;

    _shot.copy(this.aimPoint).sub(_muzzle);
    const view = this.raycaster.ray.direction;
    if (_shot.lengthSq() < 0.25 || _shot.dot(view) <= 0) _shot.copy(view);
    _shot.normalize();

    this.projectiles.fire(_muzzle, _shot, focus.speed, FOCUSED);
    this.flash.flash(_muzzle, _barrel);
    this.character.rifle?.shoot();

    // A far heavier kick than a round of the burst, and no bloom: the gun is
    // not left worse for having fired this, because there is no follow-up shot
    // for a bloom to spoil — the next one is three seconds away.
    this.rig.punch(
      MathUtils.degToRad(focus.recoilPitch),
      MathUtils.degToRad(focus.recoilYaw) * (Math.random() * 2 - 1)
    );
    this.rig.shake(focus.shake);
    // The ordinary trigger is held off for one round's worth of time, so a
    // player holding both buttons does not get the burst back on the same frame
    // the held round leaves.
    this._cooldown = Math.max(this._cooldown, 1 / Math.max(0.5, settings.gunplay.fire.rate));
  }

  /**
   * The held round arriving — wherever it arrived.
   *
   * The burst, the knock, the freeze and the blast, in that order, and nothing
   * here cares whether there was a body under it: a round that landed in the
   * dirt beside someone still went off, and it still catches them.
   *
   * @param {Vector3} point where it stopped
   * @param {Vector3} direction the way it was going
   * @param {object|null} [spare] a body already spent on the direct hit — it
   *   cannot be caught by the blast as well, or the round is worth its own
   *   damage twice against the one target it actually hit
   */
  _detonate(point, direction, spare = null) {
    const focus = settings.gunplay.focus;
    this.burst.fire(point, direction, focus.burst);
    this.rig.shake(focus.blastShake);
    this.onHitStop?.(focus.hitStop, focus.hitStopScale);
    this._blast(point, spare);
  }

  /**
   * What the blast is worth to everyone standing near it.
   *
   * Measured to the middle of a body rather than to its feet, because a burst
   * that went off at chest height a metre away is one metre from the body it
   * caught and not two — and the falloff is linear, because the player has to
   * be able to look at a group and guess who is inside it.
   */
  _blast(point, spare) {
    const focus = settings.gunplay.focus;
    const radius = Math.max(0, focus.blastRadius);
    if (radius <= 0 || focus.blastDamage <= 0) return;

    const lift = Math.max(0, settings.enemies.height) * 0.5;

    for (const enemy of this.enemies.enemies) {
      if (!enemy.alive || enemy === spare) continue;

      const position = enemy.position;
      const dx = position.x - point.x;
      const dy = position.y + lift - point.y;
      const dz = position.z - point.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance >= radius) continue;

      const share = 1 - distance / radius;
      const result = enemy.wound(Math.max(1, focus.blastDamage * share));
      if (result !== 'down') continue;

      // Thrown outward, and straight up for anything standing exactly on the
      // point — a body with no direction to be thrown in still has to go
      // somewhere, and up is the only answer that is never wrong.
      _tangent.set(dx, 0, dz);
      const flat = _tangent.length();
      if (flat < 1e-4) _tangent.set(0, 0, 1);
      else _tangent.multiplyScalar(1 / flat);

      this._blastForce.impulse = focus.impulse * share;
      this._blastForce.lift = focus.lift * share;
      this._blastForce.spin = focus.spin * share;
      this.enemies.kill(enemy, _tangent.x, _tangent.z, this._blastForce);
    }
  }

  /**
   * Where the barrel's tip is, and which way it points.
   *
   * ## Found rather than declared
   *
   * The obvious way to do this is to trust the catalog — the note says the
   * barrel runs down +Z — and take the far end of the model's bounds along
   * that axis. It is also the way that quietly breaks: exports arrive rotated
   * (this one is a Sketchfab scene, and those come in on their side), and a
   * flash going off at the stock is the kind of bug nobody thinks to look for
   * because the shooting still works.
   *
   * So the axis is *measured*. The six face centres of the model's own bounding
   * box are the six candidates for "the end of the piece", and the muzzle is
   * simply the one farthest from the hand holding it — which is true of every
   * gun ever modelled, whatever axis it was authored down. The barrel's
   * direction falls out of the same pair of points.
   *
   * Resolved once per model and then cached: the geometry does not move inside
   * its own space, and which end is which cannot change while it is mounted.
   *
   * @returns {boolean} false when there is no gun on the body to fire
   */
  _resolveMuzzle(out, forward) {
    const slot = this.equipment()?.get('rifle');
    const model = slot?.model;
    if (!model) return false;

    const hand = this.character.getBone('RightHand');
    if (hand) hand.getWorldPosition(_hand);
    else _hand.setFromMatrixPosition(model.matrixWorld);

    if (this._muzzleModel !== model) {
      this._muzzleModel = model;
      this._measureMuzzle(model);
    }

    const config = settings.gunplay.muzzle;
    out.copy(this._muzzleLocal).applyMatrix4(model.matrixWorld);

    forward.copy(out).sub(_hand);
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, 1).transformDirection(model.matrixWorld);
    forward.normalize();

    if (config.forward !== 0) out.addScaledVector(forward, config.forward);
    if (config.up !== 0 || config.right !== 0) {
      // A frame around the barrel rather than around the model, so the two
      // trims mean "above the barrel" and "beside it" to whoever is dialling
      // them, whatever the export was authored down.
      _bitangent.set(0, 1, 0);
      _tangent.crossVectors(forward, _bitangent);
      if (_tangent.lengthSq() < 1e-8) _tangent.set(1, 0, 0);
      _tangent.normalize();
      _bitangent.crossVectors(_tangent, forward).normalize();
      out.addScaledVector(_tangent, config.right).addScaledVector(_bitangent, config.up);
    }

    return true;
  }

  /**
   * Which face of the model's bounds is the business end.
   *
   * The six face centres are tested rather than the eight corners, because a
   * corner is off the barrel's axis by half the piece's width in two
   * directions — enough to hang the flash off the side of it.
   */
  _measureMuzzle(model) {
    localBounds(model, _box);
    _box.getCenter(_face);

    let best = -1;
    for (const axis of ['x', 'y', 'z']) {
      for (const end of [_box.min[axis], _box.max[axis]]) {
        _candidate.copy(_face);
        _candidate[axis] = end;
        _probe.copy(_candidate).applyMatrix4(model.matrixWorld);
        const distance = _probe.distanceToSquared(_hand);
        if (distance <= best) continue;
        best = distance;
        this._muzzleLocal.copy(_candidate);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* contact                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * A round reached a body.
   *
   * Three in the chest or one above the collar, which is `settings.gunplay
   * .damage` and not a rule written here: the body is told what the round was
   * worth and hands back whether that was the last of it.
   *
   * The held round takes the same path with two differences and no third: it is
   * worth `focus.damage` rather than `damage.body`, and it goes off where it
   * stopped. Everything after that — the blood, the ragdoll, the mark on the
   * reticle — is the same code, because a round arriving is a round arriving.
   *
   * @param {number} [kind] `ORDINARY` or `FOCUSED`, from the pool
   */
  _hitBody(enemy, point, direction, head, kind = ORDINARY) {
    const damage = settings.gunplay.damage;
    const focus = settings.gunplay.focus;
    const focused = kind === FOCUSED;

    const worth = focused
      ? head
        ? focus.headDamage
        : focus.damage
      : head
        ? damage.head
        : damage.body;
    const result = enemy.wound(worth);

    // The burst first, and whatever the wound came back with — a held round
    // that arrived a frame after something else took the body down still
    // arrived, and a shot that visibly hit and did nothing at all is the one
    // thing three seconds of aim cannot be allowed to buy.
    if (focused) this._detonate(point, direction, enemy);
    if (!result) return;

    // Out of the wound the way the round was going, lifted a little — a spray
    // thrown flat along the ground reads as a puddle rather than as an exit.
    _spray.copy(direction).setY(direction.y * 0.4 + 0.35).normalize();
    this.onBlood?.(
      point,
      _spray,
      head ? damage.headBlood : damage.bodyBlood,
      damage.bloodSpeed
    );

    if (result === 'hit') {
      this.rig.shake(damage.hitShake);
      this.crosshair.hit(false);
      return;
    }

    // The blow the ragdoll is handed. A rifle does not take a body apart, so
    // `slices` is false and the corpse goes down whole — the cut belongs to the
    // sword, and a round that halved someone would say the wrong thing about
    // both weapons. The held round shoves far harder, which is the one place
    // its weight is visible after the light has gone.
    const force = focused
      ? { impulse: focus.impulse, lift: focus.lift, spin: focus.spin, slices: false }
      : {
          impulse: head ? damage.headImpulse : damage.impulse,
          lift: head ? damage.headLift : damage.lift,
          spin: head ? damage.headSpin : damage.spin,
          slices: false
        };

    _tangent.set(direction.x, 0, direction.z);
    const flat = _tangent.length();
    if (flat < 1e-4) _tangent.set(0, 0, 1);
    else _tangent.multiplyScalar(1 / flat);

    if (!this.enemies.kill(enemy, _tangent.x, _tangent.z, force)) return;

    // The held round has already knocked the lens and frozen the world on its
    // own terms (`_detonate`); doing it twice on the same frame would stack two
    // hit-stops into one long stutter.
    if (!focused) {
      this.rig.shake(damage.killShake);
      this.onHitStop?.(damage.killHitStop, damage.killHitStopScale);
    }
    this.crosshair.hit(true);
  }

  /**
   * A round reached the floor.
   *
   * An ordinary one throws a handful of sparks off it and is finished. A held
   * one opens where it landed, and the sparks go with it — the burst has a
   * shower of its own and the impact's dozen would be lost inside it.
   */
  _hitGround(point, direction, kind = ORDINARY) {
    if (kind === FOCUSED) {
      this._detonate(point, direction);
      return;
    }
    this.sparks.burst(point, direction);
  }

  /* ------------------------------------------------------------------ */
  /* the reticle                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Say on screen what the gun is about to do.
   *
   * The spread is converted from an angle to pixels here rather than in the
   * reticle, because this is the only place that has both halves of the
   * conversion — the cone the rounds leave in, and the lens they are being
   * drawn through. Which means the gap is *literally* the group the next round
   * could land in: the reticle is not a decoration that widens, it is the
   * spread, drawn.
   */
  _drawReticle(live, raw) {
    // A reticle over a trigger that will not answer is worse than no reticle at
    // all, so the reticle is on the screen only while the shot is: the feet
    // decide both. It leaves on the first step — a walk, a run or a sprint, the
    // rule does not care which — and comes back on the frame the walk cycle
    // ends, because `steady` reads the same threshold the legs go idle on. One
    // mark, one meaning: if it is drawn, the round goes where it is.
    //
    // It still dims on the way out rather than blinking (`setBlocked`), so the
    // trigger is visibly lost a beat before the mark is, and the mark is still
    // aged while it is gone: a hit from the last round belongs to the round,
    // not to the pose, and must not be found still burning on the way back in.
    const ready = this.steady;
    const aiming = live && ready;
    this.crosshair.show(aiming);
    this.crosshair.setBlocked(!ready);
    // Before the early-out, so a bar on screen leaves on the frame the player
    // takes the step that emptied it rather than being frozen where it was.
    this.crosshair.setCharge(this.charge, this._charge > 0);
    this.crosshair.update(raw);
    if (!aiming) return;

    const half = MathUtils.degToRad(this.camera.fov) * 0.5;
    const pixels =
      ((window.innerHeight * 0.5) * Math.tan(MathUtils.degToRad(this.spread))) / Math.tan(half);

    this.crosshair.setSpread(4 + pixels);
    // Cold while the trigger is held: "that is a body" and "and you cannot
    // shoot it" are two lights the player would otherwise have to read against
    // each other.
    this.crosshair.setHot(ready && this.onBody);
  }

  /* ------------------------------------------------------------------ */
  /* the pointer                                                         */
  /* ------------------------------------------------------------------ */

  _bind() {
    /**
     * Spend a change in which buttons are down.
     *
     * ## Why the buttons are read as a mask
     *
     * The mouse's buttons are **chorded**, and the pointer events say so: a
     * `pointerdown` is raised only when the first button goes down, and a
     * `pointerup` only when the last one comes back up. Every press and every
     * release in between arrives as a `pointermove` carrying a new `buttons`
     * mask, and as nothing else at all.
     *
     * Which is exactly the shape of this mode. The sights are the right button
     * and the trigger is the left, so the trigger's own press — taken with the
     * sights already up, which is the moment it matters most — is never a
     * `pointerdown`. A handler reading `event.button` off the down event is
     * therefore a gun that cannot fire down its own sights, and the reverse:
     * the sights cannot come up mid-burst either. So every handler hands its
     * event here instead and the mask is diffed against the one it left.
     *
     * The trigger is taken off the *edge* rather than off the state, because a
     * semi-automatic gun spends `_trigger` on the round it fires
     * (`_pullTrigger`) and a mask re-read on every twitch of the mouse would
     * hand it straight back. The sights are the opposite — pure state, up for
     * exactly as long as the button is down.
     *
     * @param {PointerEvent} event
     */
    this._syncButtons = (event) => {
      const now = event.buttons ?? 0;
      const down = now & ~this._buttons;
      // Tracked in every state, live or not: a button held down through the
      // character screen must not read as a fresh press on the way back out.
      this._buttons = now;

      if (!this.active) {
        this.standDown();
        return;
      }

      // Nothing the buttons say counts while the pointer is free. That press
      // is the one taking the pointer back (`core/PointerLook.js`), and the
      // sights go with the trigger: a right button held to orbit the camera
      // with a cursor is a drag, not an eye down a scope.
      if (!this.locked) {
        this.standDown();
        return;
      }

      if (down & MIDDLE) {
        // The middle button is free — OrbitControls is given neither of the
        // gestures that would want it (see `core/CameraRig.js`).
        this.swapShoulder();
      }

      // The sights, and the one edge on this button that means something else.
      // A right button that comes up on a full bar is not the sights coming
      // down, it is the shot being taken — latched here rather than read off
      // `_sights` in the frame loop, because the state is gone by the time the
      // loop next runs and the edge is the whole event.
      const sights = Boolean(now & RIGHT);
      if (this._sights && !sights && this.charged) this._release = true;
      this._sights = sights;

      if (down & LEFT) {
        this._trigger = true;
        this._pressed = true;
      } else if (!(now & LEFT)) {
        this._trigger = false;
      }
    };

    this._onPointerDown = (event) => {
      // Only the event the button actually arrives on can refuse the browser's
      // own middle-button gesture, so it is refused here rather than beside the
      // shoulder swap. Nothing else about the press is this file's: the one
      // that takes the pointer is stopped by `core/PointerLook.js`, and while
      // the pointer is ours the orbit drag is already stood down.
      if (this.active && event.button === 1) event.preventDefault();

      this._syncButtons(event);
    };

    this._onPointerUp = (event) => {
      this._syncButtons(event);
    };

    this._onPointerMove = (event) => {
      // A chorded press arrives on this event and on no other: this is where
      // the trigger goes down while the sights are already up. The turn the
      // same move carries is the stage's — see `core/PointerLook.js`.
      this._syncButtons(event);
    };

    this._onBlur = () => {
      // The window going away takes the buttons with it: whatever is physically
      // down cannot be reported again until the page has focus, so the mask has
      // to go too or the first press back reads as no press at all.
      this._buttons = 0;
      this.standDown();
    };

    // In the capture phase, so the middle button's own gesture is refused
    // before anything downstream can act on the press.
    window.addEventListener('pointerdown', this._onPointerDown, true);
    window.addEventListener('pointerup', this._onPointerUp);
    // On the window rather than the canvas: while the pointer is locked every
    // move is targeted at the canvas anyway, and while it is not this is the
    // only way a button released off the canvas is ever seen.
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('blur', this._onBlur);
  }

  dispose() {
    this.standDown();
    window.removeEventListener('pointerdown', this._onPointerDown, true);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('blur', this._onBlur);

    this.crosshair.dispose();
    this.projectiles.dispose();
    this.sparks.dispose();
    this.flash.dispose();
    this.burst.dispose();
    this.group.parent?.remove(this.group);
  }
}

/**
 * An object's bounds in its *own* space.
 *
 * `Box3.setFromObject` answers in world space, which is no use for a point that
 * has to survive the thing being moved, scaled and re-parented — and the gun is
 * all three of those every time the studio is opened. So each mesh's geometry
 * bounds are brought back through the root's inverse instead.
 */
function localBounds(root, out) {
  root.updateWorldMatrix(true, true);
  _local.copy(root.matrixWorld).invert();
  out.makeEmpty();

  root.traverse((node) => {
    const geometry = node.geometry;
    if (!geometry) return;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundingBox) return;
    _relative.multiplyMatrices(_local, node.matrixWorld);
    _corner.copy(geometry.boundingBox).applyMatrix4(_relative);
    out.union(_corner);
  });

  if (out.isEmpty()) out.set(new Vector3(0, 0, 0), new Vector3(0, 0, 0.5));
  return out;
}
