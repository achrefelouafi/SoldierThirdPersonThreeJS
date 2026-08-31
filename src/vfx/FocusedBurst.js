import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InstancedMesh,
  InterleavedBufferAttribute,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NormalBlending,
  PlaneGeometry,
  PointLight,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  Vector3
} from 'three';

import { frame } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { terrainGLSL } from '../shaders/lib/terrain.glsl.js';
import { copyColor, getColor, makeColor } from '../utils/color.js';

/** Segments round the shell and up it. The arcs are drawn *on* it, so the
 *  silhouette is all that needs resolution — and the boil moves it every frame. */
const SHELL_SEGMENTS = 48;
const SHELL_RINGS = 32;

/** Subdivisions of the ground disc, which is bent onto the height field. */
const DECAL_SEGMENTS = 32;

/** Ceilings. One burst is on screen at a time (see the class note), so these are
 *  the *whole* pool rather than a share of it — each layer is rewritten from
 *  index zero every time one goes off. */
const SPRITE_CAPACITY = 320;
const DEBRIS_CAPACITY = 48;
const HAZE_CAPACITY = 32;

/** origin(3) velocity(3) seed birth life size kind drag gravity tint — one sprite. */
const SPRITE_STRIDE = 14;
/** origin(3) velocity(3) seed birth life size — one puff. */
const HAZE_STRIDE = 10;

/** What a sprite is. The shader branches on it exactly twice. */
const SPARK = 0;
const SHARD = 1;

const _axis = /* @__PURE__ */ new Vector3();
const _spin = /* @__PURE__ */ new Vector3();
const _offset = /* @__PURE__ */ new Vector3();
const _scale = /* @__PURE__ */ new Vector3();
const _quaternion = /* @__PURE__ */ new Quaternion();
const _turn = /* @__PURE__ */ new Quaternion();
const _matrix = /* @__PURE__ */ new Matrix4();

/**
 * What the held shot does when it arrives.
 *
 * ## Why it is not another impact
 *
 * `vfx/GunFX.js` already draws a round landing — a dozen sparks off the floor
 * and a flash at the barrel — and every one of the rifle's ordinary rounds uses
 * it. What that cannot do is say *this one cost three seconds*. A shot the
 * player stood still in the open to earn has to arrive as an event, and an
 * event is not a bigger version of a hit: it is a different number of things
 * happening at once.
 *
 * ## The seven layers
 *
 * Painted back to front, one draw call and one idea each, and every one has its
 * own `*Enabled` flag in `settings.gunplay.focus.burst` so it can be soloed
 * against the other six. That is the only way to tune a stack this deep — for
 * the first fifty milliseconds the whole thing is one white flash, and nothing
 * underneath can be judged while the core is sitting on top of it.
 *
 * 1. **The cracks.** A disc bent onto the height field with a web of filaments
 *    written outward across it — ridged noise for the mat of fine cracks, and
 *    a handful of straight spokes running out of the middle for the big ones.
 *    It is the only layer that outlives the light, and it is what says the
 *    ground was *there* when this happened. Faded out by height, so a round
 *    that took a head off at chest height does not crack the floor under it.
 *
 * 2. **The haze.** Slow grey puffs climbing out of the contact, on
 *    `NormalBlending` — the one layer here that is not light. The air being
 *    torn is the thing every additive stack is missing, and it cannot be added:
 *    smoke that brightened what it crossed would be steam lit from inside.
 *
 * 3. **The debris.** Two dozen chunks of floor thrown up and tumbling, and the
 *    only *lit* thing in the burst — they are on `LAYER.WORLD` with a standard
 *    material, so the moon keys them like everything else on the stage. That is
 *    deliberate: a blast made entirely of unlit light has no weight in it, and
 *    the one shaded surface in the frame is what the eye sizes the rest
 *    against. They settle on the height field rather than falling through it.
 *
 * 4. **The shell.** A sphere of arcs — meridians and parallels drawn on a rim
 *    that burns hardest where it turns away from the lens, boiling on a noise
 *    field as it opens. This is the reference's primary arc mesh, and it is the
 *    layer that gives the burst a *volume*: without it the rest is a spray with
 *    nothing in the middle.
 *
 * 5. **The shower.** Sparks and shards out of one buffer, because the only
 *    thing separating them is four numbers and a branch. The sparks are the
 *    ember half — orange, heavy, stretched along their own screen velocity into
 *    streaks. The shards are the cold half — long cyan and violet needles that
 *    outrun everything else and are gone before the shell has finished opening.
 *    Both ride the same closed-form trajectory, evaluated per vertex, because
 *    linear drag under a constant acceleration has an exact solution and a
 *    hundred and fifty particles is a hundred and fifty CPU integrations nobody
 *    needs to pay for.
 *
 * 6. **The core.** One camera-facing quad: a white point that is gone almost
 *    before it is seen, a halo around it, and a star of spikes on a bearing
 *    rolled per burst. It is drawn last of the light because it must win
 *    wherever it overlaps.
 *
 * 7. **The light.** One `PointLight`, and the rule about it is the muzzle
 *    flash's rule (`vfx/GunFX.js`): it is never made invisible, only dark. A
 *    light appearing in a scene changes the lighting hash every material on the
 *    stage was compiled against, so a burst that switched one on would
 *    recompile the world on the one frame that cannot afford it.
 *
 * ## One at a time
 *
 * There is no pool of bursts and there is no ring: every layer is rewritten
 * from index zero when one goes off, and a second burst replaces the first
 * outright. That is honest rather than lazy — the shot takes three seconds of
 * held aim to earn (`settings.gunplay.focus.charge`) and the burst lives about
 * one and a half, so two can never be on screen together without the settings
 * being dialled somewhere they were never meant to go. It is also what keeps
 * this file a state machine instead of five pools.
 *
 * ## What it owns, and what it does not
 *
 * The look and the pacing. Nothing else. It does not know what was hit, what
 * the round was worth, or that anything died — `combat/Gunplay.js` spends the
 * damage on the same frame it calls `fire`, on its own path.
 */
export class FocusedBurst {
  /**
   * @param {object} [options]
   * @param {{heightAt: (x: number, z: number) => number, uniforms: object}|null} [options.terrain]
   *   the height field. Without it the cracks lie flat at the burst's own y and
   *   the debris fall forever, which on flat ground is the same answer.
   */
  constructor({ terrain = null } = {}) {
    this.terrain = terrain;

    /** Every layer, in world space. Add it to the scene. */
    this.group = new Group();
    this.group.name = 'FocusedBurst';

    this._buildDecal();
    this._buildHaze();
    this._buildDebris();
    this._buildShell();
    this._buildSprites();
    this._buildCore();

    // Held in the scene from construction and never switched off — only turned
    // down to nothing. See the note on the seven layers above.
    this.light = new PointLight(0xffffff, 0, 20, 2);
    this.light.castShadow = false;

    this.group.add(
      this.decal,
      this.haze,
      this.debris,
      this.shell,
      this.sprites,
      this.core,
      this.light
    );

    /** Where the burst is, and the floor under it. */
    this._at = new Vector3();
    this._groundY = 0;
    /** Seconds since it went off. Dead until one does. */
    this._age = 0;
    /**
     * The master length, and the last frame anything is on screen.
     *
     * They are two numbers because the shaped layers are *fractions* of the
     * master (`shellLife`, `coreLife`) while the thrown ones each carry their
     * own clock — a chunk of floor is still bouncing well after the light has
     * gone. `_life` is what the fractions are measured against; `_until` is
     * what `active` answers off, so nothing is cut off mid-flight.
     */
    this._life = 0;
    this._until = 0;
    /** Seconds of the frame just advanced — what the debris are integrated on. */
    this._dt = 0;
    /** The clock the sprite and haze shaders resolve their trajectories against. */
    this._clock = 0;
    /** A fresh roll per burst: the star's bearing and the noise fields' phase. */
    this._roll = 0;
    this._seed = 0;
  }

