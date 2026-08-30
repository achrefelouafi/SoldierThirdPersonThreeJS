import {
  AdditiveBlending,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  ShaderMaterial,
  Vector3
} from 'three';

import { frame } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { copyColor, makeColor } from '../utils/color.js';

/** Segments along the arc, and across it. The arc needs the resolution; the
 *  sweep back into the tail needs rather less. */
const SEGMENTS_U = 64;
const SEGMENTS_V = 18;

/** Waves in the air at once. Two per combo, and room for three combos over. */
const CAPACITY = 12;

const _up = new Vector3(0, 1, 0);
const _forward = new Vector3();
const _right = new Vector3();
const _upAxis = new Vector3();
const _rolledRight = new Vector3();
const _rolledUp = new Vector3();
const _matrix = new Matrix4();
const _aim = new Vector3();

/**
 * The cut, thrown off the blade and sent at somebody.
 *
 * ## What it is
 *
 * A crescent of light that leaves the sword on the frame the edge crosses the
 * front, crosses the ground between here and whoever the swing was locked on,
 * and dies on their chest. Two of them open the combo (`animation/Attack.js`
 * with `configKey: 'swordCombo'`); the third beat of that combo is the body
 * arriving in person, and it is not one of these.
 *
 * ## The shape, and why it is one surface
 *
 * The obvious build is a crescent billboard plus a trail behind it, which is
 * two systems that have to be kept agreeing about where the crescent is. This
 * is one: a single swept sheet whose `v` runs from the **tail** at 0 to the
 * **leading edge** at 1, so the arc and the veil dragging off it are the same
 * quad grid and cannot come apart.
 *
 * Across that sheet three things happen at once, all of them functions of `u`
 * (position along the arc, -1 at one tip to +1 at the other):
 *
 *  - the sheet's radius **converges** toward the tail, which is what makes the
 *    silhouette a crescent rather than a band — the inner edge bows further in
 *    than the outer one;
 *  - it is **swept back** down the direction of travel, hardest in the middle,
 *    because the middle of a sword's arc is the part that was moving fastest;
 *  - both are scaled by a **taper** that reaches zero at `|u| = 1`, so the tips
 *    close to a point. A crescent with blunt ends reads as a croissant; the
 *    whole thing has to end in something that could cut.
 *
 * The sheet is also **cupped** out of its own plane, the tips lifting clear of
 * the middle, so it is not a flat card. That is what keeps it alive from
 * straight above: a flat plane edge-on to the lens is a one-pixel line, and the
 * third-person camera spends most of its time looking down on this one.
 *
 * ## Where the plane sits
 *
 * Local `+Z` is the direction of travel and the crescent lies **along** it,
 * not across it: the apex of the arc leads, the tips trail, and the veil is
 * dragged off the back. That is the whole point of the orientation — the hard
 * white edge is the side the target sees coming, and everything blue is behind
 * it, so a cut in flight reads as aimed at somebody rather than as an arc
 * standing up in the air.
 *
 * Which way the sheet is turned about that axis is `roll`. **Zero lays it
 * flat** — a horizontal sweep going across whoever it was thrown at — and a
 * right angle stands it on edge into an overhead chop. It is read straight off
 * the clip that threw it.
 *
 * ## What it does not know
 *
 * Anything about damage. A wave that reaches its target calls `onArrive` and
 * that is the end of its involvement — who gets hurt, how hard, and what is
 * drawn on top of it are `vfx/SwordCombo.js`'s to decide. This class draws a
 * crescent and moves it.
 */
