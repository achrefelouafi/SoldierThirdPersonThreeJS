import { MathUtils, PerspectiveCamera, Spherical, Vector3, MOUSE, TOUCH } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { settings } from '../config/settings.js';
import { clamp, damp, lerp } from '../utils/math.js';
import { LAYER } from './Layers.js';

const _dir = new Vector3();
const _desiredTarget = new Vector3();
const _follow = new Vector3(); // how far the target moved this frame
const _right = new Vector3(); // the lens's own X, for the shoulder offset
const _up = new Vector3(); // and its Y
const _spherical = new Spherical(); // the orbit, while the mouse is turning it

/**
 * Third-person orbit rig.
 *
 * The distance always resolves back to `settings.camera.distance`, so framing
 * stays consistent no matter where the orbit target drifts. The wheel zooms by
 * writing that same setting rather than by moving the camera, which keeps the
 * settings file the single source of truth — set `distance` from anywhere and
 * the rig glides to it.
 */
export class CameraRig {
  constructor(domElement) {
    this.camera = new PerspectiveCamera(
      settings.camera.fov,
      window.innerWidth / window.innerHeight,
      0.1,
      400
    );
    // Behind the character and slightly off axis, so the opening frame looks out
    // *into the moon* — which is the shot every backlit thing in this scene (the
    // haze's inscatter, the ground mist, the silver on the clouds) is built for.
    // Only the direction matters: the rig resolves the distance back to
    // `settings.camera.distance` on the first update.
    this.camera.position.set(1.7, 2.3, -5.4);
    this.camera.layers.enable(LAYER.VFX);

    this.controls = new OrbitControls(this.camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.enablePan = false;
    this.controls.enableZoom = false; // the wheel drives `settings.camera.distance` instead
    this.controls.minPolarAngle = settings.camera.minPolar;
    this.controls.maxPolarAngle = settings.camera.maxPolar;
    this.controls.rotateSpeed = 0.65;

    // Either button orbits: nothing here needs the left one for anything else.
    this.controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: null, RIGHT: MOUSE.ROTATE };
    this.controls.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_ROTATE };

    /** The point the rig orbits around — the character's feet. */
    this.anchor = new Vector3(0, 0, 0);

    /**
     * The two things that can stand the orbit drag down, held apart.
     *
     * `parked` is the studio: another camera is on screen and this rig is not
     * being looked through at all, so the wheel is dead too. `pointerLocked`
     * is the play stage's ordinary state — the mouse is turning the view
     * through `look` instead of dragging it, so OrbitControls must not also be
     * reading it, but the wheel is still the player's zoom.
     *
     * Kept as two flags rather than as one `controls.enabled` because they are
     * released by different things and either one alone must hold: coming back
     * from the studio with the pointer still captured must not hand the orbit
     * back to a drag nobody is making.
     */
    this.parked = false;
    this.pointerLocked = false;

    /**
     * Impact shake: how much is left of it, and where it put the lens last
     * frame.
     *
     * Held as an offset that is *taken back off* the camera at the top of the
     * next update rather than baked into the position. OrbitControls reads its
     * own orbit back out of `camera.position` every frame, so a shake left in
     * there would be mistaken for the user dragging and the whole rig would
     * walk away from its target.
     */
    this._shake = 0;
    this._shakeOffset = new Vector3();
    this._shakeSeed = Math.random() * 100;

    /**
     * The over-the-shoulder aim — how far into it the rig is, and how far down
     * the sights on top of that.
     *
     * Both are blends rather than switches, and `side` is the third: it damps
     * between -1 and +1 rather than flipping, so swapping shoulders is the lens
     * *crossing* behind the body instead of teleporting past it. That crossing
     * is a quarter of a second long and it is what makes the swap feel like a
     * camera move rather than a glitch.
     */
    this.aim = { active: false, ads: false };
    this._aimBlend = 0;
    this._adsBlend = 0;
    this._side = settings.gunplay.shoulder;

    /**
     * The shoulder offset the lens is currently standing at.
     *
     * Held and taken back off exactly as the shake is, and for the same reason:
     * OrbitControls re-derives its whole orbit from `camera.position` every
     * frame, so an offset left in there would be read as the user having
     * dragged the camera sideways and the rig would walk off its target one
     * frame at a time.
     *
     * It is applied *after* `lookAt`, which is the entire trick: the lens is
     * translated without being re-aimed, so the view direction is untouched and
     * the body simply slides out of the middle of the frame. The centre of the
     * screen then looks past the shoulder into the distance — which is what the
     * reticle is a ray along.
     */
    this._aimOffset = new Vector3();

