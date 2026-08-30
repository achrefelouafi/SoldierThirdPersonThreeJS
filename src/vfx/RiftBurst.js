import {
  AdditiveBlending,
  BufferAttribute,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InstancedMesh,
  InterleavedBufferAttribute,
  Matrix4,
  Mesh,
  RingGeometry,
  ShaderMaterial,
  Vector3
} from 'three';

import { frame } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { copyColor, makeColor } from '../utils/color.js';

/** Bursts alight at once. One is a finisher; three is two finishers overlapping. */
const CAPACITY = 3;
/** Rings thrown around each one. */
const RINGS = 3;
/** Ceiling on the motes in one burst's core, and on its shards. */
const MOTES = 320;
const SHARDS = 28;

/** origin(3) dir(3) reach size rate seed age — one mote, one stride. */
const MOTE_STRIDE = 11;
/** origin(3) dir(3) length width rate seed age — one shard, one stride. */
const SHARD_STRIDE = 11;
/** origin(3) radius age — one halo. */
const HALO_STRIDE = 5;
/** Where `age` sits in each of the three records above. */
const MOTE_AGE = 10;
const SHARD_AGE = 10;
const HALO_AGE = 4;

const TAU = Math.PI * 2;

const _forward = new Vector3();
const _right = new Vector3();
const _upAxis = new Vector3();
const _rolledRight = new Vector3();
const _rolledUp = new Vector3();
const _tiltedForward = new Vector3();
const _tiltedUp = new Vector3();
const _matrix = new Matrix4();
const _up = new Vector3(0, 1, 0);

/**
 * The thing that opens where the third cut lands.
 *
 * ## Why it is not another flash
 *
 * `vfx/BladeImpact.js` already draws what a blade arriving looks like, and the
 * finisher uses it — the star of spikes along the steel and the shower coming
 * off the edge are exactly right and there is no reason to draw them twice.
 * What that cannot do is say *this one was different*. A combo whose third beat
 * looks like its first two has no third beat; it has three first beats.
 *
 * ## The five layers
 *
 * So this is the one thing in the move that is not a cut: a sphere of light
 * torn open on the point of contact, built as **five layers stacked back to
 * front**, each of which is one draw call, one shader and one idea. They are
 * listed here in the order the frame is painted, which is also the order to
 * switch them off in when tuning — every one has its own `*Enabled` flag in
 * `settings.swordCombo.rift`, so any layer can be soloed against the rest and
 * judged on its own.
 *
 * 1. **The halo.** One broad camera-facing disc of violet, well outside
 *    everything else and gone in half a second. It is not a shape — it is the
 *    *air* around the burst being lit, and it is the layer doing the work the
 *    bloom pass is not: the stage runs at a bloom strength of hundredths, so
 *    anything meant to look like it is glowing has to draw its own glow.
 *
 * 2. **The shell.** A sphere drawn almost entirely on its rim: the fresnel term
 *    is the whole look, because a filled ball of additive light is a white blob
 *    and a rim is a volume. Its surface is displaced by noise that crawls over
 *    it as it opens, so the silhouette boils instead of inflating.
 *
 * 3. **The core.** A few hundred motes thrown out from the contact along their
 *    own bearings, most stopping around the shell and a handful running clean
 *    through it. Each is stretched along its own screen velocity, so the field
 *    reads as a *spray* of grain rather than a dot screen. This is the layer
 *    that gives the sphere an inside, and it is why the shell is allowed to
 *    stay a thin rim.
 *
 * 4. **The rings.** Flat annuli thrown out through everything on three
 *    different planes. They travel faster than the shell and thin as they go,
 *    so the shape the eye tracks is a sphere being outrun by its own shockwave.
 *    The first is laid across the line the blow came in on — it is the blow,
 *    seen side-on — and the other two are tilted off it so the burst has depth
 *    from any angle the camera happens to be at.
 *
 * 5. **The shards.** Long needles of light thrown radially, brightest a third
 *    of the way out and tapering to a point. The fastest layer by some way: out
 *    and gone inside a third of a second, before the shell has finished
 *    opening. This is what makes the burst read as something *breaking* rather
 *    than something expanding, and if only one control here is ever touched it
 *    should be `shardLength` — nothing else changes the silhouette of the
 *    finisher as much.
 *
 * Everything is pooled, additive and unlit; nothing here knows what caused it.
 */
export class RiftBurst {
  constructor() {
    /** Every layer, in one place. Add it to the scene. */
    this.group = new Group();
    this.group.name = 'RiftBurst';

    this._buildHalo();
    this._buildShell();
    this._buildCore();
    this._buildRings();
    this._buildShards();

    this.group.add(this.halo, this.shell, this.core, this.rings, this.shards);

    // Three burst records, allocated once and handed back and forth. A finisher
    // must never be the frame that allocates ten thousand floats.
    this._free = [];
    for (let i = 0; i < CAPACITY; i++) this._free.push(makeBurst());

    /** @type {object[]} */
    this.bursts = [];
  }

  /** Whether anything is still open. */
  get active() {
    return this.bursts.length > 0;
  }

  /* ------------------------------------------------------------------ */
  /* layer 1 — the halo                                                  */
  /* ------------------------------------------------------------------ */

