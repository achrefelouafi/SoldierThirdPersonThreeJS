import { Box3, Matrix4, MeshDepthMaterial, RGBADepthPacking, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { copyColor, makeColor } from '../utils/color.js';
import { patchOnBeforeCompile, replaceChunk } from '../utils/shaderPatch.js';

const _inverse = new Matrix4();
const _relative = new Matrix4();
const _bounds = new Box3();

/**
 * One weapon, able to burn away and back.
 *
 * A mask over the piece: a noise field mixed with how far along the weapon the
 * fragment is, thresholded, `discard`ed below the line, and lit along the line
 * itself. Run the threshold from 0 to 1 and the weapon dissolves from the grip
 * outward; run it back and it comes in the same way. That is the whole of the
 * swap in `WeaponSwitch` — there is no second effect for the arrival, only the
 * same mask read backwards, which is what makes the two halves look like one
 * exchange.
 *
 * ## The frame the mask lives in
 *
 * Every fragment is resolved into the weapon *root's* space (`uWeaponInverse`,
 * refreshed each frame from the mount's world matrix). Two things fall out of
 * that and neither is optional:
 *
 *  - A weapon is several nodes with transforms of their own — the rifle is a
 *    body, a stock and a ring that spins. Mesh-local coordinates would give
 *    each of them its own private mask, and the burn would arrive at three
 *    different times on three parts of one object.
 *  - World coordinates would leave the pattern standing still in the room while
 *    the weapon swings through it, so the burn would crawl across the piece
 *    with the swing of an arm.
 *
 * Rooted at the weapon, the mask rides it: the same speckle is on the same
 * millimetre of barrel however the body is moving.
 *
 * ## Why the materials are cloned
 *
 * The palette is shared with the body (see `EquipmentLibrary`) — patching a
 * material here would put a dissolve on the character's armour. So each
 * material this touches is cloned once. A clone copies parameters and
 * *references* the same textures, so a weapon costs a uniform block rather than
 * a second copy of its maps.
 */
export class WeaponDissolve {
  /**
   * @param {import('three').Object3D} root the mounted weapon — the space the
   *   mask is resolved in, and the transform the piece is measured against
   */
  constructor(root) {
    this.root = root;

    /** Shared by every material on this weapon, so one write moves all of it. */
    this.uniforms = {
      /** 0 = solid, 1 = gone. Everything between is the burn. */
      uDissolve: { value: 0 },
      uWeaponInverse: { value: new Matrix4() },
      uNoiseScale: { value: 26 },
      /** The piece's long axis, and where it starts and how far it runs. */
      uAxis: { value: new Vector3(0, 0, 1) },
      uBase: { value: 0 },
      uSpan: { value: 1 },
      uRise: { value: 0.55 },
      uEdgeColor: { value: makeColor('#7fd4ff') },
      uEdgeEmissive: { value: 7 },
      uEdgeWidth: { value: 0.13 }
    };

    /** The clones this made, so teardown releases exactly what it created. */
    this.materials = [];
    this.depthMaterials = [];

    this._measure();
    this._dress();
    this.update();
  }

  /** 0 = solid, 1 = gone. */
  get progress() {
    return this.uniforms.uDissolve.value;
  }

  set progress(value) {
    this.uniforms.uDissolve.value = Math.min(1, Math.max(0, value));
  }

  /**
   * Re-read the look. Live, so the burn is editable while it is running.
   * @param {typeof import('../config/settings.js').settings.weapons} look
   */
  sync(look) {
    const u = this.uniforms;
    copyColor(u.uEdgeColor.value, look.edgeColor);
    u.uEdgeEmissive.value = look.edgeEmissive;
    u.uEdgeWidth.value = look.edgeWidth;
    u.uRise.value = look.rise;
    u.uNoiseScale.value = look.detail;
  }

  /**
   * Bring the mask's frame up to date with where the weapon is.
   *
   * Every frame it is burning, and only then: the matrix is what pins the
   * pattern to the piece, and a stale one would let the mask slide across a
   * weapon that is moving. A solid weapon has no mask to pin.
   */
  update() {
    this.root.updateWorldMatrix(true, false);
    this.uniforms.uWeaponInverse.value.copy(this.root.matrixWorld).invert();
  }

  /* ------------------------------------------------------------------ */

  /**
   * Measure the piece, in its own space.
   *
   * The longest axis of the bounding box is taken as "along the weapon" — for
   * a katana that is the blade and for the rifle it is the barrel, which is the
   * direction a burn wants to travel in either case. Nothing here is authored,
   * so a third weapon costs no numbers.
   */
  _measure() {
    const box = new Box3();
    this.root.updateWorldMatrix(true, true);
    _inverse.copy(this.root.matrixWorld).invert();

    this.root.traverse((node) => {
      if (!node.isMesh && !node.isSkinnedMesh) return;
      if (!node.geometry?.boundingBox) node.geometry?.computeBoundingBox();
      if (!node.geometry?.boundingBox) return;
      _bounds.copy(node.geometry.boundingBox);
      _relative.multiplyMatrices(_inverse, node.matrixWorld);
      box.union(_bounds.applyMatrix4(_relative));
    });

    if (box.isEmpty()) return;

    const size = box.getSize(new Vector3());
    const axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z';

    this.uniforms.uAxis.value.set(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    this.uniforms.uBase.value = box.min[axis];
    this.uniforms.uSpan.value = Math.max(1e-3, size[axis]);
  }

  /** Replace every material under the weapon with a patched clone of it. */
  _dress() {
    const clones = new Map();

    this.root.traverse((node) => {
      if (!node.isMesh && !node.isSkinnedMesh) return;

      // The burn is a `discard`, and the depth pass would otherwise go on
      // casting a whole weapon's shadow off one that is half gone.
      const depth = this._makeDepthMaterial();
      node.customDepthMaterial = depth;
      this.depthMaterials.push(depth);

      const source = Array.isArray(node.material) ? node.material : [node.material];
      const applied = source.map((material) => {
        if (!material) return material;
        if (!clones.has(material)) clones.set(material, this._makeMaterial(material));
        return clones.get(material);
      });

      node.material = Array.isArray(node.material) ? applied : applied[0];
    });
  }

  /**
   * One of the weapon's materials → this instance's own, maskable, copy.
   *
   * @param {import('three').Material} source
   */
  _makeMaterial(source) {
    const material = source.clone();
    material.name = `${source.name || 'weapon'}__dissolve`;

    /**
     * The surface this was made from, before the mask went on it.
     *
     * Anything that copies a weapon's material to make something *else* out of
     * it has to start here, not from the clone: a copy taken off this one would
     * inherit the mask's threshold with it, so anything forged while the rifle
     * was drawn would be born already burnt away.
     *
     * A plain own property rather than `userData`, which `Material.copy`
     * deep-clones through JSON and a material reference does not survive.
     */
    material.undissolved = source;

    // `Material.copy` does not carry own-property `onBeforeCompile`, so a
    // patch already on the weapon would be silently dropped by the clone —
    // along with the cache key that says which program it belongs to. See
    // `utils/shaderPatch.js`.
    if (Object.hasOwn(source, 'onBeforeCompile')) {
      material.onBeforeCompile = source.onBeforeCompile;
      if (Object.hasOwn(source, 'customProgramCacheKey')) {
        material.customProgramCacheKey = source.customProgramCacheKey;
      }
    }

    // `totalEmissiveRadiance` only exists on the lit materials. An unlit one
    // still burns away — it simply has nowhere to put the edge light.
    const lit = Boolean(material.emissive);

    patchOnBeforeCompile(material, (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = VERTEX_PATCH(shader.vertexShader);
      shader.fragmentShader = lit
        ? FRAGMENT_PATCH(shader.fragmentShader)
        : CUT_ONLY_PATCH(shader.fragmentShader);
    });
    material.needsUpdate = true;

    this.materials.push(material);
    return material;
  }

  /**
   * The same mask, for the shadow map.
   *
   * Only the threshold — no edge, because a shadow has no colour to put one in,
   * and the noise tap is the whole cost either way.
   */
  _makeDepthMaterial() {
    const material = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });

    patchOnBeforeCompile(material, (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = VERTEX_PATCH(shader.vertexShader);
      shader.fragmentShader = replaceChunk(
        `${MASK_HEAD}\n${shader.fragmentShader}`,
        '#include <alphatest_fragment>',
        `#include <alphatest_fragment>\nif (weaponBurn() < uDissolve) discard;`
      );
    });

    return material;
  }

  dispose() {
    this.root.traverse((node) => {
      node.customDepthMaterial = undefined;
    });
    for (const material of this.materials) material.dispose();
    for (const material of this.depthMaterials) material.dispose();
    this.materials.length = 0;
    this.depthMaterials.length = 0;
  }
}

