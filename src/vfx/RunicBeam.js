import {
  AdditiveBlending,
  BufferAttribute,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  PlaneGeometry,
  PointLight,
  ShaderMaterial,
  Vector3
} from 'three';

import { settings } from '../config/settings.js';
import { frame } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { copyColor, makeColor } from '../utils/color.js';
import { Easing } from '../utils/math.js';
import { BladeImpact } from './BladeImpact.js';
import { SummonSeal } from './SummonSeal.js';

const TAU = Math.PI * 2;

/** Segments around the column and up it. The height needs the resolution: the
 *  striations run along it and the head has to have a clean edge to cut at. */
const COLUMN_RADIAL = 44;
const COLUMN_RINGS = 32;

/** Ribbons the spiral layer can draw, and quads along each one. */
const SPIRALS = 6;
const SPIRAL_SEGMENTS = 112;

/** Ceiling on the void grain. */
const MOTES = 320;
/** angle radius spread rise swirl size rate phase — one mote, one stride. */
const MOTE_STRIDE = 8;

const _at = new Vector3();

/**
 * The void runic beam: a rune opens under a body and something comes up it.
 *
 * ## What it is, and why it is not another burst
 *
 * Every other thing the player throws is an *event* — a crescent that crosses
 * the ground, a fist that comes down, a sphere torn open on a contact point.
 * All of them are over in half a second, and all of them are read as the moment
 * they happened. This is the opposite: a column standing in the world for the
 * better part of two seconds with a body burning away inside it. The pacing is
 * the whole point, and it is why this is a small state machine like
 * `vfx/Judgement.js` rather than a pooled emitter like `vfx/RiftBurst.js` —
 * there is only ever one of these, and what matters about it is the order its
 * beats arrive in.
 *
 * ## The five layers
 *
 * Stacked back to front, one draw call and one idea each, and every one of them
 * has an `*Enabled` flag in `settings.voidBeam` so it can be soloed against the
 * other four — which is the only sane way to tune a stack of additive light.
 *
 * 1. **The runes.** `vfx/SummonSeal.js`, unchanged, laid flat on the ground
 *    under the mark instead of hung overhead. It is the same circle the
 *    judgement opens and it is deliberately the same circle: the two abilities
 *    reach into the same place, and a second, differently-drawn seal would say
 *    they do not. It writes itself anticlockwise from the top over `open`, so
 *    the pattern *arrives* rather than fading up.
 *
 * 2. **The beam.** An open cylinder drawn on its own *middle* rather than its
 *    rim — `pow(facing, k)`, which is the inverse of the fresnel a shell wants:
 *    a hollow tube lit on its silhouette is a pipe, and one lit down the axis
 *    the lens is looking through is a column of light. Its surface is a
 *    seamless noise field scrolling *downward*, because something coming up out
 *    of the ground has to have texture falling through it or the eye reads a
 *    static gradient and stops looking.
 *
 * 3. **The spirals.** Ribbons wound round the column, gold against its violet.
 *    Each one is a helix evaluated in the vertex shader — the geometry is a
 *    parameter strip and nothing else — and widened *across the screen* rather
 *    than in the world, so a cord can never turn edge-on to the lens and blink.
 *    They are what stops the beam being a cylinder: a straight column has no
 *    motion in it at all, and three cords racing up it have nothing but.
 *
 * 4. **The burst.** `vfx/BladeImpact.js`, reused exactly as the combo reuses
 *    it, thrown straight up from the foot of the column on the frame it opens.
 *    It is already what a hit looks like; there is no reason to draw a second.
 *
 * 5. **The grain.** A few hundred four-pointed shards orbiting the column and
 *    rising through it. Each one loops on its own clock (`fract`, not a
 *    lifetime), so the field is continuous for as long as the beam stands
 *    without a single re-emission: the pool is written once, at the strike, and
 *    read as a closed form every frame after.
 *
 * One light serves all five.
 *
 * ## What it owns, and what it does not
 *
 * The look and the pacing between the beats. Nothing else. It does not know
 * who is under it, what being hit costs, or that the body burning away inside
 * it is burning because of anything it did — `core/App.js` unmakes the body on
 * the same frame it calls `fire`, on the same path every other attack takes.
 * Like `vfx/SwordCombo.js`, this class draws a thing and moves it.
 */
export class RunicBeam {
  /**
   * @param {object} [options]
   * @param {{heightAt: (x: number, z: number) => number}|null} [options.terrain]
   *   where the foot of the column goes. Without it the beam stands on the
   *   body's own y, which on flat ground is the same answer.
   */
  constructor({ terrain = null } = {}) {
    this.terrain = terrain;

    /** Everything it is, in world space. Add it to the scene. */
    this.group = new Group();
    this.group.name = 'RunicBeam';

    // Grounded, unlike the judgement's: this circle is struck into the floor at
    // somebody's feet rather than hung in the air over their head, so it is
    // subdivided and every vertex is dropped onto the height field. Without
    // that it is buried on the uphill side of the first slope it opens on.
    this.seal = new SummonSeal({ terrain });
    this.impact = new BladeImpact();
    this.group.add(this.seal.mesh, this.impact.mesh);

    this._buildColumn();
    this._buildSpirals();
    this._buildMotes();
    this.group.add(this.column, this.spirals, this.motes);

    // One light for the whole cast. Never casts a shadow: a shadow map
    // re-rendered for a light that lives two seconds costs more than all five
    // layers above it put together.
    this.light = new PointLight(0x9b5cff, 0, 16, 1.8);
    this.light.name = 'RunicBeamLight';
    this.light.castShadow = false;
    this.group.add(this.light);

    /** @type {'idle'|'open'|'charge'|'strike'|'hold'|'close'} */
    this.state = 'idle';
    /** Seconds in the current state. */
    this.timer = 0;

    /** Where the foot of it is: the mark's ground, fixed on the frame it opens. */
    this._ground = new Vector3();
    /** Which way round the circle is, radians about +Y. */
    this._yaw = 0;
    /** The ripple leaving the seal after the column came through, 0..1. */
    this._punch = 1;
    /** What is left of the strike's own flash, 0..1. */
    this._flash = 0;
    /** Seconds the grain has been looping — the one clock all of it reads. */
    this._grain = 0;
    /** How many shards the last cast dealt orbits to. */
    this._moteCount = 0;
    /**
     * Whether this cast ever got its column up.
     *
     * `close` is reached two ways — after a beam has stood, and by a rune that
     * fizzled because the body it was written under died to something else in
     * between. The two look completely different on the way out, and without
     * this the second of them pops a full column into existence for the half
     * second it takes to fold, which is the exact opposite of what a cast
     * losing its target should look like.
     */
    this._fired = false;
  }

