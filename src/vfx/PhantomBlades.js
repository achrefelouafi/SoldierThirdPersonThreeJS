import { Box3, Group, Matrix4, Quaternion, ShaderMaterial, Vector3 } from 'three';

import { frame } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { copyColor, makeColor } from '../utils/color.js';
import { Easing } from '../utils/math.js';

/**
 * Blades a rite can have on screen.
 *
 * The pool is built to this rather than to `count`, so the editor's count
 * slider never triggers a rebuild — it only decides how many are summoned.
 */
const MAX_BLADES = 6;

/** The axis a measured blade is turned onto: local +Z is the steel. */
const BLADE_AXIS = /* @__PURE__ */ new Vector3(0, 0, 1);

const _box = /* @__PURE__ */ new Box3();
const _size = /* @__PURE__ */ new Vector3();
const _centre = /* @__PURE__ */ new Vector3();
const _axis = /* @__PURE__ */ new Vector3();
const _quaternion = /* @__PURE__ */ new Quaternion();
const _forward = /* @__PURE__ */ new Vector3();
const _right = /* @__PURE__ */ new Vector3();
const _up = /* @__PURE__ */ new Vector3();
const _scratch = /* @__PURE__ */ new Vector3();
const _basis = /* @__PURE__ */ new Matrix4();

/**
 * The katanas themselves — the weapon off the character's own hip, summoned out
 * of the dark and driven through somebody.
 *
 * ## Why it is the real mesh
 *
 * Every other layer of this ability is drawn from nothing. This one is not, and
 * that is the point: the blade the player has been swinging all session is the
 * blade that comes out of the aura, at the same proportions, with the same
 * guard and the same curve. A stand-in — a stretched quad, a generated shape —
 * is legible as a stand-in the instant it is next to the real thing, and the
 * character is holding the real thing throughout.
 *
 * The geometry is **borrowed**: `EquipmentLibrary` already has the katana
 * resident because the body is wearing one, and a clone shares its buffers. So
 * this class creates no geometry and, crucially, disposes none — those buffers
 * belong to the library, and releasing them here would take the sword out of
 * the character's hand. What it does own is the materials, one set per blade,
 * because the palette's steel is lit for a man standing in moonlight and these
 * are lit for something that came up out of the floor — and because each blade
 * is at a different point in its own burn.
 *
 * ## Measured, not assumed
 *
 * The catalog says the blade runs down +Z, and it does. This class does not
 * trust that: it measures the clone's bounding box, takes its **longest axis**
 * as the blade — the same trick `equipment/WeaponDissolve.js` uses, and for the
 * same reason — turns that axis onto +Z, and scales the piece to `length`
 * metres end to end.
 *
 * It then shifts the model back down its own axis so the **tip sits on the
 * holder's origin**. That one decision is what makes the rest of the class
 * simple: a blade's transform becomes "where the point is, and which way it is
 * going", which is the only two facts a thrust has. Nothing here ever reasons
 * about where a hilt ended up.
 *
 * ## The choreography, and what it does not decide
 *
 * Each blade runs a small machine — `gather`, `poised`, `thrust`, `buried`,
 * `wrench`, `fade` — and this class owns all of it. What it does not own is
 * *when*: `vfx/CrimsonRite.js` calls `stab` and `wrench` on the beat, exactly
 * as `core/App.js` calls the rite on the frame of a clip.
 *
 * One thing travels back the other way, and it is the important one.
 * `onPierce` fires on the frame the point actually reaches the body — not the
 * frame the stab was ordered. A thrust takes time to arrive, and dealing the
 * blow on arrival is the same decoupling `vfx/SlashWave.js` makes for a thrown
 * cut. It is the whole reason the stabs read as steel going in rather than as
 * damage with a decal attached.
 */