  /** Whether anything is still on screen. */
  get active() {
    return this._age < this._until;
  }

  /* ------------------------------------------------------------------ */
  /* the frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Advance the clocks.
   *
   * Called *before* anything can emit, exactly as `vfx/BladeImpact.js#sync` is
   * and for the same reason: a sprite born later in the same frame is stamped
   * with a clock the shader has already been given, or it is born a frame in
   * the past. The rest of the work is in `update`, which runs after the round
   * has had its chance to land.
   *
   * @param {number} dt the simulation's clock — the burst causes a hit-stop and
   *   is meant to stand in it
   */
  sync(dt) {
    this._dt = dt;
    this._clock += dt;
    if (this._age < this._until) this._age += dt;
  }

  /**
   * Place, size and fade every layer for this frame.
   *
   * @param {import('three').Camera} camera what the core and the haze face
   * @param {object} config `settings.gunplay.focus.burst`
   */
  update(camera, config) {
    if (!this.active) {
      this._standDown();
      return;
    }

    const t = this._age / Math.max(0.001, this._life);
    this._updateDecal(config, t);
    this._updateShell(config, t);
    this._updateCore(config, camera, t);
    this._updateSprites(config);
    this._updateHaze(config, t);
    this._updateDebris(config);
    this._updateLight(config, t);
  }

  /**
   * Set one off, here.
   *
   * @param {Vector3} point world, where the round stopped
   * @param {Vector3} direction unit, the way it was travelling — the debris and
   *   the shower are thrown *off* it rather than along it
   * @param {object} config `settings.gunplay.focus.burst`
   */
  fire(point, direction, config) {
    if (!config.enabled) return;

    this._at.copy(point);
    this._groundY = this.terrain ? this.terrain.heightAt(point.x, point.z) : point.y;
    this._age = 0;
    this._life = Math.max(0.1, config.life);
    // The longest any one thrown particle can live, against the multipliers the
    // emitters roll — see `_life` above for why this is a second number.
    this._until = Math.max(
      this._life,
      config.debrisEnabled === false ? 0 : config.debrisLife * 1.3,
      config.hazeEnabled === false ? 0 : config.hazeLife * 1.3,
      config.sparksEnabled === false ? 0 : config.sparkLife * 1.35,
      config.shardsEnabled === false ? 0 : config.shardLife * 1.3
    );
    this._roll = Math.random() * Math.PI * 2;
    this._seed = Math.random() * 90;

    this._emitSprites(config, direction);
    this._emitDebris(config, direction);
    this._emitHaze(config);
  }

  /** Everything on screen, gone — for leaving the stage and for a reset. */
  clear() {
    this._age = 0;
    this._life = 0;
    this._until = 0;
    this.sprites.geometry.instanceCount = 0;
    this.haze.geometry.instanceCount = 0;
    this.debris.count = 0;
    this._debrisLife.fill(0);
    this._standDown();
  }

