import {
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial
} from 'three';

import { LAYER } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { terrainGLSL } from '../shaders/lib/terrain.glsl.js';
import { copyColor, makeColor } from '../utils/color.js';

/**
 * Bursts running at once.
 *
 * One per stab and one on the tear-out is four, and the tear-out's own is still
 * spreading while the ground under it is still glowing from the third stab.
 */
const CAPACITY = 6;

/**
 * Subdivisions of one burst's quad.
 *
 * It is bent onto the height field per vertex and it is eight metres across,
 * over ground that can have a whole shoulder of a hill in it. The same count
 * `vfx/ShockRing.js` settled on, for the same reason: below it the disc cuts
 * into slopes.
 */
const SEGMENTS = 24;

const _matrix = /* @__PURE__ */ new Matrix4();

/**
 * The floor, under something being taken apart on it.
 *
 * ## What the reference actually shows
 *
 * Not *a* shockwave — **four of them**, concentric, at four different radii, all
 * on screen at once, with the ground between them split into radial cracks that
 * glow along their floors, and the whole disc scorched dark. That is a very
 * specific picture and it is not what one expanding ring looks like: a single
 * front says "something landed", and a stack of them says "something is *still
 * happening* here", which is the difference between an impact and a rite.
 *
 * So a burst here is a **train**. Each ring is launched a fixed fraction of the
 * life after the one before it and travels the same curve — out fast, then
 * slowing — so at any instant there are several fronts at several radii, evenly
 * spaced in time and therefore unevenly spaced in distance, which is exactly
 * how ripples space themselves. Nothing about it is a stack of copies.
 *
 * ## Dark and bright out of one material
 *
 * The disc has to do two opposite things: the rings and the cracks **add** light
 * to the frame, and the scorch **takes it away**. An additive material can only
 * do the first, and an alpha-blended one can only do the second.
 *
 * Premultiplied alpha does both. The shader outputs `rgb * a` into a
 * `ONE, ONE_MINUS_SRC_ALPHA` pipe, so a fragment can be near-black at high
 * alpha (the burn, which hides the grass) or very bright at low alpha (a front,
 * which is light lying on it). One draw call, one sort, and the ground is
 * genuinely charred rather than tinted.
 *
 * ## Why it is bent rather than placed
 *
 * The quad is subdivided and every vertex is dropped onto the height field
 * (`shaders/lib/terrain.glsl.js`), exactly as `vfx/ShockRing.js` and
 * `vfx/TargetRings.js` do it. An eight-metre disc laid flat at the mark's own
 * height is buried on the uphill side and floating on the downhill one, which
 * is the one thing that gives a ground effect away immediately.
 */