export class PhantomBlades {
  /**
   * @param {object} [options]
   * @param {(() => import('three').Object3D|null)|null} [options.source] where
   *   to borrow the katana from, asked once and then cached. A provider rather
   *   than a model, because the equipment does not exist until the character
   *   screen has been built and this is constructed long before that.
   * @param {((blade: object) => void)|null} [options.onPierce] the frame a
   *   point reaches the body it was driven at
   */
  constructor({ source = null, onPierce = null } = {}) {
    this.source = source;
    this.onPierce = onPierce;

    /** Everything it is, in world space. Add it to the scene. */
    this.group = new Group();
    this.group.name = 'PhantomBlades';

    /**
     * The blades, built on the first cast and kept.
     * @type {Array<object>}
     */
    this.blades = [];
    /** The measured, turned, scaled group every blade is cloned from. */
    this._template = null;
    /** True once the source has been asked and could not answer. */
    this._missing = false;
    /** Metres the template was built at, so moving `length` rebuilds it. */
    this._builtLength = 0;
  }

  /** Whether any blade is on screen. */
  get active() {
    for (const blade of this.blades) if (blade.state !== 'hidden') return true;
    return false;
  }

  /**
   * How many blades this rite actually got.
   *
   * Zero is a real answer and the caller has to handle it: the katana may not
   * have been resident when the rite was thrown. See `summon`.
   */
  get count() {
    let live = 0;
    for (const blade of this.blades) if (blade.state !== 'hidden') live++;
    return live;
  }

  /* ------------------------------------------------------------------ */
  /* the beats                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Call them up around a body.
   *
   * They are placed on a ring `standoff` metres out, at staggered bearings and
   * heights, each already pointed at the piece of the body it will take. The
   * ring is turned by a random amount per cast, so two rites do not put a blade
   * over the same shoulder twice.
   *
   * @param {Vector3} centre where the body is standing — the ring's middle
   * @param {number} height metres up the body the ring is centred on
   * @param {object} config `settings.crimsonRite.blades`
   * @returns {number} how many blades came. Zero if there is no katana to
   *   borrow, which is not an error: the other five layers are unaffected, and
   *   a cast that refused would be a far worse failure than one that is thinner
   */
  summon(centre, height, config) {
    if (!config.enabled) return 0;
    if (!this._ensure(config)) return 0;

    const wanted = Math.min(Math.max(1, Math.round(config.count)), this.blades.length);
    const turn = Math.random() * Math.PI * 2;

    for (let i = 0; i < this.blades.length; i++) {
      const blade = this.blades[i];
      if (i >= wanted) {
        this._park(blade);
        continue;
      }

      const angle = turn + (i / wanted) * Math.PI * 2;
      // Not all at one height: three points on a level ring is a diagram, and
      // the reference's blades come in high, low and across.
      const lift = ((i % 3) - 1) * config.spreadHeight;

      // Where it goes in. Just off the centre line rather than through it — a
      // thrust that ends exactly on the axis has every blade meeting at one
      // point, and what should read as three wounds reads as a pin cushion.
      blade.mark.set(
        centre.x + Math.cos(angle) * config.bite,
        centre.y + height + lift * 0.5,
        centre.z + Math.sin(angle) * config.bite
      );
      // And where it waits, back down its own line.
      blade.home.set(
        centre.x + Math.cos(angle) * config.standoff,
        centre.y + height + lift,
        centre.z + Math.sin(angle) * config.standoff
      );
      // The way out: on past the body and rising, so the tear-out clears the
      // corpse rather than backing out of the hole it made.
      blade.exit.set(
        centre.x - Math.cos(angle) * config.throughDistance,
        centre.y + height + config.throughLift,
        centre.z - Math.sin(angle) * config.throughDistance
      );

      blade.dir.subVectors(blade.mark, blade.home);
      if (blade.dir.lengthSq() < 1e-8) blade.dir.set(0, 0, 1);
      blade.dir.normalize();

      // The body this ring was measured against. `stab` re-aims by *moving*
      // the mark, and it needs somewhere to have moved it from — without this
      // the first re-aim would read the offset as the whole world position.
      blade.aimedAt.copy(centre);
      blade.aimedAt.y += height;

      blade.seed = Math.random() * 64;
      blade.roll = Math.random() * Math.PI * 2;
      blade.spin = (Math.random() - 0.5) * config.spin;
      blade.form = 0;
      // Negative, so the stagger runs off before the blade begins to exist.
      blade.timer = -i * Math.max(0, config.stagger);
      blade.state = 'gather';
      blade.holder.visible = true;

      this._place(blade, blade.home);
    }

    return wanted;
  }

