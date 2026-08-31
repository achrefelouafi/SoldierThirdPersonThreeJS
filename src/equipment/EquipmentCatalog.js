/**
 * What can be equipped, and where.
 *
 * This file is the whole content layer: adding a sword is one entry here and no
 * code anywhere else. Everything downstream — the loader, the attachment mounts,
 * the character screen's item list — is driven off these objects and knows
 * nothing about any particular item.
 *
 * Categories exist so the two kinds of thing stay separable. `weapons` is the
 * category that will grow rules (draw/sheathe, damage, a hand it has to be in);
 * `attachments` is cosmetic and never will. Keeping them apart now is what makes
 * that later work a change to one category rather than a filter over a flat list.
 */

/**
 * @typedef {object} EquipmentItem
 * @property {string} id stable key — used by the saved loadout, so do not rename
 * @property {string} name what the screen calls it
 * @property {string} category a `CATEGORIES` id
 * @property {string} url a .glb, relative to the site root
 * @property {string} [node] name of the sub-tree to lift out of that file, for
 *   an export that carries more than the piece — the rest is disposed on the
 *   way past. Omit and the whole scene is the item.
 * @property {string} [stance] marks the item a *weapon* and names the idle the
 *   body holds while it is drawn (see `animation/Locomotion.js`). Exactly one
 *   weapon is ever out; `equipment/WeaponSwitch.js` owns which.
 * @property {string} [note] one line of flavour for the item card
 * @property {boolean} [equipByDefault] worn on load, with no saved loadout involved
 * @property {boolean} [locked] cannot be taken off — the screen offers no way to
 *   unequip it, and `EquipmentManager.toggle` refuses to
 * @property {EquipmentPlacement} defaults where it goes before anyone tunes it
 */

/**
 * @typedef {object} EquipmentPlacement
 * @property {string} bone joint name, without the `mixamorig:` namespace
 * @property {[number, number, number]} position metres, in the bone's own frame
 * @property {[number, number, number]} rotation degrees, XYZ order
 * @property {number} scale multiplier on the model's authored size
 * @property {[boolean, boolean, boolean]} [mirror] per-axis reflection of the
 *   piece through the body's centre — X gives the matching copy on the other
 *   side, Y flips it about the waist, Z about the coronal plane
 */

export const CATEGORIES = [
  {
    id: 'weapons',
    label: 'Weapons',
    /** Held gear. One of these is drawn at a time — see `stance` below. */
    hint: 'Held gear — one is drawn at a time, and 1 swaps between them.'
  },
  {
    id: 'attachments',
    label: 'Attachments',
    hint: 'Cosmetic. Rides the skeleton and does nothing else.'
  }
];

/** @type {EquipmentItem[]} */
export const ITEMS = [
  {
    id: 'sword',
    name: 'Katana',
    category: 'weapons',
    url: './models/weapons/sword.glb',
    note: 'Blade runs down +Z from the guard.',
    // The idle the body stands in while this is the weapon that is out — the
    // plain one, which is the stand every other clip was authored against.
    stance: 'sword',
    // Worn from the first frame — the character is never seen unarmed, and the
    // screen cannot take it off: combat and its VFX assume the blade is there.
    equipByDefault: true,
    locked: true,
    defaults: {
      // Dialled in on the set and pasted back with the screen's "Copy
      // defaults" — this is the grip everything else was authored against.
      bone: 'RightHand',
      position: [-0.0081, 0.1093, 0.0535],
      rotation: [-152.9985, 62.0427, -16.8781],
      scale: 1
    }
  },
  {
    id: 'rifle',
    name: 'Rifle',
    category: 'weapons',
    url: './models/weapons/Rifle.glb',
    // The export is a Sketchfab scene rather than a bare mesh: the gun is three
    // meshes under a wrapper, and this is the wrapper. Named exactly as the
    // file has it — a `node` that does not match is not an error, it simply
    // falls through to the whole scene with a warning, which for this file is
    // the same content and a line of noise in the console.
    node: 'Sketchfab_model.001',
    note: 'Barrel runs down +Z. The ring on it turns.',
    stance: 'rifle',
    // The one flag that says "this weapon is fired rather than swung". Drawing
    // it is what puts the whole shooter on — the shoulder camera, the reticle,
    // the torso's twist onto it and the trigger. See `combat/Gunplay.js`.
    ranged: true,
    // Both weapons ride the skeleton at all times and the switch decides which
    // one is *visible*, so the gun is mounted from the first frame exactly as
    // the blade is — that is what lets either be tuned on the set at any point.
    equipByDefault: true,
    locked: true,
    defaults: {
      // Dialled in on the set, like the blade's. The two share a hand but not
      // their numbers: the gun sits higher in the palm and is rolled most of a
      // half-turn the other way, because the barrel leaves the fist where the
      // blade's edge does.
      bone: 'RightHand',
      position: [-0.1189, 0.3161, -0.0028],
      rotation: [143.26, -36.7459, -147.994],
      scale: 1
    }
  },
  {
    id: 'scabbard',
    name: 'Scabbard',
    category: 'attachments',
    url: './models/attachements/Scabbard.glb',
    note: 'Sits on the left hip, mouth forward.',
    defaults: {
      bone: 'Hips',
      position: [0.12, 0.02, 0],
      rotation: [0, 0, 20],
      scale: 1
    }
  },
  {
    id: 'potion',
    name: 'Potion',
    category: 'attachments',
    url: './models/attachements/Potion.glb',
    note: 'Belt flask.',
    defaults: {
      bone: 'Spine',
      position: [-0.14, 0, 0.06],
      rotation: [0, 0, 0],
      scale: 1
    }
  }
];