  dispose() {
    for (const mesh of [this.decal, this.haze, this.debris, this.shell, this.sprites, this.core]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.light.dispose?.();
    this.group.parent?.remove(this.group);
  }

  /** Every layer dark. The light is turned down rather than hidden. */
  _standDown() {
    this.decal.visible = false;
    this.shell.visible = false;
    this.core.visible = false;
    this.sprites.visible = false;
    this.haze.visible = false;
    this.debris.visible = false;
    this.light.intensity = 0;
  }

  /* ------------------------------------------------------------------ */
  /* 1. the cracks                                                       */
  /* ------------------------------------------------------------------ */

  _buildDecal() {
    const terrain = this.terrain;
    const segments = terrain ? DECAL_SEGMENTS : 1;
    const geometry = new PlaneGeometry(1, 1, segments, segments).rotateX(-Math.PI / 2);

    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uColor: { value: makeColor('#2f9dff') },
        uCoreColor: { value: makeColor('#cdefff') },
        uAge: { value: 1 },
        uWrite: { value: 0.14 },
        uDetail: { value: 4.5 },
        uSpokes: { value: 9 },
        uScorch: { value: 0.5 },
        uFade: { value: 1 },
        uIntensity: { value: 1 },
        uSeed: { value: 0 },
        // A centimetre off the floor: the disc and the terrain mesh are the same
        // surface, and two surfaces at the same depth is a z-fight.
        uLift: { value: 0.02 },
        uExposure: frame.uExposure
      },
      vertexShader: DECAL_VERTEX(terrain),
      fragmentShader: DECAL_FRAGMENT
    });
    if (terrain) {
      Object.assign(material.uniforms, terrain.uniforms);
      material.defines.TERRAIN = '';
    }

    this.decal = new Mesh(geometry, material);
    this.decal.name = 'FocusCracks';
    // It irises out of nothing wherever the round happened to land; a bounding
    // sphere built at the origin survives neither half of that.
    this.decal.frustumCulled = false;
    this.decal.layers.set(LAYER.VFX);
    this.decal.renderOrder = 5;
    this.decal.visible = false;
    this.decal.raycast = () => {};
  }

  _updateDecal(config, t) {
    const shown = config.decalEnabled !== false && config.decalRadius > 0.01 && t < 1;
    this.decal.visible = shown;
    if (!shown) return;

    // How much floor there is to crack: all of it under a round that landed on
    // the ground, none at all under one that went off well above it.
    const height = Math.max(0, this._at.y - this._groundY);
    const reach = Math.max(0.01, config.decalReach);
    const fade = Math.max(0, 1 - height / reach);
    if (fade <= 0.001) {
      this.decal.visible = false;
      return;
    }

    this.decal.position.set(this._at.x, this._groundY, this._at.z);
    const radius = Math.max(0.05, config.decalRadius);
    this.decal.scale.set(radius * 2, 1, radius * 2);

    const u = this.decal.material.uniforms;
    copyColor(u.uColor.value, config.decalColor);
    copyColor(u.uCoreColor.value, config.decalCoreColor);
    u.uAge.value = t;
    u.uWrite.value = Math.max(0.01, config.decalWrite);
    u.uDetail.value = Math.max(0.5, config.decalDetail);
    u.uSpokes.value = Math.max(0, Math.round(config.decalSpokes));
    u.uScorch.value = config.decalScorch;
    u.uFade.value = fade;
    u.uIntensity.value = config.intensity;
    u.uSeed.value = this._seed;
  }

  /* ------------------------------------------------------------------ */
  /* 2. the haze                                                         */
  /* ------------------------------------------------------------------ */

  _buildHaze() {
    this._hazeData = new Float32Array(HAZE_CAPACITY * HAZE_STRIDE);
    this._hazeBuffer = new InstancedInterleavedBuffer(this._hazeData, HAZE_STRIDE, 1);
    this._hazeBuffer.setUsage(DynamicDrawUsage);

    const geometry = quadGeometry();
    geometry.setAttribute('aOrigin', new InterleavedBufferAttribute(this._hazeBuffer, 3, 0));
    geometry.setAttribute('aVelocity', new InterleavedBufferAttribute(this._hazeBuffer, 3, 3));
    geometry.setAttribute('aSeed', new InterleavedBufferAttribute(this._hazeBuffer, 1, 6));
    geometry.setAttribute('aBirth', new InterleavedBufferAttribute(this._hazeBuffer, 1, 7));
    geometry.setAttribute('aLife', new InterleavedBufferAttribute(this._hazeBuffer, 1, 8));
    geometry.setAttribute('aSize', new InterleavedBufferAttribute(this._hazeBuffer, 1, 9));
    geometry.instanceCount = 0;

    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // The quad is turned to face the lens in view space, so its winding is
      // not this file's to predict.
      side: DoubleSide,
      // The one layer here that is not light. See the class note.
      blending: NormalBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: makeColor('#c9d6e4') },
        uOpacity: { value: 0.34 },
        uGrowth: { value: 2.6 }
      },
      vertexShader: HAZE_VERTEX,
      fragmentShader: HAZE_FRAGMENT
    });

    this.haze = new Mesh(geometry, material);
    this.haze.name = 'FocusHaze';
    this.haze.frustumCulled = false;
    this.haze.layers.set(LAYER.VFX);
    // Under everything that is light, over the cracks on the floor.
    this.haze.renderOrder = 8;
    this.haze.visible = false;
    this.haze.raycast = () => {};
  }

  _emitHaze(config) {
    const wanted = config.hazeEnabled === false ? 0 : clampCount(config.haze, HAZE_CAPACITY);
    this.haze.geometry.instanceCount = wanted;
    if (wanted === 0) return;

    const rise = Math.max(0, config.hazeRise);
    const life = Math.max(0.05, config.hazeLife);
    const size = Math.max(0.02, config.hazeSize);
    const data = this._hazeData;

    for (let i = 0; i < wanted; i++) {
      const o = i * HAZE_STRIDE;
      // Out along the floor and up: a puff thrown radially reads as the ground
      // venting, and one thrown spherically reads as a ball of fog.
      const angle = Math.random() * Math.PI * 2;
      const out = 0.35 + Math.random() * 1.5;

      data[o] = this._at.x + Math.cos(angle) * out * 0.25;
      data[o + 1] = this._at.y + (Math.random() - 0.3) * 0.35;
      data[o + 2] = this._at.z + Math.sin(angle) * out * 0.25;
      data[o + 3] = Math.cos(angle) * out;
      data[o + 4] = rise * (0.5 + Math.random());
      data[o + 5] = Math.sin(angle) * out;
      data[o + 6] = Math.random();
      data[o + 7] = this._clock;
      data[o + 8] = life * (0.6 + Math.random() * 0.7);
      data[o + 9] = size * (0.6 + Math.random() * 0.9);
    }

    this._hazeBuffer.addUpdateRange(0, wanted * HAZE_STRIDE);
    this._hazeBuffer.needsUpdate = true;
  }

  _updateHaze(config, t) {
    const shown = config.hazeEnabled !== false && this.haze.geometry.instanceCount > 0;
    this.haze.visible = shown;
    if (!shown) return;

    const u = this.haze.material.uniforms;
    u.uTime.value = this._clock;
    copyColor(u.uColor.value, config.hazeColor);
    // Wound out over the burst's own tail as well as each puff's, so nothing is
    // left standing in the air after the light has gone.
    u.uOpacity.value = config.hazeOpacity * (1 - t * t);
    u.uGrowth.value = Math.max(1, config.hazeGrowth);
  }

  /* ------------------------------------------------------------------ */
  /* 3. the debris                                                       */
  /* ------------------------------------------------------------------ */

  _buildDebris() {
    this._debrisX = new Float32Array(DEBRIS_CAPACITY);
    this._debrisY = new Float32Array(DEBRIS_CAPACITY);
    this._debrisZ = new Float32Array(DEBRIS_CAPACITY);
    this._debrisVX = new Float32Array(DEBRIS_CAPACITY);
    this._debrisVY = new Float32Array(DEBRIS_CAPACITY);
    this._debrisVZ = new Float32Array(DEBRIS_CAPACITY);
    /** The tumble: an axis, and radians a second about it. */
    this._debrisAX = new Float32Array(DEBRIS_CAPACITY);
    this._debrisAY = new Float32Array(DEBRIS_CAPACITY);
    this._debrisAZ = new Float32Array(DEBRIS_CAPACITY);
    this._debrisRate = new Float32Array(DEBRIS_CAPACITY);
    /** Where each chunk has got to in its own tumble, as a quaternion. */
    this._debrisQuat = new Float32Array(DEBRIS_CAPACITY * 4);
    /** A chunk is a box, and a box that is a cube is a dice, not a chunk. */
    this._debrisSX = new Float32Array(DEBRIS_CAPACITY);
    this._debrisSY = new Float32Array(DEBRIS_CAPACITY);
    this._debrisSZ = new Float32Array(DEBRIS_CAPACITY);
    this._debrisAge = new Float32Array(DEBRIS_CAPACITY);
    this._debrisLife = new Float32Array(DEBRIS_CAPACITY);

    const material = new MeshStandardMaterial({
      color: 0xb8b3ac,
      roughness: 0.92,
      metalness: 0.0,
      // The chunks are a dozen centimetres across and the whole point of them is
      // that they catch the key light differently as they turn — smooth normals
      // on a box that size average that away to nothing.
      flatShading: true
    });

    this.debris = new InstancedMesh(new BoxGeometry(1, 1, 1), material, DEBRIS_CAPACITY);
    this.debris.name = 'FocusDebris';
    // Every matrix is rewritten every frame a chunk is in the air; the default
    // static hint would have the driver re-uploading a buffer it was told would
    // not change.
    this.debris.instanceMatrix.setUsage(DynamicDrawUsage);
    this.debris.frustumCulled = false;
    this.debris.castShadow = false;
    this.debris.receiveShadow = false;
    // The one lit layer, so it belongs on the layer everything lit is on.
    this.debris.layers.set(LAYER.WORLD);
    this.debris.count = 0;
    this.debris.visible = false;
  }

  _emitDebris(config, direction) {
    this._debrisLife.fill(0);
    const wanted = config.debrisEnabled === false ? 0 : clampCount(config.debris, DEBRIS_CAPACITY);
    if (wanted === 0) {
      this.debris.count = 0;
      return;
    }

    const speed = Math.max(0, config.debrisSpeed);
    const spread = Math.max(0, config.debrisSpread);
    const size = Math.max(0.005, config.debrisSize);
    const life = Math.max(0.1, config.debrisLife);

    // Off the round rather than along it: the floor gives way *upward* and a
    // little back the way the round came, which is what a chunk being knocked
    // out of a surface actually does.
    _axis.set(direction.x * 0.35, Math.abs(direction.y) * 0.4 + 0.75, direction.z * 0.35).normalize();

    for (let i = 0; i < wanted; i++) {
      const launch = speed * (0.35 + Math.random() * 1.1);
      const sx = (Math.random() - 0.5) * spread;
      const sy = (Math.random() - 0.5) * spread * 0.6;
      const sz = (Math.random() - 0.5) * spread;

      this._debrisX[i] = this._at.x;
      this._debrisY[i] = this._at.y;
      this._debrisZ[i] = this._at.z;
      this._debrisVX[i] = (_axis.x + sx) * launch;
      this._debrisVY[i] = (_axis.y + sy) * launch;
      this._debrisVZ[i] = (_axis.z + sz) * launch;

      _spin.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
      if (_spin.lengthSq() < 1e-6) _spin.set(0, 1, 0);
      _spin.normalize();
      this._debrisAX[i] = _spin.x;
      this._debrisAY[i] = _spin.y;
      this._debrisAZ[i] = _spin.z;
      this._debrisRate[i] = 5 + Math.random() * 12;

      const q = i * 4;
      this._debrisQuat[q] = 0;
      this._debrisQuat[q + 1] = 0;
      this._debrisQuat[q + 2] = 0;
      this._debrisQuat[q + 3] = 1;

      this._debrisSX[i] = size * (0.35 + Math.random() * 1.1);
      this._debrisSY[i] = size * (0.35 + Math.random() * 1.1);
      this._debrisSZ[i] = size * (0.35 + Math.random() * 1.1);
      this._debrisAge[i] = 0;
      this._debrisLife[i] = life * (0.6 + Math.random() * 0.7);
    }
  }

  /**
   * Advance the chunks and lay them down.
   *
   * The one thing worth knowing: live chunks are **compacted** into the front of
   * the instance range and `count` is set to how many there were. An
   * `InstancedMesh` draws its first `count` instances and nothing else, so a
   * dead chunk left where it died would either be drawn or would have to be
   * folded away in a shader this material does not have.
   */
  _updateDebris(config) {
    const shown = config.debrisEnabled !== false;
    this.debris.visible = shown;
    if (!shown) {
      this.debris.count = 0;
      return;
    }

    // Re-read every frame, because the whole point of the settings file is that
    // a colour is a live control — and there is exactly one material here.
    this.debris.material.color.copy(getColor(config.debrisColor));

    const dt = this._dt;
    const gravity = config.debrisGravity;
    let drawn = 0;

    for (let i = 0; i < DEBRIS_CAPACITY; i++) {
      if (this._debrisLife[i] <= 0) continue;

      this._debrisAge[i] += dt;
      const u = this._debrisAge[i] / this._debrisLife[i];
      if (u >= 1) {
        this._debrisLife[i] = 0;
        continue;
      }

      this._debrisVY[i] += gravity * dt;
      this._debrisX[i] += this._debrisVX[i] * dt;
      this._debrisY[i] += this._debrisVY[i] * dt;
      this._debrisZ[i] += this._debrisVZ[i] * dt;

      // The floor. A chunk that fell through it would be a chunk nobody sees
      // land, and landing is most of what the layer is for: it bounces once,
      // badly, sheds most of its speed and stops tumbling as it settles.
      const floor = this.terrain
        ? this.terrain.heightAt(this._debrisX[i], this._debrisZ[i])
        : this._groundY;
      const rest = floor + this._debrisSY[i] * 0.5;
      if (this._debrisY[i] < rest) {
        this._debrisY[i] = rest;
        this._debrisVY[i] = Math.abs(this._debrisVY[i]) * 0.28;
        this._debrisVX[i] *= 0.55;
        this._debrisVZ[i] *= 0.55;
        this._debrisRate[i] *= 0.5;
      }

      // The tumble, integrated as a turn about the chunk's own axis rather than
      // as three Euler rates — a box spun on Euler angles gimbals the moment it
      // is thrown anywhere but flat.
      const q = i * 4;
      _axis.set(this._debrisAX[i], this._debrisAY[i], this._debrisAZ[i]);
      _turn.setFromAxisAngle(_axis, this._debrisRate[i] * dt);
      _quaternion.set(
        this._debrisQuat[q],
        this._debrisQuat[q + 1],
        this._debrisQuat[q + 2],
        this._debrisQuat[q + 3]
      );
      _quaternion.premultiply(_turn).normalize();
      this._debrisQuat[q] = _quaternion.x;
      this._debrisQuat[q + 1] = _quaternion.y;
      this._debrisQuat[q + 2] = _quaternion.z;
      this._debrisQuat[q + 3] = _quaternion.w;

      // Shrunk away at the end rather than faded: the material is opaque, and
      // making it transparent for the last fifth of a chunk's life would cost
      // the whole layer its depth write.
      const shrink = 1 - smoothstep01(0.72, 1, u);
      _offset.set(this._debrisX[i], this._debrisY[i], this._debrisZ[i]);
      _scale.set(
        this._debrisSX[i] * shrink,
        this._debrisSY[i] * shrink,
        this._debrisSZ[i] * shrink
      );
      _matrix.compose(_offset, _quaternion, _scale);
      this.debris.setMatrixAt(drawn, _matrix);
      drawn++;
    }

    this.debris.count = drawn;
    if (drawn > 0) this.debris.instanceMatrix.needsUpdate = true;
  }

  /* ------------------------------------------------------------------ */
  /* 4. the shell                                                        */
  /* ------------------------------------------------------------------ */

  _buildShell() {
    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      // Both faces, so the far side of the cage shows through the near one —
      // which is the whole difference between a sphere and a disc.
      side: DoubleSide,
      fog: false,
      toneMapped: false,
      uniforms: {
        uColor: { value: makeColor('#3fa9ff') },
        uCoreColor: { value: makeColor('#d8f4ff') },
        uMeridians: { value: 6 },
        uParallels: { value: 3 },
        uArcWidth: { value: 0.05 },
        uRim: { value: 2.4 },
        uWarp: { value: 0.05 },
        uDetail: { value: 2.2 },
        uAge: { value: 1 },
        uIntensity: { value: 1 },
        uSeed: { value: 0 },
        uExposure: frame.uExposure
      },
      vertexShader: SHELL_VERTEX,
      fragmentShader: SHELL_FRAGMENT
    });

    this.shell = new Mesh(
      new SphereGeometry(1, SHELL_SEGMENTS, SHELL_RINGS),
      material
    );
    this.shell.name = 'FocusShell';
    this.shell.frustumCulled = false;
    this.shell.layers.set(LAYER.VFX);
    this.shell.renderOrder = 12;
    this.shell.visible = false;
    this.shell.raycast = () => {};
  }

  _updateShell(config, t) {
    const span = Math.max(0.02, config.shellLife);
    const u01 = t / span;
    const shown = config.shellEnabled !== false && u01 < 1;
    this.shell.visible = shown;
    if (!shown) return;

    // Out fast and slowing: `outQuint` is the shape of a front spreading
    // through a material, and the shell is the one layer whose *size* is the
    // read rather than its brightness.
    const front = 1 - Math.pow(1 - u01, 5);
    const radius = Math.max(0.05, config.radius) * (0.18 + front * 0.82);

    this.shell.position.copy(this._at);
    this.shell.scale.setScalar(radius);

    const u = this.shell.material.uniforms;
    copyColor(u.uColor.value, config.shellColor);
    copyColor(u.uCoreColor.value, config.shellCoreColor);
    u.uMeridians.value = Math.max(1, Math.round(config.meridians));
    u.uParallels.value = Math.max(1, Math.round(config.parallels));
    u.uArcWidth.value = Math.max(0.002, config.arcWidth);
    u.uRim.value = Math.max(0.2, config.shellRim);
    // The boil is authored in metres and applied on a unit sphere, so it is
    // divided by the radius it is about to be scaled by — otherwise the wobble
    // grows with the shell and the silhouette stops boiling and starts heaving.
    u.uWarp.value = Math.max(0, config.shellWarp) / radius;
    u.uDetail.value = Math.max(0.2, config.shellDetail);
    u.uAge.value = u01;
    u.uIntensity.value = config.intensity;
    u.uSeed.value = this._seed;
  }

  /* ------------------------------------------------------------------ */
  /* 5. the shower                                                       */
  /* ------------------------------------------------------------------ */

  _buildSprites() {
    this._spriteData = new Float32Array(SPRITE_CAPACITY * SPRITE_STRIDE);
    this._spriteBuffer = new InstancedInterleavedBuffer(
      this._spriteData,
      SPRITE_STRIDE,
      1
    );
    this._spriteBuffer.setUsage(DynamicDrawUsage);

    const geometry = quadGeometry();
    const b = this._spriteBuffer;
    geometry.setAttribute('aOrigin', new InterleavedBufferAttribute(b, 3, 0));
    geometry.setAttribute('aVelocity', new InterleavedBufferAttribute(b, 3, 3));
    geometry.setAttribute('aSeed', new InterleavedBufferAttribute(b, 1, 6));
    geometry.setAttribute('aBirth', new InterleavedBufferAttribute(b, 1, 7));
    geometry.setAttribute('aLife', new InterleavedBufferAttribute(b, 1, 8));
    geometry.setAttribute('aSize', new InterleavedBufferAttribute(b, 1, 9));
    geometry.setAttribute('aKind', new InterleavedBufferAttribute(b, 1, 10));
    geometry.setAttribute('aDrag', new InterleavedBufferAttribute(b, 1, 11));
    geometry.setAttribute('aGravity', new InterleavedBufferAttribute(b, 1, 12));
    geometry.setAttribute('aTint', new InterleavedBufferAttribute(b, 1, 13));
    geometry.instanceCount = 0;

    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        uSparkColor: { value: makeColor('#ffb257') },
        uShardColor: { value: makeColor('#66f0ff') },
        uShardColorAlt: { value: makeColor('#e07dff') },
        uStretch: { value: 0.05 },
        uIntensity: { value: 1 },
        uExposure: frame.uExposure
      },
      vertexShader: SPRITE_VERTEX,
      fragmentShader: SPRITE_FRAGMENT
    });

    this.sprites = new Mesh(geometry, material);
    this.sprites.name = 'FocusShower';
    this.sprites.frustumCulled = false;
    this.sprites.layers.set(LAYER.VFX);
    this.sprites.renderOrder = 13;
    this.sprites.visible = false;
    this.sprites.raycast = () => {};
  }

  _emitSprites(config, direction) {
    const sparks = config.sparksEnabled === false ? 0 : Math.max(0, Math.round(config.sparks));
    const shards = config.shardsEnabled === false ? 0 : Math.max(0, Math.round(config.shards));
    const total = Math.min(sparks + shards, SPRITE_CAPACITY);
    this.sprites.geometry.instanceCount = total;
    if (total === 0) return;

    // The pool is shared, so a settings block that asks for more than it holds
    // loses the tail of the shards rather than the head of the sparks.
    const sparkCount = Math.min(sparks, total);
    const shardCount = total - sparkCount;

    let slot = 0;
    // Reflected off the round: a sphere of sparks says a bomb went off in mid
    // air, and a hemisphere thrown back off the surface says something arrived.
    _axis.set(direction.x * 0.4, Math.abs(direction.y) * 0.5 + 0.5, direction.z * 0.4).normalize();

    for (let i = 0; i < sparkCount; i++) {
      const launch = Math.max(0, config.sparkSpeed) * (0.3 + Math.random() * 1.2);
      _spin.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(2);
      this._writeSprite(
        slot++,
        _axis.x * launch + _spin.x * launch * 0.6,
        _axis.y * launch + _spin.y * launch * 0.45,
        _axis.z * launch + _spin.z * launch * 0.6,
        Math.max(0.05, config.sparkLife) * (0.45 + Math.random() * 0.9),
        Math.max(0.002, config.sparkSize) * (0.6 + Math.random() * 0.9),
        SPARK,
        Math.max(0.02, config.sparkDrag),
        config.sparkGravity,
        0
      );
    }

    for (let i = 0; i < shardCount; i++) {
      // The cold half goes out in every direction and far harder — the shards
      // are what makes the burst read as something *breaking* rather than
      // something burning, and they have to outrun the shell to do it.
      _spin.set(
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
        Math.random() * 2 - 1
      );
      if (_spin.lengthSq() < 1e-6) _spin.set(0, 1, 0);
      _spin.normalize();
      const launch = Math.max(0, config.shardSpeed) * (0.5 + Math.random() * 0.9);
      this._writeSprite(
        slot++,
        _spin.x * launch,
        _spin.y * launch + launch * 0.15,
        _spin.z * launch,
        Math.max(0.05, config.shardLife) * (0.5 + Math.random() * 0.8),
        Math.max(0.002, config.shardSize) * (0.5 + Math.random() * 1.1),
        SHARD,
        Math.max(0.02, config.shardDrag),
        config.shardGravity,
        Math.random()
      );
    }

    this._spriteBuffer.addUpdateRange(0, total * SPRITE_STRIDE);
    this._spriteBuffer.needsUpdate = true;
  }

  /** One sprite into the pool, at the burst's own point. */
  _writeSprite(slot, vx, vy, vz, life, size, kind, drag, gravity, tint) {
    const data = this._spriteData;
    const o = slot * SPRITE_STRIDE;

    data[o] = this._at.x;
    data[o + 1] = this._at.y;
    data[o + 2] = this._at.z;
    data[o + 3] = vx;
    data[o + 4] = vy;
    data[o + 5] = vz;
    data[o + 6] = Math.random();
    data[o + 7] = this._clock;
    data[o + 8] = life;
    data[o + 9] = size;
    data[o + 10] = kind;
    data[o + 11] = drag;
    data[o + 12] = gravity;
    data[o + 13] = tint;
  }

  _updateSprites(config) {
    const shown = this.sprites.geometry.instanceCount > 0;
    this.sprites.visible = shown;
    if (!shown) return;

    const u = this.sprites.material.uniforms;
    u.uTime.value = this._clock;
    copyColor(u.uSparkColor.value, config.sparkColor);
    copyColor(u.uShardColor.value, config.shardColor);
    copyColor(u.uShardColorAlt.value, config.shardColorAlt);
    u.uStretch.value = Math.max(0, config.sparkStretch);
    u.uIntensity.value = config.intensity;
  }

  /* ------------------------------------------------------------------ */
  /* 6. the core                                                         */
  /* ------------------------------------------------------------------ */

  _buildCore() {
    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uColor: { value: makeColor('#eafaff') },
        uHalo: { value: makeColor('#38b6ff') },
        uAge: { value: 1 },
        uSpikes: { value: 4 },
        uSpikeLength: { value: 1.7 },
        uIntensity: { value: 1 },
        uExposure: frame.uExposure
      },
      vertexShader: CORE_VERTEX,
      fragmentShader: CORE_FRAGMENT
    });

    this.core = new Mesh(new PlaneGeometry(1, 1), material);
    this.core.name = 'FocusCore';
    this.core.frustumCulled = false;
    this.core.layers.set(LAYER.VFX);
    // The brightest thing in the frame on the instant it exists; it wins
    // wherever it overlaps.
    this.core.renderOrder = 14;
    this.core.visible = false;
    this.core.raycast = () => {};
  }

  _updateCore(config, camera, t) {
    const span = Math.max(0.02, config.coreLife);
    const u01 = t / span;
    const shown = config.coreEnabled !== false && u01 < 1;
    this.core.visible = shown;
    if (!shown) return;

    this.core.position.copy(this._at);
    this.core.quaternion.copy(camera.quaternion);
    // The star's bearing, rolled once per burst so two of them are never the
    // same shape. Rolling the quad rather than the pattern keeps it out of the
    // shader entirely.
    this.core.rotateZ(this._roll);
    const grow = 1 - Math.pow(1 - u01, 3);
    this.core.scale.setScalar(Math.max(0.05, config.coreSize) * (0.45 + grow * 0.55));

    const u = this.core.material.uniforms;
    copyColor(u.uColor.value, config.coreColor);
    copyColor(u.uHalo.value, config.coreHalo);
    u.uAge.value = u01;
    u.uSpikes.value = Math.max(0, Math.round(config.coreSpikes));
    u.uSpikeLength.value = Math.max(0, config.coreSpikeLength);
    u.uIntensity.value = config.intensity;
  }

  /* ------------------------------------------------------------------ */
  /* 7. the light                                                        */
  /* ------------------------------------------------------------------ */

  _updateLight(config, t) {
    // Cubed: the light is at full strength for barely two frames and then falls
    // off a cliff. A linear fade on a light this bright reads as a lamp being
    // switched off in a room.
    const remaining = Math.max(0, 1 - t);
    const strength = remaining * remaining * remaining;
    this.light.position.copy(this._at);
    this.light.color.copy(getColor(config.lightColor));
    this.light.intensity = Math.max(0, config.light) * strength * config.intensity;
    this.light.distance = Math.max(1, config.lightRange);
  }
}

