import {
  BufferAttribute,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  NormalBlending,
  ShaderMaterial
} from 'three';

import { LAYER } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { copyColor, makeColor } from '../utils/color.js';

/** origin(3) angle radius spin rise seed birth life size — one puff, one stride. */
const STRIDE = 11;

/**
 * Torn shadow, going round.
 *
 * ## The layer that has to be dark
 *
 * Every other emissive in this project adds. This one cannot: a swirl of
 * *shadow* that brightened what it crossed would be a swirl of smoke lit from
 * inside, which is the one thing it must not read as. So it is the only
 * particle system here on `NormalBlending` — a near-black body with a violet
 * fringe, laid over the frame rather than added to it. The darkness of the
 * aura comes entirely from this and the wisps; the bright layers (the pool,
 * the rings, the column) are what it is dark *against*.
 *
 * ## The vortex is not simulated
 *
 * A puff is born on a ring at some angle and thereafter is a closed form: the
 * angle winds at its own rate, the radius creeps outward over its life, and the
 * whole thing lifts. There is no integration, no per-frame write and no
 * compaction — the CPU only ever *births* eleven floats into a ring buffer and
 * the vertex shader does the rest, exactly as `vfx/HolyEmbers.js` does with its
 * ballistic motes. A spent slot is folded to a degenerate point and costs the
 * rasteriser nothing.
 *
 * The winding rate is hashed per puff and falls off with the radius it was born
 * at. That one line is the difference between a vortex and a turntable: a set
 * of particles all turning at one rate is a texture on a spinning disc, and a
 * set whose inner ones outrun their outer ones is a fluid.
 *
 * ## Arms, not blobs
 *
 * The reference is not a cloud of round puffs going round — it is a *spiral*,
 * with arms you can trace. Round billboards cannot make one however many of
 * them there are, and the fix is not more particles: it is that each puff is
 * **stretched along its own orbit**. A quad elongated on the tangent is a short
 * arc of smoke, and a set of arcs at radii that turn at different rates shears
 * into arms on its own, because that is exactly how a real spiral forms.
 *
 * The stretch axis is computed in *view* space, so it survives the camera
 * orbiting the effect, and it collapses back to round as the orbit turns to
 * face the lens — where there is no screen-space direction to stretch along and
 * a fixed elongation would read as a puff randomly turning into a stick.
 *
 * ## The puff
 *
 * One quad, one fbm lookup, one radial mask. The noise is sampled in the quad's
 * own space with the puff's seed on the third axis, so no two are the same
 * shape, and it is eroded from the outside in — which is what gives smoke its
 * ragged outline instead of the soft circle a plain falloff draws.
 */
export class ShadowSwirl {
  /** @param {number} capacity hard ceiling on puffs in flight */
  constructor(capacity = 512) {
    this.capacity = capacity;

    this.data = new Float32Array(capacity * STRIDE);
    this.buffer = new InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buffer.setUsage(DynamicDrawUsage);

    const geometry = new InstancedBufferGeometry();
    // One quad, corners in [-1, 1]. The billboard is built in view space, so a
    // vertex only has to say which corner of the puff it is.
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3)
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('aOrigin', new InterleavedBufferAttribute(this.buffer, 3, 0));
    geometry.setAttribute('aAngle', new InterleavedBufferAttribute(this.buffer, 1, 3));
    geometry.setAttribute('aRadius', new InterleavedBufferAttribute(this.buffer, 1, 4));
    geometry.setAttribute('aSpin', new InterleavedBufferAttribute(this.buffer, 1, 5));
    geometry.setAttribute('aRise', new InterleavedBufferAttribute(this.buffer, 1, 6));
    geometry.setAttribute('aSeed', new InterleavedBufferAttribute(this.buffer, 1, 7));
    geometry.setAttribute('aBirth', new InterleavedBufferAttribute(this.buffer, 1, 8));
    geometry.setAttribute('aLife', new InterleavedBufferAttribute(this.buffer, 1, 9));
    geometry.setAttribute('aSize', new InterleavedBufferAttribute(this.buffer, 1, 10));
    geometry.instanceCount = 0;

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      // Tested, so a puff behind the body is behind the body — which matters
      // more here than on any additive layer: shadow drawn over the character
      // would take the character out of the middle of its own aura.
      depthTest: true,
      side: DoubleSide,
      // The whole point. See the class note.
      blending: NormalBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        /** The body of the smoke. Nearly black, and never quite. */
        uColor: { value: makeColor('#0b0712') },
        /** The fringe, where the aura catches a torn edge. */
        uRimColor: { value: makeColor('#8b5cf6') },
        uOpacity: { value: 0.72 },
        uRim: { value: 0.55 },
        /** Fraction the orbit widens (or, negative, tightens) over a life. */
        uWiden: { value: 0.35 },
        uRise: { value: 0.55 },
        uSize: { value: 0.62 },
        uGrow: { value: 0.9 },
        /** How far a puff is drawn out along its own orbit. 1 is a ball. */
        uStretch: { value: 2.6 },
        uWobble: { value: 0.28 },
        uWobbleSpeed: { value: 1.6 },
        /** How fine the fbm is across one puff, and how fast it churns. */
        uDetail: { value: 1.7 },
        uChurn: { value: 0.45 },
        uSoftness: { value: 0.15 },
        /** How hard the outside is eaten away. This is what makes it smoke. */
        uErode: { value: 0.55 }
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'ShadowSwirl';
    this.mesh.frustumCulled = false;
    // The topmost layer of the ability: the shadow passes in *front* of the
    // column, which is the only reading in which the column stands inside it.
    this.mesh.renderOrder = 9;
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.raycast = () => {};

