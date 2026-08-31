import {
  AdditiveBlending,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  ShaderMaterial,
  Vector3
} from 'three';

import { LAYER } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { copyColor, makeColor } from '../utils/color.js';

/**
 * Segments along the arc, and across it.
 *
 * All of the resolution is in `u`: the stroke is a metre and a half of curve
 * seen from a few metres away, and the erosion that tears its trailing edge is
 * sampled per fragment anyway. Across it there is nothing to resolve but a
 * width that changes smoothly, so six spans is already more than the silhouette
 * can spend.
 */
const SEGMENTS_U = 56;
const SEGMENTS_V = 6;

/**
 * Strokes on screen at once.
 *
 * A rite throws two per stab and five on the tear-out, and the tail of one
 * overlaps the head of the next — eighteen is the busiest frame plus room for a
 * second rite thrown on top of the first.
 */
const CAPACITY = 24;

const _pivot = /* @__PURE__ */ new Vector3();
const _radial = /* @__PURE__ */ new Vector3();
const _travel = /* @__PURE__ */ new Vector3();
const _axis = /* @__PURE__ */ new Vector3();
const _scale = /* @__PURE__ */ new Vector3();
// `fan` has to hold its own bearing across a call into `strike`, which uses the
// two above as scratch — so it gets a pair of its own rather than a subtle bug.
const _fanAxis = /* @__PURE__ */ new Vector3();
const _fanTravel = /* @__PURE__ */ new Vector3();

/**
 * The mark a blade leaves in the air behind it.
 *
 * ## What it is, and what it is not
 *
 * A stroke: one piece of a circle, swept about an axis, with a razor of white
 * heat along its leading edge and the rest of it tearing itself to pieces from
 * the trailing edge inward. It is the first panel of the reference and it is
 * the layer the whole ability is read off — everything else here (the mist, the
 * rings, the aura, the cinders) is *what the stroke disturbed*.
 *
 * It is deliberately **not** `vfx/SlashWave.js`, which is the other thing in
 * this project shaped like a crescent. That one is a projectile: it is thrown,
 * it travels, it arrives somewhere and it is a whole cut compressed into a
 * flying object. This one never moves. It is struck into the air at the moment
 * an edge passes through a body and it stays exactly where it was struck while
 * it comes apart, because that is what a trail *is* — the record of where the
 * steel has already been, not a thing on its way anywhere.
 *
 * ## The three things that happen across one stroke
 *
 * Every term is a function of `u` (along the arc, 0 at one tip to 1 at the
 * other) and `v` (across it, 0 at the trailing edge to 1 at the leading one).
 *
 *  1. **The taper.** `sin(πu)` raised to a power, so both ends close to a
 *     point. A stroke with blunt ends is a piece of pipe; the whole silhouette
 *     of a cut lives in the fact that it ends in something that could cut.
 *  2. **The razor.** A hard white line at `v = razor`, near but not on the
 *     leading edge. On it and the stroke reads as a glowing band with a lit
 *     border; a little inside it and there is a thin skin of crimson *ahead* of
 *     the white, which is what the eye reads as an edge rather than as a tube.
 *  3. **The tearing.** The trailing half is eaten by a threshold that climbs
 *     with age, so the stroke does not fade — it **shatters**, from the tail
 *     forward and from the tips inward, into filaments and then into nothing.
 *     A trail that fades uniformly is a decal losing opacity. A trail that
 *     comes apart is something that was never solid to begin with.
 *
 * The tearing is the reason this is one shader rather than a ribbon plus a
 * particle system: the fragments in the reference are *the trail*, at a later
 * moment, and drawing them separately means keeping two things agreeing about
 * where a stroke was and how far gone it is.
 *
 * ## Drawing on
 *
 * A stroke is not born whole. `head` runs from one tip to the other over the
 * first fraction of its life and nothing is drawn past it, with a bloom of
 * heat riding on the front — so the stroke is *swept* rather than stamped, in
 * the time the blade actually took to pass. At the pace a rite runs this is
 * about eighty milliseconds, which is far too fast to read consciously and
 * exactly slow enough to feel.
 *
 * ## The frame a stroke lives in
 *
 * The instance matrix carries the **pivot** of the swing — the shoulder the arc
 * turns about, which is a radius behind the point of contact — with local X on
 * the radius through the contact, local Y along the travel and local Z on the
 * axis of the sweep. Scale is the radius, so the geometry is a unit arc and the
 * same buffer serves a wrist flick and a two-metre tear-out.
 *
 * `pitch` shears that circle into one shallow turn of a helix, because a real
 * sweep also goes *forward*: a stroke that closes perfectly on its own circle
 * is a hoop seen edge-on, and the third-person camera looks down on all of it.
 */
