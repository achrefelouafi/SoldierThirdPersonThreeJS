/**
 * What the player can *do*, in one list.
 *
 * Three things read this and nothing else describes a move: `core/Input.js`
 * builds its key map from the entries marked `attack` (so a rebind here rebinds
 * the game), `ui/ActionHUD.js` draws the panels along the bottom of the screen
 * from all of them, and `core/App.js` resolves a state per `id` each frame.
 *
 * `id` is the contract between the three. For an attack it is also the
 * `configKey` its `Attack` instance reads out of `config/settings.js` — one
 * word that names the clip, its tuning block, its glyph in `ui/icons.js` and
 * its chip in the HUD.
 *
 * `category` is the second contract, and it is a statement about *kind*, not
 * about layout: a technique is something the body does with the sword and the
 * feet, an ability is something rarer that the body alone could not, and a buff
 * is not thrown at anybody at all — it is called down on yourself and carried.
 * The HUD gives each kind its own panel and its own heading so the difference
 * is visible before any of it is read — see `ui/ActionHUD.js`.
 */

/**
 * @typedef {object} Category
 * @property {string} id matches an ability's `category`
 * @property {string} label the panel's heading
 * @property {string} kanji the mark beside it
 * @property {'top'|'main'} row which band of the HUD the panel sits in
 */

/**
 * The kinds of thing a move can be, in the order their panels are laid out.
 *
 * @type {Record<string, Category>}
 */
export const CATEGORIES = {
  /**
   * Getting somewhere, and getting dressed. Quiet, above the rest — neither is
   * a way to hurt anyone, and neither should compete with the panels that are.
   */
  movement: { id: 'movement', label: 'Movement', kanji: '歩', row: 'top' },
  /** Sword and body. The three the fight is actually fought with. */
  technique: { id: 'technique', label: 'Techniques', kanji: '技', row: 'main' },
  /**
   * The rarer things — asking for something rather than doing it.
   *
   * Both of them (`swordCombo`, `voidBeam`) are thrown at whoever is in front
   * of you exactly as a technique is, because what makes a move an ability here
   * is *what it calls on*, not how it is aimed.
   */
  ability: { id: 'ability', label: 'Abilities', kanji: '術', row: 'main' },
  /**
   * The boons: called down on yourself and then carried for a while.
   *
   * The other panels are all a thing you do *to* somebody, and these two are
   * the only moves with nowhere to point them — what they change is the body
   * throwing them, and they keep changing it for ten seconds after the key is
   * let go. That is a different kind of move from "a thing that happens now",
   * so it is a panel of its own: while one is up its chip is a countdown, and a
   * player scanning for "how long have I got" should be reading one place.
   */
  buff: { id: 'buff', label: 'Boons', kanji: '加', row: 'main' }
};

/**
 * @typedef {object} Ability
 * @property {string} id matches the settings block, the `Attack` config key and the icon
 * @property {keyof typeof CATEGORIES} category which panel it is drawn in
 * @property {string} label what the chip says
 * @property {string} hotkey what the chip's key cap says
 * @property {string} code the physical `KeyboardEvent.code` behind it
 * @property {string} note one line, for the chip's tooltip
 * @property {boolean} [attack] buffered as an edge and routed to an `Attack`
 * @property {boolean} [press] the chip is a control as well as a readout — it
 *   can be clicked, and the click means the same as the key. Only for the ones
 *   that are a plain switch: anything aimed has to be aimed, and a button
 *   cannot say where.
 */

