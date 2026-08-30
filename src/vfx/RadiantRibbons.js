import {
  AdditiveBlending,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  ShaderMaterial
} from 'three';

import { LAYER } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { copyColor, makeColor } from '../utils/color.js';

/**
 * Quads along one ribbon.
 *
 * It is a helix, so every one of these is a chord across a curve — too few and
 * the spiral reads as a bent coat hanger. Forty-eight is the first count that
 * is smooth at two turns, which is more than the effect ever asks for.
 */
const SEGMENTS = 48;

/** Ribbons the buffer is built for. `count` picks how many of them are drawn. */
const CAPACITY = 24;

/**
 * Trails of light spiralling up around whoever is standing in the shaft.
 *
 * ## One quad grid, any number of ribbons
 *
 * The geometry is a strip and nothing else: `x` runs 0 (the tail) to 1 (the
 * head) and `y` is which side of the ribbon a vertex is on. Not one metre of
 * the helix is in the buffer — the vertex shader puts every vertex on it from
 * the instance's own seed, so the twenty-four ribbons are one draw call and
 * changing their number, radius, pitch or speed costs nothing but a uniform.
 *
 * Each ribbon draws its whole character out of that seed: which way round it
 * turns, how fast it climbs, how long it is, how far out it rides and how wide
 * it is. That is the difference between a spiral and *spirals* — a set that all
 * share a phase reads as a barber's pole, and hashing them apart costs three
 * lines.
 *
 * ## Why they climb rather than loop
 *
 * A ribbon is placed by a head that runs 0..1 and wraps. If the ribbon were
 * pinned to the column it would have to tear somewhere when that head came
 * round. Instead the whole strip is offset so that at head 0 it sits entirely
 * *below* the floor and at head 1 entirely above the top, and it is faded at
 * both ends — so a ribbon is born out of the ground, climbs, and dissolves into
 * the sky, and the wrap happens where there is nothing on screen to tear.
 *
 * ## Facing
 *
 * A ribbon is a surface with no thickness, and one seen edge-on is a line of
 * dead pixels. So the width is laid out along `cross(tangent, view)`: the strip
 * turns about its own path to keep its face to the lens, which is what a trail
 * has to do to survive a camera orbiting it.
 *
 * ## What it owns
 *
 * One mesh and its uniforms. Where the column is, how hard it is burning and
 * how many ribbons are in it are told to it once a frame by `vfx/Ascendance.js`.
 * It never allocates after construction.
 */