export class SlashTrails {
  constructor() {
    // A unit parameter domain in [0,1]²; every metre of the stroke is put there
    // by the vertex shader. The same idiom `vfx/SlashWave.js` uses, and for the
    // same reason: the geometry is never rebuilt for a different size.
    const geometry = new PlaneGeometry(1, 1, SEGMENTS_U, SEGMENTS_V).translate(0.5, 0.5, 0);
    geometry.setAttribute('aAge', new InstancedBufferAttribute(new Float32Array(CAPACITY), 1));
    geometry.setAttribute('aSeed', new InstancedBufferAttribute(new Float32Array(CAPACITY), 1));
    geometry.setAttribute('aSweep', new InstancedBufferAttribute(new Float32Array(CAPACITY), 1));
    geometry.setAttribute('aWidth', new InstancedBufferAttribute(new Float32Array(CAPACITY), 1));
    geometry.setAttribute('aPitch', new InstancedBufferAttribute(new Float32Array(CAPACITY), 1));
    geometry.setAttribute(
      'aStrength',
      new InstancedBufferAttribute(new Float32Array(CAPACITY), 1)
    );

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      // Tested, so a stroke struck on the far side of a body is behind it. The
      // blades pass *through* the mark, and half the reason the move reads as
      // three-dimensional is that half of each stroke is occluded.
      depthTest: true,
      // A sheet with no thickness, and the lens goes round it.
      side: DoubleSide,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uCoreColor: { value: makeColor('#ffe3d8') },
        uColor: { value: makeColor('#ff1f2d') },
        uEdgeColor: { value: makeColor('#4a0308') },
        uIntensity: { value: 2.4 },
        /** Where the white line sits across the stroke, and how wide it is. */
        uRazor: { value: 0.84 },
        uRazorWidth: { value: 0.1 },
        uCore: { value: 1.5 },
        /** How hard the body falls away from the razor toward the tail. */
        uFalloff: { value: 2.1 },
        /** How pointed the ends are. Higher is a finer needle. */
        uTip: { value: 0.55 },
        /** Fraction of life the stroke is still being swept for. */
        uDraw: { value: 0.16 },
        uHeadSoft: { value: 0.09 },
        uHeadFlare: { value: 2.2 },
        /** The tearing: how fine the pieces are, how fast, how much of it. */
        uDetail: { value: 3.6 },
        uFlow: { value: 1.3 },
        uTear: { value: 0.85 },
        /** Filament splitting along the stroke — the hairs in the reference. */
        uHair: { value: 26.0 },
        uHairDepth: { value: 0.45 },
        uTime: { value: 0 }
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT
    });

    this.mesh = new InstancedMesh(geometry, this.material, CAPACITY);
    this.mesh.name = 'SlashTrails';
    this.mesh.count = 0;
    // Struck wherever a blade happened to be, which is nowhere near the origin
    // the bounding sphere would be built at.
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.VFX);
    // Over the mist and the ground, under the cinders: the stroke is the thing
    // in front, and the specks are in front of it.
    this.mesh.renderOrder = 7;
    this.mesh.raycast = () => {};

    this._ages = geometry.getAttribute('aAge');
    this._seeds = geometry.getAttribute('aSeed');
    this._sweeps = geometry.getAttribute('aSweep');
    this._widths = geometry.getAttribute('aWidth');
    this._pitches = geometry.getAttribute('aPitch');
    this._strengths = geometry.getAttribute('aStrength');

    /** @type {{matrix: Matrix4, age: number, life: number, seed: number, sweep: number, width: number, pitch: number, strength: number}[]} */
    this._strokes = [];
    for (let i = 0; i < CAPACITY; i++) {
      this._strokes.push({
        matrix: new Matrix4(),
        age: 0,
        life: 0,
        seed: 0,
        sweep: 0,
        width: 0,
        pitch: 0,
        strength: 0
      });
    }
    /** How many of the pool are alive, kept packed at the front. */
    this._live = 0;
  }

  /** Whether any stroke is still on screen. */
  get active() {
    return this._live > 0;
  }

  /**
   * Strike one into the air.
   *
   * The arc is described by where it **passes through** rather than by where it
   * turns, because that is the thing the caller actually knows: a blade went
   * through a body at this point, travelling this way. The pivot is resolved
   * from the radius here, so a caller never has to work out where an imaginary
   * shoulder was.
   *
   * `look` and `shape` are deliberately two arguments. Every stroke in one
   * ability has to be made of the same stuff — the same reds, the same razor,
   * the same way of tearing — or the move stops reading as one move. But a
   * thrust and a tear-out are not the same *gesture*: one is a long shallow
   * streak with barely any curve in it, the other a tight violent arc, and they
   * differ in nothing but four numbers. Splitting them here is what lets the
   * editor carry one look and two gestures instead of two of everything.
   *
   * @param {Vector3} at the point of contact the arc sweeps through
   * @param {Vector3} travel unit direction the edge was moving at that point
   * @param {Vector3} axis unit axis the sweep turns about — roughly
   *   perpendicular to `travel`, and the thing that decides whether the stroke
   *   is an overhead chop or a cut across
   * @param {object} look `settings.crimsonRite.trails` — what a stroke is made of
   * @param {{radius: number, sweep: number, width: number, life: number, pitch: number}} shape
   *   what this particular gesture is shaped like
   * @param {number} [strength] master on its brightness, reach and width
   * @param {number} [curve] +1 or -1: which side of the travel the arc bends to
   */
  strike(at, travel, axis, look, shape, strength = 1, curve = 1) {
    if (!look.enabled || strength <= 0) return;

    _travel.copy(travel);
    if (_travel.lengthSq() < 1e-8) return;
    _travel.normalize();

    _axis.copy(axis);
    // Only the part of the axis square to the travel is a rotation axis; the
    // rest of it would tilt the whole circle out of the plane the cut was in.
    _axis.addScaledVector(_travel, -_axis.dot(_travel));
    if (_axis.lengthSq() < 1e-8) return;
    _axis.normalize();

    // The radius through the contact: square to both, and flipped by `curve` so
    // two strokes thrown on one blow can bend away from each other.
    _radial.crossVectors(_travel, _axis).multiplyScalar(curve >= 0 ? 1 : -1);
    if (_radial.lengthSq() < 1e-8) return;
    _radial.normalize();

    const radius = Math.max(0.05, shape.radius * strength);
    // A radius back down the radial from the contact — the shoulder the swing
    // turned about, which is the origin the arc is actually drawn from.
    _pivot.copy(at).addScaledVector(_radial, -radius);

    const stroke = this._claim();
    // Local X on the radius, Y along the travel, Z on the sweep's own axis:
    // the vertex shader draws a unit circle in XY and reads the pitch off Z.
    stroke.matrix.makeBasis(_radial, _travel, _axis);
    stroke.matrix.scale(_scale.set(radius, radius, radius));
    stroke.matrix.setPosition(_pivot);

    stroke.age = 0;
    stroke.life = Math.max(0.05, shape.life);
    stroke.seed = Math.random() * 64;
    stroke.sweep = Math.max(0.1, shape.sweep) * (0.85 + Math.random() * 0.3);
    stroke.width = Math.max(0.01, shape.width) * (0.8 + Math.random() * 0.45);
    // Signed off the curve as well, so a stroke that bends one way leans the
    // same way out of its own plane. Both flipping together is one gesture;
    // only one of them flipping is a stroke that folds back on itself.
    stroke.pitch = shape.pitch * (curve >= 0 ? 1 : -1);
    stroke.strength = strength;
  }

  /**
   * A fan of strokes off one blow.
   *
   * The reference's first panel is never one arc — it is three or four, thrown
   * on slightly different bearings and slightly different radii, overlapping.
   * That is what turns a clean crescent into something violent, and it costs
   * nothing but instances.
   *
   * Each is rolled about the travel by an even share of `spread`, so a fan of
   * three opens symmetrically about the blow's own plane rather than drifting
   * off to one side.
   *
   * @param {Vector3} at the point of contact
   * @param {Vector3} travel unit direction the edge was moving
   * @param {Vector3} axis unit axis the sweep turns about
   * @param {object} look `settings.crimsonRite.trails`
   * @param {{count: number, spread: number, radius: number, sweep: number, width: number, life: number, pitch: number}} shape
   *   the gesture, and how many strokes are in it
   * @param {number} [strength] master, before each stroke's own variation
   */
  fan(at, travel, axis, look, shape, strength = 1) {
    const wanted = Math.min(Math.max(0, Math.round(shape.count)), CAPACITY);
    if (wanted <= 0) return;

    const spread = shape.spread ?? 0;
    for (let i = 0; i < wanted; i++) {
      // -1..1 across the fan, and exactly 0 for a fan of one.
      const offset = wanted > 1 ? (i / (wanted - 1)) * 2 - 1 : 0;
      _fanAxis.copy(axis).applyAxisAngle(_fanTravel.copy(travel).normalize(), offset * spread);
      this.strike(
        at,
        travel,
        _fanAxis,
        look,
        shape,
        // The outer strokes of a fan are the lighter ones: a fan of equals
        // reads as a stack of copies, and the eye wants one of them to be the
        // cut and the others to be its wake.
        strength * (1 - Math.abs(offset) * 0.35),
        i % 2 === 0 ? 1 : -1
      );
    }
  }

  /**
   * @param {number} dt seconds, on the simulation's clock — a stroke is part of
   *   the blow that struck it, so it holds through the hit-stop
   * @param {number} elapsed the shared clock, for the tearing's own crawl
   * @param {object} config `settings.crimsonRite.trails`
   */
  update(dt, elapsed, config) {
    // Compacted rather than spliced: the pool is fixed and the live ones are
    // kept at the front, so a dead stroke costs one swap and never an
    // allocation.
    for (let i = this._live - 1; i >= 0; i--) {
      const stroke = this._strokes[i];
      stroke.age += dt;
      if (stroke.age < stroke.life) continue;
      this._live--;
      if (i !== this._live) {
        this._strokes[i] = this._strokes[this._live];
        this._strokes[this._live] = stroke;
      }
    }

    this.mesh.count = this._live;
    if (!this._live) return;

    const ages = this._ages.array;
    const seeds = this._seeds.array;
    const sweeps = this._sweeps.array;
    const widths = this._widths.array;
    const pitches = this._pitches.array;
    const strengths = this._strengths.array;

    for (let i = 0; i < this._live; i++) {
      const stroke = this._strokes[i];
      this.mesh.setMatrixAt(i, stroke.matrix);
      ages[i] = Math.min(1, stroke.age / stroke.life);
      seeds[i] = stroke.seed;
      sweeps[i] = stroke.sweep;
      widths[i] = stroke.width;
      pitches[i] = stroke.pitch;
      strengths[i] = stroke.strength;
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    this._ages.needsUpdate = true;
    this._seeds.needsUpdate = true;
    this._sweeps.needsUpdate = true;
    this._widths.needsUpdate = true;
    this._pitches.needsUpdate = true;
    this._strengths.needsUpdate = true;

    const u = this.material.uniforms;
    u.uTime.value = elapsed;
    copyColor(u.uCoreColor.value, config.coreColor);
    copyColor(u.uColor.value, config.color);
    copyColor(u.uEdgeColor.value, config.edgeColor);
    u.uIntensity.value = config.intensity;
    u.uRazor.value = config.razor;
    u.uRazorWidth.value = Math.max(0.005, config.razorWidth);
    u.uCore.value = config.core;
    u.uFalloff.value = Math.max(0.1, config.falloff);
    u.uTip.value = Math.max(0.05, config.tip);
    u.uDraw.value = Math.min(0.9, Math.max(0.001, config.draw));
    u.uHeadSoft.value = Math.max(0.005, config.headSoft);
    u.uHeadFlare.value = config.headFlare;
    u.uDetail.value = config.detail;
    u.uFlow.value = config.flow;
    u.uTear.value = config.tear;
    u.uHair.value = config.hair;
    u.uHairDepth.value = config.hairDepth;
  }

  /** Every stroke off, immediately — for leaving the stage and for a reset. */
  clear() {
    this._live = 0;
    this.mesh.count = 0;
  }

  dispose() {
    this.clear();
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }

  /**
   * A slot for a new stroke.
   *
   * Full means the oldest goes, not the newest is refused: on the tear-out five
   * strokes are struck on one frame, and dropping the fifth would take a piece
   * out of the fan the player is actually looking at while preserving one that
   * is nearly gone.
   */
  _claim() {
    if (this._live < CAPACITY) return this._strokes[this._live++];

    let oldest = 0;
    let most = -1;
    for (let i = 0; i < CAPACITY; i++) {
      const stroke = this._strokes[i];
      const spent = stroke.life > 0 ? stroke.age / stroke.life : 1;
      if (spent <= most) continue;
      most = spent;
      oldest = i;
    }
    return this._strokes[oldest];
  }
}

