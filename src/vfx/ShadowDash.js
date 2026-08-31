import { MathUtils, Matrix4 } from 'three';

import { settings } from '../config/settings.js';
import { frame } from '../core/FrameUniforms.js';
import { copyColor, makeColor } from '../utils/color.js';
import { patchOnBeforeCompile, replaceChunk } from '../utils/shaderPatch.js';

/** Seconds between sweeps of the body for materials nobody has dressed yet. */
const RESCAN = 0.5;

/**
 * The character itself, turned to shadow for the length of a dash.
 *
 * ## What it is for
 *
 * The sword combo's third beat is the character arriving in person: the warp
 * carries the body up to ten metres in about four tenths of a second (see
 * `settings.swordCombo.warpFrom`). Nothing on the body ever said so. The same
 * lit skin that was standing still throwing crescents arrived standing still
 * somewhere else, and a body that is only ever *between* two poses reads as a
 * teleport with a smear on it rather than as something that moved.
 *
 * So for those four tenths it is not that body. The skin burns away into a
 * shade of itself — a dark surface the stage shows *through*, held together by
 * a violet rim, so the silhouette still reads against a night stage — and burns
 * back out of it on the frame the feet land on the mark. The one fresnel term
 * pays for both halves of that: it lights the rim and it decides how much of
 * the world comes through, so the body is thinnest square-on and solid at the
 * edges, which is where a silhouette actually lives. The finisher lands on a body that is still coming
 * back, which is where it should land: the blow is what puts the character
 * back in the world.
 *
 * ## Why it patches rather than swaps
 *
 * The obvious implementation is a second set of materials and a swap. That buys
 * a pop on both edges and a shader compile at the worst possible moment, and it
 * has to be undone correctly for every mesh on a body whose gear changes while
 * the game is running.
 *
 * Instead every material the body is *already* wearing gets one patch, once, and
 * one uniform decides how much of it is shade this frame. There is no swap, no
 * second draw and no state to unwind — at `uDashShift` 0 the branch is not
 * taken and the character renders exactly as it did before this class existed.
 * The transition is then free: a noise field crossed with height up the body,
 * thresholded at the shift, with a line of light riding the front. Run the
 * threshold up and the character dissolves into shadow from the feet; run it
 * back down and the shadow recedes the way it came, which is what makes the two
 * halves read as one exchange rather than as two effects.
 *
 * ## What it dresses
 *
 * Everything under `character.model`, which is the body *and* whatever is
 * hanging off its bones — a drawn katana goes to shadow with the arm holding
 * it. Gear is mounted and unmounted while the game runs, so the sweep is
 * repeated every `RESCAN` seconds; a material is only ever patched once
 * (`_dressed`), so a sweep that finds nothing new costs a traversal and no
 * shader compiles.
 *
 * Nothing here knows what a sword combo is. It is handed an `Attack` and a
 * window stated against that move's own approach, so any move with a warp can
 * ask for the same treatment by pointing this at its own settings block.
 */