  /** Live tuning, read per frame so the editor's edits land immediately. */
  get config() {
    return settings.voidBeam;
  }

  /** Whether a rune is open, a column is standing, or either is folding away. */
  get active() {
    return this.state !== 'idle';
  }

  /* ------------------------------------------------------------------ */
  /* the beats                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * The first beat: a rune writes itself into the ground under a body.
   *
   * Nothing is hurt by this and nothing is committed. The circle is a *promise*
   * — it is the beat where the player and the body both know what is coming and
   * neither can stop it, and taking it out would leave a column that simply
   * appears, which is a projectile rather than a summons.
   *
   * Where it opens is fixed here, on this frame: the rune is a hole in the
   * world, not a decal that follows anyone about.
   *
   * A cast that is still *folding away* is interrupted rather than refused:
   * the move takes two seconds and the beam takes a little longer, so two
   * presses in a row would otherwise leave the second one killing a body with
   * no rune under it. Anything earlier than that is refused — a second press
   * during a beat that is still happening must not restart it.
   *
   * @param {{position: Vector3}|null} target the body the punch was locked on
   * @returns {boolean} whether the rune was taken
   */
  open(target) {
    const config = this.config;
    if (!config.enabled || !target) return false;
    if (this.state !== 'idle' && this.state !== 'close') return false;

    const position = target.position;
    this._ground.set(
      position.x,
      this.terrain ? this.terrain.heightAt(position.x, position.z) : position.y,
      position.z
    );
    // Two casts in a row should not put the same glyph over the same shoulder.
    this._yaw = Math.random() * TAU;
    this.seal.reseed();
    this.seal.place(
      this._ground.x,
      this._ground.y + Math.max(0, config.seal.lift),
      this._ground.z,
      this._yaw
    );

    this._punch = 1;
    this._flash = 0;
    this._grain = 0;
    this._fired = false;
    this._writeMotes(config);
    this._enter('open');
    return true;
  }

  /**
   * The second beat: the column comes up.
   *
   * Everything opens on the same frame because they are the same event — the
   * beam, the cords, the burst at its foot, the ripple leaving the rune, the
   * grain, the light, and the body `core/App.js` unmakes in parallel.
   * Staggering any of them would turn one blow into a sequence of small ones.
   *
   * It is deliberately callable from any state the rune is in rather than only
   * from a finished `charge`: the beat that fires this is a frame in a clip,
   * and the clip is the authority on when the fist comes down. A rune only
   * three quarters written is snapped to whole here, which reads as the drawing
   * being *interrupted* by what it summoned — no worse than the alternative,
   * which is a beam that waits politely for its own circle.
   *
   * @param {{position: Vector3}|null} [target] re-aims the foot of it, if the
   *   body has moved since the rune was opened
   * @returns {boolean} whether anything fired
   */
  fire(target = null) {
    const config = this.config;
    if (!config.enabled) return false;
    if (this.state === 'idle' || this.state === 'strike' || this.state === 'hold') return false;

    if (target?.position) {
      const position = target.position;
      this._ground.set(
        position.x,
        this.terrain ? this.terrain.heightAt(position.x, position.z) : position.y,
        position.z
      );
      this.seal.place(
        this._ground.x,
        this._ground.y + Math.max(0, config.seal.lift),
        this._ground.z,
        this._yaw
      );
      this._writeMotes(config);
    }

    // Thrown straight up, which is the direction the column left along — the
    // star of spikes `BladeImpact` draws points the way the thing was going,
    // and a burst that is radially symmetric has no direction in it.
    this.impact.burst(
      this._ground.x,
      this._ground.y + Math.max(0, config.impactHeight),
      this._ground.z,
      0,
      1,
      0,
      config.impact,
      Math.max(0, config.strikeFlash)
    );

    this._punch = 0;
    this._flash = 1;
    this._grain = 0;
    this._fired = true;
    this._enter('strike');
    return true;
  }

  /**
   * Stop it, wherever it had got to.
   *
   * @param {{immediate?: boolean}} [options] `immediate` drops everything on the
   *   spot — for leaving the stage, where a close would only be paused halfway
   *   through and resumed on the way back.
   */
  dismiss({ immediate = false } = {}) {
    if (immediate) {
      this.clear();
      return;
    }
    if (!this.active || this.state === 'close') return;
    this._enter('close');
  }

