/**
 * settings.js — the single source of truth for every tweakable value on the stage.
 *
 * Nothing in the renderer owns state that lives here: the lights, the floor
 * shader, the dust and the post pipeline all *read* these objects every frame,
 * so mutating a field is immediately visible on screen without rebuilding
 * anything. Systems may only ever sample these values — never copy one into a
 * record at construction time and read it back later.
 *
 * The camera, environment and post blocks are lifted wholesale from the
 * LinearAbiltyCastingThreeJS sandbox, so this project's stage is lit, framed and
 * graded exactly like that one.
 *
 * Conventions
 *  - Colours are stored as `#rrggbb` strings. Read them through
 *    `utils/color.js#getColor()`, which caches one THREE.Color per string.
 *  - `global` holds multipliers that scale everything at once (1 = neutral).
 */

export const settings = {
  /* ------------------------------------------------------------------ */
  /* Global multipliers                                                  */
  /* ------------------------------------------------------------------ */
  global: {
    timeScale: 1.0, // slow-mo / fast forward for the whole simulation
    animationSpeed: 1.0 // character animation playback rate
  },

  /* ------------------------------------------------------------------ */
  /* Camera                                                              */
  /* ------------------------------------------------------------------ */
  /**
   * A third-person orbit rig. The distance always resolves back to `distance`,
   * so framing stays consistent however the target drifts, and the wheel zooms
   * by writing that same field — which keeps this file the one authority.
   */
  camera: {
    // Pulled back from the character-stage default: the subject here is a
    // forest, and at two metres the trunks are all out of frame.
    distance: 3.9,
    minDistance: 1.0,
    maxDistance: 12.0,
    zoomSpeed: 3.0,
    zoomDamping: 0.002,
    minPolar: 0.05,
    /**
     * How far the orbit may fall *below* the target, in radians from +Y.
     *
     * Past π/2 the camera drops under the point it is looking at and the view
     * tilts up — which is the only way anything in the sky gets into frame. At
     * the old 1.55 the rig could not raise its aim above about 26° of elevation,
     * and a moon parked higher than that was simply off the top of the screen.
     * Kept just past level: further down and a long zoom would put the lens
     * through the floor, which nothing here collides against.
     */
    maxPolar: 1.62,
    fov: 55,
    targetHeight: 1.3,
    damping: 0.001,
    /**
     * Radians of view per pixel of mouse, while the pointer is captured.
     *
     * The whole stage's, not the rifle's: the pointer is taken by a click and
     * turns the view whatever is in the hand (`core/PointerLook.js`), so there
     * is one number for how fast the player turns rather than one per weapon.
     * What each mode adds on top of it is a *multiplier* — see
     * `gunplay.camera.adsSensitivity`.
     */
    sensitivity: 0.0023
  },

  /* ------------------------------------------------------------------ */
  /* Character                                                           */
  /* ------------------------------------------------------------------ */
  character: {
    /** Mixamo exports in centimetres. */
    fbxScale: 0.01,
    /** Rigs vary; normalise to a believable human height so world scale holds. */
    targetHeight: 1.78,
    /** Heading in radians about world +Y. 0 faces +Z, whichever way the rig binds. */
    facing: 0.0,
    /** Fraction of the heading gap left after 1s when turning (lower = snappier). */
    turnRate: 0.02,
    /**
     * Surface response of the imported skin.
     *
     * Materials matched out of the glTF palette carry their own authored
     * roughness/metalness *maps*, so these two are ignored for them until
     * `overrideSurface` is switched on — at which point they multiply the maps,
     * which is a way to look at the model rather than the shipped look. They
     * always apply to a material the palette had no match for.
     */
    overrideSurface: false,
    roughness: 1.0,
    metalness: 0.9,
    /** Slow turntable, revolutions/second. 0 parks the body where `facing` puts it. */
    spin: 0.0
  },

  /* ------------------------------------------------------------------ */
  /* Weapons                                                             */
  /* ------------------------------------------------------------------ */
  /**
   * The swap between the katana and the rifle — see `equipment/WeaponSwitch.js`.
   *
   * There is no draw and no sheathe: one weapon burns away along a noise mask
   * while the other burns in through the same mask, and the two overlap so the
   * hand is never empty. The whole trick is that the mask is *shared* — the same
   * pattern, run backwards — which is what makes the two halves read as one
   * exchange rather than as two separate effects that happen to be adjacent.
   */
  weapons: {
    /** Seconds from the press to the new weapon standing solid. */
    switchTime: 0.62,
    /**
     * How much of that the two halves share, 0..0.9.
     *
     * 0 is strictly one then the other and leaves a visible empty hand in the
     * middle; anything past about half and the two are simply on screen
     * together. A quarter is the overlap that reads as one becoming the other.
     */
    overlap: 0.28,
    /**
     * Where in the timeline the *grip* changes, 0..1.
     *
     * The idle the body stands in is a full-body pose, and it has to change on
     * the beat the new weapon appears rather than on either end of the swap —
     * too early and the hands are shaped round a gun that is not there yet, too
     * late and they are still holding a blade that has gone.
     */
    handover: 0.55,
    /** The glowing edge of the mask, and how wide that band is (0..1 of the burn). */
    edgeColor: '#7fd4ff',
    edgeEmissive: 4.5,
    edgeWidth: 0.05,
    /**
     * Features per metre in the mask noise.
     *
     * Far higher than the same control on a body, and it has to be: a blade is
     * three centimetres across, so anything under about fifty features per
     * metre puts less than two blobs across its width and the mask reads as the
     * weapon being cut in half rather than as it coming apart.
     */
    detail: 70.0,
    /**
     * How much the burn runs along the piece rather than being pure static —
     * 1 is a clean line travelling from the grip to the tip, 0 is noise eating
     * it from everywhere at once.
     */
    rise: 0.55
  },

  /* ------------------------------------------------------------------ */
  /* Gunplay                                                             */
  /* ------------------------------------------------------------------ */
  /**
   * The shooter, and everything that is only true while the rifle is out.
   *
   * The whole mode is entered by drawing the gun — there is no aim key and no
   * separate state to get into. `equipment/WeaponSwitch.js` says which weapon
   * is in the hand, `combat/Gunplay.js` reads that, and four things change at
   * once: the lens steps off the body's axis onto a shoulder, a reticle comes
   * up in the middle of the screen, the torso stops facing where the feet are
   * going and points at whatever the reticle is on, and the left button fires.
   *
   * The one number that decides whether any of it *reads* is `camera.offset`.
   * A third-person shooter is a lie held together by one thing: the round comes
   * out of a gun that is half a metre to the side of and below the lens, and it
   * still has to arrive exactly where the reticle is. Every game solves it the
   * same way this does — the lens is shifted sideways so the body is out of the
   * way of its own aim, the reticle is a ray *from the lens*, and the muzzle is
   * simply pointed at wherever that ray landed. See `combat/Gunplay.js`.
   */
  gunplay: {
    enabled: true,
    /**
     * Which shoulder the lens is over: -1 is the left, +1 the right.
     *
     * Right by default, which is what a right-handed body wants: the rifle is
     * carried on that side, so a lens over the left shoulder is looking across
     * the chest and past the gun rather than down it, and the muzzle sits in
     * the wrong half of the screen from the reticle it is answering to.
     *
     * Live, and swapped with `H` or the middle mouse button. It is a number
     * rather than a boolean because it is also the *amount*: the offset is
     * multiplied by it, so crossing between the two sides is one damp on one
     * value rather than a switch with a special case in the middle.
     */
    shoulder: 1,

    camera: {
      /** Metres the lens steps off the body's axis, toward `shoulder`. */
      offset: 0.62,
      /** Metres it rises with it, in the lens's own frame. */
      rise: 0.05,
      /** What the orbit resolves to while the gun is up — closer than the walk. */
      distance: 2.4,
      /** And how high it looks: the chest rather than the waist. */
      targetHeight: 1.5,
      fov: 52,

      /** The same four, held down the sights (right button). */
      adsOffset: 0.46,
      adsDistance: 1.75,
      adsTargetHeight: 1.54,
      adsFov: 36,

      /** Fraction of the gap left after 1s as the lens moves onto the shoulder. */
      blend: 0.0006,
      /**
       * What `camera.sensitivity` is multiplied by down the sights — a longer
       * lens turns slower.
       */
      adsSensitivity: 0.55
    },

    aim: {
      /** Metres the reticle's ray reaches before it gives up and picks a point. */
      range: 160,
      /** Metres between samples as that ray walks the height field. */
      step: 0.55,

      /**
       * How the twist toward the reticle is shared out up the spine.
       *
       * Each joint takes its share of the same yaw and pitch, and the shares
       * are normalised — so whatever is listed here, the *last* joint in the
       * chain ends up pointing exactly at the reticle. That is why the neck and
       * the head are not on the list: the gun hangs off the arms, the arms hang
       * off `Spine2`, and anything given to a joint above `Spine2` is a share
       * of the aim the gun does not get. The head coming round with the chest
       * rather than past it is also simply what a person aiming a rifle does —
       * the cheek is on the stock.
       *
       * Three joints rather than one for the obvious reason: a body that bends
       * only at the waist is a mannequin on a turntable.
       */
      shares: { Spine: 0.26, Spine1: 0.34, Spine2: 0.4 },
      /** Degrees the torso may twist off the hips before the feet have to move. */
      maxYaw: 78,
      /** And how far up and down it will look. */
      maxPitch: 52,
      /** Fraction of the angle gap left after 1s (lower = the torso snaps round). */
      rate: 0.00004,
      /** Fraction of the blend left after 1s as the aim comes up, and drops. */
      enter: 0.0008,

      /**
       * Degrees the *legs* may lean off the lens toward where the body is
       * actually travelling.
       *
       * This used to be the whole answer to sideways travel — with one walk and
       * one run, both forward, a body locked square to the lens moonwalks the
       * moment it is not going that way, and turning the hips part of the way
       * into the travel is what every game without a strafe set does about it.
       * There is a strafe set now (`WalkSideRifle.fbx`), so the number is a
       * fraction of what it was: what the hips no longer take, the sidestep
       * clip shows properly, and every degree given back here is a degree of
       * that clip traded for a body pointing somewhere it is not looking. Wind
       * it up toward 90 and the strafe fades out as the hips swallow it.
       */
      lean: 20,
      /** Fraction of the heading gap left after 1s while the body holds the aim. */
      turnRate: 0.000002
    },

    fire: {
      /** Rounds a second, and whether holding the button keeps them coming. */
      rate: 9.5,
      auto: true,
      /** Metres a second the round travels. It is a projectile, not a trace. */
      speed: 155,
      /** Metres a second squared it falls — 0 is a laser, and reads like one. */
      drop: 2.5,

      /** Degrees of cone: standing, at a run, and down the sights. */
      spread: 0.85,
      moveSpread: 2.8,
      adsSpread: 0.22,
      /** Degrees added per round, what that piles up to, and how fast it bleeds. */
      bloom: 0.5,
      bloomMax: 3.4,
      bloomRecover: 5.0,

      /** Degrees the view is kicked up per round, and scattered sideways. */
      recoilPitch: 0.62,
      recoilYaw: 0.22,
      /** Fraction of the kick still standing after 1s — the pull back down. */
      recoilRecover: 0.000002,
      /** Metres the lens is knocked, on top of the kick. */
      shake: 0.028
    },

    damage: {
      /** What a body is worth, and what one round takes off it. */
      health: 100,
      /** Three in the chest. */
      body: 34,
      /** Or one anywhere above the collar. */
      head: 100,

      /** The blow a lethal round hands the ragdoll — see `combat/Ragdoll.js`. */
      impulse: 3.0,
      lift: 1.4,
      spin: 1.1,
      /** And what a head shot hands it: less shove, far more fold. */
      headImpulse: 2.4,
      headLift: 2.2,
      headSpin: 2.6,

      /** Droplets a hit throws, and how hard, per kind of hit. */
      bodyBlood: 12,
      headBlood: 34,
      bloodSpeed: 3.2,

      /** Seconds a struck body's rim burns brighter, and by how much. */
      flinch: 0.24,
      flinchRim: 6.0,

      /** Metres the lens is knocked on a hit, and again on the kill. */
      hitShake: 0.02,
      killShake: 0.06,
      /** Seconds the world nearly stops on a kill, and how far down it goes. */
      killHitStop: 0.045,
      killHitStopScale: 0.3
    },

    /**
     * What a round can hit, as three volumes read off the skeleton every frame.
     *
     * Cheap analytic shapes rather than the mesh: a sphere on the head and two
     * capsules down the body. It is the head sphere that matters — it is the
     * whole difference between a gun that rewards aim and one that does not,
     * and it is deliberately a little generous.
     */
    hitbox: {
      headRadius: 0.14,
      torsoRadius: 0.24,
      legRadius: 0.17
    },

    tracer: {
      /** Metres of streak drawn behind each round, and how thick. */
      length: 2.8,
      width: 0.035,
      color: '#ffd9a0',
      /** Straight past 1, so the bloom pass catches it. */
      brightness: 5.0,
      /** Seconds a round lives before it is taken back, whatever it has hit. */
      life: 1.6
    },

    muzzle: {
      /** Metres from the barrel's tip, along the way it points, and off it. */
      forward: 0.05,
      up: 0.0,
      right: 0.0,
      /** Metres across the flash, and the seconds it lasts. */
      size: 0.34,
      life: 0.055,
      color: '#ffcf8a',
      /** The light it throws, and how far it reaches. */
      light: 9.0,
      lightRange: 7.0
    },

    impact: {
      /** Sparks thrown by a round landing on the ground, and how fast. */
      sparks: 14,
      speed: 6.5,
      /** Seconds they last, metres across, and how hard they fall. */
      life: 0.42,
      size: 0.055,
      gravity: -16.0,
      color: '#ffc98a',
      brightness: 3.0
    },

    /**
     * The held shot — the one round the rifle fires that is not a round.
     *
     * ## The gesture
     *
     * The right button is already the sights. Held *still* for three seconds it
     * becomes something else: a bar fills under the reticle
     * (`ui/Crosshair.js`), and the release that would ordinarily just drop the
     * sights sends one round instead — dead on the reticle, no cone at all, and
     * whatever it lands on is taken apart by `vfx/FocusedBurst.js`.
     *
     * Three conditions hold the charge and any one of them breaking empties it:
     * the sights up, the feet planted, and the trigger untouched. The last is
     * the one worth saying out loud — the charge is a held breath, and a burst
     * fired in the middle of one is the breath let go.
     *
     * ## What it costs
     *
     * `damage` is deliberately past a body's whole health: the round is three
     * seconds of standing still in the open, and a shot that took three seconds
     * to earn and then needed a second one is a shot nobody will ever take. The
     * blast is what makes it worth aiming at a *crowd* rather than at a body —
     * `blastDamage` at the centre, falling to nothing at `blastRadius`, and it
     * cannot touch the body that was hit directly (that one is already spent).
     */
    focus: {
      enabled: true,
      /** Seconds the sights must be held, still, before the shot is offered. */
      charge: 3.0,
      /**
       * Seconds the filled bar waits before the release stops meaning this.
       *
       * 0 is "for as long as the button is down", which is what this wants: a
       * player who has earned the shot should be free to keep holding it while
       * they pick a target. Anything above 0 puts a clock on that.
       */
      hold: 0,

      /** What the one round is worth, in the chest and above the collar. */
      damage: 240,
      headDamage: 400,
      /** m/s. Faster than an ordinary round, and it does not fall as far. */
      speed: 260,
      drop: 0.6,
      /** Multiplier on the tracer's width and length, for this round only. */
      tracer: 3.4,

      /** Degrees the view is kicked, and metres the lens is knocked with it. */
      recoilPitch: 2.4,
      recoilYaw: 0.5,
      shake: 0.05,
      /** And what the *landing* is worth to the lens, wherever it happened. */
      blastShake: 0.14,
      /** Seconds the world nearly stops on the blast, and how far down it goes. */
      hitStop: 0.085,
      hitStopScale: 0.22,

      /** Metres the blast reaches, and what it is worth at the middle of it. */
      blastRadius: 3.6,
      blastDamage: 140,
      /** The blow the blast hands a ragdoll — everything here is thrown *out*. */
      impulse: 6.5,
      lift: 4.0,
      spin: 2.4,

      /**
       * The devastation itself — `vfx/FocusedBurst.js`.
       *
       * Seven layers, painted back to front, and each one has its own `*Enabled`
       * flag so it can be soloed against the other six. That is the only sane
       * way to tune a stack this deep: the whole thing is one white flash for
       * the first fifty milliseconds, and nothing in it can be judged while the
       * other six are on top of it.
       */
      burst: {
        enabled: true,
        /** Seconds the longest layer lives. Every other layer is a share of it. */
        life: 1.75,
        /** Metres the shell opens to. The one number that sets the whole scale. */
        radius: 3.1,
        /** Master on every layer's brightness. */
        intensity: 1.8,

        /** 1. The dome of arcs: the shell, and the lines drawn on it. */
        shellEnabled: true,
        shellColor: '#3fa9ff',
        shellCoreColor: '#d8f4ff',
        /** Meridians round it and parallels up it — the cage in the reference. */
        meridians: 7,
        parallels: 5,
        /** How wide an arc is, and how hard the rim it rides on burns. */
        arcWidth: 0.05,
        shellRim: 1.4,
        /** Metres of boil on the silhouette, and how fine the boil is. */
        shellWarp: 0.0,
        shellDetail: 0.9,
        /** Fraction of `life` the shell is out and gone in. */
        shellLife: 0.41,

        /** 2. The core: the white of it, and the star thrown off it. */
        coreEnabled: true,
        coreColor: '#eafaff',
        coreHalo: '#38b6ff',
        /** Metres across at its widest, and the fraction of `life` it lasts. */
        coreSize: 10.0,
        coreLife: 0.42,
        /** Spikes on the star, and how far they reach past the ball. */
        coreSpikes: 3,
        coreSpikeLength: 1.7,

        /** 3. The web of cracks under it. */
        decalEnabled: true,
        decalColor: '#2f9dff',
        decalCoreColor: '#cdefff',
        /** Metres across, and how high off the ground the burst may be and
         *  still leave one — a round that hit a head does not crack the floor. */
        decalRadius: 7.8,
        decalReach: 6.7,
        /** How fine the web is, spokes running out of the middle, and the burn. */
        decalDetail: 5.8,
        decalSpokes: 9,
        decalScorch: 0.9,
        /** Fraction of `life` the cracks take to write, and to fade after. */
        decalWrite: 0.32,

        /** 4. The chunks the floor gives up. */
        debrisEnabled: true,
        debris: 12,
        /** Metres on a side, thrown at, and how far off straight up they go. */
        debrisSize: 0.135,
        debrisSpeed: 19.8,
        debrisSpread: 1.54,
        debrisGravity: -9.5,
        debrisLife: 1.25,
        debrisColor: '#b8b3ac',

        /** 5. The sparks: the ember half of the shower. */
        sparksEnabled: true,
        sparks: 95,
        sparkColor: '#ffb257',
        sparkSpeed: 10.5,
        sparkSize: 0.06,
        sparkLife: 0.75,
        sparkStretch: 0.05,
        sparkDrag: 1.7,
        sparkGravity: -15.0,

        /** 6. The shards: the cold half, in two colours. */
        shardsEnabled: true,
        shards: 53,
        shardColor: '#66f0ff',
        shardColorAlt: '#e07dff',
        shardSpeed: 13.5,
        shardSize: 0.16,
        shardLife: 0.95,
        shardDrag: 2.4,
        shardGravity: -9.0,

        /** 7. The haze standing in for the air being torn. */
        hazeEnabled: true,
        haze: 11,
        hazeColor: '#c9d6e4',
        hazeOpacity: 0.56,
        /** Metres across at birth, what it grows to, and how fast it climbs. */
        hazeSize: 0.7,
        hazeGrowth: 2.6,
        hazeRise: 1.4,
        hazeLife: 1.35,

        /** The light the whole thing throws, and how far it reaches. */
        light: 102.0,
        lightRange: 13.5,
        lightColor: '#7fd8ff'
      }
    },

    /**
     * The bar over a body's head — see `vfx/HealthBars.js`.
     *
     * It belongs to the gun and to nothing else, which is why it is a block
     * here rather than under `enemies`: the rifle is the only weapon on the
     * stage that spends a body's health a piece at a time, so it is the only
     * one that leaves a question a bar can answer. Bars come up with the rifle
     * and fade with it.
     */
    healthBar: {
      enabled: true,
      /** Metres across, and tall — small, because it is a glance, not a readout. */
      width: 0.46,
      height: 0.055,
      /** Metres above the head it floats. */
      lift: 0.3,
      /**
       * Pixels of width it may never fall below.
       *
       * A bar sized purely in metres is honest up close and three pixels wide
       * at forty metres. Past the distance where this takes over the bar simply
       * stops shrinking, which is the whole difference between a reading and a
       * speck.
       */
      minWidth: 26,
      /** Metres from the lens a body still wears one. */
      range: 80,
      /** Seconds it takes to come up, and to go back out. */
      fadeIn: 0.12,
      fadeOut: 0.28,

      /** What is left, the ground behind it, and the frame around it. */
      color: '#ff2d32',
      trackColor: '#160709',
      frameColor: '#04050a',
      /** How solid those two are — the remaining health itself is always solid. */
      trackOpacity: 0.5,
      frameOpacity: 0.72,
      /** The frame's thickness, as a fraction of the bar's height. */
      border: 0.15,
      /** Whether a body nobody has hit yet wears one at all. */
      onlyWounded: false
    }
  },

  /* ------------------------------------------------------------------ */
  /* Locomotion                                                          */
  /* ------------------------------------------------------------------ */
  /**
   * The third-person controller and the idle/walk/run blend it drives.
   *
   * `walkSpeed` and `runSpeed` are metres per second: how fast the body travels,
   * and the speeds the blend reads for its weights. `clipWalkSpeed` and
   * `clipRunSpeed` are what the *clips* were authored at, and they are what the
   * playback rate divides by — keeping the two apart is what makes raising
   * `runSpeed` speed the legs up to match instead of skating them.
   * `strideMin/Max` bound how far that rate is allowed to stretch.
   */
  locomotion: {
    enabled: true,
    walkSpeed: 1.5,
    runSpeed: 3.53,
    /** Ground speed each clip covers at rate 1. Fixed by the animation, not the design. */
    clipWalkSpeed: 1.35,
    clipRunSpeed: 6.35,
    /** m/s² toward the stick, and off it. Deceleration is the harder of the two. */
    acceleration: 14.0,
    deceleration: 20.0,
    /** Below this the body is standing still, whatever the residual velocity. */
    idleThreshold: 0.08,
    /** Fraction of the blend gap left after 1s (lower = snappier clip changes). */
    blendRate: 0.0005,
    /**
     * The same, for the cross-fade between the two idles — the plain stand and
     * the rifle one. Faster than the gait blend on purpose: this one is
     * answering a weapon appearing in the hand, and it has to be finished by
     * the time the burn is.
     */
    stanceRate: 0.00002,
    /**
     * Trim on the stride rate, per gait — a multiplier on top of the
     * speed/clip-speed division, blended between the two the same way the
     * weights are. The division is only as right as `clipWalkSpeed` and
     * `clipRunSpeed` are, and those are guesses until someone watches the feet;
     * these are where that judgement goes. Leave them at 1 and nothing changes.
     *
     * The run trim is large because `clipRunSpeed` is set well above `runSpeed`:
     * the division alone would play the run clip at about half rate and drag the
     * feet, so the multiplier puts the legs back at the pace the ground is
     * actually passing at.
     */
    walkAnimSpeed: 0.8,
    runAnimSpeed: 2.42,
    /** Clamp on the clip playback rate, so a stretched speed never skates or sprints. */
    strideMin: 0.65,
    strideMax: 2.5
  },

  /* ------------------------------------------------------------------ */
  /* Jump                                                                */
  /* ------------------------------------------------------------------ */
  /**
   * The running long jump — space, from a run only. Space at any lesser pace
   * gets the in-place `hop` below instead.
   *
   * It is a committed move: the stick is dead from launch until the feet are
   * back down, and the body ends the jump wherever the arc put it. `distance`
   * is that reach in metres, applied by renormalising the clip's own hips
   * translation, so the animator's shape is kept and only its size is the
   * designer's; 0 means "travel exactly as far as the clip does".
   */
  jump: {
    enabled: true,
    /** Metres of ground the jump covers. 0 = whatever the clip itself travels. */
    distance: 7.0,
    /** Whether a run is a precondition. Off, and every jump is this one. */
    requiresRun: true,
    /** Fraction of `runSpeed` the body must already be doing to launch at all. */
    minRunFraction: 0.6,
    /** Normalised time in the clip at which the feet are down and control returns. */
    landAt: 0.86,
    /** Seconds to fade the jump over the run, and back off it after landing. */
    blendIn: 0.08,
    blendOut: 0.22
  },

  /**
   * The plain hop — space, from anything the long jump turns down.
   *
   * Standing, walking, or running below `jump.minRunFraction`, this is what
   * space does. The clip travels nowhere, and that is what lets it stay a
   * *modifier* rather than a move: it plays over the gait without taking the
   * stick, so a jump out of a walk keeps its momentum and comes down still
   * heading where the player was steering. Nothing here is a distance for the
   * same reason — the controller never stops owning the position.
   */
  hop: {
    enabled: true,
    /** No gait to clear, so the hop answers from a standstill too. */
    requiresRun: false,
    /**
     * How much of the gait keeps playing underneath, 0..1.
     *
     * The clip is a *standing* jump, so at full take-over it plants the legs
     * while the controller carries the body on — the body travels, but it reads
     * as the character stopping to jump and sliding. Leaving some of the walk or
     * run under it keeps the legs moving through the arc. Only the travelling
     * clips get this; a hop from a standstill is the pure pose.
     */
    gaitBleed: 0.35,
    /** Normalised time in the clip at which the feet are back down. */
    landAt: 0.82,
    /** Seconds to fade the hop over the gait, and back off it after landing. */
    blendIn: 0.07,
    blendOut: 0.18
  },

  /* ------------------------------------------------------------------ */
  /* The kick                                                            */
  /* ------------------------------------------------------------------ */
  /**
   * `E` — the one attack, and the thing that makes it read: **motion warping**.
   *
   * A kick animation is authored at one distance from one target, and a player
   * never stands there. Every third-person game worth the name answers this the
   * same way: the clip is not moved to the player, the *player* is moved to the
   * clip. On the press the nearest enemy inside `range` and the `cone` is
   * locked, the ideal contact spot is resolved (`standoff` metres short of it),
   * and the body is carried there over the first `warpAt` of the clip — turning
   * first, stepping in second. The foot lands where the animator put it, on a
   * target that is exactly where the animator assumed one would be.
   *
   * Everything after the contact is impact: `hitStop` freezes the world for a
   * few dozen milliseconds (the oldest trick in the fighting-game book, and
   * still the one that sells a hit), the lens takes a `shake`, and the enemy is
   * handed the impulse below as a ragdoll — see `combat/Ragdoll.js`.
   *
   * The three normalised times are the contract with the clip: `hitAt` is the
   * frame the foot is out, `recoverAt` the frame control comes back, and
   * `warpAt` the window the approach is allowed. Watch the kick once and dial
   * them; nothing else in here depends on the animation.
   */
  kick: {
    enabled: true,
    /** Metres a target can be locked from. Past this the kick swings at air. */
    range: 3.4,
    /** Full width of the search cone, degrees — a kick behind you is not a kick. */
    cone: 130,
    /**
     * Metres from the target's centre the strike is thrown from.
     *
     * This is the number that decides whether the foot lands on the chest or
     * through it. Mixamo's kicks are authored at roughly a metre and a bit.
     */
    standoff: 1.12,
    /** Ceiling on the warp, metres. Beyond it the body steps as far as it can. */
    maxWarp: 3.0,
    /** Fraction of the clip the approach takes. The rest is the strike itself. */
    warpAt: 0.36,
    /** Fraction of *that* window the turn finishes in: face first, then close. */
    turnAt: 0.5,
    /** Normalised time the foot connects. */
    hitAt: 0.42,
    /** Metres the strike still lands at, measured at `hitAt`. Slack on `standoff`. */
    reach: 2.1,
    /** Normalised time the stick is handed back. */
    recoverAt: 0.74,
    /** Played exactly as authored — see the slash's own note on this. */
    timeScale: 1,
    /** Seconds to fade the kick over the gait, and back off it. */
    blendIn: 0.08,
    blendOut: 0.24,

    /**
     * m/s along the kick, and straight up, given to the body it lands on.
     *
     * These two and `ragdoll.gravity` decide the distance: at the defaults the
     * body leaves the ground for about half a second and comes down some three
     * metres back. Far enough to read as a blow, near enough to still be in
     * frame when it lands.
     */
    impulse: 6.5,
    lift: 3.4,
    /**
     * How much more of that the *upper* body takes, per body-height above the
     * hips. This is the whole difference between a corpse sliding backwards and
     * one folding over the foot and going down — the shoulders leave faster
     * than the feet do, so the body rotates around the impact.
     */
    spin: 1.6,
    /** Seconds the world nearly stops on contact, and how far down it goes. */
    hitStop: 0.07,
    hitStopScale: 0.06,
    /** Metres the lens is kicked. Decays in about a third of a second. */
    shake: 0.16,
    /** A boot does not cut anyone in half — see `settings.slice`. */
    slices: false
  },

  /* ------------------------------------------------------------------ */
  /* The slash hit                                                       */
  /* ------------------------------------------------------------------ */
  /**
   * `R` — the second attack, and the same machine as the kick above.
   *
   * Every field means exactly what it means there, because both are driven by
   * the same `animation/Attack.js` and only the numbers differ. Read the block
   * above first; this one is only the ways the move is *not* a kick.
   *
   * The clip (`Slash.fbx`) is a two-handed sweep, and the numbers here are read
   * straight off it. It runs 2.4 seconds at its authored pace, which is half as
   * long again as anything else the body does — hence `timeScale`. Within that:
   *
   *  - **0 → 0.30** the wind-up, the blade carried back over the left shoulder.
   *    Nothing has happened yet, which is why the approach is allowed to run to
   *    `warpAt` before it has to be finished.
   *  - **0.33 → 0.42** the sweep. The hand crosses the body's front at 0.38 and
   *    reaches furthest at 0.40, so that is where the blow is (`hitAt`).
   *  - **0.42 → 0.66** the follow-through: the hips drop into a deep finish and
   *    come back up. Control returns as the body straightens, not after it has
   *    settled, or the move costs two whole seconds of standing still.
   *
   * It hits *across* rather than down — more shove than the jump it replaced,
   * still a lot of lift, because a top half that is thrown clear is the whole
   * point of a cut. See `settings.slice` for what happens to the body itself.
   */
  slashHit: {
    enabled: true,
    /** Metres a target can be locked from — a sword reaches past a foot. */
    range: 5.0,
    /** Full width of the search cone, degrees. Tighter: this one is committed. */
    cone: 110,
    /**
     * Metres from the target's centre the swing is thrown from.
     *
     * Further out than the kick's, and it has to be: the contact is the length
     * of an arm and a blade from the shoulder, not the length of a leg.
     */
    standoff: 1.6,
    /** Ceiling on the warp, metres. This one steps in rather than leaps. */
    maxWarp: 4.5,
    /**
     * Fraction of the clip the approach takes.
     *
     * The end of the wind-up, so the body arrives on its mark on the frame the
     * blade starts to move and the sweep itself is never slid through.
     */
    warpAt: 0.34,
    /** Fraction of *that* window the turn finishes in: face first, then close. */
    turnAt: 0.45,
    /** Normalised time the blow connects — the frame the edge crosses the front. */
    hitAt: 0.38,
    /** Metres the strike still lands at, measured at `hitAt`. */
    reach: 2.6,
    /** Normalised time the stick is handed back, as the body comes back up. */
    recoverAt: 0.66,
    /**
     * How much faster than authored the clip is played.
     *
     * 2.4 seconds is a long time to hold a player still. At 1.35 the swing is
     * about 1.8 seconds end to end and the commitment is a little over one,
     * which puts it in the same family as the kick without touching the export.
     */
    timeScale: 1.35,
    /** Seconds to fade the move over the gait, and back off it. */
    blendIn: 0.09,
    blendOut: 0.26,

    /**
     * m/s along the blow, and straight up.
     *
     * Lower than the kick's, and it still throws further: half a body weighs
     * half as much to this solver and `slice.split` adds to it on top. At these
     * the torso comes down about four and a half metres out, against the three
     * and a half a whole body kicked across the same ground manages — far
     * enough to read as *thrown clear*, near enough to still be in frame.
     */
    impulse: 4.6,
    lift: 5.2,
    /** Upper body multiplier — high, so what is left of the torso goes over. */
    spin: 2.0,
    /** Seconds the world nearly stops on contact, and how far down it goes. */
    hitStop: 0.1,
    hitStopScale: 0.05,
    /** Metres the lens is knocked. */
    shake: 0.24,
    /** This one comes across with the sword: the body it lands on comes apart. */
    slices: true
  },

  /* ------------------------------------------------------------------ */
  /* The slide cut                                                       */
  /* ------------------------------------------------------------------ */
  /**
   * `T` — the gap closer. Same machine again (`animation/Attack.js`), and the
   * one of the three whose *approach* is the move rather than a way of reaching
   * one.
   *
   * The clip (`Crouchslash.fbx`) runs 2.12 seconds at 60fps and carries about
   * three and a half metres of its own forward travel, which `_retarget` freezes
   * like every other non-root-motion clip — so the ground it covers is the warp's
   * to supply, and `maxWarp` is what decides how far the slide actually goes.
   * Read off the hips and the sword hand:
   *
   *  - **0 → 0.24** the run-up and the drop: the hips fall from standing to a
   *    third of their height and the blade is carried back and low.
   *  - **0.24 → 0.47** the slide itself, hips flat at their lowest. Nothing has
   *    happened yet, which is why the approach is allowed to run this late —
   *    `warpAt` sits at the end of it, so the whole distance is closed on the
   *    frames that are authored as travel.
   *  - **0.47 → 0.70** the body comes up out of the crouch and the arm sweeps
   *    across the front, furthest out at 0.60 and crossing the far shoulder at
   *    0.70 — the ~45th frame of the source, and `hitAt`. The body is still
   *    travelling here, and it is meant to be: this is the frame it draws level
   *    with what it is cutting, not the frame it stops in front of it.
   *  - **0.70 → 1** the follow-through and standing back up, on the far side of
   *    the body (`passThrough`). Control comes back as the character straightens
   *    rather than after it has settled.
   *
   * It is a sword and it cuts (`slices`), and it comes across low and hard: more
   * shove than the standing slash, since the whole body weight is behind it.
   */
  crouchSlash: {
    enabled: true,
    /**
     * Metres a target can be locked from.
     *
     * By far the longest of the three, because this is the move that *travels*:
     * the clip is a run into a slide, and locking only what is already in a
     * sword's reach would waste it.
     */
    range: 9.0,
    /** Full width of the search cone, degrees. Narrow — you commit to a line. */
    cone: 90,
    /**
     * Metres from the target's centre the cut is thrown from — as the slash.
     *
     * Not where the move ends, though: this one only *passes* the mark. See
     * `passThrough`.
     */
    standoff: 1.55,
    /** Ceiling on the warp, metres. The whole point of the move. */
    maxWarp: 8.0,
    /**
     * Metres past the body the slide finishes, and the thing that makes this a
     * pass rather than a stop.
     *
     * A slide cut that halts in front of what it cut is a run that ran out. The
     * warp gets a second leg for it (`animation/Attack.js`): the contact mark is
     * somewhere on the way rather than the end of the trip, and the body carries
     * on down the same line until it is standing behind what it just opened,
     * still facing the way it went. With `passAt` at `recoverAt` the travel ends
     * on the frame the stick comes back, so the player takes the body over
     * already on the far side.
     */
    passThrough: 1.9,
    /**
     * Normalised time the pass-through finishes.
     *
     * The far side of the cut and the frames the body is standing back up on —
     * it should not still be sliding once the player has it again, so this and
     * `recoverAt` are the same number.
     */
    passAt: 0.86,
    /**
     * Fraction of the clip the approach takes.
     *
     * The end of the slide, so the gap is closed while the body is low and
     * moving. What comes after it is no longer the approach but the pass: at
     * this frame the character is on the mark, at `hitAt` it is level with the
     * body, and by `passAt` it is behind it.
     */
    warpAt: 0.6,
    /**
     * Fraction of *that* window the turn finishes in.
     *
     * Early: a slide that curves reads as a homing missile, so the body is
     * pointed down the line before it has gone far along it.
     */
    turnAt: 0.3,
    /** Normalised time the blade crosses the target — the ~45th source frame. */
    hitAt: 0.7,
    /** Metres the strike still lands at, measured at `hitAt`. */
    reach: 2.8,
    /** Normalised time the stick is handed back, as the body stands back up. */
    recoverAt: 0.86,
    /**
     * How much faster than authored the clip is played.
     *
     * A touch quicker than authored, which puts the whole move at about 1.7
     * seconds and the commitment at 1.4 — long for an attack, and it should be:
     * this one crosses eight metres for it.
     */
    timeScale: 1.25,
    /** Seconds to fade the move over the gait, and back off it. */
    blendIn: 0.1,
    blendOut: 0.26,

    /**
     * m/s along the blow, and straight up.
     *
     * More along and less up than the standing slash: this comes across at hip
     * height with the body's own speed behind it, so what it lands on is taken
     * off its feet rather than lifted off them.
     */
    impulse: 5.8,
    lift: 4.2,
    /** Upper body multiplier — what is left of the torso goes over the cut. */
    spin: 2.1,
    /** Seconds the world nearly stops on contact, and how far down it goes. */
    hitStop: 0.11,
    hitStopScale: 0.05,
    /** Metres the lens is knocked. The heaviest of the three. */
    shake: 0.28,
    /** A sword, at the waist: the body it lands on comes apart. */
    slices: true
  },

  /* ------------------------------------------------------------------ */
  /* The flip kick                                                       */
  /* ------------------------------------------------------------------ */
  /**
   * `Q` — the disengage. The same machine again (`animation/Attack.js`), and
   * the only one of the four that *leaves*.
   *
   * The clip (`Flipkick.fbx`) runs 2.02 seconds at 60fps: a short run, a foot
   * planted high on a body, and a backflip off it. Read off the hips and the
   * right foot, with the hips frozen horizontally by `_retarget` as ever, so
   * every distance below is the foot's lead on the root rather than the ground
   * the export covers:
   *
   *  - **0 → 0.15** the run-up. The hips carry 1.2 m in the export's own units
   *    and the feet cycle twice; the ground is the warp's to supply.
   *  - **0.15 → 0.21** the leg comes through. The right foot swings from level
   *    with the hips to 0.58 m ahead of them and 0.8 m off the floor, furthest
   *    out at 0.20 — waist height on a body of the same size, which is `hitAt`.
   *  - **0.21 → 0.40** the push. The foot stops dead in space at that height
   *    while the hips climb past and over it: the body is standing on what it
   *    just kicked and using it to get off the ground. Nothing may move the
   *    root through these frames or the foot skates across the chest under it,
   *    which is what `passFrom` is for.
   *  - **0.40 → 0.72** the flip. Feet leave, the hips rise 1.1 m and the whole
   *    body turns over backwards once. The vertical is the clip's own and
   *    `_retarget` keeps it, so the arc costs nothing here.
   *  - **0.72** both feet down, hips back at standing height. Control returns
   *    here rather than at the end — the last quarter of the export sinks into
   *    a deep crouch nobody asked for, and `blendOut` covers the first of it.
   *
   * Its place among the other three is the negative `passThrough`: the kick
   * stops in front of a body, the slide cut goes through one, and this one
   * comes off one. That is what it is *for* — a way out of a crowd that costs
   * a body on the way, rather than a way further into it.
   */
  flipKick: {
    enabled: true,
    /**
     * Metres a target can be locked from.
     *
     * A short run rather than a slide: further than the standing kick reaches,
     * nothing like the ground the slide cut crosses.
     */
    range: 3.6,
    /** Full width of the search cone, degrees. */
    cone: 120,
    /**
     * Metres from the target's centre the foot is planted from.
     *
     * The shortest of the four, and it has to be: the contact is a leg folded
     * up at waist height, not one thrown straight out — 0.69 m of lead on the
     * root against the standing kick's 0.98. At this the foot lands a little
     * inside the body's own radius, which is where a push-off belongs.
     */
    standoff: 0.95,
    /**
     * Ceiling on the warp, metres.
     *
     * Read off the export's own run-up, which carries about 1.7 m in the
     * `warpAt` window — so at a typical engagement the body covers the ground
     * at the pace the legs are cycling at, and only a press taken at the very
     * edge of `range` overdrives it into a lunge.
     */
    maxWarp: 2.5,
    /**
     * Metres back off the mark the flip finishes — negative, and the whole
     * point of the move.
     *
     * `animation/Attack.js` reads the sign: forward is ground on the far side
     * of a body, backwards is a shove off one. The export nets out roughly
     * where it planted, because the animator had no body to push against; this
     * is the push it implies.
     */
    passThrough: -1.15,
    /**
     * Normalised time the recoil is allowed to start.
     *
     * The frame the foot leaves the chest. Before it the body is standing on
     * the target and the root is pinned to the mark; travelling any earlier
     * drags the planted foot sideways across what it is standing on.
     */
    passFrom: 0.4,
    /**
     * Normalised time the recoil finishes — the frame the feet touch down.
     *
     * The same number as `recoverAt`, so the body has stopped travelling on
     * the frame the player takes it over.
     */
    passAt: 0.74,
    /**
     * Fraction of the clip the approach takes.
     *
     * The frame the leg comes through, so the body is on its mark before the
     * foot is out. Short, because the run-up in the export is short — the
     * approach is the fastest of the four and it should be.
     */
    warpAt: 0.2,
    /** Fraction of *that* window the turn finishes in: face first, then close. */
    turnAt: 0.5,
    /** Normalised time the blow connects — the leg up and over, into the flip. */
    hitAt: 0.49,
    /** Metres the strike still lands at, measured at `hitAt`. */
    reach: 2.0,
    /** Normalised time the stick is handed back, as both feet touch down. */
    recoverAt: 0.74,
    /**
     * How much faster than authored the clip is played.
     *
     * Two seconds is a long time to hold a player still. At 1.2 the move is
     * 1.68 seconds end to end and the commitment 1.24, which puts it between
     * the kick and the slide cut.
     */
    timeScale: 1.2,
    /** Seconds to fade the move over the gait, and back off it. */
    blendIn: 0.08,
    blendOut: 0.2,

    /**
     * m/s along the blow, and straight up.
     *
     * The hardest shove of the four and the one that lifts least: this is a
     * whole body's weight driven through one heel and then pushed *away* from,
     * so what it lands on goes back rather than up. The two bodies leave the
     * contact in opposite directions, which is the read the move lives on.
     */
    impulse: 8.4,
    lift: 3.2,
    /** Upper body multiplier — high, so the body folds over the heel and goes. */
    spin: 1.9,
    /** Seconds the world nearly stops on contact, and how far down it goes. */
    hitStop: 0.09,
    hitStopScale: 0.05,
    /** Metres the lens is kicked. */
    shake: 0.22,
    /** A heel, and no blade anywhere near it — see `settings.slice`. */
    slices: false
  },

  /* ------------------------------------------------------------------ */
  /* The sword combo                                                     */
  /* ------------------------------------------------------------------ */
  /**
   * `Z` — three cuts, two of which are thrown.
   *
   * The same machine as every move above (`animation/Attack.js`), and the first
   * one to use two things that machine grew for it: `hits`, which states more
   * than one contact in a single clip, and `warpFrom`, which says the approach
   * begins somewhere other than the first frame. Read the kick's block first —
   * every field the two share means exactly what it means there.
   *
   * ## The shape of the move
   *
   * It is a **reach, reach, close**. The body locks a target up to eleven metres
   * off and stays where it is for the first two sweeps: each one throws a
   * crescent of light that crosses the ground on its own and opens on the chest
   * (`vfx/SlashWave.js`). Only then does the warp run — a hard dash onto the
   * mark between the second cut and the third — and the finisher lands in
   * person, with an edge on it.
   *
   * The first two beats deliberately do not kill (`wound` below): a combo whose
   * opening beat can finish the job has no third beat. They spend health and
   * stagger; the third takes the body apart (`slices`).
   *
   * ## The clip
   *
   * `SwordCombo.fbx` runs 3.63 seconds at its authored pace — by a distance the
   * longest thing on this rig — and the three `hits` below are read straight off
   * the sword hand's speed through it, sampled against the hips:
   *
   *  - **0 → 0.24** the wind-up, the blade carried back and low and then up over
   *    the shoulder. Nothing has happened yet.
   *  - **0.30** the first sweep: an overhead chop coming down a steep diagonal
   *    across the body's front, the hand furthest forward at 0.30 and fastest
   *    at 0.32.
   *  - **0.485** the second: a flat sweep across the front at chest height,
   *    right to left, and the fastest frame in the whole clip.
   *  - **0.715** the third: a high diagonal falling the other way from the
   *    first, so the pair cross. This is the one that cuts.
   *  - **0.75 → 1** the follow-through and the settle. Control comes back as the
   *    body straightens (`recoverAt`), not after it has stopped moving.
   *
   * At `timeScale` 1.6 the whole thing is 2.27 seconds and the commitment a
   * little under two — long, and meant to be. It is the most expensive thing the
   * body can choose to do, and the two seconds it costs are the price of a kill
   * from eleven metres away.
   */
  swordCombo: {
    enabled: true,
    /**
     * Metres a target can be locked from.
     *
     * The longest of any move, because the first two beats do not need the body
     * to be anywhere near what it is hitting — they are thrown. What the range
     * actually has to cover is the *dash*, which is why it and `maxWarp` are
     * nearly the same number.
     */
    range: 11.0,
    /** Full width of the search cone, degrees. Narrow: this is a committed line. */
    cone: 84,
    /** Metres from the target's centre the finisher is thrown from. */
    standoff: 1.7,
    /** Ceiling on the dash, metres. Everything `range` can lock, it can reach. */
    maxWarp: 10.0,
    /**
     * Where the approach begins and ends, in clip-normalised time.
     *
     * The gap between them is the dash, and it is deliberately short: the body
     * stands and throws for two thirds of the clip, then covers up to ten metres
     * in the fifth of it left before the finisher lands. Push `warpFrom` toward
     * `warpAt` and the dash becomes a blink; drop it to zero and the move
     * becomes an ordinary walk-in that happens to throw two cuts on the way.
     */
    warpFrom: 0.52,
    warpAt: 0.7,
    /**
     * Fraction of *that* window the turn finishes in — but measured against the
     * clip, not the dash (see `Attack#_advanceWarp`). At these the body is
     * square onto its target by phase 0.18, which is well before the first
     * crescent leaves: you face what you are about to throw at.
     */
    turnAt: 0.26,
    /**
     * Unused by this move, and here because every attack has one: `hits` below
     * is what actually names its contacts. Left at the finisher's time so
     * anything that reads `hitAt` generically gets a sensible answer.
     */
    hitAt: 0.715,
    /** Metres the *finisher* still lands at. The thrown beats state their own. */
    reach: 2.9,
    /** Normalised time the stick is handed back, as the body straightens. */
    recoverAt: 0.86,
    /** 3.63 seconds is far too long to hold a player still. At 1.6 it is 2.27. */
    timeScale: 1.6,
    /** Seconds to fade the move over the gait, and back off it. */
    blendIn: 0.1,
    blendOut: 0.3,

    /**
     * The three blows, in clip-normalised time.
     *
     * `at` is the only field `animation/Attack.js` reads; everything else on an
     * entry is carried straight through to `vfx/SwordCombo.js`, which is what
     * turns a beat into something on screen.
     *
     *  - `kind` — `'wave'` throws a crescent at the target, `'finish'` lands in
     *    person. It is the one field `core/App.js` branches on.
     *  - `reach` — how far this particular blow still connects at. The thrown
     *    beats state a reach as long as the lock range, because the body is
     *    still standing where it pressed the key; the finisher does not state
     *    one and falls back to the block's own `reach`, which is a sword's.
     *  - `roll` — degrees the crescent is turned about its line of flight. 90
     *    stands the arc up (a chop), **0 lays it flat**, which is a sweep going
     *    straight across the body it was thrown at. All three are 0: a cut that
     *    arrives tilted reads as having been aimed at nothing in particular,
     *    where a flat one visibly takes the target across the middle. Tilt one
     *    only if you want a chop, and tilt it deliberately.
     *  - `size` — the arc's radius in metres. The finisher's is the largest by
     *    half again: it is not travelling anywhere, so it can afford to be.
     *  - `speed` — metres a second, for the thrown ones. At 38 a cut crosses ten
     *    metres in a quarter of a second, which is long enough to be watched and
     *    short enough that the body is not left standing.
     *  - `spin` — degrees a second the crescent rolls as it flies. 0 on all
     *    three, and it has to be: a cut launched flat that rolls on the way
     *    over arrives at whatever angle the flight time happened to leave it
     *    at, which is the one thing that makes a thrown blade look aimless.
     */
    hits: [
      { at: 0.3, kind: 'wave', beat: 0, reach: 12, roll: 0, size: 1.5, speed: 38, spin: 0 },
      { at: 0.485, kind: 'wave', beat: 1, reach: 12, roll: 0, size: 1.75, speed: 44, spin: 0 },
      { at: 0.715, kind: 'finish', beat: 2, roll: 0, size: 1.9, strength: 1, spin: 0 }
    ],

    /**
     * What each *thrown* cut costs the body it lands on, in the units
     * `settings.gunplay.damage` is written in.
     *
     * Under a third of a body's health each, on purpose. Two of them leave it
     * standing and staggered with about a third left, which is the state the
     * finisher is supposed to arrive into. Raise it past a half and the combo
     * kills on its second beat and the third lands on a corpse.
     */
    wound: 30,
    /** Metres the lens is knocked by each thrown cut landing. */
    woundShake: 0.11,

    /**
     * m/s along the blow, and straight up, given to the body the finisher lands
     * on. The heaviest of any move: this is two seconds of commitment arriving
     * at once, and the corpse should leave the frame knowing it.
     */
    impulse: 5.4,
    lift: 6.0,
    /** Upper body multiplier — high, so what is left of the torso goes over. */
    spin: 2.2,
    /** Seconds the world nearly stops on the finisher, and how far down it goes. */
    hitStop: 0.14,
    hitStopScale: 0.04,
    /** Metres the lens is knocked. The heaviest thing a technique does. */
    shake: 0.36,
    /** The third beat comes across with the sword — see `settings.slice`. */
    slices: true,

    /**
     * The crescents — `vfx/SlashWave.js`.
     *
     * One swept sheet per cut, whose `v` runs from the tail to the leading edge,
     * so the arc and the veil dragging off it are the same surface. The three
     * numbers that decide whether it reads as a *cut* rather than as a glowing
     * ribbon are `razor` (where the hard white line sits along the edge — push
     * it to 0.99 for a scalpel, drop it to 0.8 for a smear), `converge` (how far
     * the inner edge bows in, which is what makes the silhouette a crescent) and
     * `tipTaper` (how pointed the ends are).
     */
    wave: {
      enabled: true,
      /** Metres above the target's feet a thrown cut is aimed. Chest height. */
      aimHeight: 1.05,
      /** Defaults for a beat that does not state its own. */
      size: 1.6,
      speed: 40,
      /** Seconds a cut may stay in the air before it expires, having missed. */
      life: 1.2,
      /** Seconds a cut hangs on the body after it lands. */
      hold: 0.22,
      /** Seconds the finisher's own parked arc hangs on the contact point. */
      finishLife: 0.55,
      /**
       * How hard a cut is allowed to steer toward a target that has moved, per
       * second. Low on purpose: this is a thrown blade, not a missile, and one
       * that tracks perfectly reads as one.
       */
      homing: 3.2,

      /** The hard line on the leading edge, the glow behind it, and the veil. */
      coreColor: '#ffffff',
      edgeColor: '#a8e9ff',
      bodyColor: '#2f7dff',
      tailColor: '#7c4dff',
      intensity: 2.0,
      /** Radians the arc subtends, tip to tip. */
      spread: 2.25,
      /** How far the inner edge bows in — the crescent's whole silhouette. */
      converge: 0.58,
      /** How far the tips cup out of the sheet's own plane, so it is not a flat card. */
      bow: 0.24,
      /** How far the veil is dragged back behind the edge, × the radius. */
      tail: 0.62,
      /** Exponent on the tips: low is a wide blade, high is a needle. */
      tipTaper: 0.55,
      /** Where along the sheet the white edge line sits, 0..1. */
      razor: 0.94,
      /** How hard the noise eats the veil. At 0 the trail is a solid sheet. */
      erode: 1.15,
      /** How much wider the arc opens over its flight — a cut spreads. */
      grow: 0.35
    },

    /**
     * The finisher's own shape — `vfx/RiftBurst.js`.
     *
     * Violet against the cuts' blue, and a sphere against their arcs, because
     * the third beat has to be legible as a different event from across the
     * field. It is **five layers**, and they are listed here in the order they
     * are drawn — back to front, which is also the order to switch them off in
     * when tuning. Each has its own `*Enabled` flag so it can be soloed against
     * the rest, and `vfx/RiftBurst.js` is where each one is explained:
     *
     *  1. `halo*`  — the air around it, lit. The only source of glow on this
     *     stage, which runs its bloom pass at hundredths.
     *  2. the shell — `radius`, `life`, `fresnel`, `churn*`. A sphere drawn on
     *     its rim.
     *  3. `mote*`  — the grain inside it, thrown outward. What gives the sphere
     *     an inside, and what lets the shell stay a thin rim.
     *  4. `ring*`  — the shockwave, on three planes, outrunning the shell.
     *  5. `shard*` — needles of light, out and gone before the shell has
     *     finished opening. The layer that makes it read as *breaking*.
     *
     * If only one number here is ever touched, make it `shardLength`: nothing
     * else changes the silhouette of the finisher as much.
     */
    rift: {
      enabled: true,

      /* ---- 1. the halo ---- */
      haloEnabled: true,
      /**
       * Metres the glow in the air reaches, and the seconds it hangs.
       *
       * Nearly three times the shell, and deliberately: this layer has no edge
       * of its own (it is two gaussians), so its radius is not a size on screen
       * but how far the falloff has to travel before it is gone. Anything
       * tighter reads as a second sphere behind the first.
       */
      haloRadius: 4.6,
      haloLife: 0.67,
      /** Blue where the burst is, violet out in the air around it. */
      haloColor: '#3f5bff',
      haloEdgeColor: '#a05cff',
      /** Low. It is under four brighter layers and it is not meant to be seen. */
      haloIntensity: 1.1,

      /* ---- 2. the shell ---- */
      /** Metres the shell opens to, and the seconds it takes. */
      radius: 2.2,
      life: 0.6,
      /** The rim, the little of the body behind it, and the flash inside. */
      coreColor: '#ffffff',
      rimColor: '#89b9ff',
      deepColor: '#3a2ce0',
      intensity: 1.45,
      /**
       * Exponent on the fresnel. High is a thin rim; low fills the sphere.
       *
       * Higher than it used to be, because the motes now do the filling: a
       * shell that is only a rim over a field of grain is a volume, and one
       * that is also filled in is a ball with grain painted on it.
       */
      fresnel: 3.6,
      /** How far the surface is displaced by noise, and how fast it crawls. */
      churn: 0,
      churnSpeed: 3.4,

      /* ---- 3. the core ---- */
      moteEnabled: true,
      /**
       * How many, how far they get and how long they last.
       *
       * The count is the one number here with a real cost, and it is a cheap
       * one: a mote is twelve floats written once and a closed form evaluated
       * per vertex, so the whole field is a memcpy a frame. Two hundred and
       * forty is dense enough to read as a volume at four metres and thin
       * enough to still read as *grain* rather than as fog.
       */
      moteCount: 221,
      moteReach: 2.65,
      moteLife: 0.6,
      /** Metres across one mote is, before its own random spread. */
      moteSize: 0.056,
      /**
       * How far a mote is smeared along its own screen velocity.
       *
       * The difference between a spray and a dot screen. At zero the field
       * strobes, because a mote crosses several pixels between two frames.
       */
      moteStretch: 0.032,
      /**
       * The fraction thrown clean through the shell, and how much further they
       * go. These are the ones that say the sphere failed to hold what was in
       * it — past about a quarter they stop being escapees and become the
       * field, and the shell loses its edge.
       */
      escape: 0.18,
      escapeReach: 2.25,
      moteColor: '#bcd8ff',
      moteIntensity: 1.55,

      /* ---- 4. the rings ---- */
      /** Metres the rings reach, and the seconds they take to get there. */
      ringRadius: 3.4,
      ringLife: 0.6,
      ringColor: '#c58cff',
      ringIntensity: 3.5,
      /** Thickness of a ring's band, as a fraction of its radius, and its feather. */
      ringWidth: 0.01,
      ringSoftness: 0.05,
      /** Radians a second a ring turns in its own plane. */
      ringSpin: 3.05,
      /** The radial comb through them, and how deep it cuts. */
      spokes: 25,
      spokeDepth: 0.25,

      /* ---- 5. the shards ---- */
      shardEnabled: true,
      /**
       * How many needles, how long the longest of them reach and how wide they
       * are at the root. Each shard takes its own length from a wide spread
       * around `shardLength` — a dozen needles all one length is a sun symbol,
       * and a dozen over six lengths is an explosion.
       */
      shardCount: 18,
      shardLength: 4.4,
      shardWidth: 0.05,
      /**
       * Seconds. Half the shell's, on purpose: the shards are the *event* and
       * the shell is what is left of it, and a needle still on screen when the
       * sphere has finished opening reads as decoration.
       */
      shardLife: 0.32,
      /** How far out along itself a shard starts, as a fraction of its length. */
      shardRoot: 0.06,
      /**
       * How far the needles are allowed out of the plane across the blow, 0..1
       * of a right angle. At 0 the burst is a flat starburst standing square to
       * the cut — dramatic, and wrong from every other camera. At 1 it is an
       * even hedgehog and the bearing of the blow is gone.
       */
      shardBias: 0.5,
      shardColor: '#a8ddff',
      shardIntensity: 3.6
    },

    /**
     * The flash and the shower — `vfx/BladeImpact.js`, reused unchanged.
     *
     * The three multipliers above it are what separate the three
     * moments: a small flash off the steel as a cut leaves, a full one where it
     * lands, and half as much again on the finisher.
     */
    launchFlash: 0.95,
    arriveFlash: 1.0,
    finishFlash: 1.15,
    impact: {
      enabled: true,
      /**
        * Seconds the flash lives, and metres across it opens.
        *
        * Small, and it has to be: on the finisher this sits inside the shell,
        * the rings and a parked crescent, all of them additive and all of them
        * centred on the same point. Anything larger stops being the hot core of
        * a hit and becomes a white disc with the rest of the move behind it.
        */
      life: 0.3,
      size: 0.8,
      color: '#dff2ff',
      ringColor: '#5fb4ff',
      sparkColor: '#bfe4ff',
      intensity: 2.3,
      /** Spikes in the star, and how far they reach — the bearing of the steel. */
      spikes: 7,
      spikeLength: 1.8,
      /**
       * Sparks thrown, how fast they leave and how wide the cone opens.
       *
       * Close to the blades' own numbers on purpose — a shower three times as
       * dense does not read as three times the hit, it reads as a firework. The
       * three `*Flash` multipliers are what make one of these bigger than
       * another, not the count.
       *
       * Off for now: on this move the shower was reading as noise over the
       * crescents and the burst, both of which already carry the hit. The rest
       * of the block is left tuned so putting the count back is one number.
       */
      sparks: 0,
      sparkSpeed: 8.2,
      sparkSpread: 0.52,
      sparkLife: 0.52,
      sparkSize: 0.038,
      /** How far a spark is smeared along its own screen velocity. */
      sparkStretch: 0.043,
      /** Air, and weight. */
      sparkDrag: 1.95,
      sparkGravity: -19
    },

    /**
     * The ground's answer under the finisher — `vfx/ShockRing.js`.
     *
     * Small and fast, as a sword's answer should be: the ring is barely wider
     * than the body it opens under and it is gone inside a second.
     */
    shock: {
      enabled: true,
      radius: 2.2,
      life: 0.62,
      color: '#a97cff',
      crackColor: '#6fd6ff',
      intensity: 0.75,
      width: 0.09,
      softness: 0.165,
      cracks: 22,
      crackLength: 1.31,
      crackWidth: 0.008,
      crackGlow: 2.9,
      lift: 0.017
    },

    /**
     * One light for the whole move — `vfx/SwordCombo.js`.
     *
     * It rides whichever crescent is in the air and jumps to each landing, and a
     * dimmer event never drags it off a brighter one. Never casts a shadow: a
     * shadow map re-rendered for a light that lives half a second costs more
     * than every mesh in the move put together.
     */
    light: {
      /** Peak, in three.js point-light units, and the metres it carries. */
      intensity: 60,
      range: 17.5,
      color: '#7cc4ff',
      /** Seconds a flash takes to decay. Squared on the way down. */
      decay: 0.34,
      /** Fractions of `intensity` for each of the three moments. */
      launch: 0.35,
      arrive: 0.8,
      finish: 1.0
    },

    /**
     * The dash itself, on the body — `vfx/ShadowDash.js`.
     *
     * The one beat of the move where the character *travels*, and the only
     * moment in the game where it covers ten metres in four tenths of a second.
     * Nothing on the body said so: the same lit skin that was standing still
     * arrived standing still somewhere else, and a body that is only ever
     * *between* two poses reads as a teleport with a smear on it.
     *
     * So it is not the same body. From a hair before the dash begins the skin
     * burns away into a shade of itself — one dark surface and a violet rim,
     * dressed below — and burns back out of it on the frame the feet land on
     * the mark. The finisher therefore lands on a
     * body that is still coming back, which is exactly where it should land —
     * the blow is what puts the character back in the world.
     *
     * ## The window
     *
     * Stated against the move's own approach rather than in absolute phases, so
     * tuning `warpFrom`/`warpAt` carries this with it and cannot leave a lit
     * body dashing or a shade standing around after it has arrived. `lead` is
     * how far *before* the approach the burn starts (it has to be finished by
     * the time the feet leave) and `linger` how far past the arrival the shade
     * is held before it comes back.
     *
     * ## The burn
     *
     * The same device as every other dissolve in the project, read in both
     * directions: a noise field crossed with height up the body, thresholded,
     * and a line of light riding the front. `rise` is the mix — 0 is static
     * eating the character, 1 is a clean wipe up it, and between them is the
     * thing that looks like a body coming apart into shadow. Going dark the
     * front travels up from the feet; coming back it recedes the same way it
     * came, which is what makes the two halves read as one exchange rather than
     * as two effects.
     */
    shadowDash: {
      enabled: true,
      /**
       * Clip-normalised time before `warpFrom` the burn starts, and after
       * `warpAt` the shade is held.
       *
       * The lead is roughly the length of `enter` at this move's pace, so the
       * body is fully shade on the frame it starts moving rather than halfway
       * through it. The linger is zero: "arrives" and "comes back" are meant to
       * be the same event.
       */
      lead: 0.05,
      linger: 0.0,
      /**
       * Seconds each direction takes, on the *simulation's* clock.
       *
       * Not the same number, and they should not be: going is a body leaving in
       * a hurry and coming back is a body being put together, so the return is
       * three times as long and runs straight through the finisher's hit-stop —
       * which slows it, and is most of why the third beat lands as hard as it
       * does.
       */
      enter: 0.09,
      exit: 0.3,
      /** Cycles of noise per metre. Higher is finer flakes. */
      detail: 9.0,
      /** How much of the threshold is height rather than noise, 0..1. */
      rise: 0.4,
      /** Cycles a second the noise field crawls up the body while it is out. */
      drift: 0.6,

      /**
       * The dark itself — the summons' own numbers, so the two read as the same
       * material.
       */
      color: '#04050b',
      roughness: 0.85,
      metalness: 0.0,

      /** The rim that keeps a black body from reading as a hole in the screen. */
      fresnel: {
        color: '#7a4dff',
        power: 2.4,
        emissive: 2.2
      },

      /**
       * How much of the world comes *through* the shade, by facing.
       *
       * The same fresnel term the rim is drawn with, spent twice: where the
       * surface turns away from the lens it is nearly solid (`rim`), and where
       * it faces the lens square it is mostly gone (`core`). That is what makes
       * the shade read as a body-shaped absence of a body rather than as a
       * black cut-out — the silhouette holds, the middle of the chest does not,
       * and the stage behind it stays visible the whole way across the dash.
       *
       * `power` is the exponent between the two, and it is the control that
       * matters: low and the whole body is glass, high and only the outline is
       * left. It is stated apart from `fresnel.power` on purpose — the rim's
       * light wants a tight edge and the veil wants a wide one.
       *
       * Whatever the numbers, the burning front stays solid: a line of light
       * you can see through has nothing to be the edge *of*.
       */
      veil: {
        core: 0.16,
        rim: 0.92,
        power: 1.6
      },

      /**
       * The line of light riding the front, in both directions.
       *
       * Brighter and wider than the summons' vanish, because this one has to be
       * read twice in half a second on a body that is crossing the screen.
       */
      edgeColor: '#8f5bff',
      edgeEmissive: 3.6,
      edgeWidth: 0.09
    }
  },

  /* ------------------------------------------------------------------ */
  /* The void runic beam                                                 */
  /* ------------------------------------------------------------------ */
  /**
   * The unmaking (`B`) — `animation/Attack.js` and `vfx/RunicBeam.js`.
   *
   * ## The move
   *
   * Mechanically it is the sword combo again: one press, one body locked, one
   * clip, and beats stated in `hits` that whoever wired `onHit` turns into
   * events. What is different is what those beats *are*. `CastFront.fbx`
   * throws two, and neither of them reaches anybody:
   *
   *  - the first sweeps the hands and strikes a rune into the ground under the
   *    mark and nothing else. It cannot hurt anyone and it is not meant to —
   *    it is the beat where both parties know what is coming and neither can
   *    stop it;
   *  - the second drives an arm out and brings a column of void up through the
   *    body standing on it.
   *
   * And it is the one attack that does not travel. Every other move here warps
   * onto a mark in front of what it is throwing at, because a fist or a blade
   * has to *be* somewhere to land; nothing in this one is thrown from the hand,
   * so the body stays exactly where the player pressed the key and only turns
   * to face the mark. That is `maxWarp: 0` below, and it is the whole
   * difference — the numbers the approach used are left stated but inert.
   *
   * That is the whole reason it is filed as an *ability* rather than a
   * technique (`config/abilities.js`): the other four attacks are things a body
   * does with its feet and a sword, and this is a body asking for something.
   *
   * ## What it costs the thing it lands on
   *
   * Nothing survives it — there is no `wound` here and no health arithmetic,
   * because the beam does not damage a body, it *unmakes* one. `unmake` below
   * is the fact about the blow that says so, exactly as `slices` is the fact
   * that says the slash comes across with an edge: a body taken by this skips
   * the five seconds of lying there that every other corpse gets and burns
   * away where it stood, in the beam's own colour rather than in embers.
   *
   * ## The look
   *
   * Five layers, one draw call each, in the order they are drawn — and every
   * one has an `enabled` of its own so it can be soloed against the other four.
   * `vfx/RunicBeam.js` is where each is explained:
   *
   *  1. `seal`   — the runes on the ground. `vfx/SummonSeal.js`, laid flat.
   *  2. `beam`   — the column itself, drawn on its axis rather than its rim.
   *  3. `spiral` — the cords wound round it, gold against its violet.
   *  4. `impact` — the burst at its foot. `vfx/BladeImpact.js`, reused.
   *  5. `grain`  — the void shards orbiting and rising through it.
   *
   * If only one number here is ever touched, make it `beam.corePower`: it is
   * how tightly the light gathers down the middle of the tube, and it is the
   * whole difference between a column and a pipe.
   */
  voidBeam: {
    enabled: true,
    /**
     * Metres a body can be locked from.
     *
     * The longest of any move, and the same distance the beats state as their
     * `reach`: nothing here has to cross the ground, so the only honest range
     * is how far the rune can be written — not how far a body could walk in
     * the length of a clip.
     */
    range: 12,
    /** Full width of the search cone, degrees. */
    cone: 92,
    /** Inert while `maxWarp` is zero: there is no mark to stand off from. */
    standoff: 2.1,
    /**
     * Ceiling on the approach, metres — and here it is *none*.
     *
     * Zero is the field doing its job rather than the field switched off:
     * `Attack#_resolveWarp` clamps the step to it, so the destination resolves
     * onto the spot the body already occupies and the warp still runs, still
     * turning to face the mark. The cast is thrown from where you stood.
     */
    maxWarp: 0,
    /**
     * Where the turn is measured against, in clip-normalised time.
     *
     * With no step left in the warp these two only frame the turn — see
     * `turnAt`. Kept stated so raising `maxWarp` in the editor gives the move
     * an approach again without needing anything else set.
     */
    warpFrom: 0,
    warpAt: 0.24,
    /**
     * Fraction of that window the turn finishes in — square on by phase 0.12,
     * which is well before the hands sweep the rune down at 0.21.
     */
    turnAt: 0.5,
    /** Unused: `hits` names the contacts. Left at the frame the beam opens. */
    hitAt: 0.48,
    /** Metres the *fallback* blow lands at. Both beats state their own. */
    reach: 3.2,
    /**
     * Normalised time the stick is handed back.
     *
     * The clip holds the arm out from 0.48 to about 0.70 and then stands the
     * body up out of the cast; this is a little past that, so the pose is held
     * for the whole of the column's own hold and the player gets the body back
     * as it straightens rather than while it is still pointing.
     */
    recoverAt: 0.78,
    /**
     * 4.27 seconds of clip — half again the length of anything else on the rig.
     *
     * At 1.75 it is 2.44, the two beats are 0.66 apart and the body is the
     * player's again after 1.9. Slower than that and the hold outstays the
     * `charge` timeout below; much faster and the cast reads as a jab.
     */
    timeScale: 1.75,
    /** Seconds to fade the move over the gait, and back off it. */
    blendIn: 0.12,
    blendOut: 0.32,

    /**
     * The two beats, in clip-normalised time — measured off the clip's own
     * hands, at the frame the sweep closes and the frame the cast lands.
     *
     *  - `kind` — `'rune'` opens the circle and does nothing else, `'unmake'`
     *    brings the column up and takes the body. It is the one field
     *    `core/App.js` branches on.
     *  - `reach` — how far this blow still connects at. Both are stated well
     *    past the lock range, because neither of them is a *reach* in any
     *    physical sense: the rune is written on the ground the body is standing
     *    on however far away that is, and the column comes up out of it.
     */
    hits: [
      { at: 0.21, kind: 'rune', beat: 0, reach: 12 },
      { at: 0.48, kind: 'unmake', beat: 1, reach: 12 }
    ],

    /**
     * m/s along the blow, and straight up, given to the body it takes.
     *
     * Almost nothing along, and a real lift: there is no direction in this. The
     * body is pulled off its feet into the column rather than thrown out of it,
     * and it burns away on the way up.
     */
    impulse: 0.4,
    lift: 2.6,
    /** Upper body multiplier — enough to fold it over as it goes. */
    spin: 1.5,
    /** Seconds the world nearly stops as the column opens, and how far down. */
    hitStop: 0.12,
    hitStopScale: 0.05,
    /** Metres the lens is knocked. */
    shake: 0.34,
    /** Nothing is cut here. The body is not parted, it is unmade. */
    slices: false,

    /**
     * How a body taken by this goes away — read by `combat/Enemy.js#die`.
     *
     * A fact about the *blow*, in the same way `slices` is: what killed it
     * decides how it leaves. Every other corpse on the stage lies there for
     * `settings.enemies.corpseTime` and then burns off in ember orange; one
     * taken by the beam gets almost none of that lying about and burns in the
     * beam's own violet, from the feet up, with a wide soft edge — because what
     * is eating it is not fire.
     *
     * Setting it to null would put this move's kills back on the ordinary path,
     * which is the useful thing to try if the burn is ever in question.
     */
    unmake: {
      /** Seconds the body lies there first. Almost none: it is already going. */
      corpseTime: 0.1,
      /** And the seconds it takes to go. Inside the column's own hold. */
      dissolveTime: 1.15,
      /** The burn line, its heat and how wide a band it is. */
      edgeColor: '#c9a0ff',
      edgeEmissive: 9.0,
      edgeWidth: 0.24,
      /**
       * How much of the burn is height rather than noise.
       *
       * Lower than the default: a clean line rising up a body is a body being
       * dipped in something, and this one is being eaten from everywhere at
       * once by something that happens to start at the floor.
       */
      dissolveRise: 0.12
    },

    /**
     * The choreography, in seconds — `vfx/RunicBeam.js`.
     *
     * `charge` is the only one that is not a pace: it is a *timeout*. The clip's
     * second beat normally fires the column somewhere in the middle of it, and
     * reaching the end means the cast lost whatever it was for — the body died
     * to something else in between — so the rune folds away rather than firing
     * at grass. Keep it comfortably longer than the gap between the two beats
     * (0.66 s at the pace above) or the circle will close before the cast
     * lands.
     */
    beats: {
      /** The circle writing itself, one full turn. */
      open: 0.3,
      /** Held open, gathering — and the fizzle timeout. See above. */
      charge: 1.1,
      /** The column coming up. Under a quarter second reads as an eruption. */
      strike: 0.22,
      /** Standing, while what is inside it burns away. */
      hold: 1.05,
      /** And pinched out. */
      close: 0.42,
      /** Seconds the ripple takes to leave the rune after something came up it. */
      ripple: 0.34
    },

    /** Metres above the ground the burst at the foot of the column is thrown. */
    impactHeight: 0.55,
    /** Master on that burst's size and counts. */
    strikeFlash: 1.3,

    /**
     * 1 · The runes — `vfx/SummonSeal.js`, laid flat on the ground.
     *
     * The same circle the light's own seal is drawn with, on its own numbers —
     * `lift` is the one field that is this block's alone.
     */
    seal: {
      /** Metres it stands off the floor, so it is not in the ground's z-fight. */
      lift: 0.05,
      /** Metres from the centre to the outer ring. Wider than a body. */
      radius: 1.75,
      /** The lines, and the hot centre the column comes up through. */
      color: '#8a4dff',
      coreColor: '#f0e2ff',
      intensity: 1.85,
      /** Turns a second of the outer band. The inner bands run against it. */
      spin: 0.09,
      /** Marks in the tick band, glyphs in the rune band, and long spokes. */
      ticks: 60,
      runes: 18,
      spokes: 8,
      /** Stroke weight and its feather, both in fractions of the radius. */
      width: 0.011,
      softness: 0.009,
      /** The soft light pooled inside the circle, and how mottled it is. */
      haze: 0.42,
      detail: 0.55,
      /** Depth and speed of the breath the whole thing sits on. */
      pulse: 0.22,
      pulseSpeed: 4.4
    },

    /**
     * 2 · The column.
     *
     * An open cylinder drawn on its *middle* rather than its rim. `corePower`
     * is the control: it is the exponent on how square a piece of the wall is
     * to the lens, so a high number gathers all the light down the axis (a
     * beam) and a low one spreads it over the whole tube (a pipe).
     */
    beam: {
      enabled: true,
      /** Metres tall, and metres across at the waist. */
      height: 7.2,
      radius: 0.3,
      /** How much wider the foot is than the waist — the skirt in the rune. */
      flare: 0.85,
      /** How much fatter it is on the frame it opens, easing back to its width. */
      swell: 0.35,
      /** Depth and speed of the breath it stands on while it holds. */
      breathe: 0.035,
      breatheSpeed: 8.5,
      /** The axis, the light either side of it, and the violet at the edges. */
      coreColor: '#ffffff',
      innerColor: '#c3bcff',
      edgeColor: '#8a3dff',
      intensity: 1.35,
      /** How tightly the light gathers on the axis, and how far the glow spreads. */
      corePower: 4.4,
      glowPower: 0.7,
      /** Features up the column, and around it. */
      grain: 3.2,
      swirl: 1.8,
      /** How fast the surface falls *down* through it, against the travel. */
      flow: 1.7,
      /** How hard that noise eats the light. At 0 the wall is a flat gradient. */
      erode: 0.5,
      /** Width of the hot band at the head, in fractions of the height. */
      headWidth: 0.06,
      /** How far up the rune's own light spills into the foot. */
      footGlow: 0.1,
      /** Where the top starts dissipating, 0..1 of the height. */
      crown: 0.6
    },

    /**
     * 3 · The cords wound round it.
     *
     * Each is a helix evaluated in the vertex shader and widened *across the
     * screen*, so it can never turn edge-on to the lens and blink. They
     * alternate handedness and colour around the column: two turning the same
     * way read as one thick cord, and two turning against each other read as
     * something being wound.
     */
    spiral: {
      enabled: true,
      /** How many. Even numbers pair the two colours; the ceiling is 6. */
      count: 4,
      /** Metres out from the axis at the foot, and how far up they run. */
      radius: 0.52,
      reach: 0.94,
      /** Turns each makes over that length. */
      turns: 2.3,
      /** Metres across one cord at the foot, and what is left of that at the top. */
      width: 0.055,
      taper: 0.4,
      /** Radians a second the whole winding turns. */
      spin: 1.9,
      /** How far they open out as they climb. */
      flare: 0.45,
      /** The white middle, and the two colours the cords alternate between. */
      coreColor: '#fff3d4',
      colorA: '#ffc257',
      colorB: '#c06bff',
      intensity: 2.4,
      /** How hard a cord falls off from its middle. High is a wire, low is a smear. */
      sharpness: 2.4,
      /** Waves of brightness running up each cord. */
      pulse: 15
    },

    /**
     * 4 · The burst at its foot — `vfx/BladeImpact.js`, reused unchanged.
     *
     * Every field means what it means on `settings.swordCombo.impact`; this is
     * a second set of numbers for the same system, violet rather than blue and
     * thrown straight up. The sparks are on here, unlike the combo's: there is
     * no crescent over the top of them to compete with.
     */
    impact: {
      enabled: true,
      life: 0.38,
      size: 1.15,
      color: '#efe1ff',
      ringColor: '#9d5cff',
      sparkColor: '#cfa8ff',
      intensity: 2.4,
      /** Spikes in the star, and how far they reach. */
      spikes: 8,
      spikeLength: 2.1,
      /** Thrown up and out, and heavy enough to come back down inside the beam. */
      sparks: 34,
      sparkSpeed: 7.4,
      sparkSpread: 0.72,
      sparkLife: 0.75,
      sparkSize: 0.042,
      sparkStretch: 0.05,
      sparkDrag: 1.7,
      sparkGravity: -14
    },

    /**
     * 5 · The void grain.
     *
     * Four-pointed shards orbiting the column and rising through it. Each runs
     * its own loop off one shared clock, so the pool is written once at the
     * strike and read as a closed form for the rest of the cast — `count` is
     * therefore very nearly free, and the only real reason to keep it modest is
     * that a column packed with grain stops being a column.
     */
    grain: {
      enabled: true,
      /** How many. The ceiling is 320. */
      count: 240,
      /** Metres out they start, and how much further they get by the top. */
      radius: 0.85,
      spread: 0.6,
      /** Metres they climb, and radians a second they turn while climbing. */
      rise: 6.2,
      swirl: 2.6,
      /** Metres across one shard, and the seconds one loop takes. */
      size: 0.075,
      life: 1.5,
      /** How long the needles of the star are. High is a sparkle, low is a blob. */
      spike: 6.0,
      /** The body of a shard, and the white where its needles cross. */
      color: '#7a45ff',
      coreColor: '#e8d8ff',
      intensity: 2.2
    },

    /**
     * One light for the whole cast — hung partway *up* the column.
     *
     * Not at its foot: a seven-metre column lit from the ground puts every
     * shadow on the stage in the wrong place, and what a viewer thinks is
     * glowing is the middle of it.
     */
    light: {
      /**
       * Peak, in three.js point-light units, and the metres it carries.
       *
       * What actually reaches the lamp is `(hold + gather + flash²)` of this,
       * so the number below is not the brightest it gets — the frame the column
       * opens is a little over one and a half times it, and what it settles to
       * while the beam stands is `hold`'s share of it.
       */
      intensity: 42,
      range: 14,
      color: '#a06bff',
      /** Seconds the strike's own flash takes to decay. Squared on the way down. */
      decay: 0.4,
      /** How far up the column it hangs, as a fraction of the height reached. */
      height: 0.42,
      /** What the column is worth at rest, and what the rune is worth gathering. */
      hold: 0.45,
      gather: 0.18
    }
  },

  /* ------------------------------------------------------------------ */
  /* The crimson rite                                                    */
  /* ------------------------------------------------------------------ */
  /**
   * The Crimson Rite (`V`) — `animation/Attack.js` and `vfx/CrimsonRite.js`.
   *
   * ## The move
   *
   * Mechanically it is the unmaking again: one press, one body locked, one
   * cast clip, and two beats stated in `hits`. What is different is what
   * happens *after* the second beat, and it is the only move in the project
   * that does anything after its clip has finished.
   *
   *  - the first beat marks the body — the ground goes dark, ink stands up out
   *    of it, and three katanas resolve out of that ink pointed inward. Nothing
   *    is hurt and nothing is committed;
   *  - the second beat lets them go. From there the clip has no further say:
   *    `vfx/CrimsonRite.js` runs the three thrusts on a clock of its own, each
   *    landing when its point actually arrives, and the tear-out that follows
   *    them is a fourth impact with no frame in any animation behind it.
   *
   * That is the whole reason the timing lives in `beats` below rather than in
   * `hits`. A clip can mark two frames; this move has four impacts.
   *
   * Like the unmaking it does not travel — `maxWarp: 0`, the body stays where
   * the player pressed the key and only turns to face the mark. Nothing here is
   * thrown from the hand, so there is nowhere to close to.
   *
   * ## What it costs the thing it lands on
   *
   * The three thrusts *wound* and are tuned so that three of them cannot take a
   * body to zero — see `wound`. The rite has to keep its own victim alive for
   * its own finish, exactly as the sword combo's opening cuts do. The tear-out
   * then kills outright, and `unmake` below says how the body leaves: it is not
   * a corpse to be dropped and burned in ember orange five seconds later, it is
   * a body three blades came out of, and it goes where it stands.
   *
   * ## The look
   *
   * Six layers, and the reference is a five-panel breakdown of exactly this
   * kind of effect. Each has an `enabled` of its own so it can be soloed
   * against the other five; `vfx/CrimsonRite.js` explains what each is doing:
   *
   *  1. `trails`  — the strokes. `vfx/SlashTrails.js`, in two gestures.
   *  2. `mist`    — blood, atomised and flung. `vfx/BloodMist.js`.
   *  3. `rings`   — the floor. `vfx/RiteRings.js`.
   *  4. `aura`    — the ink. `vfx/InkAura.js`.
   *  5. `cinders` — the sparks. `vfx/CinderStreaks.js`.
   *  6. `blades`  — the katanas. `vfx/PhantomBlades.js`.
   *
   * If only one number here is ever touched, make it `trails.tear`: it is how
   * hard a stroke comes apart as it dies, and it is the whole difference
   * between a cut and a glowing ribbon fading out.
   */
  crimsonRite: {
    enabled: true,
    /**
     * Metres a body can be locked from.
     *
     * The same distance the beats state as their `reach`, and for the same
     * reason the unmaking's are: nothing here crosses the ground, so the only
     * honest range is how far the mark can be struck.
     */
    range: 11,
    /** Full width of the search cone, degrees. */
    cone: 96,
    /** Inert while `maxWarp` is zero: there is no mark to stand off from. */
    standoff: 2.2,
    /**
     * Ceiling on the approach, metres — and here it is *none*.
     *
     * Zero is the field doing its job rather than the field switched off:
     * `Attack#_resolveWarp` clamps the step to it, so the destination resolves
     * onto the spot the body already occupies and the warp still runs, still
     * turning to face the mark. The rite is worked from where you stood.
     */
    maxWarp: 0,
    /** Inert with no step in the warp, but stated so raising it works. */
    warpFrom: 0,
    warpAt: 0.24,
    /** Square on well before the hands come down at 0.21. */
    turnAt: 0.5,
    /** Unused: `hits` names the contacts. Left at the frame the rite is let go. */
    hitAt: 0.46,
    /** Metres the *fallback* blow lands at. Both beats state their own. */
    reach: 3.2,
    /**
     * Normalised time the stick is handed back.
     *
     * Earlier than the unmaking's, and deliberately: the player should get the
     * body back while the blades are still working. The rite does not need the
     * caster after it has been let go, and a character rooted for the whole of
     * something they are only watching is the commonest way an ability of this
     * length stops being fun.
     */
    recoverAt: 0.66,
    /** 4.27 s of clip at 1.85 is 2.31, and the two beats fall 0.62 apart. */
    timeScale: 1.85,
    /** Seconds to fade the move over the gait, and back off it. */
    blendIn: 0.12,
    blendOut: 0.3,

    /**
     * The two beats the *clip* is responsible for, in clip-normalised time.
     *
     * Measured off the same hands the unmaking's are, because it is the same
     * export: the frame the sweep closes, and the frame the arm drives out.
     *
     *  - `mark` strikes the ground and calls the blades up. It cannot hurt
     *    anyone and it is not meant to.
     *  - `rite` lets them go, and is the last thing the animation decides.
     *
     * `kind` is the one field `core/App.js` branches on.
     */
    hits: [
      { at: 0.21, kind: 'mark', beat: 0, reach: 11 },
      { at: 0.46, kind: 'rite', beat: 1, reach: 11 }
    ],

    /** Metres up the body the ring of blades is centred — chest height. */
    height: 1.05,
    /** How many thrusts. Three, which is the move. */
    stabs: 3,

    /**
     * What one thrust costs.
     *
     * Three of these must not reach the health an enemy stands up with
     * (`settings.gunplay.damage.health`, which is 100), or the rite kills its
     * own victim before it can finish it — the same tuning the sword combo's
     * `wound` needs, and for the same reason. Three at 28 leave a body on 16,
     * which is a margin thin enough that the thrusts feel like they are doing
     * something and wide enough that the tear-out always gets its turn.
     *
     * If one *does* finish a body that something else had worn down first, it
     * falls by the ordinary path with this move's force and the rite tears out
     * into the corpse — which reads perfectly well, and is far better than a
     * rite that stalls.
     */
    wound: 28,

    /**
     * m/s along the blow, and straight up, given to the body it takes.
     *
     * Almost nothing along, and a real lift: three blades leaving in three
     * directions have no net bearing between them. The body is pulled off its
     * feet and burns away on the way up rather than being thrown anywhere.
     */
    impulse: 0.5,
    lift: 2.4,
    /** Upper body multiplier — enough to fold it over as it goes. */
    spin: 1.6,
    /** Seconds the world nearly stops as the blades come out, and how far down. */
    hitStop: 0.13,
    hitStopScale: 0.05,
    /** Metres the lens is knocked by the tear-out — the attack's own shake. */
    shake: 0.34,
    /** And by each thrust. Much smaller: there are three of them. */
    stabShake: 0.12,
    /** The tear-out's, thrown from the rite rather than from the attack. */
    rendShake: 0.4,
    /** Nothing is cut here. The body is not parted, it is taken. */
    slices: false,

    /**
     * How a body taken by this goes away — read by `combat/Enemy.js#die`.
     *
     * A fact about the *blow*, exactly as `slices` is: what killed it decides
     * how it leaves. Every ordinary corpse lies there for
     * `settings.enemies.corpseTime` and burns off in ember orange. One taken by
     * the rite gets almost none of that lying about and burns crimson, from
     * everywhere at once — `dissolveRise` is low because what is eating it is
     * not fire climbing up it, it is three wounds opening at the same time.
     *
     * Setting it to null puts this move's kills back on the ordinary path,
     * which is the useful thing to try if the burn is ever in question.
     */
    unmake: {
      /** Seconds the body lies there first. Almost none: it is already going. */
      corpseTime: 0.12,
      /** And the seconds it takes to go, inside the rite's own settle. */
      dissolveTime: 1.25,
      /** The burn line, its heat and how wide a band it is. */
      edgeColor: '#ff3a24',
      edgeEmissive: 11.0,
      edgeWidth: 0.2,
      /** Eaten from everywhere at once rather than dipped in something. */
      dissolveRise: 0.14
    },

    /**
     * The choreography, in seconds — `vfx/CrimsonRite.js`.
     *
     * These are the move, far more than `hits` is: everything after the cast is
     * paced here.
     *
     * `charge` is the only one that is not a pace, it is a **timeout**. The
     * clip's second beat normally lets the blades go somewhere in the middle of
     * it, and reaching the end means the rite lost what it was for — the body
     * died to something else in between — so the ink sinks rather than three
     * katanas stabbing grass. Keep it comfortably longer than the gap between
     * the two beats (0.62 s at the pace above).
     */
    beats: {
      /** The ink welling up and the blades resolving in it. */
      mark: 0.42,
      /** Held, gathering — and the fizzle timeout. See above. */
      charge: 1.2,
      /**
       * Seconds between one thrust being *ordered* and the next.
       *
       * Not between landings: a thrust takes `blades.beats.thrust` to arrive,
       * so the rhythm on screen is this plus that. At 0.19 and 0.13 the three
       * points land about a fifth of a second apart, which is fast enough to
       * read as one burst and slow enough to count.
       */
      between: 0.19,
      /**
       * How long the body is held on the points before they come out.
       *
       * The pause before the tear, and it is doing real work: without it the
       * third thrust and the finish are one event and the move has three beats
       * instead of four.
       */
      hold: 0.26,
      /** The tear-out itself. */
      rend: 0.55,
      /** And the ink sinking back into the ground it came out of. */
      settle: 0.85,
      /**
       * Seconds after which the rite tears out with whatever landed.
       *
       * A safety valve, not a pace. Everything between the cast and the finish
       * depends on points *arriving*, and one that never does would leave the
       * rite holding a body and its own key forever — so rather than trying to
       * enumerate the ways that could happen, it gives up waiting. The normal
       * path never reaches this: three thrusts ordered 0.19 apart, each taking
       * 0.13 to land, are all in well inside a second. Raise it if `stabs` is
       * ever set far above `blades.count`, since the thrusts then have to queue
       * for a blade to come free.
       */
      abandon: 2.6
    },

    /** Master on the ring struck by each beat — the mark, a thrust, the tear. */
    markRing: 0.55,
    stabRing: 0.8,
    rendRing: 1.15,
    /** And on the cloud each of them throws. */
    stabMist: 1.0,
    rendMist: 2.1,

    /**
     * 1 · The strokes — `vfx/SlashTrails.js`.
     *
     * This block is what a stroke is *made of*, and it is shared by both
     * gestures below so the move cannot come apart into two looks. `razor` and
     * `tear` are the two that matter: the first is where the white line sits
     * across the stroke, the second is how hard it shatters as it dies.
     */
    trails: {
      enabled: true,
      /** The white heat, the body of it, and the dark it fades into. */
      coreColor: '#ffe3d8',
      color: '#ff1f2d',
      edgeColor: '#4a0308',
      intensity: 1.3,
      /**
       * Where the white line sits across the stroke, 0 at the trailing edge and
       * 1 at the leading one, and how wide it is.
       *
       * Deliberately not 1. A razor exactly on the leading edge reads as a
       * glowing band with a lit border; a little inside it leaves a thin skin
       * of crimson *ahead* of the white, and that skin is what the eye reads as
       * an edge rather than as a tube.
       */
      razor: 0.84,
      razorWidth: 0.055,
      core: 0.45,
      /** How hard the body falls away from the razor toward the tail. */
      falloff: 1.0,
      /** How pointed the ends are. Higher is a finer needle. */
      tip: 0.55,
      /** Fraction of its life the stroke is still being swept over. */
      draw: 0.16,
      headSoft: 0.09,
      /** The bloom riding the front while it is being swept. */
      headFlare: 1.1,
      /** The tearing: how fine the pieces are, how fast they crawl, how much. */
      detail: 3.6,
      flow: 1.3,
      tear: 0.85,
      /** Filament splitting along the stroke — the hairs in the reference. */
      hair: 26.0,
      hairDepth: 0.45
    },

    /**
     * The thrust's gesture: long, shallow, barely curved.
     *
     * A big radius with a small sweep is a piece of a very large circle, which
     * is a nearly straight streak — which is what a thrust leaves. Everything
     * about how it *looks* is `trails` above; these five numbers are all that
     * separates it from the tear-out.
     */
    stabArc: {
      count: 2,
      /** Radians the fan is opened by, about the thrust's own line. */
      spread: 0.5,
      radius: 2.6,
      sweep: 0.55,
      width: 0.34,
      life: 0.32,
      /** Metres the arc is sheared forward, so it is not a flat hoop. */
      pitch: 0.35,
      strength: 0.8
    },

    /**
     * The tear-out's: tight, wide and violent.
     *
     * A small radius with a large sweep is most of a circle — the crescents the
     * reference's first panel is full of. Same look, opposite gesture, and that
     * contrast is the cheapest way to make a finisher feel like a different
     * kind of thing from the blows that set it up.
     */
    rendArc: {
      count: 3,
      spread: 0.85,
      radius: 1.15,
      sweep: 2.5,
      width: 0.5,
      life: 0.55,
      pitch: 0.8,
      strength: 1.1
    },

    /**
     * 2 · The mist — `vfx/BloodMist.js`.
     *
     * Two kinds out of one system: `puffs` are the cloud, `drops` are what is
     * flung out of it. The cloud is the only opaque thing in the whole ability
     * and therefore the only source of weight in it — if the move ever feels
     * like a light show, this is the block to raise.
     */
    mist: {
      enabled: true,
      /** The dark heart of it, the body, and the hot grains caught inside. */
      deepColor: '#12000d',
      color: '#6e0512',
      hotColor: '#ff4326',
      intensity: 1.0,
      /** Shared: drag on everything, and the fall the drops actually feel. */
      drag: 2.4,
      gravity: -6.5,
      /** The cloud: how many, how fast, how long, how big, how see-through. */
      puffs: 26,
      puffSpeed: 1.5,
      puffRise: 0.55,
      puffLife: 1.05,
      size: 0.5,
      grow: 2.3,
      opacity: 0.72,
      /** Metres back down the blade the cloud is born — a wound is behind a tip. */
      setback: 0.28,
      /** How ragged a puff's outline is, how fine, and how fast it churns. */
      erode: 0.62,
      detail: 2.6,
      churn: 0.5,
      /** The drops: how many, how fast, how long, how wide a cone. */
      drops: 40,
      dropSpeed: 6.5,
      dropLife: 0.85,
      spray: 0.8,
      splatSize: 0.055,
      /** How much of a drop's length comes from its own speed. */
      splatStretch: 2.6,
      /** How much heat is caught in the blood. Past about 1 it stops being wet. */
      hot: 0.55
    },

    /**
     * 3 · The floor — `vfx/RiteRings.js`.
     *
     * `rings` is the count in the train and `ringGap` is how far apart they are
     * launched. Four at 0.11 is the reference's picture: several fronts at
     * several radii on screen at once, which says *this is still happening*
     * where a single ring only says something landed.
     */
    rings: {
      enabled: true,
      color: '#ff2a20',
      coreColor: '#ffd8c8',
      crackColor: '#ff5a1e',
      scorchColor: '#0a0305',
      intensity: 0.9,
      /** Metres the outermost front reaches, and how long the disc lives. */
      radius: 3.8,
      life: 1.5,
      /** The train: how many fronts, how far apart, and how much each loses. */
      rings: 4,
      ringGap: 0.11,
      ringReach: 0.88,
      /** Stroke weight of a front and its feather, in fractions of the radius. */
      width: 0.018,
      softness: 0.022,
      /** The cracks: how many, how long, how wide, how hot. */
      cracks: 14,
      crackLength: 0.8,
      crackWidth: 0.012,
      crackGlow: 1.6,
      /** The burn: how dark, how far out, and how much of the life it fades over. */
      scorch: 0.85,
      scorchRadius: 0.85,
      scorchFade: 0.35,
      /** Metres it stands off the floor, out of the ground's z-fight. */
      lift: 0.035
    },

    /**
     * 4 · The ink — `vfx/InkAura.js`.
     *
     * The only layer that subtracts. `threshold` is the control: it is where
     * the ink is cut out of its noise field, so a low number is a fog bank and
     * a high one is a few thin ribbons. Everything between is the aura.
     */
    aura: {
      enabled: true,
      /** Near-black, and the heat caught in the edges of it. */
      inkColor: '#050205',
      rimColor: '#8e0a14',
      opacity: 0.7,
      rim: 0.5,
      /** Metres out the shell stands, and metres up it reaches. */
      radius: 1.7,
      height: 2.8,
      /** Feature size, how fast the threads climb, and how hard they hook. */
      scale: 1.5,
      rise: 0.42,
      warp: 0.75,
      /** Where the ink is cut out of the field, and how sharp that cut is. */
      threshold: 0.58,
      sharpness: 0.2,
      /** The lean at the top, its beat, and how fast the whole shell turns. */
      curl: 0.4,
      curlSpeed: 0.8,
      swirl: 0.35
    },

    /**
     * 5 · The cinders — `vfx/CinderStreaks.js`.
     *
     * `stretch` is the one that decides the whole character of the field: a
     * cinder is drawn along the direction it is actually travelling, by an
     * amount proportional to how fast it is going *now*, so one number gives
     * the reference's mixture of long streaks and near-points.
     */
    cinders: {
      enabled: true,
      color: '#ff2f14',
      coreColor: '#ffd6b4',
      intensity: 1.5,
      /** Shared: how fast they are thrown, how long they last, how they slow. */
      speed: 7.0,
      life: 0.9,
      drag: 1.5,
      gravity: -2.2,
      /** The lift under an ember — these should not simply rain. */
      rise: 1.1,
      /** How big a cinder is before its speed stretches it, and by how much. */
      size: 0.016,
      stretch: 2.3,
      maxStretch: 9.0,
      /** The light around one, and the flicker each is on. */
      halo: 0.5,
      flicker: 0.4,
      flickerSpeed: 22.0,
      /** Shed off the steel by one thrust, in a cone about its line. */
      stabCount: 24,
      stabStrength: 1.0,
      spread: 0.7,
      /** Thrown in every direction by the tear-out. */
      rendCount: 90,
      rendStrength: 1.5,
      rendRadius: 0.6,
      /** And the slow drift out of the aura, for as long as there is one. */
      drift: 26,
      driftHeight: 0.2,
      driftSpread: 0.9,
      driftStrength: 0.32
    },

    /**
     * 6 · The katanas — `vfx/PhantomBlades.js`.
     *
     * The character's own weapon, borrowed off the equipment library rather
     * than modelled here. `length` is the only number that changes the mesh: it
     * is what the piece is scaled to, end to end, and moving it rebuilds the
     * blades.
     */
    blades: {
      enabled: true,
      /** How many come. Three, one per thrust. Six is the ceiling. */
      count: 3,
      /** Metres a summoned blade is, point to pommel. */
      length: 1.45,
      /**
       * Which end of the measured piece is the point.
       *
       * The blade is found by taking the longest axis of its bounding box,
       * which cannot say which *end* of that axis is the tip. The katana runs
       * away from the guard down +Z, so the far end is; this is here for the
       * day an export disagrees.
       */
      flip: false,
      /** Metres out the ring of them hangs, and metres in they finish. */
      standoff: 2.1,
      bite: 0.22,
      /** Metres apart in height, so three points are not a level diagram. */
      spreadHeight: 0.42,
      /** Seconds between one blade resolving out of the ink and the next. */
      stagger: 0.09,
      /** Metres further out a blade starts before it drifts to its mark. */
      gatherDrift: 0.55,
      /** Depth and beat of the hover while it waits. */
      hover: 0.05,
      hoverSpeed: 2.6,
      /** Radians a second it turns about its own line, ± this. */
      spin: 1.2,
      /** The ring in the steel once it is in: how far, how fast, how it dies. */
      quiver: 0.035,
      quiverSpeed: 46.0,
      quiverDecay: 9.0,
      /** The tear-out: metres out the far side, how high, how curved. */
      throughDistance: 3.2,
      throughLift: 1.5,
      throughArc: 0.7,
      /** Radians it rolls about its own line on the way out. */
      throughRoll: 3.2,
      /** m/s a banished blade drifts up as it burns off. */
      fadeRise: 0.7,

      /** Seconds each state of one blade takes — see `vfx/PhantomBlades.js`. */
      beats: {
        /** Resolving out of the ink, point first. */
        gather: 0.3,
        /**
         * The thrust.
         *
         * Under about a tenth of a second and the blade teleports; much over a
         * fifth and it is being pushed rather than driven.
         */
        thrust: 0.13,
        /** Coming out the far side. */
        wrench: 0.45,
        /** And burning off, for one that never got used. */
        fade: 0.4
      },

      /** The steel: near-black, the sheen on it, and the crimson round it. */
      bodyColor: '#0b0709',
      sheenColor: '#b04a4a',
      rimColor: '#ff2436',
      rim: 2.4,
      rimPower: 2.6,
      /** The burn that puts it there and takes it away. */
      edgeColor: '#ff7038',
      edgeEmissive: 8.0,
      edgeWidth: 0.14,
      /**
       * Features per metre in the burn's mask.
       *
       * High, and it has to be: a blade is three centimetres across, so
       * anything under about twenty features per metre puts less than a blob
       * across its width and the mask reads as the blade being cut in half
       * rather than as it coming apart. The same problem `settings.weapons.detail`
       * solves, at the same kind of number.
       */
      detail: 34.0,
      /**
       * How much of the burn runs along the piece rather than being pure static.
       *
       * 1 is a clean line travelling from the point to the pommel; 0 is noise
       * eating it from everywhere at once. High here, because a summoned blade
       * should arrive *point first* — that is what makes it read as being drawn
       * out of the dark rather than switched on.
       */
      burnRise: 0.62,
      /** The energy crawling up the steel, and how fast. */
      veins: 0.55,
      veinFlow: 1.6
    },

    /**
     * The one light the whole rite shares.
     *
     * Three strengths, one per kind of event, and the brightest wins — a stray
     * thrust must not drag the glow back off a tear-out that is still burning.
     */
    light: {
      color: '#ff3020',
      intensity: 13.0,
      range: 14.0,
      /** Seconds a flash takes to fall away. */
      decay: 0.34,
      /** What each event is worth, as a fraction of the intensity above. */
      mark: 0.35,
      stab: 0.8,
      rend: 1.0
    }
  },

  /* ------------------------------------------------------------------ */
  /* The shadow execution                                                */
  /* ------------------------------------------------------------------ */
  /**
   * Five katanas, one body — `vfx/ShadowExecution.js`.
   *
   * The other multi-blade finisher, and deliberately the opposite of the rite
   * in every beat that matters. The rite presents three blades and puts them in
   * one at a time; this one calls five up, **turns them round the body** while
   * the ring winds up and closes, and then puts all five in on the same frame.
   * The rite throws blood. This throws pieces of something breaking, and what
   * it leaves does not fall over — it comes apart.
   *
   * The whole first half of the move is `beats.circle` and the two numbers
   * under `blades` that drive it (`windSpin`, `tighten`). If the ability ever
   * feels like a light show rather than a threat, those three are the block to
   * open first.
   */
  shadowExecution: {
    enabled: true,

    /**
     * Metres a body can be locked from.
     *
     * The same distance the beats state as their `reach`, and for the same
     * reason the rite's are: nothing here crosses the ground, so the only
     * honest range is how far the mark can be struck.
     */
    range: 11,
    /** Full width of the search cone, degrees. */
    cone: 96,
    /** Inert while `maxWarp` is zero: there is no mark to stand off from. */
    standoff: 2.4,
    /**
     * Ceiling on the approach, metres — and here it is *none*, exactly as the
     * rite's is. `Attack#_resolveWarp` clamps the step to it, so the warp still
     * runs and still turns the body to face the mark; the execution is worked
     * from where you stood.
     */
    maxWarp: 0,
    warpFrom: 0,
    warpAt: 0.24,
    /** Square on well before the hands come down at 0.21. */
    turnAt: 0.5,
    /** Unused: `hits` names the contacts. Left at the frame the cast is let go. */
    hitAt: 0.46,
    /** Metres the *fallback* blow lands at. Both beats state their own. */
    reach: 3.2,
    /**
     * Normalised time the stick is handed back.
     *
     * Earlier even than the rite's. This move runs for the better part of three
     * seconds after the clip has finished and the caster is not needed for any
     * of it — a character rooted for the whole of something they are only
     * watching is the commonest way an ability of this length stops being fun.
     */
    recoverAt: 0.62,
    /** The same cast the rite and the unmaking use, at the same pace. */
    timeScale: 1.85,
    blendIn: 0.12,
    blendOut: 0.3,

    /**
     * The two beats the *clip* is responsible for, in clip-normalised time.
     *
     * Measured off the same hands the rite's are, because it is the same
     * export: the frame the sweep closes, and the frame the arm drives out.
     *
     *  - `sever-mark` claims the ground and calls the five up. It cannot hurt
     *    anybody and it is not meant to.
     *  - `sever-cast` sets the ring turning in earnest, and is the last thing
     *    the animation decides about this move.
     */
    hits: [
      { at: 0.21, kind: 'sever-mark', beat: 0, reach: 11 },
      { at: 0.46, kind: 'sever-cast', beat: 1, reach: 11 }
    ],

    /** Metres up the body the ring of blades turns — chest height. */
    height: 1.25,

    /**
     * What five points arriving at once costs.
     *
     * One number rather than one per blade, because it is one event: five
     * thrusts landing on one frame are not five blows. It must not reach the
     * health an enemy stands up with (`settings.gunplay.damage.health`, 100) or
     * the move kills its own victim before it can finish it — the same tuning
     * the rite's `wound` needs. 74 leaves a body on 26, thin enough that the
     * impact reads as very nearly fatal and wide enough that the tear-out
     * always gets its turn.
     */
    wound: 74,

    /**
     * m/s along the blow and straight up, given to the body it takes.
     *
     * Almost nothing along and a real lift: five blades leaving on five
     * bearings have no net direction between them. The body is pulled off its
     * feet and comes apart on the way up rather than being thrown anywhere.
     */
    impulse: 0.4,
    lift: 3.0,
    /** Upper body multiplier — enough to fold it over as it goes. */
    spin: 1.8,
    /** Seconds the world nearly stops as the blades come out, and how far down. */
    hitStop: 0.16,
    hitStopScale: 0.04,
    /** Metres the lens is knocked by the tear-out — the attack's own shake. */
    shake: 0.42,
    /** And by the impact, which is thrown from the ability's own clock. */
    impaleShake: 0.34,
    /** The tear-out's, likewise. */
    severShake: 0.52,
    /** Nothing is cut here. The body is not parted, it is unmade. */
    slices: false,

    /**
     * How a body taken by this goes away — read by `combat/Enemy.js#die`.
     *
     * A fact about the *blow*, exactly as `slices` is. The rite burns its kills
     * crimson from three wounds; this one takes them in violet from everywhere
     * at once, which is why `dissolveRise` is nearly zero: what is eating the
     * body is not fire climbing up it, it is five holes opening at the same
     * time. The burn is deliberately slower than the rite's — the player has
     * been made to watch a wind-up, and the pay-off is worth a full second.
     *
     * Setting it to null puts this move's kills back on the ordinary path,
     * which is the useful thing to try if the dissolve is ever in question.
     */
    unmake: {
      /** Seconds the body lies there first. Almost none: it is already going. */
      corpseTime: 0.06,
      /** And the seconds it takes to go, inside the move's own settle. */
      dissolveTime: 1.3,
      /** The burn line, its heat and how wide a band it is. */
      edgeColor: '#b98cff',
      edgeEmissive: 12.0,
      edgeWidth: 0.22,
      /** Eaten from everywhere at once rather than dipped in something. */
      dissolveRise: 0.1
    },

    /**
     * The choreography, in seconds — `vfx/ShadowExecution.js`.
     *
     * These are the move far more than `hits` is: everything after the cast is
     * paced here.
     *
     * `charge` is the only one that is not a pace, it is a **timeout**. The
     * clip's second beat normally sets the ring turning somewhere in the middle
     * of the mark, and reaching the end means the execution lost what it was
     * for — the body died to something else in between — so the dark sinks
     * rather than five katanas circling grass. Keep it comfortably longer than
     * the gap between the two beats (0.62 s at the pace above).
     */
    beats: {
      /** The floor going violet and the five resolving out of it, one by one. */
      mark: 0.45,
      /** Held, gathering — and the fizzle timeout. See above. */
      charge: 1.6,
      /**
       * The wind-up: the ring accelerating and closing, and the crescents.
       *
       * The single most important number in the block. Under about six tenths
       * the ring has no time to visibly *speed up* and the move is a summons
       * followed by a stab; much over a second and a half the player is waiting
       * rather than watching.
       */
      circle: 1.0,
      /**
       * How long the body is held on the five points before they come out.
       *
       * The pause before the tear, and it is doing real work: without it the
       * impact and the finish are one event and the move has two beats instead
       * of four.
       */
      pin: 0.45,
      /** The tear-out, and the body coming apart with it. */
      sever: 0.65,
      /** And the dark sinking back into the ground it came out of. */
      settle: 1.0,
      /**
       * Seconds after which the move finishes with whatever landed.
       *
       * A safety valve, not a pace. It is measured from the frame the thrusts
       * are ordered, and they take `blades.beats.thrust` to arrive — so the
       * normal path is nowhere near it. It exists because everything from the
       * impact onward depends on points *arriving*, and one that never does
       * would leave the move holding a body and its own key forever.
       */
      abandon: 1.2
    },

    /** Master on the ring struck by each beat — the mark, the impact, the tear. */
    markRing: 0.75,
    impaleRing: 0.95,
    severRing: 1.15,

    /**
     * 1 · The light on the floor — `vfx/ShadowPool.js`, bound to the height field.
     *
     * It has no shape at all and that is its job: four of the nine layers here
     * *subtract*, and this is the source they are seen against. Turn it off and
     * the ability is a set of dark shapes over dark ground.
     */
    glow: {
      /** Metres from the middle to where the spill has run out. */
      radius: 2.9,
      /** Metres off the floor. Enough to beat the depth buffer, not to see. */
      lift: 0.028,
      /**
       * Bluer than everything above it, and on purpose: the pool is the one
       * part of the aura that reads as a *source* rather than as smoke lit by
       * one, and the eye is told that by hue as much as by brightness.
       */
      color: '#6a3cff',
      coreColor: '#b49cff',
      intensity: 2.6,
      /** How the spill falls off. Low is a wide wash; high is a tight bloom. */
      falloff: 1.9,
      /** How much of the radius the hot middle takes, and how tight it is in it. */
      core: 0.3,
      corePower: 3.4,
      pulse: 0.14,
      pulseSpeed: 2.4,
      mottle: 0.35,
      mottleScale: 2.1,
      mottleSpeed: 0.22
    },

    /**
     * 2 · The shockwave — `vfx/RiteRings.js`.
     *
     * The reference's third panel is not one ring: it is a train of them at
     * several radii at once, with the ground between split into radial cracks
     * that glow along their floors, and the whole disc scorched. `rings` is how
     * many fronts are in the train and `ringGap` is how far apart they are
     * launched — five at 0.1 is that picture.
     */
    rings: {
      enabled: true,
      color: '#8b5cff',
      coreColor: '#f0e8ff',
      crackColor: '#a06bff',
      scorchColor: '#05030a',
      intensity: 2.4,
      /** Metres the outermost front reaches, and how long the disc lives. */
      radius: 4.4,
      life: 1.7,
      /** The train: how many fronts, how far apart, and how much each loses. */
      rings: 3,
      ringGap: 0.1,
      ringReach: 0.86,
      /** Stroke weight of a front and its feather, in fractions of the radius. */
      width: 0.014,
      softness: 0.012,
      /** The cracks: how many, how long, how wide, how hot. */
      cracks: 28,
      crackLength: 0.95,
      crackWidth: 0.01,
      crackGlow: 1.9,
      /** The burn: how dark, how far out, how much of the life it fades over. */
      scorch: 0.7,
      scorchRadius: 0.75,
      scorchFade: 0.35,
      /** Metres it stands off the floor, out of the ground's z-fight. */
      lift: 0.035
    },

    /**
     * 3 · The column — `vfx/DarkPillar.js`.
     *
     * The vertical. Every other layer here is flat on the floor or wrapped
     * round the body, and without one thing standing up out of the middle the
     * composite has no height at all. It is brightest through its *middle* and
     * dark at its edges — see the module for why the obvious way round is
     * wrong.
     */
    column: {
      radius: 0.3,
      height: 6.4,
      color: '#8b5cff',
      coreColor: '#f2ecff',
      shadeColor: '#08061a',
      intensity: 0.68,
      shade: 0.05,
      shadePower: 3.1,
      corePower: 5.2,
      rimPower: 3.8,
      rim: 1.1,
      topFade: 0.62,
      /** The striations running up the wall, their size and their pace. */
      streaks: 0.62,
      streakScale: 3.8,
      streakSpeed: 3.1,
      /** The lightning inside it. */
      veins: 2.2,
      veinScale: 2.2,
      veinRate: 10.4,
      veinPower: 10.2,
      veinBranch: 0.6,
      /** The hot lip riding the head while it is still climbing. */
      front: 0.55,
      pulse: 0.18,
      pulseSpeed: 4.5,
      /** The flare at its foot, and how far up it reaches. */
      flare: 0.55,
      flareHeight: 0.05,
      /** Fraction wider the bore is as it comes up out of the floor. */
      arrivalWidth: 0.35,
      /** And how far it is thrown open by the impact, and by the tear-out. */
      pinWidth: 0.3,
      severWidth: 0.6
    },

    /**
     * 4 · The aura — `vfx/SmokeWisps.js`.
     *
     * The reference's fourth panel: slow black plumes climbing and curling with
     * violet caught in their edges. The *slow* layer, and the one that says the
     * thing is still happening rather than having happened. `count` is density
     * and `span` is how much of the height one wisp occupies.
     */
    wisps: {
      count: 30,
      color: '#3a2b58',
      rimColor: '#8b5cf6',
      opacity: 1,
      rim: 1.85,
      /** Metres out they stand, and metres up they reach. */
      radius: 2.3,
      height: 5.4,
      /** How hard they wind, which way, and how much they lean. */
      curl: 0.8,
      writhe: -0.42,
      sway: 0,
      span: 0.6,
      speed: 0.28,
      width: 0.28,
      spread: 2.2,
      topScale: 1.12,
      softness: 2.15,
      /** How fine the erosion across one is, how fast it churns, how much. */
      detail: 5.75,
      churn: 0.68,
      erode: 0.57
    },

    /**
     * 5 · The torn shadow — `vfx/ShadowSwirl.js`.
     *
     * Fast and horizontal where the wisps are slow and vertical: the aura needs
     * both or it reads as one motion. Also the other layer that subtracts.
     */
    swirl: {
      color: '#1c1430',
      rimColor: '#9b6cff',
      opacity: 0.95,
      rim: 1.9,
      /** Puffs a second while the ring is turning, and while it is gathering. */
      rate: 58,
      gatherRate: 26,
      /** And thrown out all at once by the two impacts. */
      impaleBurst: 90,
      severBurst: 150,
      spread: 0.7,
      life: 2.15,
      spin: 2.6,
      reverse: false,
      widen: 0.3,
      rise: 3.6,
      spawnHeight: 2.2,
      size: 0.54,
      grow: 1.4,
      stretch: 2.3,
      wobble: 0.3,
      wobbleSpeed: 1.5,
      detail: 1.7,
      churn: 0.76,
      softness: 0.21,
      erode: 0.55
    },

    /**
     * 6 · The shatter — `vfx/ShadowShards.js`.
     *
     * The reference's second panel, and the only layer in the ability with
     * mass. `jagged` and `rimWidth` are the two that decide what a piece looks
     * like: the first is how far the hashed corners may wander off even
     * spacing — 0 is five regular pentagons, and past about 1.2 the pieces
     * start folding through themselves — and the second is how much of the
     * violet is showing along an edge.
     */
    shards: {
      enabled: true,
      /** The facet, the fringe along its edges, and the heat in its fractures. */
      color: '#08040f',
      rimColor: '#8b5cf6',
      coreColor: '#e9dcff',
      opacity: 0.95,
      rim: 0.95,
      rimWidth: 0.06,
      heat: 0.9,
      jagged: 0.95,
      softness: 0.05,
      churn: 0.35,
      /** Metres across a piece is, and how much it opens out over its life. */
      size: 0.075,
      grow: 0.35,
      /** Radians a second it tumbles, ± this. */
      spin: 3.6,
      /** Shared: how fast they are thrown, how long they last, how they slow. */
      speed: 7.5,
      life: 0.9,
      drag: 2.8,
      gravity: -8.5,
      /** The lift under a piece, so the field hangs before the fall takes it. */
      rise: 1.6,
      /** Radians of the cone one thrust breaks along. */
      spread: 0.8,
      /** Broken off the steel by one of the five thrusts. */
      stabCount: 34,
      stabStrength: 1.0,
      /** Thrown out of the body by the impact itself. */
      impaleCount: 150,
      impaleStrength: 1.25,
      impaleRadius: 0.45,
      /** And by the tear-out, which is the frame the body comes apart. */
      severCount: 200,
      severStrength: 1.8,
      severRadius: 0.7
    },

    /**
     * 7 · The embers — `vfx/CinderStreaks.js`.
     *
     * The reference's sixth panel. `stretch` decides the whole character of the
     * field: an ember is drawn along the direction it is actually travelling by
     * an amount proportional to how fast it is going *now*, so one number gives
     * the panel's mixture of long streaks and near-points.
     */
    cinders: {
      enabled: true,
      color: '#8b5cff',
      coreColor: '#efe6ff',
      intensity: 2.0,
      /** Shared: how fast they are thrown, how long they last, how they slow. */
      speed: 7.5,
      life: 1.0,
      drag: 1.5,
      gravity: -2.0,
      /** The lift under an ember — these should not simply rain. */
      rise: 1.3,
      /** How big one is before its speed stretches it, and by how much. */
      size: 0.016,
      stretch: 2.4,
      maxStretch: 9.0,
      /** The light around one, and the flicker each is on. */
      halo: 0.55,
      flicker: 0.4,
      flickerSpeed: 22.0,
      /** Shed off the steel by one of the five thrusts, in a cone about it. */
      stabCount: 22,
      stabStrength: 1.0,
      spread: 0.7,
      /** Thrown in every direction by the tear-out. */
      severCount: 100,
      severStrength: 1.35,
      severRadius: 0.7,
      /** And the slow drift up out of the dark, for as long as there is any. */
      drift: 55,
      driftHeight: 0.2,
      driftSpread: 0.85,
      driftStrength: 0.34
    },

    /**
     * 8 · The crescents — `vfx/SlashTrails.js`.
     *
     * The reference's first panel and the layer the whole move is read off.
     * This block is what a stroke is *made of* and it is shared by all three
     * gestures below, so the move cannot come apart into three looks.
     */
    trails: {
      enabled: false,
      /** The white heat, the body of it, and the dark it fades into. */
      coreColor: '#f3ebff',
      color: '#9a5cff',
      edgeColor: '#1a0640',
      intensity: 1.35,
      /**
       * Where the white line sits across the stroke, 0 at the trailing edge and
       * 1 at the leading one, and how wide it is. Deliberately not 1: a little
       * inside leaves a thin skin of violet *ahead* of the white, and that skin
       * is what the eye reads as an edge rather than as a tube.
       */
      razor: 0.85,
      razorWidth: 0.05,
      core: 0.45,
      falloff: 1.0,
      /** How pointed the ends are. Higher is a finer needle. */
      tip: 0.5,
      /** Fraction of its life the stroke is still being swept over. */
      draw: 0.14,
      headSoft: 0.09,
      /** The bloom riding the front while it is being swept. */
      headFlare: 0.55,
      /** The tearing: how fine the pieces are, how fast they crawl, how much. */
      detail: 5.0,
      flow: 1.3,
      tear: 0.62,
      /** Filament splitting along the stroke — the hairs in the reference. */
      hair: 26.0,
      hairDepth: 0.45
    },

    /**
     * The crescent a *circling* blade drags behind it.
     *
     * The one gesture in the project struck by something travelling rather than
     * by a blow landing, and the reason the wind-up reads as a cage closing
     * rather than as five props going round. Its radius is not taken from here:
     * `ShadowExecution#_dragArcs` overrides it with the radius the ring is
     * actually at this frame, so the arc is a genuine piece of the circle the
     * blade is on. Everything else is.
     *
     * `rate` is crescents a second **per blade** — one continuous trail behind
     * each katana — and it is the density dial. Five blades at nine a second
     * with a stroke living just over half a second is about twenty-five alive
     * at once, which is what `vfx/SlashTrails.js`'s pool is sized for. Much
     * higher and it starts recycling strokes that are still bright, which reads
     * as crescents vanishing in mid-air.
     */
    orbitArc: {
      count: 1,
      spread: 0.35,
      /** Overridden per stroke — see above. Kept for the editor to show. */
      radius: 2.4,
      sweep: 2.6,
      width: 0.42,
      life: 0.55,
      /** Metres the arc is sheared along its own axis, so the ring is a helix. */
      pitch: 0.7,
      /**
       * How far off vertical a crescent's sweep plane is allowed to lean.
       *
       * The honest axis is straight up — the ring is level, so the arc a
       * blade leaves is level — and a set of level arcs is a *collar*: hoops
       * stacked at one height round the waist. The reference's crescents
       * cross at every angle and pass over and behind the figure, and this
       * is the number that buys that. 0 is the collar; much past 1 and the
       * arcs stop agreeing that anything is going round at all.
       */
      tilt: 0.62,
      strength: 1.0,
      rate: 11
    },

    /**
     * The thrust's gesture: long, shallow, barely curved.
     *
     * A big radius with a small sweep is a piece of a very large circle, which
     * is a nearly straight streak — which is what a thrust leaves.
     */
    stabArc: {
      count: 2,
      spread: 0.5,
      radius: 2.8,
      sweep: 0.5,
      width: 0.34,
      life: 0.34,
      pitch: 0.35,
      strength: 0.9
    },

    /**
     * The tear-out's: tight, wide and violent.
     *
     * A small radius with a large sweep is most of a circle — the crescents the
     * reference's first panel is full of. Same look, opposite gesture, and that
     * contrast is the cheapest way to make a finisher feel like a different
     * kind of thing from the blow that set it up.
     */
    severArc: {
      count: 3,
      spread: 0.9,
      radius: 1.25,
      sweep: 2.8,
      width: 0.46,
      life: 0.7,
      pitch: 0.85,
      strength: 1.25
    },

    /**
     * 9 · The katanas — `vfx/PhantomBlades.js`.
     *
     * The character's own weapon, borrowed off the equipment library rather
     * than modelled here. `length` is the only number that changes the mesh: it
     * is what the piece is scaled to, end to end, and moving it rebuilds them.
     *
     * The four numbers this ability adds to the rite's are `orbit`, `gatherSpin`,
     * `windSpin` and `tighten`, and between them they *are* the first half of
     * the move.
     */
    blades: {
      enabled: true,
      /** How many come. Five, which is the move. Six is the ceiling. */
      count: 5,
      /** Metres a summoned blade is, point to pommel. */
      length: 1.5,
      /** Which end of the measured piece is the point — see the module. */
      flip: false,
      /** Metres out the ring turns, and metres in a thrust finishes. */
      standoff: 2.5,
      bite: 0.24,
      /** Metres apart in height, so five points are not a level diagram. */
      spreadHeight: 0.42,
      /**
       * Radians a second the ring turns, before the drive scales it.
       *
       * Set this to 0 and the blades hang exactly as the rite's do, which is
       * the fastest way to see how much of this ability is the turn.
       */
      orbit: 2.2,
      /** The drift while they are still arriving, as a multiple of `orbit`. */
      gatherSpin: 1.0,
      /** And what it winds up to by the frame they go in. */
      windSpin: 4.6,
      /** Fraction of `standoff` the ring has closed to by then. */
      tighten: 0.52,
      /**
       * Seconds between one blade resolving out of the dark and the next.
       *
       * Five of these is the ability's opening statement, so it wants to be
       * long enough to *count*: at 0.13 the last one arrives about two thirds
       * of a second after the first, which is one blade per beat of the music
       * anybody would put under this.
       */
      stagger: 0.13,
      /** Metres further out a blade starts before it drifts to the ring. */
      gatherDrift: 0.6,
      /** Depth and beat of the hover while it waits. */
      hover: 0.05,
      hoverSpeed: 2.6,
      /** Radians a second it turns about its own line, ± this. */
      spin: 1.4,
      /** The ring in the steel once it is in: how far, how fast, how it dies. */
      quiver: 0.04,
      quiverSpeed: 46.0,
      quiverDecay: 9.0,
      /** The tear-out: metres out the far side, how high, how curved. */
      throughDistance: 3.6,
      throughLift: 1.8,
      throughArc: 0.8,
      /** Radians it rolls about its own line on the way out. */
      throughRoll: 3.4,
      /** m/s a banished blade drifts up as it burns off. */
      fadeRise: 0.8,

      /** Seconds each state of one blade takes — see `vfx/PhantomBlades.js`. */
      beats: {
        /** Resolving out of the dark, point first. */
        gather: 0.32,
        /**
         * The thrust. Under about a tenth of a second and the blade teleports;
         * much over a fifth and it is being pushed rather than driven.
         */
        thrust: 0.12,
        /** Coming out the far side. */
        wrench: 0.5,
        /** And burning off, for one that never got used. */
        fade: 0.4
      },

      /** The steel: near-black, the sheen on it, and the violet round it. */
      bodyColor: '#191233',
      sheenColor: '#e6dcff',
      rimColor: '#a97cff',
      rim: 1.05,
      rimPower: 3.0,
      /**
       * How much broad light the steel takes — the *shape* term.
       *
       * The rite's block does not have this field at all, and its blades
       * are drawn without it: three katanas against a wall of crimson smoke
       * read perfectly well as silhouettes with hot edges. These are called
       * against open night with nothing bright behind them, and a fresnel on
       * its own gives every face of the piece the same value — one flat
       * strip with a glowing outline, no blade, no guard, no grip. This is
       * what puts a lit side and a dark side back on it.
       */
      wash: 0.55,
      /** The burn that puts it there and takes it away. */
      edgeColor: '#cfb0ff',
      edgeEmissive: 11.0,
      edgeWidth: 0.15,
      /**
       * Features per metre in the burn's mask. High, and it has to be: a blade
       * is three centimetres across, so anything under about twenty features
       * per metre reads as the blade being cut in half rather than as it coming
       * apart.
       */
      detail: 34.0,
      /**
       * How much of the burn runs along the piece rather than being pure
       * static. High, because a summoned blade should arrive *point first*.
       */
      burnRise: 0.64,
      /** The energy crawling up the steel, and how fast. */
      veins: 0.9,
      veinFlow: 1.7
    },

    /**
     * The one light the whole execution shares.
     *
     * Unlike the rite's, this one has a *standing* term as well as its flashes
     * (`hold`): four of the nine layers subtract, and between the beats the body
     * in the middle of them would otherwise be lit by nothing at all.
     */
    light: {
      color: '#8b5cff',
      intensity: 26.0,
      range: 16.0,
      /** Three's own falloff exponent on the point light. */
      decay: 2.2,
      /**
       * Metres off the floor the *standing* glow sits.
       *
       * Low, and deliberately: the ring's middle is inside the body, and a
       * point light in there lights none of it — every normal on the outside
       * faces away. This one up-lights the body off the ground the dark is
       * coming out of, which is the reading the reference has. A flash still
       * fires wherever it actually happened.
       */
      height: 0.45,
      /** Seconds a flash takes to fall away. */
      fall: 0.4,
      /** What the light is worth between the beats, as a fraction of the above. */
      hold: 0.22,
      /** And what each event is worth, on the same scale. */
      mark: 0.3,
      impale: 0.85,
      sever: 1.0
    }
  },

  /* ------------------------------------------------------------------ */
  /* The slice                                                           */
  /* ------------------------------------------------------------------ */
  /**
   * Cutting a body in half — see `combat/Enemy.js` and `vfx/BloodBurst.js`.
   *
   * A move whose block says `slices` does not simply fell the body it lands on:
   * it parts it along a plane. Nothing is re-tessellated to do that. The body is
   * duplicated, each copy is given the *same* plane and told to keep the
   * opposite side of it (`uCutSide` in the enemy's shader), and each is handed
   * its own ragdoll — so the two halves are two bodies that happen to have been
   * one a frame ago, and every joint below the waist can fall while every joint
   * above it flies.
   *
   * The plane is measured in the mesh's **bind** space rather than in the posed
   * one, which is the only reason the cut stays at the waist while the halves
   * tumble: a plane in posed space would slide up the body as the corpse folded
   * over, and eventually eat all of it.
   *
   * The hollow the cut opens is filled by the same materials' back faces
   * (`interiorColor`), which is why every enemy is double-sided from birth —
   * flipping that at the moment of the blow would cost a shader recompile
   * exactly when the frame can least afford one.
   */
  slice: {
    enabled: true,
    /**
     * Where the plane sits, as a fraction of the body's own height.
     *
     * 0.60 is the waist on this export — between the hip joint and the base of
     * the spine. Below it and the plane goes through the pelvis, which leaves
     * the top half with a slab of hip hanging off it; much above and the legs
     * walk away with the ribcage.
     */
    height: 0.6,
    /** Degrees it is tilted off horizontal, tipping away along the blow. */
    tilt: 16,
    /** Metres the upper half is lifted clear on the frame the body parts. */
    separation: 0.09,
    /**
     * m/s the halves are driven *apart* along the blow, added on top of
     * whatever each one already took of it.
     *
     * The top half gets it the way the sword went and the legs get it the other
     * way, so the two travel in opposite directions instead of following each
     * other into the same heap — which is the difference between reading the
     * cut and reading a body that fell over in two bits. It is added evenly
     * rather than weighted up the body (`Ragdoll#shove`), so neither half is
     * spun by it: the fold is the blow's doing, this only separates them.
     *
     * Large enough here that the legs end up going slightly backwards, since
     * `lower.impulse` gives them a little forward to cancel first.
     */
    split: 1.8,
    /**
     * What each half does with the blow, as multipliers on the move's own
     * `impulse` / `lift` / `spin`. The top of a body cut in half leaves with
     * most of what the sword had; the bottom is a pair of legs that fold.
     *
     * Well under 1 rather than over it, which reads backwards until you see
     * why: `spin` is applied per *body height*, and half a body is half as
     * tall, so the same number throws its head twice as hard. At these the top
     * half comes down about where a whole body kicked by the same blow would
     * have, which is the reach the move was tuned against.
     */
    upper: { impulse: 0.78, lift: 0.72, spin: 0.55 },
    lower: { impulse: 0.22, lift: 0.1, spin: 0.2 },

    /**
     * The two halves as solid things — see `collideRagdolls` in
     * `combat/Ragdoll.js`.
     *
     * Each half is its own solver and neither knows the other is there, so
     * without this the torso falls through the legs it was cut off and the
     * whole thing reads as two sprites rather than one body coming apart. A
     * dozen spheres against a dozen, once a frame, for the second or two a
     * corpse is still moving.
     *
     * `radius` is the base — every joint scales it by its own size (a pelvis is
     * a chunk, a wrist is not). `maxPush` is what keeps it from exploding: it
     * caps how far one frame may separate a pair, so an overlap that starts
     * deep opens over several frames instead of firing the halves apart.
     */
    collide: {
      enabled: true,
      /** Metres, before each joint's own size multiplier. */
      radius: 0.09,
      /** How much of the closing speed comes back, and how much slide is lost. */
      bounce: 0.2,
      friction: 0.45,
      /** Metres a single frame may push one pair apart. */
      maxPush: 0.05
    },

    /** The meat the cut opens, and how much it glows in its own right. */
    interiorColor: '#4a0a0d',
    interiorEmissive: 0.4,
    /** The hot line the steel leaves, and how wide that band is (× height). */
    edgeColor: '#ff3a22',
    edgeEmissive: 3.5,
    edgeWidth: 0.012,

    /**
     * The blood — `vfx/BloodBurst.js`.
     *
     * One burst on the frame the body parts, then both stumps run for
     * `bleedTime`. Not additive: blood is dark, and additive dark is nothing.
     * `color` is the one control that matters; everything else is how it flies.
     */
    blood: {
      enabled: true,
      color: '#8b0a0a',
      /** Lifts it out of a blue night without turning it pink. */
      brightness: 1.15,
      /** Droplets thrown on the cut, and how fast they leave it. */
      burst: 220,
      speed: 5.0,
      /** How wide the spray opens, as a fraction of that speed. */
      spread: 0.6,
      /** Droplets a second from each stump afterwards, and for how long. */
      drip: 70,
      dripSpeed: 1.3,
      bleedTime: 2.4,
      /** Metres across. The streak is the speed's doing, not this. */
      size: 0.03,
      sizeVariance: 0.6,
      /** Seconds a droplet lives. */
      life: 1.2,
      lifeVariance: 0.45,
      /** Heavier than the ragdoll's air: drops arc rather than float. */
      gravity: -16,
      drag: 0.5,
      /** How far a droplet is smeared along its own screen velocity. */
      stretch: 0.05,
      maxStretch: 6,
      /** Fraction of the life spent fading out. */
      fade: 0.35
    }
  },

  /* ------------------------------------------------------------------ */
  /* The target ring                                                     */
  /* ------------------------------------------------------------------ */
  /**
   * The circle under anyone a move could land on — see `vfx/TargetRings.js`.
   *
   * Aim assist is invisible by nature: the cone and the range decide who a
   * press goes to, and until something says so the player is guessing. This is
   * that something, and it deliberately answers the *same* question the attack
   * asks — a body wears a ring exactly when `EnemyManager#findTarget` *returns
   * it* for some enabled move, which is the one body that press would take. Not
   * everyone standing inside the range and the cone: a swing only ever goes to
   * one of them, and lighting the rest is a promise three quarters of them
   * cannot keep.
   *
   * The look is a rim rather than a disc: `falloff` is the exponent on the
   * radius, so the brightness runs from nothing at the centre to full at the
   * edge — a fresnel pointed inwards — and `softness` is the feather that keeps
   * the outer edge off the ground. A filled disc under a body reads as a
   * shadow; only the glowing edge reads as a lock.
   */
  targetRing: {
    enabled: true,
    /** Metres from the body's centre to the edge of the circle. */
    radius: 0.7,
    /** Lifted clear of the floor, so it never z-fights the terrain. */
    lift: 0.03,
    /**
     * The inward gradient, as an exponent on the radius.
     *
     * 1 is a flat ramp from the centre out. Higher pins the light to the rim —
     * past about 6 it is a hard ring with nothing inside it.
     */
    falloff: 4.5,
    /** Fraction of the radius the outer edge feathers over. */
    softness: 0.12,
    color: '#ff7a3c',
    /** Master on the additive brightness. */
    intensity: 1.5,
    /** How much of that the slow breath takes off, and how fast it breathes. */
    pulse: 0.25,
    pulseSpeed: 3.2,
    /** Seconds the ring takes to come up, and to go out once out of reach. */
    fadeIn: 0.12,
    fadeOut: 0.2
  },

  /* ------------------------------------------------------------------ */
  /* Enemies                                                             */
  /* ------------------------------------------------------------------ */
  /**
   * The bodies standing around waiting to be kicked — see `combat/`.
   *
   * `count` of them stand within `radius` of the player and no closer than
   * `minRadius`, each idling on its own phase of the same clip so the group
   * never breathes in unison. They watch the player turn, and that is the whole
   * of their behaviour: this is a combat *feel* sandbox, not an AI one.
   *
   * Death is `ragdoll` below — a Verlet skeleton with no physics engine behind
   * it — followed by `corpseTime` seconds on the ground and a `dissolveTime`
   * burn-away. A slot that empties is refilled `respawnDelay` later, around
   * wherever the player has walked to, so there are always `count` of them.
   */
  enemies: {
    enabled: true,
    /** How many are standing at any moment. */
    count: 5,
    /** Metres from the player they spawn inside, and no nearer than. */
    radius: 13,
    minRadius: 4.5,
    /** Metres between two of them, so they never share a patch of ground. */
    separation: 2.4,
    /** Normalised height, metres — the same treatment the player's rig gets. */
    height: 1.78,

    /** Whether they turn to watch the player, and from how far. */
    watch: true,
    watchRadius: 18,
    /** Fraction of the heading gap left after 1s (lower = they snap round). */
    turnRate: 0.02,

    /** Whether the player is stopped by them, and the radius of that cylinder. */
    collide: true,
    bodyRadius: 0.42,

    /** Seconds a corpse lies there, then the seconds it takes to burn away. */
    corpseTime: 5.0,
    dissolveTime: 1.3,
    /** Seconds before an empty slot is refilled. */
    respawnDelay: 2.5,

    /**
     * The look. The export carries no textures at all, so this is authored
     * rather than imported: a cold, near-black body with an ember rim, which is
     * the one combination that reads as hostile against a blue night and stays
     * legible at twenty metres.
     */
    look: {
      color: '#191c24',
      roughness: 0.78,
      metalness: 0.15,
      /** The rim that draws the silhouette. Same device the shadows use. */
      rimColor: '#ff5a1e',
      rimPower: 2.6,
      rimEmissive: 1.5,
      /** The burn edge as they dissolve, and how wide that band is. */
      edgeColor: '#ff8a3c',
      edgeEmissive: 6.0,
      edgeWidth: 0.12,
      /** Features per metre in the dissolve noise. */
      dissolveDetail: 9.0,
      /** How much the burn is driven by height rather than noise — 1 = a clean
       * line rising from the feet, 0 = pure static. */
      dissolveRise: 0.45
    },

    /**
     * The ragdoll — see `combat/Ragdoll.js` for what these actually drive.
     *
     * It is a particle per joint, the bone lengths as distance constraints and
     * a few braces across the pelvis and chest, solved by relaxation. `gravity`
     * is deliberately heavier than earth: a body that falls at 9.8 on a screen
     * this size reads as slow motion, and every game does the same thing.
     */
    ragdoll: {
      gravity: -19.0,
      /** Fraction of the velocity the air takes per second. */
      damping: 0.06,
      /** Relaxation passes per substep, and substeps per frame. More = stiffer. */
      iterations: 7,
      substeps: 2,
      /** How hard the braces pull compared to the bones themselves. */
      brace: 0.45,
      /** Metres a joint stands off the ground, and how it lands on it. */
      radius: 0.075,
      friction: 0.62,
      bounce: 0.06,
      /** Below this much movement per second, the body is asleep and free. */
      sleep: 0.03
    }
  },

  /* ------------------------------------------------------------------ */
  /* Terrain                                                             */
  /* ------------------------------------------------------------------ */
  /**
   * The shape of the ground — see `world/Terrain.js`.
   *
   * Every value here is a live shader uniform, so the landscape can be redialled
   * while walking over it; nothing in this block rebuilds a buffer except
   * `seed` (which reshuffles a 256×256 table) and `segments` (which rebuilds the
   * floor mesh). The character, the camera and the shadow focus all read the
   * same height field on the CPU, so the body walks the hills it can see.
   *
   * Nothing here has a per-frame cost any more. The field is evaluated once
   * into a texture (`world/TerrainCache.js`) and the floor reads one texel per
   * vertex, so `octaves` now only prices the bake — which runs when a control
   * below moves, and about every sixty metres of walking.
   */
  terrain: {
    enabled: true,
    /**
     * Metres from the mean height to a peak. 0 is a flat plane.
     *
     * fbm almost never reaches its own extremes, so the ground actually swings
     * about ±2.5 m at this setting. Deliberately gentler than open ground would
     * want: a forest floor rolls, and every metre of relief is a metre of
     * trunk-base the ground hides.
     */
    amplitude: 3.4,
    /** Metres per lattice unit of the base octave — the size of the big hills. */
    scale: 62,
    octaves: 5,
    lacunarity: 2.05,
    gain: 0.5,
    /** Pushes the lattice around with a slower copy of itself: valleys, not blobs. */
    warp: 1.05,
    /** 0 rolling downs, 1 sharp ridges. */
    ridge: 0.28,
    seed: 3,
    /**
     * Floor mesh subdivisions per side. 400 m / this is the vertex spacing.
     *
     * 384 puts a vertex about every metre; below about 128 the hills start to
     * read as facets in silhouette.
     */
    segments: 384
  },

  /* ------------------------------------------------------------------ */
  /* Ascendance — the light that comes down and stays on you             */
  /* ------------------------------------------------------------------ */
  /**
   * `B` — a shaft of light out of the sky, and ten seconds of being better.
   *
   * The only ability in the game that is cast on *yourself* and the only one
   * whose payload is a duration. Nothing about it is aimed, nothing about it
   * hits, and everything it is worth is felt through the other moves: while it
   * is up the body is quicker on its feet and every blow it lands is heavier.
   *
   * ## The shape of it
   *
   * Five layers, and they are separate systems for the same reason a stylised
   * summon is authored as separate passes anywhere — each one is doing a
   * different job and each one has to be dialled on its own:
   *
   *  1. `sigil`   — the circle at the feet, written before anything comes down.
   *  2. `pillar`  — the shaft itself, arriving.
   *  3. `ribbons` — the spirals winding up it for as long as the boon is held.
   *  4. `burst`   — one frame of white on the floor as it lands.
   *  5. `embers`  — the motes rising the whole time.
   *
   * See `vfx/Ascendance.js`, which orders them.
   *
   * ## The three numbers worth reaching for first
   *
   *  - `duration` — how long the boon is up. Ten seconds is long enough to be
   *    worth the second it costs to call down and short enough that the player
   *    is spending it rather than living in it.
   *  - `haste` / `might` — what it is actually *for*. Both are multipliers, and
   *    both are deliberately large: a buff nobody can feel is a light show.
   *  - `pillar → height` — how far up the shaft goes before it dissolves. This
   *    is the number that decides whether the light came out of the sky or out
   *    of a lamp just off the top of the frame.
   */
  ascendance: {
    enabled: true,

    /**
     * Seconds the boon is held, measured from the frame the light *lands* —
     * not from the press.
     *
     * That is the whole design of the cost: the second of gathering and
     * descending is paid before the clock starts, so calling it down in the
     * middle of a fight is a real decision rather than a free press.
     */
    duration: 10,

    /**
     * Seconds before the end that the column starts pulsing.
     *
     * A buff that ends without warning is one the player discovers by finding
     * their blows suddenly light. 0 switches the warning off.
     */
    warn: 1.6,

    /** Metres of knock on the lens the moment the shaft lands. */
    shake: 0.24,

    /**
     * What the boon does, as multipliers on the body while it is up.
     *
     * Both are ramped down over `beats.fade` rather than switched off, because
     * a walk that drops from a sprint to a stroll on one frame reads as a bug
     * in the controller and not as a buff ending.
     */
    /** On `locomotion.walkSpeed` and `runSpeed`. */
    haste: 1.38,
    /** On the impulse, lift, spin and lens-knock of every blow the player lands. */
    might: 1.55,

    /**
     * The choreography, in seconds. `duration` is not one of these — it is the
     * beat between them.
     */
    beats: {
      /** The circle writing itself at the feet, one full turn. */
      gather: 0.55,
      /** The shaft coming down out of the sky. */
      descend: 0.5,
      /** After it lands: the bore closing to its resting width, the ribbons up. */
      settle: 0.55,
      /** And the shaft being drawn back up into the sky at the end. */
      fade: 0.95
    },

    /**
     * The circle on the floor — `vfx/SummonSeal.js`, the same one the fist
     * comes through, bound to the height field so it lies on the ground the
     * player is standing on instead of cutting into it.
     */
    sigil: {
      /** Metres from the centre to the outer ring. Wide enough to stand in. */
      radius: 2.35,
      /** Metres off the floor. Enough to beat the depth buffer, not enough to see. */
      lift: 0.045,
      /** The lines. */
      color: '#c98a1e',
      /** The hot centre, the drawing head, and the flash the light lands in. */
      coreColor: '#fff1c2',
      intensity: 1.35,
      /** Turns a second of the outer band. The inner bands run against it. */
      spin: 0.05,
      ticks: 64,
      runes: 18,
      spokes: 12,
      width: 0.009,
      softness: 0.009,
      haze: 0.22,
      detail: 0.5,
      pulse: 0.22,
      pulseSpeed: 3.4
    },

    /**
     * The shaft — `vfx/LightPillar.js`, one open tube whose entire look is the
     * cosine between its wall and the eye.
     */
    pillar: {
      /** Metres of bore at rest. Wide enough for a body, narrow enough to be a beam. */
      radius: 0.8,
      /**
       * Metres it reaches up, of which the top `topFade` is dissolving.
       *
       * Not as tall as it wants to be, and the reason is the *descent*. The
       * lens sits behind a body and sees maybe ten metres of air above it; a
       * shaft that starts twenty-six metres up spends nearly the whole of its
       * fall out of frame and appears to switch on at the last instant. At
       * sixteen the light comes down *through* the shot, which is the beat the
       * ability is built around.
       */
      height: 12,
      color: '#ffcb6a',
      coreColor: '#fffaef',
      /**
       * Deliberately far below every other emissive in the project.
       *
       * The shaft is additive, two-sided and standing between the lens and a
       * dark sky, so the middle of it is being added four or five times over
       * before anything else in the frame has been drawn. Anything near 1 here
       * clips the whole column to white and takes the profile — the entire
       * effect — with it.
       */
      intensity: 0.5,
      /**
       * How the density falls off across the column.
       *
       * `corePower` is the profile through the middle — 1 is a flat disc of
       * light and anything past about 3 is a thin filament with air around it.
       * `rimPower` is the skin at the silhouette, and `rim` is how much of it
       * there is.
       */
      corePower: 2.0,
      /**
       * The skin at the silhouette, and deliberately almost nothing.
       *
       * A rim is what draws an *edge*, and a shaft of light does not have one:
       * anything much above about 0.2 here turns the column into a rectangle
       * with a visible boundary, whatever the core is doing inside it.
       */
      rimPower: 3.0,
      rim: 0.14,
      /**
       * Fraction of the height the top dissolves over.
       *
       * It has to be read together with `gatherHead`, because between them they
       * decide whether the descent can be *seen*: the shaft exists only between
       * the front and the start of this fade, and if that window sits above the
       * few metres of air the lens frames over the body, the light appears to
       * switch on at the floor rather than to arrive at it.
       */
      topFade: 0.3,
      /** The light falling inside it: how much, how fine, and how fast. */
      streaks: 0.45,
      streakScale: 1.1,
      streakSpeed: 1.6,
      /** Depth and speed of the breath the standing column sits on. */
      pulse: 0.14,
      pulseSpeed: 2.6,
      /** How much wider the foot of the shaft is where it meets the floor. */
      flare: 1.45,
      flareHeight: 0.035,
      /**
       * How far down the shaft has already come by the end of the gather, 0..1.
       *
       * The split that makes the descent visible at all. Everything above this
       * fraction of `height` is covered while the circle is still being written
       * — faint, and above the top of the screen — so that `beats.descend` is
       * spent entirely on the stretch the lens can actually see. Raise it and
       * the light is nearly down before the circle is finished; drop it to 0
       * and the whole fall happens off the top of the frame.
       */
      gatherHead: 0.72,
      /** Extra bore on the frame it arrives, closing over `beats.settle`. */
      arrivalWidth: 0.55,
      /** Seconds the white of the landing takes to fall back to nothing. */
      flashTime: 0.4
    },

    /**
     * The spirals — `vfx/RadiantRibbons.js`. One draw call however many there
     * are, so `count` is very nearly free.
     */
    ribbons: {
      /** How many are winding at once. The buffer is built for 24. */
      count: 10,
      color: '#ffb43c',
      coreColor: '#fff7e2',
      intensity: 1.15,
      /** Metres out they ride, and metres up they climb. */
      radius: 1.28,
      height: 4.4,
      /** Turns each one takes over the full climb. */
      turns: 1.8,
      /** Length of one ribbon as a fraction of that climb. */
      span: 0.5,
      /** Climbs a second, and turns a second on top of the climb. */
      speed: 0.32,
      swirl: 0.45,
      /** Metres across at the head, tapering to nothing at the tail. */
      width: 0.095,
      /** What the helix's radius has narrowed to by the top. */
      topScale: 0.42,
      /** Depth of the waist in that radius, so the column is not a cylinder. */
      waist: 0.13,
      /** Falloff across the ribbon, and the tighter one the white core takes. */
      softness: 1.6,
      corePower: 7.0
    },

    /** The flash on the floor as it lands — `vfx/ManifestBurst.js`. */
    burst: {
      /** Metres the fan reaches. */
      radius: 4.4,
      /** Seconds it takes to burn out. */
      life: 0.7,
      color: '#ffc65c',
      coreColor: '#fffdf4',
      intensity: 2.4,
      /** Spikes in the fan, and how wide and how long they are. */
      petals: 16,
      petalWidth: 0.085,
      petalLength: 0.95,
      /** The front at the outside of them. */
      ringWidth: 0.05,
      softness: 0.1,
      /** The hot disc in the middle, which collapses faster than anything else. */
      core: 1.9,
      /** Metres off the floor. */
      lift: 0.05
    },

    /** The motes — `vfx/HolyEmbers.js`. */
    embers: {
      color: '#ffc861',
      coreColor: '#fff8e6',
      intensity: 0.6,
      /** Motes a second while the boon is held, and while it is still gathering. */
      rate: 32,
      gatherRate: 12,
      /** And the handful thrown up on the frame it lands. */
      burst: 120,
      /** How far out of the sigil they are born, as a fraction of its radius. */
      spread: 0.92,
      /** Seconds one lives, before its own scatter. */
      life: 2.7,
      /** Metres a second off the floor. */
      speed: 1.4,
      /** Metres up a mote may be born, so the field is not one lifting sheet. */
      spawnHeight: 1.7,
      /**
       * Air resistance, and the pull *upward* underneath it.
       *
       * The acceleration is positive here and negative on every other particle
       * system in the project — that sign is the entire difference between an
       * ember rising out of something holy and a spark falling off a sword.
       */
      drag: 1.1,
      rise: 1.5,
      /** Metres across at birth, and how much of that it gains over its life. */
      size: 0.042,
      grow: 0.4,
      /** Metres of wander, and how fast it wanders. */
      sway: 0.33,
      swaySpeed: 1.4,
      /** The round glow behind the diamond, and how hard the diamond's own edge is. */
      halo: 0.5,
      sharpness: 0.3,
      /** Depth of the shimmer. Each mote is on its own beat. */
      twinkle: 0.45,
      /**
       * Radians a second one may turn, either way.
       *
       * Small on purpose. A diamond turned forty-five degrees is a square, and
       * a field of them spinning freely is half squares at any given moment —
       * which is not what the shape is for. This is enough to keep them from
       * being a stamped set and not enough to lose the point.
       */
      spin: 0.9
    },

    /**
     * The one part of the ability that lights anything.
     *
     * Every layer above is additive and lights nothing at all, so without this
     * the body standing in the middle of a column of light would be exactly as
     * dark as it was before the sky opened.
     */
    light: {
      color: '#ffc861',
      /** While the boon is held. */
      intensity: 6,
      /** And on the frame it lands, decaying with the shaft's own flash. */
      flash: 30,
      /** Where it hangs, as a fraction of the body's height. */
      height: 0.62,
      distance: 11,
      decay: 1.8
    }
  },

  /* ------------------------------------------------------------------ */
  /* Shadow Boost — the dark that comes up and stays on you              */
  /* ------------------------------------------------------------------ */
  /**
   * `M` — a column of shadow out of the floor, and seconds of being worse to
   * stand near.
   *
   * The second self-cast boon, and deliberately the *opposite* of `ascendance`
   * in every reading rather than the same effect in another colour:
   *
   *  - the light is called **down** out of the sky; this comes **up** out of
   *    the ground.
   *  - the light is drawn in hard-edged geometry — a struck circle, a shaft, a
   *    fan of petals. This is **soft**: smoke, wisps, a torn vortex.
   *  - and the light is bright everywhere, where the middle of this is **darker
   *    than the world behind it**. That is the one thing no additive effect in
   *    the project had ever done, and it is why two of the five layers are on
   *    `NormalBlending` — see `vfx/DarkPillar.js`.
   *
   * What the two boons are *worth* differs on the same axis. Ascendance is
   * mostly haste with weight behind it; this is mostly weight with a little
   * haste — it does not make the body quick, it makes what the body lands
   * ruinous. Both are up at once if you cast both, and `App#_might` multiplies
   * them, which is expensive on purpose.
   *
   * ## The shape of it
   *
   * Five layers, and they are separate systems for the same reason a stylised
   * aura is authored as separate passes anywhere — each one is doing a
   * different job and each one has to be dialled on its own:
   *
   *  1. `glow`   — the pool of violet on the floor, under everything.
   *  2. `rings`  — the ground standing up in fronts, running outward.
   *  3. `column` — the shaft of dark energy, arriving.
   *  4. `wisps`  — the smoke curling up it for as long as the boon is held.
   *  5. `swirl`  — the torn shadow going round the body.
   *
   * See `vfx/ShadowBoost.js`, which orders them.
   *
   * ## The three numbers worth reaching for first
   *
   *  - `duration` — how long the boon is up.
   *  - `might` — what it is actually for. A buff nobody can feel is a light
   *    show, and this one is not even a light show.
   *  - `column → shade` — how much the column darkens what is behind it. This
   *    is the number that decides whether the effect reads as shadow or as a
   *    purple lamp, and it is the first one to reach for if it looks like the
   *    latter.
   */
  shadowBoost: {
    enabled: true,

    /**
     * Seconds the boon is held, measured from the frame the column *breaks
     * through* — not from the press.
     *
     * The same bargain the light makes: the moment of gathering is paid before
     * the clock starts, so calling it up in the middle of a fight is a real
     * decision rather than a free press.
     */
    duration: 10,

    /**
     * Seconds before the end that the column starts pulsing.
     *
     * A buff that ends without warning is one the player discovers by finding
     * their blows suddenly light. 0 switches the warning off.
     */
    warn: 1.6,

    /** Metres of knock on the lens the moment the column comes through. */
    shake: 0.22,

    /**
     * What the boon does, as multipliers on the body while it is up.
     *
     * Both are ramped down over `beats.fade` rather than switched off, because
     * a walk that drops from a sprint to a stroll on one frame reads as a bug
     * in the controller and not as a buff ending.
     *
     * The split is the whole character of the ability against the light's:
     * barely any haste, and more `might` than ascendance has. Shadow does not
     * make you quick.
     */
    /** On `locomotion.walkSpeed` and `runSpeed`. */
    haste: 1.12,
    /** On the impulse, lift, spin and lens-knock of every blow the player lands. */
    might: 1.75,

    /**
     * The choreography, in seconds. `duration` is not one of these — it is the
     * beat between them.
     */
    beats: {
      /** The pool opening at the feet, before anything has come up. */
      gather: 0.45,
      /** The column tearing up out of the floor. */
      erupt: 0.4,
      /** After it breaks through: the bore closing to its resting width. */
      settle: 0.5,
      /** And the column being drawn back down into the ground at the end. */
      fade: 0.85
    },

    /**
     * Layer 1 — the base glow. `vfx/ShadowPool.js`, bound to the height field.
     *
     * It has no shape at all and that is its job: it is the light source the
     * other four layers are seen against. Turn it off and the ability is a set
     * of dark shapes over dark ground.
     */
    glow: {
      /** Metres from the middle to where the spill has run out. */
      radius: 3,
      /** Metres off the floor. Enough to beat the depth buffer, not enough to see. */
      lift: 0.025,
      /**
       * Bluer than everything above it, and on purpose.
       *
       * In the reference the pool is the one part of the aura that reads as a
       * *source* rather than as smoke lit by one, and the eye is told that by
       * hue as much as by brightness: the column and the rings are violet, and
       * the light they are standing in is a shade nearer blue, the way the hot
       * middle of a flame is.
       */
      color: '#5a3cff',
      coreColor: '#9a86ff',
      intensity: 2.35,
      /**
       * How the spill falls off. Low is a wide flat wash; high is a tight bloom
       * with dark floor around it.
       */
      falloff: 1.4,
      /** How much of the radius the hot middle takes, and how tight it is in it. */
      core: 0.32,
      corePower: 3.35,
      /** Depth and speed of the breath under it. */
      pulse: 0.16,
      pulseSpeed: 2.2,
      /** How mottled the pool is, how fine the mottling, and how fast it crawls. */
      mottle: 0.35,
      mottleScale: 2.1,
      mottleSpeed: 0.22
    },

    /**
     * Layer 2 — the ground distortion. `vfx/DistortionRings.js`.
     *
     * Concentric fronts running outward, each with a dark trough on its inside
     * edge. The trough is what stands them up: a bright line on the floor is a
     * decal, and a bright line with a shadow behind it is a ridge.
     */
    rings: {
      /** Metres the outermost front reaches. Wider than the pool, on purpose. */
      radius: 3.8,
      lift: 0.08,
      color: '#a48cff',
      coreColor: '#f2ecff',
      intensity: 1,
      /** How many fronts are on the disc at once. */
      rings: 4,
      /**
       * Fronts a second past any given point.
       *
       * Slow. In the reference these are barely moving — they read as the
       * ground being *held* open rather than as a shockwave, and anything past
       * about 1 turns the aura into a sonar ping.
       */
      speed: -0.39,
      /** Width of the bright band, and the feather on it. */
      width: 0.038,
      softness: 0.04,
      /**
       * The bloom either side of the band, and how far into the floor it
       * carries.
       *
       * Without it the fronts are hairlines. The reference's rings are *lit*:
       * a bright line with light spilling off it into the stone.
       */
      glow: 0.72,
      glowWidth: 0.16,
      /** Depth of the trough behind each front, and how far back it reaches. */
      trough: 0.5,
      troughWidth: 0.145,
      /**
       * How far a front is pushed off a true circle, and how fine that push is.
       *
       * This is the "distortion" of the name. At 0 they are compass circles and
       * the floor reads as a target decal; a very little of it is enough.
       */
      warp: 0,
      warpScale: 4.5,
      warpSpeed: 0.22,
      /** Turns a second of the whole warped field. */
      spin: -0.63
    },

    /**
     * Layer 3 — the dark energy column. `vfx/DarkPillar.js`, two tubes.
     *
     * `shade` is the one to reach for: it is how much the near-black tube
     * dims what is behind it, and it is the difference between a shaft of
     * shadow and a violet lamp.
     */
    column: {
      /** Metres of bore at rest. Wide enough for a body to stand in. */
      radius: 0.79,
      /**
       * Metres it reaches up.
       *
       * Tall enough to leave the top of the shot, as it does in the reference —
       * the column is the one part of the effect the player is meant to see
       * from across the field, and one that ends tidily in mid-air at head
       * height reads as a prop rather than as something torn open.
       */
      height: 9.5,
      color: '#8b5cff',
      coreColor: '#f0e8ff',
      /** The tube that darkens the silhouette. Nearly black, and never quite. */
      shadeColor: '#0a0714',
      /**
       * Brightness of the half that adds.
       *
       * Held well under 1: the glow is two-sided and additive, so the middle of
       * the column is added twice over before anything else in the frame has
       * been drawn, and anything near 1 clips the whole shaft to white and
       * takes the profile — the entire effect — with it.
       */
      intensity: 1.11,
      /**
       * And the half that subtracts: peak opacity of the dark tube at the
       * **silhouette**, where the wall is grazing.
       *
       * Because it is held to the rim rather than the axis (see
       * `vfx/DarkPillar.js`), this can be generous without touching the
       * character standing in the middle. It is what gives the shaft an outside
       * as well as an inside.
       */
      shade: 0.2,
      /** How hard the dark is held to that silhouette. Higher is a thinner edge. */
      shadePower: 3.05,
      /**
       * The profile through the middle — the length of the eye's ray through
       * the column, which is what makes it read as a volume.
       *
       * 1 is a flat disc of light and anything past about 3.5 is a thin
       * filament with air around it.
       */
      corePower: 5.4,
      /**
       * The skin at the silhouette, and deliberately almost nothing.
       *
       * A rim draws an *edge*, and a shaft of energy does not have one — past
       * about 0.3 the column becomes a rectangle with a visible boundary,
       * whatever the core is doing inside it. The dark tube is what defines
       * this shaft's edge; the glow only accents it.
       */
      rimPower: 3.8,
      rim: 1.63,
      /** Fraction of the risen height the top dissolves over. */
      topFade: 0.5,
      /** What falls through the core: how much of it, how fine, and how fast. */
      streaks: 0.6,
      streakScale: 3.8,
      streakSpeed: 2.8,
      /**
       * The lightning.
       *
       * `veinRate` is strikes a second and is the one that matters: it is a
       * *quantised* clock, so each beat replaces the bolt outright rather than
       * sliding it along. Below about 3 the column reads as flickering; above
       * about 12 the strikes blur into a constant seethe.
       */
      veins: 2.6,
      veinScale: 2.2,
      veinRate: 9.6,
      veinPower: 10.2,
      /** How much of a bolt is split into forks rather than left as one trunk. */
      veinBranch: 0.59,
      /**
       * What the wall between the lens and the body is worth, against the far
       * one.
       *
       * The tube is two-sided and both walls add, which is what gives a shaft
       * its density — and is also what paints the character out of the middle
       * of their own ability. This moves that light to the side of the body
       * that can afford it. At 1 the column is at full strength and the player
       * is a smear inside it; at 0 the shaft is hollow from the front.
       */
      front: 0.51,
      /** Depth and speed of the breath the standing column sits on. */
      pulse: 0.17,
      pulseSpeed: 4.5,
      /** How much wider the foot is where it comes out of the floor. */
      flare: 1.35,
      flareHeight: 0.07,
      /** Extra bore on the frame it arrives, closing over `beats.settle`. */
      arrivalWidth: 0.7,
      /** Seconds the white of the break-through takes to fall back to nothing. */
      flashTime: 0.35
    },

    /**
     * Layer 4 — the rising wisps. `vfx/SmokeWisps.js`. One draw call however
     * many there are, so `count` is very nearly free — the buffer is built
     * for 24.
     */
    wisps: {
      count: 23,
      /** The body of the smoke, and the fringe where the aura shows through it. */
      color: '#453564',
      rimColor: '#7c5cf0',
      opacity: 1,
      rim: 1.57,
      /** Metres out they stand at the floor, and metres up they climb. */
      radius: 2.22,
      height: 5.7,
      /** Turns each one takes over the climb, and the drift of the whole set. */
      curl: 0.75,
      writhe: -0.39,
      /** Metres of the slow second wander laid over that curl. */
      sway: 0,
      /** Length of one wisp as a fraction of the climb. */
      span: 0.62,
      /** Climbs a second. */
      speed: 0.24,
      /**
       * Metres across at the floor, and how much it has spread by the top.
       *
       * Thin. These are *threads* in the reference, not plumes — the wide,
       * soft mass in the air is the swirl's job, and a set of broad ribbons
       * here competes with it and wins, which leaves the aura looking like fog
       * rather than like smoke rising out of something.
       */
      width: 0.26,
      spread: 2.2,
      /** What the standing radius has widened to by the top. */
      topScale: 1.09,
      /** Falloff across the wisp. */
      softness: 2.15,
      /** How fine the tear along one is, how fast it crawls, and how deep it bites. */
      detail: 5.75,
      churn: 0.68,
      erode: 0.57
    },

    /**
     * Layer 5 — the swirling shadow. `vfx/ShadowSwirl.js`.
     *
     * The fast, horizontal layer, against the wisps' slow vertical one. The
     * ability needs both or the whole aura reads as one motion.
     */
    swirl: {
      color: '#231a32',
      rimColor: '#8b5cf6',
      opacity: 0.95,
      rim: 1.88,
      /** Puffs a second while the boon is held, and while it is still gathering. */
      rate: 53,
      gatherRate: 12,
      /** And the handful thrown out on the frame it breaks through. */
      burst: 90,
      /** How far out they are born, as a fraction of the pool's radius. */
      spread: 0.68,
      /** Seconds one lives. */
      life: 2.15,
      /**
       * Radians a second at the pool's own radius.
       *
       * Puffs born nearer the middle wind faster than this in proportion, which
       * is what makes it a vortex rather than a turntable.
       */
      spin: 2.4,
      /**
       * Whether half of them turn the other way.
       *
       * Off by default, and it is the right default: a vortex has a direction,
       * and a set that argues about which one reads as a cloud of insects. On,
       * it is chaos — which is a look, but it is not this one.
       */
      reverse: false,
      /** Fraction the orbit widens over a life. Negative draws them inward. */
      widen: 0.28,
      /** Metres a second the field lifts. */
      rise: 3.5,
      /** Metres up a puff may be born, so the swirl is a column and not a sheet. */
      spawnHeight: 2.1,
      /** Metres across at birth, and how much of that it gains over its life. */
      size: 0.54,
      grow: 1.38,
      /**
       * How far a puff is drawn out along its own orbit.
       *
       * The single number that decides whether this layer is a spiral or a
       * cloud of blobs. 1 is a ball; at 2.5 or so each puff is a short arc of
       * smoke, and arcs at radii that turn at different rates shear into arms
       * on their own — which is how a real spiral forms and the only way to get
       * one out of billboards. See `vfx/ShadowSwirl.js`.
       */
      stretch: 2.25,
      /** Metres of wander, and how fast it wanders. */
      wobble: 0.3,
      wobbleSpeed: 1.5,
      /** How fine the fbm across one puff is, and how fast it churns. */
      detail: 1.7,
      churn: 0.76,
      /** The soft inner edge of a puff, and how hard its outline is eaten away. */
      softness: 0.21,
      erode: 0.55
    },

    /**
     * The one part of the ability that lights anything.
     *
     * Three of the five layers add and light nothing; the other two *darken*.
     * So without this the body in the middle of a column of shadow would be
     * dimmer than before the ability started and lit by nothing at all, which
     * is the one outcome that would make the effect read as a mistake.
     */
    light: {
      color: '#8b5cff',
      /** While the boon is held. */
      intensity: 21.4,
      /** And on the frame it breaks through, decaying with the column's flash. */
      flash: 43,
      /** Where it hangs, as a fraction of the body's height. */
      height: 1.06,
      distance: 14.5,
      decay: 3.2
    }
  },

  /* ------------------------------------------------------------------ */
  /* Environment & lighting                                              */
  /* ------------------------------------------------------------------ */
  environment: {
    // **Moonlight.** One cool key, a deep blue sky fill, and a pale bounce off
    // frozen ground — the whole frame is two or three steps of blue and nothing
    // else, which is what a night shot actually is. It is not a dark scene: a
    // full moon on open ground is bright, and the reference reads as night
    // because everything in it is *one cool hue*, not because it is
    // underexposed. Turning `sunIntensity` down from here does not make it more
    // nocturnal, it makes it muddy — the colour is doing the work.
    //
    // "sun" throughout is the key light. It used to double as the moon; it does
    // not any more. The moon is a body in the sky with its own azimuth and
    // elevation (`sky.moon`), and it is what the haze, the mist and the sky's
    // own glow are lit from. This is the *portrait* key, and under
    // `keyCharacterOnly` below it lights the character and nothing else — so it
    // can be placed for the body without dragging the whole landscape with it.
    // High, because it is a *character* key now rather than a scene sun: under
    // `keyCharacterOnly` nothing else in the frame sees it, so it can be driven
    // hard enough to model the armour without blowing the landscape out.
    sunIntensity: 5.18,
    sunColor: '#b8d2f0',
    // Down world +Z, a little to one side, so the ground runs into the light.
    sunAzimuth: 1.42,
    // High. With the key off the landscape this is a portrait angle rather than
    // a time of day: it decides where the shadow across the character's own
    // armour falls, and nothing else.
    sunElevation: 0.72,
    /**
     * Whether the key and the rim light the character *only*.
     *
     * three has no per-object light filtering — a light in a scene is in every
     * material in it — so this is done from the other end: the world's own
     * surfaces are patched to drop every directional light
     * (`Environment#excludeFromKeyLights`), and the key and the rim are the only
     * two directional lights there are. What is left lighting the ground is the
     * ambient, the hemisphere and the probe, which is what makes the landscape
     * read as moonlit air rather than as a spotlit set.
     *
     * A live uniform rather than a define, so the switch costs nothing and no
     * shader recompiles when it moves.
     */
    keyCharacterOnly: true,
    ambientIntensity: 0.34,
    ambientColor: '#3f6396',
    hemiIntensity: 0.75,
    hemiSkyColor: '#5c86bb',
    // The bounce off frozen ground: pale, cold, and only a little of it.
    hemiGroundColor: '#2b3f52',
    // Same story as the key: character-only, so it is strong enough to cut a
    // cold edge down the silhouette against the haze behind it.
    rimIntensity: 4,
    rimColor: '#9ec8ff',
    rimAzimuth: 3.69,
    rimElevation: 0.69,
    // Low. The probe is a daylight HDR (`spruit_sunrise`) and it is kept only as
    // a specular response for metal — at anything much above this it starts
    // putting a warm afternoon back into the armour.
    envIntensity: 0.14,
    // There is no backdrop colour and no linear fog here any more. The sky
    // (`world/Sky.js`) is drawn over every pixel before anything else, so a
    // scene background was never visible; and `world/Atmosphere.js` owns the
    // air, which it can do the two things linear fog cannot — pool in the
    // hollows, and glow looking into the moon.
    shadowBias: -0.0006,
    /**
     * How far a shadow lookup is walked along the surface normal before it is
     * taken, metres.
     *
     * The character screen has had this control since it was built; the play
     * stage was carrying a hard-coded 0.035 and no way to reach it. It is the
     * scale-free half of the acne fix — `shadowBias` offsets in depth and has to
     * be re-dialled whenever the frustum changes size, while this one is in
     * metres of world and does not. Too little and lit surfaces speckle
     * themselves; too much and contact shadows detach from their feet.
     */
    shadowNormalBias: 0.035,
    /**
     * Softness of the shadow edge.
     *
     * Note that `PCFSoftShadowMap` (what `core/Renderer.js` selects) uses a
     * fixed kernel and ignores this — it is in force only under `PCFShadowMap`.
     * Left here because the character screen's spot does honour it.
     */
    shadowRadius: 2.6,
    /**
     * Half-width of the sun's shadow box, metres, and how far up-sun the light
     * is parked. The box has to cover the trees whose shadows fall across the
     * frame, and the distance has to clear the tallest of them — at a low
     * elevation a light parked close is a light *below* the canopy, and the
     * near plane starts slicing crowns off.
     */
    shadowExtent: 46,
    shadowDistance: 210,
    floorColor: '#1c2b3a',
    floorTint: '#3c5a74',
    floorRoughness: 0.94,
    floorSheen: 0.12,
    // Nearly off. The pool is a dark-stage device — it sinks the floor into a
    // black backdrop past 40 m — and out here the haze is what does that job,
    // in a colour the sky agrees with.
    floorPool: 0.0,
    // The tiling that dresses the floor. `floorTextureSet` picks between the
    // soil the grass is planted in (ambientCG Ground103, public/textures/terrain)
    // and the original flagstone (Rock030, public/textures/stone); only the one
    // in use is downloaded. `floorTextureScale` is metres of floor one tile
    // covers; `floorTexTint` grades it toward `floorTint` so it sits inside the
    // cool stage palette. Switch the texture off for the procedural fallback in
    // Ground.js.
    floorTexture: true,
    floorTextureSet: 'terrain',
    floorTextureScale: 3.0,
    floorNormalScale: 1.0,
    // Pushed up from the daylight value: the soil is a brown photograph and the
    // stage is blue, so more of the tiling's own colour has to be graded away
    // than a warm scene ever needed.
    floorTexTint: 0.62,
    contactShadow: 0.5
  },

  /* ------------------------------------------------------------------ */
  /* The air                                                             */
  /* ------------------------------------------------------------------ */
  /**
   * Haze, ground mist and inscatter — see `world/Atmosphere.js`.
   *
   * This replaces three's fog for the world's own surfaces (the character keeps
   * it, and never gets far enough from the lens for the difference to show), and
   * it exists to do the two things linear fog cannot.
   *
   * `ground` is the layer that pools in the hollows: density falls off
   * exponentially above `base` with an e-folding height of `falloff`, so at the
   * defaults here the mist is thick in the valleys, thinning to nothing by about
   * fifteen metres up. It is what puts white between the far trunks while the
   * ones nearby stay clear.
   *
   * `inscatter` is the other half, and the one that does the most work per unit:
   * how far the haze goes toward `sunColor` when you are looking down the beam.
   * At 0 the air is a flat wash from every angle; at 1 the quarter of the scene
   * around the moon glows and the rest does not, which is what a long exposure
   * into a full moon actually looks like.
   *
   * This is the *distance* fog — the air itself, everywhere, with no shape of
   * its own. The mist that rolls along the ground with a body and an edge is
   * `groundFog` below, and the two are meant to be used together.
   */
  haze: {
    enabled: true,
    /** What the distance dissolves into looking away from the moon. */
    color: '#48789e',
    /** And looking into it. The sky's horizon and glow are the same two colours. */
    sunColor: '#c6e0f5',
    /** 1/m of the layer that is everywhere. 0.004 is half-hidden at ~170 m. */
    density: 0.0048,
    /** Metres of clear air in front of the lens, so the character is never hazed. */
    start: 4,
    /** Extra 1/m at the floor of the mist. */
    ground: 0.016,
    /** World Y the mist sits on, and the metres it takes to thin by 1/e. */
    base: -1.5,
    falloff: 7.5,
    inscatter: 0.62,
    /** How tight the moon lobe is. Higher = the glow hugs the disc more closely. */
    sunPower: 5.0,
    /** Ceiling on the blend, so the far field never goes perfectly flat. */
    max: 0.94
  },

  /* ------------------------------------------------------------------ */
  /* Sky                                                                 */
  /* ------------------------------------------------------------------ */
  /**
   * The backdrop — see `world/Sky.js`.
   *
   * Only the zenith, the stars and the moon's own glow are authored: the horizon
   * is the haze colour, bound from the block above by identity, because the sky
   * is what every distant surface has to dissolve *into* and any other colour
   * there puts a visible line across the far field.
   *
   * The whole block is drawn by one fullscreen shader that runs before anything
   * else, so every control here is priced per screen pixel per frame.
   */
  sky: {
    enabled: true,
    // Deep navy overhead, dissolving to the haze at the horizon. The gap
    // between this and `haze.color` is the single strongest read of depth in
    // the frame — close them up and the sky goes flat.
    zenith: '#041834',
    /** How fast the zenith takes over from the horizon. Low = a tall gradient. */
    gradient: 1.33,
    /**
     * The glare around the disc, and how tight it is.
     *
     * Off. With `moon.geometry` on there is a real lit sphere up there, and the
     * shader's glare was stacking a second, softer disc on top of it. Turn it
     * back up only alongside the fallback disc.
     */
    sunGlow: 0.0,
    sunGlowPower: 51.5,
    /** The broad wash the moon puts over its whole quarter of the sky. */
    broadGlow: 0.0,
    /**
     * The disc itself, and its angular size (1 - cos, so 0.0035 ≈ 9.6° across).
     *
     * Many times a real moon (which is half a degree) — it is the subject of
     * the shot. What keeps it from reading as a blown-out lamp at that size is
     * not this number but `moon.opacity` below: the body is drawn nearly
     * transparent, so it is big *and* soft.
     */
    disc: 2.0,
    discSize: 0.0035,
    // Down hard. The sky is a backdrop for a moonlit ground, and at 1.0 the
    // gradient was bright enough that the haze had nothing to dissolve into.
    exposure: 0.35,

    /**
     * The moon: where it hangs, and what its face looks like.
     *
     * `azimuth` and `elevation` are the same convention every other angle in the
     * project uses — azimuth measured from world +X toward +Z, elevation from
     * the horizon — and they are the *world's* light direction: the sky's disc
     * and glare, the haze's inscatter lobe and the ground mist's moonlight all
     * resolve from this one pair (`world/Sky.js` writes `frame.uLightDir` from
     * it). The character's key is a separate angle in `environment` above.
     *
     * **On elevation.** The rig cannot aim much above 30° (`camera.maxPolar`),
     * so a moon parked higher than about 0.5 rad is off the top of the frame and
     * only its glare is ever on screen. Low is also the better shot here —
     * everything backlit in this scene is built around looking *into* it.
     *
     * **`geometry` is the moon that ships.** With it on, `world/Moon.js` hangs a
     * displaced sphere carrying a real lunar surface material out at the angles
     * above and the sky's own disc stands down; `detail`/`detailScale` below then
     * do nothing, because they belong to that disc. Turn it off (or lose the
     * maps) and the shader disc comes back — which is what `detail` is for: two
     * octaves of value noise standing in for the maria, evaluated *only* inside
     * the disc, without which the fallback is a white circle that reads as a
     * lens flare.
     *
     * Everything from `phase` down is the body, and `phase` is the one that
     * changes the picture: it is where its *sun* is, measured from full (lit
     * from behind the lens) round toward the limb, so it is the difference
     * between a full moon and a crescent. `brightness` and `size` are shared
     * with the glare — they are `sky.disc` and `sky.discSize` above, so the halo
     * in the air can never be sized for a moon that is not there.
     */
    moon: {
      azimuth: 1.69,
      elevation: 0.325,
      color: '#eef6ff',

      /** The textured sphere rather than the shader disc. */
      geometry: true,

      /**
       * The body's own exposure and its coverage, both of which belong to it
       * alone.
       *
       * `sky.disc` above is *shared* — it is the glare's brightness and the
       * scale the haze's lobe is sized against — so turning the sphere down
       * with it drags the whole quarter of the sky down too. `brightness` is a
       * multiplier on top of it: 1 leaves the body where the glare thinks it
       * is, below that is a moon that is no longer the brightest thing in the
       * frame. `opacity` is the other half of the same complaint — it scales
       * the alpha, so the face washes into the sky behind it rather than
       * sitting on it as a pasted-on plate. Both at 1 is the old behaviour
       * exactly.
       *
       * They are set as a *pair*, and the pair is the whole look: the face is
       * drawn at four percent coverage, so it is very nearly the sky it hangs
       * in, and the exposure is up three times to put it back. The result is a
       * body you can see through — soft, grey, sitting *in* the air rather than
       * punched through it. Raising `opacity` without dropping `brightness` to
       * match blows the disc out to white immediately.
       */
      brightness: 3.0,
      opacity: 0.04,

      /** Where its sun is: 0 full, π/2 half, π new. And how far that sun is
       * lifted off the line of sight, which leans the terminator. */
      phase: 0.84,
      phaseTilt: 0.64,
      /** Which stretch of ground faces the lens. The material is uniform, so
       * these only reseed the view — there is no "right" side to this moon. */
      tilt: 0.0,
      spin: -0.74159,

      /**
       * The surface material, projected triplanar in the body's object space.
       *
       * `textureScale` is tiles per radius: up puts more, smaller craters on the
       * face. `blendSharpness` is how narrow the band is where two of the three
       * projections meet — low smears them together, high can show a seam.
       */
      textureScale: 0.35,
      blendSharpness: 1.0,

      /**
       * `displacement` is the height map moving actual vertices, as a fraction
       * of the radius — it is what breaks the silhouette into crater rims
       * instead of leaving a circle with a picture on it. `relief` is the normal
       * map's weight in the shading, which carries everything finer than the
       * 96×64 sphere can hold.
       */
      displacement: 0.0,
      relief: 1.0,
      /** The AO map's weight. Crater floors and rim shadows, on both sides. */
      ao: 1.0,
      /** A weak wide highlight off the smoother patches, from the roughness map. */
      sheen: 0.225,

      /**
       * `terminator` is how many degrees the day/night edge takes to cross, and
       * `flatten` is the exponent on the cosine: real regolith throws light
       * straight back where it came from, so a lambert sphere looks wrong in the
       * most recognisable way there is. Low = flat and bright to the limb.
       */
      terminator: 0.29,
      flatten: 0.86,
      /** Earthshine on the night side, and how far the limb dissolves. */
      earthshine: 0.0,
      edge: 0.4,

      /** Fallback disc only: the maria, and the size of the patches. */
      detail: 0.25,
      detailScale: 8.8
    },

    /**
     * Stars — one hash per lattice cell, so a whole sky of them costs about what
     * a single texture lookup would.
     *
     * `density` is cells per unit of direction: higher packs more in and makes
     * each one smaller. `horizon` is the elevation below which they are gone,
     * because the air near the horizon is thick enough to swallow them.
     */
    stars: {
      enabled: true,
      density: 155.0,
      brightness: 2.65,
      twinkle: 0.37,
      horizon: 0.06
    }
  },

  /* ------------------------------------------------------------------ */
  /* Ground fog                                                          */
  /* ------------------------------------------------------------------ */
  /**
   * The mist that crawls over the ground — see `world/GroundFog.js`.
   *
   * The *other* fog, and a different kind of thing from `haze` above. That one
   * is a property of the air with no shape of its own; this one is an emitter
   * letting go of puffs that are carried downwind, spread as they age, and hug
   * whatever the ground beneath them is doing (the height field is read straight
   * out of the floor's own baked texture, so mist blowing across a hollow goes
   * down into it).
   *
   * Every puff's whole trajectory is closed-form in the vertex shader, so the
   * per-frame CPU cost is a loop comparing `count` floats against the clock. The
   * GPU cost is fill: `count` × `sizeEnd`² of soft transparent quads, which is
   * the thing to turn down if the frame is tight — `count` first, then `detail`.
   */
  groundFog: {
    enabled: true,
    /**
     * Puffs in the air. Density is this against `life`: the emitter releases
     * `count / life` per second, because a slot respawns the moment it dies.
     * Capped at 512 by the buffer.
     */
    count: 190,
    /** Seconds one puff lives, and how much shorter the short ones are. */
    life: 15.0,
    lifeVariance: 0.45,

    /**
     * The emitter. `follow` parks it on the character (with `x`/`z` as an offset
     * from them), which is what keeps mist around the camera on an endless
     * ground; switch it off and `x`/`z` are a fixed world position, which is how
     * you put a bank of fog in one particular hollow.
     */
    follow: true,
    x: 0,
    z: 26,
    /** Metres of the disc puffs are born over. */
    radius: 32.5,

    /** Metres per second the mist is carried. */
    windX: 0.1,
    windZ: -1.35,
    /** Metres per second it climbs. Small — this is mist, not smoke. */
    rise: 0.06,
    /** Metres the centre floats above the surface under it. */
    hover: 0.7,
    /** Lateral wander, metres, and how fast it wanders. */
    swirl: 1.1,
    swirlSpeed: 0.12,

    /**
     * Metres across at birth and at death.
     *
     * Birth is the *larger* of the two here: these are few, very wide banks that
     * tighten slightly as they age, which reads as mist settling rather than as
     * smoke billowing out.
     */
    sizeStart: 13.0,
    sizeEnd: 9.3,
    /** Radians per second the billboard rolls, so no two show the same face. */
    spin: 0.05,

    /** The mist itself, and what it goes toward looking into the moon. */
    color: '#5f819e',
    litColor: '#cfe4f6',
    /** Master on the alpha. The one control that is always right to reach for. */
    opacity: 0.08,
    /** How much of the radius is the soft shoulder. 1 = pure gradient. */
    softness: 0.85,
    /** Fractions of the life spent fading in and out. */
    fadeIn: 0.18,
    fadeOut: 0.45,
    /**
     * Metres above the ground the alpha ramps up over.
     *
     * This is what hides the line where a billboard crosses the terrain — by the
     * time the depth test cuts the quad, there is nothing there to cut. Too
     * small and the cut shows; too large and the mist floats.
     */
    groundFade: 2.55,
    /** Noise breaking the disc up: how much, and how fine. 0 skips the lookup. */
    detail: 0.45,
    detailScale: 10.7,
    /**
     * How far the mist goes toward `litColor` down the beam, and how tightly.
     *
     * Off. Puffs are large enough now that one drifting across the moon swung
     * its whole face to `litColor` at once, which read as a flicker rather than
     * as light — the haze behind them carries the beam instead.
     */
    moonlight: 0.0,
    moonPower: 3.0,

    /**
     * The hole kept clear around the lens: metres at which a puff is completely
     * gone, and metres over which it comes back to full.
     *
     * Nothing else in the block can fix a puff being *between* you and the
     * character. It is metres across and a metre from the lens, so it covers the
     * frame, and its birth and death are then a wash of colour over everything —
     * the one place where mist that is otherwise correct is simply in the way.
     * So the alpha is taken to zero inside `nearFade` and ramped back over
     * `nearFadeRange`, and the puff is still there in the world, still drifting,
     * just not drawn where it could only be an obstruction. Keep `nearFade` a
     * little beyond the closest the camera ever gets to the character.
     */
    nearFade: 7.0,
    nearFadeRange: 9.0
  },

  /* ------------------------------------------------------------------ */
  /* Leaves                                                              */
  /* ------------------------------------------------------------------ */
  /**
   * The forest floor's litter and the leaves in the air above it — see
   * `world/Leaves.js`, `world/LeafLitter.js`, `world/LeafDrift.js`.
   *
   * The block at this level is everything the two populations *share*: they are
   * the same leaves off the same 3 × 3 sheet, in the same grade, backlit by the
   * same moon, on the same wind. Only `litter` and `drift` below differ, and
   * they differ because a leaf lying in the mud and a leaf being carried across
   * the field are doing genuinely different things.
   */
  leaves: {
    enabled: true,

    /**
     * Metres along the blade of an average leaf.
     *
     * The single most load-bearing number here. Beech leaves are eight to ten
     * centimetres; the quad is a little larger than the leaf inside it, so this
     * runs a touch over. Too small and the field reads as gravel, too large and
     * it reads as a bed of lily pads.
     */
    size: 0.17,
    sizeVariance: 0.45,

    /** How rough the blade is. Damp leaves are shinier than dry ones. */
    roughness: 0.72,
    normalScale: 1.0,

    /**
     * The alpha cutoff.
     *
     * Leaves are drawn *opaque and alpha-tested* rather than blended: they write
     * depth, they need no sorting, and they can be drawn in any order — which is
     * the only reason five thousand of them costs one draw call. Lower cuts out
     * more of the soft edge (fatter leaves, more aliasing), higher eats into the
     * blade. `alphaToCoverage` is what pays off the usual price of testing: the
     * cut-out edge is resolved against the composer's MSAA samples instead of
     * per pixel, so it comes out as clean as a blended edge with none of the
     * ordering.
     *
     * That last part needs multisampling to exist: it is honoured only while
     * `post.samples` is above 0, because on a single-sampled target there is no
     * coverage mask to resolve against and the switch would cost a `fwidth` for
     * nothing. Left on here so that raising `post.samples` improves the leaves
     * without anyone having to come back for this.
     */
    alphaTest: 0.42,
    alphaToCoverage: true,
    /**
     * How far inside its own cell a leaf's UVs are kept, in cells.
     *
     * The sheet is nine leaves in one image and a minified sample near a cell
     * border reaches into the leaf next door. This is the cheap answer: pull
     * every fetch a little inside its own ninth.
     */
    atlasInset: 0.02,

    /**
     * The grade.
     *
     * The sheet is a daylight photograph of a green beech and this stage is a
     * blue night, so the leaves are pushed toward `tint` the same way the floor's
     * soil is: normalised to unit luminance, so the hue moves and the brightness
     * does not. At 0 they are summer-green in a moonlit field, which is the one
     * thing that would give the whole effect away.
     */
    tint: '#ff0505',
    tintAmount: 0.55,

    /**
     * Light coming *through* the blade.
     *
     * A leaf is one cell thick and it glows when the moon is behind it. This is
     * the highest-value control in the block: without it a leaf is an opaque
     * chip and the field reads as stickers on the ground; with it the leaves
     * facing away from you into the moon light up in their own colour, which is
     * what a photograph of a woodland floor at night actually shows. `power` is
     * how tightly it hugs the beam.
     */
    backlight: 0.9,
    backlightColor: '#b9d69a',
    backlightPower: 6.0,

    /**
     * The wind, metres per second — one wind for both populations.
     *
     * The gust triple on top of it is a slow travelling wave over world
     * position: `speed` is how fast it beats, `scale` how big the gusts are
     * (radians per metre, so small numbers mean broad ones) and `strength` how
     * hard. It quivers the litter where it lies *and* pushes the leaves in the
     * air, so one gust visibly crosses the whole field.
     */
    windX: 0.55,
    windZ: -1.5,
    gustSpeed: 0.55,
    gustScale: 0.06,
    gustStrength: 1.0,

    /**
     * The leaves on the ground, and what happens when you walk through them.
     *
     * A leaf lies flat on the slope under it and does nothing at all until
     * something disturbs it, at which point it is thrown along a closed-form
     * arc and lands where the arc ends — from which it can be kicked again. The
     * whole flight lives in the vertex shader; the CPU writes four floats per
     * kick and nothing else, ever.
     */
    litter: {
      enabled: true,

      /**
       * Metres across the window of leaves that follows the character, and how
       * many leaves each of its 20 × 20 cells holds.
       *
       * These two are the cost. `perCell` × 400 is the leaf count — 14 is
       * 5 600 leaves, about 1.8 per square metre, which is a well-covered
       * woodland floor. Both are live: the buffers are allocated once at the
       * ceiling, so a lower density leaves the tail of every cell empty rather
       * than rebuilding anything, and moving either simply re-lays the grid.
       */
      field: 56,
      perCell: 14,

      /** Metres a leaf floats above the surface, so it cannot z-fight the floor. */
      hover: 0.015,
      /** Radians the wind lifts the tip of a resting leaf. */
      rustle: 0.16,

      /**
       * Metres at which the field starts to erode away and at which it is gone.
       *
       * Not an optimisation you can see: at this density the far field is more
       * leaves than pixels, and drawing it is a grey shimmer. Keep `fadeEnd`
       * inside `field / 2` or the window's own edge comes into view.
       */
      fadeStart: 20,
      fadeEnd: 29,

      /**
       * A kick, once it is in the air. `flight` is how long one lasts, `drag`
       * how fast the launch speed bleeds off (higher = shorter, sharper throws),
       * `swirl` how far it wanders sideways on the way and `spin` how hard it
       * tumbles. The swirl and the spin are both built to die out exactly at the
       * end of the flight — that is what makes the landing place computable, and
       * it is what lets a leaf be kicked again from where it came down.
       */
      flight: 1.15,
      drag: 2.4,
      swirl: 0.22,
      swirlSpeed: 5.0,
      spin: 14,

      /**
       * What a foot does to them.
       *
       * `pushSpeed` is the metres per second below which nothing is disturbed —
       * without it the leaves under a standing character would be re-kicked
       * every frame and boil. `pushRadius` is how wide the sweep is and
       * `pushLead` how far ahead of the body it is centred (the character is
       * positioned by their root, and the foot going through the leaves is in
       * front of it). `pushForward` blends the throw between straight away from
       * the foot (0 — reads as an explosion underneath you) and along the way it
       * is going (1 — reads as a conveyor); the middle is a sweep. `pushForce`
       * scales it against your speed, `pushLift` how high they go, and
       * `pushBudget` caps how many one frame may disturb.
       */
      pushSpeed: 0.35,
      pushRadius: 0.75,
      pushLead: 0.35,
      pushForward: 0.6,
      pushForce: 0.5,
      pushLift: 0.35,
      pushBudget: 40,

      /**
       * And what the wind does: leaves a second that come unstuck and skitter
       * downwind. The same kick with smaller numbers, and `gustSpread` is the
       * radians either side of downwind they are fanned over, because a gust is
       * turbulent and a field leaving on one bearing reads as a conveyor belt.
       */
      gustRate: 5,
      gustForce: 0.5,
      gustLift: 0.18,
      gustSpread: 1.1
    },

    /**
     * The leaves in the air.
     *
     * Born over the character, carried downwind, falling the whole time and
     * swinging from side to side as they go — the glide a leaf does because it
     * is a wing. They land on the same ground the litter lies on and skitter
     * along it until their life runs out.
     */
    drift: {
      enabled: true,
      /** Leaves in the air. Capped at 1024 by the buffer; this is the cost dial. */
      count: 260,
      /** Metres of the disc around the character they are born over. */
      radius: 26,
      /** Seconds one lives, and how much shorter the short ones are. */
      life: 18,
      lifeVariance: 0.4,
      /** Metres above the ground they are born between. */
      heightMin: 0.6,
      heightMax: 8,
      /** These are the leaves you see close up, so they can run a little larger. */
      sizeScale: 1.0,

      /** Metres per second it sinks. */
      fall: 0.6,
      /** Metres of the sideways swing, and how fast it swings. */
      flutter: 0.55,
      flutterSpeed: 2.0,
      /** How hard it turns over about its long axis as it swings. */
      tumble: 1.0,
      /** Radians per second the whole leaf yaws as it goes. */
      yawDrift: 0.35,

      /** Metres it rests above the surface once it is down. */
      hover: 0.02,
      /**
       * Metres of descent over which the tumble is unwound.
       *
       * What makes one land instead of stopping dead on its edge: over the last
       * metre it flattens out and lies down on the slope.
       */
      settle: 1.1,

      fadeStart: 30,
      fadeEnd: 42,
      /** Fractions of the life spent dissolving in and out. */
      fadeIn: 0.05,
      fadeOut: 0.22,
      /**
       * The hole kept clear around the lens: metres at which a leaf is gone
       * entirely, and metres over which it comes back. A leaf twenty
       * centimetres from the camera is a green wall across the frame.
       */
      nearFade: 0.8,
      nearFadeRange: 1.2
    }
  },

  /* ------------------------------------------------------------------ */
  /* Post processing                                                     */
  /* ------------------------------------------------------------------ */
  post: {
    enabled: true,
    /**
     * Multisample count on the composer's render targets.
     *
     * The scene is drawn into a render target rather than into the canvas, so
     * the renderer's own `antialias` flag never touches it — this is the only
     * anti-aliasing in the project. Without it every ridge line against the sky
     * and every hard shadow edge crawls as the camera moves, which reads on
     * screen as a fringe of noise rather than as aliasing.
     *
     * It is also the most expensive single thing in the pipeline, because the
     * whole chain writes through these targets. 2 keeps most of the benefit for
     * half the bandwidth; 0 — where it ships — is the cheapest, and what the
     * stage is currently dialled for.
     */
    samples: 0,
    // Just over 1. The night is lit by one cool key and a sky that is mostly
    // dark, so there is far less in the frame competing for the tone mapper's
    // shoulder than the daylit version had.
    exposure: 1.02,
    // Off. The moon carries its own brightness, and the bloom on top of it was
    // smearing the blade's edge into the haze. Turn `bloomStrength` back up if
    // the moon ever needs a halo again.
    bloomStrength: 0.0,
    bloomRadius: 0.0,
    bloomThreshold: 0.0,
    vignette: 0.69,
    chromaticAberration: 0.0,
    contrast: 1.0,
    saturation: 1.0,
    temperature: 0.0, // + warm / - cool
    lift: 0.0,
    gain: 1.0,
    // Off. Film grain is a per-pixel hash redrawn every frame; the grade is
    // clean enough now that it read as crawling dots rather than emulsion.
    grain: 0.0
  },

  /* ------------------------------------------------------------------ */
  /* Character screen (the equipment studio)                             */
  /* ------------------------------------------------------------------ */
  /**
   * The lit stage the character is inspected and equipped on — a scene of its
   * own, with its own camera, lights and grade (see `world/StudioStage.js`).
   *
   * Nothing here is shared with the world stage above. That separation is the
   * point: the play stage is lit for readability at a distance, and this one is
   * lit for a single body standing two metres from the lens, where the light has
   * to model the armour rather than merely reveal it.
   */
  studio: {
    /**
     * Framing. The rig owns the live target and distance (it is an orbit under
     * the pointer); these are the limits it works inside and the frame it
     * returns to.
     */
    camera: {
      fov: 34,
      distance: 3.3,
      minDistance: 0.3,
      maxDistance: 9.0,
      /** Height the default frame looks at, metres up the body. */
      targetHeight: 1.05,
      /** Fraction of the gap left after 1s while gliding to a framing preset. */
      damping: 0.0006,
      /** Idle camera drift, revolutions/second. 0 parks it. */
      autoOrbit: 0.0
    },

    /** Turntable on the body itself, revolutions/second. */
    turntable: 0.0,

    /**
     * Five-point cinematic rig.
     *
     * Key and fill are each a *pair*: a spot that carries the shadow and the
     * falloff, and a rect-area softbox at the same angle that does the wrapping
     * and the long specular roll across metal. That pairing is what a single
     * light of either kind cannot do — an area light casts no shadow, and a spot
     * alone leaves armour reading as plastic.
     *
     * Spot intensities are candela and fall off with the square of the distance;
     * area intensities are nits and do not, which is why the two scales look
     * nothing alike.
     */
    lights: {
      keyIntensity: 187,
      keyColor: '#ffeedd',
      keyAzimuth: 5.03,
      keyElevation: 0.72,
      keyDistance: 4.2,
      keyAngle: 1.39,
      keyPenumbra: 1.0,
      /** The softbox at the key's angle: size in metres, and its own intensity. */
      keySoftbox: 8.7,
      keySoftboxSize: 1.6,

      fillIntensity: 2.85,
      fillColor: '#ffffff',
      fillAzimuth: 2.79,
      fillElevation: 0.3,
      fillDistance: 4.75,
      fillSize: 2.7,

      /** Separation down the far edge of the silhouette. */
      rimIntensity: 251,
      rimColor: '#00b33c',
      rimAzimuth: 3.5,
      rimElevation: 0.42,
      rimDistance: 3.8,

      /** Warm kicker from the other side behind, so the two edges differ. */
      kickerIntensity: 70,
      kickerColor: '#ff8c00',
      kickerAzimuth: 5.5,
      kickerElevation: 0.3,
      kickerDistance: 3.6,

      /** Hair light, straight down and slightly behind. */
      topIntensity: 55,
      topColor: '#e6f0ff',

      ambientIntensity: 0.17,
      ambientColor: '#ffffff',
      /** The HDR probe, as spec response rather than as light. */
      envIntensity: 0.88,

      shadowBias: 0.001,
      shadowNormalBias: 0.019,
      shadowRadius: 5.3
    },

    /** The set the body stands on. */
    stage: {
      backdropTop: '#275403',
      backdropBottom: '#0e1f00',
      /** A halo on the backdrop that stays behind the body as the camera orbits. */
      backdropGlow: '#004216',
      glowStrength: 0.5,
      glowSpread: 0.28,

      floorColor: '#090c11',
      floorRoughness: 0.3,
      floorMetalness: 0.9,
      /** Radius of the plinth, metres. The floor fades out well inside it. */
      floorRadius: 2.55,

      ringColor: '#11fa00',
      ringIntensity: 1.51,

      contactShadow: 0.9,
      dust: 0.55
    },

    /**
     * The screen's own grade. Same fields as `post`, swapped in wholesale while
     * the character screen is up, so tuning the play stage's look never drags
     * this one with it.
     */
    post: {
      enabled: true,
      exposure: 0.49,
      bloomStrength: 0.02,
      bloomRadius: 0.86,
      bloomThreshold: 1.76,
      vignette: 1.5,
      chromaticAberration: 0.0,
      contrast: 1.15,
      saturation: 1.06,
      temperature: -0.02,
      lift: -0.004,
      gain: 1.0,
      grain: 0.0
    }
  }
};

/** Immutable snapshot used by "Reset to defaults" and the preset system. */
export const DEFAULT_SETTINGS = structuredClone(settings);

/**
 * Deep-merge a plain object into `settings` in place.
 * Existing object identity is preserved so every live binding keeps working.
 */
export function applySettings(patch, target = settings) {
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (target[key] && typeof target[key] === 'object') applySettings(value, target[key]);
    } else if (key in target) {
      target[key] = value;
    }
  }
  return target;
}

/** Restore every value to the shipped defaults (in place). */
export function resetSettings() {
  applySettings(structuredClone(DEFAULT_SETTINGS));
}

/** Serialisable clone of the current state. */
export function snapshotSettings() {
  return structuredClone(settings);
}