  _buildHalo() {
    const geometry = quadGeometry(-1);
    this._haloData = new Float32Array(CAPACITY * HALO_STRIDE);
    this._haloBuffer = new InstancedInterleavedBuffer(this._haloData, HALO_STRIDE, 1);
    this._haloBuffer.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aOrigin', new InterleavedBufferAttribute(this._haloBuffer, 3, 0));
    geometry.setAttribute('aRadius', new InterleavedBufferAttribute(this._haloBuffer, 1, 3));
    geometry.setAttribute('aAge', new InterleavedBufferAttribute(this._haloBuffer, 1, 4));
    geometry.instanceCount = 0;

    this.haloMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uInnerColor: { value: makeColor('#4a5cff') },
        uOuterColor: { value: makeColor('#a86bff') },
        uIntensity: { value: 1.15 },
        uExposure: frame.uExposure
      },
      vertexShader: HALO_VERTEX,
      fragmentShader: HALO_FRAGMENT
    });

    this.halo = new Mesh(geometry, this.haloMaterial);
    this.halo.name = 'RiftHalo';
    this.halo.frustumCulled = false;
    this.halo.layers.set(LAYER.VFX);
    // Behind every other layer of the burst: it is the light in the air, and
    // the shapes are what is standing in front of it.
    this.halo.renderOrder = 11;
    this.halo.raycast = () => {};
  }

  /* ------------------------------------------------------------------ */
  /* layer 2 — the shell                                                 */
  /* ------------------------------------------------------------------ */

  _buildShell() {
    // Subdivided rather than a UV sphere: the vertex displacement is what gives
    // it its silhouette, and a UV sphere would gather all its resolution at the
    // poles and crease along the seam.
    const shell = new IcosahedronGeometry(1, 5);
    shell.setAttribute('aAge', new InstancedBufferAttribute(new Float32Array(CAPACITY), 1));
    shell.setAttribute('aSeed', new InstancedBufferAttribute(new Float32Array(CAPACITY), 1));

    this.shellMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      fog: false,
      toneMapped: false,
      uniforms: {
        uCoreColor: { value: makeColor('#ffffff') },
        uRimColor: { value: makeColor('#89b9ff') },
        uDeepColor: { value: makeColor('#3a2ce0') },
        uIntensity: { value: 3.2 },
        uFresnel: { value: 2.4 },
        uChurn: { value: 0.34 },
        uChurnSpeed: { value: 2.6 },
        uExposure: frame.uExposure
      },
      vertexShader: SHELL_VERTEX,
      fragmentShader: SHELL_FRAGMENT
    });

    this.shell = new InstancedMesh(shell, this.shellMaterial, CAPACITY);
    this.shell.count = 0;
    this.shell.frustumCulled = false;
    this.shell.layers.set(LAYER.VFX);
    this.shell.renderOrder = 13;
    this.shell.name = 'RiftShells';
    this.shell.raycast = () => {};

    this._shellAges = shell.getAttribute('aAge');
    this._shellSeeds = shell.getAttribute('aSeed');
  }

  /* ------------------------------------------------------------------ */
  /* layer 3 — the core                                                  */
  /* ------------------------------------------------------------------ */

  _buildCore() {
    const geometry = quadGeometry(-1);
    this._moteData = new Float32Array(CAPACITY * MOTES * MOTE_STRIDE);
    this._moteBuffer = new InstancedInterleavedBuffer(this._moteData, MOTE_STRIDE, 1);
    this._moteBuffer.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aOrigin', new InterleavedBufferAttribute(this._moteBuffer, 3, 0));
    geometry.setAttribute('aDir', new InterleavedBufferAttribute(this._moteBuffer, 3, 3));
    geometry.setAttribute('aReach', new InterleavedBufferAttribute(this._moteBuffer, 1, 6));
    geometry.setAttribute('aSize', new InterleavedBufferAttribute(this._moteBuffer, 1, 7));
    geometry.setAttribute('aRate', new InterleavedBufferAttribute(this._moteBuffer, 1, 8));
    geometry.setAttribute('aSeed', new InterleavedBufferAttribute(this._moteBuffer, 1, 9));
    geometry.setAttribute('aAge', new InterleavedBufferAttribute(this._moteBuffer, 1, 10));
    geometry.instanceCount = 0;

    this.coreMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uCoreColor: { value: makeColor('#ffffff') },
        uMoteColor: { value: makeColor('#bcd8ff') },
        uIntensity: { value: 2.4 },
        uStretch: { value: 0.02 },
        uExposure: frame.uExposure
      },
      vertexShader: MOTE_VERTEX,
      fragmentShader: MOTE_FRAGMENT
    });

    this.core = new Mesh(geometry, this.coreMaterial);
    this.core.name = 'RiftCore';
    this.core.frustumCulled = false;
    this.core.layers.set(LAYER.VFX);
    this.core.renderOrder = 14;
    this.core.raycast = () => {};
  }

  /* ------------------------------------------------------------------ */
  /* layer 4 — the rings                                                 */
  /* ------------------------------------------------------------------ */

  _buildRings() {
    // A wide annulus so the shader has room to put the band anywhere inside it
    // as the ring thins; the geometry is a canvas, not the shape.
    const ring = new RingGeometry(0.18, 1, 96, 1);
    ring.setAttribute('aAge', new InstancedBufferAttribute(new Float32Array(CAPACITY * RINGS), 1));
    ring.setAttribute('aSeed', new InstancedBufferAttribute(new Float32Array(CAPACITY * RINGS), 1));

    this.ringMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      fog: false,
      toneMapped: false,
      uniforms: {
        uCoreColor: { value: makeColor('#ffffff') },
        uRingColor: { value: makeColor('#c58cff') },
        uIntensity: { value: 3.6 },
        uWidth: { value: 0.09 },
        uSoftness: { value: 0.16 },
        uSpokes: { value: 26 },
        uSpokeDepth: { value: 0.45 },
        uExposure: frame.uExposure
      },
      vertexShader: RING_VERTEX,
      fragmentShader: RING_FRAGMENT
    });

    this.rings = new InstancedMesh(ring, this.ringMaterial, CAPACITY * RINGS);
    this.rings.count = 0;
    this.rings.frustumCulled = false;
    this.rings.layers.set(LAYER.VFX);
    this.rings.renderOrder = 15;
    this.rings.name = 'RiftRings';
    this.rings.raycast = () => {};

    this._ringAges = ring.getAttribute('aAge');
    this._ringSeeds = ring.getAttribute('aSeed');
  }

  /* ------------------------------------------------------------------ */
  /* layer 5 — the shards                                                */
  /* ------------------------------------------------------------------ */

  _buildShards() {
    // `y` runs 0 → 1 from root to tip rather than -1 → 1: a shard is not
    // symmetric about its middle, and the shader wants the distance along it as
    // a plain 0..1 with no remapping.
    const geometry = quadGeometry(0);
    this._shardData = new Float32Array(CAPACITY * SHARDS * SHARD_STRIDE);
    this._shardBuffer = new InstancedInterleavedBuffer(this._shardData, SHARD_STRIDE, 1);
    this._shardBuffer.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aOrigin', new InterleavedBufferAttribute(this._shardBuffer, 3, 0));
    geometry.setAttribute('aDir', new InterleavedBufferAttribute(this._shardBuffer, 3, 3));
    geometry.setAttribute('aLength', new InterleavedBufferAttribute(this._shardBuffer, 1, 6));
    geometry.setAttribute('aWidth', new InterleavedBufferAttribute(this._shardBuffer, 1, 7));
    geometry.setAttribute('aRate', new InterleavedBufferAttribute(this._shardBuffer, 1, 8));
    geometry.setAttribute('aSeed', new InterleavedBufferAttribute(this._shardBuffer, 1, 9));
    geometry.setAttribute('aAge', new InterleavedBufferAttribute(this._shardBuffer, 1, 10));
    geometry.instanceCount = 0;

    this.shardMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uCoreColor: { value: makeColor('#ffffff') },
        uShardColor: { value: makeColor('#a8ddff') },
        uIntensity: { value: 3.4 },
        uRoot: { value: 0.08 },
        uExposure: frame.uExposure
      },
      vertexShader: SHARD_VERTEX,
      fragmentShader: SHARD_FRAGMENT
    });

    this.shards = new Mesh(geometry, this.shardMaterial);
    this.shards.name = 'RiftShards';
    this.shards.frustumCulled = false;
    this.shards.layers.set(LAYER.VFX);
    // Last, and over everything: on the instant it exists this is the brightest
    // thing in the frame, and it should win wherever it crosses the other four.
    this.shards.renderOrder = 16;
    this.shards.raycast = () => {};
  }

  /* ------------------------------------------------------------------ */

  /**
   * Tear one open here, on a blow that came in along `(dx, dy, dz)`.
   *
   * The direction is what the first ring is laid across and what the shards are
   * thrown about, so the burst carries the bearing of the cut that caused it
   * rather than being a shape that could have happened to anybody from any
   * side.
   *
   * Everything random about a burst is drawn once, here, and never again: the
   * per-frame job below is an age and a memcpy. That is the whole reason the
   * core can afford three hundred motes.
   *
   * @param {number} x world, at the point of contact
   * @param {number} y
   * @param {number} z
   * @param {number} dx unit direction the blade was travelling
   * @param {number} dy
   * @param {number} dz
   * @param {object} config `settings.swordCombo.rift`
   * @param {number} [strength] master on the reach
   */
  open(x, y, z, dx, dy, dz, config, strength = 1) {
    if (!config.enabled || strength <= 0) return;
    // The oldest goes when there is nothing free: a burst that has nearly
    // closed is the one nobody is looking at any more.
    const burst = this._free.pop() ?? this.bursts.shift();

    const length = Math.hypot(dx, dy, dz) || 1;
    burst.position.set(x, y, z);
    burst.direction.set(dx / length, dy / length, dz / length);
    burst.radius = Math.max(0.1, config.radius) * strength;
    burst.ringRadius = Math.max(0.1, config.ringRadius) * strength;
    burst.haloRadius = Math.max(0.1, config.haloRadius) * strength;
    burst.life = Math.max(0.05, config.life);
    burst.ringLife = Math.max(0.05, config.ringLife);
    burst.haloLife = Math.max(0.05, config.haloLife);
    burst.moteLife = Math.max(0.05, config.moteLife);
    burst.shardLife = Math.max(0.05, config.shardLife);
    burst.age = 0;
    burst.seed = Math.random() * 64;

    for (let i = 0; i < RINGS; i++) {
      burst.rolls[i] = Math.random() * TAU;
      // The first lies square across the blow; the rest lean off it.
      burst.tilts[i] = i === 0 ? 0 : (i / RINGS) * Math.PI * 0.62 + Math.random() * 0.25;
      burst.spins[i] = (Math.random() - 0.5) * config.ringSpin * 2;
    }

    // An orthonormal frame around the blow — a tilt and a roll of zero is all
    // `_basis` needs to give one — shared by the core and the shards.
    this._basis(burst.direction, 0, 0);

    this._seedCore(burst, config, strength);
    this._seedShards(burst, config, strength, _rolledRight, _rolledUp);

    this.bursts.push(burst);
  }

  /**
   * The core's motes: a bearing each, and how far down it each one gets.
   *
   * Two populations out of one loop, and the split is what stops the field
   * reading as a textured ball. Most of a burst's motes stop at or just inside
   * the shell — they are the *volume*, and their reach is drawn from a
   * distribution weighted outward so the grain gathers near the rim, where the
   * eye is already looking. The rest (`escape`) are thrown clean through it at
   * several times the radius, and those are the ones that say the sphere failed
   * to hold what was in it.
   */
  _seedCore(burst, config, strength) {
    const count = Math.min(MOTES, Math.max(0, Math.round(config.moteCount)));
    burst.moteCount = count;
    burst.moteView = burst.moteData.subarray(0, count * MOTE_STRIDE);

    const reach = Math.max(0.05, config.moteReach) * strength;
    const escape = Math.min(1, Math.max(0, config.escape));
    const escapeReach = Math.max(0, config.escapeReach);
    const size = Math.max(0.001, config.moteSize);
    const data = burst.moteData;

    for (let i = 0; i < count; i++) {
      // Uniform on the sphere: `y` flat in [-1, 1] and the ring radius taken
      // from it, which is the one construction that does not bunch at the poles.
      const cosTheta = Math.random() * 2 - 1;
      const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
      const phi = Math.random() * TAU;
      const dirX = sinTheta * Math.cos(phi);
      const dirY = cosTheta;
      const dirZ = sinTheta * Math.sin(phi);

      const runs = Math.random() < escape;
      const travel = runs
        ? reach * (1 + Math.random() * escapeReach)
        : reach * (0.22 + Math.pow(Math.random(), 0.55) * 0.88);

      // A hair off the centre to begin with, so the first frame is a speck of
      // grain rather than one point that then blooms outward.
      const born = reach * 0.06 * Math.random();

      const o = i * MOTE_STRIDE;
      data[o] = burst.position.x + dirX * born;
      data[o + 1] = burst.position.y + dirY * born;
      data[o + 2] = burst.position.z + dirZ * born;
      data[o + 3] = dirX;
      data[o + 4] = dirY;
      data[o + 5] = dirZ;
      data[o + 6] = travel;
      data[o + 7] = size * (0.5 + Math.random() * 1.1);
      // Its own clock, so the field arrives over a few frames instead of on one.
      data[o + 8] = 0.7 + Math.random() * 0.7;
      data[o + 9] = Math.random() * 64;
      data[o + MOTE_AGE] = 0;
    }
  }

  /**
   * The shards: where the needles point, and how long each one is.
   *
   * They are laid out around the circle *across* the blow at even angles, then
   * each is leaned out of that plane by up to `shardBias` of a right angle. At
   * a bias of zero the burst is a flat starburst standing square to the cut —
   * dramatic, and wrong from every other camera. At one it is an even hedgehog
   * and the bearing of the blow is gone. In between is the point: a shape that
   * remembers which way the sword was going and still has depth from anywhere.
   *
   * @param {Vector3} right one axis across the blow
   * @param {Vector3} up the other
   */
  _seedShards(burst, config, strength, right, up) {
    const count = Math.min(SHARDS, Math.max(0, Math.round(config.shardCount)));
    burst.shardCount = count;
    burst.shardView = burst.shardData.subarray(0, count * SHARD_STRIDE);

    const reach = Math.max(0.05, config.shardLength) * strength;
    const width = Math.max(0.001, config.shardWidth);
    const bias = Math.min(1, Math.max(0, config.shardBias)) * Math.PI * 0.5;
    const forward = burst.direction;
    const data = burst.shardData;

    for (let i = 0; i < count; i++) {
      // Even angles with a jitter: evenly spaced is a wheel and fully random is
      // a clump, and the jitter is what buys neither.
      const angle = (i / Math.max(1, count)) * TAU + (Math.random() - 0.5) * (TAU / count);
      const lean = (Math.random() * 2 - 1) * bias;
      const cl = Math.cos(lean);
      const sl = Math.sin(lean);
      const ca = Math.cos(angle) * cl;
      const sa = Math.sin(angle) * cl;

      const o = i * SHARD_STRIDE;
      data[o] = burst.position.x;
      data[o + 1] = burst.position.y;
      data[o + 2] = burst.position.z;
      data[o + 3] = right.x * ca + up.x * sa + forward.x * sl;
      data[o + 4] = right.y * ca + up.y * sa + forward.y * sl;
      data[o + 5] = right.z * ca + up.z * sa + forward.z * sl;
      // A wide spread of lengths. A dozen needles all one length is a sun
      // symbol; a dozen over six lengths is an explosion.
      data[o + 6] = reach * (0.42 + Math.random() * 0.9);
      data[o + 7] = width * (0.55 + Math.random() * 0.9);
      data[o + 8] = 0.75 + Math.random() * 0.6;
      data[o + 9] = Math.random() * 64;
      data[o + SHARD_AGE] = 0;
    }
  }

  /* ------------------------------------------------------------------ */

  /**
   * Age everything, and write the slots.
   *
   * One pass over at most three bursts fills five buffers. The two big ones —
   * the core and the shards — are filled by stamping this frame's age into the
   * burst's own copy of its records and blitting the block, which is why a
   * three-hundred-mote core costs a memcpy a frame rather than a loop over
   * motes doing trigonometry.
   *
   * @param {number} dt
   * @param {object} config `settings.swordCombo.rift`
   */
  update(dt, config) {
    this._sync(config);

    const bursts = this.bursts;
    for (let i = bursts.length - 1; i >= 0; i--) {
      const burst = bursts[i];
      burst.age += dt;
      // The layers do not end together, so a burst is gone only once the
      // longest-lived of them has run out. All five are in the max, including
      // the shards — they are the shortest of the five at every sane setting,
      // but a slider that silently stops working past a value is a slider that
      // is lying.
      const last = Math.max(
        burst.life,
        burst.ringLife,
        burst.haloLife,
        burst.moteLife,
        burst.shardLife
      );
      if (burst.age >= last) {
        bursts.splice(i, 1);
        this._free.push(burst);
      }
    }

    let halos = 0;
    let shells = 0;
    let motes = 0;
    let rings = 0;
    let shards = 0;

    for (const burst of bursts) {
      /* ---- 1. the halo ---- */
      const haloAge = burst.age / burst.haloLife;
      if (config.haloEnabled && haloAge < 1) {
        const o = halos * HALO_STRIDE;
        this._haloData[o] = burst.position.x;
        this._haloData[o + 1] = burst.position.y;
        this._haloData[o + 2] = burst.position.z;
        this._haloData[o + 3] = burst.haloRadius;
        this._haloData[o + HALO_AGE] = haloAge;
        halos++;
      }

      /* ---- 2. the shell ---- */
      const shellAge = burst.age / burst.life;
      if (shellAge < 1) {
        // Out fast and slowing — an `outQuint`, which is what anything
        // spreading into a material that resists it actually does.
        const front = 1 - Math.pow(1 - shellAge, 5);
        const scale = burst.radius * (0.12 + front * 0.88);
        _matrix.makeScale(scale, scale, scale);
        _matrix.setPosition(burst.position);
        this.shell.setMatrixAt(shells, _matrix);
        this._shellAges.setX(shells, shellAge);
        this._shellSeeds.setX(shells, burst.seed);
        shells++;
      }

      /* ---- 3. the core ---- */
      const moteAge = burst.age / burst.moteLife;
      if (config.moteEnabled && moteAge < 1 && burst.moteCount > 0) {
        stamp(burst.moteData, burst.moteCount, MOTE_STRIDE, MOTE_AGE, moteAge);
        this._moteData.set(burst.moteView, motes * MOTE_STRIDE);
        motes += burst.moteCount;
      }

      /* ---- 4. the rings ---- */
      const ringAge = burst.age / burst.ringLife;
      if (ringAge < 1) {
        const front = 1 - Math.pow(1 - ringAge, 4);
        for (let i = 0; i < RINGS; i++) {
          // Each ring's own plane: the blow's bearing, tilted off it and then
          // spun in its own plane so the spokes are never all in phase.
          this._basis(burst.direction, burst.tilts[i], burst.rolls[i] + burst.spins[i] * burst.age);
          // Staggered: the outer ones leave a beat later, so the burst reads as
          // one shockwave overtaking another rather than three drawn at once.
          const lag = 1 - i * 0.16;
          const scale = burst.ringRadius * front * lag;
          _rolledRight.multiplyScalar(scale);
          _rolledUp.multiplyScalar(scale);
          _forward.multiplyScalar(scale);
          _matrix.makeBasis(_rolledRight, _rolledUp, _forward);
          _matrix.setPosition(burst.position);
          this.rings.setMatrixAt(rings, _matrix);
          this._ringAges.setX(rings, ringAge);
          this._ringSeeds.setX(rings, burst.seed + i * 13.7);
          rings++;
        }
      }

      /* ---- 5. the shards ---- */
      const shardAge = burst.age / burst.shardLife;
      if (config.shardEnabled && shardAge < 1 && burst.shardCount > 0) {
        stamp(burst.shardData, burst.shardCount, SHARD_STRIDE, SHARD_AGE, shardAge);
        this._shardData.set(burst.shardView, shards * SHARD_STRIDE);
        shards += burst.shardCount;
      }
    }

    this.halo.geometry.instanceCount = halos;
    this.shell.count = shells;
    this.core.geometry.instanceCount = motes;
    this.rings.count = rings;
    this.shards.geometry.instanceCount = shards;

    if (halos > 0) this._haloBuffer.needsUpdate = true;
    if (shells > 0) {
      this.shell.instanceMatrix.needsUpdate = true;
      this._shellAges.needsUpdate = true;
      this._shellSeeds.needsUpdate = true;
    }
    if (motes > 0) this._moteBuffer.needsUpdate = true;
    if (rings > 0) {
      this.rings.instanceMatrix.needsUpdate = true;
      this._ringAges.needsUpdate = true;
      this._ringSeeds.needsUpdate = true;
    }
    if (shards > 0) this._shardBuffer.needsUpdate = true;
  }

  /**
   * A ring's plane: `+Z` along the blow, tilted, then rolled in its own plane.
   *
   * Leaves the three axes in the module's scratch vectors, unscaled — the
   * caller multiplies them by the radius it wants, which is what makes the
   * basis and the size one matrix rather than two. At a tilt and a roll of zero
   * it is simply an orthonormal frame around the blow, which is how `open` uses
   * it for the shards.
   */
  _basis(direction, tilt, roll) {
    _forward.copy(direction);
    _right.crossVectors(_up, _forward);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    _upAxis.crossVectors(_forward, _right).normalize();

    // Tilt leans the ring's plane over about its own right-hand axis, which
    // moves `+Z` off the blow's bearing and takes `+Y` with it. Both results go
    // to scratch of their own rather than back over `_forward`/`_upAxis`, which
    // the second line still needs in their untilted form.
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);
    _tiltedForward.copy(_forward).multiplyScalar(ct).addScaledVector(_upAxis, -st);
    _tiltedUp.copy(_upAxis).multiplyScalar(ct).addScaledVector(_forward, st);

    // And roll turns it within that plane.
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    _rolledRight.copy(_right).multiplyScalar(cr).addScaledVector(_tiltedUp, sr);
    _rolledUp.copy(_right).multiplyScalar(-sr).addScaledVector(_tiltedUp, cr);
    _forward.copy(_tiltedForward);
  }

  /** Push the look. Read per frame, so the editor's edits land immediately. */
  _sync(config) {
    const h = this.haloMaterial.uniforms;
    copyColor(h.uInnerColor.value, config.haloColor);
    copyColor(h.uOuterColor.value, config.haloEdgeColor);
    h.uIntensity.value = config.haloIntensity;

    const s = this.shellMaterial.uniforms;
    copyColor(s.uCoreColor.value, config.coreColor);
    copyColor(s.uRimColor.value, config.rimColor);
    copyColor(s.uDeepColor.value, config.deepColor);
    s.uIntensity.value = config.intensity;
    s.uFresnel.value = config.fresnel;
    s.uChurn.value = config.churn;
    s.uChurnSpeed.value = config.churnSpeed;

    const c = this.coreMaterial.uniforms;
    copyColor(c.uCoreColor.value, config.coreColor);
    copyColor(c.uMoteColor.value, config.moteColor);
    c.uIntensity.value = config.moteIntensity;
    c.uStretch.value = Math.max(0, config.moteStretch);

    const r = this.ringMaterial.uniforms;
    copyColor(r.uCoreColor.value, config.coreColor);
    copyColor(r.uRingColor.value, config.ringColor);
    r.uIntensity.value = config.ringIntensity;
    r.uWidth.value = config.ringWidth;
    r.uSoftness.value = config.ringSoftness;
    r.uSpokes.value = Math.max(0, Math.round(config.spokes));
    r.uSpokeDepth.value = config.spokeDepth;

    const b = this.shardMaterial.uniforms;
    copyColor(b.uCoreColor.value, config.coreColor);
    copyColor(b.uShardColor.value, config.shardColor);
    b.uIntensity.value = config.shardIntensity;
    b.uRoot.value = Math.min(0.9, Math.max(0, config.shardRoot));
  }

  /** Everything open, closed — for leaving the stage and for a reset. */
  clear() {
    for (const burst of this.bursts) this._free.push(burst);
    this.bursts.length = 0;
    this.halo.geometry.instanceCount = 0;
    this.shell.count = 0;
    this.core.geometry.instanceCount = 0;
    this.rings.count = 0;
    this.shards.geometry.instanceCount = 0;
  }

  dispose() {
    for (const mesh of [this.halo, this.shell, this.core, this.rings, this.shards]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
      // Only the two `InstancedMesh`es carry a GPU-side instance buffer of
      // their own; the other three are plain meshes over a shared one.
      mesh.dispose?.();
    }
    this.group.parent?.remove(this.group);
  }
}