  /** Everything off, immediately — for leaving the stage and for a reset. */
  clear() {
    this.state = 'idle';
    this.timer = 0;
    this._fired = false;
    this.seal.clear();
    this.impact.clear();
    this.column.visible = false;
    this.spirals.visible = false;
    this.motes.visible = false;
    this._flash = 0;
    this.light.intensity = 0;
    this.light.visible = false;
  }

  /* ------------------------------------------------------------------ */
  /* the frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number} dt seconds, on the *simulation's* clock — the whole thing is
   *   combat, so it slows with the hit-stop it causes and stops with `P`
   * @param {number} elapsed the shared clock, for the rune's own turning and
   *   the noise crawling down the column
   */
  update(dt, elapsed) {
    const config = this.config;

    // Before anything can emit into it, so a spark born by this frame's strike
    // is stamped with a clock the shader has already been given.
    this.impact.sync(elapsed, config.impact);
    this._advance(dt, elapsed, config);
  }

  /** The beat itself. Everything with a clock in it is in here. */
  _advance(dt, elapsed, config) {
    if (!this.active) {
      this.seal.update(config.seal, { fade: 0, scale: 0 }, elapsed);
      this.column.visible = false;
      this.spirals.visible = false;
      this.motes.visible = false;
      this.light.visible = false;
      this.light.intensity = 0;
      return;
    }

    this.timer += dt;
    this._grain += dt;

    const beats = config.beats;
    /** 0..1 through the current beat. */
    const t = (seconds) => Math.min(1, this.timer / Math.max(1e-3, seconds));

    let open = 1;
    let scale = 1;
    let charge = 0;
    let fade = 1;
    /** How far up its own height the column has got, 0..1. */
    let reach = 0;
    /** How much of its own radius it has, 0..1. */
    let girth = 1;

    switch (this.state) {
      case 'open': {
        const u = t(beats.open);
        // Written and irised out on the same beat, so the circle arrives in the
        // order a hand would have struck it.
        open = u;
        scale = Easing.outBack(u);
        charge = u * 0.3;
        if (u >= 1) this._enter('charge');
        break;
      }

      case 'charge': {
        const u = t(beats.charge);
        charge = 0.3 + 0.7 * Easing.outQuad(u);
        // The rune is not normally left to run out: the clip's second punch
        // fires the column somewhere in the middle of this. Reaching the end is
        // the cast having lost whatever it was for — the body died to something
        // else in the meantime — and it folds away rather than firing at grass.
        if (u >= 1) this._enter('close');
        break;
      }

      case 'strike': {
        const u = t(beats.strike);
        charge = 1;
        // Out of the ground at speed and slowing as it arrives: an `outExpo`,
        // which spends most of its length in the first fifth of the beat. The
        // column is at half its height in the first three frames, which is the
        // whole difference between something erupting and something growing.
        reach = Easing.outExpo(u);
        // And fat on the frame it opens, settling back to its own width. The
        // swell is small on purpose — past about a half it stops reading as a
        // pressure wave and starts reading as a different, wider beam.
        girth = 1 + (config.beam.swell ?? 0) * (1 - u) * (1 - u);
        if (u >= 1) this._enter('hold');
        break;
      }

      case 'hold': {
        const u = t(beats.hold);
        charge = 1;
        reach = 1;
        // Breathing rather than steady. A column at a constant width for a
        // second and a half is a cylinder someone forgot to animate.
        girth = 1 + (config.beam.breathe ?? 0) * Math.sin(elapsed * (config.beam.breatheSpeed ?? 9));
        if (u >= 1) this._enter('close');
        break;
      }

      case 'close': {
        const u = t(beats.close);
        charge = 0.3 * (1 - u);
        // Only if there is one. A rune that lost its target folds away with
        // nothing standing in it — see `_fired`.
        reach = this._fired ? 1 : 0;
        // It is pinched out rather than faded out: the width goes first and the
        // brightness follows it, so the last thing on screen is a thread of
        // light rather than a translucent tube.
        girth = 1 - Easing.inCubic(u);
        scale = 1 - Easing.inCubic(u);
        fade = 1 - u;
        if (u >= 1) {
          this._enter('idle');
          this.seal.update(config.seal, { fade: 0, scale: 0 }, elapsed);
          this.column.visible = false;
          this.spirals.visible = false;
          this.motes.visible = false;
          this.light.visible = false;
          this.light.intensity = 0;
          return;
        }
        break;
      }

      default:
        break;
    }

    this._punch = Math.min(1, this._punch + dt / Math.max(0.02, beats.ripple));
    this._flash = Math.max(0, this._flash - dt / Math.max(0.02, config.light.decay));

    this.seal.update(
      config.seal,
      { open, scale, charge, punch: this._punch < 1 ? this._punch : 0, fade },
      elapsed
    );
    this._syncColumn(config, elapsed, reach, girth, fade, charge);
    this._syncSpirals(config, elapsed, reach, girth, fade);
    this._syncMotes(config, reach, fade);
    this._syncLight(config, reach, charge);
  }

  /** Move into a state, and start its clock. */
  _enter(state) {
    this.state = state;
    this.timer = 0;
  }