/* -------------------------------------------------------------------- */

/**
 * The unit arc, and the shear that stops it being a hoop.
 *
 * `position.x` is `u` along the arc and `position.y` is `v` across it. The
 * circle is drawn in local XY at unit radius (the instance matrix carries the
 * metres), the ribbon is thrown out along its own radius by the width, and the
 * whole thing is sheared down local Z by the pitch so the two tips do not lie
 * in the same plane.
 */
const VERTEX = /* glsl */ `
uniform float uTip;

attribute float aAge;
attribute float aSeed;
attribute float aSweep;
attribute float aWidth;
attribute float aPitch;
attribute float aStrength;

varying vec2 vUv;
varying float vAge;
varying float vSeed;
varying float vStrength;

const float PI = 3.14159265359;

void main() {
  vUv = position.xy;
  vAge = aAge;
  vSeed = aSeed;
  vStrength = aStrength;

  float u = position.x;
  float v = position.y;

  // Both ends close to a point. The same curve the fragment shader fades the
  // stroke out on, so the silhouette and the light agree about where the tip is.
  float taper = pow(max(sin(u * PI), 0.0), uTip);

  float angle = (u - 0.5) * aSweep;
  vec2 ring = vec2(cos(angle), sin(angle));
  // Out along the arc's own radius by the width, which is why the stroke stays
  // the same thickness however far round it goes.
  float offset = (v - 0.5) * aWidth * taper;
  vec3 local = vec3(ring * (1.0 + offset), 0.0);
  // And forward, so the circle is one shallow turn of a helix. A cut that
  // closes on its own circle is a hoop, and from above a hoop is what it reads
  // as; this is the half-metre of travel the body did while the arm came round.
  local.z = aPitch * (u - 0.5);

  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(local, 1.0);
}
`;

