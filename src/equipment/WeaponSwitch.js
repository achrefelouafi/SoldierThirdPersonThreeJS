import { MathUtils } from 'three';
import { settings } from '../config/settings.js';
import { DEFAULT_WEAPON_ID, findItem, weaponItems } from './EquipmentCatalog.js';
import { WeaponDissolve } from './WeaponDissolve.js';

const STORAGE_KEY = 'character-equipment.weapon.v1';

/**
 * Which weapon is drawn, and the exchange between them.
 *
 * ## Both are always on the body
 *
 * There is no equip and no unequip here. Every weapon in the catalog is mounted
 * on its joint from the first frame and stays there; this class only decides
 * which one is *visible*. Three things fall out of that, and they are the whole
 * reason it is built this way:
 *
 *  - Each weapon keeps its own placement, live, in the same loadout as
 *    everything else — so the katana's seat in the fist and the rifle's are two
 *    independent sets of numbers that both survive a reload.
 *  - The character screen can tune either of them without anything being
 *    loaded, unloaded or re-parented: switch, and the piece under the gizmo is
 *    the one now in the hand.
 *  - Anything that reads the loadout goes on finding what it is looking for
 *    whatever is drawn.
 *
 * ## The exchange
 *
 * One timeline, `_phase`, running 0 → 1 over `settings.weapons.switchTime`. The
 * outgoing weapon's mask runs forward across the first part of it and the
 * incoming weapon's runs *backward* across the last part, and the two parts
 * overlap — so for a moment both are half-there and the hand is never empty.
 * See `WeaponDissolve` for the mask itself; there is only the one, read in two
 * directions, which is what makes this read as an exchange rather than as a
 * disappearance followed by an appearance.
 *
 * The grip changes on its own beat inside that (`handover`): the idle is a
 * full-body pose, and it belongs to the weapon that is arriving, not to either
 * end of the swap.
 */
export class WeaponSwitch {
  /**
   * @param {import('../animation/CharacterController.js').CharacterController} character
   * @param {import('./EquipmentManager.js').EquipmentManager} equipment
   * @param {{onChange?: (id: string) => void}} [hooks] fired when the drawn
   *   weapon changes — at the press, not at the end of the burn
   */
  constructor(character, equipment, hooks = {}) {
    this.character = character;
    this.equipment = equipment;
    this.hooks = hooks;

    /** @type {import('./EquipmentCatalog.js').EquipmentItem[]} */
    this.items = weaponItems();

    this._current = DEFAULT_WEAPON_ID;
    /** The weapon burning out, and the one burning in. Null between swaps. */
    this._from = null;
    this._to = null;
    /** 0..1 across the whole exchange. Parked at 1 when nothing is happening. */
    this._phase = 1;
    /** Whether the grip has already changed hands this swap. */
    this._handed = true;

    /** slot model → its mask. One per mounted weapon, built when it arrives. */
    this._dissolves = new Map();
  }

  /* ------------------------------------------------------------------ */

  /** The weapon that is out. */
  get current() {
    return this._current;
  }

  /** Whether an exchange is running. */
  get switching() {
    return this._phase < 1;
  }

  /** What this id's card should say it is: drawn, stowed, or not a weapon. */
  isDrawn(id) {
    return this._current === id;
  }

  /** Whether the catalog calls this a weapon at all. */
  has(id) {
    return this.items.some((item) => item.id === id);
  }