  /* ------------------------------------------------------------------ */
  /* layer 2 — the beam                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * An open cylinder, unit high and unit wide.
   *
   * Every metre of it is put there by the mesh's own scale rather than by the
   * geometry, so the height and the radius are live sliders and the buffer is
   * built once. `uv.y` runs 0 at the foot to 1 at the crown, which is the
   * parameter the head, the flare and the fade are all written against.
   */
  _buildColumn() {
    const geometry = new CylinderGeometry(
      1,
      1,
      1,
      COLUMN_RADIAL,
      COLUMN_RINGS,
      true
    ).translate(0, 0.5, 0);

    this.columnMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      // Depth-*tested*, so the column is properly buried by a hill between it
      // and the lens. It is a thing standing in the world, not an overlay.
      depthTest: true,
      blending: AdditiveBlending,
      // Both faces, and the far wall is most of the look: the light the lens
      // sees down the middle of the tube is the front and the back adding up,
      // which is exactly what a volume does and what one wall cannot fake.
      side: DoubleSide,
      fog: false,
      toneMapped: false,
      uniforms: {
        uCoreColor: { value: makeColor('#ffffff') },
        uInnerColor: { value: makeColor('#9fd8ff') },
        uEdgeColor: { value: makeColor('#7b3dff') },
        uIntensity: { value: 2.2 },
        uCorePower: { value: 3.2 },
        uGlowPower: { value: 0.85 },
        uFlare: { value: 0.5 },
        uReach: { value: 0 },
        uFade: { value: 1 },
        uCharge: { value: 0 },
        uGrain: { value: 3.4 },
        uRingScale: { value: 1.7 },
        uFlow: { value: 1.55 },
        uErode: { value: 0.55 },
        uHeadWidth: { value: 0.07 },
        uFootGlow: { value: 0.18 },
        uCrown: { value: 0.62 },
        uSeed: { value: 0 },
        uTime: { value: 0 },
        uExposure: frame.uExposure
      },
      vertexShader: COLUMN_VERTEX,
      fragmentShader: COLUMN_FRAGMENT
    });

    this.column = new Mesh(geometry, this.columnMaterial);
    this.column.name = 'RunicBeamColumn';
    // It is scaled from nothing and moved to wherever the mark was standing,
    // neither of which a bounding sphere built at the origin survives.
    this.column.frustumCulled = false;
    this.column.layers.set(LAYER.VFX);
    this.column.renderOrder = 5;
    this.column.visible = false;
    this.column.raycast = () => {};
  }

  _syncColumn(config, elapsed, reach, girth, fade, charge) {
    const beam = config.beam;
    const u = this.columnMaterial.uniforms;

    this.column.visible = beam.enabled && reach > 0.001 && fade > 0.001 && girth > 0.001;
    if (!this.column.visible) return;

    const radius = Math.max(0.01, beam.radius) * girth;
    this.column.position.copy(this._ground);
    this.column.scale.set(radius, Math.max(0.1, beam.height), radius);

    copyColor(u.uCoreColor.value, beam.coreColor);
    copyColor(u.uInnerColor.value, beam.innerColor);
    copyColor(u.uEdgeColor.value, beam.edgeColor);
    u.uIntensity.value = beam.intensity;
    u.uCorePower.value = Math.max(0.05, beam.corePower);
    u.uGlowPower.value = Math.max(0.05, beam.glowPower);
    u.uFlare.value = beam.flare;
    u.uGrain.value = beam.grain;
    u.uRingScale.value = beam.swirl;
    u.uFlow.value = beam.flow;
    u.uErode.value = beam.erode;
    u.uHeadWidth.value = Math.max(0.005, beam.headWidth);
    u.uFootGlow.value = Math.max(0.01, beam.footGlow);
    u.uCrown.value = Math.min(0.999, Math.max(0, beam.crown));
    u.uReach.value = reach;
    u.uFade.value = fade;
    u.uCharge.value = charge;
    u.uSeed.value = this._yaw;
    u.uTime.value = elapsed;
  }

  /* ------------------------------------------------------------------ */
  /* layer 3 — the spirals                                               */
  /* ------------------------------------------------------------------ */

  /**
   * One strip of quads, instanced once per cord.
   *
   * The geometry is a *parameter domain* and nothing else: `position.x` is how
   * far along the cord a vertex is and `position.y` is which side of it. Where
   * that lands in the world is the helix in the vertex shader, so the radius,
   * the height, the number of turns and the handedness are all uniforms and the
   * buffer never changes.
   */
  _buildSpirals() {
    const strip = new PlaneGeometry(1, 1, SPIRAL_SEGMENTS, 1).translate(0.5, 0.5, 0);

    const geometry = new InstancedBufferGeometry();
    // The strip's own buffers, carried over rather than copied — and it is
    // deliberately *not* disposed afterwards: they are the same objects, and
    // freeing them through the source would take them out from under this one.
    geometry.setAttribute('position', strip.getAttribute('position'));
    geometry.setIndex(strip.getIndex());

    const phases = new Float32Array(SPIRALS);
    const hands = new Float32Array(SPIRALS);
    const tints = new Float32Array(SPIRALS);
    for (let i = 0; i < SPIRALS; i++) {
      // Spread evenly about the column, and every other one wound the *other*
      // way. Two cords turning the same way read as one thick cord; two turning
      // against each other read as something being wound.
      phases[i] = (i / SPIRALS) * TAU;
      hands[i] = i % 2 === 0 ? 1 : -1;
      // Alternating between the two colours in the block, so the gold and the
      // violet cross rather than sitting on the same side of the column.
      tints[i] = i % 2 === 0 ? 0 : 1;
    }
    geometry.setAttribute('aPhase', new InstancedBufferAttribute(phases, 1));
    geometry.setAttribute('aHand', new InstancedBufferAttribute(hands, 1));
    geometry.setAttribute('aTint', new InstancedBufferAttribute(tints, 1));
    geometry.instanceCount = 0;

    this.spiralMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      side: DoubleSide,
      fog: false,
      toneMapped: false,
      uniforms: {
        uCoreColor: { value: makeColor('#fff4d6') },
        uColorA: { value: makeColor('#ffbe4d') },
        uColorB: { value: makeColor('#c46bff') },
        uIntensity: { value: 2.6 },
        uSharp: { value: 2.6 },
        uRadius: { value: 0.62 },
        uHeight: { value: 6.5 },
        uTurns: { value: 2.4 },
        uWidth: { value: 0.09 },
        uSpin: { value: 1.7 },
        uFlare: { value: 0.55 },
        uReach: { value: 0 },
        uFade: { value: 1 },
        uTaper: { value: 0.55 },
        uPulse: { value: 14 },
        uTime: { value: 0 },
        uExposure: frame.uExposure
      },
      vertexShader: SPIRAL_VERTEX,
      fragmentShader: SPIRAL_FRAGMENT
    });

    this.spirals = new Mesh(geometry, this.spiralMaterial);
    this.spirals.name = 'RunicBeamSpirals';
    this.spirals.frustumCulled = false;
    this.spirals.layers.set(LAYER.VFX);
    // In front of the column: the cords are wound round the outside of it, and
    // additive layers have no depth order of their own to say so.
    this.spirals.renderOrder = 6;
    this.spirals.visible = false;
    this.spirals.raycast = () => {};
  }

  _syncSpirals(config, elapsed, reach, girth, fade) {
    const spiral = config.spiral;
    const u = this.spiralMaterial.uniforms;

    const count = Math.min(SPIRALS, Math.max(0, Math.round(spiral.count)));
    this.spirals.visible = spiral.enabled && count > 0 && reach > 0.001 && fade > 0.001;
    if (!this.spirals.visible) return;

    this.spirals.geometry.instanceCount = count;
    // Unit-scaled on purpose: the ribbon's width is applied in *view* space, so
    // a scale on the mesh would stretch the cord's thickness with its radius
    // and the whole layer would thicken as it swelled.
    this.spirals.position.copy(this._ground);

    copyColor(u.uCoreColor.value, spiral.coreColor);
    copyColor(u.uColorA.value, spiral.colorA);
    copyColor(u.uColorB.value, spiral.colorB);
    u.uIntensity.value = spiral.intensity;
    u.uSharp.value = Math.max(0.2, spiral.sharpness);
    u.uRadius.value = Math.max(0.01, spiral.radius) * girth;
    u.uHeight.value = Math.max(0.1, config.beam.height) * Math.max(0.05, spiral.reach);
    u.uTurns.value = spiral.turns;
    u.uWidth.value = Math.max(0.001, spiral.width);
    u.uSpin.value = spiral.spin;
    u.uFlare.value = spiral.flare;
    u.uTaper.value = Math.min(1, Math.max(0, spiral.taper));
    u.uPulse.value = spiral.pulse;
    u.uReach.value = reach;
    u.uFade.value = fade;
    u.uTime.value = elapsed;
  }

  /* ------------------------------------------------------------------ */
  /* layer 5 — the grain                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * A pool of camera-facing quads, each carrying its own orbit.
   *
   * Written once, at the strike, and read as a closed form every frame after —
   * so the field costs one uniform write a frame however many shards are in it,
   * and nothing here allocates once the beam is standing.
   */
  _buildMotes() {
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3)
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);

    this._moteData = new Float32Array(MOTES * MOTE_STRIDE);
    // Four interleaved reads out of one buffer: cheaper than four attributes
    // and, more to the point, one `needsUpdate` instead of four.
    this._moteBuffer = new InstancedInterleavedBuffer(this._moteData, MOTE_STRIDE, 1);
    this._moteBuffer.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aPolar', new InterleavedBufferAttribute(this._moteBuffer, 3, 0));
    geometry.setAttribute('aDrift', new InterleavedBufferAttribute(this._moteBuffer, 3, 3));
    geometry.setAttribute('aRate', new InterleavedBufferAttribute(this._moteBuffer, 1, 6));
    geometry.setAttribute('aPhase', new InterleavedBufferAttribute(this._moteBuffer, 1, 7));
    geometry.instanceCount = 0;

    this.moteMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uCoreColor: { value: makeColor('#e6d4ff') },
        uMoteColor: { value: makeColor('#6a3cff') },
        uIntensity: { value: 2.4 },
        uOrigin: { value: new Vector3() },
        uAge: { value: 0 },
        uCeiling: { value: 0 },
        uFade: { value: 1 },
        uSpike: { value: 6.5 },
        uExposure: frame.uExposure
      },
      vertexShader: MOTE_VERTEX,
      fragmentShader: MOTE_FRAGMENT
    });

    this.motes = new Mesh(geometry, this.moteMaterial);
    this.motes.name = 'RunicBeamMotes';
    this.motes.frustumCulled = false;
    this.motes.layers.set(LAYER.VFX);
    this.motes.renderOrder = 7;
    this.motes.visible = false;
    this.motes.raycast = () => {};
  }

  /**
   * Deal every shard its orbit.
   *
   * Done once per cast rather than per frame: a shard's whole path is eight
   * numbers, and the only thing that changes after this is the clock. The
   * spread of `rate` is what keeps the field from pulsing — three hundred
   * shards on one period is a strobe, and three hundred on their own periods is
   * a column of dust.
   */
  _writeMotes(config) {
    const grain = config.grain;
    const count = Math.min(MOTES, Math.max(0, Math.round(grain.count)));
    const data = this._moteData;

    for (let i = 0; i < count; i++) {
      const o = i * MOTE_STRIDE;
      data[o] = Math.random() * TAU; // where round the column it starts
      data[o + 1] = grain.radius * (0.35 + Math.random() * 0.85); // and how far out
      data[o + 2] = grain.spread * (0.2 + Math.random()); // how much further it gets
      data[o + 3] = grain.rise * (0.5 + Math.random()); // how high it climbs
      data[o + 4] = grain.swirl * (0.55 + Math.random() * 0.9) * (Math.random() < 0.25 ? -1 : 1);
      data[o + 5] = grain.size * (0.45 + Math.random() * 1.1);
      data[o + 6] = 1 / Math.max(0.05, grain.life * (0.6 + Math.random() * 0.8));
      data[o + 7] = Math.random(); // and where in its own loop it starts
    }

    this._moteCount = count;
    this.motes.geometry.instanceCount = count;
    this._moteBuffer.needsUpdate = true;
  }

  _syncMotes(config, reach, fade) {
    const grain = config.grain;
    const u = this.moteMaterial.uniforms;

    this.motes.visible =
      grain.enabled && this._moteCount > 0 && reach > 0.001 && fade > 0.001;
    if (!this.motes.visible) return;

    u.uOrigin.value.copy(this._ground);
    copyColor(u.uCoreColor.value, grain.coreColor);
    copyColor(u.uMoteColor.value, grain.color);
    u.uIntensity.value = grain.intensity;
    u.uSpike.value = Math.max(1, grain.spike);
    u.uAge.value = this._grain;
    // In metres, so the shader's test is against the shard's own climb rather
    // than against a normalised height it has no way to resolve.
    u.uCeiling.value = Math.max(0, config.beam.height) * reach;
    u.uFade.value = fade;
  }

  /* ------------------------------------------------------------------ */

  /**
   * The light, hung partway up the column.
   *
   * Not at its foot: a column of light six metres tall lit from the ground puts
   * every shadow on the stage in the wrong place, and the thing a viewer thinks
   * is glowing is the middle of it. It carries the strike's own flash on top of
   * whatever the beam is worth at rest, and the flash is squared on the way
   * down — the shape light actually leaves a room with.
   */
  _syncLight(config, reach, charge) {
    const light = config.light;

    _at.copy(this._ground);
    _at.y += Math.max(0, config.beam.height) * Math.min(1, reach) * Math.max(0, light.height);

    const glow = light.hold * Math.min(1, reach) + light.gather * charge;
    const intensity = (glow + this._flash * this._flash) * light.intensity;

    this.light.position.copy(_at);
    copyColor(this.light.color, light.color);
    this.light.distance = light.range;
    this.light.intensity = intensity;
    this.light.visible = intensity > 0.001;
  }

  dispose() {
    this.seal.dispose();
    this.impact.dispose();
    for (const mesh of [this.column, this.spirals, this.motes]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.group.parent?.remove(this.group);
  }
}

