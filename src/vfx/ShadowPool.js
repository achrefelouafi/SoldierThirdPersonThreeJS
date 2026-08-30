import { AdditiveBlending, Mesh, PlaneGeometry, ShaderMaterial } from 'three';

import { LAYER } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { terrainGLSL } from '../shaders/lib/terrain.glsl.js';
import { copyColor, makeColor } from '../utils/color.js';

/** Subdivisions of the disc. It is bent onto the height field like the rings are. */
const SEGMENTS = 24;

/**
 * The light the aura is standing in.
 *
 * ## The layer with no shape at all
 *
 * Every other part of this ability is an edge — rings, a column, torn puffs,
 * curling wisps. This one is deliberately the opposite: a soft pool of violet
 * on the floor with nothing in it to read, and its whole job is to be the thing
 * all those edges are seen *against*. Take it out and the effect is a set of
 * dark shapes over dark ground; put it back and there is a light source in the
 * middle of the frame that the shadow is shadow of.
 *
 * It is also the cheapest layer here by an order of magnitude — one disc, one
 * radial falloff — which is worth saying because it is doing more for the read
 * than anything else in the ability.
 *
 * ## Two falloffs, one disc
 *
 * A wide, very soft body in the aura's colour, and a small hard core that runs
 * to white. That pairing is why it reads as a *source* rather than as a painted
 * circle: real pooled light has a hot middle whose falloff is nothing like the
 * falloff of its spill, and one gradient can only ever describe one of those.
 *
 * ## What it owns
 *
 * A mesh and its uniforms. Where it lies and how hard it is burning are told to
 * it once a frame by `vfx/ShadowBoost.js`. It never allocates after
 * construction.
 */
export class ShadowPool {
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
        uColor: { value: makeColor('#6a3cff') },
        uCoreColor: { value: makeColor('#c9b4ff') },
        uIntensity: { value: 1.5 },
        uTime: { value: 0 },
        /** Master, 0..1. */
        uFade: { value: 0 },
        /** 0..1 — decaying, the white left over from the frame it broke through. */
        uFlash: { value: 0 },
        /** How the spill falls off, and how tight the hot middle is. */
        uFalloff: { value: 2.6 },
        uCore: { value: 0.34 },
        uCorePower: { value: 2.2 },
        /** Depth and speed of the breath under it. */
        uPulse: { value: 0.18 },
        uPulseSpeed: { value: 2.2 },
        /** How much the pool is mottled, and how fast the mottling crawls. */
        uMottle: { value: 0.3 },
        uMottleScale: { value: 2.1 },
        uMottleSpeed: { value: 0.22 },
        uLift: { value: 0.03 },
        uSeed: { value: 2.9 }
      },
      vertexShader: VERTEX(terrain),
      fragmentShader: FRAGMENT
    });
    if (terrain) {
      Object.assign(this.material.uniforms, terrain.uniforms);
      this.material.defines.TERRAIN = '';
    }

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'ShadowPool';
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.VFX);
    // The bottom of the ability. Everything else on the floor is drawn over it.
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
    this.mesh.raycast = () => {};
  }

  /**
   * Where it lies, in world space.
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
   * @param {object} config `settings.shadowBoost.glow`
   * @param {object} state
   * @param {number} state.fade master, 0..1
   * @param {number} state.scale multiplier on the radius
   * @param {number} state.flash 0..1, decaying
   * @param {number} elapsed the shared clock
   */
  update(config, { fade = 1, scale = 1, flash = 0 }, elapsed = 0) {
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
    u.uFlash.value = flash;
    u.uFalloff.value = Math.max(0.2, config.falloff);
    u.uCore.value = config.core;
    u.uCorePower.value = Math.max(0.2, config.corePower);
    u.uPulse.value = config.pulse;
    u.uPulseSpeed.value = config.pulseSpeed;
    u.uMottle.value = config.mottle;
    u.uMottleScale.value = Math.max(0.1, config.mottleScale);
    u.uMottleSpeed.value = config.mottleSpeed;
    u.uLift.value = config.lift;
  }

  /** A fresh mottle, for the next cast. */
  reseed() {
    this.material.uniforms.uSeed.value = Math.random() * 64;
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

const FRAGMENT = /* glsl */ `
${noiseGLSL}

uniform vec3 uColor;
uniform vec3 uCoreColor;
uniform float uIntensity;
uniform float uTime;
uniform float uFade;
uniform float uFlash;
uniform float uFalloff;
uniform float uCore;
uniform float uCorePower;
uniform float uPulse;
uniform float uPulseSpeed;
uniform float uMottle;
uniform float uMottleScale;
uniform float uMottleSpeed;
uniform float uSeed;

varying vec2 vUv;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float d = length(p);
  if (d > 1.0) discard;

  // The spill. Raised to a power rather than smoothstepped, so it has no edge
  // anywhere — the one shape in the ability that must not have one.
  float spill = pow(max(0.0, 1.0 - d), uFalloff);
  // And the hot middle, on its own much tighter falloff.
  float core = pow(max(0.0, 1.0 - d / max(0.02, uCore)), uCorePower);

  // Mottled, and crawling: pooled light on rough ground is never even, and a
  // clean gradient standing still for ten seconds is the thing that says decal.
  float mottle = mix(1.0, fbm3(vec3(p * uMottleScale, uSeed + uTime * uMottleSpeed)) * 1.6, uMottle);

  float breath = 1.0 - uPulse * (0.5 - 0.5 * cos(uTime * uPulseSpeed));
  float gain = uIntensity * uFade * breath;

  float body = spill * mottle;
  float hot = core + uFlash * (spill * 1.2 + core * 1.4);

  vec3 rgb = uColor * body + uCoreColor * hot;
  float a = (body + hot) * gain;
  if (a < 0.003) discard;

  // Premultiplied against an additive blend: the alpha is the light.
  gl_FragColor = vec4(rgb * gain, a);
}
`;