/**
 * The joints worth offering first.
 *
 * The screen lists every bone the rig actually has — this is only the order and
 * the grouping the common ones appear in, so picking "right hand" is one click
 * rather than a scroll through fifty finger joints. A name no rig here carries
 * is skipped silently.
 */
export const ATTACH_POINTS = [
  { group: 'Hands', bones: ['RightHand', 'LeftHand'] },
  { group: 'Arms', bones: ['RightForeArm', 'RightArm', 'LeftForeArm', 'LeftArm'] },
  { group: 'Back & hips', bones: ['Spine2', 'Spine1', 'Spine', 'Hips'] },
  { group: 'Head', bones: ['Head', 'Neck', 'RightShoulder', 'LeftShoulder'] },
  { group: 'Legs', bones: ['RightUpLeg', 'RightLeg', 'RightFoot', 'LeftUpLeg', 'LeftLeg', 'LeftFoot'] }
];

/** Deep copy of an item's shipped placement — never hand the catalog out live. */
export function defaultPlacement(item) {
  const d = item.defaults ?? {};
  return {
    bone: d.bone ?? 'RightHand',
    position: [...(d.position ?? [0, 0, 0])],
    rotation: [...(d.rotation ?? [0, 0, 0])],
    scale: d.scale ?? 1,
    mirror: normaliseMirror(d.mirror)
  };
}

/** Three booleans, whatever a catalog entry or a stored loadout offered. */
export function normaliseMirror(mirror) {
  return [0, 1, 2].map((axis) => mirror?.[axis] === true);
}

/** @returns {EquipmentItem|null} */
export function findItem(id) {
  return ITEMS.find((item) => item.id === id) ?? null;
}

/** What the character starts out wearing, in catalog order. */
export function defaultItems() {
  return ITEMS.filter((item) => item.equipByDefault === true);
}

/** Items in one category, in catalog order. */
export function itemsInCategory(categoryId) {
  return ITEMS.filter((item) => item.category === categoryId);
}

/**
 * The weapons, in catalog order.
 *
 * A weapon is any item that declares a `stance` — which is the same statement
 * as "only one of these is out at a time", because the stance is the idle the
 * body holds and the body has one pose. Nothing else in the project decides
 * what counts as a weapon.
 */
export function weaponItems() {
  return ITEMS.filter((item) => typeof item.stance === 'string');
}

/** Whether this id names a weapon. */
export function isWeapon(id) {
  return typeof findItem(id)?.stance === 'string';
}

/**
 * Whether this id names a weapon that is *fired*.
 *
 * The single question the whole shooter hangs off: `combat/Gunplay.js` asks it
 * of whatever is drawn, every frame, and turns itself on or off by the answer.
 * Adding a second gun to the catalog is therefore a `ranged: true` and nothing
 * else.
 */
export function isRanged(id) {
  return findItem(id)?.ranged === true;
}

/** The one that is drawn before anyone has said otherwise: the first listed. */
export const DEFAULT_WEAPON_ID = weaponItems()[0]?.id ?? null;