/* -------------------------------------------------------------------- */
/* shared pieces                                                         */
/* -------------------------------------------------------------------- */

/** One quad, corners in [-1, 1], shared by every instance of a billboard layer. */
function quadGeometry() {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3)
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

const clampCount = (value, ceiling) =>
  Math.min(ceiling, Math.max(0, Math.round(value || 0)));

/** `smoothstep`, on the CPU, without pulling the whole maths module in twice. */
function smoothstep01(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0 || 1e-6)));
  return t * t * (3 - 2 * t);
}

/* -------------------------------------------------------------------- */
/* the cracks                                                            */
/* -------------------------------------------------------------------- */

const DECAL_VERTEX = (terrain) => /* glsl */ `
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
 * A web of cracks, written outward.
 *
 * Two patterns and they are doing different jobs. The **spokes** are the big
 * cracks — a handful of them, straight out of the middle, jittered off even
 * spacing by a noise sample so they are not a starburst. The **web** is
 * everything else: ridged noise, which is `1 - |snoise|` raised hard, and which
 * gives a mat of thin filaments for the price of one noise call.
 *
 * The `front` is what makes it read as *cracking* rather than as a decal that
 * faded up: the pattern is masked by an expanding radius, so the web arrives
 * from the middle outward over `uWrite`, with a hot leading edge on the front
 * while it travels.
 */
const DECAL_FRAGMENT = /* glsl */ `
${noiseGLSL}

