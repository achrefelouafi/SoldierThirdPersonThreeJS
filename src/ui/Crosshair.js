/**
 * The reticle.
 *
 * Four ticks around a hole, and every part of it is telling the player
 * something they would otherwise have to learn by missing:
 *
 *  - **The gap** is the spread. It opens as the body moves, opens again with
 *    every round fired, and closes down the sights. A player who has never read
 *    a word about recoil will still stop firing on the run, because the reticle
 *    said so.
 *  - **The colour** is whether the ray is on a body. It is the only confirmation
 *    that the shot would connect, and it is what makes shooting at range feel
 *    aimed rather than hopeful.
 *  - **The mark** is the hit. Four short strokes on contact, and a longer,
 *    hotter set on a kill — the difference between "that landed" and "that was
 *    the last one it needed", which is the single most useful thing a shooter
 *    can tell you in the middle of a fight.
 *  - **The bar** is the held shot. It sits under everything else, it fills
 *    while the sights are up and the feet are planted, and when it is full the
 *    release of the right button sends the round that opens a hole in the world
 *    (`combat/Gunplay.js`, `vfx/FocusedBurst.js`). Under the reticle rather
 *    than through it because it is a *promise*, not an aim: the four ticks say
 *    where the round goes and this says what kind of round it will be.
 *
 * It draws itself off three custom properties and four classes, so a frame in
 * which nothing has changed writes nothing to the DOM at all.
 */
export class Crosshair {
  /** @param {HTMLElement} [parent] */
  constructor(parent = document.body) {
    this.element = document.createElement('div');
    this.element.className = 'reticle';
    this.element.setAttribute('aria-hidden', 'true');

    this.element.innerHTML = `
      <div class="reticle__arms">
        <i class="reticle__tick reticle__tick--up"></i>
        <i class="reticle__tick reticle__tick--down"></i>
        <i class="reticle__tick reticle__tick--left"></i>
        <i class="reticle__tick reticle__tick--right"></i>
      </div>
      <b class="reticle__dot"></b>
      <div class="reticle__mark">
        <i></i><i></i><i></i><i></i>
      </div>
      <div class="reticle__charge"><i></i></div>
    `;

    this.mark = this.element.querySelector('.reticle__mark');
    this.charge = this.element.querySelector('.reticle__charge');

    /** Seconds left of the hit mark, and whether it was a kill. */
    this._mark = 0;
    this._markLife = 0.42;
    /** Diffed state, so an unchanged frame touches nothing. */
    this._shown = null;
    this._hot = null;
    this._blocked = null;
    this._gap = -1;
    this._charge = -1;
    this._charging = null;
    this._ready = null;

    parent.appendChild(this.element);
  }

  /** Whether the reticle is on screen at all — the gun being out, and nothing else. */
  show(on) {
    if (this._shown === on) return;
    this._shown = on;
    this.element.classList.toggle('is-live', on);
    if (!on) {
      this._mark = 0;
      this.mark.classList.remove('is-hit', 'is-kill');
    }
  }

  /**
   * How far along the held shot is.
   *
   * @param {number} value 0..1 — how much of the charge time has been served
   * @param {boolean} shown whether there is a charge to report at all. False is
   *   not the same as 0: an empty bar on screen is a control the player is
   *   being told they are failing at, and the bar is only ever there while they
   *   are actually holding the button. It leaves the instant the round does.
   */
  setCharge(value, shown) {
    if (this._charging !== shown) {
      this._charging = shown;
      this.charge.classList.toggle('is-live', shown);
    }
    if (!shown) return;

    // Quantised to a percent before it is diffed: the charge is a float that
    // changes every frame and the bar is a hundred and forty pixels wide, so
    // three quarters of those writes would be to the same rendered width.
    const filled = Math.round(Math.min(1, Math.max(0, value)) * 100);
    if (filled !== this._charge) {
      this._charge = filled;
      this.charge.style.setProperty('--charge', `${filled}%`);
    }

    const ready = filled >= 100;
    if (ready !== this._ready) {
      this._ready = ready;
      this.charge.classList.toggle('is-ready', ready);
    }
  }

  /**
   * How far the four ticks stand off the centre, in pixels.
   *
   * Handed the *angle* rather than a pixel count would be the purer interface,
   * but the reticle would then need the camera's field of view and the
   * viewport's height to say anything at all — and `combat/Gunplay.js` already
   * holds both. So the conversion happens where the numbers are.
   */
  setSpread(pixels) {
    const gap = Math.round(Math.max(2, pixels));
    if (gap === this._gap) return;
    this._gap = gap;
    this.element.style.setProperty('--gap', `${gap}px`);
  }

  /**
   * Whether the trigger is being held off — the body on the move.
   *
   * Dimmed rather than blanked, because the reticle is on its way off the
   * screen when this comes on — the same step that holds the trigger off takes
   * the mark with it (see `Gunplay#steady`), and a mark that faded out at full
   * strength would read as a shot the player still had.
   */
  setBlocked(on) {
    if (this._blocked === on) return;
    this._blocked = on;
    this.element.classList.toggle('is-blocked', on);
  }

  /** Whether the ray is on a body. */
  setHot(on) {
    if (this._hot === on) return;
    this._hot = on;
    this.element.classList.toggle('is-hot', on);
  }

  /**
   * A round landed.
   * @param {boolean} [kill] whether it was the one that put the body down
   */
  hit(kill = false) {
    this._mark = this._markLife;
    this.mark.classList.toggle('is-kill', kill);
    // Restarted rather than left running, so two hits in quick succession read
    // as two marks instead of one that never went out.
    this.mark.classList.remove('is-hit');
    void this.mark.offsetWidth; // force the animation to begin again
    this.mark.classList.add('is-hit');
  }

  /** @param {number} dt real seconds — a hit mark does not slow with the world */
  update(dt) {
    if (this._mark <= 0) return;
    this._mark -= dt;
    if (this._mark > 0) return;
    this.mark.classList.remove('is-hit', 'is-kill');
  }

  dispose() {
    this.element.remove();
  }
}