export class ShadowDash {
  /**
   * @param {import('../animation/CharacterController.js').CharacterController} character
   * @param {object} [options]
   * @param {() => object} [options.config] the block the look and the window are
   *   read from, per frame, so the editor's edits land immediately
   */
  constructor(character, { config = () => settings.swordCombo.shadowDash } = {}) {
    this.character = character;
    this.config = config;

    /**
     * Shared by every material this dresses, by identity — one write a frame
     * moves the whole body. Names are prefixed because these land in shaders
     * that are already carrying somebody else's patch: a mounted weapon's
     * material is patched by `equipment/WeaponDissolve.js`, and two injections
     * declaring one `uNoiseScale` between them is a compile error rather than a
     * subtle bug.
     */
    this.uniforms = {
      /** 0 = the body as authored, 1 = all shade. Everything between is the burn. */
      uDashShift: { value: 0 },
      /** World → the character's own frame, so the burn rides the body. */
      uDashInverse: { value: new Matrix4() },

      uDashColor: { value: makeColor('#04050b') },
      uDashRoughness: { value: 0.85 },
      uDashMetalness: { value: 0 },

      uDashRimColor: { value: makeColor('#7a4dff') },
      uDashRimPower: { value: 2.4 },
      uDashRimEmissive: { value: 2.2 },

      /** The veil: how solid the shade is square-on, at the rim, and the curve between. */
      uDashCoreAlpha: { value: 0.16 },
      uDashRimAlpha: { value: 0.92 },
      uDashAlphaPower: { value: 1.6 },
      // The frame's exposure, by identity — the emissives divide themselves by
      // it so the colours survive the trip between the two stages' grades.
      uDashExposure: frame.uExposure,

      uDashDetail: { value: 9 },
      uDashHeight: { value: 1.8 },
      uDashRise: { value: 0.4 },
      uDashDrift: { value: 0 },

      uDashEdgeColor: { value: makeColor('#8f5bff') },
      uDashEdgeEmissive: { value: 3.6 },
      uDashEdgeWidth: { value: 0.09 }
    };

    /** Materials already carrying the patch. Never patched twice. */
    this._dressed = new WeakSet();
    /** The model the last sweep walked, so a reloaded body is re-dressed. */
    this._model = null;
    /** Seconds until the next sweep for gear that has arrived since the last. */
    this._scan = 0;
    /** Where the burn is, and how far the noise has crawled since it started. */
    this._shift = 0;
    this._drift = 0;
  }

  /** How much of the body is shade right now, 0..1. */
  get progress() {
    return this._shift;
  }

  /** Whether any of it is. */
  get active() {
    return this._shift > 1e-3;
  }

  /**
   * Advance the burn.
   *
   * @param {number} dt seconds on the *simulation's* clock — the return runs
   *   through the finisher's own hit-stop and is meant to slow with it
   * @param {import('../animation/Attack.js').Attack|null} attack the move whose
   *   approach the shade is following. Null, or a move standing still, and the
   *   body simply comes back.
   */
  update(dt, attack = null) {
    const config = this.config();

    if (!config.enabled && this._shift <= 0) {
      this._drift = 0;
      return;
    }

    this._sweep(dt);

    // A linear ramp in each direction, for the same reason `Attack`'s blend is
    // linear: the burn has to *finish*, and an exponential tail would leave a
    // few percent of shade on a body that is supposed to be back.
    const target = this._wanted(attack, config);
    const rising = target > this._shift;
    const step = dt / Math.max(0.02, rising ? config.enter : config.exit);
    this._shift = rising
      ? Math.min(target, this._shift + step)
      : Math.max(target, this._shift - step);

    if (this._shift <= 0) {
      this._shift = 0;
      this._drift = 0;
      this.uniforms.uDashShift.value = 0;
      return;
    }

    this._drift += dt * config.drift;
    this._sync(config);
  }

  /** Back to the authored body, this frame. For leaving the stage and for a reset. */
  clear() {
    this._shift = 0;
    this._drift = 0;
    this.uniforms.uDashShift.value = 0;
  }