uniform vec3 uColor;
uniform vec3 uCoreColor;
uniform float uAge;
uniform float uWrite;
uniform float uDetail;
uniform float uSpokes;
uniform float uScorch;
uniform float uFade;
uniform float uIntensity;
uniform float uSeed;
uniform float uExposure;

varying vec2 vUv;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float d = length(p);
  if (d > 1.0) discard;

  float t = clamp(uAge, 0.0, 1.0);
  float angle = atan(p.y, p.x);

  /* ---- the front ---- */
  float front = clamp(uAge / max(0.001, uWrite), 0.0, 1.0);
  front = 1.0 - (1.0 - front) * (1.0 - front);
  float written = 1.0 - smoothstep(front - 0.14, front, d);
  // The edge of the crack as it travels: brightest exactly where the ground is
  // giving way this instant.
  float edge = (1.0 - smoothstep(0.0, 0.1, abs(d - front))) * (1.0 - front);

  /* ---- the big cracks ---- */
  float jitter = snoise(vec3(cos(angle) * 1.7, sin(angle) * 1.7, uSeed)) * 0.6;
  float spoke = 0.0;
  if (uSpokes > 0.5) {
    spoke = pow(max(0.0, cos(angle * uSpokes + jitter)), 26.0);
    // Thinner as they run out, and never reaching the rim — a crack that ended
    // on the edge of the disc would end on a circle.
    spoke *= (1.0 - smoothstep(0.25, 1.0, d));
  }

  /* ---- the mat between them ---- */
  float ridge = 1.0 - abs(snoise(vec3(p * uDetail, uSeed * 0.7)));
  float web = pow(clamp(ridge, 0.0, 1.0), 16.0);
  web *= (1.0 - smoothstep(0.1, 0.95, d));

  /* ---- the burn under it ---- */
  float scorch = pow(max(0.0, 1.0 - d * 2.6), 2.4) * uScorch * pow(1.0 - t, 2.0);

  float fade = pow(1.0 - t, 1.4) * uFade;
  float lines = (spoke * 0.95 + web * 0.6) * written;
  float light = (lines + edge * 0.7) * fade + scorch * fade;
  if (light < 0.002) discard;

  float gain = uIntensity / max(uExposure, 0.01);
  vec3 rgb = uColor * light + uCoreColor * (lines * 0.45 + edge * 0.6 + scorch * 0.5) * fade;

  // Premultiplied against an additive blend: the alpha is the light.
  gl_FragColor = vec4(rgb * gain, light * gain);
}
`;

/* -------------------------------------------------------------------- */
/* the haze                                                              */
/* -------------------------------------------------------------------- */

const HAZE_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uGrowth;

attribute vec3 aOrigin;
attribute vec3 aVelocity;
attribute float aSeed;
attribute float aBirth;
attribute float aLife;
attribute float aSize;

varying vec2 vShape;
varying float vAge;
varying float vSeed;

void main() {
  float age = uTime - aBirth;

  if (aLife <= 0.0 || age < 0.0 || age >= aLife) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vShape = vec2(0.0);
    vAge = 1.0;
    vSeed = 0.0;
    return;
  }

  float u = age / aLife;
  // Heavy drag: a puff shoves outward on the blast and then almost stops, which
  // is the difference between smoke and a thrown ball of cotton.
  float slow = 1.0 - exp(-age * 2.4);
  vec3 pos = aOrigin + aVelocity * slow * 0.45;

  vec4 viewPos = viewMatrix * vec4(pos, 1.0);
  float size = aSize * mix(1.0, uGrowth, u);
  // A roll per puff, so fourteen of them are not fourteen copies of one shape.
  float roll = aSeed * 6.28318530718;
  vec2 corner = vec2(
    position.x * cos(roll) - position.y * sin(roll),
    position.x * sin(roll) + position.y * cos(roll)
  );
  viewPos.xy += corner * size;

  gl_Position = projectionMatrix * viewPos;
  vShape = position.xy;
  vAge = u;
  vSeed = aSeed;
}
`;