  /** The one after the current, wrapping — what a plain toggle would pick. */
  get next() {
    const index = this.items.findIndex((item) => item.id === this._current);
    return this.items[(index + 1) % Math.max(1, this.items.length)]?.id ?? this._current;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Draw a weapon.
   *
   * @param {string} id catalog item id — must be a weapon
   * @param {{immediate?: boolean}} [options] `immediate` skips the burn, for
   *   the boot path and for restoring a stored choice: there is nothing to
   *   exchange when the body has not been on screen yet.
   * @returns {boolean} whether the drawn weapon changed
   */
  select(id, { immediate = false } = {}) {
    if (!this.has(id) || id === this._current) return false;

    this._from = immediate ? null : this._current;
    this._to = id;
    this._current = id;
    this._phase = immediate ? 1 : 0;
    this._handed = false;

    // The grip changes mid-burn when there is a burn; with none, now is mid —
    // and with no burn to cover it there is nothing to cross-fade the pose
    // under either, so the stand is snapped rather than eased into.
    if (immediate) this._hand(true);

    this.hooks.onChange?.(id);
    this._store();
    return true;
  }

  /** Swap to the next weapon in the catalog. */
  toggle() {
    return this.select(this.next);
  }

  /**
   * Draw whatever was last chosen, with no exchange.
   *
   * Called once the loadout is on the body. A stored id that is no longer a
   * weapon (a catalog edit, an old key) falls through to the default, and the
   * default is applied either way — the stance has to be set even when nothing
   * was stored, or the body stands in the sword idle holding a rifle.
   *
   * The masks are built here rather than being left to the first frame, so the
   * materials they put on the weapons exist in time for the boot path's shader
   * warm-up. Left to the frame loop they would be two programs compiled on the
   * frame the game starts, which is the one frame that cannot afford it.
   */
  restore() {
    let stored = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      console.warn('[WeaponSwitch] stored weapon is unreadable', error);
    }

    if (stored && this.has(stored)) this.select(stored, { immediate: true });
    else this._hand(true);

    this._syncDissolves();
    return this._current;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Advance the exchange and write the masks.
   *
   * Runs every frame in both modes — the play stage and the character screen —
   * because the mask is pinned to a weapon that is swinging through the room
   * while it burns, and a frame's stale matrix is a frame of the pattern
   * sliding across the piece. A weapon that is not burning skips all of it: its
   * threshold is 0, so there is no mask to pin and nothing to re-read.
   *
   * @param {number} dt seconds
   */
  update(dt) {
    this._syncDissolves();
    if (!this._dissolves.size) return;

    const look = settings.weapons;

    if (this._phase < 1) {
      this._phase = Math.min(1, this._phase + dt / Math.max(0.05, look.switchTime));
      if (!this._handed && this._phase >= MathUtils.clamp(look.handover, 0, 1)) this._hand();
      if (this._phase >= 1) {
        this._from = null;
        this._to = null;
      }
    }

    // Each half of the timeline is `span` long, and they overlap by `overlap`
    // of a half — so `2 * span - overlap * span = 1`, the whole exchange.
    const overlap = MathUtils.clamp(look.overlap, 0, 0.9);
    const span = 1 / (2 - overlap);
    const out = MathUtils.clamp(this._phase / span, 0, 1);
    const arrive = 1 - MathUtils.clamp((this._phase - (1 - span)) / span, 0, 1);

    for (const [id, dissolve] of this._dissolves) {
      const slot = this.equipment.get(id);
      if (!slot) continue;

      const progress =
        id === this._from ? out : id === this._to ? arrive : id === this._current ? 0 : 1;

      dissolve.progress = progress;
      // Gone is gone: a fully burnt weapon is taken out of the draw entirely
      // rather than left to run a mask that discards every one of its fragments.
      slot.model.visible = progress < 1;
      if (progress <= 0 || !slot.model.visible) continue;

      dissolve.sync(look);
      dissolve.update();
    }
  }

  /* ------------------------------------------------------------------ */

  /**
   * Put the body in the drawn weapon's idle.
   * @param {boolean} [immediate] skip the cross-fade — see `select`
   */
  _hand(immediate = false) {
    this._handed = true;
    this.character.setStance?.(findItem(this._current)?.stance ?? null, { immediate });
  }

  /**
   * Keep one mask per mounted weapon.
   *
   * Weapons arrive asynchronously (the models are downloaded), and the screen's
   * "clear" can in principle take one off, so this is checked rather than done
   * once at construction. A mask is built against a *slot's model*, so a piece
   * that is re-equipped gets a new one rather than a stale one aimed at an
   * object that is no longer in the scene.
   */
  _syncDissolves() {
    for (const item of this.items) {
      const slot = this.equipment.get(item.id);
      const existing = this._dissolves.get(item.id);

      if (!slot) {
        if (existing) {
          existing.dispose();
          this._dissolves.delete(item.id);
        }
        continue;
      }

      if (existing?.root === slot.model) continue;
      existing?.dispose();

      const dissolve = new WeaponDissolve(slot.model);
      this._dissolves.set(item.id, dissolve);
      // A weapon that arrives while it is not the one drawn arrives *gone*,
      // not solid and then blinking out on the next frame.
      dissolve.progress = item.id === this._current ? 0 : 1;
      slot.model.visible = item.id === this._current;
    }
  }

  _store() {
    try {
      localStorage.setItem(STORAGE_KEY, this._current);
    } catch (error) {
      console.warn('[WeaponSwitch] could not store the drawn weapon', error);
    }
  }

  dispose() {
    for (const dissolve of this._dissolves.values()) dissolve.dispose();
    this._dissolves.clear();
  }
}