  /**
   * Drive one in.
   *
   * The mark is re-read here rather than trusted from the summon: the body may
   * have turned or been pushed in the meantime, and a blade that goes through
   * the air beside a shoulder is worse than one that never came.
   *
   * @param {number} index which blade — wrapped, so a rite with more stabs than
   *   blades simply goes round again
   * @param {Vector3} [at] where the body is now
   * @returns {object|null} the blade that started moving, for whoever wants to
   *   dress the launch — null if none was ready
   */
  stab(index, at = null) {
    const blade = this._nth(index);
    if (!blade) return null;
    if (blade.state !== 'poised' && blade.state !== 'gather') return null;

    if (at) {
      // Re-aimed at the body's new position while keeping the offset off its
      // centre line that the summon chose, so the three wounds stay three.
      _scratch.subVectors(blade.mark, blade.aimedAt);
      blade.mark.copy(at).add(_scratch);
    }
    blade.aimedAt.copy(blade.mark);

    // Wherever it drifted to while it hovered is where the thrust starts — not
    // the point it was summoned at, or the blade would jump back before coming
    // forward.
    blade.home.copy(blade.holder.position);
    blade.dir.subVectors(blade.mark, blade.home);
    if (blade.dir.lengthSq() < 1e-8) blade.dir.set(0, 0, 1);
    blade.dir.normalize();

    // Resolved to whole on the frame it moves. A blade caught mid-gather has a
    // hole in it, and a hole travelling at a body reads as a rendering fault
    // rather than as a summons being interrupted by its own urgency.
    blade.form = 1;
    blade.state = 'thrust';
    blade.timer = 0;
    return blade;
  }

  /**
   * Tear them all out at once.
   *
   * Every blade goes, buried or not: one still hovering has nothing to pull out
   * of, and leaving it hanging while its siblings leave is worse than having it
   * join them.
   */
  wrench() {
    for (const blade of this.blades) {
      if (blade.state === 'hidden' || blade.state === 'wrench') continue;
      blade.state = 'wrench';
      blade.timer = 0;
      blade.home.copy(blade.holder.position);
    }
  }

  /** Let whatever is left burn away where it hangs. */
  banish() {
    for (const blade of this.blades) {
      if (blade.state === 'hidden' || blade.state === 'fade') continue;
      blade.state = 'fade';
      blade.timer = 0;
    }
  }

  /* ------------------------------------------------------------------ */
  /* the frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number} dt seconds, on the simulation's clock — a thrust is part of
   *   the blow it lands, so it holds through the hit-stop
   * @param {number} elapsed the shared clock, for the burn's own crawl
   * @param {object} config `settings.crimsonRite.blades`
   */
  update(dt, elapsed, config) {
    for (const blade of this.blades) {
      if (blade.state === 'hidden') continue;
      blade.timer += dt;
      this._advance(blade, dt, elapsed, config);
      if (blade.state !== 'hidden') this._sync(blade, elapsed, config);
    }
  }

  /** Every blade gone, immediately — for leaving the stage and for a reset. */
  clear() {
    for (const blade of this.blades) this._park(blade);
  }

