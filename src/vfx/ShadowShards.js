import {
  BufferAttribute,
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

/** Floats per shard: origin, velocity, seed, birth, life, size, tumble. */
const STRIDE = 11;

/**
 * The shatter — what the reference's second panel actually is.
 *
 * ## Look at the panel rather than assuming
 *
 * It is not a puff of smoke and it is not a spray of sparks. It is a **black
 * mass coming apart into hard-edged pieces**: flat angular fragments, straight
 * edges, real corners, at wildly different sizes, thrown out of a middle so
 * dense it is a hole in the frame — and the only colour in it is a violet line
 * along the fractures. Every other particle system in this project draws either
 * a round thing (`vfx/BloodMist.js`, `vfx/ShadowSwirl.js`) or a straight streak
 * (`vfx/CinderStreaks.js`), and neither can make this: a cloud of eroded
 * circles is smoke however dark it is, and smoke is precisely what the panel is
 * not. Something *solid* is being broken.
 *
 * So the silhouette is the whole module, and it is built the only way a hard
 * edge survives being a billboard: the quad is a bounding box and the shape is
 * cut out of it in the fragment shader as the **intersection of five
 * half-planes**, with the corners hashed off the instance's own seed. Five
 * straight edges, five corners, a different piece every time, one draw call for
 * all of them, and no geometry on the bus.
 *
 * ## Dark that occludes and edges that burn, out of one material
 *
 * A shard has to do two opposite things at once. Its body must *take light
 * away* — it is a piece of something opaque, and on a night stage a fragment
 * that added would be a grey blob rather than a hole. Its fractures must
 * **add**: they are where the violet is getting through, and on dark ground
 * they are the only reason the field reads at all.
 *
 * Premultiplied alpha does both, exactly as `vfx/RiteRings.js` does it on the
 * floor. The shader writes `rgb * a` into a `ONE, ONE_MINUS_SRC_ALPHA` pipe, so
 * one fragment can be near-black at high alpha (the facet, which hides what is
 * behind it) and another far brighter than white at low alpha (the fracture,
 * which is light coming through the crack). One material, one sort.
 *
 * ## No simulation
 *
 * The CPU writes eleven floats per shard and never touches it again. Drag under
 * a constant acceleration has a closed form, so the trajectory and the tumble
 * are both evaluated in the vertex shader — the same arrangement
 * `vfx/CinderStreaks.js` uses, and for the same reason: a burst of a hundred
 * and twenty pieces costs one buffer write and nothing per frame afterwards.
 * The buffer is a ring; a spent shard folds to a degenerate point and costs the
 * rasteriser nothing.
 */
export class ShadowShards {
  /** @param {number} capacity hard ceiling on shards in flight */
  constructor(capacity = 512) {
    this.capacity = capacity;

    this.data = new Float32Array(capacity * STRIDE);
    this.buffer = new InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buffer.setUsage(DynamicDrawUsage);

    const geometry = new InstancedBufferGeometry();
    // One quad, corners in [-1, 1]. It is a *bounding box*, not the shape — the
    // shape is cut out of it per fragment, so a vertex only has to say which
    // corner it is.
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
      depthWrite: false,
      // Tested. A fragment thrown behind the body has to go behind the body:
      // this is the one layer in the ability with genuine mass, and mass that
      // drew over everything would read as dirt on the lens.
      depthTest: true,
      blending: NormalBlending,
      // The whole reason a facet can be darker than the ground while its
      // fracture is brighter than white. See the class note.
      premultipliedAlpha: true,
      fog: false,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        /** The facet. Nearly black — it is a piece of the dark, not a grey. */
        uColor: { value: makeColor('#08040f') },
        /** The fringe along an edge, where the aura catches it. */
        uRimColor: { value: makeColor('#8b5cf6') },
        /** And the heat in the fracture itself. */
        uCoreColor: { value: makeColor('#e9dcff') },
        uOpacity: { value: 0.95 },
        uRim: { value: 0.9 },
        uRimWidth: { value: 0.14 },
        uHeat: { value: 2.6 },
        /** Radians the hashed corners may wander off even spacing. */
        uJagged: { value: 0.55 },
        uSoftness: { value: 0.06 },
        uChurn: { value: 0.35 },
        uSize: { value: 0.17 },
        uGrow: { value: 0.55 },
        uSpin: { value: 3.4 },
        uDrag: { value: 2.2 },
        uGravity: { value: -7.5 }
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'ShadowShards';
    this.mesh.frustumCulled = false;
    // Over the smoke and under the strokes: the debris is in front of the aura
    // it was thrown out of, and the steel's own trails are in front of that.
    this.mesh.renderOrder = 8;
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
   * Called before anything can emit, so a shard born later in the same frame is
   * stamped with a clock the shader already agrees with.
   *
   * @param {number} time the simulation's clock
   * @param {object} config `settings.shadowExecution.shards`
   */
  sync(time, config) {
    const u = this.material.uniforms;

    this._clock = time;
    u.uTime.value = time;
    copyColor(u.uColor.value, config.color);
    copyColor(u.uRimColor.value, config.rimColor);
    copyColor(u.uCoreColor.value, config.coreColor);
    u.uOpacity.value = config.opacity;
    u.uRim.value = config.rim;
    u.uRimWidth.value = Math.max(0.01, config.rimWidth);
    u.uHeat.value = config.heat;
    u.uJagged.value = config.jagged;
    u.uSoftness.value = Math.max(0.005, config.softness);
    u.uChurn.value = config.churn;
    u.uSize.value = Math.max(0.005, config.size);
    u.uGrow.value = config.grow;
    u.uSpin.value = config.spin;
    u.uDrag.value = Math.max(0.05, config.drag);
    u.uGravity.value = config.gravity;
  }

  /**
   * Break something open, in every direction at once.
   *
   * @param {number} x world
   * @param {number} y
   * @param {number} z
   * @param {number} count how many pieces
   * @param {object} config `settings.shadowExecution.shards`
   * @param {number} [strength] master on how fast and how big they go
   * @param {number} [radius] metres they are born within, so the burst has a
   *   volume rather than every piece leaving one point
   */
  burst(x, y, z, count, config, strength = 1, radius = 0) {
    if (!config.enabled) return;
    const wanted = Math.min(Math.max(0, Math.round(count)), this.capacity >> 1);
    if (wanted <= 0) return;

    const start = this._head;
    for (let i = 0; i < wanted; i++) {
      // An even scatter on the sphere. `acos` of a uniform is what keeps a
      // burst from banding at its own poles, which is the giveaway of a bearing
      // picked from two uniform angles.
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const sin = Math.sin(phi);
      this._throw(
        x,
        y,
        z,
        Math.cos(theta) * sin,
        Math.cos(phi),
        Math.sin(theta) * sin,
        config,
        strength,
        radius
      );
    }
    this._flush(start);
  }

  /**
   * Break something open along a line — a cone about the way the steel came in.
   *
   * The stab's own burst. A blade goes in on a bearing and what it breaks
   * leaves *past* it, so this is a cone rather than a sphere; `spread` is how
   * wide, in radians, and 0 would be a lance of debris.
   *
   * @param {number} x world, where the point is
   * @param {number} y
   * @param {number} z
   * @param {number} dx the unit line it came in on
   * @param {number} dy
   * @param {number} dz
   * @param {number} count how many pieces
   * @param {object} config `settings.shadowExecution.shards`
   * @param {number} [strength] master on how fast and how big they go
   */
  shed(x, y, z, dx, dy, dz, count, config, strength = 1) {
    if (!config.enabled) return;
    const wanted = Math.min(Math.max(0, Math.round(count)), this.capacity >> 1);
    if (wanted <= 0) return;

    // A basis about the line, so the cone opens round the bearing rather than
    // round whichever axis the caller happened to be working in.
    let ax = 0;
    let ay = 1;
    let az = 0;
    if (Math.abs(dy) > 0.94) {
      ax = 1;
      ay = 0;
    }
    let rx = ay * dz - az * dy;
    let ry = az * dx - ax * dz;
    let rz = ax * dy - ay * dx;
    const length = Math.hypot(rx, ry, rz) || 1;
    rx /= length;
    ry /= length;
    rz /= length;
    const ux = dy * rz - dz * ry;
    const uy = dz * rx - dx * rz;
    const uz = dx * ry - dy * rx;

    const spread = Math.max(0, config.spread);
    const start = this._head;
    for (let i = 0; i < wanted; i++) {
      const angle = Math.random() * Math.PI * 2;
      // Square-rooted, so the cone fills evenly instead of crowding its axis.
      const reach = Math.tan(spread) * Math.sqrt(Math.random());
      const ox = Math.cos(angle) * reach;
      const oy = Math.sin(angle) * reach;
      let vx = dx + rx * ox + ux * oy;
      let vy = dy + ry * ox + uy * oy;
      let vz = dz + rz * ox + uz * oy;
      const reachLength = Math.hypot(vx, vy, vz) || 1;
      vx /= reachLength;
      vy /= reachLength;
      vz /= reachLength;
      this._throw(x, y, z, vx, vy, vz, config, strength, 0);
    }
    this._flush(start);
  }

  /** Kill everything in flight — for leaving the stage and for a reset. */
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

  /* ------------------------------------------------------------------ */

  /** One piece, on its own bearing at its own speed. */
  _throw(x, y, z, dx, dy, dz, config, strength, radius) {
    // The spread of *speeds* is what gives the burst its shape: a handful run
    // clean out of the frame and most of them barely leave the middle, which is
    // the dense black heart the panel is built round. A set that all left at one
    // speed would be an expanding shell, which is a bubble and not a shatter.
    const roll = Math.random();
    const speed = config.speed * strength * (0.16 + roll * roll * 1.6);
    const scale = Math.random();
    const size = 0.35 + scale * scale * 1.9;
    const spawn = radius * Math.random();
    const o = this._head * STRIDE;
    const data = this.data;

    data[o] = x + dx * spawn;
    data[o + 1] = y + dy * spawn;
    data[o + 2] = z + dz * spawn;
    data[o + 3] = dx * speed;
    // Everything gets a little lift on top of its bearing, so the field hangs
    // for a moment before the fall takes it. Debris that only falls is gravel.
    data[o + 4] = dy * speed + config.rise * (0.4 + Math.random());
    data[o + 5] = dz * speed;
    data[o + 6] = Math.random() * 64;
    data[o + 7] = this._clock;
    data[o + 8] = Math.max(0.05, config.life * (0.6 + Math.random() * 0.8));
    data[o + 9] = size * strength;
    // Signed, so half the field tumbles the other way. A set that all turned one
    // way reads as a texture scrolling.
    data[o + 10] = (Math.random() - 0.5) * 2;

    this._head = (this._head + 1) % this.capacity;
    if (this._written < this.capacity) this._written++;
  }

  /**
   * Send up only what was written.
   *
   * A ring that wrapped this frame is two spans, which is still a fraction of
   * restreaming the pool.
   */
  _flush(start) {
    this.mesh.geometry.instanceCount = this._written;
    if (this._head > start) {
      this.buffer.addUpdateRange(start * STRIDE, (this._head - start) * STRIDE);
    } else {
      this.buffer.addUpdateRange(start * STRIDE, (this.capacity - start) * STRIDE);
      if (this._head > 0) this.buffer.addUpdateRange(0, this._head * STRIDE);
    }
    this.buffer.needsUpdate = true;
  }
}

/* -------------------------------------------------------------------- */

/**
 * One shard, thrown and tumbling.
 *
 * The trajectory is drag under a constant acceleration, solved rather than
 * stepped — the same closed form `vfx/CinderStreaks.js` uses. The tumble is one
 * rotation of the quad's corners in *view* space: a flat fragment turning about
 * the view axis reads as a piece of debris spinning, and it costs a `mat2`.
 */
const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uDrag;
uniform float uGravity;
uniform float uSize;
uniform float uGrow;
uniform float uSpin;

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
varying float vHeat;

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
    vHeat = 0.0;
    return;
  }

  float u = age / aLife;

  /* ---- drag under a constant acceleration, solved rather than stepped ---- */
  float k = uDrag;
  float decay = exp(-k * age);
  float impulse = (1.0 - decay) / k;
  vec3 gravity = vec3(0.0, uGravity, 0.0);
  vec3 pos = aOrigin + aVelocity * impulse + gravity * (age - impulse) / k;

  // Whole for most of its life and then gone: a piece of something solid does
  // not thin out the way smoke does, so the fade is held flat and dropped late.
  vFade = smoothstep(0.0, 0.05, u) * (1.0 - smoothstep(0.52, 1.0, u));
  // The violet in the fracture cooling. It is the heat of the blow that opened
  // the piece, and it goes out well before the piece does.
  vHeat = (1.0 - u) * (1.0 - u);

  /* ---- the tumble ---- */
  float roll = aSeed * TAU + aSpin * uSpin * age;
  float c = cos(roll);
  float s = sin(roll);
  vec2 corner = mat2(c, s, -s, c) * position.xy;

  float size = uSize * aSize * (1.0 + uGrow * u);

  vec4 viewPos = viewMatrix * vec4(pos, 1.0);
  viewPos.xy += corner * size;
  gl_Position = projectionMatrix * viewPos;

  // Unrotated, so the polygon is cut in the shard's own frame and therefore
  // turns with it.
  vShape = position.xy;
  vSeed = aSeed;
}
`;

/**
 * The silhouette: five half-planes, hashed off the seed.
 *
 * Every edge is the straight boundary of one half-plane and every corner is
 * where two of them meet, which is the one thing a noise field cannot give and
 * the whole reason the panel reads as something *broken* rather than something
 * burnt. The radii are hashed per corner, so pieces come out as darts, wedges
 * and slabs from one rule — and a corner whose two neighbours are nearly in line
 * simply disappears, which is why a five-sided generator produces plenty of
 * three- and four-sided pieces.
 */
const FRAGMENT = /* glsl */ `
${noiseGLSL}

