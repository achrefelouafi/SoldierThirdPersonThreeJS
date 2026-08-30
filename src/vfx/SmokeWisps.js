import {
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial
} from 'three';

import { LAYER } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { copyColor, makeColor } from '../utils/color.js';

/**
 * Quads along one wisp.
 *
 * It is a curl, so every one of these is a chord across a curve. Forty is the
 * first count at which the S-bend at the top of a wisp stops reading as two
 * straight pieces meeting at an angle.
 */
const SEGMENTS = 40;

/** Wisps the buffer is built for. `count` picks how many of them are drawn. */
const CAPACITY = 24;

/**
 * Smoke, going up.
 *
 * ## The slow layer
 *
 * The swirl is fast and horizontal; these are slow and vertical, and the aura
 * needs both or it reads as one motion. A wisp climbs out of the ground,
 * curling as it goes, widening and thinning until it is nothing — the loose,
 * unhurried thing between the hard edges of the column and the rings.
 *
 * ## One quad grid, any number of wisps
 *
 * The geometry is a strip and nothing else: `x` runs 0 (the tail, at the floor)
 * to 1 (the head), and `y` is which side of the ribbon a vertex is on. Not one
 * metre of the curl is in the buffer — the vertex shader puts every vertex on
 * it from the instance's own seed, exactly as `vfx/RadiantRibbons.js` does, so
 * twenty-four wisps are one draw call and their number, height, curl and speed
 * are all uniforms.
 *
 * Each wisp draws its whole character out of that seed: which way it winds, how
 * fast it climbs, how long it is, how far out it stands and how wide it gets.
 * A set that shares a phase reads as a barber's pole; hashing them apart costs
 * three lines.
 *
 * ## Why they climb rather than loop
 *
 * A wisp is placed by a head that runs 0..1 and wraps. The strip is offset so
 * that at head 0 it sits entirely below the floor and at head 1 entirely above
 * the top, and it is faded at both ends — so a wisp is born out of the ground,
 * climbs, and dissolves, and the wrap happens where there is nothing on screen
 * to tear.
 *
 * ## Dark, like the swirl
 *
 * `NormalBlending`, a near-black body and a violet fringe. See
 * `vfx/ShadowSwirl.js` for why the two shadow layers cannot add: smoke that
 * brightened what it crossed would be steam lit from within.
 *
 * ## What it owns
 *
 * One mesh and its uniforms. Where the column stands and how hard the aura is
 * running are told to it once a frame by `vfx/ShadowBoost.js`. It never
 * allocates after construction.
 */