  /**
   * Release what this actually created, and nothing else.
   *
   * The geometry under every blade is the library's, shared with the katana in
   * the character's hand — disposing it here would empty that hand. Only the
   * materials were made here, so only they are released; the cloned scene nodes
   * are plain objects the collector can have.
   */
  dispose() {
    for (const blade of this.blades) {
      blade.holder.parent?.remove(blade.holder);
      for (const material of blade.materials) material.dispose();
      blade.materials.length = 0;
    }
    this.blades.length = 0;
    this._template = null;
    this.group.parent?.remove(this.group);
  }

  /* ------------------------------------------------------------------ */
  /* the machine                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * One blade, one frame.
   *
   * Every state resolves the same two things — where the point is, and how much
   * of the blade exists — and nothing else. Which is why they read straight
   * down: `gather` brings it into being where it waits, `thrust` carries the
   * point onto the mark, `buried` holds it there, `wrench` takes it out the far
   * side, `fade` burns off what is left.
   */
  _advance(blade, dt, elapsed, config) {
    const beats = config.beats;

    switch (blade.state) {
      case 'gather': {
        // Still inside its own stagger: it does not exist yet, and the first
        // thing it does must not happen early.
        if (blade.timer < 0) {
          blade.form = 0;
          this._place(blade, blade.home);
          return;
        }
        const u = Math.min(1, blade.timer / Math.max(1e-3, beats.gather));
        // Resolving out of the smoke rather than appearing in it. The burn runs
        // backwards from the point, so a blade arrives tip first.
        blade.form = Easing.outQuad(u);
        // And drifting in as it does, so it is *coming* rather than waiting.
        _scratch.copy(blade.home).addScaledVector(blade.dir, -config.gatherDrift * (1 - u));
        this._place(blade, _scratch);
        if (u >= 1) {
          blade.state = 'poised';
          blade.timer = 0;
        }
        return;
      }

      case 'poised': {
        blade.form = 1;
        // Hanging, breathing on its own line. A blade holding perfectly still
        // reads as a prop that has been placed.
        const hover = Math.sin(elapsed * config.hoverSpeed + blade.seed) * config.hover;
        _scratch.copy(blade.home).addScaledVector(blade.dir, hover);
        _scratch.y += Math.cos(elapsed * config.hoverSpeed * 0.71 + blade.seed) * config.hover;
        this._place(blade, _scratch);
        return;
      }

      case 'thrust': {
        const u = Math.min(1, blade.timer / Math.max(1e-3, beats.thrust));
        blade.form = 1;
        // `outExpo`: most of the distance goes in the first fifth of the beat,
        // which is the difference between a thrust and a blade sliding along a
        // rail. The last stretch is nearly still, and it is what lets the eye
        // catch where the point actually stopped.
        _scratch.lerpVectors(blade.home, blade.mark, Easing.outExpo(u));
        this._place(blade, _scratch);
        if (u < 1) return;

        blade.state = 'buried';
        blade.timer = 0;
        // The frame the point is in, and the frame the blow is dealt on. What
        // that costs is entirely whoever wired this — see `vfx/CrimsonRite.js`.
        this.onPierce?.(blade);
        return;
      }

      case 'buried': {
        blade.form = 1;
        // A short, fast shiver along its own line and nowhere else: steel that
        // has just gone into something rings, and it rings down the blade.
        const ring =
          Math.sin(blade.timer * config.quiverSpeed) *
          config.quiver *
          Math.exp(-blade.timer * config.quiverDecay);
        _scratch.copy(blade.mark).addScaledVector(blade.dir, ring);
        this._place(blade, _scratch);
        return;
      }

      case 'wrench': {
        const u = Math.min(1, blade.timer / Math.max(1e-3, beats.wrench));
        // Out the far side rather than back the way it came. `outCubic`, so it
        // leaves hard and coasts — a linear exit is a blade being retracted.
        _scratch.lerpVectors(blade.home, blade.exit, Easing.outCubic(u));
        // And thrown up over its own line on the way, which is what turns a
        // withdrawal into a tear.
        _scratch.y += Math.sin(u * Math.PI) * config.throughArc;
        // Burning off from the moment it is clear of the body.
        blade.form = 1 - Math.max(0, (u - 0.45) / 0.55);
        this._place(blade, _scratch, u * config.throughRoll);
        if (u >= 1) this._park(blade);
        return;
      }

      case 'fade': {
        const u = Math.min(1, blade.timer / Math.max(1e-3, beats.fade));
        blade.form = 1 - u;
        // Drifting up as it goes, and turning: it is not being put away, it is
        // being let go of.
        _scratch.copy(blade.holder.position);
        _scratch.y += config.fadeRise * dt;
        this._place(blade, _scratch, u * config.throughRoll * 0.4);
        if (u >= 1) this._park(blade);
        return;
      }

      default:
        return;
    }
  }

