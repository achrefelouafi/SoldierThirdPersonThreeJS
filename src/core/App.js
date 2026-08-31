import { Vector3 } from 'three';

import { Renderer } from './Renderer.js';
import { Time } from './Time.js';
import { CameraRig } from './CameraRig.js';
import { PointerLook } from './PointerLook.js';
import { Input } from './Input.js';
import { frame } from './FrameUniforms.js';

import { Environment } from '../world/Environment.js';
import { Atmosphere } from '../world/Atmosphere.js';
import { Sky } from '../world/Sky.js';
import { Moon } from '../world/Moon.js';
import { Ground } from '../world/Ground.js';
import { Terrain } from '../world/Terrain.js';
import { GroundFog } from '../world/GroundFog.js';
import { Leaves } from '../world/Leaves.js';
import { ContactShadows } from '../world/ContactShadows.js';

import { AssetLoader } from '../loaders/AssetLoader.js';
import { CharacterController } from '../animation/CharacterController.js';
import { ThirdPersonController } from '../animation/ThirdPersonController.js';
import { EnemyManager } from '../combat/EnemyManager.js';
import { Gunplay } from '../combat/Gunplay.js';

import { PostProcessing } from '../postprocessing/PostProcessing.js';
import { BloodBurst } from '../vfx/BloodBurst.js';
import { Ascendance } from '../vfx/Ascendance.js';
import { ShadowBoost } from '../vfx/ShadowBoost.js';
import { ShadowDash } from '../vfx/ShadowDash.js';
import { SwordCombo } from '../vfx/SwordCombo.js';
import { RunicBeam } from '../vfx/RunicBeam.js';
import { CrimsonRite } from '../vfx/CrimsonRite.js';
import { ShadowExecution } from '../vfx/ShadowExecution.js';
import { TargetRings } from '../vfx/TargetRings.js';
import { HealthBars } from '../vfx/HealthBars.js';
import { CharacterScreen } from '../screens/CharacterScreen.js';
import { findItem } from '../equipment/EquipmentCatalog.js';
import { LoadingScreen } from '../ui/LoadingScreen.js';
import { Editor } from '../ui/Editor.js';
import { Toast } from '../ui/Toast.js';
import { Stats } from '../ui/Stats.js';
import { ActionHUD } from '../ui/ActionHUD.js';
import { TargetHotkeys } from '../ui/TargetHotkeys.js';

import { settings } from '../config/settings.js';

const HDR_URL = './hdri/spruit_sunrise.hdr';

/** Where a thrown cut leaves the body, resolved per beat and never held. */
const _blade = new Vector3();

/**
 * Application root: owns every subsystem and the frame loop.
 *
 * The wiring is deliberately one-directional — App builds the systems and then
 * does nothing but order the per-frame updates. No subsystem reaches back into
 * App.
 *
 * What is on screen is a lit stage with a character standing on it: the key,
 * the rim, the air and the grade come from `config/settings.js`, and the body
 * loops its idle. Equipment goes on through the character screen (`Tab`), which is a second
 * scene the same body is moved into — see `screens/CharacterScreen.js`.
 *
 * There are therefore two modes, and exactly one thing switches between them:
 * `characterScreen.active` decides which scene the post pipeline draws, which
 * camera it draws it through, which grade block is in force, and which of the
 * two update paths runs. Neither mode knows about the other.
 */