/* -------------------------------------------------------------------- */
/* the plumbing                                                          */
/* -------------------------------------------------------------------- */

/**
 * One quad, corners in `[-1, 1]` across and `[bottom, 1]` along.
 *
 * `bottom` is the only thing that differs between the sprite layers and the
 * shards: a mote is symmetric about its own centre and a shard runs from a root
 * to a tip, so the latter wants its `y` to arrive in the shader as a plain 0..1
 * distance along itself.
 */
function quadGeometry(bottom) {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-1, bottom, 0, 1, bottom, 0, 1, 1, 0, -1, 1, 0]), 3)
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

/** A burst record, allocated once and reused for the life of the system. */
function makeBurst() {
  return {
    position: new Vector3(),
    direction: new Vector3(0, 0, 1),
    radius: 1,
    ringRadius: 1,
    haloRadius: 1,
    life: 0.5,
    ringLife: 0.5,
    haloLife: 0.5,
    moteLife: 0.5,
    shardLife: 0.3,
    age: 0,
    seed: 0,
    // Each ring gets its own tilt off the blow's plane and its own spin, so
    // three of them never read as one ring drawn three times.
    rolls: new Float32Array(RINGS),
    tilts: new Float32Array(RINGS),
    spins: new Float32Array(RINGS),
    // The block written at birth, and the view of exactly the part of it this
    // burst is using — which is what `update` blits, so a core of forty motes
    // does not cost the copy of three hundred.
    moteCount: 0,
    moteData: new Float32Array(MOTES * MOTE_STRIDE),
    moteView: null,
    shardCount: 0,
    shardData: new Float32Array(SHARDS * SHARD_STRIDE),
    shardView: null
  };
}