/* -------------------------------------------------------------------- */
/* layer 2 — the beam                                                    */
/* -------------------------------------------------------------------- */

/**
 * The column's wall, flared at the foot.
 *
 * Two things leave here for the fragment stage and neither can be recovered
 * there: the *facing* term — how square this piece of wall is to the lens,
 * which is what draws the column rather than a pipe — and the ring coordinate,
 * a point on the unit circle rather than an angle, so the noise field wrapped
 * round the tube has no seam at the join.
 *
 * The normal is rebuilt from the local position rather than taken from the
 * attribute, because the mesh is scaled hard non-uniformly (a tenth of a metre
 * across, six metres tall) and the attribute would arrive squashed flat.
 */
const COLUMN_VERTEX = /* glsl */ `
uniform float uFlare;

varying vec2 vUv;
varying vec2 vRing;
varying float vFacing;

void main() {
  vUv = uv;

  vec3 local = position;
  vRing = normalize(vec2(local.x, local.z) + 1e-6);
  // A skirt at the foot and nothing at the crown: the beam is a plume standing
  // in a rune, and a perfectly parallel tube reads as a prop.
  local.xz *= 1.0 + uFlare * pow(1.0 - uv.y, 3.0);

  vec4 world = modelMatrix * vec4(local, 1.0);
  // The wall's outward normal, in world space. Only x and z: the ends are open
  // and every face here is vertical.
  vec3 n = normalize(mat3(modelMatrix) * vec3(vRing.x, 0.0, vRing.y));
  vec3 view = normalize(cameraPosition - world.xyz);
  vFacing = abs(dot(n, view));

  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * The light in the tube.
 *
 * The whole look is one inversion: a shell wants `pow(1 - facing, k)` and draws
 * its silhouette, and this wants `pow(facing, k)` and draws its *axis*. Where
 * the wall is square to the lens the eye is looking straight down the length of
 * the volume and the light piles up; where it turns away there is nothing but
 * the thinnest sliver of it. Rendered two-sided, so the far wall adds to the
 * near one and the middle is genuinely twice as bright as the edges.
 *
 * Over that, three things happen along `uv.y`:
 *
 *  - **the head** — a hot band at `uReach` with nothing above it, so the column
 *    is *arriving* rather than fading up;
 *  - **the foot** — a hard bloom in the first fifth, which is the rune's own
 *    light spilling into the bottom of the beam;
 *  - **the crown** — the top losing its edges to the noise and dissipating,
 *    because a beam that stops dead at a height has a ceiling on it.
 */
const COLUMN_FRAGMENT = /* glsl */ `
${noiseGLSL}