export class RiteRings {
  /**
   * @param {object} [options]
   * @param {{uniforms: object}|null} [options.terrain] the height field to lie
   *   on. Without one the disc stays flat at the height it was born at.
   */
  constructor({ terrain = null } = {}) {
    this.terrain = terrain;

    const geometry = new PlaneGeometry(1, 1, SEGMENTS, SEGMENTS).rotateX(-Math.PI / 2);
    geometry.setAttribute('aAge', new InstancedBufferAttribute(new Float32Array(CAPACITY), 1));
    geometry.setAttribute('aSeed', new InstancedBufferAttribute(new Float32Array(CAPACITY), 1));
    geometry.setAttribute(
      'aStrength',
      new InstancedBufferAttribute(new Float32Array(CAPACITY), 1)
    );

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
      // The scorch has to be able to hide the ground it is on. See the note.
      premultipliedAlpha: true,
      fog: false,
      toneMapped: false,
      uniforms: {
        uColor: { value: makeColor('#ff2a20') },
        uCoreColor: { value: makeColor('#ffd8c8') },
        uCrackColor: { value: makeColor('#ff5a1e') },
        uScorchColor: { value: makeColor('#0a0305') },
        uIntensity: { value: 2.2 },
        /** How many fronts are in the train, and how far apart they are launched. */
        uRings: { value: 4 },
        uRingGap: { value: 0.11 },
        /** How much less far each ring gets than the one before it. */
        uRingReach: { value: 0.88 },
        uWidth: { value: 0.035 },
        uSoftness: { value: 0.045 },
        uCracks: { value: 14 },
        uCrackLength: { value: 0.8 },
        uCrackWidth: { value: 0.016 },
        uCrackGlow: { value: 1.6 },
        /** The burn: how dark, how far out it reaches, how long it stays. */
        uScorch: { value: 0.7 },
        uScorchRadius: { value: 0.62 },
        uScorchFade: { value: 0.35 },
        uLift: { value: 0.035 }
      },
      vertexShader: VERTEX(terrain),
      fragmentShader: FRAGMENT
    });
    if (terrain) {
      Object.assign(this.material.uniforms, terrain.uniforms);
      this.material.defines.TERRAIN = '';
    }

    this.mesh = new InstancedMesh(geometry, this.material, CAPACITY);
    this.mesh.name = 'RiteRings';
    this.mesh.count = 0;
    // Born wherever the mark was standing, nowhere near the origin the bounding
    // sphere would be built at.
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.VFX);
    // The lowest layer of the ability, and above the target rings it covers.
    this.mesh.renderOrder = 4;
    this.mesh.raycast = () => {};

    this._ages = geometry.getAttribute('aAge');
    this._seeds = geometry.getAttribute('aSeed');
    this._strengths = geometry.getAttribute('aStrength');

    /** @type {{x: number, z: number, radius: number, life: number, age: number, seed: number, strength: number}[]} */
    this._bursts = [];
  }

  /** Whether any disc is still on the floor. */
  get active() {
    return this._bursts.length > 0;
  }

  /**
   * Open one, here.
   *
   * @param {number} x world
   * @param {number} z
   * @param {object} config `settings.crimsonRite.rings`
   * @param {number} [strength] master on this burst's reach and brightness
   */
  burst(x, z, config, strength = 1) {
    if (!config.enabled || strength <= 0) return;

    // The oldest goes rather than the newest being dropped: a disc that has
    // nearly burned out is the one nobody is looking at.
    if (this._bursts.length >= CAPACITY) this._bursts.shift();
    this._bursts.push({
      x,
      z,
      radius: Math.max(0.2, config.radius) * strength,
      life: Math.max(0.05, config.life),
      age: 0,
      seed: Math.random() * 64,
      strength
    });
  }

  /**
   * @param {number} dt seconds, on the simulation's clock — a burst belongs to
   *   the blow that opened it, so it holds through the hit-stop
   * @param {object} config `settings.crimsonRite.rings`
   */
  update(dt, config) {
    for (let i = this._bursts.length - 1; i >= 0; i--) {
      const burst = this._bursts[i];
      burst.age += dt;
      if (burst.age >= burst.life) this._bursts.splice(i, 1);
    }

    const count = this._bursts.length;
    this.mesh.count = count;
    if (!count) return;

    const ages = this._ages.array;
    const seeds = this._seeds.array;
    const strengths = this._strengths.array;

    for (let i = 0; i < count; i++) {
      const burst = this._bursts[i];
      // The Y is thrown away in the shader, which resolves it off the height
      // field — this only says where on the ground and how far it reaches.
      _matrix.makeScale(burst.radius * 2, 1, burst.radius * 2);
      _matrix.setPosition(burst.x, 0, burst.z);
      this.mesh.setMatrixAt(i, _matrix);
      ages[i] = Math.min(1, burst.age / burst.life);
      seeds[i] = burst.seed;
      strengths[i] = burst.strength;
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    this._ages.needsUpdate = true;
    this._seeds.needsUpdate = true;
    this._strengths.needsUpdate = true;

    const u = this.material.uniforms;
    copyColor(u.uColor.value, config.color);
    copyColor(u.uCoreColor.value, config.coreColor);
    copyColor(u.uCrackColor.value, config.crackColor);
    copyColor(u.uScorchColor.value, config.scorchColor);
    u.uIntensity.value = config.intensity;
    u.uRings.value = Math.max(1, Math.round(config.rings));
    u.uRingGap.value = Math.max(0.01, config.ringGap);
    u.uRingReach.value = config.ringReach;
    u.uWidth.value = Math.max(0.004, config.width);
    u.uSoftness.value = Math.max(0.004, config.softness);
    u.uCracks.value = Math.max(0, Math.round(config.cracks));
    u.uCrackLength.value = config.crackLength;
    u.uCrackWidth.value = Math.max(0.001, config.crackWidth);
    u.uCrackGlow.value = config.crackGlow;
    u.uScorch.value = config.scorch;
    u.uScorchRadius.value = Math.max(0.05, config.scorchRadius);
    u.uScorchFade.value = Math.max(0.01, config.scorchFade);
    u.uLift.value = config.lift;
  }

  /** Every disc off, immediately — for leaving the stage and for a reset. */
  clear() {
    this._bursts.length = 0;
    this.mesh.count = 0;
  }

  dispose() {
    this.clear();
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}

/* -------------------------------------------------------------------- */

const VERTEX = (terrain) => /* glsl */ `
uniform float uLift;
attribute float aAge;
attribute float aSeed;
attribute float aStrength;
varying vec2 vUv;
varying float vAge;
varying float vSeed;
varying float vStrength;
${terrain ? terrainGLSL : ''}

void main() {
  vUv = uv;
  vAge = aAge;
  vSeed = aSeed;
  vStrength = aStrength;

  // The instance carries where the mark stood and how far the disc reaches; the
  // height comes from the field itself, per vertex, so an eight-metre burst
  // runs over a slope instead of being buried in it.
  vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
  #ifdef TERRAIN
    world.y = terrainHeightAt(world.xz) + uLift;
  #else
    world.y += uLift;
  #endif

  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * The train of fronts, the cracks between them, and the burn under all of it.
 *
 * Read it in that order, because that is the order the terms depend on each
 * other: a crack only exists where a front has already passed, and the burn
 * only exists where the cracks are.
 */
const FRAGMENT = /* glsl */ `
${noiseGLSL}

uniform vec3 uColor;
uniform vec3 uCoreColor;
uniform vec3 uCrackColor;
uniform vec3 uScorchColor;
uniform float uIntensity;
uniform float uRings;
uniform float uRingGap;
uniform float uRingReach;
uniform float uWidth;
uniform float uSoftness;
uniform float uCracks;
uniform float uCrackLength;
uniform float uCrackWidth;
uniform float uCrackGlow;
uniform float uScorch;
uniform float uScorchRadius;
uniform float uScorchFade;

varying vec2 vUv;
varying float vAge;
varying float vSeed;
varying float vStrength;

const float TAU = 6.28318530718;
/** GLSL ES 1.00 wants a constant bound; uRings breaks out of the loop early. */
const int MAX_RINGS = 6;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float d = length(p);
  if (d > 1.0) discard;

  float t = clamp(vAge, 0.0, 1.0);
  float turn = fract(atan(p.y, p.x) / TAU);

  /* ---- the train of fronts ---- */
  float rings = 0.0;
  /** How far the *leading* front has got — everything else is measured on it. */
  float lead = 0.0;

  for (int i = 0; i < MAX_RINGS; i++) {
    float fi = float(i);
    if (fi >= uRings) break;

    // Launched a gap apart and each given the rest of the life to run, so the
    // later ones are slower as well as later — which is what stops the train
    // reading as one ring smeared into several.
    float start = fi * uRingGap;
    float span = max(1e-3, 1.0 - start);
    float ti = clamp((t - start) / span, 0.0, 1.0);
    if (ti <= 0.0) continue;

    // Out fast, then slowing. A linear front is a growing circle; this is
    // something spreading through a material.
    float front = (1.0 - (1.0 - ti) * (1.0 - ti)) * pow(uRingReach, fi);
    lead = max(lead, front);

    // Thinning and dimming as it spreads: the same energy carried by an ever
    // longer circumference. Without it a ring at eight metres is as bright as
    // it was at one, and the whole train reads as a decal growing.
    float w = uWidth * mix(1.5, 0.5, ti);
    float ring = 1.0 - smoothstep(w, w + uSoftness, abs(d - front));
    // Chewed round its circumference so it is a shock rather than a hoop drawn
    // with a compass. The offset per ring keeps neighbours from agreeing.
    float bite = 0.72 + 0.28 * snoise01(vec3(turn * 9.0, fi * 4.3, vSeed));
    // Bounded, and deliberately: an unbounded 1/(radius) term is *physically*
    // the right way to conserve a front's energy as its circumference grows,
    // and it is a disaster here — near the middle it multiplies four
    // overlapping fronts by two and a half each, the sum leaves the [0,1] the
    // composite below is built on, and the whole disc blooms into a white
    // plate. A plain fade to a little under half does the same job for the eye.
    rings += ring * bite * (1.0 - ti) * mix(1.0, 0.45, front);
  }
  rings = min(rings, 1.4);

  /* ---- the cracks the fronts opened ---- */
  float crack = 0.0;
  if (uCracks > 0.5 && uCrackGlow > 0.0) {
    float cell = turn * uCracks + vSeed;
    float index = floor(cell);
    float h = hash11(index + vSeed * 7.0);
    float len = mix(0.28, 1.0, h) * uCrackLength;

    // The wobble. A crack running straight out from the middle is a spoke; this
    // pushes it off its own bearing by an amount that wanders with the radius,
    // which is what makes it read as something that tore rather than was drawn.
    float wobble = snoise(vec3(d * 5.2, index * 3.7, vSeed)) * 0.19;
    float off = fract(cell) - 0.5 + wobble;

    // Held to a constant width in *metres* along its length rather than in
    // angle, and tapering to a point at its far end.
    //
    // The cap is not decoration. Holding a width in metres inside an angular
    // parameterisation means dividing by the radius, and that division runs
    // away toward the middle — by half a metre out, one crack is already wider
    // than the whole cell it lives in, every crack overlaps its neighbours, and
    // the disc fills solid orange. It is a filled plate rather than a set of
    // splits, and it is the single most convincing way to make a ground effect
    // look like a decal. Capped, the cracks merge into a small blot at the
    // centre — which is exactly what splits radiating from one point do.
    float taper = 1.0 - smoothstep(0.0, len, d);
    float halfW = min((uCrackWidth * taper) / max(d, 0.06) / TAU * uCracks, 0.09);
    crack = 1.0 - smoothstep(halfW, halfW + halfW + 0.004, abs(off));
    // Opened by the leading front on its way past, never ahead of it.
    crack *= (1.0 - smoothstep(lead - 0.2, lead, d)) * step(0.06, d) * step(d, len);
    // And cooling slower than the fronts do, so the floor is still lit after
    // the shock itself has gone.
    crack *= uCrackGlow * pow(1.0 - t, 1.5);
  }

  /* ---- what is left of the first instant ---- */
  // Kept at a strength the composite can hold: this term is a *coverage* below,
  // so anything past 1 is a white disc sitting at the middle of the burst for
  // as long as the power takes to fall, rather than the instant of heat it is
  // supposed to be.
  float flash = (1.0 - smoothstep(0.0, 0.22, d)) * pow(1.0 - t, 5.0) * 1.2;

  /* ---- and the burn under all of it ---- */
  // Ragged rather than a disc, and it arrives with the first front rather than
  // being there from the start: the ground is charred *by* the rite.
  float scorchGrain = fbm3(vec3(p * 3.1, vSeed * 11.0)) * 0.5 + 0.5;
  float scorch =
    (1.0 - smoothstep(uScorchRadius * (0.55 + 0.45 * scorchGrain), uScorchRadius * 1.25, d)) *
    smoothstep(0.0, 0.18, t) *
    (1.0 - smoothstep(1.0 - uScorchFade, 1.0, t)) *
    uScorch;

  /* ---- the composite ---- */
  // Coverage and brightness are kept strictly apart, and that separation is the
  // whole reason this reads as a floor rather than as a lamp. Each element says
  // how much of the fragment it *covers* — a number that stays inside 0..1 —
  // and then contributes colour scaled by its own coverage and by the gain,
  // which is the only term allowed past 1 and so the only thing that blooms.
  //
  // Letting coverage carry brightness instead is what blew the disc out to a
  // white plate: four overlapping fronts summed well past 1, the alpha clamped
  // there, and the colour went on climbing with nothing left to hold it.
  float gain = uIntensity * vStrength;
  float aRings = clamp(rings, 0.0, 1.0);
  float aCrack = clamp(crack, 0.0, 1.0);
  float aFlash = clamp(flash, 0.0, 1.0);
  float aScorch = clamp(scorch, 0.0, 1.0);
  float lit = max(max(aRings, aCrack), aFlash);

  // The burn is underneath and the light lies on top of it: a front crossing
  // charred ground is *on* it, not behind it.
  float a = clamp(aScorch + (1.0 - aScorch) * lit, 0.0, 1.0);
  if (a < 0.004) discard;

  vec3 rgb =
    uScorchColor * aScorch * (1.0 - lit) +
    uColor * aRings * gain +
    uCrackColor * aCrack * gain +
    uCoreColor * aFlash * gain;

  // Already premultiplied — every term above is scaled by its own coverage —
  // into a ONE, ONE_MINUS_SRC_ALPHA pipe. Bright at low alpha is light lying on
  // the floor; dark at high alpha is floor that is no longer there.
  gl_FragColor = vec4(rgb, a);
}
`;