uniform float uTime;
uniform vec3 uColor;
uniform vec3 uRimColor;
uniform vec3 uCoreColor;
uniform float uOpacity;
uniform float uRim;
uniform float uRimWidth;
uniform float uHeat;
uniform float uJagged;
uniform float uSoftness;
uniform float uChurn;

varying vec2 vShape;
varying float vSeed;
varying float vFade;
varying float vHeat;

const float TAU = 6.28318530718;
const int FACETS = 5;

/**
 * The nth corner of this shard, in its own [-1, 1] frame.
 *
 * The radius is hashed and then **squared**, which is the line that decides
 * what the field looks like. A uniform radius gives five corners at five
 * comparable distances, which is a pentagon however far the angles are jittered
 * — and a hail of pentagons is the one result that reads as a decal rather than
 * as debris. Squaring crowds the distribution down near the middle, so most
 * pieces have one or two corners collapsed almost onto the origin and come out
 * as triangles, slivers and darts, with the occasional broad slab among them.
 * That mixture is the reference's second panel.
 */
vec2 facet(int index) {
  float f = float(index);
  float angle = f / float(FACETS) * TAU + (hash11(vSeed * 13.7 + f * 3.17) - 0.5) * uJagged;
  float reach = hash11(vSeed * 29.3 + f * 7.71);
  return vec2(cos(angle), sin(angle)) * mix(0.14, 1.0, reach * reach);
}