    this._head = 0;
    this._written = 0;
    this._clock = 0;
    /** Fractional puffs carried between frames, so a slow rate is not rounded away. */
    this._debt = 0;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Push this frame's uniforms.
   *
   * Called before anything can emit, so a puff born later in the same frame is
   * stamped with a clock the shader already agrees with.
   *
   * @param {number} time the simulation's clock
   * @param {object} config `settings.shadowBoost.swirl`
   */
  sync(time, config) {
    const u = this.material.uniforms;

    this._clock = time;
    u.uTime.value = time;
    copyColor(u.uColor.value, config.color);
    copyColor(u.uRimColor.value, config.rimColor);
    u.uOpacity.value = config.opacity;
    u.uRim.value = config.rim;
    u.uWiden.value = config.widen;
    u.uRise.value = config.rise;
    u.uSize.value = config.size;
    u.uGrow.value = config.grow;
    u.uStretch.value = Math.max(1, config.stretch);
    u.uWobble.value = config.wobble;
    u.uWobbleSpeed.value = config.wobbleSpeed;
    u.uDetail.value = Math.max(0.1, config.detail);
    u.uChurn.value = config.churn;
    u.uSoftness.value = Math.max(0.01, config.softness);
    u.uErode.value = config.erode;
  }

  /**
   * Feed the vortex, in puffs a second.
   *
   * A rate rather than a count, so the density is a number in seconds and does
   * not change with the frame rate. The remainder is carried, which is what
   * lets a rate below one a frame still produce puffs instead of rounding to
   * none.
   *
   * @param {number} x world, the axis of the vortex
   * @param {number} y the ground there
   * @param {number} z
   * @param {number} radius metres out the band of birth sits
   * @param {number} rate puffs a second
   * @param {number} dt seconds
   * @param {object} config `settings.shadowBoost.swirl`
   */
  emit(x, y, z, radius, rate, dt, config) {
    if (rate <= 0 || dt <= 0) return;
    this._debt += rate * dt;
    const count = Math.floor(this._debt);
    if (count <= 0) return;
    this._debt -= count;
    this.spray(x, y, z, radius, count, config);
  }