/** This frame's age into every record of a block, at the field it lives in. */
function stamp(data, count, stride, offset, age) {
  for (let i = 0; i < count; i++) data[i * stride + offset] = age;
}

/* -------------------------------------------------------------------- */
/* layer 1 — the halo                                                    */
/* -------------------------------------------------------------------- */

/**
 * A disc built in view space, so it faces the lens from wherever it is looked
 * at without a matrix or a `lookAt`. It swells a little as it dies: light in
 * air does not shrink back into the thing that made it.
 */
const HALO_VERTEX = /* glsl */ `
attribute vec3 aOrigin;
attribute float aRadius;
attribute float aAge;

varying vec2 vShape;
varying float vAge;

void main() {
  float t = clamp(aAge, 0.0, 1.0);
  // A slot never written, or one already spent. Folded to a degenerate point
  // outside the clip volume, which the rasteriser drops free.
  if (aRadius <= 0.0 || t >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vShape = vec2(0.0);
    vAge = 1.0;
    return;
  }

  vec4 view = viewMatrix * vec4(aOrigin, 1.0);
  float scale = aRadius * (0.55 + 0.75 * (1.0 - pow(1.0 - t, 3.0)));
  view.xy += position.xy * scale;

  gl_Position = projectionMatrix * view;
  vShape = position.xy;
  vAge = t;
}
`;

