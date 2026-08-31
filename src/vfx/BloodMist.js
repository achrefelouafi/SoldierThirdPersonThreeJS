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

/** origin(3) velocity(3) seed birth life size spin kind — one particle, one stride. */
const STRIDE = 12;

/** A puff of atomised blood, hanging where a body was opened. */
const KIND_MIST = 0;
/** A drop of it, thrown clear and falling. */
const KIND_SPLATTER = 1;

/**
 * What comes out of a body when three feet of steel goes through it.
 *
 * ## Why this is not `vfx/BloodBurst.js`
 *
 * That one is a *spray*: a cone of droplets thrown along the blow, which is
 * what a cut across a torso throws and it is right for the sword. The second
 * panel of the reference is a different thing entirely — a **cloud**. Blood
 * atomised into the air and left hanging there, dark and dense in the middle,
 * thinning to a rust-coloured haze, with a scatter of hard specks flung out of
 * it. It is the layer that gives the ability its weight: strokes and rings are
 * light, and light alone has no *mass*. The mist is the only thing in the move
 * that is opaque.
 *
 * ## One system, two kinds
 *
 * Splitting them would mean two draw calls, two pools and two clocks for two
 * halves of one event, so `kind` is an attribute and the shader branches once:
 *
 *  - **mist** — large, slow, heavily eroded, expanding as it thins. Almost no
 *    gravity: it is a suspension, and a cloud that falls is a liquid.
 *  - **splatter** — small, fast, hard-edged, stretched along its own travel and
 *    pulled down properly. These are what stop the cloud reading as a smoke
 *    puff someone tinted red.
 *
 * ## Premultiplied, so one material can be dark *and* hot
 *
 * The obvious blend for blood is `NormalBlending`, and it is right for the body
 * of the cloud: this stuff **occludes**, and a mist that adds light to the frame
 * is not mist. But the reference's cloud also has embers glowing inside it, and
 * an alpha-blended fragment can never be brighter than its own colour.
 *
 * So the material is premultiplied: the shader outputs `rgb * a` and the pipe
 * blends `ONE, ONE_MINUS_SRC_ALPHA`. A fragment at `a = 0.9` with a colour of
 * 0.05 is near-black and hides what is behind it; a fragment at `a = 0.2` with
 * a colour of 6 is a spark that blooms. Both come out of one shader, one draw
 * call, and one sort.
 *
 * ## No simulation
 *
 * The CPU only births a particle — twelve floats into a ring buffer, never read
 * again — and the trajectory is a closed form in the vertex shader, exactly as
 * `vfx/HolyEmbers.js` does it: linear drag under a constant acceleration has an
 * exact solution, so a thousand particles cost one buffer write each and
 * nothing per frame afterwards.
 */