  /**
   * Give the body back and forget it.
   *
   * The patch itself stays on materials this class does not own — there is no
   * safe way to take an injection back out of somebody else's shader, and with
   * the shift at zero there is nothing to take out: the branch is not taken.
   */
  dispose() {
    this.clear();
    this._model = null;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Whether the body should be shade this frame.
   *
   * The window is stated against the move's *own* approach rather than in
   * absolute phases, so tuning `warpFrom`/`warpAt` carries the burn with it and
   * cannot leave a lit body dashing or a shadow standing around after it has
   * arrived.
   *
   * A swing with no warp is a swing at the air from where the body is already
   * standing — there is no travel to explain, so there is nothing to hide.
   */
  _wanted(attack, config) {
    if (!config.enabled || !attack?.locked || !attack.warp?.active) return 0;

    const move = attack.config;
    const warpAt = Math.max(0.01, move.warpAt ?? 0);
    const warpFrom = MathUtils.clamp(move.warpFrom ?? 0, 0, warpAt - 0.01);
    const phase = attack.phase;

    return phase >= warpFrom - (config.lead ?? 0) && phase < warpAt + (config.linger ?? 0) ? 1 : 0;
  }

  /** Settings → the uniforms, live, plus the frame the burn is resolved in. */
  _sync(config) {
    const u = this.uniforms;

    u.uDashShift.value = this._shift;

    copyColor(u.uDashColor.value, config.color);
    u.uDashRoughness.value = config.roughness;
    u.uDashMetalness.value = config.metalness;

    copyColor(u.uDashRimColor.value, config.fresnel.color);
    u.uDashRimPower.value = config.fresnel.power;
    u.uDashRimEmissive.value = config.fresnel.emissive;

    const veil = config.veil;
    u.uDashCoreAlpha.value = MathUtils.clamp(veil.core, 0, 1);
    u.uDashRimAlpha.value = MathUtils.clamp(veil.rim, 0, 1);
    u.uDashAlphaPower.value = Math.max(0.05, veil.power);

    u.uDashDetail.value = config.detail;
    u.uDashHeight.value = Math.max(1e-3, this.character.height);
    u.uDashRise.value = config.rise;
    u.uDashDrift.value = this._drift;

    copyColor(u.uDashEdgeColor.value, config.edgeColor);
    u.uDashEdgeEmissive.value = config.edgeEmissive;
    u.uDashEdgeWidth.value = config.edgeWidth;

    // The body's own frame, this frame. `tilt` rather than `root`: it is the
    // node the model actually hangs in, so a lean or a bob carries the noise
    // field with it, and it carries no scale — the burn is measured in metres
    // off the floor, which is what lets `detail` be cycles per metre and
    // `uDashHeight` be the character's height as everything else states it.
    //
    // It has to be current. The whole point of the move is that the character
    // crosses ten metres while this is running, and a matrix one frame stale
    // would drag the field half a metre through the body every frame of it.
    const tilt = this.character.tilt;
    tilt.updateWorldMatrix(true, false);
    u.uDashInverse.value.copy(tilt.matrixWorld).invert();
  }

  /**
   * Dress anything on the body that is not dressed yet.
   *
   * On a timer rather than every frame because the answer only changes when
   * gear is mounted or a weapon is drawn, and half a second is far inside the
   * two seconds of clip that run before the dash — nothing can arrive late
   * enough to be caught bare in one.
   */
  _sweep(dt) {
    const model = this.character.model;
    if (!model) return;

    this._scan -= dt;
    if (model === this._model && this._scan > 0) return;
    this._model = model;
    this._scan = RESCAN;

    model.traverse((node) => {
      if (!node.isMesh && !node.isSkinnedMesh) return;
      const list = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of list) {
        if (!material || this._dressed.has(material)) continue;
        this._dressed.add(material);
        // Only the lit standard family has the chunks below to hook, and it is
        // what every material on this body is: the palette is glTF and anything
        // the rig brought was converted (`CharacterController#_toStandard`).
        if (!material.isMeshStandardMaterial) continue;
        this._patch(material);
      }
    });
  }

  /**
   * One material, able to go to shadow and back.
   *
   * The `transparent` flag is set here, once, and never taken off again. It has
   * to be set *somewhere* — three writes `gl_FragColor.a = 1.0` into any shader
   * it believes is opaque, so an alpha the patch computes would be thrown away
   * — and setting it per dash would mean a flag change on a dozen materials on
   * the frame the move fires, which is a shader recompile at the worst moment
   * in the move. Left on, it costs nothing: outside the dash `uDashShift` is 0,
   * the branch is not taken and the alpha is still exactly 1.
   *
   * `depthWrite` is deliberately left alone — the body keeps writing depth, so
   * the veil shows the *stage* through the character and never the inside of
   * its own skull.
   */
  _patch(material) {
    patchOnBeforeCompile(material, (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = DASH_VERTEX_PATCH(shader.vertexShader);
      shader.fragmentShader = DASH_FRAGMENT_PATCH(shader.fragmentShader);
    });
    material.transparent = true;
    material.needsUpdate = true;
  }
}