/**
 * Two gaussians and nothing else.
 *
 * The wide one is the violet in the air; the tight one is the blue sitting
 * where the burst actually is. Both are gaussians rather than a linear falloff
 * because a linear one has a visible circular edge the moment it is bright
 * enough to be worth drawing, and the whole job of this layer is to have no
 * edge at all.
 */
const HALO_FRAGMENT = /* glsl */ `
uniform vec3 uInnerColor;
uniform vec3 uOuterColor;
uniform float uIntensity;
uniform float uExposure;

varying vec2 vShape;
varying float vAge;

void main() {
  float d = length(vShape);
  if (d > 1.0) discard;

  float outer = exp(-d * d * 3.4);
  float inner = exp(-d * d * 13.0);
  // Up over the first two frames so it does not pop, then a long tail.
  float fade = smoothstep(0.0, 0.06, vAge) * pow(1.0 - vAge, 2.2);

  vec3 rgb = uOuterColor * outer * 0.8 + uInnerColor * inner;
  float a = (outer * 0.55 + inner) * fade;

  float gain = uIntensity / max(uExposure, 0.01);
  a *= gain;
  if (a < 0.004) discard;

  gl_FragColor = vec4(rgb * gain, a);
}
`;

/* -------------------------------------------------------------------- */
/* layer 2 — the shell                                                   */
/* -------------------------------------------------------------------- */

