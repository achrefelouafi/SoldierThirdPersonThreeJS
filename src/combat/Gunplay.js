import { Box3, Group, MathUtils, Matrix4, Raycaster, Vector2, Vector3 } from 'three';

import { settings } from '../config/settings.js';
import { isRanged } from '../equipment/EquipmentCatalog.js';
import { Crosshair } from '../ui/Crosshair.js';
import { ImpactSparks, MuzzleFlash } from '../vfx/GunFX.js';
import { nearestBody } from './Hitboxes.js';
import { Projectiles } from './Projectiles.js';

/** The middle of the screen, in NDC. The reticle is nailed to it. */
const CENTRE = /* @__PURE__ */ new Vector2(0, 0);

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
 * The pointer is captured on the first click, because a reticle in the middle
 * of the screen and a cursor that has to be dragged to turn the view are two
 * different games. While it is captured the mouse turns the rig directly
 * (`CameraRig#look`), the left button fires and the right one sights. Escape
 * gives the pointer back, and anything that needs the cursor again — the
 * studio, an ability being aimed by clicking on bodies — takes it back through
 * `blocked`.
 */
export class Gunplay {
  /**
   * @param {object} options
   * @param {import('three').PerspectiveCamera} options.camera
   * @param {import('../core/CameraRig.js').CameraRig} options.rig
   * @param {HTMLElement} options.domElement the canvas — where the pointer is read
   * @param {import('../animation/CharacterController.js').CharacterController} options.character
   * @param {import('../animation/ThirdPersonController.js').ThirdPersonController} options.controller
   * @param {import('./EnemyManager.js').EnemyManager} options.enemies
   * @param {{heightAt: (x: number, z: number) => number}|null} [options.terrain]
   * @param {() => (import('../equipment/WeaponSwitch.js').WeaponSwitch|null)} options.weapons
   *   what is drawn. A function, because the loadout does not exist until the
   *   character screen is built and this does.
   * @param {() => (import('../equipment/EquipmentManager.js').EquipmentManager|null)} options.equipment
   *   where the gun itself is, for the muzzle
   * @param {() => boolean} [options.blocked] whether something else has the
   *   pointer or the body — the studio, a marked ability, flight
   * @param {(point: Vector3, direction: Vector3, count: number, speed: number) => void} [options.onBlood]
   * @param {(seconds: number, scale: number) => void} [options.onHitStop]
   */
  constructor({
    camera,
    rig,
    domElement,
    character,
    controller,
    enemies,
    terrain = null,
    weapons,
    equipment,
    blocked = () => false,
    onBlood = null,
    onHitStop = null
  }) {
    this.camera = camera;
    this.rig = rig;
    this.domElement = domElement;
    this.character = character;
    this.controller = controller;
    this.enemies = enemies;
    this.terrain = terrain;
    this.weapons = weapons;
    this.equipment = equipment;
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
    /** Whether the pointer is ours. */
    this.locked = false;

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

  /** Give the pointer back — for anything that needs a cursor again. */
  releaseLook() {
    if (document.pointerLockElement === this.domElement) document.exitPointerLock();
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

    this.rig.setAim(live, live && this._sights);

    if (!live) {
      this.controller.aimYaw = null;
      this.character.rifle?.set(0, 0, 0);
      this.character.rifle?.update(dt);
      this.crosshair.show(false);
      this.crosshair.setHint(null);
      if (this.locked) this.releaseLook();
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
        rifle.set(delta, Math.asin(MathUtils.clamp(_shot.y, -1, 1)), 1);
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
    this.crosshair.show(live);
    this.crosshair.update(raw);
    if (!live) return;

    const half = MathUtils.degToRad(this.camera.fov) * 0.5;
    const pixels =
      ((window.innerHeight * 0.5) * Math.tan(MathUtils.degToRad(this.spread))) / Math.tan(half);

    this.crosshair.setSpread(4 + pixels);
    this.crosshair.setHot(this.onBody);
    this.crosshair.setHint(this.locked ? null : 'Click to take the sights');
  }

  /* ------------------------------------------------------------------ */
  /* the pointer                                                         */
  /* ------------------------------------------------------------------ */

  _bind() {
    const element = this.domElement;

    this._onPointerDown = (event) => {
      if (!this.active) return;

      // While the gun is up, a press on the canvas is the shooter's and nobody
      // else's — stopped here, in the capture phase, before it can reach the
      // listeners the canvas itself carries.
      //
      // It has to be *every* press rather than only the ones taken while the
      // pointer is locked. OrbitControls asks for a pointer **capture** on each
      // button down, and a captured pointer and a locked one are mutually
      // exclusive: the request throws. That includes the very press that takes
      // the lock, because the browser may grant it between this handler and the
      // canvas's. Which costs nothing — a drag that orbits is what the mouse
      // does when the pointer is *not* captured, and the first click captures
      // it.
      if (event.target === element) event.stopPropagation();

      if (event.button === 1) {
        // The middle button is free — OrbitControls is given neither of the
        // gestures that would want it (see `core/CameraRig.js`).
        event.preventDefault();
        this.swapShoulder();
        return;
      }

      if (event.button === 2) {
        this._sights = true;
        return;
      }

      if (event.button !== 0) return;

      if (document.pointerLockElement !== element) {
        // The click that takes the pointer is not also a round: it is the one
        // that focuses the window, and firing on it is how a player loses a
        // magazine to alt-tabbing back in.
        const claim = element.requestPointerLock?.();
        // Chrome hands back a promise and rejects it if the lock is asked for
        // too soon after one was released. Nothing here has to react — the
        // hint under the reticle already says the pointer is not ours.
        claim?.catch?.(() => {});
        return;
      }

      this._trigger = true;
      this._pressed = true;
    };

    this._onPointerUp = (event) => {
      if (event.button === 2) this._sights = false;
      if (event.button !== 0) return;
      this._trigger = false;
    };

    this._onPointerMove = (event) => {
      if (document.pointerLockElement !== element) return;
      const config = settings.gunplay.camera;
      const sensitivity = config.sensitivity * (this._sights ? config.adsSensitivity : 1);
      // Yaw right for a mouse moving right; pitch up for one moving away. The
      // rig buffers both and spends them on its own frame — see `CameraRig#look`.
      this.rig.look(event.movementX * sensitivity, -event.movementY * sensitivity);
    };

    this._onLockChange = () => {
      this.locked = document.pointerLockElement === element;
      if (!this.locked) {
        this._trigger = false;
        this._sights = false;
      }
    };

    this._onBlur = () => {
      this._trigger = false;
      this._pressed = false;
      this._sights = false;
    };

    // On the window, in the capture phase, so this runs before the canvas's own
    // listeners and can keep the press away from them — see the handler.
    window.addEventListener('pointerdown', this._onPointerDown, true);
    window.addEventListener('pointerup', this._onPointerUp);
    element.addEventListener('pointermove', this._onPointerMove);
    document.addEventListener('pointerlockchange', this._onLockChange);
    window.addEventListener('blur', this._onBlur);
  }

  dispose() {
    this.releaseLook();
    window.removeEventListener('pointerdown', this._onPointerDown, true);
    window.removeEventListener('pointerup', this._onPointerUp);
    this.domElement.removeEventListener('pointermove', this._onPointerMove);
    document.removeEventListener('pointerlockchange', this._onLockChange);
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
