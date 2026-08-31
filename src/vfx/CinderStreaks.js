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

/** origin(3) velocity(3) seed birth life size stretch — one cinder, one stride. */
const STRIDE = 11;

/**
 * The sparks thrown off the edge, and the ones left hanging afterwards.
 *
 * ## What the fifth panel is, exactly
 *
 * Look at it rather than assuming: it is **not** a cloud of round glowing dots.
 * It is a field of short, hard, straight **streaks** at every angle, of wildly
 * different lengths, with a scatter of near-points among them. That mixture is
 * the whole character of it — a field of uniform dots is dust, a field of
 * uniform streaks is rain, and the reference is neither.
 *
 * The mixture is not authored as two kinds. It falls out of one rule: a cinder
 * is drawn **stretched along the direction it is actually travelling**, by an
 * amount proportional to how fast it is going *now*. A fast one is a long
 * streak; the same cinder, once drag has taken it, is a dot. So a burst that
 * throws a spread of speeds produces the reference's spread of lengths for
 * free, and every cinder walks down that spread over its own life.
 *
 * ## Why it is separate from the blood
 *
 * `vfx/BloodMist.js` also throws small fast things and also stretches them, and
 * for a moment it looks like one system could do both. It cannot, and the
 * reason is the blend: blood is **wet** — dark, occluding, premultiplied over
 * the frame — and a cinder is **light**, additive, brighter than anything
 * behind it. One is matter and the other is energy. They differ in every term
 * that matters and share only a billboard.
 *
 * ## No simulation
 *
 * The CPU births a cinder and never touches it again. Drag under a constant
 * acceleration has a closed form, so the whole trajectory — and the velocity
 * the streak is aligned and scaled by — is evaluated in the vertex shader from
 * eleven floats written once. The buffer is a ring; a spent cinder is folded to
 * a degenerate point and costs the rasteriser nothing.
 */