/**
 * The shell's surface, boiling.
 *
 * The displacement is along the vertex normal and it *crawls*: the noise is
 * sampled in the sphere's own object space with the clock folded into the third
 * coordinate, so the pattern moves over the surface rather than the surface
 * moving through a fixed field. It also grows with age — the shell is smooth on
 * the frame it appears and ragged by the time it goes, which is the difference
 * between something tearing open and a balloon inflating.
 */
const SHELL_VERTEX = /* glsl */ `
${noiseGLSL}

uniform float uChurn;
uniform float uChurnSpeed;

attribute float aAge;
attribute float aSeed;

varying float vAge;
varying float vSeed;
varying float vNoise;
varying vec3 vNormal;
varying vec3 vView;

void main() {
  vec3 n = normalize(normal);

  float t = clamp(aAge, 0.0, 1.0);
  float churn = fbm3(n * 2.3 + vec3(0.0, 0.0, t * uChurnSpeed) + aSeed);
  // Smooth at birth, ragged by the end.
  vec3 local = position + n * churn * uChurn * (0.25 + t * 1.4);

  vec4 world = modelMatrix * instanceMatrix * vec4(local, 1.0);

  vAge = t;
  vSeed = aSeed;
  vNoise = churn;
  // The instance carries a uniform scale only, so the normal survives it
  // unchanged and there is no normal matrix to build.
  vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * n);
  vView = normalize(cameraPosition - world.xyz);

  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * A volume, drawn on its rim.
 *
 * `fresnel` is nearly the whole image: it is 1 where the surface turns away
 * from the lens and 0 where it faces it, so what is drawn is the silhouette and
 * the inside is left almost empty. That is what makes an additive sphere read
 * as a shell with something behind it rather than as a white ball — and now
 * that the core layer fills that inside with grain, the shell can be left
 * emptier still than it could be when it was the only thing there.
 *
 * The rest is one flash — a core that is white for the first two frames and
 * gone by the third, which is the part the eye reads as the *moment* rather
 * than as the effect.
 */
const SHELL_FRAGMENT = /* glsl */ `
uniform vec3 uCoreColor;
uniform vec3 uRimColor;
uniform vec3 uDeepColor;
uniform float uIntensity;
uniform float uFresnel;
uniform float uExposure;

varying float vAge;
varying float vSeed;
varying float vNoise;
varying vec3 vNormal;
varying vec3 vView;