    /**
     * Mouse-look, buffered.
     *
     * The pointer is captured on the play stage (`core/PointerLook.js`), and
     * the deltas arrive on their own events rather than on frames. They are
     * accumulated here and spent inside `update`, where the aim offset has
     * already been taken off — turning the orbit while that offset was still
     * baked into the position would rotate the lens around the wrong point.
     */
    this._lookYaw = 0;
    this._lookPitch = 0;
    /** How much of the pitch is recoil the rig still owes back. */
    this._recoil = 0;

    this.controls.target.set(0, settings.camera.targetHeight, 0);
    this.controls.update();

    // Actual distance, eased toward `settings.camera.distance` so a wheel flick
    // glides instead of snapping.
    this.distance = settings.camera.distance;

    this.domElement = domElement;
    this._onWheel = this._onWheel.bind(this);
    domElement.addEventListener('wheel', this._onWheel, { passive: false });

    /**
     * Let the run key coexist with the orbit.
     *
     * OrbitControls reads ctrl/meta/shift on pointer-down and turns a rotate
     * drag into a pan — but panning is off, so it bails and the drag does
     * nothing at all. Holding Shift to run would therefore lock the camera
     * until the button came back up. The modifier gesture has no use here, so
     * the flags are masked off on the way in. Capture on `window` runs before
     * the controls' own listener on the canvas; the mask is per-event, so the
     * real keyboard state the character reads is untouched.
     */
    this._onPointerDownCapture = (event) => {
      if (event.target !== domElement) return;
      if (!event.shiftKey && !event.ctrlKey && !event.metaKey) return;
      for (const flag of ['shiftKey', 'ctrlKey', 'metaKey']) {
        Object.defineProperty(event, flag, { value: false, configurable: true });
      }
    };
    window.addEventListener('pointerdown', this._onPointerDownCapture, true);
  }

  /**
   * Park the rig, or bring it back.
   *
   * The studio's own camera is on screen and this one is not being looked
   * through, so neither the drag nor the wheel means anything here.
   *
   * @param {boolean} on
   */
  park(on) {
    this.parked = on;
    this._syncControls();
  }

  /**
   * The pointer has been captured, or given back.
   *
   * @param {boolean} on
   */
  setPointerLocked(on) {
    this.pointerLocked = on;
    this._syncControls();
  }

  /** Either flag alone stands the orbit drag down. */
  _syncControls() {
    this.controls.enabled = !this.parked && !this.pointerLocked;
  }

  /** Wheel zoom. Multiplicative, so each notch feels the same at any distance. */
  _onWheel(event) {
    // The character screen parks this rig and takes the pointer; a wheel meant
    // for its own camera must not also dolly the one nobody is looking through.
    // Read off `parked` rather than off `controls.enabled`, which is also down
    // whenever the pointer is captured — and the zoom is the player's in that
    // state, not the drag's.
    if (this.parked) return;
    event.preventDefault();

    const cam = settings.camera;
    // Firefox reports lines (deltaMode 1) and pages (2) rather than pixels.
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
    const delta = (event.deltaY * scale) / 100;

    cam.distance = clamp(
      cam.distance * Math.exp(delta * 0.12 * cam.zoomSpeed),
      cam.minDistance,
      cam.maxDistance
    );
  }

  /** Point the rig should orbit around (character position). */
  setAnchor(x, y, z) {
    this.anchor.set(x, y, z);
  }

  /**
   * Where the camera sits around the target, radians from +Z.
   *
   * This is the frame movement input is resolved in: "forward" is away from the
   * camera, so orbiting the rig re-aims the controls.
   */
  get azimuth() {
    return this.controls.getAzimuthalAngle();
  }

  /**
   * Kick the lens, in metres. Takes the loudest of whatever is asked for in one
   * frame rather than summing — two impacts do not shake twice as hard.
   */
  shake(amount) {
    this._shake = Math.max(this._shake, amount);
  }

  /**
   * Put the lens on a shoulder, or take it off one.
   *
   * Nothing here happens on this call: the two flags are targets, and every
   * frame damps toward them. So the mode can be set from anywhere, as often as
   * it likes, without a transition ever being restarted half way through.
   *
   * @param {boolean} active the gun is out
   * @param {boolean} [ads] and it is being sighted down
   */
  setAim(active, ads = false) {
    this.aim.active = active;
    this.aim.ads = ads;
  }

  /** How far the lens is onto the shoulder, 0..1 — read by whatever draws the aim. */
  get aimBlend() {
    return this._aimBlend;
  }

  /**
   * Turn the view, in radians. Positive `yaw` looks right, positive `pitch` up.
   *
   * The rig's own way of being pointed, for when the pointer is captured and
   * OrbitControls has nothing to read (a locked pointer reports no movement in
   * page coordinates at all) — which is why the drag is stood down for as long
   * as the lock lasts, see `setPointerLocked`. It is buffered rather than
   * applied — see `_lookYaw`.
   */
  look(yaw, pitch) {
    this._lookYaw += yaw;
    this._lookPitch += pitch;
  }

  /**
   * Kick the view, and remember to give it back.
   *
   * Recoil is not a shake: a shake is the lens being knocked and settling back
   * exactly where it was, and recoil is the *aim* moving — the reticle is
   * genuinely somewhere else afterwards. It is applied through the same buffer
   * the mouse uses, which is what makes pulling back down a thing the player
   * does with the mouse rather than something the rig does for them.
   *
   * `_recoil` is the part the rig *will* give back on its own, over
   * `settings.gunplay.fire.recoilRecover`. What the player has already pulled
   * down is not in it, so a shot fired mid-correction does not undo the
   * correction.
   */
  punch(pitch, yaw) {
    this._lookPitch += pitch;
    this._lookYaw += yaw;
    this._recoil += pitch;
  }

  /**
   * The shake itself: two frequencies per axis so it never reads as a wobble,
   * decaying to nothing in about a third of a second.
   */
  _applyShake(dt) {
    // Real time, so a hit-stop does not also freeze the shake it triggered —
    // the lens keeps moving while the world holds still, which is exactly the
    // effect the pair is going for.
    this._shake = Math.max(0, this._shake - this._shake * Math.min(1, dt * 9) - dt * 0.02);
    if (this._shake <= 1e-4) return this._shakeOffset.set(0, 0, 0);

    const t = (performance.now() * 0.001 + this._shakeSeed) * 42;
    this._shakeOffset.set(
      (Math.sin(t) + Math.sin(t * 1.7)) * 0.5,
      (Math.sin(t * 1.3 + 2.1) + Math.sin(t * 2.3)) * 0.5,
      (Math.sin(t * 0.9 + 4.2) + Math.sin(t * 1.9)) * 0.5
    );
    return this._shakeOffset.multiplyScalar(this._shake);
  }

  update(dt) {
    const cam = settings.camera;
    const gun = settings.gunplay.camera;

    // Undo last frame's shake and shoulder offset before the controls see the
    // position: both are things done *to* the lens after it was aimed, and
    // OrbitControls would read either of them as the user's own hand.
    this.camera.position.sub(this._shakeOffset).sub(this._aimOffset);

    // How far onto the shoulder, how far down the sights, and which shoulder.
    // All three on the same curve, so the whole move arrives together.
    const rate = Math.max(1e-6, gun.blend);
    this._aimBlend = damp(this._aimBlend, this.aim.active ? 1 : 0, rate, dt);
    this._adsBlend = damp(this._adsBlend, this.aim.active && this.aim.ads ? 1 : 0, rate, dt);
    this._side = damp(this._side, settings.gunplay.shoulder, rate, dt);

    this._applyLook(dt, cam);

    // The lens itself: wider on the walk, narrower on the shoulder, narrower
    // again down the sights. Damped rather than set, because the blends above
    // already are and a field of view that lagged them would swim.
    const fov = lerp(cam.fov, lerp(gun.fov, gun.adsFov, this._adsBlend), this._aimBlend);
    if (Math.abs(this.camera.fov - fov) > 1e-4) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.controls.minPolarAngle = cam.minPolar;
    this.controls.maxPolarAngle = cam.maxPolar;

    _desiredTarget.copy(this.anchor);
    _desiredTarget.y += lerp(
      cam.targetHeight,
      lerp(gun.targetHeight, gun.adsTargetHeight, this._adsBlend),
      this._aimBlend
    );

    const target = this.controls.target;
    _follow.set(
      damp(target.x, _desiredTarget.x, cam.damping, dt) - target.x,
      damp(target.y, _desiredTarget.y, cam.damping, dt) - target.y,
      damp(target.z, _desiredTarget.z, cam.damping, dt) - target.z
    );
    target.add(_follow);

    /**
     * Carry the lens with the target, rather than letting the target slide out
     * from under it.
     *
     * OrbitControls re-derives its orbit from `camera.position` every frame: it
     * measures the offset against wherever the target is *now*, so moving the
     * target alone leaves the camera standing still in world space and quietly
     * rewrites the angles it is standing at. Run away from a top-down view and
     * the direction from target to camera swings toward the horizontal and
     * toward the back of the body — which the distance enforcement below then
     * pulls the lens along, ending in a chase shot nobody asked for.
     *
     * Translating the camera by the same delta keeps the offset vector
     * identical, so the azimuth, the pitch and the distance all survive the
     * follow and the only thing that ever changes them is the player's hand.
     */
    this.camera.position.add(_follow);

    this.controls.update();

    // Enforce the orbit distance (the wheel and any code writing the setting
    // both land here). While the gun is up the setting is overridden rather
    // than written to: the wheel's own value has to survive the aim, so that
    // holstering puts the lens back exactly where the player left it.
    const wanted = lerp(
      cam.distance,
      lerp(gun.distance, gun.adsDistance, this._adsBlend),
      this._aimBlend
    );
    this.distance = damp(this.distance, wanted, cam.zoomDamping, dt);
    _dir.copy(this.camera.position).sub(this.controls.target);
    const len = _dir.length() || 1;
    _dir.multiplyScalar(1 / len);
    this.camera.position.copy(this.controls.target).addScaledVector(_dir, this.distance);

    this.camera.position.add(this._applyShake(dt)).add(this._applyAim(gun));
  }

  /**
   * Spend the buffered mouse-look and give back what is left of the recoil.
   *
   * Applied by rotating the camera *position* around the target rather than by
   * asking OrbitControls to do it: the controls re-derive their spherical from
   * that position at the top of every update, so moving it is the supported
   * way in — and it means the mouse and a drag cannot end up fighting over two
   * separate ideas of where the orbit is.
   */
  _applyLook(dt, cam) {
    // The kick coming back down. Real time, and before the buffer is spent, so
    // the round fired this frame is not immediately half-undone.
    if (this._recoil !== 0) {
      const settled = damp(this._recoil, 0, Math.max(1e-9, settings.gunplay.fire.recoilRecover), dt);
      this._lookPitch -= this._recoil - settled;
      this._recoil = settled;
    }

    if (this._lookYaw === 0 && this._lookPitch === 0) return;

    _dir.copy(this.camera.position).sub(this.controls.target);
    _spherical.setFromVector3(_dir);
    // Subtracted, not added.
    //
    // `theta` is the azimuth of the vector *target → camera*, so the direction
    // the lens is looking is `theta + π`. Headings here are `atan2(x, z)`, and
    // in that convention turning to the right *decreases* the heading — which
    // is also why `D` strafes along `(cos, -sin)` in the controller. So a mouse
    // moving right has to take theta down, not up. It is the same sign
    // OrbitControls' own drag uses (`_rotateLeft` subtracts), for the same
    // reason, and getting it backwards inverts the horizontal axis of the whole
    // shooter while leaving the vertical alone — which is exactly how it read.
    _spherical.theta -= this._lookYaw;
    // Looking up is the lens dropping *below* what it orbits, so pitch adds to
    // the polar angle — and the same two limits the drag obeys apply here.
    _spherical.phi = MathUtils.clamp(
      _spherical.phi + this._lookPitch,
      cam.minPolar,
      cam.maxPolar
    );
    _spherical.makeSafe();
    _dir.setFromSpherical(_spherical);
    this.camera.position.copy(this.controls.target).add(_dir);

    this._lookYaw = 0;
    this._lookPitch = 0;
  }

  /**
   * Where the shoulder offset puts the lens this frame.
   *
   * In the camera's *own* frame, and applied as a pure translation — see
   * `_aimOffset`. The rise is small and does most of its work by getting the
   * shoulder out of the bottom of the reticle rather than by being seen.
   */
  _applyAim(gun) {
    if (this._aimBlend <= 1e-4) return this._aimOffset.set(0, 0, 0);

    const offset = lerp(gun.offset, gun.adsOffset, this._adsBlend) * this._side * this._aimBlend;
    const rise = gun.rise * this._aimBlend;

    _right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    _up.set(0, 1, 0).applyQuaternion(this.camera.quaternion);

    return this._aimOffset.copy(_right).multiplyScalar(offset).addScaledVector(_up, rise);
  }

  resize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.domElement.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('pointerdown', this._onPointerDownCapture, true);
    this.controls.dispose();
  }
}