/* -------------------------------------------------------------------- */

/**
 * The vertex, in the weapon root's frame.
 *
 * `transformed` rather than `position`, so a weapon that ever arrives skinned
 * or morphed is masked in the shape it is actually drawn in; `modelMatrix`
 * takes it to world space and `uWeaponInverse` brings it back down to the piece
 * — see the class note for why that is the frame the mask has to live in.
 */
const VERTEX_PATCH = (source) => {
  const head = /* glsl */ `
uniform mat4 uWeaponInverse;
varying vec3 vWeaponPos;
`;
  return replaceChunk(
    `${head}\n${source}`,
    '#include <begin_vertex>',
    `#include <begin_vertex>
vWeaponPos = (uWeaponInverse * modelMatrix * vec4(transformed, 1.0)).xyz;`
  );
};

/**
 * The mask itself, shared by the lit pass and the shadow pass.
 *
 * `burn` is noise crossed with distance along the piece: pure noise reads as
 * static eating the weapon and a pure gradient reads as a wipe, and the mix of
 * the two is the thing that looks like it is being unmade. A fragment survives
 * while its `burn` is still above the threshold, so raising the threshold takes
 * the weapon apart from the grip outward.
 */
const MASK_HEAD = /* glsl */ `
${noiseGLSL}
uniform float uDissolve;
uniform float uNoiseScale;
uniform vec3 uAxis;
uniform float uBase;
uniform float uSpan;
uniform float uRise;
varying vec3 vWeaponPos;

float weaponBurn() {
  float n = snoise01(vWeaponPos * uNoiseScale);
  float along = clamp((dot(vWeaponPos, uAxis) - uBase) / uSpan, 0.0, 1.0);
  return mix(n, along, clamp(uRise, 0.0, 1.0));
}
`;

/** The cut, and the light along the cut. */
const FRAGMENT_PATCH = (source) => {
  const head = /* glsl */ `
${MASK_HEAD}
uniform vec3 uEdgeColor;
uniform float uEdgeEmissive;
uniform float uEdgeWidth;
`;

  const body = /* glsl */ `
#include <emissivemap_fragment>

if (uDissolve > 0.0) {
  float burn = weaponBurn();
  if (burn < uDissolve) discard;
  // The band just above the threshold — the fragments that are about to go.
  // It is the *edge of the noise* rather than an outline of the weapon, which
  // is what makes the mask itself visible instead of merely its result.
  float edge = 1.0 - smoothstep(uDissolve, uDissolve + max(uEdgeWidth, 1e-3), burn);
  totalEmissiveRadiance += uEdgeColor * edge * uEdgeEmissive;
}
`;

  return replaceChunk(`${head}\n${source}`, '#include <emissivemap_fragment>', body);
};