void main() {
  float t = clamp(vAge, 0.0, 1.0);

  float facing = abs(dot(normalize(vNormal), normalize(vView)));
  float rim = pow(1.0 - facing, uFresnel);
  // A little of the body, so the shell has an inside rather than being a wire.
  // Deliberately tiny: the sphere is drawn two-sided, so every one of these
  // terms is paid twice wherever the far side shows through the near one, and
  // a body term generous enough to see on its own arrives as a solid ball.
  float body = pow(1.0 - facing, 0.7) * 0.08;

  // The noise that moved the surface also lights it, so the bright patches are
  // the ones standing proud — the displacement reads instead of only silhouetting.
  float veins = smoothstep(0.05, 0.75, vNoise * 0.5 + 0.5);

  // Gone by the third frame. This is the moment, not the effect — and it is
  // hung on the rim rather than laid flat across the sphere, because a flash
  // with no falloff over a closed surface is exactly a white circle. The
  // silhouette flares; the middle stays open.
  float core = pow(1.0 - t, 7.0) * (0.25 + rim) * 1.2;

  vec3 rgb = uRimColor * rim * (0.5 + veins) + uDeepColor * body + uCoreColor * core;
  float a = (rim * (0.5 + veins) + body + core);

  // Out over the back half of its life, and never abruptly: the shell is the
  // slow part of the burst and the rings are the fast one.
  a *= 1.0 - smoothstep(0.35, 1.0, t);

  float gain = uIntensity / max(uExposure, 0.01);
  a *= gain;
  if (a < 0.004) discard;

  gl_FragColor = vec4(rgb * gain, a);
}
`;

/* -------------------------------------------------------------------- */
/* layer 3 — the core                                                    */
/* -------------------------------------------------------------------- */

/**
 * One mote, on its way out, smeared along where it is going.
 *
 * Its whole trajectory is a closed form of one number — the age — so the CPU
 * never touches a mote after it is born. The easing is an `outCubic`, and the
 * *derivative* of that easing is the speed, which is what the streak is built
 * from: a mote is a dot on the frame it stops and a dash while it is moving,
 * for the price of one `normalize` on a `vec2`. Without that the field is a dot
 * screen that strobes, because at these speeds a mote crosses several pixels
 * between two frames.
 */
const MOTE_VERTEX = /* glsl */ `
uniform float uStretch;

attribute vec3 aOrigin;
attribute vec3 aDir;
attribute float aReach;
attribute float aSize;
attribute float aRate;
attribute float aSeed;
attribute float aAge;

varying vec2 vShape;
varying float vAge;
varying float vSeed;

void main() {
  float t = clamp(aAge * aRate, 0.0, 1.0);
  if (aSize <= 0.0 || t >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vShape = vec2(0.0);
    vAge = 1.0;
    vSeed = 0.0;
    return;
  }

  float front = 1.0 - pow(1.0 - t, 3.0);
  vec4 view = viewMatrix * vec4(aOrigin + aDir * (aReach * front), 1.0);

  // d/dt of the easing above, which is how fast it is actually travelling.
  float speed = aReach * 3.0 * (1.0 - t) * (1.0 - t);
  vec3 viewDir = (viewMatrix * vec4(aDir, 0.0)).xyz;
  float onScreen = length(viewDir.xy);

  // Coming straight at the lens: there is no direction on screen to point
  // along, and normalising noise would make it flicker. It stays a dot, which
  // is what a mote heading for the camera actually looks like.
  vec2 along = onScreen > 1e-4 ? viewDir.xy / onScreen : vec2(0.0, 1.0);
  vec2 side = vec2(along.y, -along.x);

  float span = aSize + onScreen * speed * uStretch;
  // Thinning as it cools, so the field tapers instead of switching off.
  float across = aSize * (1.0 - 0.4 * t);
  view.xy += side * position.x * across + along * position.y * span;

  gl_Position = projectionMatrix * view;
  vShape = position.xy;
  vAge = t;
  vSeed = aSeed;
}
`;

/**
 * A capsule with a hot head, twinkling.
 *
 * The head is the leading end of its own streak, which is where the light
 * actually is when something incandescent is moving; the rest is the smear it
 * left getting there. The twinkle is a plain sine on the seed and the age, and
 * it is the difference between three hundred motes and one texture: a field
 * whose members all dim together is a fading sprite, and one whose members
 * scintillate against each other is made of particles.
 */
const MOTE_FRAGMENT = /* glsl */ `
uniform vec3 uCoreColor;
uniform vec3 uMoteColor;
uniform float uIntensity;
uniform float uExposure;

varying vec2 vShape;
varying float vAge;
varying float vSeed;

void main() {
  float across = 1.0 - abs(vShape.x);
  float along = 1.0 - abs(vShape.y);
  float shape = across * across * smoothstep(0.0, 0.6, along);
  float head = smoothstep(-0.3, 1.0, vShape.y);
  shape *= 0.3 + 0.7 * head;

  float twinkle = 0.6 + 0.4 * sin(vSeed * 31.0 + vAge * 34.0);
  // White while it is hot, its own colour once it has cooled.
  float heat = pow(1.0 - vAge, 3.0);
  vec3 rgb = mix(uMoteColor, uCoreColor, heat * 0.85);

  float a = shape * twinkle * smoothstep(0.0, 0.04, vAge) * (1.0 - smoothstep(0.35, 1.0, vAge));

  float gain = uIntensity / max(uExposure, 0.01);
  a *= gain;
  if (a < 0.004) discard;

  gl_FragColor = vec4(rgb * gain, a);
}
`;

/* -------------------------------------------------------------------- */
/* layer 4 — the rings                                                   */
/* -------------------------------------------------------------------- */

/** Nothing to do but carry the ring's own radius through as a varying. */
const RING_VERTEX = /* glsl */ `
attribute float aAge;
attribute float aSeed;

varying float vAge;
varying float vSeed;
varying float vRadius;
varying float vAngle;