export class RadiantRibbons {
  constructor() {
    // A parameter domain, not a shape: x in [0, 1] along the ribbon, y in
    // [-0.5, 0.5] across it. Every metre of the helix is resolved in the shader.
    const strip = new PlaneGeometry(1, 1, SEGMENTS, 1).translate(0.5, 0, 0);

    const geometry = new InstancedBufferGeometry();
    // The strip's own buffers, handed over rather than copied — and its uvs
    // left behind, because nothing here reads them.
    geometry.setIndex(strip.index);
    geometry.setAttribute('position', strip.attributes.position);

    const seeds = new Float32Array(CAPACITY);
    for (let i = 0; i < CAPACITY; i++) seeds[i] = i * 1.618 + 0.37;
    geometry.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 1));
    geometry.instanceCount = 0;

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // The strip turns to face the lens, so its winding is not ours to predict.
      side: DoubleSide,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uColor: { value: makeColor('#ffbe4d') },
        uCoreColor: { value: makeColor('#fff6dc') },
        uIntensity: { value: 1.6 },
        uTime: { value: 0 },
        /** Master, and what the ribbons are wound in and out on. */
        uFade: { value: 0 },
        /** 0..1 — tightens the helix and brightens it as the summon gathers. */
        uCharge: { value: 0 },
        uRadius: { value: 1.05 },
        uHeight: { value: 3.4 },
        uTurns: { value: 1.6 },
        uSpan: { value: 0.55 },
        uSpeed: { value: 0.42 },
        uSwirl: { value: 0.5 },
        uWidth: { value: 0.11 },
        uTopScale: { value: 0.45 },
        uWaist: { value: 0.12 },
        uSoftness: { value: 1.5 },
        uCorePower: { value: 5.0 },
        uSeed: { value: 4.2 }
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'RadiantRibbons';
    // Built entirely in the vertex shader from a unit strip, so there is no
    // bounding volume that could be right.
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.VFX);
    // Over the shaft: the ribbons wrap *around* the column, and where the two
    // cross the ribbon is the nearer thing.
    this.mesh.renderOrder = 7;
    this.mesh.visible = false;
    this.mesh.raycast = () => {};
  }

  /**
   * Where the column stands — the foot of the helix, in world space.
   *
   * @param {number} x
   * @param {number} y the ground under the body
   * @param {number} z
   */
  place(x, y, z) {
    this.mesh.position.set(x, y, z);
  }

  /**
   * @param {object} config `settings.ascendance.ribbons`
   * @param {object} state
   * @param {number} state.fade master, 0..1
   * @param {number} state.charge 0..1
   * @param {number} state.scale multiplier on the radius, so they can iris out
   * @param {number} elapsed the shared clock
   */
  update(config, { fade = 1, charge = 0, scale = 1 }, elapsed = 0) {
    const count = Math.max(0, Math.min(CAPACITY, Math.round(config.count)));
    this.mesh.visible = fade > 0.001 && scale > 0.001 && count > 0;
    if (!this.mesh.visible) return;

    this.mesh.geometry.instanceCount = count;

    const u = this.material.uniforms;
    copyColor(u.uColor.value, config.color);
    copyColor(u.uCoreColor.value, config.coreColor);
    u.uIntensity.value = config.intensity;
    u.uTime.value = elapsed;
    u.uFade.value = fade;
    u.uCharge.value = charge;
    u.uRadius.value = Math.max(0.02, config.radius) * scale;
    u.uHeight.value = Math.max(0.1, config.height);
    u.uTurns.value = config.turns;
    u.uSpan.value = Math.max(0.05, config.span);
    u.uSpeed.value = config.speed;
    u.uSwirl.value = config.swirl;
    u.uWidth.value = Math.max(0.002, config.width) * scale;
    u.uTopScale.value = config.topScale;
    u.uWaist.value = config.waist;
    u.uSoftness.value = Math.max(0.1, config.softness);
    u.uCorePower.value = Math.max(0.5, config.corePower);
  }

  /** A fresh set of phases, for the next cast. */
  reseed() {
    this.material.uniforms.uSeed.value = Math.random() * 128;
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

/**
 * One vertex, put on its ribbon's helix.
 *
 * Everything that makes this ribbon *this* ribbon comes out of three hashes of
 * its seed, so the set never has two of anything in step. The tangent is the
 * analytic derivative of the helix rather than a difference of neighbours —
 * it is two terms, it is exact at every vertex, and it is what the width is
 * laid out across.
 */
const VERTEX = /* glsl */ `
${noiseGLSL}

uniform float uTime;
uniform float uFade;
uniform float uCharge;
uniform float uRadius;
uniform float uHeight;
uniform float uTurns;
uniform float uSpan;
uniform float uSpeed;
uniform float uSwirl;
uniform float uWidth;
uniform float uTopScale;
uniform float uWaist;
uniform float uSeed;

attribute float aSeed;

varying float vT;
varying float vSide;
varying float vFade;
varying float vSeed;

const float TAU = 6.28318530718;

void main() {
  float t = position.x;
  float side = position.y * 2.0;

  float seed = aSeed + uSeed;
  float h1 = hash11(seed);
  float h2 = hash11(seed + 7.31);
  float h3 = hash11(seed + 21.77);

  // Half of them turn the other way. Without this the whole column shears in
  // one direction and reads as a drill rather than as something being wound.
  float dir = h1 < 0.5 ? -1.0 : 1.0;
  float speed = uSpeed * mix(0.72, 1.34, h2);
  float span = uSpan * mix(0.68, 1.18, h3);
  float phase = h1 * 11.0 + h3 * 3.0;

  // The head runs 0..1 and wraps; the offset puts the whole strip below the
  // floor at 0 and above the top at 1, so the wrap never tears the ribbon.
  float head = fract(uTime * speed + phase);
  float y01 = head * (1.0 + span) - span + t * span;

  // Narrowing as it climbs, with a slow waist in it — a helix at a constant
  // radius is a spring, and this is meant to be something being drawn upward.
  float radius = uRadius * mix(1.0, uTopScale, clamp(y01, 0.0, 1.0)) * mix(0.76, 1.18, h2);
  radius *= 1.0 + uWaist * sin(y01 * TAU + phase);
  radius *= mix(1.0, 0.82, uCharge);

  float angle = phase * TAU + dir * (y01 * uTurns * TAU + uTime * uSwirl);
  float c = cos(angle);
  float s = sin(angle);

  vec3 local = vec3(c * radius, y01 * uHeight, s * radius);

  // d(local)/dt. The radius term is dropped: it is an order of magnitude below
  // the other two and only ever tilts the ribbon's face by a fraction of a
  // degree.
  float dAngle = dir * span * uTurns * TAU;
  vec3 tangent = vec3(-s * radius * dAngle, span * uHeight, c * radius * dAngle);

  vec4 world = modelMatrix * vec4(local, 1.0);
  vec3 tangentWorld = normalize(mat3(modelMatrix) * tangent);
  vec3 view = normalize(world.xyz - cameraPosition);

  // Across the path and across the eye: the strip rolls about its own line to
  // keep its face to the lens.
  vec3 across = cross(tangentWorld, view);
  float len = length(across);
  // Dead on: the ribbon is running straight at the camera and there is no
  // across to speak of. Any perpendicular will do for the pixel or two it lasts.
  across = len > 1e-4 ? across / len : normalize(cross(tangentWorld, vec3(0.0, 1.0, 0.0)));

  // Blunt at the head, tapering to nothing at the tail — the shape of something
  // being dragged rather than of a length of tape.
  float taper = smoothstep(0.0, 0.55, t) * (1.0 - smoothstep(0.88, 1.0, t) * 0.5);
  float width = uWidth * taper * mix(0.7, 1.3, h3) * uFade;
  world.xyz += across * side * width;

  vT = t;
  vSide = side;
  // Off the floor and into the sky. Both ends of the climb are a fade, which is
  // what lets the ribbon wrap without anything appearing or vanishing.
  vFade = smoothstep(0.0, 0.10, y01) * (1.0 - smoothstep(0.70, 1.02, y01));
  vSeed = seed;

  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * The light across the ribbon.
 *
 * Two falloffs on the same number: a soft band that is the ribbon's own colour
 * and a tight core that runs to white. That is the whole reason a trail reads
 * as *hot* rather than as a coloured strip — the middle of it is a different
 * colour from its edges, exactly as the middle of a filament is.
 */
const FRAGMENT = /* glsl */ `
${noiseGLSL}

uniform vec3 uColor;
uniform vec3 uCoreColor;
uniform float uIntensity;
uniform float uTime;
uniform float uFade;
uniform float uCharge;
uniform float uSoftness;
uniform float uCorePower;

varying float vT;
varying float vSide;
varying float vFade;
varying float vSeed;

void main() {
  float edge = max(0.0, 1.0 - abs(vSide));
  if (edge <= 0.001 || vFade <= 0.001) discard;

  float band = pow(edge, uSoftness);
  float core = pow(edge, uCorePower);
  // The head of the trail is where the energy is, and it is white there.
  float head = smoothstep(0.5, 1.0, vT) * core * 1.5;

  // A slow crawl along the ribbon, so a trail that is otherwise a clean curve
  // has something alive in it.
  float flicker = mix(0.72, 1.28, snoise01(vec3(vT * 6.0, vSeed * 3.1, uTime * 1.7)));

  float gain = uIntensity * uFade * vFade * flicker * (1.0 + uCharge * 0.7);

  vec3 rgb = uColor * band + uCoreColor * (core * 0.9 + head);
  float a = (band + core * 0.9 + head) * gain;
  if (a < 0.003) discard;

  // Premultiplied against an additive blend: the alpha is the light.
  gl_FragColor = vec4(rgb * gain, a);
}
`;