  /**
   * Throw a handful out at once — the frame the column comes up.
   *
   * @param {number} x world
   * @param {number} y the ground there
   * @param {number} z
   * @param {number} radius metres out the band of birth sits
   * @param {number} count how many
   * @param {object} config `settings.shadowBoost.swirl`
   * @param {number} [strength] master on how big they are born
   */
  spray(x, y, z, radius, count, config, strength = 1) {
    const wanted = Math.min(Math.max(0, Math.round(count)), this.capacity >> 1);
    if (wanted <= 0) return;

    const startIndex = this._head;
    const life = Math.max(0.1, config.life);

    for (let i = 0; i < wanted; i++) {
      // Born on a band rather than in a disc: the middle of the vortex is where
      // the body is standing, and a puff born there is a puff drawn across the
      // character's chest. The square root keeps the band off its inner edge.
      const angle = Math.random() * Math.PI * 2;
      const r = Math.max(0.15, radius * Math.sqrt(0.3 + 0.7 * Math.random()));
      // Inner puffs wind faster than outer ones. This is the whole difference
      // between a vortex and a turntable.
      const spin = config.spin * (radius / r) * (0.7 + Math.random() * 0.6);

      this._write(
        x,
        // Not all off the floor. A swirl that is one sheet at ankle height is a
        // decal; scattering the births up the body's own height is what gives
        // the column something to be wrapped in.
        y + Math.random() * config.spawnHeight,
        z,
        angle,
        r,
        config.reverse && Math.random() < 0.5 ? -spin : spin,
        config.rise * (0.55 + Math.random() * 0.9),
        life * (0.7 + Math.random() * 0.6),
        (0.6 + Math.random() * 0.85) * strength
      );
    }

    this.mesh.geometry.instanceCount = this._written;

    // Only the span just written goes up the bus. A ring that wrapped this
    // frame is two spans, which is still a fraction of restreaming the pool.
    if (this._head > startIndex) {
      this.buffer.addUpdateRange(startIndex * STRIDE, (this._head - startIndex) * STRIDE);
    } else {
      this.buffer.addUpdateRange(startIndex * STRIDE, (this.capacity - startIndex) * STRIDE);
      if (this._head > 0) this.buffer.addUpdateRange(0, this._head * STRIDE);
    }
    this.buffer.needsUpdate = true;
  }

  /** One puff into the ring. */
  _write(x, y, z, angle, radius, spin, rise, life, size) {
    const data = this.data;
    const o = this._head * STRIDE;

    data[o] = x;
    data[o + 1] = y;
    data[o + 2] = z;
    data[o + 3] = angle;
    data[o + 4] = radius;
    data[o + 5] = spin;
    data[o + 6] = rise;
    data[o + 7] = Math.random();
    data[o + 8] = this._clock;
    data[o + 9] = life;
    data[o + 10] = size;

    this._head = (this._head + 1) % this.capacity;
    if (this._written < this.capacity) this._written++;
  }