void main() {
  if (vFade <= 0.002) discard;

  // Signed distance to the intersection of the five edges: negative inside,
  // positive out, and the value itself is how far from an edge a fragment is —
  // which is the only thing the rim needs.
  float d = -1e3;
  for (int i = 0; i < FACETS; i++) {
    int j = i + 1;
    if (j == FACETS) j = 0;
    vec2 v0 = facet(i);
    vec2 v1 = facet(j);
    vec2 edge = v1 - v0;
    vec2 outward = normalize(vec2(edge.y, -edge.x));
    d = max(d, dot(vShape - v0, outward));
  }

  if (d > uRimWidth) discard;

  // The facet, and the line round it. The body is held solid right up to the
  // edge — a soft-edged shard is a smudge, so the softness here is a pixel of
  // anti-aliasing rather than a falloff.
  float body = 1.0 - smoothstep(-uSoftness, 0.0, d);
  float rim = 1.0 - smoothstep(0.0, uRimWidth, abs(d));

  // And only the edges that are *facing* something catch it.
  //
  // This one line is the difference between debris and cut-out paper. A rim
  // applied evenly draws a closed outline round every piece, and a field of
  // outlined black polygons reads as stickers however good the silhouettes
  // are — the eye knows that a solid object lit from somewhere has a bright
  // side and a dark side. So each shard is given a bearing of its own, hashed
  // off its seed, and the fringe is weighted by how squarely a fragment's edge
  // turns toward it: two or three lit edges per piece, the rest going into the
  // dark, and the black mass in the middle of the burst finally reads as mass.
  float bearing = hash11(vSeed * 5.31) * TAU;
  vec2 toward = vec2(cos(bearing), sin(bearing));
  float facing = smoothstep(-0.4, 0.95, dot(normalize(vShape + 1e-4), toward));
  rim *= 0.14 + 0.86 * facing;

  // What is getting through the piece: a coarse field, thresholded hard, so it
  // is a *crack* across the facet rather than a mottling of it.
  float grain = fbm3(vec3(vShape * 2.4, vSeed * 11.0 + uTime * uChurn));
  float split = smoothstep(0.66, 0.94, grain) * body;

  vec3 rgb = mix(uColor, uRimColor, clamp(rim * uRim, 0.0, 1.0));
  // Weighted toward the fracture rather than the edge: a piece lit round its
  // whole outline is the failure above wearing a brighter coat.
  rgb += uCoreColor * (rim * rim * 0.7 + split * 1.2) * uHeat * vHeat;

  float a = clamp(max(body, rim * 0.8), 0.0, 1.0) * vFade * uOpacity;
  if (a < 0.004) discard;

  // Premultiplied: the facet is dark at high coverage and hides what is behind
  // it, the fracture is far brighter than white at low coverage and adds. See
  // the class note.
  gl_FragColor = vec4(rgb * a, a);
}
`;
