import { settings } from '../config/settings.js';

/**
 * The pointer, for the whole stage.
 *
 * ## What it is
 *
 * One click takes the mouse, and from then on moving it turns the view rather
 * than dragging a cursor across it. `Esc` gives the cursor back. That is the
 * whole of the mode, and it is the mode the *entire* play stage runs in — not
 * only the rifle's. A third-person game whose camera is captured while one
 * weapon is out and dragged while the other is out is two games, and the
 * player has to notice which one they are in before they can turn around.
 *
 * ## Why it lives here rather than in the shooter
 *
 * It started in `combat/Gunplay.js`, because the rifle is what needed it
 * first: a reticle nailed to the middle of the screen and a cursor that has to
 * be dragged to aim are incompatible. But nothing about *taking the pointer*
 * is about the gun. The gun's share is what the buttons then mean — the
 * trigger, the sights, the shoulder — and that stayed there. What is here is
 * the pointer itself: who has it, how a movement becomes a turn, and what
 * hands it back.
 *
 * ## The two states, and the way between them
 *
 * **Captured** is the playing state. OrbitControls is stood down for as long
 * as it lasts (`CameraRig#setPointerLocked`), because a locked pointer reports
 * no page coordinates at all and a drag it half-saw would fight the look for
 * the same orbit. The deltas go to `CameraRig#look` instead, scaled by
 * `settings.camera.sensitivity` and by whatever the caller's `sensitivity`
 * hook says on top of it — which is how sighting down the rifle slows the
 * whole view without this file knowing a rifle exists.
 *
 * **Free** is every menu. The browser's own `Esc` is the way into it, so it
 * costs nothing to learn and works even where a key handler never sees the
 * press (Chrome swallows the `keydown` that exits a lock). While it lasts the
 * orbit drag comes back, so the camera is still usable with a cursor — the
 * editor (`G`), the panels along the bottom and the character screen are all
 * pointed at the ordinary way. Clicking the canvas takes the pointer again.
 *
 * The press that takes it is spent on taking it and on nothing else: it is
 * stopped in the capture phase before the canvas's own listeners can read it
 * as an orbit drag, a mark or a round. This is the click that focuses a window
 * after an alt-tab, and firing on it is how a magazine goes missing.
 *
 * ## What blocks it
 *
 * `blocked` — the character screen, and nothing else at present. That is a
 * place you point at things with a cursor, so the pointer is given back on the
 * way in and never taken while it is up.
 */
export class PointerLook {
  /**
   * @param {object} options
   * @param {HTMLElement} options.domElement the canvas — what the lock is taken on
   * @param {import('./CameraRig.js').CameraRig} options.rig what the deltas turn
   * @param {() => boolean} [options.blocked] whether something else wants the
   *   cursor. Read every frame, so a mode coming up takes the pointer back on
   *   its own rather than having to remember to.
   * @param {() => number} [options.sensitivity] a multiplier on top of
   *   `settings.camera.sensitivity`, for whatever is holding the view still —
   *   the sights, a scope, a slow-walk
   * @param {HTMLElement} [options.parent] where the hint line is hung
   */
  constructor({
    domElement,
    rig,
    blocked = () => false,
    sensitivity = () => 1,
    parent = document.body
  }) {
    this.domElement = domElement;
    this.rig = rig;
    this.blocked = blocked;
    this.sensitivity = sensitivity;

    /** Whether the pointer is ours. */
    this.locked = false;

    /**
     * The one line that says the mode exists.
     *
     * A captured pointer is invisible until it is taken, and a player who has
     * pressed `Esc` for the editor has no way of knowing how to get back into
     * the game. So the hint is on screen for exactly as long as the pointer is
     * *not* ours, which makes it an answer to the question the player is
     * actually asking at that moment.
     */
    this.hint = document.createElement('p');
    this.hint.className = 'look-hint';
    this.hint.setAttribute('aria-hidden', 'true');
    this.hint.textContent = 'Click to look · Esc frees the cursor';
    parent.appendChild(this.hint);
    /** Diffed, so a frame in which nothing changed writes nothing to the DOM. */
    this._hinted = null;

    this._bind();
  }

  /** Whether the pointer may be taken at all — nothing else wants the cursor. */
  get active() {
    return !this.blocked();
  }

  /** Take it. Safe to call when it is already ours, or when it may not be had. */
  capture() {
    if (this.locked || !this.active) return;
    const claim = this.domElement.requestPointerLock?.();
    // Chrome hands back a promise and rejects it if the lock is asked for too
    // soon after one was released with `Esc`. Nothing here has to react — the
    // hint is already on screen saying the pointer is not ours.
    claim?.catch?.(() => {});
  }

  /** Give it back — for anything that needs a cursor again. */
  release() {
    if (document.pointerLockElement === this.domElement) document.exitPointerLock();
  }

  /**
   * Once a frame, before anything reads the view.
   *
   * Two jobs, both of them consequences of `blocked` being a question rather
   * than a call: a mode that has just come up gets the cursor handed back
   * without having asked for it, and the hint follows the state instead of
   * being toggled from the several places that can change it.
   */
  update() {
    if (this.locked && !this.active) this.release();

    const wanted = this.active && !this.locked;
    if (wanted === this._hinted) return;
    this._hinted = wanted;
    this.hint.classList.toggle('is-live', wanted);
  }

  /* ------------------------------------------------------------------ */

  _bind() {
    const element = this.domElement;

    this._onPointerDown = (event) => {
      if (this.locked || !this.active) return;
      // A press on a panel belongs to the panel. Without this, reaching for a
      // slider in the editor would take the pointer away from the hand that
      // was about to drag it.
      if (event.target !== element) return;
      // In the capture phase, on the window, so this runs before the canvas's
      // own listeners and can keep the press away from them — the press that
      // takes the pointer is not also an orbit drag, a mark or a round.
      //
      // It has to be stopped even though the lock is not granted yet:
      // OrbitControls asks for a pointer *capture* on every button down, and a
      // captured pointer and a locked one are mutually exclusive, so the
      // request throws if the browser grants the lock in between.
      event.stopPropagation();
      this.capture();
    };

    this._onPointerMove = (event) => {
      if (!this.locked) return;
      const factor = settings.camera.sensitivity * this.sensitivity();
      // Yaw right for a mouse moving right; pitch up for one moving away. The
      // rig buffers both and spends them on its own frame — see `CameraRig#look`.
      this.rig.look(event.movementX * factor, -event.movementY * factor);
    };

    this._onLockChange = () => {
      this.locked = document.pointerLockElement === element;
      // The orbit drag and the look are two hands on the same camera. Only one
      // of them is ever live.
      this.rig.setPointerLocked(this.locked);
    };

    window.addEventListener('pointerdown', this._onPointerDown, true);
    // On the window rather than the canvas: while the pointer is locked every
    // move is targeted at the canvas anyway, and this way nothing is missed if
    // it is not.
    window.addEventListener('pointermove', this._onPointerMove);
    document.addEventListener('pointerlockchange', this._onLockChange);
  }

  dispose() {
    this.release();
    window.removeEventListener('pointerdown', this._onPointerDown, true);
    window.removeEventListener('pointermove', this._onPointerMove);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    this.hint.remove();
  }
}