export class SlashWave {
  /**
   * @param {object} [options]
   * @param {((wave: object) => void)|null} [options.onArrive] the frame a wave
   *   reaches what it was thrown at — or the end of its reach, having missed.
   */
  constructor({ onArrive = null } = {}) {
    this.onArrive = onArrive;

    // A unit grid in `position.xy`, both in [0, 1]. Every metre of the crescent
    // is put there by the vertex shader; the geometry is only a parameter
    // domain, which is why the same buffer serves a two-metre arc and a
    // five-metre one without being rebuilt.
    const geometry = new PlaneGeometry(1, 1, SEGMENTS_U, SEGMENTS_V).translate(0.5, 0.5, 0);
    geometry.setAttribute('aAge', new InstancedBufferAttribute(new Float32Array(CAPACITY), 1));
    geometry.setAttribute('aSeed', new InstancedBufferAttribute(new Float32Array(CAPACITY), 1));

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      // Two-sided on purpose: the wave is a sheet with no thickness and the
      // player will fly past the back of one. Backface culling would blink it.
      side: DoubleSide,
      fog: false,
      toneMapped: false,
      uniforms: {
        uCoreColor: { value: makeColor('#ffffff') },
        uEdgeColor: { value: makeColor('#a8e9ff') },
        uBodyColor: { value: makeColor('#2f7dff') },
        uTailColor: { value: makeColor('#7c4dff') },
        uIntensity: { value: 2.0 },
        uSpread: { value: 2.25 },
        uConverge: { value: 0.58 },
        uBow: { value: 0.24 },
        uTail: { value: 0.62 },
        uTipTaper: { value: 0.55 },
        uRazor: { value: 0.94 },
        uErode: { value: 1.15 },
        uGrow: { value: 0.35 },
        // Divided into every emissive below, for the reason set out on the
        // blade impact: ACES desaturates as it clips, so a colour dialled in at
        // one exposure arrives at another hue at another.
        uExposure: frame.uExposure
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT
    });