void main() {
  vAge = aAge;
  vSeed = aSeed;
  // The geometry is a unit annulus, so the vertex's own distance from the
  // centre is the coordinate the band is placed against.
  vRadius = length(position.xy);
  vAngle = atan(position.y, position.x);

  gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

/**
 * One ring: a band at the rim of its own annulus, with spokes through it.
 *
 * The band sits *at* radius 1 rather than travelling within the annulus,
 * because the instance matrix is what expands the ring — so the shader only has
 * to draw an edge, and it thins with age because the same light is being
 * carried by an ever longer circumference.
 *
 * The spokes are what keep it from reading as a smoke ring: a plain annulus has
 * no information in it, and a hard radial comb says the thing is made of
 * something with a grain.
 */
const RING_FRAGMENT = /* glsl */ `
uniform vec3 uCoreColor;
uniform vec3 uRingColor;
uniform float uIntensity;
uniform float uWidth;
uniform float uSoftness;
uniform float uSpokes;
uniform float uSpokeDepth;
uniform float uExposure;

varying float vAge;
varying float vSeed;
varying float vRadius;
varying float vAngle;

void main() {
  float t = clamp(vAge, 0.0, 1.0);

  // Thinning as it goes: the ring is a fixed amount of light spread round an
  // expanding circle.
  float width = uWidth * mix(1.6, 0.35, t);
  float d = abs(vRadius - 1.0);
  float band = 1.0 - smoothstep(width, width + uSoftness, d);
  if (band <= 0.0) discard;

  // The comb, drifting round the ring so it is never a static grille.
  float comb = 1.0;
  if (uSpokes > 0.5) {
    float s = cos(vAngle * uSpokes + vSeed + t * 3.0) * 0.5 + 0.5;
    comb = mix(1.0 - uSpokeDepth, 1.0, s);
  }

  // The inner edge is the hot one: it is the side the light came from.
  float inner = 1.0 - smoothstep(0.0, width * 1.4, max(0.0, vRadius - 1.0));

  float core = band * band * inner;
  vec3 rgb = uRingColor * band * comb + uCoreColor * core * 1.3;
  float a = (band * comb + core * 1.3);

  a *= smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.4, 1.0, t));

  float gain = uIntensity / max(uExposure, 0.01);
  a *= gain;
  if (a < 0.004) discard;

  gl_FragColor = vec4(rgb * gain, a);
}
`;

/* -------------------------------------------------------------------- */
/* layer 5 — the shards                                                  */
/* -------------------------------------------------------------------- */

/**
 * One needle, drawn as a ribbon between two points in view space.
 *
 * Both ends of the shard are transformed and the quad is stretched *between*
 * them rather than being a billboard rotated by a screen angle, which is what
 * makes the perspective right: a shard pointing away from the camera really is
 * short on screen, because its two ends really are close together there.
 *
 * That leaves one problem the ribbon cannot solve on its own. A needle aimed at
 * the lens collapses to nearly zero length while keeping its full width, and
 * arrives as a stubby blob. So the vertex shader measures how much of the
 * shard's length survived the projection and hands the fragment shader the
 * ratio, which fades it out as it turns end-on: the shards facing the camera
 * simply stop being drawn, and what is left is the ones that read.
 */
const SHARD_VERTEX = /* glsl */ `
uniform float uRoot;

attribute vec3 aOrigin;
attribute vec3 aDir;
attribute float aLength;
attribute float aWidth;
attribute float aRate;
attribute float aSeed;
attribute float aAge;

varying float vShape;
varying float vAlong;
varying float vAge;
varying float vSeed;
varying float vSquash;

void main() {
  float t = clamp(aAge * aRate, 0.0, 1.0);
  if (aLength <= 0.0 || t >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vShape = 0.0;
    vAlong = 0.0;
    vAge = 1.0;
    vSeed = 0.0;
    vSquash = 0.0;
    return;
  }

  // Out hard and stopping — the shards are the fast layer, and they are already
  // at three quarters of their length by the time the shell is a third open.
  float grow = 1.0 - pow(1.0 - t, 3.5);
  float reach = aLength * grow;

  vec4 root = viewMatrix * vec4(aOrigin + aDir * (reach * uRoot), 1.0);
  vec4 tip = viewMatrix * vec4(aOrigin + aDir * reach, 1.0);

  vec4 view = mix(root, tip, position.y);
  vec2 axis = tip.xy - root.xy;
  float onScreen = length(axis);
  vec2 along = onScreen > 1e-4 ? axis / onScreen : vec2(0.0, 1.0);
  vec2 side = vec2(along.y, -along.x);
  view.xy += side * position.x * aWidth;

  gl_Position = projectionMatrix * view;

  vShape = position.x;
  vAlong = position.y;
  vAge = t;
  vSeed = aSeed;
  // How much of its length is left after the projection: 1 broadside, 0 end-on.
  vSquash = pow(clamp(onScreen / max(1e-4, length(tip.xyz - root.xyz)), 0.0, 1.0), 0.6);
}
`;

/**
 * The needle's profile, entirely in the fragment shader.
 *
 * The quad is a constant-width strip and every bit of shape in it is drawn
 * here, which is what lets a shard taper smoothly along its length out of four
 * vertices. Two curves do it:
 *
 *  - **across** — the half-width closes from full at the root to almost nothing
 *    at the tip, so the silhouette is a spike rather than a bar;
 *  - **along** — a lobe that is zero at both ends and peaks about a third of
 *    the way out. A needle brightest at its root is a lamp with rays coming off
 *    it; one brightest a little way out is a *splinter*, which is the thing
 *    that reads as broken.
 *
 * The rest is a flicker on the seed and a fade that outlives neither.
 */
const SHARD_FRAGMENT = /* glsl */ `
uniform vec3 uCoreColor;
uniform vec3 uShardColor;
uniform float uIntensity;
uniform float uExposure;

varying float vShape;
varying float vAlong;
varying float vAge;
varying float vSeed;
varying float vSquash;

void main() {
  float al = clamp(vAlong, 0.0, 1.0);

  // Narrowing to a point. The exponent keeps the taper slow near the root and
  // fast at the end, which is the shape of a splinter rather than of a cone.
  float halfWidth = mix(1.0, 0.04, pow(al, 0.6));
  float across = 1.0 - clamp(abs(vShape) / max(halfWidth, 1e-3), 0.0, 1.0);
  float blade = across * across;

  // Zero at both ends, brightest a third of the way out. The max() is not
  // decoration: sin(PI) lands a hair below zero in float, and pow() of a
  // negative base is undefined — which arrives as a NaN pixel at the very tip
  // of every shard.
  float body = pow(max(0.0, sin(3.14159265 * pow(al, 0.72))), 1.5);

  float flicker = 0.72 + 0.28 * sin(vSeed * 17.0 + vAge * 21.0);
  float fade = smoothstep(0.0, 0.07, vAge) * pow(1.0 - vAge, 2.0);

  // White at the root where the burst is, its own colour out at the tip.
  vec3 rgb = mix(uShardColor, uCoreColor, pow(1.0 - al, 2.0) * 0.85);
  float a = blade * body * flicker * fade * vSquash;

  float gain = uIntensity / max(uExposure, 0.01);
  a *= gain;
  if (a < 0.004) discard;

  gl_FragColor = vec4(rgb * gain, a);
}
`;