/**
 * One puff.
 *
 * A soft disc eaten into by an fbm field that crawls as the puff ages, so the
 * silhouette churns rather than simply growing. On `NormalBlending` and
 * straight (not premultiplied) alpha, because this layer is the one thing here
 * that is *occluding* rather than emitting.
 */
const HAZE_FRAGMENT = /* glsl */ `
${noiseGLSL}

uniform vec3 uColor;
uniform float uOpacity;

varying vec2 vShape;
varying float vAge;
varying float vSeed;

void main() {
  float d = length(vShape);
  if (d > 1.0) discard;

  float body = pow(max(0.0, 1.0 - d), 1.5);
  float churn = fbm3(vec3(vShape * 1.9, vSeed * 12.0 + vAge * 0.9));
  body *= mix(0.35, 1.0, churn);

  // In quickly, out slowly: the blast throws it and the air takes its time
  // giving it back.
  float envelope = smoothstep(0.0, 0.12, vAge) * (1.0 - smoothstep(0.35, 1.0, vAge));
  float a = body * envelope * uOpacity;
  if (a < 0.004) discard;

  gl_FragColor = vec4(uColor, a);
}
`;

/* -------------------------------------------------------------------- */
/* the shower                                                            */
/* -------------------------------------------------------------------- */

/**
 * Where a sprite is, and which way its quad is turned.
 *
 * Both kinds ride the same closed-form trajectory — linear drag under a
 * constant acceleration, which has an exact solution — and both are built in
 * **view space** along their own screen velocity, so a sprite points where it
 * is going. What differs is the shape of the quad: a spark's length grows with
 * how fast it is actually crossing the screen (a per-particle motion blur for
 * the price of normalising a vec2), and a shard's is fixed, because a needle
 * that got longer the faster it went would stop being a needle.
 */