uniform vec3 uCoreColor;
uniform vec3 uInnerColor;
uniform vec3 uEdgeColor;
uniform float uIntensity;
uniform float uCorePower;
uniform float uGlowPower;
uniform float uReach;
uniform float uFade;
uniform float uCharge;
uniform float uGrain;
uniform float uRingScale;
uniform float uFlow;
uniform float uErode;
uniform float uHeadWidth;
uniform float uFootGlow;
uniform float uCrown;
uniform float uSeed;
uniform float uTime;
uniform float uExposure;

varying vec2 vUv;
varying vec2 vRing;
varying float vFacing;

void main() {
  // Nothing above the head exists at all. Discarded rather than faded, so the
  // leading edge is an edge.
  if (vUv.y > uReach) discard;

  float core = pow(vFacing, uCorePower);
  float glow = pow(vFacing, uGlowPower);

  /* ---- the surface ---- */
  // Sampled on the ring rather than on vUv.x, so there is no seam where the
  // cylinder's texture coordinate wraps. It falls *down* the column at uFlow,
  // against the direction the thing is travelling — which is what sells it as
  // matter being drawn up out of the ground rather than a gradient.
  vec3 field = vec3(vRing * uRingScale, vUv.y * uGrain - uTime * uFlow + uSeed);
  float n = fbm3(field);
  float streak = mix(1.0 - uErode, 1.0 + uErode, n);

  /* ---- along its length ---- */
  float head = exp(-pow((vUv.y - uReach) / max(uHeadWidth, 1e-3), 2.0));
  float foot = exp(-vUv.y / uFootGlow);
  // The top thins into nothing, and the noise decides *where* — so the crown is
  // ragged and different every frame instead of a soft horizontal line.
  float crown = 1.0 - smoothstep(uCrown, 1.0, vUv.y + (n - 0.5) * 0.28);

  float body = (core * streak + glow * 0.28) * crown;
  float hot = core * (foot * 1.6 + head * 1.9);

  // Three colours across the width, and the order matters: the violet is laid
  // down over the *whole* wall, the body's colour over the part of it facing
  // the lens, and the white only where the light has actually piled up. A beam
  // is read from its edges inward — take the first term out and what is left is
  // a white stripe with nothing around it.
  vec3 rgb =
    uEdgeColor * (glow * 0.85 * crown) +
    uInnerColor * body +
    uCoreColor * hot;
  float a = (body * 0.9 + hot) * (0.75 + 0.35 * uCharge);

  float gain = uIntensity * uFade / max(uExposure, 0.01);
  a *= gain;
  if (a < 0.004) discard;

  gl_FragColor = vec4(rgb * gain, a);
}
`;

/* -------------------------------------------------------------------- */
/* layer 3 — the spirals                                                 */
/* -------------------------------------------------------------------- */

/**
 * One cord, wound.
 *
 * The helix is closed-form: `t` along the strip becomes an angle and a height,
 * and the point is `(cos, y, sin)`. Its tangent is the same expression
 * differentiated, and that tangent is what the ribbon is widened *across* —
 * in **view space**, not in the world.
 *
 * That last part is the whole reason this layer works. A ribbon widened along a
 * world-space binormal turns edge-on to the lens twice per revolution and
 * disappears, which on a cord wound two and a half times round a column means
 * five blinks up its length. Widened across the screen it cannot: the cord is
 * the same thickness from every angle, and what the camera moving changes is
 * the shape it traces rather than whether it is there.
 */
const SPIRAL_VERTEX = /* glsl */ `
uniform float uRadius;
uniform float uHeight;
uniform float uTurns;
uniform float uWidth;
uniform float uSpin;
uniform float uFlare;
uniform float uReach;
uniform float uTaper;
uniform float uTime;