export class App {
  constructor(canvas) {
    this.canvas = canvas;
    this.time = new Time();
    this.elapsed = 0;
    this.paused = false;
    this._raf = 0;

    /* ---- core ---- */
    this.renderer = new Renderer(canvas);
    this.rig = new CameraRig(canvas);
    this.camera = this.rig.camera;

    // The mouse, for the whole stage: a click takes it and it turns the view,
    // `Esc` gives it back for a menu (`core/PointerLook.js`). Built here rather
    // than inside the shooter because it is not the shooter's — the sword, the
    // summons and an empty hand all look around with it too. The gun's only
    // share is the sights, which slow the turn while they are up.
    this.pointerLook = new PointerLook({
      domElement: canvas,
      rig: this.rig,
      // The one place a cursor is wanted: the studio is a room you point at
      // things in. Every other panel — the editor, the chips along the bottom —
      // is reached by pressing `Esc` first, which is what makes one key the
      // answer everywhere.
      blocked: () => this.inCharacterScreen,
      sensitivity: () =>
        this.gunplay?.sighting ? settings.gunplay.camera.adsSensitivity : 1
    });

    this.environment = new Environment(this.renderer, this.camera);
    this.scene = this.environment.scene;

    /* ---- world ---- */
    // The air comes first because almost everything else is shaded through it:
    // the ground and the sky both bind the same uniform block, which is what
    // keeps the horizon and the haze one colour instead of two.
    this.atmosphere = new Atmosphere();
    this.sky = new Sky(this.atmosphere);
    // The body in that sky. It hangs itself at the angles the sky resolves, so
    // it is only ever as right as the sky is — and it takes the sky's own disc
    // off the moment its maps are in (see `world/Moon.js`).
    this.moon = new Moon();
    // Then the terrain, because it is the surface everything else is placed on:
    // the floor mesh is displaced by it, and the character, camera and shadow
    // focus all read it on the CPU.
    this.terrain = new Terrain();
    this.ground = new Ground(this.environment, {
      terrain: this.terrain,
      atmosphere: this.atmosphere
    });
    // After the ground, because it reads the floor's own baked height field —
    // that shared texture is what lets a puff blowing across a hollow go down
    // into the hollow for the price of one fetch.
    this.groundFog = new GroundFog({
      terrain: this.terrain,
      cache: this.ground.cache,
      atmosphere: this.atmosphere
    });
    // What is actually lying on that floor. Both populations read the same
    // baked height field the floor is displaced by, so the litter lies flat on
    // the slope the ground is drawing rather than on a guess at it — and the
    // meshes themselves are not built until the sheet is in (`load`), so a
    // failed download costs a warning and nothing else.
    this.leaves = new Leaves({
      terrain: this.terrain,
      cache: this.ground.cache,
      environment: this.environment,
      atmosphere: this.atmosphere
    });
    this.contactShadows = new ContactShadows(this.renderer, {
      size: 2.6,
      height: 2.4,
      blur: 2.0,
      terrain: this.terrain
    });

    this.scene.add(
      this.sky.mesh,
      this.moon.mesh,
      this.ground.mesh,
      this.groundFog.mesh,
      this.leaves.group,
      this.contactShadows.group
    );

    /* ---- character ---- */
    this.character = new CharacterController(this.environment);
    this.scene.add(this.character.root);

    this.input = new Input();
    this.controller = new ThirdPersonController(this.character, this.input, this.rig);

    /* ---- combat ---- */
    // What a body cut in half throws off. A pool with nothing in it until
    // something is cut, and it runs on the *simulation's* clock, so a burst is
    // held by the hit-stop of the blow that caused it.
    this.blood = new BloodBurst();
    this.scene.add(this.blood.mesh);

    // The bodies to kick. The rig they clone is loaded in `load()`; until then
    // this is an empty field, and everything that reads it copes with that.
    // A body decides nothing about how a cut *looks* — it only says where and
    // how hard it bleeds, and this draws it.
    this.enemies = new EnemyManager({
      terrain: this.terrain,
      effects: {
        onBlood: (point, direction, count, speed) =>
          this.blood.emit(point, direction, count, speed)
      }
    });
    this.scene.add(this.enemies.group);
    this.controller.setEnemies(this.enemies);

    // Who a press would actually go to, drawn on the ground. It is told what to
    // mark and works nothing out itself — the answer comes from the same call
    // the attacks lock their targets with (`_updateTargetRings`).
    this.targetRings = new TargetRings({ terrain: this.terrain });
    this.scene.add(this.targetRings.mesh);

    /**
     * Who each enabled attack has locked this frame: body → the config keys of
     * the moves that would take it. Rebuilt in place every frame, and the ring
     * and the key caps are both drawn straight off it.
     * @type {Map<object, string[]>}
     */
    this._locked = new Map();
    /** Which of those keys would fire right now, rather than merely aim. */
    this._readyMoves = new Set();
    /** Key lists handed back by dead entries, so a frame allocates nothing. */
    this._keyLists = [];

    /**
     * Seconds of hit-stop left to run.
     *
     * The oldest impact trick there is: on contact the whole simulation drops
     * to a crawl for a few dozen milliseconds, so the frame the foot lands is
     * held long enough to be *seen*. It is deliberately a scale on `dt` rather
     * than a pause — the animation, the ragdoll and the mist all slow together,
     * which is what makes it read as weight rather than as a dropped frame.
     *
     * The scale is taken from whichever move landed rather than read per frame:
     * a slash stops the world harder and for longer than a kick, and the
     * blow it belongs to is over by the time the freeze runs out.
     */
    this._hitStop = 0;
    this._hitStopScale = 1;

    // The odd one out: it is not aimed at anybody, it does not
    // hit anything, and what it leaves behind is ten seconds rather than a
    // corpse. It needs the ground for its circle to lie on and somewhere to
    // send the knock its arrival puts on the lens — nothing else, because
    // nothing else in the world is involved. What the boon *does* is spent from
    // `_syncBoon` and `_onStrike`; this only says whether it is up.
    this.ascendance = new Ascendance({
      terrain: this.terrain,
      onManifest: (shake) => this.rig.shake(shake),
      onExpire: () => this.toast.show('The light leaves you')
    });
    this.scene.add(this.ascendance.group);

    // And its opposite: the same bargain — no aim, no target, a duration for a
    // payload — arrived at from the other direction. It needs exactly what the
    // light needs and for the same reasons: the ground for its pool and its
    // rings to lie on, and somewhere to send the knock its arrival puts on the
    // lens. What its boon is worth is spent from `_syncBoon` and `_onStrike`
    // alongside the light's; this only says whether it is up.
    this.shadowBoost = new ShadowBoost({
      terrain: this.terrain,
      onErupt: (shake) => this.rig.shake(shake),
      onExpire: () => this.toast.show('The dark goes back into the ground')
    });
    this.scene.add(this.shadowBoost.group);

    // Everything the three-hit combo (`Z`) throws. Unlike the two above it arms
    // nothing and decides nothing: it is dressing for an ordinary attack, and it
    // is here rather than inside that attack because `animation/Attack.js` knows
    // only which frame a blow is on. What a blow *looks like* has never been its
    // business.
    //
    // `onWound` is the half of the move the animation cannot express: a thrown
    // cut takes time to arrive, so the first two beats are dealt on the frame
    // the crescent lands rather than on the frame the sweep played.
    this.swordCombo = new SwordCombo({
      terrain: this.terrain,
      onWound: (enemy, x, z) => this._onComboWound(enemy, x, z)
    });
    this.scene.add(this.swordCombo.group);

    // And the half of that move which happens on the *body* rather than out in
    // front of it: for the four tenths of a second the dash is running, the
    // character is a shade of itself rather than the character.
    // It dresses whatever the body is wearing rather than drawing anything of
    // its own, so it has nothing to add to the scene — and it is pointed at the
    // combo's own attack in the frame loop, which is the only thing that says
    // when a dash is happening.
    this.shadowDash = new ShadowDash(this.character, {
      config: () => settings.swordCombo.shadowDash
    });

    // And everything the unmaking (`B`) calls up. On the same terms as the
    // combo and for the same reason: it is dressing for an ordinary attack
    // whose two beats happen not to be punches, and it arms nothing and decides
    // nothing. It is handed the height field because the rune it opens is
    // struck into the *ground* under a body rather than hung over one, and a
    // circle three metres across on a slope has to lie on it.
    this.runicBeam = new RunicBeam({ terrain: this.terrain });
    this.scene.add(this.runicBeam.group);

    // And the crimson rite (`V`) — dressing for an ordinary attack again, on
    // the same terms as the two above. It wants the height field for the same
    // reason the beam does: the ink and the shock rings are struck into the
    // *ground* under a body rather than hung over one.
    //
    // Two things here are unlike anything else in the frame loop. The first is
    // `blade`: the rite borrows the katana off the equipment library, which
    // does not exist until `load()` has built the character screen — so it is a
    // provider, asked on the first cast, exactly as the gun asks for its
    // loadout. The second is that this is the only move whose blows are *not*
    // all frames in a clip: the clip marks two, and the three thrusts and the
    // tear-out happen on the rite's own clock afterwards. Those four come back
    // through `onStab` and `onRend`, which land on the same two paths every
    // other attack goes through.
    this.crimsonRite = new CrimsonRite({
      terrain: this.terrain,
      blade: () => this.characterScreen?.equipment?.get('sword')?.model ?? null,
      onStab: (enemy, x, z) => this._onRiteStab(enemy, x, z),
      onRend: (enemy, x, z) => this._onStrike(enemy, x, z, settings.crimsonRite),
      onShake: (metres) => this.rig.shake(metres)
    });
    this.scene.add(this.crimsonRite.group);

    // And the shadow execution (`C`) — the second move built the rite's way,
    // and the second to borrow the katana off the equipment library. Same two
    // deferred things: a `blade` provider rather than a model, because the
    // equipment does not exist until `load()` has built the character screen,
    // and blows that are not frames in a clip. Its clip marks two beats; the
    // impact and the tear-out happen seconds later on the ability's own clock
    // and come back through `onImpale` and `onSever`, which land on the same
    // two paths every other attack goes through.
    this.shadowExecution = new ShadowExecution({
      terrain: this.terrain,
      blade: () => this.characterScreen?.equipment?.get('sword')?.model ?? null,
      onImpale: (enemy, x, z) => this._onExecutionImpale(enemy, x, z),
      onSever: (enemy, x, z) => this._onStrike(enemy, x, z, settings.shadowExecution),
      onShake: (metres) => this.rig.shake(metres)
    });
    this.scene.add(this.shadowExecution.group);

    // The shooter. Dormant until the rifle is the weapon in the hand, and from
    // that moment it owns four things nothing else does: where the lens sits,
    // where the reticle's ray lands, which way the torso points and what the
    // trigger costs (`combat/Gunplay.js`). It *asks* for the loadout rather than
    // holding one — neither the weapons nor the gear exist until `load()`
    // builds the character screen.
    this.gunplay = new Gunplay({
      camera: this.camera,
      rig: this.rig,
      character: this.character,
      controller: this.controller,
      enemies: this.enemies,
      terrain: this.terrain,
      weapons: () => this.characterScreen?.weapons ?? null,
      equipment: () => this.characterScreen?.equipment ?? null,
      look: this.pointerLook,
      // The one thing that wants the body and the ground back. The gun does not
      // argue with it: it simply stands down and lets the lens come back off the
      // shoulder. The pointer is not in that list — it belongs to the stage.
      blocked: () => this.inCharacterScreen,
      onBlood: (point, direction, count, speed) =>
        this.blood.emit(point, direction, count, speed),
      // A gun kill freezes the world too, and for the same reason a kick does —
      // but the freeze itself belongs to the frame loop, which is here.
      onHitStop: (seconds, scale) => {
        this._hitStop = Math.max(this._hitStop, seconds);
        this._hitStopScale = scale;
      }
    });
    this.scene.add(this.gunplay.group);

    // What the rifle leaves on screen that no melee blow ever could: a body
    // shot twice is a body with a question over it, and this is the answer. It
    // is built after the gun because it is the gun's — it comes up when the
    // rifle is drawn and fades when it is put away (`vfx/HealthBars.js`).
    this.healthBars = new HealthBars();
    this.scene.add(this.healthBars.mesh);

    /**
     * A blow's force, with the boon's weight already in it.
     *
     * Rebuilt in place per landed hit rather than allocated, and only reached
     * for while `ascendance` is up — with no boon the move's own settings block
     * is handed straight through, which is what keeps the common case exactly
     * as it was before the ability existed. See `_strikeForce`.
     */
    this._boonForce = { impulse: 0, lift: 0, spin: 0, slices: false, unmake: null };

    /* ---- post ---- */
    this.post = new PostProcessing(this.renderer, this.scene, this.camera);

    /* ---- UI ---- */
    this.loading = new LoadingScreen();
    this.toast = new Toast();
    this.stats = new Stats();
    // The moves and their keys, along the bottom — one panel per category. Fed a
    // state per ability every frame from `_syncAbilities`; it decides nothing.
    // The one chip that is also a control routes its click back here, so the
    // weapon swap is a button and a key saying the same thing.
    this.actionHUD = new ActionHUD({ onPress: (id) => this._onAction(id) });
    // The same answer as the ring, over the head instead of under the feet: the
    // ring says which body, these say with which key. Fed from
    // `_updateTargetRings` — it resolves nothing of its own either.
    this.targetHotkeys = new TargetHotkeys({ camera: this.camera, domElement: this.canvas });
    this.editor = new Editor({
      onToast: (message) => this.toast.show(message),
      onRespawnEnemies: () => {
        this.enemies.respawnAll();
        this.toast.show('A fresh ring of them');
      },
      onCastAscendance: () => this._castAscendance(),
      onCastShadowBoost: () => this._castShadowBoost()
    });

    /**
     * The equipment studio. Built in `load()`, because it needs the rig's
     * skeleton and material palette — neither exists until the character is in.
     * @type {CharacterScreen|null}
     */
    this.characterScreen = null;

    this._bindEvents();
  }