    this.mesh = new InstancedMesh(geometry, this.material, CAPACITY);
    this.mesh.count = 0;
    // Born wherever the blade was, which is nowhere near the origin the
    // bounding sphere would be built around.
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.VFX);
    // Over the dust, the mist and the rings on the floor: for the half second
    // one of these is on screen it is the brightest thing in the frame.
    this.mesh.renderOrder = 11;
    this.mesh.name = 'SlashWaves';
    this.mesh.raycast = () => {};

    this._ages = geometry.getAttribute('aAge');
    this._seeds = geometry.getAttribute('aSeed');

    /** @type {Wave[]} everything in flight, oldest first. */
    this.waves = [];
  }

  /** Whether anything at all is crossing the ground right now. */
  get active() {
    return this.waves.length > 0;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Throw one, from here, at that.
   *
   * The aim is a *point*, resolved by the caller and then frozen — but the
   * target is carried too, and a live one is re-read each frame (`_advance`)
   * so a body that walks two steps while the wave is in the air is still cut.
   * A wave with no target flies its aim and expires there, which is what
   * happens when the thing it was thrown at dies to something else first.
   *
   * @param {object} options
   * @param {Vector3} options.from where the edge was on the frame it left
   * @param {Vector3} options.to the point it is aimed at
   * @param {object|null} [options.target] the body, if it is still standing
   * @param {number} [options.roll] radians about the travel axis — 0 lays the
   *   crescent flat (a sweep across), a right angle stands it up (a chop)
   * @param {number} [options.size] the arc's radius, metres
   * @param {number} [options.speed] metres a second. **Zero parks it**: the
   *   crescent hangs where it was thrown, on the heading `from → to` gives it,
   *   and never announces an arrival — which is what the combo's finisher hangs
   *   on its own contact point, the arc a blade left in the air behind it
   * @param {number} [options.life] seconds it may stay in the air regardless
   * @param {number} [options.spin] radians a second the crescent rolls in flight
   * @param {number} [options.beat] which hit of the combo threw it, carried
   *   through untouched so `onArrive` can say which one landed
   */
  throw({
    from,
    to,
    target = null,
    roll = 0,
    size = 1.5,
    speed = 34,
    life = 1.1,
    spin = 0,
    beat = 0
  } = {}) {
    // The oldest goes rather than the throw being dropped: a wave that is
    // nearly on top of its target has already been read, and one that is
    // refused is a beat of the combo that visibly did not happen. It is dropped
    // outright rather than merely marked spent — every wave in the list is
    // written to an instance slot, and a list longer than the pool would write
    // past the end of the matrix buffer.
    if (this.waves.length >= CAPACITY) this.waves.shift();

    const wave = {
      position: new Vector3().copy(from),
      aim: new Vector3().copy(to),
      direction: new Vector3().subVectors(to, from),
      target,
      roll,
      size,
      speed: Math.max(0, speed),
      life: Math.max(0.05, life),
      age: 0,
      seed: Math.random() * 64,
      spin,
      beat,
      arrived: false
    };

    const length = wave.direction.length();
    if (length > 1e-4) wave.direction.multiplyScalar(1 / length);
    else wave.direction.set(0, 0, 1);

    // A parked cut is born having already got where it was going, and born
    // having already said so — so `_advance` leaves it alone and `onArrive`
    // is never called for something that did not travel to anybody.
    if (wave.speed <= 0) {
      wave.arrived = true;
      wave.reported = true;
    }

    this.waves.push(wave);
    return wave;
  }

  /**
   * Carry every wave along, and hand back the ones that got there.
   *
   * Arrival is measured as **distance left to run** rather than as proximity,
   * because at thirty-odd metres a second a wave covers half a metre between
   * two frames: a `distance < radius` test either misses the frame entirely or
   * has to be given a radius so generous that the wave dies short. Counting
   * down the gap cannot skip past zero.
   *
   * @param {number} dt
   * @param {object} config `settings.swordCombo.wave`
   */
  update(dt, config) {
    this._sync(config);

    const waves = this.waves;
    let count = 0;

    for (let i = waves.length - 1; i >= 0; i--) {
      const wave = waves[i];
      this._advance(wave, dt, config);

      if (wave.age >= wave.life) {
        waves.splice(i, 1);
        continue;
      }
      count++;
    }

    // Written after the sweep above, so a wave retired this frame does not get
    // a slot — and in the order the array happens to be in, which is fine
    // because nothing here reads a slot back.
    let slot = 0;
    for (const wave of waves) {
      this._write(slot, wave);
      slot++;
    }

    this.mesh.count = count;
    if (count > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this._ages.needsUpdate = true;
      this._seeds.needsUpdate = true;
    }
  }

  /** One wave's flight for this frame: re-aim, travel, arrive. */
  _advance(wave, dt, config) {
    wave.age += dt;

    if (!wave.arrived) {
      // Re-read a living target, so a body that moved while the wave was in
      // the air is still where the wave is going. Only the *aim* is re-taken —
      // the heading is then rebuilt from where the wave actually is, so the
      // correction is a gentle curve rather than the wave snapping round.
      const target = wave.target;
      if (target?.alive) {
        _aim.copy(target.position);
        _aim.y += Math.max(0, config.aimHeight);
        // How hard it is allowed to steer, per second. Low: this is a thrown
        // cut, not a missile, and a wave that tracks perfectly reads as one.
        const homing = Math.min(1, Math.max(0, config.homing) * dt);
        wave.aim.lerp(_aim, homing);
      }

      _forward.subVectors(wave.aim, wave.position);
      const gap = _forward.length();
      if (gap > 1e-4) {
        _forward.multiplyScalar(1 / gap);
        // Turn toward the re-taken aim rather than snapping onto it, for the
        // same reason: the curve is what says the cut was *thrown*.
        wave.direction.lerp(_forward, Math.min(1, Math.max(0, config.homing) * dt));
        wave.direction.normalize();
      }

      const step = wave.speed * dt;
      if (step >= gap) {
        // It got there. The wave is parked exactly on the aim and then lives
        // out `hold` seconds as the cut hanging in the air — the flash and the
        // blood are somebody else's, and they want something still under them.
        wave.position.copy(wave.aim);
        wave.arrived = true;
        // Whatever is left of the flight is spent hanging; a wave that arrived
        // early must not then linger for a second.
        wave.life = wave.age + Math.max(0.02, config.hold);
        this._announce(wave);
      } else {
        wave.position.addScaledVector(wave.direction, step);
      }
    }

    if (wave.spin !== 0) wave.roll += wave.spin * dt;
  }

  /** Say it landed, and only ever once. */
  _announce(wave) {
    if (wave.reported) return;
    wave.reported = true;
    this.onArrive?.(wave);
  }

  /** One wave into its instance slot: where it is, how it is turned, how big. */
  _write(slot, wave) {
    const u = Math.min(1, wave.age / wave.life);

    // The basis: `+Z` down the line of travel, and the other two rolled about
    // it by however much the swing that threw this was tilted.
    _forward.copy(wave.direction);
    // Degenerate only if a cut is thrown straight up or straight down, which
    // nothing here does — but a zero-length cross would put NaNs in the matrix
    // and take the whole mesh off screen, so it is guarded rather than assumed.
    _right.crossVectors(_up, _forward);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    _upAxis.crossVectors(_forward, _right).normalize();

    const cos = Math.cos(wave.roll);
    const sin = Math.sin(wave.roll);
    _rolledRight.copy(_right).multiplyScalar(cos).addScaledVector(_upAxis, sin);
    _rolledUp.copy(_right).multiplyScalar(-sin).addScaledVector(_upAxis, cos);

    // A uniform scale folded straight into the basis. The crescent opens a
    // little as it travels — a cut spreads, and one that arrives exactly the
    // size it left at reads as a decal being slid across the ground.
    const scale = wave.size * (1 + u * this.material.uniforms.uGrow.value);
    _rolledRight.multiplyScalar(scale);
    _rolledUp.multiplyScalar(scale);
    _forward.multiplyScalar(scale);

    _matrix.makeBasis(_rolledRight, _rolledUp, _forward);
    _matrix.setPosition(wave.position);
    this.mesh.setMatrixAt(slot, _matrix);

    // The one number the shader ages everything off. It is deliberately *not*
    // a clock: `life` is rewritten to `age + hold` the instant a wave lands
    // (`_advance`), which walks `u` up into the fragment shader's fade band on
    // the frame of contact and nowhere before it. A wave therefore arrives at
    // full brightness however short its flight turned out to be, which a plain
    // age-over-lifetime fade could not promise.
    this._ages.setX(slot, u);
    this._seeds.setX(slot, wave.seed);
  }

  /** Push the look. Read per frame, so the editor's edits land immediately. */
  _sync(config) {
    const u = this.material.uniforms;
    copyColor(u.uCoreColor.value, config.coreColor);
    copyColor(u.uEdgeColor.value, config.edgeColor);
    copyColor(u.uBodyColor.value, config.bodyColor);
    copyColor(u.uTailColor.value, config.tailColor);
    u.uIntensity.value = config.intensity;
    u.uSpread.value = config.spread;
    u.uConverge.value = config.converge;
    u.uBow.value = config.bow;
    u.uTail.value = config.tail;
    u.uTipTaper.value = config.tipTaper;
    u.uRazor.value = config.razor;
    u.uErode.value = config.erode;
    u.uGrow.value = config.grow;
  }

  /** Everything in the air, gone — for leaving the stage and for a reset. */
  clear() {
    this.waves.length = 0;
    this.mesh.count = 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

/* -------------------------------------------------------------------- */

/**
 * The crescent, built from a unit grid.
 *
 * `position.x` is the parameter along the arc and `position.y` the one across
 * it; neither is a length. Everything with a metre in it is applied here, which
 * is what lets one buffer be every wave in the game.
 *
 * The three deformations are stated in the order they are easiest to read:
 * the arc (a segment of a circle), the convergence toward the tail (which is
 * what makes it a crescent), and the sweep back along the line of travel
 * (which is what makes it look thrown). All three are scaled by `taper`, so
 * all three arrive at nothing together at the tips.
 */
const VERTEX = /* glsl */ `
uniform float uSpread;
uniform float uConverge;
uniform float uBow;
uniform float uTail;
uniform float uTipTaper;

attribute float aAge;
attribute float aSeed;

varying float vU;
varying float vV;
varying float vAge;
varying float vSeed;

void main() {
  float u = position.x * 2.0 - 1.0;  // -1 .. 1, tip to tip
  float v = position.y;              // 0 at the tail, 1 at the leading edge

  // Zero at both tips and one in the middle. The exponent is how *pointed* the
  // crescent is: low is a wide blade, high is a needle.
  float taper = pow(max(0.0, 1.0 - u * u), uTipTaper);

  float theta = u * uSpread * 0.5;
  float back = 1.0 - v;

  // The leading edge rides at radius 1; everything behind it is pulled in
  // toward the centre of the arc, hardest in the middle.
  float radius = 1.0 - back * uConverge * taper;

  vec3 local;
  // Across the line of flight: the arc's span, tip to tip.
  local.x = radius * sin(theta);
  // Along it, toward whatever the cut was thrown at. The arc curves in the
  // plane of its own flight, so the apex leads and the tips trail — which is
  // what puts the razor edge on the target's side and the veil behind it.
  // Recentred on the chord between the tips, so the crescent sits *on* the
  // point it was thrown from rather than a radius short of it, and dragged
  // further back the closer to the tail — squared, so the veil trails off
  // rather than ending on a crease.
  local.z = radius * cos(theta) - cos(uSpread * 0.5) - back * back * uTail * taper;
  // Lifted out of the plane the arc lies in, the tips clear of the middle, so
  // the sheet is a shallow cup rather than a flat card with nothing to catch
  // the camera looking down on it.
  local.y = uBow * (1.0 - cos(theta));

  vU = u;
  vV = v;
  vAge = aAge;
  vSeed = aSeed;

  gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(local, 1.0);
}
`;

/**
 * What the sheet is made of.
 *
 * Four bands, all of them functions of `v`, running from the leading edge
 * backwards: a **razor** (a hard white line right on the edge, and the whole
 * reason the thing reads as sharp rather than as a smoke ring), an **edge**
 * glow just behind it, the **body**, and the **tail**, which is eroded by
 * noise so the veil comes apart into filaments instead of ending on a straight
 * cut.
 *
 * The erosion threshold climbs with age *and* with distance back from the
 * edge, so the wave burns away from the tail forward — the leading edge is the
 * last thing left, which is the part that is still travelling.
 */
const FRAGMENT = /* glsl */ `
${noiseGLSL}

uniform vec3 uCoreColor;
uniform vec3 uEdgeColor;
uniform vec3 uBodyColor;
uniform vec3 uTailColor;
uniform float uIntensity;
uniform float uRazor;
uniform float uErode;
uniform float uExposure;

varying float vU;
varying float vV;
varying float vAge;
varying float vSeed;

void main() {
  float t = clamp(vAge, 0.0, 1.0);
  float back = 1.0 - vV;

  // The tips fade out rather than stopping, so the geometry's sharp point is
  // not also a hard alpha edge.
  float tips = pow(max(0.0, 1.0 - vU * vU), 0.42);

  // Filaments running along the arc, drifting backwards through it. Two
  // octaves is plenty — this is a fifth of a second on screen.
  vec3 p = vec3(vU * 3.1 + vSeed, back * 2.6 - t * 1.8, vSeed * 0.7);
  float n = fbm3(p) * 0.5 + 0.5;

  // What the noise has to beat to survive. Nothing is eroded at the leading
  // edge however old the wave is; the tail is eaten first and fastest.
  float bite = uErode * back * (0.25 + t * 1.15);
  float veil = smoothstep(bite, bite + 0.42, n);

  // The four bands, and their weights are the whole look. They fall away
  // steeply on purpose: the crescent is a *cut*, so nearly all of the light is
  // in the hard line on its leading edge and the rest of the sheet is the glow
  // behind it. Weighting the body anywhere near the edge fills the silhouette
  // in, and a filled crescent is a smoke ring — it reads as something billowing
  // rather than as something with an edge on it. Between them these peak a
  // little over 2 at the edge and under a half across the body, which is what
  // leaves the bloom something to find without flattening the shape into white.
  float razor = smoothstep(uRazor, 1.0, vV);
  float edge = pow(vV, 5.0);
  float body = pow(vV, 1.7) * veil;
  float tail = back * back * veil;

  vec3 rgb =
    uCoreColor * razor +
    uEdgeColor * edge * 0.6 +
    uBodyColor * body * 0.42 +
    uTailColor * tail * 0.22;

  float a = (razor + edge * 0.6 + body * 0.42 + tail * 0.22) * tips;

  // In fast, out slow: a cut is at full brightness by the second frame and
  // spends the rest of its life going out.
  a *= smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.55, 1.0, t));

  float gain = uIntensity / max(uExposure, 0.01);
  a *= gain;
  if (a < 0.004) discard;

  // Premultiplied against an additive blend: the alpha is the light.
  gl_FragColor = vec4(rgb * gain, a);
}
`;