  /** Kill everything in flight — for leaving the stage. */
  clear() {
    this.data.fill(0);
    this._head = 0;
    this._written = 0;
    this._debt = 0;
    this.mesh.geometry.instanceCount = 0;
    this.buffer.needsUpdate = true;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/* -------------------------------------------------------------------- */

/**
 * One puff, put on its orbit.
 *
 * The orbit is the closed form of a winding that slows: `angle + spin*t*(1 -
 * u/3)`. Smoke thrown round something loses its angular speed as it is flung
 * outward, and a set of puffs that keep theirs reads as a rigid disc however
 * good the sprite on it is.
 */
const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uWiden;
uniform float uRise;
uniform float uSize;
uniform float uGrow;
uniform float uStretch;
uniform float uWobble;
uniform float uWobbleSpeed;

attribute vec3 aOrigin;
attribute float aAngle;
attribute float aRadius;
attribute float aSpin;
attribute float aRise;
attribute float aSeed;
attribute float aBirth;
attribute float aLife;
attribute float aSize;

varying vec2 vShape;
varying float vSeed;
varying float vFade;

const float TAU = 6.28318530718;

void main() {
  float age = uTime - aBirth;

  // Not yet born, already spent, or a slot never written. Folded to a
  // degenerate point outside the clip volume, which the rasteriser drops free.
  if (aLife <= 0.0 || age < 0.0 || age >= aLife) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vShape = vec2(0.0);
    vSeed = 0.0;
    vFade = 0.0;
    return;
  }

  float u = age / aLife;
  float phase = aSeed * TAU;

  /* ---- the orbit ---- */
  float angle = aAngle + aSpin * age * (1.0 - u * 0.34);
  float radius = aRadius * (1.0 + uWiden * u);

  vec3 pos = aOrigin;
  pos.x += cos(angle) * radius;
  pos.z += sin(angle) * radius;
  // Rising, and losing the last of it: shadow thrown up out of the ground slows
  // the way anything thrown does.
  pos.y += (aRise + uRise) * 0.5 * age * (1.0 - u * 0.3);

  // And the wander, growing with age, so puffs leave the band cleanly and are
  // breaking up by the time they are high.
  pos.x += sin(uTime * uWobbleSpeed + phase) * uWobble * u;
  pos.z += cos(uTime * uWobbleSpeed * 0.79 + phase * 1.7) * uWobble * u;
  pos.y += sin(uTime * uWobbleSpeed * 0.61 + phase * 2.3) * uWobble * 0.5 * u;

  /* ---- how big, and how much is left ---- */
  float size = uSize * aSize * (1.0 + uGrow * u);
  // Smoke thins for most of its life rather than snapping off, and it is never
  // at full body on the frame it is born.
  vFade = smoothstep(0.0, 0.18, u) * (1.0 - smoothstep(0.4, 1.0, u));

  /* ---- the billboard, drawn out along the orbit ---- */
  vec4 viewPos = viewMatrix * vec4(pos, 1.0);

  // Where this puff is going, in world space: the tangent of its own circle.
  vec3 tangent = vec3(-sin(angle), 0.0, cos(angle)) * sign(aSpin);
  vec2 screen = (mat3(viewMatrix) * tangent).xy;
  float reach = length(screen);
  // Nearly nothing on screen means the orbit is running straight at the lens,
  // and there is no direction to draw the puff out along. Falling back to round
  // is the honest answer; a fixed elongation would have puffs turning into
  // sticks as the camera came round.
  vec2 along = reach > 1e-3 ? screen / reach : vec2(1.0, 0.0);
  vec2 across = vec2(-along.y, along.x);
  float stretch = mix(1.0, uStretch, clamp(reach, 0.0, 1.0));

  viewPos.xy += (along * position.x * stretch + across * position.y) * size;
  gl_Position = projectionMatrix * viewPos;

  vShape = position.xy;
  vSeed = aSeed;
}
`;

/**
 * One puff of shadow.
 *
 * A radial mask eaten from the outside by an fbm field. The erosion is weighted
 * by how near the edge the fragment is, so the middle of a puff stays solid
 * however violent the noise gets and only its outline is torn — which is the
 * difference between smoke and a cloud of grey blobs.
 *
 * The colour is a body and a fringe. The body is nearly black and the fringe is
 * the aura's violet, laid on where the puff is thin: shadow does not glow, but
 * the *edge* of shadow standing in a violet light does, and that edge is the
 * only place the two colours can honestly meet.
 */
const FRAGMENT = /* glsl */ `
${noiseGLSL}

uniform float uTime;
uniform vec3 uColor;
uniform vec3 uRimColor;
uniform float uOpacity;
uniform float uRim;
uniform float uDetail;
uniform float uChurn;
uniform float uSoftness;
uniform float uErode;

varying vec2 vShape;
varying float vSeed;
varying float vFade;

void main() {
  if (vFade <= 0.001) discard;

  float d = length(vShape);
  if (d > 1.0) discard;

  // The puff's own shape, in its own space, drifting on its own seed.
  float n = fbm3(vec3(vShape * uDetail, vSeed * 17.0 + uTime * uChurn));

  float mask = 1.0 - smoothstep(uSoftness, 1.0, d);
  // Eaten from the outside in, so the core survives and the outline is ragged.
  float density = clamp(mask * (0.35 + 0.95 * n) - uErode * (1.0 - mask) * (1.0 - n), 0.0, 1.0);
  if (density <= 0.004) discard;

  // The fringe. Only where the puff is thin — which is where the light behind
  // it would actually be coming through.
  float rim = smoothstep(0.3, 0.95, d) * (0.35 + 0.65 * n) * uRim;
  vec3 rgb = mix(uColor, uRimColor, clamp(rim, 0.0, 1.0));

  float a = density * vFade * uOpacity;
  if (a < 0.004) discard;

  // Not premultiplied: this is one of the two layers in the ability that are
  // laid over the frame rather than added to it.
  gl_FragColor = vec4(rgb, a);
}
`;
