import { AdditiveBlending, Mesh, PlaneGeometry, ShaderMaterial } from 'three';

import { LAYER } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { terrainGLSL } from '../shaders/lib/terrain.glsl.js';
import { copyColor, makeColor } from '../utils/color.js';

/**
 * Subdivisions of the disc.
 *
 * It is bent onto the height field like the shock ring is, and it is wider than
 * that ring — a burst laid flat at one height would be buried on the uphill
 * side of anything the player is standing on.
 */
const SEGMENTS = 28;

/**
 * The flash the moment the light arrives.
 *
 * One disc lying on the ground, and three things on it that are all the same
 * event:
 *
 *  - the **petals** — radial spikes of white racing outward, each a different
 *    length and width, tapering to a point. This is the shape of the burst and
 *    the thing that reads at a glance: a ring says "a wave", a fan of spikes
 *    says "something *arrived*".
 *  - the **core** — a hot disc in the middle, collapsing faster than everything
 *    else, so the first two frames are a white hole and the rest is a fan.
 *  - the **ring** — a thin front at the outside of the petals, thinning as it
 *    spreads. It is what stops the fan reading as a decal: the spikes have an
 *    edge and the edge is moving.
 *
 * ## One burst at a time, on purpose
 *
 * Unlike `vfx/ShockRing.js` there is no pool here. The ability that owns this
 * fires it twice — once when the light lands and once, smaller, when the boon
 * runs out — and those are ten seconds apart. A pool would be four times the
 * buffer for a case that cannot happen.
 *
 * ## What it owns
 *
 * A clock and a strength. `burst()` restarts it, `update()` ages it, and it
 * takes itself off screen when it is spent.
 */
