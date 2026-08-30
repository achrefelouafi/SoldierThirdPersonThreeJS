import {
  AdditiveBlending,
  BufferAttribute,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  ShaderMaterial
} from 'three';

import { LAYER } from '../core/Layers.js';
import { copyColor, makeColor } from '../utils/color.js';

/** origin(3) velocity(3) seed birth life size spin — one mote, one stride. */
const STRIDE = 11;

/**
 * Diamonds of light, drifting up out of the ground.
 *
 * ## The cheapest layer, and the one that ties the rest together
 *
 * Everything else in this ability is a hard-edged shape — a circle, a shaft, a
 * fan, a set of spirals. Without something loose in the air between them the
 * effect reads as four decals that happen to be in the same place. These are
 * that something: a slow, sparse drift of motes rising out of the sigil for as
 * long as the boon is up, thickest in the instant it lands.
 *
 * ## No simulation anywhere
 *
 * The CPU only ever *births* a mote — eleven floats into a ring buffer, never
 * touched again — and the whole trajectory is a closed form evaluated in the
 * vertex shader, because linear drag under a constant acceleration has an exact
 * solution:
 *
 *   p(t) = p₀ + v₀·(1−e^−kt)/k + a·(t − (1−e^−kt)/k)/k
 *
 * with `a` pointing *up* rather than down, which is the whole difference
 * between an ember and a spark. On top of it goes a sway — one sine per mote,
 * on its own phase — so a rising field does not read as a lift shaft.
 *
 * The buffer is a ring and nothing is ever compacted: a spent mote is folded to
 * a degenerate point in the vertex shader and costs the rasteriser nothing.
 *
 * ## The diamond
 *
 * The shape is `|x| + |y|` — an L1 distance, which is a diamond for the price
 * of the circle it replaces. That is the shape in the reference and it is worth
 * keeping: a round mote is dust or a firefly, and a four-pointed one is a piece
 * of something consecrated. Each carries a soft round halo behind it as well,
 * which is what stops a field of them looking like confetti.
 */
export class HolyEmbers {
  /** @param {number} capacity hard ceiling on motes in flight */
  constructor(capacity = 640) {
    this.capacity = capacity;

    this.data = new Float32Array(capacity * STRIDE);
    this.buffer = new InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buffer.setUsage(DynamicDrawUsage);

    const geometry = new InstancedBufferGeometry();
    // One quad, corners in [-1, 1], shared by every instance: the billboard is
    // built in view space, so a vertex only has to say which corner it is.
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3)
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('aOrigin', new InterleavedBufferAttribute(this.buffer, 3, 0));
    geometry.setAttribute('aVelocity', new InterleavedBufferAttribute(this.buffer, 3, 3));
    geometry.setAttribute('aSeed', new InterleavedBufferAttribute(this.buffer, 1, 6));
    geometry.setAttribute('aBirth', new InterleavedBufferAttribute(this.buffer, 1, 7));
    geometry.setAttribute('aLife', new InterleavedBufferAttribute(this.buffer, 1, 8));
    geometry.setAttribute('aSize', new InterleavedBufferAttribute(this.buffer, 1, 9));
    geometry.setAttribute('aSpin', new InterleavedBufferAttribute(this.buffer, 1, 10));
    geometry.instanceCount = 0;

