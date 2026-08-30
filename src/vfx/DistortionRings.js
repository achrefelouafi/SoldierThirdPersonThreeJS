import { AdditiveBlending, Mesh, PlaneGeometry, ShaderMaterial } from 'three';

import { LAYER } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { terrainGLSL } from '../shaders/lib/terrain.glsl.js';
import { copyColor, makeColor } from '../utils/color.js';

/**
 * Subdivisions of the disc.
 *
 * It is bent onto the height field, it is five metres across, and its whole
 * read is a set of *concentric circles* — which is the shape that shows a bad
 * conform first. A ring that steps across a slope stops being a ring.
 */
const SEGMENTS = 32;

/**
 * The ground, refusing to lie flat.
 *
 * ## Rings, not a ring
 *
 * Several fronts running outward at once from under the body, each one a thin
 * bright band with a dark trough on its inside edge. That trough is the whole
 * trick: a bright line on the floor is a decal, and a bright line with a shadow
 * behind it is a *ridge* — the ground reads as standing up in rings rather than
 * as being drawn on. It costs one extra `smoothstep`.
 *
 * The fronts are a `fract` of the radius against the clock, so there is no pool
 * and no per-ring state: raising `rings` from three to nine is a uniform, and
 * they run for as long as the aura is up without anything having to be spawned.
 *
 * ## The distortion
 *
 * Every radius is warped by an fbm field before the rings are cut out of it, so
 * a front is a wobbling closed curve instead of a compass circle — the ground
 * is being pushed, and it is not being pushed evenly. The field turns slowly on
 * its own, which is what keeps a standing effect from looking frozen between
 * the fronts.
 *
 * ## What it owns
 *
 * A mesh and its uniforms. Where it lies and how hard it is running are told to
 * it once a frame by `vfx/ShadowBoost.js`. It never allocates after
 * construction.
 */
