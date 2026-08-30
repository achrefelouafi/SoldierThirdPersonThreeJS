import { Box3, Group, MathUtils, Matrix4, Raycaster, Vector2, Vector3 } from 'three';

import { settings } from '../config/settings.js';
import { isRanged } from '../equipment/EquipmentCatalog.js';
import { Crosshair } from '../ui/Crosshair.js';
import { ImpactSparks, MuzzleFlash } from '../vfx/GunFX.js';
import { nearestBody } from './Hitboxes.js';
import { Projectiles } from './Projectiles.js';

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
    this.group.add(this.projectiles.mesh, this.sparks.points, this.flash.group);

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

    if (live) {
      // The pose was written by `character.update`; the mounts were scaled
      // after it. This is the frame's final answer to where the gun is.
      this.character.root.updateMatrixWorld(true);
      this._advanceSpread(dt);
      this._pullTrigger();
    } else {
      this._trigger = false;
      // And anything buffered goes with it: a press taken while the gun was
      // still out must not go off the next time it is drawn.
      this._pressed = false;
      this._bloom = 0;
    }

    // Rounds already in the air are advanced whatever the gun is doing: putting
    // the rifle away does not un-fire them.
    this.projectiles.update(dt, this.enemies.enemies, {
      onBody: (enemy, point, direction, head) => this._hitBody(enemy, point, direction, head),
      onGround: (point, direction) => this.sparks.burst(point, direction)
    });
    this.sparks.update(dt);
    this.flash.update(raw, this.camera);

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
   */
  _hitBody(enemy, point, direction, head) {
    const damage = settings.gunplay.damage;
    const result = enemy.wound(head ? damage.head : damage.body);
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
    // both weapons.
    const force = {
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

    this.rig.shake(damage.killShake);
    this.onHitStop?.(damage.killHitStop, damage.killHitStopScale);
    this.crosshair.hit(true);
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

      this._sights = Boolean(now & RIGHT);

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