const SPRITE_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uStretch;

attribute vec3 aOrigin;
attribute vec3 aVelocity;
attribute float aSeed;
attribute float aBirth;
attribute float aLife;
attribute float aSize;
attribute float aKind;
attribute float aDrag;
attribute float aGravity;
attribute float aTint;

varying vec2 vShape;
varying float vAge;
varying float vSeed;
varying float vKind;
varying float vTint;
varying float vHeat;

void main() {
  float age = uTime - aBirth;

  // Not yet born, already spent, or a slot never written. Folded to a
  // degenerate point outside the clip volume, which the rasteriser drops free.
  if (aLife <= 0.0 || age < 0.0 || age >= aLife) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vShape = vec2(0.0);
    vAge = 1.0;
    vSeed = 0.0;
    vKind = 0.0;
    vTint = 0.0;
    vHeat = 0.0;
    return;
  }

  float u = age / aLife;

  float k = max(0.02, aDrag);
  float decay = exp(-k * age);
  float impulse = (1.0 - decay) / k;
  vec3 accel = vec3(0.0, aGravity, 0.0);

  vec3 pos = aOrigin + aVelocity * impulse + accel * (age - impulse) / k;
  vec3 velocity = aVelocity * decay + accel * (1.0 - decay) / k;

  vec4 viewPos = viewMatrix * vec4(pos, 1.0);

  vec3 viewVel = (viewMatrix * vec4(velocity, 0.0)).xyz;
  float onScreen = length(viewVel.xy);
  // Nearly head-on: there is no direction on screen to point along, and
  // normalising noise would make the sprite flicker. It stays a dot, which is
  // what a spark coming at the lens actually looks like.
  vec2 along = onScreen > 1e-4 ? viewVel.xy / onScreen : vec2(0.0, 1.0);
  vec2 side = vec2(along.y, -along.x);

  float span;
  float across;
  if (aKind < 0.5) {
    span = aSize + onScreen * uStretch;
    across = aSize * (1.0 - 0.45 * u);
  } else {
    // A needle: long along its own travel, and a fraction of that across.
    span = aSize;
    across = aSize * 0.16 * (1.0 - 0.4 * u);
  }

  viewPos.xy += side * position.x * across + along * position.y * span;
  gl_Position = projectionMatrix * viewPos;

  vShape = position.xy;
  vAge = u;
  vSeed = aSeed;
  vKind = aKind;
  vTint = aTint;
  // How much of the white is left. Sparks cool fast; a shard holds its colour
  // almost all the way out, because it is not burning — it is lit.
  vHeat = pow(1.0 - u, aKind < 0.5 ? 2.4 : 1.2);
}
`;

/**
 * One spark, or one shard.
 *
 * The **spark** is a capsule with a hot head and a cold tail — brightest at the
 * leading end of its own streak, which is where the metal actually is when
 * something incandescent is moving.
 *
 * The **shard** is a rhombus: `1 - (|x| + |y|)`, which tapers to a point at
 * both ends and is the cheapest honest shape for a splinter of something
 * brittle. Half of them are drawn in the second colour, so the field reads as
 * two materials coming apart rather than one being tinted.
 */
const SPRITE_FRAGMENT = /* glsl */ `
uniform vec3 uSparkColor;
uniform vec3 uShardColor;
uniform vec3 uShardColorAlt;
uniform float uIntensity;
uniform float uExposure;

varying vec2 vShape;
varying float vAge;
varying float vSeed;
varying float vKind;
varying float vTint;
varying float vHeat;