export class CinderStreaks {
  /** @param {number} capacity hard ceiling on cinders in flight */
  constructor(capacity = 1024) {
    this.capacity = capacity;

    this.data = new Float32Array(capacity * STRIDE);
    this.buffer = new InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buffer.setUsage(DynamicDrawUsage);

    const geometry = new InstancedBufferGeometry();
    // One quad, corners in [-1, 1]. The billboard is built in view space, so a
    // vertex only has to say which corner it is.
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
    geometry.setAttribute('aStretch', new InterleavedBufferAttribute(this.buffer, 1, 10));
    geometry.instanceCount = 0;

    this.material = new ShaderMaterial({
      transparent: true,
      // Light, so it adds; and tested, so a cinder behind the body is behind it.
      depthWrite: false,
      depthTest: true,
      side: DoubleSide,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: makeColor('#ff2f14') },
        uCoreColor: { value: makeColor('#ffd6b4') },
        uDrag: { value: 1.5 },
        uGravity: { value: -2.2 },
        uSize: { value: 0.03 },
        /** How much of the streak's length comes from its speed. */
        uStretch: { value: 1.9 },
        uMaxStretch: { value: 9.0 },
        /** How much of the halo there is around the hard line. */
        uHalo: { value: 0.5 },
        uIntensity: { value: 3.0 },
        /** Depth and beat of the flicker each cinder is on. */
        uFlicker: { value: 0.4 },
        uFlickerSpeed: { value: 22.0 }
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'CinderStreaks';
    this.mesh.frustumCulled = false;
    // The topmost layer of the ability: cinders pass in front of the strokes
    // and the ink, and that ordering is most of what gives the move depth.
    this.mesh.renderOrder = 9;
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.raycast = () => {};

    this._head = 0;
    this._written = 0;
    this._clock = 0;
    /** Fractional cinders carried between frames, so a slow rate is not lost. */
    this._debt = 0;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Push this frame's uniforms.
   *
   * Called before anything can emit, so a cinder born later in the same frame
   * is stamped with a clock the shader already agrees with.
   *
   * @param {number} time the simulation's clock
   * @param {object} config `settings.crimsonRite.cinders`
   */
  sync(time, config) {
    const u = this.material.uniforms;

    this._clock = time;
    u.uTime.value = time;
    copyColor(u.uColor.value, config.color);
    copyColor(u.uCoreColor.value, config.coreColor);
    u.uDrag.value = Math.max(0.02, config.drag);
    u.uGravity.value = config.gravity;
    u.uSize.value = config.size;
    u.uStretch.value = config.stretch;
    u.uMaxStretch.value = Math.max(1, config.maxStretch);
    u.uHalo.value = config.halo;
    u.uIntensity.value = config.intensity;
    u.uFlicker.value = config.flicker;
    u.uFlickerSpeed.value = config.flickerSpeed;
  }

  /**
   * Throw a handful out of a point, in every direction.
   *
   * The speed is spread hard on purpose — `pow(random, 3)` between a third of
   * the speed and all of it — because the *spread of speeds is the spread of
   * lengths*, and an evenly sampled one gives a field of streaks that are all
   * much the same. Most cinders should be nearly stationary points and a few
   * should be tearing across the frame.
   *
   * @param {number} x world
   * @param {number} y
   * @param {number} z
   * @param {number} count how many
   * @param {object} config `settings.crimsonRite.cinders`
   * @param {number} [strength] master on their speed, size and reach
   * @param {number} [radius] metres out from the point they may be born
   */
  spray(x, y, z, count, config, strength = 1, radius = 0) {
    const wanted = Math.min(Math.max(0, Math.round(count)), this.capacity >> 1);
    if (wanted <= 0 || !config.enabled) return;

    const startIndex = this._head;
    const speed = Math.max(0, config.speed) * strength;
    const life = Math.max(0.05, config.life);

    for (let i = 0; i < wanted; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const sin = Math.sin(phi);
      const roll = Math.random();
      const v = speed * (0.25 + 0.75 * roll * roll * roll);

      const r = radius * Math.cbrt(Math.random());
      this._write(
        x + Math.cos(theta) * sin * r,
        y + Math.cos(phi) * r,
        z + Math.sin(theta) * sin * r,
        Math.cos(theta) * sin * v,
        // A little lift on top of whatever it was thrown with: these are embers
        // and they should not simply rain.
        Math.cos(phi) * v + config.rise,
        Math.sin(theta) * sin * v,
        life * (0.4 + Math.random() * 1.2),
        0.5 + Math.random() * 1.1,
        // Its own share of the stretch, so two cinders at the same speed are
        // still not the same length.
        0.6 + Math.random() * 0.9
      );
    }

    this._flush(startIndex);
  }

  /**
   * Throw a fan of them along a line — what an edge going through something
   * actually sheds.
   *
   * The difference from `spray` is the aim: these leave in a cone about
   * `(dx, dy, dz)`, so the shower has a *direction* in it and reads as having
   * been struck off something rather than as having welled up.
   *
   * @param {number} x world, the point of contact
   * @param {number} y
   * @param {number} z
   * @param {number} dx unit direction the edge was travelling
   * @param {number} dy
   * @param {number} dz
   * @param {number} count how many
   * @param {object} config `settings.crimsonRite.cinders`
   * @param {number} [strength] master on their speed and size
   */
  shed(x, y, z, dx, dy, dz, count, config, strength = 1) {
    const wanted = Math.min(Math.max(0, Math.round(count)), this.capacity >> 1);
    if (wanted <= 0 || !config.enabled) return;

    // A basis square to the line, built off whichever world axis the line is
    // least parallel to.
    let ax = 0;
    let ay = 1;
    let az = 0;
    if (Math.abs(dy) > 0.9) {
      ax = 1;
      ay = 0;
    }
    let ux = ay * dz - az * dy;
    let uy = az * dx - ax * dz;
    let uz = ax * dy - ay * dx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const vx = dy * uz - dz * uy;
    const vy = dz * ux - dx * uz;
    const vz = dx * uy - dy * ux;

    const startIndex = this._head;
    const speed = Math.max(0, config.speed) * strength;
    const life = Math.max(0.05, config.life);
    const spread = config.spread;

    for (let i = 0; i < wanted; i++) {
      const angle = spread * Math.random() * Math.random();
      const theta = Math.random() * Math.PI * 2;
      const sin = Math.sin(angle);
      const cos = Math.cos(angle);
      const ct = Math.cos(theta);
      const st = Math.sin(theta);
      const roll = Math.random();
      const v = speed * (0.3 + 0.7 * roll * roll);

      this._write(
        x,
        y,
        z,
        (dx * cos + (ux * ct + vx * st) * sin) * v,
        (dy * cos + (uy * ct + vy * st) * sin) * v + config.rise,
        (dz * cos + (uz * ct + vz * st) * sin) * v,
        life * (0.35 + Math.random() * 1.1),
        0.5 + Math.random() * 1.1,
        0.7 + Math.random() * 1.0
      );
    }

    this._flush(startIndex);
  }

  /**
   * Let a few off, per second, for as long as something is burning.
   *
   * A *rate* rather than a count, so the density is a number in seconds and
   * does not change with the frame rate. The remainder is carried, which is
   * what lets a rate below one a frame still produce cinders instead of
   * rounding to none.
   *
   * @param {number} x world
   * @param {number} y
   * @param {number} z
   * @param {number} radius metres out they may be born
   * @param {number} rate cinders a second
   * @param {number} dt seconds
   * @param {object} config `settings.crimsonRite.cinders`
   * @param {number} [strength] master, passed through to `spray`
   */
  emit(x, y, z, radius, rate, dt, config, strength = 1) {
    if (rate <= 0 || dt <= 0) return;
    this._debt += rate * dt;
    const count = Math.floor(this._debt);
    if (count <= 0) return;
    this._debt -= count;
    this.spray(x, y, z, count, config, strength, radius);
  }

  /** One cinder into the ring. */
  _write(x, y, z, vx, vy, vz, life, size, stretch) {
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
    data[o + 10] = stretch;

    this._head = (this._head + 1) % this.capacity;
    if (this._written < this.capacity) this._written++;
  }

  /**
   * Send the span just written up the bus.
   *
   * A ring that wrapped this frame is two spans, which is still a fraction of
   * restreaming the whole pool.
   */
  _flush(startIndex) {
    if (this._head === startIndex) return;
    this.mesh.geometry.instanceCount = this._written;

    if (this._head > startIndex) {
      this.buffer.addUpdateRange(startIndex * STRIDE, (this._head - startIndex) * STRIDE);
    } else {
      this.buffer.addUpdateRange(startIndex * STRIDE, (this.capacity - startIndex) * STRIDE);
      if (this._head > 0) this.buffer.addUpdateRange(0, this._head * STRIDE);
    }
    this.buffer.needsUpdate = true;
  }

  /** Everything in flight, gone — for leaving the stage and for a reset. */
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
 * The trajectory, and the streak drawn along it.
 *
 * The alignment is done in **view** space rather than world space, and that is
 * not an optimisation: a streak has to lie along the direction the cinder
 * appears to be going *on screen*. A cinder flying straight at the lens is
 * going very fast and should be a point, and only its projected velocity knows
 * that.
 */
const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uDrag;
uniform float uGravity;
uniform float uSize;
uniform float uStretch;
uniform float uMaxStretch;

attribute vec3 aOrigin;
attribute vec3 aVelocity;
attribute float aSeed;
attribute float aBirth;
attribute float aLife;
attribute float aSize;
attribute float aStretch;

varying vec2 vShape;
varying float vSeed;
varying float vFade;
varying float vHeat;

void main() {
  float age = uTime - aBirth;

  // Not yet born, already spent, or a slot never written. Folded to a
  // degenerate point outside the clip volume, which the rasteriser drops free.
  if (aLife <= 0.0 || age < 0.0 || age >= aLife) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vShape = vec2(0.0);
    vSeed = 0.0;
    vFade = 0.0;
    vHeat = 0.0;
    return;
  }

  float u = age / aLife;
  vSeed = aSeed;

  /* ---- drag under a constant acceleration, solved rather than stepped ---- */
  float k = uDrag;
  float decay = exp(-k * age);
  float impulse = (1.0 - decay) / k;
  vec3 gravity = vec3(0.0, uGravity, 0.0);
  vec3 pos = aOrigin + aVelocity * impulse + gravity * (age - impulse) / k;
  vec3 vel = aVelocity * decay + gravity * (1.0 - decay) / k;

  // Struck alight instantly and cooling for the whole of the rest: an ember
  // that fades linearly reads as a light being turned down.
  vFade = 1.0 - u * u;
  // And a colour that walks from white-hot to red as it goes.
  vHeat = 1.0 - u;

  /* ---- the streak ---- */
  vec4 viewPos = viewMatrix * vec4(pos, 1.0);
  vec3 viewVel = mat3(viewMatrix) * vel;

  vec2 dir = viewVel.xy;
  float speed = length(dir);
  dir = speed > 1e-4 ? dir / speed : vec2(0.0, 1.0);
  vec2 side = vec2(-dir.y, dir.x);

  // The whole character of the field: length from speed, so one rule gives the
  // reference's mixture of long streaks and near-points.
  float stretch = 1.0 + min(speed * uStretch * aStretch, uMaxStretch);
  float size = uSize * aSize;

  viewPos.xy += (dir * position.y * stretch + side * position.x) * size;
  gl_Position = projectionMatrix * viewPos;

  vShape = position.xy;
}
`;

/**
 * One cinder: a hard capsule with a soft halo behind it.
 *
 * The shape is measured on the *unstretched* corner coordinates, so a streak
 * stays exactly as thick as a dot however long it has been drawn — a mask taken
 * on the stretched quad would thin the fast ones to nothing.
 */
const FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uCoreColor;
uniform float uHalo;
uniform float uIntensity;
uniform float uFlicker;
uniform float uFlickerSpeed;
uniform float uTime;

varying vec2 vShape;
varying float vSeed;
varying float vFade;
varying float vHeat;

const float TAU = 6.28318530718;

void main() {
  if (vFade <= 0.0) discard;

  // Across the streak only: along it the quad is already the right length, and
  // the ends are closed by the same falloff read on the other axis.
  float across = abs(vShape.x);
  float along = abs(vShape.y);
  float body = (1.0 - smoothstep(0.35, 1.0, across)) * (1.0 - smoothstep(0.55, 1.0, along));
  if (body <= 0.002) discard;

  float core = (1.0 - smoothstep(0.0, 0.4, across)) * (1.0 - smoothstep(0.0, 0.85, along));
  // Round rather than capsule, and wider: this is the light *around* the
  // cinder, and light has no ends.
  float halo = pow(max(0.0, 1.0 - length(vShape)), 3.0) * uHalo;

  // Each on its own beat, so a field of them shimmers instead of pulsing.
  float flicker = 1.0 - uFlicker * (0.5 - 0.5 * cos(uTime * uFlickerSpeed + vSeed * TAU));

  float gain = uIntensity * flicker;
  // White through the middle while it is hot, red once it is not.
  vec3 rgb = uColor * (body + halo) + uCoreColor * core * vHeat * 0.9;

  // Coverage only. The blend is SRC_ALPHA, ONE, so the pipe already multiplies
  // the colour by this — an alpha carrying the gain as well would apply it
  // twice and every cinder would burn out to a white capsule.
  float a = clamp((body + halo * 0.7 + core * vHeat * 0.5) * vFade, 0.0, 1.0);
  if (a < 0.004) discard;

  gl_FragColor = vec4(rgb * gain, a);
}
`;