export class DistortionRings {
  /**
   * @param {object} [options]
   * @param {{uniforms: object}|null} [options.terrain] the height field to lie
   *   on. Without one the disc stays flat at the height it is placed at.
   */
  constructor({ terrain = null } = {}) {
    const segments = terrain ? SEGMENTS : 1;
    const geometry = new PlaneGeometry(1, 1, segments, segments).rotateX(-Math.PI / 2);

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uColor: { value: makeColor('#8b6cff') },
        uCoreColor: { value: makeColor('#e6dcff') },
        uIntensity: { value: 1.6 },
        uTime: { value: 0 },
        /** Master, 0..1 — the whole thing in and out. */
        uFade: { value: 0 },
        /** 0..1 — a shove on the fronts the frame the column comes up. */
        uPunch: { value: 0 },
        uRings: { value: 3 },
        uSpeed: { value: 0.35 },
        uWidth: { value: 0.035 },
        uSoftness: { value: 0.02 },
        /** The soft bloom either side of a front, and how far it carries. */
        uGlow: { value: 0.35 },
        uGlowWidth: { value: 0.16 },
        /** How deep the trough behind each front is, and how far it reaches. */
        uTrough: { value: 0.5 },
        uTroughWidth: { value: 0.12 },
        /** Metres of wobble on a front, and how fine the wobble is. */
        uWarp: { value: 0.055 },
        uWarpScale: { value: 2.6 },
        uWarpSpeed: { value: 0.25 },
        /** Turns a second of the whole field. */
        uSpin: { value: -0.06 },
        uLift: { value: 0.04 },
        uSeed: { value: 5.3 }
      },
      vertexShader: VERTEX(terrain),
      fragmentShader: FRAGMENT
    });
    if (terrain) {
      Object.assign(this.material.uniforms, terrain.uniforms);
      this.material.defines.TERRAIN = '';
    }

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'DistortionRings';
    // It follows a body around the world and irises out of nothing — neither of
    // which a bounding sphere built at the origin survives.
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.VFX);
    // On the floor, over the pool: the rings are what the pool is seen through.
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
    this.mesh.raycast = () => {};
  }

  /**
   * Where it lies. The middle of the rings, in world space.
   *
   * @param {number} x
   * @param {number} y the ground under the body — thrown away when a height
   *   field is bound, and the disc's own height when one is not
   * @param {number} z
   */
  place(x, y, z) {
    this.mesh.position.set(x, y, z);
  }

  /**
   * @param {object} config `settings.shadowBoost.rings`
   * @param {object} state
   * @param {number} state.fade master, 0..1
   * @param {number} state.scale multiplier on the radius, so it can iris out
   * @param {number} state.punch 0..1, decaying — the shove on arrival
   * @param {number} elapsed the shared clock
   */
  update(config, { fade = 1, scale = 1, punch = 0 }, elapsed = 0) {
    this.mesh.visible = fade > 0.001 && scale > 0.001;
    if (!this.mesh.visible) return;

    const radius = Math.max(0.05, config.radius) * scale;
    this.mesh.scale.set(radius * 2, 1, radius * 2);

    const u = this.material.uniforms;
    copyColor(u.uColor.value, config.color);
    copyColor(u.uCoreColor.value, config.coreColor);
    u.uIntensity.value = config.intensity;
    u.uTime.value = elapsed;
    u.uFade.value = fade;
    u.uPunch.value = punch;
    u.uRings.value = Math.max(1, Math.round(config.rings));
    u.uSpeed.value = config.speed;
    u.uWidth.value = Math.max(0.002, config.width);
    u.uSoftness.value = Math.max(0.002, config.softness);
    u.uGlow.value = config.glow;
    u.uGlowWidth.value = Math.max(0.005, config.glowWidth);
    u.uTrough.value = config.trough;
    u.uTroughWidth.value = Math.max(0.005, config.troughWidth);
    u.uWarp.value = config.warp;
    u.uWarpScale.value = Math.max(0.1, config.warpScale);
    u.uWarpSpeed.value = config.warpSpeed;
    u.uSpin.value = config.spin;
    u.uLift.value = config.lift;
  }

  /** A fresh warp field, for the next cast. */
  reseed() {
    this.material.uniforms.uSeed.value = Math.random() * 96;
  }

  /** Off, immediately. */
  clear() {
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
 * The fronts.
 *
 * `fract(d*rings - t*speed)` is the whole cycle: a sawtooth in the radius that
 * puts `rings` fronts on the disc and moves all of them outward at once. Each
 * front is drawn twice — a hot band, and a dark trough a little inside it —
 * and the pair is what turns a drawn circle into a raised one.
 *
 * The dark half is subtracted from an additive blend, so it can only ever take
 * the effect's *own* light back out and never dig a hole in the floor behind
 * it. That is a real limit and it is the right one: a ground effect that could
 * darken the world would need its own pass.
 */
const FRAGMENT = /* glsl */ `
${noiseGLSL}

uniform vec3 uColor;
uniform vec3 uCoreColor;
uniform float uIntensity;
uniform float uTime;
uniform float uFade;
uniform float uPunch;
uniform float uRings;
uniform float uSpeed;
uniform float uWidth;
uniform float uSoftness;
uniform float uGlow;
uniform float uGlowWidth;
uniform float uTrough;
uniform float uTroughWidth;
uniform float uWarp;
uniform float uWarpScale;
uniform float uWarpSpeed;
uniform float uSpin;
uniform float uSeed;

varying vec2 vUv;

const float TAU = 6.28318530718;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float d = length(p);
  if (d > 1.0) discard;

  float turn = atan(p.y, p.x) + uTime * uSpin * TAU;

  /* ---- the ground is not even ---- */
  // The radius is warped before anything is cut out of it, so every front is a
  // wobbling closed curve rather than a compass circle.
  float warp = snoise(vec3(
    cos(turn) * uWarpScale,
    sin(turn) * uWarpScale,
    uSeed + uTime * uWarpSpeed
  )) * uWarp;
  float r = clamp(d + warp * d, 0.0, 1.4);

  /* ---- the fronts ---- */
  // A sawtooth in the radius: uRings of them, all running outward together,
  // and hurried along for a moment by the arrival.
  float travel = uTime * uSpeed * (1.0 + uPunch * 2.2);
  float cell = fract(r * uRings - travel);
  // Distance to the nearest front, either side of it. Measuring symmetrically
  // is what lets the band and its bloom straddle the line instead of hanging
  // off one shoulder of it.
  float dist = min(cell, 1.0 - cell);

  float band = 1.0 - smoothstep(uWidth, uWidth + uSoftness, dist);
  // The bloom around the line. In the reference the rings are not hairlines —
  // they are lit, and they carry a soft halo into the floor either side.
  float halo = pow(max(0.0, 1.0 - dist / uGlowWidth), 2.0) * uGlow;
  // And the trough, on the *inside* of each front only, starting where the
  // bright band ends. This is what stands a drawn circle up off the floor: a
  // line with a shadow behind it is a ridge, and one without is a decal.
  float trough =
    step(0.5, cell) *
    smoothstep(uWidth, uWidth + uSoftness, dist) *
    (1.0 - smoothstep(uTroughWidth, uTroughWidth + uSoftness * 3.0, dist)) *
    uTrough;

  // Thinner and fainter as they run out of room, and never touching the rim of
  // the disc — a front that reached the edge would end on a hard circle.
  float reach = (1.0 - smoothstep(0.4, 0.95, d)) * smoothstep(0.02, 0.16, d);

  /* ---- the floor between them ---- */
  // A wash of mottled violet, so the ground inside the aura is stained rather
  // than being clean between the rings.
  float stain = fbm3(vec3(p * 2.4, uSeed + uTime * 0.18));
  float wash = (1.0 - smoothstep(0.1, 1.0, d)) * mix(0.06, 0.2, stain);

  float gain = uIntensity * uFade;
  float lightBand = band * reach;
  float light = lightBand + halo * reach + wash;

  // The line itself runs to white and its bloom stays the aura's violet, which
  // is the whole reason it reads as *lit* rather than as a coloured stroke.
  vec3 rgb = uColor * light + uCoreColor * lightBand * 0.5;
  float a = (light + lightBand * 0.5) * gain;

  // The trough only ever takes the effect's own light back out. On an additive
  // blend it cannot dig into the floor behind it, and it must not try.
  float dark = trough * reach * gain;
  rgb = max(vec3(0.0), rgb * gain - dark * 0.9);
  a = max(0.0, a - dark);
  if (a < 0.003) discard;

  // Premultiplied against an additive blend: the alpha is the light.
  gl_FragColor = vec4(rgb, a);
}
`;