attribute float aPhase;
attribute float aHand;
attribute float aTint;

varying float vT;
varying float vSide;
varying float vTint;

const float TAU = 6.28318530718;

void main() {
  float t = position.x;
  float side = position.y - 0.5;

  // Above the head there is no cord. Folded to a degenerate point outside the
  // clip volume, which the rasteriser drops for free — the alternative is a
  // discard in the fragment stage for geometry that is never seen.
  if (t > uReach) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vT = 1.0;
    vSide = 1.0;
    vTint = aTint;
    return;
  }

  float ang = aHand * (t * uTurns * TAU - uTime * uSpin) + aPhase;
  // Opening out as it climbs, so the cords leave the column rather than
  // gripping it all the way up.
  float radius = uRadius * (1.0 + uFlare * t);
  float y = t * uHeight;

  vec3 p = vec3(cos(ang) * radius, y, sin(ang) * radius);
  // d/dt of the above, with the radius held — the term it drops is small
  // against the other two and only tilts the cord's cross-section slightly.
  float dAng = aHand * uTurns * TAU;
  vec3 tangent = vec3(-sin(ang) * radius * dAng, uHeight, cos(ang) * radius * dAng);

  vec4 view = modelViewMatrix * vec4(p, 1.0);
  vec3 tView = (modelViewMatrix * vec4(tangent, 0.0)).xyz;

  // Its heading on screen, and the perpendicular to widen along. A cord coming
  // straight at the lens has no heading there and stays a dot, which is what it
  // actually looks like.
  float onScreen = length(tView.xy);
  vec2 along = onScreen > 1e-4 ? tView.xy / onScreen : vec2(0.0, 1.0);
  vec2 across = vec2(along.y, -along.x);

  // Thinning as it climbs: a cord of constant width running up a column that is
  // itself dissipating reads as a wire someone left there.
  float width = uWidth * mix(1.0, uTaper, t);
  view.xy += across * side * width * 2.0;

  gl_Position = projectionMatrix * view;
  vT = t;
  vSide = side;
  vTint = aTint;
}
`;

/**
 * A cord with a white centre and a coloured bleed.
 *
 * The travelling brightness along it is a plain sine, and it is doing more work
 * than it looks: the helix itself is rigid, so without something running *up*
 * it the layer is a static screw thread. With it, every cord reads as carrying
 * something.
 */
const SPIRAL_FRAGMENT = /* glsl */ `
uniform vec3 uCoreColor;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uIntensity;
uniform float uSharp;
uniform float uPulse;
uniform float uFade;
uniform float uTime;
uniform float uExposure;