  /**
   * Put the point here, aimed the way this blade is aimed.
   *
   * The holder's +Z is the blade, because the template was turned onto it and
   * shifted so the tip is on the origin — so a blade's whole transform is one
   * position and one basis, and the roll about its own line comes free.
   */
  _place(blade, at, extraRoll = 0) {
    _forward.copy(blade.dir);
    // Any vector square to the line will do for the basis; this one is built
    // off world up, unless the thrust is very nearly vertical, in which case it
    // is built off world forward instead.
    _up.set(0, 1, 0);
    if (Math.abs(_forward.dot(_up)) > 0.98) _up.set(0, 0, 1);
    _right.crossVectors(_up, _forward).normalize();
    _up.crossVectors(_forward, _right).normalize();

    // The roll about its own line. A katana is not symmetric about that axis —
    // it has a flat and an edge — so this is the difference between three
    // identical blades and three that were summoned separately.
    _quaternion.setFromAxisAngle(_forward, blade.roll + blade.spin * blade.timer + extraRoll);
    _right.applyQuaternion(_quaternion);
    _up.applyQuaternion(_quaternion);

    _basis.makeBasis(_right, _up, _forward);
    blade.holder.quaternion.setFromRotationMatrix(_basis);
    blade.holder.position.copy(at);
  }

  /** This frame's look, on every material this blade owns. */
  _sync(blade, elapsed, config) {
    for (const material of blade.materials) {
      const u = material.uniforms;
      u.uTime.value = elapsed;
      u.uForm.value = blade.form;
      u.uSeed.value = blade.seed;
      u.uLength.value = Math.max(0.05, config.length);
      copyColor(u.uBodyColor.value, config.bodyColor);
      copyColor(u.uSheenColor.value, config.sheenColor);
      copyColor(u.uRimColor.value, config.rimColor);
      copyColor(u.uEdgeColor.value, config.edgeColor);
      u.uRim.value = config.rim;
      u.uRimPower.value = Math.max(0.2, config.rimPower);
      u.uEdgeEmissive.value = config.edgeEmissive;
      u.uEdgeWidth.value = Math.max(0.005, config.edgeWidth);
      u.uNoiseScale.value = config.detail;
      u.uRise.value = config.burnRise;
      u.uVeins.value = config.veins;
      u.uVeinFlow.value = config.veinFlow;
    }
  }

  /** Off screen, and out of the way of the next cast. */
  _park(blade) {
    blade.state = 'hidden';
    blade.timer = 0;
    blade.form = 0;
    blade.holder.visible = false;
  }

