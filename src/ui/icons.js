/**
 * The glyph for each move, drawn rather than written.
 *
 * One 24×24 line drawing per ability id, in the same brush language: a single
 * stroke weight, round caps, and the faint marks — impact, trail, speed —
 * carried at lower opacity so the shape of the move reads first and the motion
 * second. Everything is `currentColor`, so a chip's state colours its icon by
 * setting `color` and nothing else.
 *
 * These are markup, not files: an inline `<svg>` costs no request, inherits the
 * chip's colour and transitions, and cannot arrive late and pop in over a HUD
 * that is already on screen.
 */

/** @param {string} body inner markup, in a 24×24 box */
const stroke = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/**
 * Icon markup by ability id.
 *
 * Keyed by the same `id` that names the settings block and the clip, so adding
 * a move means adding one entry here and one in `config/abilities.js`.
 *
 * @type {Record<string, string>}
 */
export const ABILITY_ICONS = {
  // An arc of travel with the leap's own arrowhead at the far end, dashed
  // because the ground under it is the part that is not there.
  leap: stroke(
    `<path d="M3 19.2c1.4-7.4 6.2-11.6 13.4-11.6" stroke-dasharray="2.4 2.6" opacity="0.8"/>` +
      `<path d="M12.8 4.4 17 7.6 13.6 11"/>` +
      `<circle cx="3" cy="19.2" r="1.5" fill="currentColor" stroke="none"/>`
  ),

  // A blade and a barrel crossed, with the swap arrows turning between them.
  // Neither weapon is drawn whole: at 24px a katana and a rifle differ by their
  // *ends*, so the glyph is a hilt and a stock meeting at the centre and the
  // two silhouettes reading off each other.
  weapon: stroke(
    // The blade, up to the right, with its guard.
    `<path d="M4.6 19.4 15.4 8.6" stroke-width="1.9"/>` +
      `<path d="M2.8 21.2 4.6 19.4" stroke-width="2.4"/>` +
      `<path d="M3.4 17.6 6.4 20.6" stroke-width="1.4"/>` +
      // The rifle, down to the right: barrel, then the drop of the grip.
      `<path d="M8.6 5.4h11.8" stroke-width="1.9"/>` +
      `<path d="M20.4 5.4v2.2" stroke-width="1.4"/>` +
      `<path d="M12.6 5.6 11 9.4" stroke-width="1.6"/>` +
      // And the exchange, turning between the two.
      `<path d="M17.4 13.2a3.6 3.6 0 0 1-5.2 3" stroke-width="1.3" opacity="0.72"/>` +
      `<path d="M12.9 18.3 11.6 16 14 15.1" stroke-width="1.3" opacity="0.72"/>` +
      `<path d="M14.2 19.6a3.6 3.6 0 0 0 5.2-3" stroke-width="1.3" opacity="0.72"/>` +
      `<path d="M18.7 14.5 20 16.8 17.6 17.7" stroke-width="1.3" opacity="0.72"/>`
  ),

  // A body on the stand, with a slot open either side of it — the studio is
  // where gear goes on, so the glyph is the fitting rather than the armour.
  customize: stroke(
    `<circle cx="12" cy="5.4" r="2.5"/>` +
      `<path d="M7.3 20.6c0-4.9.9-7.8 4.7-7.8s4.7 2.9 4.7 7.8" stroke-width="1.8"/>` +
      `<path d="M9.2 9.1 12 10.6l2.8-1.5" opacity="0.85"/>` +
      `<rect x="1.4" y="10.2" width="3.8" height="3.8" rx="1" opacity="0.6"/>` +
      `<rect x="18.8" y="10.2" width="3.8" height="3.8" rx="1" opacity="0.6"/>` +
      `<path d="M5.6 12.1h1.8M16.6 12.1h1.8" stroke-width="1.4" opacity="0.45"/>`
  ),

  // The lens crossing behind the body: the figure on its own axis, a lens
  // either side of it, and the arc the camera travels between the two. Drawn
  // symmetrically on purpose — the chip's own label says which side it is on
  // now, and a glyph that also tried to would be two answers to one question.
  shoulder: stroke(
    `<path d="M12 4.6v14.8" opacity="0.5"/>` +
      `<circle cx="4.6" cy="16.4" r="2.5"/>` +
      `<circle cx="19.4" cy="16.4" r="2.5"/>` +
      `<path d="M5.6 11.2a8.2 8.2 0 0 1 12.8 0" opacity="0.8"/>` +
      `<path d="M15.9 9.6 18.6 11.4 17.2 14.1" opacity="0.8"/>`
  ),

  // The leg, hip to knee to ankle to toe, with the impact thrown off the toe.
  // The hip is a dot and the foot a wedge: without them the joints read as a
  // tick mark rather than as a limb coming out of a body.
  kick: stroke(
    `<circle cx="4.6" cy="3.8" r="1.7" fill="currentColor" stroke="none"/>` +
      `<path d="M4.8 4.6 9 10.1 5.5 14 12.2 17.2" stroke-width="2.1"/>` +
      `<path d="M11.4 15.6 15.8 17.7 14.6 20.2 10.4 18.2z" fill="currentColor" stroke="none"/>` +
      `<path d="M17.2 13.2 20.4 11.2M18.4 16.6 22 16.2M17 19.8 20.4 21.4" ` +
      `stroke-width="1.4" opacity="0.62"/>`
  ),

  // Blade rising out of the guard, and the crescent the edge left behind it.
  slashHit: stroke(
    `<path d="M2.6 11.4C6.4 4.6 14.4 2.6 21.4 5.4" stroke-width="1.4" opacity="0.6"/>` +
      `<path d="M6.6 17.4 19 5" stroke-width="2"/>` +
      `<path d="M3.4 20.6 6.6 17.4" stroke-width="2.4"/>` +
      `<path d="M4.8 15.6 9 19.8" stroke-width="1.5"/>`
  ),

  // The same blade laid flat, its trail low and wide, and the speed behind it.
  crouchSlash: stroke(
    `<path d="M2.2 15.6C7.2 20.2 15.6 20.6 21.8 16" stroke-width="1.4" opacity="0.6"/>` +
      `<path d="M5.8 14.2 19 9.4" stroke-width="2"/>` +
      `<path d="M2.8 15.3 5.8 14.2" stroke-width="2.4"/>` +
      `<path d="M5 12.4 6.6 16.8" stroke-width="1.5"/>` +
      `<path d="M2.6 6.6h4.6M3.8 9.6h3.2" stroke-width="1.4" opacity="0.45"/>`
  ),

  // Two crescents already in the air and the star where the third one lands.
  // The only glyph in the set that draws a move's *whole* sequence rather than
  // its pose, because the sequence is what the move is: the pair of arcs are
  // thrown, the burst is arrived at.
  swordCombo: stroke(
    `<path d="M2.4 9.2c3-2.8 6.6-3.2 9.4-1.2" stroke-width="2"/>` +
      `<path d="M4.2 5.8c3-1.5 6-1.2 8.4.7" stroke-width="1.3" opacity="0.42"/>` +
      `<path d="M2.2 17.4c3-2.8 6.6-3.2 9.4-1.2" stroke-width="2"/>` +
      `<path d="M4 14c3-1.5 6-1.2 8.4.7" stroke-width="1.3" opacity="0.42"/>` +
      `<circle cx="18" cy="12" r="2.5" fill="currentColor" stroke="none"/>` +
      `<path d="M18 6.4v1.8M18 15.8v1.8M13.4 12h1.6M21 12h1.8M14.9 8.9l1.2 1.2` +
      `M21.1 8.9l-1.2 1.2M14.9 15.1l1.2-1.2M21.1 15.1l-1.2-1.2" ` +
      `stroke-width="1.3" opacity="0.66"/>`
  ),

  // The body upside down mid-turn, the heel still out where it planted, and
  // the loop of the flip open behind it. The arrowhead is on the *back* of the
  // loop rather than the front: this is the one technique that leaves.
  flipKick: stroke(
    `<path d="M16.6 4.6a7.4 7.4 0 1 1-9.2 2.2" stroke-width="1.4" opacity="0.6"/>` +
      `<path d="M6 10.6 7 6.2 11.2 7.6" stroke-width="1.4" opacity="0.6"/>` +
      `<circle cx="10.4" cy="18.4" r="1.7" fill="currentColor" stroke="none"/>` +
      `<path d="M10.6 17.6 12.6 12.4 17 12.2" stroke-width="2.1"/>` +
      `<path d="M16.4 10.6 20.8 11.2 20.4 13.9 16 13.4z" fill="currentColor" stroke="none"/>`
  ),

  // The rune, and what came up out of it. Deliberately not the ascendance
  // glyph turned a different colour, which is the trap with two pillars in one
  // set: that one is a soft shaft standing in a flat disc with hoops round it,
  // and this one is a *spike* rising out of a pointed sigil, wound by a single
  // unbroken thread and throwing four-pointed shards. At 26px the difference
  // that survives is the silhouette — a taper against a tube — so the taper is
  // the whole drawing and everything else is a mark beside it.
  voidBeam: stroke(
    // The column: two walls closing as they rise, and the hot line between them.
    `<path d="M9.6 1.4 8.6 14.6M14.4 1.4 15.4 14.6" stroke-width="1.3" opacity="0.55"/>` +
      `<path d="M12 1.2v13.6" stroke-width="2.3"/>` +
      // One thread wound round it, drawn as a single unbroken S so it reads as
      // a helix rather than as a stack of rings.
      `<path d="M7.6 11.8c3-1.4 3.4-3.6 1-4.8-2.4-1.2-1.4-3.4 1.8-4.4" ` +
      `stroke-width="1.3" opacity="0.85"/>` +
      `<path d="M16.4 11.8c-3-1.4-3.4-3.6-1-4.8 2.4-1.2 1.4-3.4-1.8-4.4" ` +
      `stroke-width="1.2" opacity="0.4"/>` +
      // The sigil it stands in: pointed, not a plain disc.
      `<path d="M12 12.9c5 0 9 1.6 9 3.4s-4 3.4-9 3.4-9-1.6-9-3.4 4-3.4 9-3.4z"/>` +
      `<path d="M12 14.9c2.3 0 4.2.6 4.2 1.4s-1.9 1.4-4.2 1.4-4.2-.6-4.2-1.4 1.9-1.4 4.2-1.4z" ` +
      `stroke-dasharray="1.7 1.7" opacity="0.5"/>` +
      // And the shards it is shedding — four-pointed, because that is what they
      // are, and scattered off-centre because a symmetric pair reads as ears.
      `<path d="M3.9 10.4 4.6 11.6 3.9 12.8 3.2 11.6z" fill="currentColor" stroke="none" opacity="0.85"/>` +
      `<path d="M20.2 7.6 20.8 8.6 20.2 9.6 19.6 8.6z" fill="currentColor" stroke="none" opacity="0.6"/>` +
      `<path d="M5.6 5.4 6.1 6.2 5.6 7 5.1 6.2z" fill="currentColor" stroke="none" opacity="0.45"/>`
  ),

  // Three blades converging on one point, and the rings the meeting throws.
  //
  // The trap next to `voidBeam` is that both moves are "a cast that ends a
  // body", and a glyph that says only that would be the same drawing twice. So
  // this one is built on the thing the beam has none of: **points**. Three of
  // them, on three bearings, all aimed at one spot — a shape with a direction
  // in it from every side, where the column is one vertical with no direction
  // at all. At 26px the difference that survives is convergence against
  // ascent, so the arrowheads are the drawing and the rings are a mark under it.
  crimsonRite: stroke(
    // The three blades: a shaft, a guard across it, and a point at the inner
    // end. Drawn as three separate strokes rather than one star, because a star
    // has no near and far and these are meant to be at three depths.
    `<path d="M3.6 4.2 9.9 9.6" stroke-width="1.8"/>` +
      `<path d="M3 6.6 5.6 3.4" stroke-width="1.3" opacity="0.7"/>` +
      `<path d="M20.4 4.2 14.1 9.6" stroke-width="1.8"/>` +
      `<path d="M21 6.6 18.4 3.4" stroke-width="1.3" opacity="0.7"/>` +
      `<path d="M12 21.4V14.4" stroke-width="1.8"/>` +
      `<path d="M9.9 21.8h4.2" stroke-width="1.3" opacity="0.7"/>` +
      // The point they are all aimed at, and the flash of them arriving.
      `<circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>` +
      `<path d="M12 7.4v2M7.6 14.6l1.7-1M16.4 14.6l-1.7-1" stroke-width="1.2" opacity="0.55"/>` +
      // And the train of rings it puts on the floor — two of them, because one
      // is an impact and several are a rite.
      `<ellipse cx="12" cy="12" rx="4.4" ry="4.4" stroke-width="1.2" ` +
      `stroke-dasharray="1.6 2.4" opacity="0.5"/>` +
      `<ellipse cx="12" cy="12" rx="7.4" ry="7.4" stroke-width="1.1" ` +
      `stroke-dasharray="1.4 3.2" opacity="0.28"/>`
  ),

  // Five blades on a ring, and the ring is turning.
  //
  // This sits beside `crimsonRite` in the same panel, and the two moves are
  // close enough in words — "katanas called up around a body" — that the glyphs
  // have to carry the difference on their own. They do it with the two things
  // that actually separate the moves. **Count**: three arrowheads against five
  // shafts, and five is past where the eye counts and into where it reads a
  // ring. **Gesture**: the rite's blades point *at* the middle, so its glyph is
  // a convergence; these are slewed off the radius into a pinwheel, which is
  // the one arrangement that reads as rotation at 26px with no arrow drawn.
  //
  // Everything else is subordinate to those two: the orbit is a faint dashed
  // circle, the guards are the marks that say the shafts are blades rather than
  // spokes, and the middle is a point because that is what five of them are
  // aimed at.
  shadowExecution: stroke(
    // The five, each a shaft from the ring inward, turned 25° off the radius.
    `<path d="M12 3.6 13.44 8.92" stroke-width="1.8"/>` +
      `<path d="M11.53 5.1 13.17 4.66" stroke-width="1.2" opacity="0.65"/>` +
      `<path d="M19.99 9.4 15.38 12.41" stroke-width="1.8"/>` +
      `<path d="M18.42 9.41 19.34 10.83" stroke-width="1.2" opacity="0.65"/>` +
      `<path d="M16.94 18.8 12.65 15.34" stroke-width="1.8"/>` +
      `<path d="M16.44 17.31 15.38 18.63" stroke-width="1.2" opacity="0.65"/>` +
      `<path d="M7.06 18.8 9.03 13.65" stroke-width="1.8"/>` +
      `<path d="M8.32 17.86 6.74 17.26" stroke-width="1.2" opacity="0.65"/>` +
      `<path d="M4.01 9.4 9.51 9.68" stroke-width="1.8"/>` +
      `<path d="M5.29 10.32 5.37 8.62" stroke-width="1.2" opacity="0.65"/>` +
      // The ring they are on.
      `<circle cx="12" cy="12" r="8.4" stroke-width="1.1" ` +
      `stroke-dasharray="1.5 2.8" opacity="0.32"/>` +
      // And what all five are aimed at.
      `<circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>` +
      `<circle cx="12" cy="12" r="3.2" stroke-width="1" ` +
      `stroke-dasharray="1.2 2" opacity="0.45"/>`
  ),

  // The column, wound, standing in its own circle. The only glyph in the set
  // with nothing being *done* to anybody in it, which is the point: the shaft
  // runs out of the top of the frame because the light comes from further up
  // than the box, and the two rings around it are the ribbons — front halves
  // solid, back halves faint, which is the cheapest way to draw a helix at this
  // size without it reading as a stack of hoops.
  ascendance: stroke(
    // The shaft: its walls, and the hot line down the middle of it.
    `<path d="M9.2 1.4 8.2 15.6M14.8 1.4 15.8 15.6" stroke-width="1.4" opacity="0.7"/>` +
      `<path d="M12 1.4v14.4" stroke-width="2.1"/>` +
      // The ribbons.
      `<path d="M7.9 7.4c2.4 2.3 5.8 2.3 8.2 0" stroke-width="1.4" opacity="0.9"/>` +
      `<path d="M7.9 7.4c2.4-1.9 5.8-1.9 8.2 0" stroke-width="1.2" opacity="0.32"/>` +
      `<path d="M7.4 12.4c2.6 2.4 6.2 2.4 8.8 0" stroke-width="1.4" opacity="0.9"/>` +
      `<path d="M7.4 12.4c2.6-2 6.2-2 8.8 0" stroke-width="1.2" opacity="0.32"/>` +
      // The sigil it is standing in.
      `<ellipse cx="12" cy="18.4" rx="8.3" ry="2.8"/>` +
      `<ellipse cx="12" cy="18.4" rx="4.4" ry="1.4" stroke-dasharray="1.8 1.8" opacity="0.5"/>` +
      // And the embers coming off it — diamonds, because that is what they are.
      `<path d="M3.6 12.4 4.5 13.6 3.6 14.8 2.7 13.6z" fill="currentColor" stroke="none" opacity="0.8"/>` +
      `<path d="M20.6 9.4 21.4 10.5 20.6 11.6 19.8 10.5z" fill="currentColor" stroke="none" opacity="0.62"/>` +
      `<path d="M19.6 14.6 20.2 15.4 19.6 16.2 19 15.4z" fill="currentColor" stroke="none" opacity="0.45"/>`
  ),

  // The other column, and the trap this glyph exists to avoid: at 26px a shaft
  // in a circle is a shaft in a circle, so if this were drawn like the one
  // above the two chips would be one icon in two colours. Three things separate
  // them, and all three are the ability itself read backwards. The light's
  // shaft leaves the top of the frame because it came from further up than the
  // box; this one *ends inside it*, ragged, because it came from under the
  // feet. Its foot flares where the light's is parallel. And where that one is
  // wound by clean hoops, this is wrapped in smoke — open curls that do not
  // close, with torn puffs coming off them.
  shadowBoost: stroke(
    // The pool it is standing in, filled: the only glyph in the set with a
    // solid ground under it, because the base glow is the layer everything else
    // in the effect is seen against.
    `<ellipse cx="12" cy="19" rx="8.4" ry="2.9" fill="currentColor" stroke="none" opacity="0.2"/>` +
      `<ellipse cx="12" cy="19" rx="8.4" ry="2.9" opacity="0.85"/>` +
      `<ellipse cx="12" cy="19" rx="4.6" ry="1.5" stroke-dasharray="1.8 1.8" opacity="0.5"/>` +
      // The column: walls that flare where they leave the ground and close as
      // they rise, and the dark line between them stopping short of the top.
      `<path d="M8.6 18.4c-.5-4.6-.2-8.4 1.1-12.2" stroke-width="1.4" opacity="0.75"/>` +
      `<path d="M15.4 18.4c.5-4.6.2-8.4-1.1-12.2" stroke-width="1.4" opacity="0.75"/>` +
      `<path d="M12 18.2V5.6" stroke-width="2.2"/>` +
      // And the ragged head of it — two short strokes fraying off the top,
      // which is the whole of what says this one ends where you can see it.
      `<path d="M12 5.6 10.6 2.6M12 5.6l1.6-2.4" stroke-width="1.3" opacity="0.6"/>` +
      // The wisps, wrapped round it. Open curls rather than closed hoops: the
      // difference between smoke and a spring at this size is whether the ends
      // meet.
      `<path d="M7.2 16.4c2.6-1.4 2.4-3.6.3-5 -2.1-1.4-1.4-3.4 1.3-4.4" ` +
      `stroke-width="1.3" opacity="0.9"/>` +
      `<path d="M16.8 16.4c-2.6-1.4-2.4-3.6-.3-5 2.1-1.4 1.4-3.4-1.3-4.4" ` +
      `stroke-width="1.2" opacity="0.5"/>` +
      // And the torn shadow coming off them — round and soft, because a puff of
      // smoke is the one thing in this set that must not have corners.
      `<circle cx="4" cy="12.6" r="1.5" fill="currentColor" stroke="none" opacity="0.8"/>` +
      `<circle cx="20.2" cy="9.6" r="1.2" fill="currentColor" stroke="none" opacity="0.55"/>` +
      `<circle cx="5.9" cy="7.6" r="0.9" fill="currentColor" stroke="none" opacity="0.4"/>`
  )
};

/**
 * The icon for an ability, as an element ready to append.
 *
 * Falls back to an empty span when an id has no drawing yet — a new move should
 * cost a missing glyph, not a HUD that fails to build.
 *
 * @param {string} id
 * @param {string} [className]
 */
export function createIcon(id, className = 'hud__icon') {
  const holder = document.createElement('span');
  holder.className = className;
  holder.innerHTML = ABILITY_ICONS[id] ?? '';
  return holder;
}