void main() {
  float gain = uIntensity / max(uExposure, 0.01);
  vec3 rgb;
  float a;

  if (vKind < 0.5) {
    /* ---- one spark ---- */
    float across = 1.0 - abs(vShape.x);
    float along = 1.0 - abs(vShape.y);
    float shape = across * across * smoothstep(0.0, 0.5, along);
    float head = smoothstep(-0.2, 1.0, vShape.y);
    shape *= 0.25 + 0.75 * head;

    rgb = mix(uSparkColor, vec3(1.0), vHeat * 0.8);
    a = shape * (1.0 - smoothstep(0.5, 1.0, vAge)) * 1.6;
  } else {
    /* ---- one shard ---- */
    float rhombus = 1.0 - (abs(vShape.x) + abs(vShape.y));
    if (rhombus <= 0.0) discard;
    float shape = pow(rhombus, 0.75);
    // A bright spine down the middle, so the splinter has a facet on it rather
    // than being a flat lozenge of colour.
    shape += pow(max(0.0, 1.0 - abs(vShape.x) * 5.0), 3.0) * (1.0 - abs(vShape.y)) * 0.7;

    vec3 tint = mix(uShardColor, uShardColorAlt, step(0.5, vTint));
    rgb = mix(tint, vec3(1.0), vHeat * 0.5);
    a = shape * (1.0 - smoothstep(0.4, 1.0, vAge)) * 1.3;
  }

  a *= gain;
  if (a < 0.004) discard;

  // Premultiplied against an additive blend: the alpha is the light.
  gl_FragColor = vec4(rgb * gain, a);
}
`;

/* -------------------------------------------------------------------- */
/* the shell                                                             */
/* -------------------------------------------------------------------- */

const SHELL_VERTEX = /* glsl */ `
${noiseGLSL}

uniform float uWarp;
uniform float uDetail;
uniform float uAge;
uniform float uSeed;

varying vec3 vSurface;
varying vec3 vNormalW;
varying vec3 vView;

void main() {
  vec3 n = normalize(position);
  // The boil. The silhouette has to churn as the shell opens or the eye reads a
  // balloon being inflated — which is the one thing an explosion is not.
  float boil = snoise(vec3(n * uDetail) + vec3(uSeed, uSeed * 0.6, uAge * 2.2));
  vec3 local = n * (1.0 + boil * uWarp);

  vec4 world = modelMatrix * vec4(local, 1.0);

  vSurface = n;
  // The sphere is scaled uniformly, so the normal survives the model matrix
  // without an inverse-transpose.
  vNormalW = normalize(mat3(modelMatrix) * n);
  vView = normalize(cameraPosition - world.xyz);

  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * The cage.
 *
 * A fresnel rim — `pow(1 - |N·V|, k)` — is the whole reason this reads as a
 * volume rather than as a ball: a filled sphere of additive light is a white
 * blob, and a sphere lit only where it turns away from the lens is a surface
 * with an inside.
 *
 * The arcs are drawn on that surface in its own spherical coordinates:
 * `uMeridians` lines of longitude and `uParallels` of latitude, each one found
 * by how near the fragment is to a line of the lattice rather than by any
 * geometry. They are brightened *by* the rim as well as added to it, so the
 * cage is strongest exactly where the silhouette is — which is what stops the
 * lines reading as a texture painted on a ball.
 */
const SHELL_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uCoreColor;
uniform float uMeridians;
uniform float uParallels;
uniform float uArcWidth;
uniform float uRim;
uniform float uAge;
uniform float uIntensity;
uniform float uExposure;

varying vec3 vSurface;
varying vec3 vNormalW;
varying vec3 vView;

const float TAU = 6.28318530718;
const float PI = 3.14159265359;

void main() {
  vec3 n = normalize(vSurface);
  float facing = abs(dot(normalize(vNormalW), normalize(vView)));
  float rim = pow(1.0 - facing, uRim);

  // 0..1 round the sphere, and 0..1 from pole to pole.
  float lon = atan(n.z, n.x) / TAU + 0.5;
  float lat = asin(clamp(n.y, -1.0, 1.0)) / PI + 0.5;

  // Distance to the nearest line of each lattice, as a fraction of the gap
  // between them — so uArcWidth means the same thing whatever the counts are.
  float fm = fract(lon * uMeridians);
  float fp = fract(lat * uParallels);
  float dm = min(fm, 1.0 - fm) * 2.0;
  float dp = min(fp, 1.0 - fp) * 2.0;

  float meridian = 1.0 - smoothstep(uArcWidth, uArcWidth * 2.2, dm);
  float parallel = 1.0 - smoothstep(uArcWidth, uArcWidth * 2.2, dp);
  float lines = max(meridian, parallel);

  float t = clamp(uAge, 0.0, 1.0);
  float fade = pow(1.0 - t, 1.6);

  // The lines are lit by the rim rather than merely added to it.
  float cage = lines * (0.35 + rim * 1.3);
  float light = (cage + rim * 0.75) * fade;
  if (light < 0.003) discard;

  float gain = uIntensity / max(uExposure, 0.01);
  vec3 rgb = uColor * light + uCoreColor * cage * fade * 0.55;

  // Premultiplied against an additive blend: the alpha is the light.
  gl_FragColor = vec4(rgb * gain, light * gain);
}
`;

/* -------------------------------------------------------------------- */
/* the core                                                              */
/* -------------------------------------------------------------------- */

const CORE_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * The white of it.
 *
 * Three terms, and the first is the only one that matters: a point that is at
 * full strength for barely a frame. Everything else in this file is what the
 * player looks at *after* the flash, and the flash is what makes them look.
 */
const CORE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uHalo;
uniform float uAge;
uniform float uSpikes;
uniform float uSpikeLength;
uniform float uIntensity;
uniform float uExposure;

varying vec2 vUv;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float d = length(p);
  if (d > 1.0) discard;

  float t = clamp(uAge, 0.0, 1.0);

  // The point. A fourth power: it has to be gone by the frame after the one the
  // round landed on, or the whole shot reads as a lamp switching on.
  float core = exp(-d * d * 34.0) * pow(1.0 - t, 4.0) * 2.6;
  // The air around it, which is the layer doing the work the bloom pass is not:
  // the stage blooms at hundredths, so anything meant to glow draws its own.
  float halo = pow(max(0.0, 1.0 - d), 2.8) * pow(1.0 - t, 1.6) * 0.85;

  // The star. Its bearing is the quad's own roll, set per burst on the CPU.
  float star = 0.0;
  if (uSpikes > 0.5) {
    float angle = atan(p.y, p.x);
    float lobe = pow(max(0.0, cos(angle * uSpikes)), 20.0);
    float reach = max(1e-3, uSpikeLength * (0.4 + 0.6 * (1.0 - t)));
    float taper = 1.0 - smoothstep(0.0, reach, d);
    star = lobe * taper * taper * pow(1.0 - t, 2.4) * 1.5;
  }

  float light = core + halo + star;
  if (light < 0.003) discard;

  float gain = uIntensity / max(uExposure, 0.01);
  vec3 rgb = uColor * (core + star) + uHalo * halo;
  // The first instant is white whatever colour was picked — a flash the eye can
  // find a hue in is a flash that was not bright enough.
  rgb = mix(rgb, vec3(light), pow(1.0 - t, 6.0) * 0.7);

  // Premultiplied against an additive blend: the alpha is the light.
  gl_FragColor = vec4(rgb * gain, light * gain);
}
`;