  /** The nth *summoned* blade, wrapped. Allocation-free: it is called on beats. */
  _nth(index) {
    let live = 0;
    for (const blade of this.blades) if (blade.state !== 'hidden') live++;
    if (!live) return null;

    let wanted = ((index % live) + live) % live;
    for (const blade of this.blades) {
      if (blade.state === 'hidden') continue;
      if (wanted === 0) return blade;
      wanted--;
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* construction, deferred until there is something to build from       */
  /* ------------------------------------------------------------------ */

  /**
   * Make sure there are blades to summon.
   *
   * Everything here happens once, on the first cast — which is the earliest it
   * *can*: the katana belongs to the equipment, and the equipment does not
   * exist until the character screen has been built.
   */
  _ensure(config) {
    const length = Math.max(0.2, config.length);
    if (this._template && this._builtLength === length && this.blades.length) return true;
    if (this._missing) return false;

    const borrowed = this.source?.();
    if (!borrowed) {
      // Warned about once. A rite thrown before the equipment is up should not
      // fill the console with the same line on every press.
      this._missing = true;
      console.warn('[PhantomBlades] no katana to borrow — the rite runs without blades');
      return false;
    }

    // Only reached again when `length` has been moved in the editor. The scale
    // is baked into the template rather than onto the instances, so the blades
    // are rebuilt — and the materials, which are the only thing here that is
    // actually owned, are released first.
    for (const blade of this.blades) {
      blade.holder.parent?.remove(blade.holder);
      for (const material of blade.materials) material.dispose();
    }
    this.blades.length = 0;

    this._template = this._prepare(borrowed, length, config);
    this._builtLength = length;

    for (let i = 0; i < MAX_BLADES; i++) this.blades.push(this._makeBlade());
    return true;
  }

  /**
   * Measure the borrowed katana, turn it onto +Z, and put its point on the
   * origin.
   *
   * The result is a group nothing else touches — every blade is a clone of it,
   * so the measuring happens once however many are summoned.
   */
  _prepare(borrowed, length, config) {
    const model = borrowed.clone(true);
    model.position.set(0, 0, 0);
    model.quaternion.identity();
    model.scale.setScalar(1);
    model.updateMatrixWorld(true);

    _box.setFromObject(model);
    _box.getSize(_size);
    _box.getCenter(_centre);

    // The longest axis is the blade — measured rather than taken from the
    // catalog's note, exactly as `equipment/WeaponDissolve.js` does it, so a
    // re-export on a different axis costs nothing.
    if (_size.x >= _size.y && _size.x >= _size.z) _axis.set(1, 0, 0);
    else if (_size.y >= _size.z) _axis.set(0, 1, 0);
    else _axis.set(0, 0, 1);
    // Which *end* of that axis is the point is the one thing measuring cannot
    // answer — both ends of a bounding box look identical. The catalog says the
    // blade runs away from the guard down +Z and it does, so the far end is the
    // tip; `flip` is here for the day an export disagrees.
    if (config.flip) _axis.negate();

    const span = Math.max(1e-4, Math.abs(_size.dot(_axis)));
    const scale = length / span;

    // Turn the measured axis onto +Z, then scale to metres.
    _quaternion.setFromUnitVectors(_axis, BLADE_AXIS);
    model.quaternion.copy(_quaternion);
    model.scale.setScalar(scale);

    // Centre the piece on the holder, then slide it back half its length so the
    // point — the +Z end, after the turn — sits exactly on the origin.
    _scratch.copy(_centre).multiplyScalar(scale).applyQuaternion(_quaternion);
    model.position.copy(_scratch).negate();
    model.position.z -= length * 0.5;

    const holder = new Group();
    holder.name = 'PhantomBladeTemplate';
    holder.add(model);
    holder.updateMatrixWorld(true);

    holder.traverse((node) => {
      node.layers.set(LAYER.VFX);
      if (!node.isMesh && !node.isSkinnedMesh) return;
      node.visible = true;
      // Never in the depth pass. Three summoned blades throwing shadow maps for
      // the two thirds of a second they exist would cost more than every other
      // layer of the ability put together, and nothing in the reference casts
      // a shadow.
      node.castShadow = false;
      node.receiveShadow = false;
      node.frustumCulled = false;
      node.raycast = () => {};
    });

    return holder;
  }

  /**
   * One blade: a clone of the template, with a burn of its own on it.
   *
   * The clone's world matrices are resolved while its holder is still at the
   * origin, so each mesh's `matrixWorld` *is* its transform relative to the
   * blade — which is the frame the burn has to be resolved in, and the reason
   * it can be a constant uniform rather than something refreshed per frame the
   * way `equipment/WeaponDissolve.js` has to.
   */
  _makeBlade() {
    const holder = this._template.clone(true);
    holder.name = 'PhantomBlade';
    holder.visible = false;
    holder.position.set(0, 0, 0);
    holder.quaternion.identity();
    holder.scale.setScalar(1);
    holder.updateMatrixWorld(true);

    /** @type {ShaderMaterial[]} */
    const materials = [];
    holder.traverse((node) => {
      if (!node.isMesh && !node.isSkinnedMesh) return;
      // The palette's steel is dropped rather than modified: it is the same
      // material instance the character's armour wears, and a burn patched onto
      // it would put one on the body too.
      const material = makeBladeMaterial(node.matrixWorld);
      node.material = material;
      materials.push(material);
      node.frustumCulled = false;
      node.raycast = () => {};
    });

    this.group.add(holder);

    return {
      holder,
      materials,
      state: 'hidden',
      timer: 0,
      form: 0,
      seed: 0,
      /** Where it waits, where it goes in, and where it comes out. */
      home: new Vector3(),
      mark: new Vector3(),
      exit: new Vector3(),
      /** The body's position the mark was last resolved against. */
      aimedAt: new Vector3(),
      dir: new Vector3(0, 0, 1),
      roll: 0,
      spin: 0
    };
  }
}

/* -------------------------------------------------------------------- */

/**
 * The look of a summoned blade: cold steel that is not being lit by the moon.
 *
 * Nothing here is physically based and nothing here should be. A phantom katana
 * is four terms — a near-black body, a sheen where the key light would have
 * caught it, a crimson fresnel that pulls the silhouette out of a night sky,
 * and the burn that puts it there and takes it away — and each is a curve
 * chosen by eye. `uLightDir` is the *scene's* key direction rather than an
 * invented one, because a fake normal lit from somewhere the world is not lit
 * from reads as a sticker immediately.
 *
 * @param {import('three').Matrix4} toBlade the mesh's transform into the
 *   blade's own space — the frame the burn is resolved in, so the mask rides
 *   the steel however the blade is moving. Constant, because a summoned blade's
 *   parts never move relative to each other.
 */
function makeBladeMaterial(toBlade) {
  return new ShaderMaterial({
    // Opaque, and the burn is a `discard` rather than an alpha — the same
    // choice `combat/Enemy.js` and `equipment/WeaponDissolve.js` make. A
    // transparent blade would have to be sorted against the aura, the mist and
    // itself, and would still be less convincing than one with a hole genuinely
    // eaten in it.
    transparent: false,
    depthWrite: true,
    depthTest: true,
    fog: false,
    toneMapped: false,
    uniforms: {
      uTime: { value: 0 },
      uLightDir: frame.uLightDir,
      uToBlade: { value: toBlade.clone() },
      uBodyColor: { value: makeColor('#0b0709') },
      uSheenColor: { value: makeColor('#7c2833') },
      uRimColor: { value: makeColor('#ff2436') },
      uEdgeColor: { value: makeColor('#ff7038') },
      uRim: { value: 1.4 },
      uRimPower: { value: 2.6 },
      uEdgeEmissive: { value: 8.0 },
      uEdgeWidth: { value: 0.14 },
      /** 1 = whole, 0 = gone. Runs backwards from the point. */
      uForm: { value: 0 },
      /** Metres the blade is long, so the burn's gradient is in its own units. */
      uLength: { value: 1.4 },
      uNoiseScale: { value: 34.0 },
      uRise: { value: 0.62 },
      uVeins: { value: 0.55 },
      uVeinFlow: { value: 1.6 },
      uSeed: { value: 0 }
    },
    vertexShader: BLADE_VERTEX,
    fragmentShader: BLADE_FRAGMENT
  });
}

const BLADE_VERTEX = /* glsl */ `
uniform mat4 uToBlade;

varying vec3 vNormal;
varying vec3 vView;
varying vec3 vBlade;

void main() {
  // Into the *blade's* space, where +Z is the steel and the point is on the
  // origin. The mask has to live in that frame or it would crawl across the
  // piece as the blade swings — the same reasoning equipment/WeaponDissolve.js
  // sets out at length, except that here the transform is constant and can be
  // a uniform rather than something refreshed every frame.
  vBlade = (uToBlade * vec4(position, 1.0)).xyz;

  vNormal = normalize(normalMatrix * normal);
  vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
  vView = -viewPos.xyz;
  gl_Position = projectionMatrix * viewPos;
}
`;

/**
 * The burn, and the four terms of light that survive it.
 *
 * The mask is a noise field mixed with how far down the blade the fragment is,
 * thresholded against `uForm`, `discard`ed on the wrong side of the line and
 * lit along the line itself. Run `uForm` from 0 to 1 and the blade resolves out
 * of nothing from the point back; run it the other way and it burns off the
 * same way. One mask read in two directions, which is what makes the arrival
 * and the departure read as the same event happening twice.
 */
const BLADE_FRAGMENT = /* glsl */ `
${noiseGLSL}

uniform float uTime;
uniform vec3 uLightDir;
uniform vec3 uBodyColor;
uniform vec3 uSheenColor;
uniform vec3 uRimColor;
uniform vec3 uEdgeColor;
uniform float uRim;
uniform float uRimPower;
uniform float uEdgeEmissive;
uniform float uEdgeWidth;
uniform float uForm;
uniform float uLength;
uniform float uNoiseScale;
uniform float uRise;
uniform float uVeins;
uniform float uVeinFlow;
uniform float uSeed;

varying vec3 vNormal;
varying vec3 vView;
varying vec3 vBlade;

void main() {
  /* ---- the burn ---- */
  // 0 at the point, 1 at the far end of the handle — the blade runs down -Z
  // from an origin that is sitting on its own tip. So it arrives point first,
  // which is the only way round that reads as something being *drawn*.
  float along = clamp(-vBlade.z / max(uLength, 1e-3), 0.0, 1.0);
  float speckle = snoise01(vBlade * uNoiseScale + uSeed);
  float mask = mix(speckle, along, uRise);

  float threshold = 1.0 - clamp(uForm, 0.0, 1.0);
  if (mask < threshold) discard;
  // The line itself: a band just past the threshold, burning.
  float edge = 1.0 - smoothstep(threshold, threshold + uEdgeWidth, mask);

  /* ---- the steel ---- */
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vView);
  // Sided by hand: the burn opens holes, and the far wall of a hole is a back
  // face that would otherwise be lit from inside the blade.
  if (!gl_FrontFacing) N = -N;

  float ndl = max(dot(N, normalize(uLightDir)), 0.0);
  float fresnel = pow(1.0 - max(dot(N, V), 0.0), uRimPower);
  // A hard, narrow highlight rather than a soft roll-off: the one thing a
  // katana's surface does is throw a *line* of light down its flat.
  float sheen = pow(ndl, 12.0);

  /* ---- and what is running through it ---- */
  // Energy crawling up the steel toward the point, on a rate of its own so the
  // eye does not lock it to anything else in the ability.
  float veins = snoise01(vec3(vBlade.xy * 9.0, -vBlade.z * 4.5 + uTime * uVeinFlow + uSeed));
  veins = smoothstep(0.62, 0.9, veins) * uVeins * (1.0 - along);

  vec3 rgb =
    uBodyColor +
    uSheenColor * sheen * 1.6 +
    uRimColor * fresnel * uRim +
    uEdgeColor * (edge * uEdgeEmissive + veins * 2.2);

  gl_FragColor = vec4(rgb, 1.0);
}
`;