/* -------------------------------------------------------------------- */

/**
 * The posed vertex, in the character's own frame.
 *
 * `transformed` rather than `position`, so the burn is masked in the shape the
 * body is actually drawn in — taken after skinning, the pattern rides the mesh
 * instead of the mesh sliding through a pattern standing still in the room.
 * `modelMatrix` takes it to world space and `uDashInverse` brings it back down
 * to the character, which is the frame it has to live in: the body *travels*
 * while this is running, and anything resolved in world space would wash the
 * burn across it at ten metres a second.
 *
 * Mesh-local space would not do either. The gear on the bones is a dozen nodes
 * with transforms of their own, and each would get its own private mask —
 * a burn arriving at a different height on the pauldron than on the chest.
 */
const DASH_VERTEX_PATCH = (source) => {
  const head = /* glsl */ `
uniform mat4 uDashInverse;
varying vec3 vDashBody;
`;
  return replaceChunk(
    `${head}\n${source}`,
    '#include <skinning_vertex>',
    `#include <skinning_vertex>
vDashBody = (uDashInverse * modelMatrix * vec4(transformed, 1.0)).xyz;`
  );
};

/**
 * The threshold, the surface it decides, and the light along the front.
 *
 * Two injections, because the two halves of "this fragment is shadow" land in
 * two different places in the standard shader and one of them has to run before
 * the lighting:
 *
 *  1. at `metalnessmap_fragment`, where the diffuse colour and both surface
 *     responses are resolved and nothing has been lit yet — the fragment is
 *     turned to shade *as a material*, so the dark takes the stage's key and
 *     the rim light like any other surface rather than being painted over the
 *     top of a lit one;
 *  2. at `emissivemap_fragment`, which is where a body's own light goes.
 *
 * The mask is evaluated once, in the first, and left in a global for the
 * second: it is the most expensive thing in either patch and its answer does
 * not change between them.
 *
 * ## Why the noise is local
 *
 * The project has a shared noise library, and this cannot use it. These
 * injections land on materials that may already be carrying
 * `equipment/WeaponDissolve.js`'s — a drawn katana's are — which brings that
 * library and its uniform names in with it. A second copy of either in one
 * shader is a redefinition and the program fails to compile. So the noise here
 * is its own, and every name in these patches is prefixed.
 *
 * ## The burn
 *
 * `mix(noise, height)` thresholded at the shift, exactly as every other
 * dissolve in the project: pure noise reads as static eating the character and
 * pure height as a wipe, and the value between them is what looks like a body
 * coming apart. The band is widened by `uDashEdgeWidth` at both ends so the
 * shift still reaches a *fully* authored body at 0 and a fully dark one at 1
 * with a soft front in between.
 *
 * ## The veil
 *
 * The shaded fragments thin out rather than going black — see `_patch` for the
 * flag that costs, and the emissive block below for the division that keeps the
 * rim alive through it. Still no `discard` anywhere: the alpha is a smooth
 * field over a body that goes on writing depth, so nothing about it has to be
 * sorted against itself, and outside the dash it is 1 everywhere.
 */