export class SmokeWisps {
  constructor() {
    // A parameter domain, not a shape: x in [0, 1] along the wisp, y in
    // [-0.5, 0.5] across it. Every metre of the curl is resolved in the shader.
    const strip = new PlaneGeometry(1, 1, SEGMENTS, 1).translate(0.5, 0, 0);

    const geometry = new InstancedBufferGeometry();
    // The strip's own buffers, handed over rather than copied — and its uvs
    // left behind, because nothing here reads them.
    geometry.setIndex(strip.index);
    geometry.setAttribute('position', strip.attributes.position);

    const seeds = new Float32Array(CAPACITY);
    for (let i = 0; i < CAPACITY; i++) seeds[i] = i * 2.399 + 0.11;
    geometry.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 1));
    geometry.instanceCount = 0;

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // The strip turns to face the lens, so its winding is not ours to predict.
      side: DoubleSide,
      blending: NormalBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uColor: { value: makeColor('#0d0916') },
        uRimColor: { value: makeColor('#7c5cf0') },
        uOpacity: { value: 0.6 },
        uRim: { value: 0.5 },
        uTime: { value: 0 },
        /** Master, and what the wisps are wound in and out on. */
        uFade: { value: 0 },
        uRadius: { value: 1.1 },
        uHeight: { value: 3.2 },
        uCurl: { value: 0.55 },
        uWrithe: { value: 0.35 },
        uSway: { value: 0.4 },
        uSpan: { value: 0.6 },
        uSpeed: { value: 0.28 },
        uWidth: { value: 0.34 },
        uSpread: { value: 1.4 },
        uTopScale: { value: 1.25 },
        uSoftness: { value: 1.4 },
        /** How fine the tear along a wisp is, and how fast it crawls. */
        uDetail: { value: 3.4 },
        uChurn: { value: 0.5 },
        uErode: { value: 0.45 },
        uSeed: { value: 6.7 }
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'SmokeWisps';
    // Built entirely in the vertex shader from a unit strip, so there is no
    // bounding volume that could be right.
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.VFX);
    // Over the column and under the swirl: the wisps wrap around the shaft, and
    // the torn puffs blow across in front of everything.
    this.mesh.renderOrder = 8;
    this.mesh.visible = false;
    this.mesh.raycast = () => {};
  }

  /**
   * Where they climb from — the foot of the set, in world space.
   *
   * @param {number} x
   * @param {number} y the ground under the body
   * @param {number} z
   */
  place(x, y, z) {
    this.mesh.position.set(x, y, z);
  }

  /**
   * @param {object} config `settings.shadowBoost.wisps`
   * @param {object} state
   * @param {number} state.fade master, 0..1
   * @param {number} state.scale multiplier on the radius and the width
   * @param {number} elapsed the shared clock
   */
  update(config, { fade = 1, scale = 1 }, elapsed = 0) {
    const count = Math.max(0, Math.min(CAPACITY, Math.round(config.count)));
    this.mesh.visible = fade > 0.001 && scale > 0.001 && count > 0;
    if (!this.mesh.visible) return;

    this.mesh.geometry.instanceCount = count;

    const u = this.material.uniforms;
    copyColor(u.uColor.value, config.color);
    copyColor(u.uRimColor.value, config.rimColor);
    u.uOpacity.value = config.opacity;
    u.uRim.value = config.rim;
    u.uTime.value = elapsed;
    u.uFade.value = fade;
    u.uRadius.value = Math.max(0.02, config.radius) * scale;
    u.uHeight.value = Math.max(0.1, config.height);
    u.uCurl.value = config.curl;
    u.uWrithe.value = config.writhe;
    u.uSway.value = config.sway;
    u.uSpan.value = Math.max(0.05, config.span);
    u.uSpeed.value = config.speed;
    u.uWidth.value = Math.max(0.005, config.width) * scale;
    u.uSpread.value = config.spread;
    u.uTopScale.value = config.topScale;
    u.uSoftness.value = Math.max(0.1, config.softness);
    u.uDetail.value = Math.max(0.1, config.detail);
    u.uChurn.value = config.churn;
    u.uErode.value = config.erode;
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
 * One vertex, put on its wisp.
 *
 * The path is a slow winding about the column with a second, slower wander laid
 * on top of it — two frequencies, because one is a corkscrew and a corkscrew is
 * not what smoke does. The tangent is the analytic derivative of that path
 * rather than a difference of neighbours: it is exact at every vertex, and it
 * is what the width is laid out across so the strip keeps its face to the lens.
 */
const VERTEX = /* glsl */ `
${noiseGLSL}

uniform float uTime;
uniform float uFade;
uniform float uRadius;
uniform float uHeight;
uniform float uCurl;
uniform float uWrithe;
uniform float uSway;
uniform float uSpan;
uniform float uSpeed;
uniform float uWidth;
uniform float uSpread;
uniform float uTopScale;
uniform float uSeed;

attribute float aSeed;

varying float vT;
varying float vSide;
varying float vFade;
varying float vSeed;
varying float vHeight;

const float TAU = 6.28318530718;

void main() {
  float t = position.x;
  float side = position.y * 2.0;

  float seed = aSeed + uSeed;
  float h1 = hash11(seed);
  float h2 = hash11(seed + 3.77);
  float h3 = hash11(seed + 19.13);

  // Half of them wind the other way. Without this the whole set shears one way
  // and reads as a drill rather than as smoke.
  float dir = h1 < 0.5 ? -1.0 : 1.0;
  float speed = uSpeed * mix(0.7, 1.4, h2);
  float span = uSpan * mix(0.7, 1.2, h3);
  float phase = h1 * 13.0 + h3 * 5.0;

  // The head runs 0..1 and wraps; the offset puts the whole strip below the
  // floor at 0 and above the top at 1, so the wrap never tears the wisp.
  float head = fract(uTime * speed + phase);
  float y01 = head * (1.0 + span) - span + t * span;
  float h = clamp(y01, 0.0, 1.0);

  // Standing further out as it rises: smoke off a ring spreads, and a set that
  // holds its radius is a cage.
  float radius = uRadius * mix(1.0, uTopScale, h) * mix(0.7, 1.25, h2);
  float angle = phase * TAU + dir * (h * uCurl * TAU + uTime * uWrithe);
  float c = cos(angle);
  float s = sin(angle);

  // The second frequency: a slow lateral wander that only exists once the wisp
  // is off the floor.
  vec2 wander = vec2(
    sin(h * 3.1 + phase * 5.0 + uTime * 0.4),
    cos(h * 2.6 + phase * 3.3 + uTime * 0.33)
  ) * uSway * h;

  vec3 local = vec3(c * radius + wander.x, y01 * uHeight, s * radius + wander.y);

  // d(local)/dt, dropping the radius and wander terms: both are an order of
  // magnitude below the other two and only tilt the strip by a fraction of a
  // degree.
  float dAngle = dir * span * uCurl * TAU;
  vec3 tangent = vec3(-s * radius * dAngle, span * uHeight, c * radius * dAngle);

  vec4 world = modelMatrix * vec4(local, 1.0);
  vec3 tangentWorld = normalize(mat3(modelMatrix) * tangent);
  vec3 view = normalize(world.xyz - cameraPosition);

  // Across the path and across the eye: the strip rolls about its own line to
  // keep its face to the lens.
  vec3 across = cross(tangentWorld, view);
  float len = length(across);
  across = len > 1e-4 ? across / len : normalize(cross(tangentWorld, vec3(0.0, 1.0, 0.0)));

  // Narrow where it leaves the ground, spreading as it climbs, and tapering off
  // at the head — the shape of a plume rather than of a length of tape.
  float grow = mix(0.45, uSpread, h);
  float taper = smoothstep(0.0, 0.3, t) * (1.0 - smoothstep(0.72, 1.0, t) * 0.75);
  world.xyz += across * side * uWidth * grow * taper * uFade;

  vT = t;
  vSide = side;
  // Off the floor and away into the air. Both ends of the climb are a fade,
  // which is what lets a wisp wrap without anything appearing or vanishing.
  vFade = smoothstep(0.0, 0.12, y01) * (1.0 - smoothstep(0.55, 1.0, y01));
  vSeed = seed;
  vHeight = h;

  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * The smoke across the wisp.
 *
 * A soft band eaten from its edges by an fbm field running along the strip, and
 * a violet fringe where what is left is thin. The erosion is the same idea as
 * the swirl's and for the same reason: a clean-edged ribbon of dark is a strap,
 * and smoke has to be losing pieces of itself the whole way up.
 */
const FRAGMENT = /* glsl */ `
${noiseGLSL}

uniform vec3 uColor;
uniform vec3 uRimColor;
uniform float uOpacity;
uniform float uRim;
uniform float uTime;
uniform float uFade;
uniform float uSoftness;
uniform float uDetail;
uniform float uChurn;
uniform float uErode;

varying float vT;
varying float vSide;
varying float vFade;
varying float vSeed;
varying float vHeight;

void main() {
  float edge = max(0.0, 1.0 - abs(vSide));
  if (edge <= 0.001 || vFade <= 0.001) discard;

  float band = pow(edge, uSoftness);
  // Along the wisp, across it, and crawling — three axes, so the tear is a
  // moving field rather than a stripe.
  float n = fbm3(vec3(vT * uDetail, vSide * 1.6 + vSeed * 7.0, uTime * uChurn + vSeed));

  float density = clamp(band * (0.4 + 0.9 * n) - uErode * (1.0 - band) * (1.0 - n), 0.0, 1.0);
  // Thinner the higher it gets, on top of the fade at the ends: smoke does not
  // stop, it runs out.
  density *= mix(1.0, 0.55, vHeight);
  if (density <= 0.004) discard;

  // The fringe, where the wisp is thin enough for the aura behind it to come
  // through.
  float rim = (1.0 - band) * (0.4 + 0.6 * n) * uRim;
  vec3 rgb = mix(uColor, uRimColor, clamp(rim, 0.0, 1.0));

  float a = density * vFade * uFade * uOpacity;
  if (a < 0.004) discard;

  // Not premultiplied: like the swirl, this is laid over the frame rather than
  // added to it.
  gl_FragColor = vec4(rgb, a);
}
`;