varying float vT;
varying float vSide;
varying float vTint;

void main() {
  float across = 1.0 - clamp(abs(vSide) * 2.0, 0.0, 1.0);
  float body = pow(across, uSharp);
  float core = pow(across, uSharp * 4.0);

  // Both ends taper to nothing: a cord that starts and stops with a flat cap is
  // a cylinder, and the caps are the two frames a viewer looks at.
  float ends = smoothstep(0.0, 0.06, vT) * (1.0 - smoothstep(0.72, 1.0, vT));
  // And something running up it.
  float pulse = 0.72 + 0.5 * sin(vT * uPulse - uTime * 9.0 + vTint * 2.1);

  vec3 tint = mix(uColorA, uColorB, vTint);
  vec3 rgb = tint * body + uCoreColor * core;
  float a = (body * 0.85 + core) * ends * pulse;

  float gain = uIntensity * uFade / max(uExposure, 0.01);
  a *= gain;
  if (a < 0.004) discard;

  gl_FragColor = vec4(rgb * gain, a);
}
`;

/* -------------------------------------------------------------------- */
/* layer 5 — the grain                                                   */
/* -------------------------------------------------------------------- */

/**
 * One shard, on its own loop.
 *
 * `fract` rather than a lifetime is the trick that makes this layer free: each
 * shard runs its own orbit from 0 to 1 and starts again, at its own rate and
 * from its own offset, so a pool written once at the strike keeps producing
 * grain for as long as the beam stands. Nothing is re-emitted, nothing is
 * re-sorted and the CPU writes one float a frame for the whole field.
 *
 * The path is a rising spiral: out from the column as it climbs, turning as it
 * goes. It is the cords' motion at a hundredth of their scale, which is why the
 * two layers read as one thing happening rather than two effects on top of each
 * other.
 */
const MOTE_VERTEX = /* glsl */ `
uniform vec3 uOrigin;
uniform float uAge;
uniform float uCeiling;

attribute vec3 aPolar;
attribute vec3 aDrift;
attribute float aRate;
attribute float aPhase;

varying vec2 vShape;
varying float vLife;
varying float vSeed;

void main() {
  float t = fract(uAge * aRate + aPhase);
  float climb = pow(t, 0.78); // fast off the ground, easing as it goes
  float size = aDrift.z;

  // A slot never written, or a shard that has climbed past the head of a column
  // that has not got there yet: grain hanging in the air above a beam is the
  // tell that the two are separate systems.
  if (size <= 0.0 || aDrift.x * climb > uCeiling) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vShape = vec2(0.0);
    vLife = 1.0;
    vSeed = 0.0;
    return;
  }

  float ang = aPolar.x + aDrift.y * t;
  float radius = aPolar.y + aPolar.z * climb;

  vec3 world = uOrigin + vec3(cos(ang) * radius, aDrift.x * climb, sin(ang) * radius);
  vec4 view = viewMatrix * vec4(world, 1.0);

  // Turned by its own phase, so a field of four-pointed stars is not a field of
  // the same four-pointed star.
  float spin = aPhase * 6.28318530718 + t * 1.4;
  float c = cos(spin);
  float s = sin(spin);
  vec2 corner = vec2(position.x * c - position.y * s, position.x * s + position.y * c);

  // Born small, at its size for most of the climb, gone to nothing at the top.
  float scale = size * smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.55, 1.0, t));
  view.xy += corner * scale;

  gl_Position = projectionMatrix * view;
  vShape = position.xy;
  vLife = t;
  vSeed = aPhase;
}
`;

/**
 * A four-pointed star: two needles crossed, and a core where they meet.
 *
 * Drawn rather than sampled, for the same reason the seal is: a sprite is stuck
 * at the resolution it was authored at, and these are looked at from two metres
 * as often as from twenty. Two products of falloffs is the cheapest star there
 * is — no length, no atan, no texture fetch.
 */
const MOTE_FRAGMENT = /* glsl */ `
uniform vec3 uCoreColor;
uniform vec3 uMoteColor;
uniform float uIntensity;
uniform float uSpike;
uniform float uFade;
uniform float uExposure;

varying vec2 vShape;
varying float vLife;
varying float vSeed;

void main() {
  vec2 q = abs(vShape);
  float across = max(1.0 - q.x, 0.0);
  float along = max(1.0 - q.y, 0.0);

  // One needle each way, and their product for the hot middle.
  float star =
    max(1.0 - q.x * uSpike, 0.0) * along * along +
    max(1.0 - q.y * uSpike, 0.0) * across * across;
  float core = pow(across * along, 4.0);

  float twinkle = 0.55 + 0.45 * sin(vSeed * 41.0 + vLife * 27.0);
  float fade = smoothstep(0.0, 0.1, vLife) * (1.0 - smoothstep(0.5, 1.0, vLife));

  vec3 rgb = uMoteColor * star + uCoreColor * core;
  float a = (star * 0.8 + core) * twinkle * fade;

  float gain = uIntensity * uFade / max(uExposure, 0.01);
  a *= gain;
  if (a < 0.004) discard;

  gl_FragColor = vec4(rgb * gain, a);
}
`;