export class BloodMist {
  /** @param {number} capacity hard ceiling on particles in flight */
  constructor(capacity = 1536) {
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
    geometry.setAttribute('aSpin', new InterleavedBufferAttribute(this.buffer, 1, 10));
    geometry.setAttribute('aKind', new InterleavedBufferAttribute(this.buffer, 1, 11));
    geometry.instanceCount = 0;

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      // Tested: mist thrown behind a body is behind it, and the character can
      // walk in front of the cloud they made.
      depthTest: true,
      side: DoubleSide,
      blending: NormalBlending,
      // The whole point — see the class note. Without this the cloud can either
      // occlude or glow and not both.
      premultipliedAlpha: true,
      fog: false,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        /** The three reds: the dark heart, the body of it, and the hot specks. */
        uDeepColor: { value: makeColor('#12000d') },
        uColor: { value: makeColor('#6e0512') },
        uHotColor: { value: makeColor('#ff4326') },
        uDrag: { value: 2.4 },
        uGravity: { value: -6.5 },
        uMistSize: { value: 0.5 },
        uMistGrow: { value: 2.3 },
        uMistOpacity: { value: 0.72 },
        /** How ragged a puff's outline is, and how fast that ragging crawls. */
        uErode: { value: 0.62 },
        uDetail: { value: 2.6 },
        uChurn: { value: 0.5 },
        uSplatSize: { value: 0.055 },
        uSplatStretch: { value: 2.6 },
        uHot: { value: 0.55 },
        uIntensity: { value: 1.0 }
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'BloodMist';
    this.mesh.frustumCulled = false;
    // Under the strokes and over the ground: the cut is in front of what it
    // threw, which is the ordering that tells the eye which caused which.
    this.mesh.renderOrder = 6;
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.raycast = () => {};

    this._head = 0;
    this._written = 0;
    this._clock = 0;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Push this frame's uniforms.
   *
   * Called before anything can emit, so a particle born later in the same frame
   * is stamped with a clock the shader already agrees with.
   *
   * @param {number} time the simulation's clock
   * @param {object} config `settings.crimsonRite.mist`
   */
  sync(time, config) {
    const u = this.material.uniforms;

    this._clock = time;
    u.uTime.value = time;
    copyColor(u.uDeepColor.value, config.deepColor);
    copyColor(u.uColor.value, config.color);
    copyColor(u.uHotColor.value, config.hotColor);
    u.uDrag.value = Math.max(0.02, config.drag);
    u.uGravity.value = config.gravity;
    u.uMistSize.value = config.size;
    u.uMistGrow.value = config.grow;
    u.uMistOpacity.value = config.opacity;
    u.uErode.value = config.erode;
    u.uDetail.value = config.detail;
    u.uChurn.value = config.churn;
    u.uSplatSize.value = config.splatSize;
    u.uSplatStretch.value = config.splatStretch;
    u.uHot.value = config.hot;
    u.uIntensity.value = config.intensity;
  }

  /**
   * Open a body: a cloud where the steel went in, and drops thrown out of it.
   *
   * The two kinds are emitted from the same call because they are the same
   * event, and they are aimed differently on purpose: the **mist** is thrown
   * out in every direction with barely any speed, because a suspension has no
   * bearing, while the **splatter** is thrown down the blade's own line in a
   * cone. That difference is the whole reason the burst has a direction in it
   * without the cloud having to lean.
   *
   * @param {number} x world, the point of contact
   * @param {number} y
   * @param {number} z
   * @param {number} dx unit direction the steel was travelling
   * @param {number} dy
   * @param {number} dz
   * @param {object} config `settings.crimsonRite.mist`
   * @param {number} [strength] master on the counts, the speed and the size
   */
  burst(x, y, z, dx, dy, dz, config, strength = 1) {
    if (!config.enabled || strength <= 0) return;

    const startIndex = this._head;
    const mist = Math.min(Math.round(config.puffs * strength), this.capacity >> 2);
    const splat = Math.min(Math.round(config.drops * strength), this.capacity >> 2);

    /* ---- the cloud ---- */
    for (let i = 0; i < mist; i++) {
      // A ball rather than a cone, and biased *back* along the blade a little:
      // the cloud belongs to the wound, and a wound is behind the tip.
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const sin = Math.sin(phi);
      const speed = config.puffSpeed * (0.3 + Math.random() * 1.1) * strength;

      this._write(
        x - dx * config.setback * Math.random(),
        y - dy * config.setback * Math.random(),
        z - dz * config.setback * Math.random(),
        Math.cos(theta) * sin * speed,
        // A shade of lift on it. Atomised blood is lighter than the drops it
        // came from, and a cloud that only sinks reads as paint.
        Math.cos(phi) * speed + config.puffRise,
        Math.sin(theta) * sin * speed,
        Math.max(0.1, config.puffLife) * (0.6 + Math.random() * 0.8),
        0.55 + Math.random() * 0.9,
        (Math.random() - 0.5) * 2.2,
        KIND_MIST
      );
    }

    /* ---- and what was flung out of it ---- */
    for (let i = 0; i < splat; i++) {
      // A cone about the blade's line, opened by `spray`. `Math.random()` twice
      // over, so most drops are near the axis and a few are wide of it — an
      // evenly filled cone reads as a paint gun.
      const spread = config.spray * Math.random() * Math.random();
      const theta = Math.random() * Math.PI * 2;
      // Any vector square to the blade's line will do for a basis; this one is
      // built off whichever world axis the line is least parallel to.
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

      const sin = Math.sin(spread);
      const cos = Math.cos(spread);
      const ct = Math.cos(theta);
      const st = Math.sin(theta);
      const speed = config.dropSpeed * (0.4 + Math.random() * 1.3) * strength;

      this._write(
        x,
        y,
        z,
        (dx * cos + (ux * ct + vx * st) * sin) * speed,
        (dy * cos + (uy * ct + vy * st) * sin) * speed,
        (dz * cos + (uz * ct + vz * st) * sin) * speed,
        Math.max(0.1, config.dropLife) * (0.5 + Math.random() * 1.0),
        0.4 + Math.random() * 1.2,
        0,
        KIND_SPLATTER
      );
    }

    if (mist + splat <= 0) return;
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

  /** One particle into the ring. */
  _write(x, y, z, vx, vy, vz, life, size, spin, kind) {
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
    data[o + 11] = kind;

    this._head = (this._head + 1) % this.capacity;
    if (this._written < this.capacity) this._written++;
  }

  /** Everything in flight, gone — for leaving the stage and for a reset. */
  clear() {
    this.data.fill(0);
    this._head = 0;
    this._written = 0;
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
 * The trajectory, in closed form, and the billboard that carries it.
 *
 * Both kinds share the integration and differ only in what they do with the
 * result: a puff turns on its own axis and swells, and a drop is stretched
 * along the direction it is actually travelling *now* — which is the velocity
 * after drag and gravity, not the one it was born with, so a drop arcs over
 * and lies down as it falls.
 */
const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uDrag;
uniform float uGravity;
uniform float uMistSize;
uniform float uMistGrow;
uniform float uSplatSize;
uniform float uSplatStretch;

attribute vec3 aOrigin;
attribute vec3 aVelocity;
attribute float aSeed;
attribute float aBirth;
attribute float aLife;
attribute float aSize;
attribute float aSpin;
attribute float aKind;

varying vec2 vShape;
varying float vSeed;
varying float vFade;
varying float vAge;
varying float vKind;

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
    vAge = 0.0;
    vKind = 0.0;
    return;
  }

  float u = age / aLife;
  vAge = u;
  vSeed = aSeed;
  vKind = aKind;

  /* ---- drag under a constant acceleration, solved rather than stepped ---- */
  float k = uDrag;
  float decay = exp(-k * age);
  float impulse = (1.0 - decay) / k;
  vec3 gravity = vec3(0.0, uGravity, 0.0);
  vec3 pos = aOrigin + aVelocity * impulse + gravity * (age - impulse) / k;
  // The velocity *now*, which is what a drop is stretched along.
  vec3 vel = aVelocity * decay + gravity * (1.0 - decay) / k;

  float mist = step(aKind, 0.5);

  /* ---- how big, and how much is left ---- */
  // A puff swells as it thins — the same volume of stuff spread wider — and a
  // drop only shrinks a little as it dries.
  float size = mix(
    uSplatSize * aSize * (1.0 - 0.35 * u),
    uMistSize * aSize * (1.0 + uMistGrow * u),
    mist
  );
  // Mist arrives over a moment and hangs; a drop is simply there and then not.
  vFade = mix(
    1.0 - smoothstep(0.55, 1.0, u),
    smoothstep(0.0, 0.1, u) * (1.0 - smoothstep(0.3, 1.0, u)),
    mist
  );

  /* ---- the billboard ---- */
  vec4 viewPos = viewMatrix * vec4(pos, 1.0);

  if (mist > 0.5) {
    // Turning on its own axis, so a field of puffs does not read as one texture
    // stamped many times.
    float angle = aSpin * age + aSeed * TAU;
    float c = cos(angle);
    float s = sin(angle);
    vShape = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
    viewPos.xy += vShape * size;
    vShape = position.xy;
  } else {
    // Along the travel, in *view* space: the drop is a streak, and a streak has
    // to lie along the direction it appears to be going on screen rather than
    // the one it is going in the world.
    vec3 viewVel = mat3(viewMatrix) * vel;
    vec2 dir = viewVel.xy;
    float speed = length(dir);
    dir = speed > 1e-4 ? dir / speed : vec2(0.0, 1.0);
    vec2 side = vec2(-dir.y, dir.x);
    // Stretched by how fast it is actually going, so a drop at the top of its
    // arc is a dot and the same drop on the way down is a dash.
    float stretch = 1.0 + uSplatStretch * min(speed * 0.12, 1.4);
    viewPos.xy += (dir * position.y * stretch + side * position.x) * size;
    vShape = position.xy;
  }

  gl_Position = projectionMatrix * viewPos;
}
`;

/**
 * A puff, or a drop.
 *
 * The puff is where the work is. A round falloff alone is a smoke sprite, and
 * the reference's cloud is nothing like round — it is torn, clotted, darker in
 * its middle than at its edge. So the disc is eaten by a noise field that
 * crawls in its own space, thresholded against the age, and its *interior* is
 * darkened rather than brightened: the deep colour sits where the cloud is
 * thickest, which is the one thing that makes it read as volume rather than as
 * a glowing blob.
 */
const FRAGMENT = /* glsl */ `
${noiseGLSL}

uniform float uTime;
uniform vec3 uDeepColor;
uniform vec3 uColor;
uniform vec3 uHotColor;
uniform float uMistOpacity;
uniform float uErode;
uniform float uDetail;
uniform float uChurn;
uniform float uHot;
uniform float uIntensity;

varying vec2 vShape;
varying float vSeed;
varying float vFade;
varying float vAge;
varying float vKind;

const float TAU = 6.28318530718;

void main() {
  if (vFade <= 0.0) discard;

  float d = length(vShape);
  if (d > 1.0) discard;

  vec3 rgb;
  float a;

  if (vKind < 0.5) {
    /* ---- a puff of it ---- */
    float disc = 1.0 - smoothstep(0.25, 1.0, d);

    // Torn, and churning while it hangs. The field is offset per particle and
    // crawls slowly in z, so two puffs on the same frame are never the same
    // shape and one puff is never the same shape twice.
    vec3 p = vec3(vShape * uDetail, vSeed * 37.0 + uTime * uChurn);
    float grain = fbm3(p) * 0.5 + 0.5;
    // The threshold climbs with age: the cloud is eaten from the outside in as
    // it disperses, rather than dimming where it stands.
    float bite = mix(0.0, uErode, vAge) + (1.0 - disc) * uErode;
    float body = disc * smoothstep(bite, bite + 0.3, grain);
    if (body <= 0.002) discard;

    // Thickest in the middle, and the middle is the *darkest* part — that
    // inversion is the whole difference between a cloud and a light.
    float depth = smoothstep(0.15, 0.85, body);
    rgb = mix(uColor, uDeepColor, depth * 0.85);
    // And a few hot grains caught in it, where the noise happens to peak.
    float ember = smoothstep(0.82, 0.98, grain) * uHot * (1.0 - vAge);
    rgb += uHotColor * ember * 3.0;

    a = body * uMistOpacity * vFade;
  } else {
    /* ---- a drop ---- */
    // Hard: a drop of blood has an edge on it, and the small amount of feather
    // here is anti-aliasing rather than softness.
    float body = 1.0 - smoothstep(0.62, 0.92, d);
    if (body <= 0.002) discard;

    // Dark at the rim and lit through the middle, which is what a wet thing
    // does with a night sky behind it.
    float core = 1.0 - smoothstep(0.0, 0.45, d);
    rgb = mix(uDeepColor, uColor, core);
    rgb += uHotColor * core * uHot * 1.6 * (1.0 - vAge * vAge);
    a = body * vFade;
  }

  a *= uIntensity;
  if (a < 0.004) discard;

  // Premultiplied: the pipe is ONE, ONE_MINUS_SRC_ALPHA — so a dark fragment
  // at high alpha hides the frame and a bright one at low alpha adds to it.
  gl_FragColor = vec4(rgb * a, a);
}
`;