/**
 * One stroke: a razor, a body behind it, and the tearing that eats both.
 *
 * The order the terms are built in is the order they matter in. `head` gates
 * everything — nothing exists past the front of the sweep. `tear` then removes
 * what the age has taken, from the tail forward and the tips inward. What is
 * left is coloured by how near it is to the razor.
 */
const FRAGMENT = /* glsl */ `
${noiseGLSL}

uniform vec3 uCoreColor;
uniform vec3 uColor;
uniform vec3 uEdgeColor;
uniform float uIntensity;
uniform float uRazor;
uniform float uRazorWidth;
uniform float uCore;
uniform float uFalloff;
uniform float uTip;
uniform float uDraw;
uniform float uHeadSoft;
uniform float uHeadFlare;
uniform float uDetail;
uniform float uFlow;
uniform float uTear;
uniform float uHair;
uniform float uHairDepth;
uniform float uTime;

varying vec2 vUv;
varying float vAge;
varying float vSeed;
varying float vStrength;

const float PI = 3.14159265359;

void main() {
  float u = vUv.x;
  float v = vUv.y;
  float t = clamp(vAge, 0.0, 1.0);

  /* ---- the sweep, still being drawn ---- */
  // The front runs one tip to the other over the first fraction of the life,
  // and past 1 it simply stops mattering. An outQuad on it, because a blade is
  // quickest through the middle of its arc and slowest at the ends.
  float drawn = clamp(t / uDraw, 0.0, 1.0);
  float head = drawn * (2.0 - drawn);
  float behind = 1.0 - smoothstep(head, head + uHeadSoft, u);
  if (behind <= 0.0) discard;

  /* ---- the shape ---- */
  float taper = pow(max(sin(u * PI), 0.0), uTip);
  if (taper < 0.004) discard;

  // Distance from the razor, in units of the stroke's own half-width. Behind it
  // the body falls away over the whole tail; ahead of it there is only the thin
  // skin that makes the white read as an *edge*.
  float behindRazor = max(0.0, uRazor - v) / max(uRazor, 1e-3);
  float aheadRazor = max(0.0, v - uRazor) / max(1.0 - uRazor, 1e-3);
  float body = pow(1.0 - behindRazor, uFalloff) * (1.0 - aheadRazor * aheadRazor);
  float razor = 1.0 - smoothstep(0.0, uRazorWidth, abs(v - uRazor));

  /* ---- the tearing ---- */
  // Two bands. The coarse one breaks the stroke into pieces; the fine one
  // splits each piece lengthwise into the filaments the reference is full of.
  vec3 p = vec3(u * uDetail * 6.0, v * uDetail * 1.4, vSeed + uTime * uFlow);
  float grain = fbm3(p) * 0.5 + 0.5;
  float hair = snoise01(vec3(u * uHair, v * 2.2, vSeed * 3.1));
  grain = mix(grain, grain * (0.55 + 0.45 * hair), uHairDepth);

  // What the age has eaten. It climbs from nothing to past 1, so a stroke ends
  // as fragments and then as nothing — and it climbs *fastest at the tail and
  // the tips*, which is what makes the stroke come apart from its edges inward
  // rather than dissolving as a sheet.
  float exposure = behindRazor * 0.55 + (1.0 - taper) * 0.45;
  float threshold = t * t * (1.0 + uTear * exposure) * 1.35 - 0.12;
  float intact = smoothstep(threshold, threshold + 0.22, grain);
  if (intact <= 0.002) discard;

  /* ---- the head's own heat ---- */
  // A bloom riding the front while the stroke is still being swept. It is what
  // the eye follows, and it is why the sweep is legible at eighty milliseconds.
  float flare = exp(-pow((u - head) / max(uHeadSoft, 1e-3), 2.0)) * (1.0 - drawn) * uHeadFlare;

  float mask = behind * taper * intact;
  float gain = uIntensity * vStrength;

  vec3 rgb =
    uEdgeColor * body * 0.9 +
    // The crimson carries the stroke. It has to outweigh the white by a good
    // margin or the razor spreads over the whole ribbon and every arc reads as
    // a white wire — which is the one thing the reference's strokes are not.
    uColor * body * body * 2.4 +
    uCoreColor * (razor * uCore + flare);

  // Coverage and brightness kept apart. The blend is SRC_ALPHA, ONE, so the
  // pipe multiplies the colour by the alpha for us — which means an alpha that
  // also carried the gain would apply it *twice* and the stroke would go up as
  // the square of a slider that reads as linear. Alpha is how much of the
  // fragment the stroke covers, and nothing else; the gain lives in the colour,
  // where it is the only term allowed past 1 and so the only thing that blooms.
  float a = clamp((body * 0.85 + razor * 0.7 + flare * 0.6) * mask, 0.0, 1.0);
  if (a < 0.003) discard;

  gl_FragColor = vec4(rgb * gain, a);
}
`;