  /** Whether the equipment studio is the thing on screen. */
  get inCharacterScreen() {
    return this.characterScreen?.active === true;
  }

  /* ------------------------------------------------------------------ */

  _bindEvents() {
    this.renderer.onResize((width, height, pixelRatio) => {
      this.rig.resize(width, height);
      this.post.setSize(width, height, pixelRatio);
      this.characterScreen?.resize(width, height, pixelRatio);
    });

    this._onKeyDown = (event) => {
      // Ignore keys typed into a panel's own fields — the equipment inspector
      // is full of number boxes, and most of these keys are characters in them.
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      switch (event.code) {
        case 'KeyP':
          this.paused = !this.paused;
          this.toast.show(this.paused ? 'Paused — the editor still applies' : 'Resumed');
          break;
        case 'KeyG':
          // A panel full of sliders opened under a captured pointer is a panel
          // nothing can reach, so opening it hands the cursor back — the same
          // thing `Esc` does, done for the player at the moment they have
          // clearly asked for it. Closing it takes nothing: the next click on
          // the canvas is what says they are done.
          if (this.editor.toggle()) this.pointerLook.release();
          break;
        case 'KeyF':
          this.stats.toggle();
          break;
        case 'Tab':
          // The browser would move focus into the editor's fields otherwise,
          // and the next press would be typed into a number box instead.
          event.preventDefault();
          this.toggleCharacterScreen();
          break;
        case 'Digit1': {
          // A toggle, so a held key would swap the weapon every frame.
          if (event.repeat) break;
          this._switchWeapon();
          break;
        }
        case 'KeyH': {
          // The same toggle discipline, and the same reason.
          if (event.repeat) break;
          this._swapShoulder();
          break;
        }
        case 'KeyN': {
          // One of the two abilities with nothing to aim, so it is one of the
          // two a single press casts outright. Held down it would try again
          // every frame and be refused every frame, which is a lot of nothing.
          if (this.inCharacterScreen || event.repeat) break;
          this._castAscendance();
          break;
        }
        case 'KeyM': {
          // The other one, and the same discipline for the same reason.
          if (this.inCharacterScreen || event.repeat) break;
          this._castShadowBoost();
          break;
        }
        case 'Escape':
          // The pointer first, whatever else this press means. The browser
          // gives it back on `Esc` on its own — and swallows the `keydown`
          // while doing so, which is why this is here for the case where it
          // does not rather than as the way it usually happens.
          this.pointerLook.release();
          if (this.inCharacterScreen) this.characterScreen.exit();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', this._onKeyDown);
  }

  /* ------------------------------------------------------------------ */

  /**
   * A chip along the bottom was clicked.
   *
   * The clickable ones are the plain switches (`press` in `config/abilities.js`),
   * and a click means exactly what the key means — so this routes to the same
   * place the key handler does rather than growing a second path that can
   * disagree with it.
   *
   * @param {string} id ability id
   */
  _onAction(id) {
    if (id === 'weapon') this._switchWeapon();
    else if (id === 'shoulder') this._swapShoulder();
    else if (id === 'customize') this.toggleCharacterScreen();
    else if (id === 'ascendance') this._castAscendance();
    else if (id === 'shadowBoost') this._castShadowBoost();
  }

  /**
   * Refuse a boon that is being thrown out of the air, and say so.
   *
   * Both boons come out of the ground the body is standing on — a shaft of
   * light onto it, a column of dark up through it — so neither has anywhere to
   * land while the feet are off it. The check lives here rather than in the
   * two casts because it is the same question asked twice, and a silent
   * refusal mid-jump reads as a dropped key.
   *
   * @returns {boolean} true when the press should be spent on a line of text
   */
  _groundedOnly() {
    const jump = this.character.jump;
    const hop = this.character.hop;
    if (!jump?.locked && !hop?.locked) return false;
    this.toast.show('Not in the air — a boon needs the ground under you');
    return true;
  }

  /**
   * Call the light down on yourself.
   *
   * The only cast in the game that asks no question first: there is no body to
   * mark, no cone to be inside and no reach to be within, because the thing it
   * lands on is already standing here. So every refusal it can give is about
   * *when* rather than about where, and each of them costs a line of text —
   * a press that did nothing at all would read as a dropped key.
   */
  _castAscendance() {
    // The editor's button reaches this from either stage, and there is nothing
    // on the set for a shaft of light to come down onto — nor a frame loop that
    // would advance it if there were.
    if (this.inCharacterScreen) {
      this.toast.show('Not in here — the light needs the stage');
      return;
    }
    if (this._groundedOnly()) return;
    if (!settings.ascendance.enabled) {
      this.toast.show('Ascendance is switched off in the editor');
      return;
    }
    if (this.ascendance.active) {
      this.toast.show(
        this.ascendance.held
          ? `The light is already on you — ${Math.ceil(this.ascendance.remaining)}s`
          : 'It is already coming down'
      );
      return;
    }

    const position = this.character.position;
    const groundY = this.terrain.heightAt(position.x, position.z);
    if (!this.ascendance.cast(position.x, groundY, position.z)) return;
    this.toast.show(`Ascendance — ${settings.ascendance.duration}s of it, once the light lands`);
  }

  /**
   * Call the dark up out of the ground under yourself.
   *
   * The same shape as `_castAscendance` line for line, because it is the same
   * *kind* of cast: nothing to aim, nothing to be in reach of, and therefore
   * nothing to refuse for except *when*. The two boons are deliberately not
   * exclusive — holding both at once is expensive in seconds and should be
   * worth what it costs, and `_might` multiplies them.
   */
  _castShadowBoost() {
    // The editor's button reaches this from either stage, and there is nothing
    // on the set for a column of shadow to come up through — nor a frame loop
    // that would advance it if there were.
    if (this.inCharacterScreen) {
      this.toast.show('Not in here — the dark needs ground to come out of');
      return;
    }
    if (this._groundedOnly()) return;
    if (!settings.shadowBoost.enabled) {
      this.toast.show('Shadow Boost is switched off in the editor');
      return;
    }
    if (this.shadowBoost.active) {
      this.toast.show(
        this.shadowBoost.held
          ? `The dark is already on you — ${Math.ceil(this.shadowBoost.remaining)}s`
          : 'It is already coming up'
      );
      return;
    }

    const position = this.character.position;
    const groundY = this.terrain.heightAt(position.x, position.z);
    if (!this.shadowBoost.cast(position.x, groundY, position.z)) return;
    this.toast.show(
      `Shadow Boost — ${settings.shadowBoost.duration}s of it, once the column is through`
    );
  }

  /**
   * Cross the lens to the other shoulder.
   *
   * Answered even with the sword out — the setting is real either way and the
   * rig will be standing on that side the moment the gun comes up — but the
   * line of text says which case it is, because a camera move nobody can see
   * happening reads as a dropped key.
   */
  _swapShoulder() {
    const side = this.gunplay.swapShoulder();
    this.toast.show(
      this.gunplay.drawn
        ? `Over the ${side} shoulder`
        : `Over the ${side} shoulder — draw the rifle to see it`
    );
  }

  /**
   * Draw the other weapon.
   *
   * Works on both stages: the exchange is a property of the body, and the body
   * is on screen in either of them. Nothing else moves — the loadout is
   * untouched, both weapons stay mounted, and only which one is *visible*
   * changes (see `equipment/WeaponSwitch.js`).
   */
  _switchWeapon() {
    const weapons = this.characterScreen?.weapons;
    if (!weapons || weapons.switching) return;
    const previous = weapons.current;
    if (!weapons.toggle() || weapons.current === previous) return;
    this.toast.show(`${findItem(weapons.current)?.name ?? weapons.current} in hand`);
  }

  /**
   * Swap between the play stage and the equipment studio.
   *
   * Everything mode-dependent is resolved from `inCharacterScreen` in `frame()`,
   * so this only has to move the character, park the world's controls and say
   * which view the post stack draws.
   */
  toggleCharacterScreen() {
    const screen = this.characterScreen;
    if (!screen) return;

    // Leaving goes through the screen's own exit path, so the panel's close
    // button and this key land in exactly the same place (`_onScreenExit`).
    if (screen.active) {
      screen.exit();
      return;
    }

    screen.enter();
    // The boon stands *on* the body rather than out in the world, and is
    // therefore the one thing that would come along. It must not: a column of
    // light twenty-six metres tall is not a thing to judge a pauldron against.
    this.ascendance.dismiss({ immediate: true });
    // And the other one, for the same reason and rather more so: a column of
    // shadow standing on the turntable would not only compete with the
    // pauldron being judged, it would be *darkening* it.
    this.shadowBoost.dismiss({ immediate: true });
    // And any cut still in the air. Nothing it was thrown at exists on the set,
    // and a crescent left crossing an empty stage would be the first thing the
    // studio's lens found.
    this.swordCombo.clear();
    // And the shade off the body, which is the one thing the combo leaves
    // *on* the character: the studio has its own update path, so a dash
    // interrupted by the screen would leave the body half burnt away and
    // nothing would ever finish putting it back.
    this.shadowDash.clear();
    // And the beam, along with the rune under it. Both are struck into ground
    // that does not exist on the set, and a column of void standing in an
    // equipment studio is not a look anybody asked for.
    this.runicBeam.dismiss({ immediate: true });
    // And the rite, which is the same case three times over: ink standing in
    // ground the set does not have, shock rings on a floor that is not there,
    // and three katanas hanging in the air where the body they were called
    // against used to be.
    this.crimsonRite.dismiss({ immediate: true });
    // And the execution, which is the rite's case over again and rather more of
    // it: a column standing in ground the set does not have, a shockwave on a
    // floor that is not there, and five katanas circling the spot where the
    // body they were called against used to be.
    this.shadowExecution.dismiss({ immediate: true });
    // And the rifle's own layers, which are the one thing on the body that is
    // not driven from the frame loop's play branch: the studio has its own
    // update path, so a torso left twisted toward a reticle in another scene
    // would be the pose every placement was then judged against.
    this.character.rifle?.cancel();
    // Nothing to be in reach of on the set, and the rings are not simulated
    // while it is up — so they come off now rather than being left mid-fade.
    this.targetRings.clear();
    this.targetHotkeys.clear();
    this.healthBars.clear();
    // And the pointer, which the stage captures. The studio is a place you
    // point at things with a cursor, and the frame loop returns before
    // `PointerLook#update` would have handed it back on its own.
    this.pointerLook.release();
    this.gunplay.standDown();
    this.rig.park(true);
    this.post.setView(screen.stage.scene, screen.camera.camera);
    this.toast.show('Character screen — drag to orbit · right-drag to pan · wheel to zoom');
  }

  /**
   * A blow landed on someone.
   *
   * Three things happen at once and they are all the same beat: the body is
   * handed to the ragdoll, the world nearly stops, and the lens takes a knock.
   * Any one of them alone reads as a bug; together they read as contact.
   *
   * All three are read off the move that landed, which is the whole difference
   * between the two attacks at the moment of impact — the kick's is a short,
   * flat shove, the slash's a longer freeze and a body in two pieces.
   *
   * @param {object} config the striking move's settings block
   */
  _onStrike(enemy, x, z, config) {
    const might = this._might();
    if (!this.enemies.kill(enemy, x, z, this._strikeForce(config, might))) return;
    this._hitStop = config.hitStop;
    this._hitStopScale = config.hitStopScale;
    // The lens is knocked harder too. It is the cheapest half of a boon and
    // very nearly the whole of what the player actually feels: a body thrown
    // further is something they watch, and a camera that jumps is something
    // that happens to them.
    this.rig.shake(config.shake * might);
  }

  /**
   * The blow, with the boon's weight in it.
   *
   * Only the three numbers a ragdoll is handed are touched — how hard it goes,
   * how far up, and how much the upper body takes — because those are the whole
   * of what "heavier" can mean to a body that is already dead. The freeze is
   * deliberately *not* scaled: hit-stop is pacing, and a buff that made every
   * kill hold the world for longer would make the fight slower while making the
   * character faster.
   *
   * @param {object} config the striking move's settings block
   * @param {number} might the multiplier from `_might`, 1 when nothing is up
   * @returns {object} `config` itself when there is no boon — the common case
   *   allocates nothing and changes nothing
   */
  _strikeForce(config, might) {
    if (might <= 1) return config;
    const force = this._boonForce;
    force.impulse = config.impulse * might;
    force.lift = config.lift * might;
    force.spin = config.spin * might;
    // Whether the blow comes apart is the move's own answer and never the
    // boon's: a kick does not start cutting people in half because the sky
    // opened. Nor does the beam stop unmaking what it takes because it does.
    force.slices = config.slices === true;
    force.unmake = config.unmake ?? null;
    return force;
  }

  /**
   * The boons' multiplier on a blow, each ramped in with its own power.
   *
   * There are two of them and they *multiply* rather than taking the larger.
   * That is a real decision and it is the right one: standing in both a column
   * of light and a column of shadow costs two casts and two seconds of standing
   * still, and a player who has paid for both should be handed something
   * absurd. Neither ability knows the other exists — this line is the only
   * place in the project where they meet.
   */
  _might() {
    const light = this.ascendance.power;
    const dark = this.shadowBoost.power;
    let might = 1;
    if (light > 0) might *= 1 + (settings.ascendance.might - 1) * light;
    if (dark > 0) might *= 1 + (settings.shadowBoost.might - 1) * dark;
    return might;
  }

  /**
   * Hand the boons to the body.
   *
   * The other half of what a boon is worth, and the half that is felt every
   * frame rather than on a landed hit. It is one number written onto the
   * controller — see `ThirdPersonController#speedScale` — which is deliberately
   * all the coupling there is: neither ability knows the character exists, and
   * the controller does not know what a boon is.
   *
   * The two stack the same way they do on a blow, and are worth very different
   * amounts here: the light is mostly haste, and the dark is barely any.
   */
  _syncBoon() {
    const light = this.ascendance.power;
    const dark = this.shadowBoost.power;
    let scale = 1;
    if (light > 0) scale *= 1 + (settings.ascendance.haste - 1) * light;
    if (dark > 0) scale *= 1 + (settings.shadowBoost.haste - 1) * dark;
    this.controller.speedScale = scale;
  }

  /**
   * One blow out of a move, routed to whichever thing it turns out to be.
   *
   * Most attacks land once and land in person, so `beat` is null and this is
   * `_onStrike` with an extra frame of indirection. The two that state `hits`
   * are the interesting ones, and between them they cover every shape a beat
   * can have:
   *
   *  - the combo's opening two are cuts being *thrown*, and what they do
   *    happens when they arrive rather than on the frame the sweep played;
   *  - the unmaking's first is a beat that does nothing at all to anybody — it
   *    opens a rune and stops;
   *  - and both moves' last beats are the body going down, by very different
   *    routes.
   *
   * The branch is on `kind` rather than on the move's identity, so a third
   * multi-hit clip would only have to describe its beats to get the same
   * treatment — nothing here knows either move by name.
   *
   * @param {object} config the striking move's settings block
   * @param {object|null} beat the `hits` entry that fired, for a move with any
   */
  _onBeat(enemy, x, z, config, beat) {
    if (beat?.kind === 'wave') {
      this.swordCombo.throwWave(this._bladePoint(), enemy, beat);
      return;
    }

    // The unmaking's first strike. It is the only beat in the game that reaches
    // a body and costs it nothing: the rune is a promise, and the thing that
    // keeps it is the beat below.
    if (beat?.kind === 'rune') {
      this.runicBeam.open(enemy);
      return;
    }

    // And its second. The column opens *before* the kill, so it is centred on a
    // body that is still standing on its own feet — a corpse's position is the
    // ragdoll's, and by the next frame it is already sliding out of the rune it
    // was supposed to be unmade in.
    if (beat?.kind === 'unmake') {
      this.runicBeam.fire(enemy);
    }

    // The rite's first beat, and the second thing in the game that reaches a
    // body and costs it nothing: the ink and the blades are a promise, exactly
    // as the rune is.
    if (beat?.kind === 'mark') {
      this.crimsonRite.mark(enemy);
      return;
    }

    // And its second — the last thing the *clip* decides about this move. From
    // here the rite runs on its own clock: three thrusts and a tear-out, each
    // landing when it lands and each reporting back through `onStab` or
    // `onRend`. So this returns rather than falling through to `_onStrike`
    // below, because nothing has been hit yet.
    if (beat?.kind === 'rite') {
      this.crimsonRite.cast(enemy);
      return;
    }

    // The execution's first beat — the third thing in the game that reaches a
    // body and costs it nothing. The dark and the ring of katanas are a
    // promise, exactly as the rune and the rite's ink are.
    if (beat?.kind === 'sever-mark') {
      this.shadowExecution.mark(enemy);
      return;
    }

    // And its second, which is the last thing the *clip* decides about this
    // move. From here it runs on its own clock: a wind-up, five points arriving
    // together, a hold and a tear-out, each reporting back through `onImpale`
    // or `onSever`. So this returns rather than falling through to `_onStrike`
    // below, because nothing has been hit yet.
    if (beat?.kind === 'sever-cast') {
      this.shadowExecution.cast(enemy);
      return;
    }

    // The finisher, and every other move in the game: the body goes down here.
    // The rift opens *before* the kill so it is centred on a body that is still
    // standing — a corpse's position is the ragdoll's, and by the next frame it
    // is already falling away from where the blade actually met it.
    if (beat?.kind === 'finish') {
      const position = enemy.position;
      this.swordCombo.finish(
        position.x,
        position.y + Math.max(0, config.wave.aimHeight),
        position.z,
        x,
        z,
        beat
      );
    }
    this._onStrike(enemy, x, z, config);
  }

  /**
   * A thrown cut reached somebody who is still standing.
   *
   * Deliberately not `_onStrike`: this is the *opening* of a combo, and the
   * body is meant to still be there for the finisher. So it spends health and
   * knocks the lens, and that is all — no hit-stop, because freezing the world
   * twice on the way to a third blow would make the move feel like three moves,
   * and no kill, because `settings.swordCombo.wound` is tuned so that two of
   * them cannot take a body to zero.
   *
   * If something else has already worn it down far enough that one of these
   * does finish it, it falls on the cut's own bearing with the move's own
   * force — the same path the finisher takes, so the corpse never comes apart
   * differently depending on which beat happened to be the last one.
   */
  _onComboWound(enemy, x, z) {
    const config = settings.swordCombo;
    if (!enemy?.alive) return;

    this.rig.shake(config.woundShake);
    if (enemy.wound(config.wound) !== 'down') return;
    this._onStrike(enemy, x, z, config);
  }

  /**
   * A summoned point reached a body that is still standing.
   *
   * The same shape as `_onComboWound` and for the same reason: this is a blow
   * on the way to a finisher, and the body has to still be there for it. So it
   * spends health and that is all — the lens is knocked by the rite itself
   * (`onShake`) rather than here, and there is deliberately no hit-stop,
   * because freezing the world three times on the way to a fourth blow would
   * make one move feel like four.
   *
   * `settings.crimsonRite.wound` is tuned so three of these cannot take a full
   * body to zero. If something else has already worn it down far enough that
   * one of them does finish it, it falls with the rite's own force — the same
   * path the tear-out takes, so the corpse never leaves differently depending
   * on which thrust happened to be the last one.
   */
  _onRiteStab(enemy, x, z) {
    const config = settings.crimsonRite;
    if (!enemy?.alive) return;
    if (enemy.wound(config.wound) !== 'down') return;
    this._onStrike(enemy, x, z, config);
  }

  /**
   * Five summoned points reached a body on the same frame.
   *
   * The same shape as `_onRiteStab` and for the same reason: this is a blow on
   * the way to a finisher, and the body has to still be there for it. It is one
   * call rather than five, because five points arriving together are one event
   * and not five — the rite's rhythm is the thing this move exists not to be.
   *
   * So it spends health and that is all. The lens is knocked by the execution
   * itself (`onShake`) rather than here, and there is deliberately no hit-stop:
   * freezing the world on the way to a finish that freezes it again would make
   * one move feel like two.
   *
   * `settings.shadowExecution.wound` is tuned so this cannot take a full body
   * to zero. If something else has already worn it down far enough that it
   * does, it falls with the execution's own force — the same path the tear-out
   * takes, so the corpse never leaves differently depending on which beat
   * happened to be the last one.
   */
  _onExecutionImpale(enemy, x, z) {
    const config = settings.shadowExecution;
    if (!enemy?.alive) return;
    if (enemy.wound(config.wound) !== 'down') return;
    this._onStrike(enemy, x, z, config);
  }

  /**
   * Where the edge is, for a cut about to leave it.
   *
   * The sword hand if the rig has one, which it does — read a frame late,
   * because the skeleton for this frame is posed in `character.update` and the
   * beat that asks for this fires in `controller.update` before it. At a hand's
   * speed through a sweep that is a few centimetres, and the crescent is thrown
   * along a line resolved from the *target* rather than from the hand, so the
   * only thing the staleness moves is where the launch flash sits.
   *
   * The fallback is the chest, which is where a viewer would say a cut came
   * from anyway if they had to guess.
   */
  _bladePoint() {
    const hand = this.character.getBone?.('RightHand');
    if (hand) {
      hand.getWorldPosition(_blade);
      return _blade;
    }
    const position = this.character.position;
    const yaw = this.character.facing;
    return _blade.set(
      position.x + Math.sin(yaw) * 0.5,
      position.y + this.character.height * 0.62,
      position.z + Math.cos(yaw) * 0.5
    );
  }

  /**
   * Light a ring under whoever a press would land on, and say which press.
   *
   * The question is asked one move at a time, and it is the move's *own*
   * question: `findTarget` with that move's range and cone, which is the exact
   * call `ThirdPersonController` makes on the press. So a body wears a ring
   * because a key would take it — not because it happens to be standing inside
   * some cone alongside three others the swing will never reach. Two rings can
   * still come up, and when they do they are telling the truth: the kick and
   * the slash have locked different bodies, and the caps over each head say
   * which key goes where.
   *
   * Every *enabled* attack is asked, rather than only the ones that could start
   * this instant: the moves lock each other out for the length of a swing (see
   * `Attack#canStart`), and a ring that blinked off for the half second the
   * body was busy would read as the target being lost. `ready` carries that
   * difference instead, and only dims the cap.
   *
   * That `ready` set is the single answer to "would this key do anything right
   * now", and three things are drawn off it: the cap over the head, the plate
   * along the bottom (`_syncAbilities`) and the press itself, which the
   * controller refuses on the same `findTarget` call. One answer, so a plate
   * cannot come up over a body no key would reach.
   *
   * @param {number} dt
   * @param {import('three').Vector3} position
   */
  _updateTargetRings(dt, position) {
    const locked = this._locked;
    const ready = this._readyMoves;

    // Every list back to the pool before the map is emptied — the map is the
    // only thing holding them.
    for (const keys of locked.values()) {
      keys.length = 0;
      this._keyLists.push(keys);
    }
    locked.clear();
    ready.clear();

    const facing = this.character.facing;
    for (const move of this.character.attacks ?? []) {
      if (!move.available || !move.config.enabled) continue;

      const enemy = this.enemies.findTarget(position, facing, move.config);
      if (!enemy) continue;

      // Mid-swing counts as ready: the cap should be lit on the move the body
      // is committed to, not dimmed the instant the key does its job.
      if (move.locked || move.canStart()) ready.add(move.configKey);

      let keys = locked.get(enemy);
      if (!keys) {
        keys = this._keyLists.pop() ?? [];
        locked.set(enemy, keys);
      }
      keys.push(move.configKey);
    }

    this.targetRings.update(dt, locked, this.elapsed);
    this.targetHotkeys.update(dt, locked, ready);
  }

  /**
   * Say which moves the player can reach right now.
   *
   * Every answer is asked of the thing that owns it — the moves' own
   * `canStart()`, the summons' own `active` — rather than re-derived here, so
   * the row cannot claim a key will work when the press would be swallowed.
   * The attacks report `off` while another one has the body, which is exactly
   * what a press would do.
   *
   * For the techniques that is only half the question: a move also needs
   * someone inside its range and its cone, or the controller spends the press
   * and walks on (`ThirdPersonController#update`). That half is not re-asked
   * here — `_readyMoves` was filled from the same `findTarget` call the press
   * itself makes, one pass earlier in this frame, and is already "in reach
   * *and* able to start". Asking it twice is how the plate and the key drift
   * into disagreeing about the frame a body crosses the edge of the cone.
   */
  _syncAbilities() {
    const jump = this.character.jump;
    const hop = this.character.hop;
    const state = {
      leap:
        jump?.locked || hop?.locked
          ? 'active'
          : jump?.canStart(this.controller.speed, this.input.running) || hop?.canStart()
            ? 'ready'
            : 'off',
      // Always open, and never `active`: the studio hides this row while it is
      // up (`body.cs-open .hud`), so the only state it can be seen in is ready.
      customize: 'ready',
      // Lit while the exchange is burning, which is also the window in which a
      // second press is refused — the chip says so rather than swallowing it.
      weapon: this.characterScreen?.weapons.switching ? 'active' : 'ready',
      // Lit while the shooter is actually up, dimmed while the key would still
      // work but nothing on screen would change: the setting is real with the
      // sword out, and the lens is simply not on a shoulder to be crossed.
      shoulder: this.gunplay.active ? 'active' : 'off',
      // Lit for the whole of it — the gather, the descent and the ten seconds —
      // because from the player's side those are one thing that is happening.
      // The chip's *name* is what separates them: it counts the boon down and
      // says nothing at all while the light is still on its way.
      ascendance: this.ascendance.active
        ? 'active'
        : settings.ascendance.enabled
          ? 'ready'
          : 'off',
      // And its opposite, on exactly the same rules: lit for the gather, the
      // eruption and the seconds after, because from the player's side those
      // are one thing that is happening.
      shadowBoost: this.shadowBoost.active
        ? 'active'
        : settings.shadowBoost.enabled
          ? 'ready'
          : 'off'
    };

    // The two chips that name a value rather than a move: what is in the hand,
    // and which side the lens is standing on.
    const drawn = this.characterScreen?.weapons.current;
    if (drawn) {
      this.actionHUD.setLabel('weapon', findItem(drawn)?.name ?? drawn);
    }
    this.actionHUD.setLabel(
      'shoulder',
      this.gunplay.shoulder === 'left' ? 'Left shoulder' : 'Right shoulder'
    );
    // The third chip that names a value: how much of the boon is left. Rounded
    // *up*, so it reads 1 for the whole of the last second and never spends a
    // frame saying 0 while the light is still standing on the body.
    const left = this.ascendance.remaining;
    this.actionHUD.setLabel('ascendance', left > 0 ? `Ascendance ${Math.ceil(left)}s` : 'Ascendance');
    // And the fourth, counting down the other boon on the same rule.
    const dark = this.shadowBoost.remaining;
    this.actionHUD.setLabel(
      'shadowBoost',
      dark > 0 ? `Shadow Boost ${Math.ceil(dark)}s` : 'Shadow Boost'
    );

    for (const move of this.character.attacks ?? []) {
      state[move.configKey] = move.locked
        ? 'active'
        : this._readyMoves.has(move.configKey)
          ? 'ready'
          : 'off';
    }

    this.actionHUD.update(state);
  }

  /** However the screen was closed, the play stage comes back here. */
  _onScreenExit() {
    // The orbit drag comes back with the stage; the pointer does not, and is
    // not taken back for the player either. They left this stage with a cursor
    // and they arrive with one — the next click on the canvas is what says
    // they are done pointing at things.
    this.rig.park(false);
    this.post.setView(this.scene, this.camera);
    this.toast.show('Back on the stage');
  }

  /* ------------------------------------------------------------------ */

  /** Load assets, warm the shader cache, then start the loop. */
  async load() {
    const assets = new AssetLoader();

    this.loading.setProgress(0.05, 'Loading environment…');
    const hdr = await assets.loadHDR(HDR_URL);
    await this.environment.loadEnvironment(hdr);
    frame.uEnvMap.value = this.environment.equirect;

    this.loading.setProgress(0.3, 'Loading the forest floor…');
    await this.ground.loadTextures(assets);
    // And what is lying on it. Before the shader warm-up below, so the two leaf
    // materials are compiled with everything else rather than on the first frame
    // a leaf is in shot.
    await this.leaves.load(assets, this.renderer);

    // Before the shader warm-up below, so the moon is compiled with the rest and
    // the first frame has a body in it rather than a disc that swaps a moment
    // later. If the maps fail the sky keeps its own disc and nothing else knows.
    await this.moon.load(assets);

    // One build before the first frame, so the ground is shaped when the
    // loading screen lifts rather than settling a frame into it. The floor
    // follows, because it is what re-bakes the height field the terrain has just
    // described (see `world/TerrainCache.js`) — and it has to happen before the
    // shader compile below, not on the first frame after it.
    this.terrain.update();
    this.ground.update(0, 0, 0);

    this.loading.setProgress(0.55, 'Loading character, materials & animations…');
    await this.character.load(assets);

    this.loading.setProgress(0.72, 'Waking the enemies…');
    await this.enemies.load(assets);
    // An attack knows the frame the blow lands and nothing else; what being hit
    // means is decided here. Each hands over its own settings block, so the
    // impact is the one the move was tuned with.
    //
    // A move that lands more than once also hands over the *beat* that fired,
    // and the combo is the only one that does. Its two opening beats are thrown
    // rather than landed, so they go somewhere else entirely — see `_onBeat`.
    for (const move of this.character.attacks) {
      move.onHit = (enemy, x, z, beat) => this._onBeat(enemy, x, z, move.config, beat);
    }
    // Stood up now rather than on the first frame, so their materials are in
    // the scene for the shader warm-up below.
    this.enemies.respawnAll();

    this.loading.setProgress(0.8, 'Building the character screen…');
    // The set and its rig cost nothing until they are drawn, and building them
    // now means `C` is instant. The equipment models themselves stay on disk
    // until the screen is opened — see `EquipmentLibrary`.
    this.characterScreen = new CharacterScreen({
      renderer: this.renderer,
      canvas: this.canvas,
      character: this.character,
      worldScene: this.scene,
      envMap: this.environment.envMap,
      onToast: (message) => this.toast.show(message),
      onExit: () => this._onScreenExit()
    });

    this.loading.setProgress(0.83, 'Equipping…');
    // The starting loadout — whatever was last dialled in on the set, or the
    // catalog's defaults on a first run. Gear hangs off the skeleton rather than
    // off either stage, so equipping here puts it on the body for the play scene
    // too, and a placement tuned in the screen is the one the world shows.
    await this.characterScreen.equipment.restoreOrDefaults();
    // Which of the weapons that puts on the body is actually drawn, and the
    // idle that goes with it. After the loadout, because there is nothing to
    // draw until the mounts exist — and with no burn, because the body has not
    // been on screen yet.
    this.characterScreen.weapons.restore();

    this.loading.setProgress(0.85, 'Compiling shaders…');
    // Compile everything up front so the first frame never stutters — both
    // stages, so opening the character screen is not its own first frame.
    await this.renderer.gl.compileAsync(
      this.characterScreen.stage.scene,
      this.characterScreen.camera.camera
    );
    await this.renderer.gl.compileAsync(this.scene, this.camera);

    // Every texture has decoded by now, so the blobs the character's embedded
    // images were served from can go.
    await assets.settled();
    assets.dispose();

    this.loading.setProgress(1, 'Ready');
    this.loading.hide();
    // The moves are named by the row along the bottom, so this only has to
    // cover what the row does not: the stick, and where to look for the rest.
    this.toast.show('WASD to move · Shift to run · your moves are along the bottom');

    this.start();
  }

  start() {
    this.time.reset();
    this.stats.reset();
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      this.frame();
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this._raf);
  }

  /* ------------------------------------------------------------------ */

  frame() {
    const gl = this.renderer.gl;
    // The counters still standing are the ones the *previous* frame ran up, and
    // they are about to be cleared — so the readout is fed here, where a frame
    // ends for certain, rather than at each of the several places one can end.
    this.stats.sample(gl.info.render);
    gl.info.reset();

    const raw = this.time.tick();
    // The impact freeze, spent in *real* time so it lasts as long on any frame
    // rate, and applied as a scale so everything slows together (see `_hitStop`).
    let scale = settings.global.timeScale;
    if (this._hitStop > 0) {
      this._hitStop = Math.max(0, this._hitStop - raw);
      scale *= this._hitStopScale;
    }
    const dt = this.paused ? 0 : raw * scale;
    this.elapsed += dt;

    /* ---- shared uniforms ---- */
    frame.uTime.value = this.elapsed;
    frame.uDelta.value = dt;
    frame.uCameraNear.value = this.camera.near;
    frame.uCameraFar.value = this.camera.far;

    // Before anything reads the view: whether the pointer is still ours, and
    // the one line that says how to get it back.
    this.pointerLook.update();

    // Which grade is in force. Everything downstream reads this one object.
    const look = this.inCharacterScreen ? this.characterScreen.postLook : settings.post;

    /* ---- simulation ---- */
    this.renderer.syncSettings(look);

    if (this.inCharacterScreen) {
      // The play stage is not simulated while the studio is up: its lights,
      // floor and mist are not on screen, and the body is not standing on it.
      this.characterScreen.update(dt, raw);

      gl.shadowMap.needsUpdate = true;
      this.post.sync(this.elapsed, look);
      this.post.render();
      return;
    }

    // Any terrain slider moved this frame lands here, before anything reads a
    // height — so the floor and the body both see the same landscape.
    this.terrain.update();
    // The air and the sky are one look, so they are re-read together. The sky
    // drops its own disc for as long as there is a body to draw instead, and the
    // body comes second because it hangs itself on the light direction the sky
    // has just resolved.
    this.atmosphere.update();
    this.sky.discEnabled = !this.moon.active;
    this.sky.update(this.elapsed);
    this.moon.update();

    // Before the stick, because it is what the stick is resolved against while
    // the rifle is out: the aim decides the heading the body has to hold and
    // the twist the torso carries, and a frame's lag on either would have the
    // body chasing a lens that was chasing it back.
    this.gunplay.aim(dt);

    // Before the stick as well, and for a plainer reason: the boon's haste is a
    // multiplier on the pace the stick asks for, so it has to be on the
    // controller before the controller is asked for a frame of movement.
    this._syncBoon();

    // Movement first: it sets the heading and the speed the blend animates to.
    // It only ever touches XZ; which is the whole reason the body can be dropped
    // onto the ground here without the controller knowing the ground exists.
    this.controller.update(dt);
    // Stand the character on the surface. The jump's arc lives inside the model
    // (it is the clip's own hips translation), so this stays the body's *ground*
    // height throughout and a leap over a valley still lands on the far side.
    const position = this.character.position;
    const groundY = this.terrain.heightAt(position.x, position.z);
    position.y = groundY;
    this.character.update(dt);

    // Before the bodies, not after: a blow landing this frame emits into this,
    // and a droplet has to be stamped with a clock the shader has already been
    // given or it is born a frame in the past.
    this.blood.sync(this.elapsed);

    // The bodies: their idles, their ragdolls and the ring they stand in. After
    // the character, because where the player is standing is what they watch,
    // what they are spawned around, and what the kick's reach was measured
    // against this frame.
    this.enemies.update(dt, position);
    // After them, so a body that has just been felled or has just walked out of
    // the cone loses its ring on the same frame it stops being a target.
    this._updateTargetRings(dt, position);
    // And what is left of each of them, while the gun is out. After the bodies
    // for the third time and the same reason: one felled this frame must not
    // still be wearing a bar on it.
    this.healthBars.update(dt, this.enemies.enemies, this.gunplay.active, this.camera);

    this.environment.setFocus(position.x, position.z, groundY);
    this.environment.update();
    // Gear rides the skeleton, so this is mostly the mounts' scale against a rig
    // the editor may have just re-normalised — plus the clock for any piece
    // that animates itself, which is why it takes the simulation's `dt`: a
    // rifle's ring slows with the hit-stop like everything else on the body.
    this.characterScreen?.equipment.update(dt);
    // And which weapon is in the hand. On the same clock and for the same
    // reason: a swap started a frame before a blow lands is part of the blow.
    this.characterScreen?.weapons.update(dt);
    // And the trigger, after both — the muzzle is a point on a model hanging
    // off a hand that has only just finished being posed and scaled, so a round
    // fired any earlier would leave the gun where it was last frame. The real
    // clock goes with the simulation's because the flash and the reticle are
    // the player's, not the world's: a hit-stop must not hold a muzzle flash on
    // screen for three times its life.
    this.gunplay.update(dt, raw);
    // The body's own shade, last of the body's followers: the mounts have their
    // final scale and the skeleton its final pose, and it reads the combo's clip
    // clock, which `controller.update` advanced at the top of the frame. On the
    // simulation's clock like the rest of the move — the return runs straight
    // through the finisher's hit-stop and is meant to slow with it, so the
    // character comes back *into* the blow.
    this.shadowDash.update(dt, this.character.swordCombo);
    // And the boon, which is the only one of them that is standing on the body:
    // it is handed where the feet are every frame, so the column travels with
    // the character rather than being left where it was cast.
    this.ascendance.update(dt, this.elapsed, position, groundY, this.character.height);
    // And the other boon, immediately after it and on the same clock, for every
    // reason the line above gives: it stands on the body, it travels with it,
    // and it is combat, so it slows with the hit-stop of the blows it is making
    // heavier. The two are independent all the way down — the only place they
    // meet is `_might`.
    this.shadowBoost.update(dt, this.elapsed, position, groundY, this.character.height);
    // And the combo's cuts, on the same clock as everything else the player
    // threw: a crescent still crossing the ground when the finisher lands slows
    // with the hit-stop that finisher caused, which is the only way the three
    // beats stay one move rather than becoming two that happen to overlap.
    this.swordCombo.update(dt, this.elapsed);
    // And the beam, on the same clock again — it *causes* the hit-stop it then
    // stands in, and the body burning away inside it is on that clock too, so
    // the two have to slow together or the column outlives what it was for.
    this.runicBeam.update(dt, this.elapsed);
    // And the rite, on the same clock once more — and it is the one that most
    // needs to be: it *causes* the hit-stop its own tear-out stands in, and the
    // body burning away inside it is on that clock too. It is also the only
    // thing in this list that can deal a blow from inside its own update, which
    // is exactly why it is here rather than anywhere else: by this line the
    // enemies have already been stepped, so a point that arrives this frame
    // meets a body that is where it says it is.
    this.crimsonRite.update(dt, this.elapsed);
    // And the execution, on the same clock and for all the same reasons — it
    // causes the hit-stop its own tear-out stands in, and the body coming apart
    // inside it is on that clock too.
    this.shadowExecution.update(dt, this.elapsed);

    // After everything that could have taken the body, so a chip lights on the
    // frame the move it names actually starts.
    this._syncAbilities();

    this.ground.update(this.elapsed, position.x, position.z);
    // After the floor, because the puffs stand on the height field the bake it
    // just refreshed describes.
    this.groundFog.update(this.elapsed, position);
    // And the leaves, for the same reason — they lie on that bake, and the
    // window of them follows the body that has just finished moving. The
    // velocity is what scatters them: it goes in raw, so a walk stirs the litter
    // and a sprint throws it, and standing still disturbs nothing.
    this.leaves.update(dt, this.elapsed, position, this.controller.velocity);

    /* ---- camera ---- */
    // The rig runs on *real* time so orbiting stays responsive while paused.
    this.rig.setAnchor(position.x, groundY, position.z);
    this.rig.update(raw);

    this.contactShadows.setPosition(position.x, position.z, groundY);
    this.contactShadows.render(this.scene);

    /* ---- render ---- */
    // Exactly one shadow map update per frame (see Renderer).
    gl.shadowMap.needsUpdate = true;
    this.post.sync(this.elapsed, look);
    this.post.render();
  }

  /* ------------------------------------------------------------------ */

  dispose() {
    this.stop();
    window.removeEventListener('keydown', this._onKeyDown);
    this.input.dispose();
    this.pointerLook.dispose();
    this.gunplay.dispose();
    this.ascendance.dispose();
    this.shadowBoost.dispose();
    this.swordCombo.dispose();
    this.shadowDash.dispose();
    this.runicBeam.dispose();
    this.crimsonRite.dispose();
    this.shadowExecution.dispose();
    this.targetRings.dispose();
    this.targetHotkeys.dispose();
    this.healthBars.dispose();
    this.enemies.dispose();
    this.blood.dispose();
    this.characterScreen?.dispose();
    this.character.dispose();
    this.sky.dispose();
    this.moon.dispose();
    this.ground.dispose();
    this.groundFog.dispose();
    this.leaves.dispose();
    this.terrain.dispose();
    this.contactShadows.dispose();
    this.post.dispose();
    this.environment.dispose();
    this.editor.dispose();
    this.toast.dispose();
    this.stats.dispose();
    this.actionHUD.dispose();
    this.rig.dispose();
    this.renderer.dispose();
  }
}