export class ManifestBurst {
  /**
   * @param {object} [options]
   * @param {{uniforms: object}|null} [options.terrain] the height field to lie
   *   on. Without one the disc stays flat at the height it was fired at.
   */
  constructor({ terrain = null } = {}) {
    const geometry = new PlaneGeometry(1, 1, SEGMENTS, SEGMENTS).rotateX(-Math.PI / 2);

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uColor: { value: makeColor('#ffc65c') },
        uCoreColor: { value: makeColor('#fffdf4') },
        uIntensity: { value: 2.6 },
        /** 0..1 through this burst's life. */
        uAge: { value: 1 },
        /** Master on brightness and reach, so the two bursts differ in size. */
        uStrength: { value: 1 },
        uPetals: { value: 14 },
        uPetalWidth: { value: 0.09 },
        uPetalLength: { value: 0.9 },
        uRingWidth: { value: 0.05 },
        uSoftness: { value: 0.1 },
        uCore: { value: 1.6 },
        uLift: { value: 0.05 },
        uSeed: { value: 3.7 }
      },
      vertexShader: VERTEX(terrain),
      fragmentShader: FRAGMENT
    });
    if (terrain) {
      Object.assign(this.material.uniforms, terrain.uniforms);
      this.material.defines.TERRAIN = '';
    }

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'ManifestBurst';
    // Fired wherever the body is standing, which is nowhere near the origin the
    // bounding sphere would be built at.
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.VFX);
    // The newest thing on the floor, and the one that should win wherever it
    // overlaps the sigil and the target rings.
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
    this.mesh.raycast = () => {};

    this._age = 0;
    this._life = 0;
    this._radius = 0;
  }

  /** Whether anything is still burning. */
  get active() {
    return this._life > 0;
  }

  /**
   * Open one, here.
   *
   * @param {number} x world
   * @param {number} y the ground there — thrown away when a height field is
   *   bound, and the disc's own height when one is not
   * @param {number} z
   * @param {object} config `settings.ascendance.burst`
   * @param {number} [strength] master on this one burst's reach and brightness
   */
  burst(x, y, z, config, strength = 1) {
    if (strength <= 0) return;
    this.mesh.position.set(x, y, z);
    this._age = 0;
    this._life = Math.max(0.05, config.life);
    this._radius = Math.max(0.2, config.radius) * strength;
    this.material.uniforms.uStrength.value = strength;
    this.material.uniforms.uSeed.value = Math.random() * 64;
  }

  /**
   * @param {number} dt seconds, on the simulation's clock
   * @param {object} config `settings.ascendance.burst`
   */
  update(dt, config) {
    if (this._life <= 0) {
      this.mesh.visible = false;
      return;
    }

    this._age += dt;
    if (this._age >= this._life) {
      this._life = 0;
      this.mesh.visible = false;
      return;
    }

    this.mesh.visible = true;
    this.mesh.scale.set(this._radius * 2, 1, this._radius * 2);

    const u = this.material.uniforms;
    u.uAge.value = this._age / this._life;
    copyColor(u.uColor.value, config.color);
    copyColor(u.uCoreColor.value, config.coreColor);
    u.uIntensity.value = config.intensity;
    u.uPetals.value = Math.max(1, Math.round(config.petals));
    u.uPetalWidth.value = Math.max(0.002, config.petalWidth);
    u.uPetalLength.value = config.petalLength;
    u.uRingWidth.value = Math.max(0.004, config.ringWidth);
    u.uSoftness.value = Math.max(0.004, config.softness);
    u.uCore.value = config.core;
    u.uLift.value = config.lift;
  }

  /** Off, immediately. */
  clear() {
    this._life = 0;
    this.mesh.visible = false;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/* -------------------------------------------------------------------- */

const VERTEX = (terrain) => /* glsl */ `
uniform float uLift;
varying vec2 vUv;
${terrain ? terrainGLSL : ''}

void main() {
  vUv = uv;

  vec4 world = modelMatrix * vec4(position, 1.0);
  #ifdef TERRAIN
    world.y = terrainHeightAt(world.xz) + uLift;
  #else
    world.y += uLift;
  #endif

  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * The fan.
 *
 * `front` is on an `outQuint` — out very fast, then almost stopped. A burst is
 * not a wave: nearly all of its travel happens in the first fifth of its life,
 * and the rest of the time is it cooling where it got to. A linear front reads
 * as an expanding circle; this reads as a detonation.
 */
const FRAGMENT = /* glsl */ `
${noiseGLSL}

uniform vec3 uColor;
uniform vec3 uCoreColor;
uniform float uIntensity;
uniform float uAge;
uniform float uStrength;
uniform float uPetals;
uniform float uPetalWidth;
uniform float uPetalLength;
uniform float uRingWidth;
uniform float uSoftness;
uniform float uCore;
uniform float uSeed;

varying vec2 vUv;

const float TAU = 6.28318530718;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float d = length(p);
  if (d > 1.0) discard;

  float t = clamp(uAge, 0.0, 1.0);
  float inv = 1.0 - t;
  // Almost all of the travel in the first moments, then it hangs.
  float front = 1.0 - inv * inv * inv * inv * inv;
  float turn = fract(atan(p.y, p.x) / TAU);

  /* ---- the petals ---- */
  float petals = 0.0;
  {
    float cell = turn * uPetals + uSeed;
    float index = floor(cell);
    float h = hash11(index + uSeed * 5.0);
    float h2 = hash11(index * 2.7 + uSeed);

    // No two the same length, and none of them the whole radius: a fan of
    // equal spikes is a starburst clip-art, and the unevenness is the effect.
    float reach = mix(0.42, 1.0, h) * uPetalLength * front;
    // Tapering to a point, and held to a width in radius units rather than in
    // angle — otherwise every spike is a wedge.
    float taper = 1.0 - smoothstep(0.0, reach, d);
    float halfW = (uPetalWidth * mix(0.6, 1.25, h2) * taper) / max(d, 0.035) / TAU * uPetals;
    float spike = 1.0 - smoothstep(halfW, halfW + uSoftness * 0.5, abs(fract(cell) - 0.5));
    petals = spike * step(d, reach) * taper;
    // Long-lived enough to be seen, gone before the ring is.
    petals *= pow(inv, 2.2);
  }

  /* ---- the front ---- */
  float w = uRingWidth * mix(1.5, 0.5, front);
  float ring = 1.0 - smoothstep(w, w + uSoftness, abs(d - front));
  ring *= inv * inv / (0.4 + front);

  /* ---- the core ---- */
  // Collapsing far faster than anything else, so the first frames are a hole in
  // the ground and everything after them is a fan.
  float core = (1.0 - smoothstep(0.0, 0.22 + 0.3 * front, d)) * pow(inv, 5.0) * uCore;
  // And a wash under the whole thing, which is what stops the middle of the
  // burst looking empty between the core dying and the petals fading.
  float wash = (1.0 - smoothstep(0.0, front, d)) * pow(inv, 3.0) * 0.35;

  float gain = uIntensity * uStrength;
  vec3 rgb = uColor * (ring + wash) + uCoreColor * (petals + core);
  float a = (ring + wash + petals + core) * gain;
  if (a < 0.003) discard;

  // Premultiplied against an additive blend: the alpha is the light.
  gl_FragColor = vec4(rgb * gain, a);
}
`;