    this.material = new ShaderMaterial({
      transparent: true,
      // Light, so it adds; and tested against the world, so a mote behind the
      // body is behind the body.
      depthWrite: false,
      depthTest: true,
      side: DoubleSide,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: makeColor('#ffc861') },
        uCoreColor: { value: makeColor('#fff8e6') },
        uDrag: { value: 1.1 },
        uRise: { value: 1.6 },
        uSize: { value: 0.075 },
        uGrow: { value: 0.5 },
        uSway: { value: 0.34 },
        uSwaySpeed: { value: 1.5 },
        uHalo: { value: 0.55 },
        uSharpness: { value: 0.22 },
        uTwinkle: { value: 0.45 },
        uIntensity: { value: 2.2 }
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'HolyEmbers';
    this.mesh.frustumCulled = false;
    // The topmost layer of the ability: motes drift *in front of* the shaft and
    // the ribbons, and that ordering is what gives the column any depth at all.
    this.mesh.renderOrder = 8;
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.raycast = () => {};

    this._head = 0;
    this._written = 0;
    this._clock = 0;
    /** Fractional motes carried between frames, so a slow rate is not rounded away. */
    this._debt = 0;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Push this frame's uniforms.
   *
   * Called before anything can emit, so a mote born later in the same frame is
   * stamped with a clock the shader already agrees with.
   *
   * @param {number} time the simulation's clock
   * @param {object} config `settings.ascendance.embers`
   */
  sync(time, config) {
    const u = this.material.uniforms;

    this._clock = time;
    u.uTime.value = time;
    copyColor(u.uColor.value, config.color);
    copyColor(u.uCoreColor.value, config.coreColor);
    u.uDrag.value = Math.max(0.02, config.drag);
    u.uRise.value = config.rise;
    u.uSize.value = config.size;
    u.uGrow.value = config.grow;
    u.uSway.value = config.sway;
    u.uSwaySpeed.value = config.swaySpeed;
    u.uHalo.value = config.halo;
    u.uSharpness.value = Math.max(0.01, config.sharpness);
    u.uTwinkle.value = config.twinkle;
    u.uIntensity.value = config.intensity;
  }

  /**
   * Let a few off the ground, in a ring around a point.
   *
   * Called every frame while the boon is up with a *rate* rather than a count,
   * so the density is a number in seconds and does not change with the frame
   * rate. The remainder is carried, which is what lets a rate below one a frame
   * still produce motes instead of rounding to none.
   *
   * @param {number} x world, the middle of the ring
   * @param {number} y the ground there — motes are born on it
   * @param {number} z
   * @param {number} radius metres out they are born within
   * @param {number} rate motes a second
   * @param {number} dt seconds
   * @param {object} config `settings.ascendance.embers`
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
   * Throw a handful up at once — the moment the light lands.
   *
   * @param {number} x world
   * @param {number} y the ground there
   * @param {number} z
   * @param {number} radius metres out they are born within
   * @param {number} count how many
   * @param {object} config `settings.ascendance.embers`
   * @param {number} [strength] master on their speed and size
   */
  spray(x, y, z, radius, count, config, strength = 1) {
    const wanted = Math.min(Math.max(0, Math.round(count)), this.capacity >> 1);
    if (wanted <= 0) return;

    const startIndex = this._head;
    const speed = Math.max(0, config.speed) * strength;
    const life = Math.max(0.1, config.life);

    for (let i = 0; i < wanted; i++) {
      // Born in a ring rather than in a disc: the sigil's rim is where the
      // light is, and a mote lifting off the empty middle has nothing to have
      // come from. The square root is what keeps the ring from crowding its
      // inner edge.
      const angle = Math.random() * Math.PI * 2;
      const r = radius * Math.sqrt(0.25 + 0.75 * Math.random());
      const rise = speed * (0.55 + Math.random() * 0.9);

      this._write(
        x + Math.cos(angle) * r,
        // Not all off the floor: a few start at knee and shoulder height, which
        // is what stops the field reading as a single sheet lifting.
        y + Math.random() * Math.random() * config.spawnHeight,
        z + Math.sin(angle) * r,
        // A breath of outward drift, and the rest of it straight up.
        Math.cos(angle) * speed * 0.18,
        rise,
        Math.sin(angle) * speed * 0.18,
        life * (0.65 + Math.random() * 0.7),
        0.6 + Math.random() * 0.9,
        (Math.random() - 0.5) * config.spin
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

  /** One mote into the ring. */
  _write(x, y, z, vx, vy, vz, life, size, spin) {
    const data = this.data;
    const o = this._head * STRIDE;

    data[o] = x;
    data[o + 1] = y;
    data[o + 2] = z;
    data[o + 3] = vx;
    data[o + 4] = vy;
    data[o + 5] = vz;
    data[o + 6] = Math.random();
    data[o + 7] = this._clock;
    data[o + 8] = life;
    data[o + 9] = size;
    data[o + 10] = spin;

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

const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uDrag;
uniform float uRise;
uniform float uSize;
uniform float uGrow;
uniform float uSway;
uniform float uSwaySpeed;

attribute vec3 aOrigin;
attribute vec3 aVelocity;
attribute float aSeed;
attribute float aBirth;
attribute float aLife;
attribute float aSize;
attribute float aSpin;

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

  /* ---- the climb, in closed form ---- */
  // The acceleration points *up*. Drag alone would have a mote slow to a stop
  // and hang there; a positive term underneath it is what keeps it going, and
  // what makes the field read as something being drawn upward rather than as
  // something that was thrown.
  float k = uDrag;
  float decay = exp(-k * age);
  float impulse = (1.0 - decay) / k;
  vec3 pos = aOrigin + aVelocity * impulse + vec3(0.0, uRise, 0.0) * (age - impulse) / k;

  // And the wander. One sine per mote on its own phase, growing with age so
  // they leave the ground straight and are drifting by the time they are high.
  float phase = aSeed * TAU;
  pos.x += sin(uTime * uSwaySpeed + phase) * uSway * u;
  pos.z += cos(uTime * uSwaySpeed * 0.83 + phase * 1.7) * uSway * u;

  /* ---- how big, and how much is left ---- */
  float size = uSize * aSize * (1.0 + uGrow * u);
  // Struck alight over a moment and fading for most of the rest: a mote that
  // snaps off is a dropped frame, and one that is still at full brightness when
  // it goes is a hole appearing in the air.
  vFade = smoothstep(0.0, 0.12, u) * (1.0 - smoothstep(0.35, 1.0, u));

  /* ---- the billboard, turning about its own axis ---- */
  vec4 viewPos = viewMatrix * vec4(pos, 1.0);
  float angle = aSpin * age + phase;
  float c = cos(angle);
  float s = sin(angle);
  vec2 corner = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
  viewPos.xy += corner * size;
  gl_Position = projectionMatrix * viewPos;

  vShape = position.xy;
  vSeed = aSeed;
}
`;

/**
 * One mote: a diamond with a halo behind it.
 *
 * `|x| + |y|` is the whole shape. It is drawn twice — once hard, for the body
 * of the diamond, and once as a wide power falloff for the light coming off it
 * — because a mote that is only its own silhouette has no presence in the air
 * around it, and one that is only a halo is a smudge.
 */
const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform vec3 uCoreColor;
uniform float uHalo;
uniform float uSharpness;
uniform float uTwinkle;
uniform float uIntensity;

varying vec2 vShape;
varying float vSeed;
varying float vFade;

const float TAU = 6.28318530718;

void main() {
  if (vFade <= 0.0) discard;

  // The L1 distance: a diamond, for the price of the circle it replaces.
  float d = abs(vShape.x) + abs(vShape.y);
  if (d > 1.4) discard;

  float body = 1.0 - smoothstep(0.55 - uSharpness, 0.55 + uSharpness, d);
  float core = 1.0 - smoothstep(0.0, 0.34, d);
  // Round rather than diamond, and much wider: this is the light *around* the
  // mote, and light does not have corners.
  float halo = pow(max(0.0, 1.0 - length(vShape)), 3.0) * uHalo;

  // Each on its own beat, so a field of them shimmers instead of pulsing.
  float twinkle = 1.0 - uTwinkle * (0.5 - 0.5 * cos(uTime * 5.5 + vSeed * TAU));

  float gain = uIntensity * vFade * twinkle;
  vec3 rgb = uColor * (body * 0.6 + halo) + uCoreColor * core * 0.7;
  float a = (body * 0.6 + halo + core * 0.7) * gain;
  if (a < 0.004) discard;

  // Premultiplied against an additive blend: the alpha is the light.
  gl_FragColor = vec4(rgb * gain, a);
}
`;