/** @type {Ability[]} */
export const ABILITIES = [
  {
    id: 'leap',
    category: 'movement',
    label: 'Leap',
    hotkey: 'Space',
    code: 'Space',
    note: 'A running long jump. At any lesser pace it is a hop instead.'
  },
  {
    id: 'weapon',
    category: 'movement',
    // Rewritten each frame with the name of what is actually in the hand, so
    // the chip is the answer to "what am I holding" as well as the way to
    // change it — see `ActionHUD#setLabel`.
    label: 'Katana',
    hotkey: '1',
    code: 'Digit1',
    note: 'Swap the weapon. The one in your hand burns away and the other burns in.',
    press: true
  },
  {
    id: 'shoulder',
    category: 'movement',
    // Rewritten each frame with the side the lens is actually on, so the chip
    // answers "which shoulder am I over" as well as changing it.
    label: 'Right shoulder',
    hotkey: 'H',
    code: 'KeyH',
    note:
      'Cross the camera to the other shoulder. Only means anything with the rifle out — ' +
      'the middle mouse button does the same thing.',
    press: true
  },
  {
    id: 'customize',
    category: 'movement',
    label: 'Character',
    hotkey: 'Tab',
    code: 'Tab',
    note: 'The equipment studio: a stage of its own, for looking at the body and dressing it.'
  },
  {
    id: 'kick',
    category: 'technique',
    label: 'Kick',
    hotkey: 'E',
    code: 'KeyE',
    note: 'Steps onto the nearest body in front of you and plants a foot in it.',
    attack: true
  },
  {
    id: 'slashHit',
    category: 'technique',
    label: 'Slash Hit',
    hotkey: 'R',
    code: 'KeyR',
    note: 'Steps in and opens it across the waist. Longer reach, and it cuts.',
    attack: true
  },
  {
    id: 'crouchSlash',
    category: 'technique',
    label: 'Slide Cut',
    hotkey: 'T',
    code: 'KeyT',
    note: 'Runs it down, drops into a slide and opens it on the way past.',
    attack: true
  },
  {
    id: 'flipKick',
    category: 'technique',
    label: 'Flip Kick',
    hotkey: 'Q',
    code: 'KeyQ',
    note: 'Runs it down, plants a heel in its chest and backflips off it — the way out.',
    attack: true
  },
  {
    id: 'swordCombo',
    category: 'ability',
    label: 'Sword Combo',
    // Not `F`: that toggles the frame stats (`App`'s own key handler), and a
    // move that flipped a debug panel every time it was thrown would be the
    // kind of bug nobody reports because they assume they did it.
    hotkey: 'Z',
    code: 'KeyZ',
    note:
      'Throws two cuts across the ground at it, then closes out of the dark and ' +
      'takes it apart. The longest reach of them, and the longest you are committed for.',
    attack: true
  },
  {
    id: 'voidBeam',
    category: 'ability',
    label: 'Unmaking',
    hotkey: 'B',
    code: 'KeyB',
    note:
      'Cast twice at the nearest body, from where you stand. The first writes a rune into ' +
      'the ground under it, the second brings a column of void up through it — and there ' +
      'is nothing left to fall.',
    attack: true
  },
  {
    id: 'crimsonRite',
    category: 'ability',
    label: 'Crimson Rite',
    // The next free cap on the bottom row, beside the one the unmaking uses.
    // Both are casts thrown from where you stand, and a hand that has found one
    // of them has found the other.
    hotkey: 'V',
    code: 'KeyV',
    note:
      'Mark the nearest body and call three katanas up out of the dark around it. ' +
      'They go in one after another and come out together — and what they come out of ' +
      'does not fall.',
    attack: true
  },
  {
    id: 'ascendance',
    category: 'buff',
    // Rewritten each frame while the boon is up with the seconds left on it,
    // so the chip is the timer as well as the key — see `App#_syncAbilities`.
    label: 'Ascendance',
    // The next cap along from the ones the abilities already hold — B is taken,
    // and this one is on the same row, where the hand finds it without being
    // told where it is. N and M sit together because the boons do.
    hotkey: 'N',
    code: 'KeyN',
    note:
      'Call the light down on yourself. For ten seconds you move quicker and ' +
      'everything you land hits harder. Not aimed at anybody — it is a boon.',
    // Nothing to aim, so a click can mean it: there is nowhere to point it, and
    // therefore nothing a chip would have to be able to say. Both boons are
    // pressable for the same reason.
    press: true
  },
  {
    id: 'shadowBoost',
    category: 'buff',
    // Rewritten each frame while the boon is up with the seconds left on it,
    // exactly as `ascendance` is — see `App#_syncAbilities`.
    label: 'Shadow Boost',
    // The next cap along again. B and N are taken, and M finishes the row the
    // hand is already on.
    hotkey: 'M',
    code: 'KeyM',
    note:
      'Call the dark up out of the ground under you. For ten seconds everything ' +
      'you land is ruinous — the other boon, and aimed at nobody either.',
    // The second boon, so the second chip a click can mean. Same reason as
    // above: there is nowhere to point it.
    press: true
  }
];

/** The attacks, in the order a press is offered to them. */
export const ATTACK_ABILITIES = ABILITIES.filter((ability) => ability.attack);