const DASH_FRAGMENT_PATCH = (source) => {
  const head = /* glsl */ `
uniform float uDashShift;
uniform vec3 uDashColor;
uniform float uDashRoughness;
uniform float uDashMetalness;
uniform vec3 uDashRimColor;
uniform float uDashRimPower;
uniform float uDashRimEmissive;
uniform float uDashCoreAlpha;
uniform float uDashRimAlpha;
uniform float uDashAlphaPower;
uniform float uDashExposure;
uniform float uDashDetail;
uniform float uDashHeight;
uniform float uDashRise;
uniform float uDashDrift;
uniform vec3 uDashEdgeColor;
uniform float uDashEdgeEmissive;
uniform float uDashEdgeWidth;
varying vec3 vDashBody;

/** How much of this fragment is shade, and how close it is to the front. */
float dashShade;
float dashFront;

float dashHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

/** Value noise, two octaves — enough grain for a body, and eight taps. */
float dashNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      mix(dashHash(i), dashHash(i + vec3(1.0, 0.0, 0.0)), f.x),
      mix(dashHash(i + vec3(0.0, 1.0, 0.0)), dashHash(i + vec3(1.0, 1.0, 0.0)), f.x),
      f.y),
    mix(
      mix(dashHash(i + vec3(0.0, 0.0, 1.0)), dashHash(i + vec3(1.0, 0.0, 1.0)), f.x),
      mix(dashHash(i + vec3(0.0, 1.0, 1.0)), dashHash(i + vec3(1.0, 1.0, 1.0)), f.x),
      f.y),
    f.z);
}
`;

  const surface = /* glsl */ `
#include <metalnessmap_fragment>

dashShade = 0.0;
dashFront = 0.0;

if (uDashShift > 0.0) {
  vec3 p = vDashBody * uDashDetail - vec3(0.0, uDashDrift, 0.0);
  float n = dashNoise(p) * 0.65 + dashNoise(p * 2.17) * 0.35;
  float up = clamp(vDashBody.y / uDashHeight, 0.0, 1.0);
  float mask = mix(n, up, clamp(uDashRise, 0.0, 1.0));

  // The front, widened past both ends so 0 is entirely the authored body and
  // 1 entirely shade rather than each leaving half a band behind.
  float w = max(uDashEdgeWidth, 1e-3);
  float level = uDashShift * (1.0 + 2.0 * w) - w;
  dashShade = 1.0 - smoothstep(level - w, level + w, mask);
  // Peaks where the fragment is half taken — the edge of the *noise*, which is
  // what makes the mask itself visible rather than only its result.
  dashFront = 4.0 * dashShade * (1.0 - dashShade);

  diffuseColor.rgb = mix(diffuseColor.rgb, uDashColor, dashShade);
  roughnessFactor = mix(roughnessFactor, uDashRoughness, dashShade);
  metalnessFactor = mix(metalnessFactor, uDashMetalness, dashShade);
}
`;

  const emissive = /* glsl */ `
#include <emissivemap_fragment>

if (uDashShift > 0.0) {
  // Every grazing angle emits: the rim is what stops a black body reading as a
  // hole in the screen. Fading it in with the shade rather than with the shift
  // keeps it off the half of the body that is still skin.
  float facing = clamp(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0);

  // The veil, off the same term: square-on is nearly gone, the rim is nearly
  // solid, and the burning front is solid whatever the numbers say — an edge
  // you can see through is not an edge. Only the shaded fraction thins, so the
  // half of the body that is still skin stays as opaque as it was authored.
  float veil = mix(uDashCoreAlpha, uDashRimAlpha, pow(facing, uDashAlphaPower));
  veil = clamp(max(veil, dashFront), 0.0, 1.0);
  float alpha = mix(diffuseColor.a, min(diffuseColor.a, veil), dashShade);

  // Everything below is emitted *through* that veil — the blend multiplies it
  // by the alpha on the way out — so it is pre-divided by it. Without this the
  // rim goes out exactly where the body gets thinnest, which is the one place
  // it is holding the silhouette together. Floored, so a near-invisible core
  // cannot turn a small emissive into an arc light.
  float through = max(uDashExposure, 0.01) * max(alpha, 0.15);

  totalEmissiveRadiance +=
    uDashRimColor * pow(facing, max(uDashRimPower, 0.05))
    * (uDashRimEmissive * dashShade / through);

  totalEmissiveRadiance +=
    uDashEdgeColor * dashFront * (uDashEdgeEmissive / through);

  diffuseColor.a = alpha;
}
`;

  const patched = replaceChunk(
    `${head}\n${source}`,
    '#include <metalnessmap_fragment>',
    surface
  );
  return replaceChunk(patched, '#include <emissivemap_fragment>', emissive);
};
