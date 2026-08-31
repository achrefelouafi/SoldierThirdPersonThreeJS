import GUI from 'lil-gui';
import { settings } from '../config/settings.js';
import { LITTER_CELLS } from '../world/LeafLitter.js';
import { PresetManager } from './PresetManager.js';

/**
 * Real-time stage editor.
 *
 * Every control binds straight to a field in `config/settings.js`. Because the
 * lights, the floor shader, the dust, the camera rig and the post stack all
 * *read* those fields each frame, no controller needs an onChange handler:
 * moving a slider re-lights the scene on the next frame, with no rebuild and no
 * shader recompilation.
 *
 * That holds while the clock is paused (`P`) — which is the point, since the
 * pose worth lighting is usually a frozen one. The two exceptions are noted
 * where they occur: the floor's stone maps flip a shader define, and the
 * character's scale is resolved once at load.
 */
export class Editor {
  /**
   * @param {object} hooks { onToast, onRespawnEnemies, onCastAscendance,
   *   onCastShadowBoost }
   */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.presets = new PresetManager();

    this.gui = new GUI({ title: 'Stage Editor', width: 330 });
    this.gui.domElement.style.setProperty('--title-height', '30px');

    this._presetState = { name: 'My preset', selected: this.presets.names[0] ?? '' };
    this._hidden = false;

    this._buildPresets();
    this._buildEnvironment();
    this._buildAir();
    this._buildTerrain();
    this._buildLeaves();
    this._buildAscendance();
    this._buildShadowBoost();
    this._buildPost();
    this._buildCamera();
    this._buildCharacter();
    this._buildLocomotion();
    this._buildWeapons();
    this._buildGunplay();
    this._buildCombat();
    this._buildStudio();

    // Everything starts collapsed, top-level folders included: the panel opens
    // as a list of sections and the user picks one.
    this.gui.foldersRecursive().forEach((folder) => folder.close());
  }

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */

  static range(folder, object, key, min, max, step, label) {
    return folder.add(object, key, min, max, step).name(label ?? key);
  }

  /** Re-read every control from settings — after a preset load or a reset. */
  refresh() {
    this.gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
  }

  /** @returns {boolean} whether the panel is now on screen */
  toggle() {
    this._hidden = !this._hidden;
    this.gui.show(!this._hidden);
    return !this._hidden;
  }

  /* ------------------------------------------------------------------ */
  /* folders                                                             */
  /* ------------------------------------------------------------------ */

  _buildPresets() {
    const folder = this.gui.addFolder('Presets');
    const state = this._presetState;

    let selector = folder
      .add(state, 'selected', this.presets.names.length ? this.presets.names : [''])
      .name('preset');

    // lil-gui rebuilds the controller when the option list changes, so the
    // reference has to be replaced rather than mutated.
    const refreshOptions = () => {
      const names = this.presets.names;
      selector = selector.options(names.length ? names : ['']).name('preset');
      selector.setValue(names.includes(state.selected) ? state.selected : (names[0] ?? ''));
    };

    folder.add(state, 'name').name('name');

    folder
      .add(
        {
          save: () => {
            this.presets.save(state.name);
            state.selected = state.name;
            refreshOptions();
            this.hooks.onToast?.(`Saved preset "${state.name}"`);
          }
        },
        'save'
      )
      .name('Save preset');

    folder
      .add(
        {
          load: () => {
            if (this.presets.load(state.selected)) {
              this.refresh();
              this.hooks.onToast?.(`Loaded "${state.selected}"`);
            }
          }
        },
        'load'
      )
      .name('Load preset');

    folder
      .add(
        {
          duplicate: () => {
            const copy = this.presets.duplicate(state.selected);
            if (copy) {
              state.selected = copy;
              refreshOptions();
              this.hooks.onToast?.(`Duplicated to "${copy}"`);
            }
          }
        },
        'duplicate'
      )
      .name('Duplicate');

    folder
      .add(
        {
          remove: () => {
            if (this.presets.remove(state.selected)) {
              refreshOptions();
              this.hooks.onToast?.('Preset deleted');
            }
          }
        },
        'remove'
      )
      .name('Delete');

    folder
      .add({ exportOne: () => this.presets.exportJSON() }, 'exportOne')
      .name('Export current (JSON)');
    folder.add({ exportAll: () => this.presets.exportAll() }, 'exportAll').name('Export all presets');

    folder
      .add(
        {
          import: async () => {
            const result = await this.presets.importFromFile();
            refreshOptions();
            this.refresh();
            this.hooks.onToast?.(
              result.applied
                ? 'Settings imported'
                : result.imported.length
                  ? `Imported ${result.imported.length} preset(s)`
                  : 'Nothing imported'
            );
          }
        },
        'import'
      )
      .name('Import JSON…');

    folder
      .add(
        {
          reset: () => {
            this.presets.reset();
            this.refresh();
            this.hooks.onToast?.('Reset to defaults');
          }
        },
        'reset'
      )
      .name('Reset to defaults');

    this.presetFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  _buildEnvironment() {
    const folder = this.gui.addFolder('Environment');
    const e = settings.environment;
    const R = Editor.range;

    // The key and the rim are the character's own lights. three cannot exclude
    // an object from a light, so the world's surfaces are patched to drop every
    // directional light instead — see `Environment#excludeFromKeyLights`. Off,
    // and the pair go back to lighting the whole landscape.
    folder.add(e, 'keyCharacterOnly').name('key & rim: character only');
    R(folder, e, 'sunIntensity', 0, 8, 0.01, 'key intensity');
    folder.addColor(e, 'sunColor').name('key colour');
    R(folder, e, 'sunAzimuth', 0, Math.PI * 2, 0.01, 'key azimuth');
    R(folder, e, 'sunElevation', 0.05, 1.5, 0.01, 'key elevation');
    R(folder, e, 'ambientIntensity', 0, 3, 0.01, 'ambient');
    folder.addColor(e, 'ambientColor').name('ambient colour');
    R(folder, e, 'hemiIntensity', 0, 3, 0.01, 'hemisphere');
    R(folder, e, 'envIntensity', 0, 3, 0.01, 'env (IBL)');
    R(folder, e, 'shadowRadius', 0, 8, 0.05, 'shadow softness');
    R(folder, e, 'shadowBias', -0.01, 0.001, 0.0001, 'shadow bias');
    // The pair the character screen has always had and this one did not. Bias
    // works in depth and has to be re-dialled whenever `shadow box` moves; the
    // normal bias is in metres of world and does not. Speckle on a lit surface
    // wants this one raised, a shadow detaching from its feet wants it lowered.
    R(folder, e, 'shadowNormalBias', 0, 0.15, 0.001, 'shadow normal bias');
    R(folder, e, 'contactShadow', 0, 1.5, 0.01, 'contact shadow');
    // Half-width of the sun's shadow box. Bigger reaches further out for
    // casters and costs sharpness — the map is a fixed 4096², so this is
    // metres per texel in disguise. The distance below only has to be far
    // enough up-sun to clear the canopy; at a low elevation that is a long way.
    R(folder, e, 'shadowExtent', 12, 120, 1, 'shadow box (m)');
    R(folder, e, 'shadowDistance', 40, 400, 5, 'sun distance (m)');

    const rim = folder.addFolder('Rim light');
    R(rim, e, 'rimIntensity', 0, 4, 0.01, 'rim intensity');
    rim.addColor(e, 'rimColor').name('rim colour');
    R(rim, e, 'rimAzimuth', 0, Math.PI * 2, 0.01, 'rim azimuth');
    R(rim, e, 'rimElevation', 0.05, 1.5, 0.01, 'rim elevation');
    rim.addColor(e, 'hemiSkyColor').name('hemi sky');
    rim.addColor(e, 'hemiGroundColor').name('hemi bounce');

    // `tiled surface` flips USE_MAP, so it costs one shader recompile — fine for
    // an editor toggle, and free while it stays put. Switching sets downloads
    // the other one the first time it is picked.
    const floor = folder.addFolder('Stage floor');
    floor.add(e, 'floorTexture').name('tiled surface');
    floor.add(e, 'floorTextureSet', ['terrain', 'stone']).name('surface');
    R(floor, e, 'floorTextureScale', 0.5, 24, 0.1, 'tile size (m)');
    R(floor, e, 'floorNormalScale', 0, 3, 0.01, 'relief strength');
    R(floor, e, 'floorTexTint', 0, 1, 0.01, 'tint toward floor');
    floor.addColor(e, 'floorColor').name('floor colour');
    floor.addColor(e, 'floorTint').name('floor tint');
    R(floor, e, 'floorRoughness', 0.05, 1, 0.01, 'roughness');
    R(floor, e, 'floorSheen', 0, 1, 0.01, 'sheen');
    R(floor, e, 'floorPool', 0, 1, 0.01, 'light pool');
  }

  /* ------------------------------------------------------------------ */

  /**
   * Haze, sky and ground mist — one look, in one folder.
   *
   * They are together because they cannot be tuned apart. The sky's horizon *is*
   * the haze colour (bound by identity, which is why there is no control for it
   * under Sky); the mist is lit from the same moon direction the haze glows
   * along, and the moon's own angles live under Sky; and the ground fog's job is
   * to sit in front of a distance the haze has already dissolved. Move one and
   * the others are suddenly wrong.
   */
  _buildAir() {
    const folder = this.gui.addFolder('Air, sky & fog');
    const R = Editor.range;

    const h = settings.haze;
    const haze = folder.addFolder('Distance haze');
    haze.add(h, 'enabled').name('haze enabled');
    haze.addColor(h, 'color').name('haze colour');
    haze.addColor(h, 'sunColor').name('into-moon colour');
    // 1/m, so the number itself means very little; the readout under it is what
    // you actually aim.
    R(haze, h, 'density', 0, 0.03, 0.0002, 'distance haze (1/m)');
    R(haze, h, 'start', 0, 40, 0.5, 'clear air (m)');
    haze
      .add(
        {
          get halfAt() {
            const d = settings.haze.density;
            return d > 1e-5 ? Math.round(Math.LN2 / d + settings.haze.start) : 9999;
          }
        },
        'halfAt'
      )
      .name('half hidden at (m)')
      .listen()
      .disable();
    // The layer that pools in the hollows. `mist floor` is the world height it
    // sits on and `mist depth` is how fast it thins going up — between them
    // they decide whether it is a ground effect or a wall.
    R(haze, h, 'ground', 0, 0.12, 0.001, 'ground mist (1/m)');
    R(haze, h, 'base', -12, 12, 0.1, 'mist floor (m)');
    R(haze, h, 'falloff', 0.5, 40, 0.1, 'mist depth (m)');
    // How far the air goes toward the moon's colour looking down the beam. The
    // highest-value control in this folder: at 0 the haze is a flat wash from
    // every angle, which is the one thing real air never is.
    R(haze, h, 'inscatter', 0, 1, 0.01, 'moon inscatter');
    R(haze, h, 'sunPower', 1, 24, 0.1, 'inscatter tightness');
    R(haze, h, 'max', 0, 1, 0.01, 'haze ceiling');

    const s = settings.sky;
    const sky = folder.addFolder('Sky');
    sky.add(s, 'enabled').name('sky enabled');
    sky.addColor(s, 'zenith').name('zenith');
    R(sky, s, 'gradient', 0.1, 3, 0.01, 'gradient');
    R(sky, s, 'sunGlow', 0, 12, 0.05, 'moon glare');
    R(sky, s, 'sunGlowPower', 1, 60, 0.5, 'glare tightness');
    R(sky, s, 'broadGlow', 0, 3, 0.01, 'broad wash');
    R(sky, s, 'exposure', 0, 3, 0.01, 'sky exposure');

    // The moon. `disc size` is 1 - cos of the half-angle, so the numbers look
    // small — 0.006 is about six degrees across, which is a dozen times life
    // size and exactly what the reference is.
    const moon = sky.addFolder('Moon');
    // Where it hangs — and the world's one light direction with it: the sky's
    // glare, the haze's inscatter lobe and the mist's lit side all resolve from
    // this pair (`Sky#_placeMoon` writes `frame.uLightDir`). The character's key
    // is a *different* angle, over in Environment.
    //
    // Elevation is capped low on purpose. The rig cannot aim much above 30°
    // (`camera.maxPolar`), so a moon parked higher than this is off the top of
    // the frame and only its glare is ever on screen — which is exactly why it
    // used to be invisible at the old 0.72.
    R(moon, s.moon, 'azimuth', 0, Math.PI * 2, 0.01, 'rotation (azimuth)');
    R(moon, s.moon, 'elevation', -0.05, 0.6, 0.005, 'elevation');
    R(moon, s, 'disc', 0, 40, 0.1, 'brightness');
    R(moon, s, 'discSize', 0.0005, 0.05, 0.0005, 'size');
    moon.addColor(s.moon, 'color').name('colour');

    // The body — a displaced sphere wearing a real lunar surface material
    // (`world/Moon.js`). Off, and the sky goes back to drawing the disc itself,
    // which is the only thing the two `maria` sliders at the bottom still feed.
    const body = moon.addFolder('Surface');
    body.add(s.moon, 'geometry').name('textured body');
    // The body's own two masters. `brightness` above is `sky.disc`, which is
    // also the glare's and what the haze's lobe is sized against — these two
    // are the ones to reach for when the sphere itself is too hot or too solid,
    // because they move it and nothing else. Both at 1 is untouched.
    R(body, s.moon, 'brightness', 0, 3, 0.01, 'body brightness');
    R(body, s.moon, 'opacity', 0, 1, 0.01, 'body opacity');
    // The one control here that changes the picture rather than the finish:
    // where the moon's *own* sun is, from full through half to new.
    R(body, s.moon, 'phase', 0, Math.PI, 0.01, 'phase (full → new)');
    R(body, s.moon, 'phaseTilt', -1.2, 1.2, 0.01, 'phase tilt');
    R(body, s.moon, 'terminator', 0.005, 0.5, 0.005, 'terminator softness');
    R(body, s.moon, 'flatten', 0.1, 2, 0.01, 'limb flatness');
    R(body, s.moon, 'earthshine', 0, 0.4, 0.005, 'earthshine');
    R(body, s.moon, 'edge', 0.001, 0.4, 0.001, 'limb fade');
    R(body, s.moon, 'displacement', 0, 0.25, 0.005, 'relief (geometry)');
    R(body, s.moon, 'relief', 0, 1, 0.01, 'relief (normals)');
    R(body, s.moon, 'ao', 0, 1, 0.01, 'crater shadow (AO)');
    R(body, s.moon, 'sheen', 0, 0.5, 0.005, 'sheen');
    R(body, s.moon, 'textureScale', 0.2, 6, 0.05, 'crater scale');
    R(body, s.moon, 'blendSharpness', 1, 16, 0.5, 'projection blend');
    R(body, s.moon, 'tilt', -Math.PI, Math.PI, 0.01, 'face tilt');
    R(body, s.moon, 'spin', -Math.PI, Math.PI, 0.01, 'face spin');

    // Fallback disc only: with the body up, `Sky` is not drawing a disc at all.
    R(moon, s.moon, 'detail', 0, 1, 0.01, 'maria (disc only)');
    R(moon, s.moon, 'detailScale', 1, 24, 0.1, 'maria size (disc only)');

    // One hash per lattice cell, so the whole sky of them is about the price of
    // a single texture lookup. `density` is cells per unit direction: up packs
    // more in and shrinks each one.
    const stars = sky.addFolder('Stars');
    const st = s.stars;
    stars.add(st, 'enabled').name('stars enabled');
    R(stars, st, 'density', 40, 600, 5, 'density');
    R(stars, st, 'brightness', 0, 6, 0.05, 'brightness');
    R(stars, st, 'twinkle', 0, 1, 0.01, 'twinkle');
    R(stars, st, 'horizon', 0, 0.6, 0.01, 'gone below (sin elev)');

    this._buildGroundFog(folder);
  }

  /**
   * The mist that rolls over the ground — see `world/GroundFog.js`.
   *
   * A sub-folder of the air rather than a folder of its own, because it is the
   * near half of the same effect: the haze above dissolves the distance, and
   * this puts something between you and it that has a shape and moves.
   *
   * Everything here is live. `count` is the only control that touches a buffer,
   * and even that only reveals or hides slots that were allocated at boot — the
   * mist never rebuilds.
   */
  _buildGroundFog(parent) {
    const folder = parent.addFolder('Ground fog (emitter)');
    const f = settings.groundFog;
    const R = Editor.range;

    folder.add(f, 'enabled').name('enabled');
    // Density is `count` against `life`: a slot respawns the instant it dies, so
    // the emitter is releasing count/life puffs a second. `count` is also the
    // fill-rate dial — it is the first thing to turn down if the frame is tight.
    R(folder, f, 'count', 0, 512, 1, 'puffs (cost)');
    R(folder, f, 'life', 1, 60, 0.5, 'life (s)');
    R(folder, f, 'lifeVariance', 0, 0.95, 0.01, 'life spread');
    R(folder, f, 'opacity', 0, 1, 0.01, 'opacity');

    // Where it comes from. `follow` parks the emitter on the character, which is
    // what keeps mist around the camera on an endless floor; off, x/z are a
    // fixed world position and the bank stays in the hollow you put it in.
    const emitter = folder.addFolder('Emitter');
    emitter.add(f, 'follow').name('follow character');
    R(emitter, f, 'x', -200, 200, 0.5, 'x / offset X (m)');
    R(emitter, f, 'z', -200, 200, 0.5, 'z / offset Z (m)');
    R(emitter, f, 'radius', 0, 120, 0.5, 'spawn radius (m)');
    // The hole kept clear around the lens. Nothing else in this panel can fix a
    // puff sitting between you and the character: raise this until the closest
    // mist is behind the camera's own distance to them.
    R(emitter, f, 'nearFade', 0, 40, 0.25, 'clear of camera (m)');
    R(emitter, f, 'nearFadeRange', 0.5, 40, 0.25, 'clear ramp (m)');

    const drift = folder.addFolder('Drift');
    R(drift, f, 'windX', -8, 8, 0.05, 'wind X (m/s)');
    R(drift, f, 'windZ', -8, 8, 0.05, 'wind Z (m/s)');
    R(drift, f, 'rise', -1, 2, 0.01, 'rise (m/s)');
    R(drift, f, 'hover', -1, 8, 0.05, 'hover above ground (m)');
    R(drift, f, 'swirl', 0, 8, 0.05, 'wander (m)');
    R(drift, f, 'swirlSpeed', 0, 1.5, 0.01, 'wander speed');
    R(drift, f, 'spin', 0, 1, 0.005, 'roll (rad/s)');

    const look = folder.addFolder('Look');
    R(look, f, 'sizeStart', 0.2, 40, 0.1, 'size at birth (m)');
    R(look, f, 'sizeEnd', 0.2, 60, 0.1, 'size at death (m)');
    look.addColor(f, 'color').name('mist colour');
    look.addColor(f, 'litColor').name('into-moon colour');
    R(look, f, 'moonlight', 0, 1.5, 0.01, 'moonlight');
    R(look, f, 'moonPower', 0.5, 12, 0.1, 'moonlight tightness');
    R(look, f, 'softness', 0.02, 1, 0.01, 'edge softness');
    R(look, f, 'fadeIn', 0.01, 0.9, 0.01, 'fade in (of life)');
    R(look, f, 'fadeOut', 0.01, 0.9, 0.01, 'fade out (of life)');
    // What hides the line where a billboard crosses the terrain. Too small and
    // the cut shows; too large and the mist floats off the ground.
    R(look, f, 'groundFade', 0.05, 8, 0.05, 'dissolve into ground (m)');
    R(look, f, 'detail', 0, 1, 0.01, 'noise breakup');
    R(look, f, 'detailScale', 0.5, 12, 0.1, 'breakup size');
  }

  /* ------------------------------------------------------------------ */

  /**
   * The shape of the ground — see `world/Terrain.js`.
   *
   * Every control here is a shader uniform read by the floor *and* the CPU that
   * stands the character up, so the landscape can be redialled while walking
   * over it and the body keeps its feet on whatever comes out. The two that are
   * not free are called out below.
   */
  _buildTerrain() {
    const folder = this.gui.addFolder('Terrain');
    const t = settings.terrain;
    const R = Editor.range;

    folder.add(t, 'enabled').name('terrain enabled');
    R(folder, t, 'amplitude', 0, 20, 0.05, 'height (m)');
    R(folder, t, 'scale', 8, 200, 1, 'hill size (m)');
    // The one real cost dial: the floor evaluates this field five times per
    // vertex (the height and its normal), so an octave here is paid for by
    // every vertex of the grid.
    R(folder, t, 'octaves', 1, 6, 1, 'detail (cost)');
    R(folder, t, 'warp', 0, 2, 0.01, 'warp (valleys)');
    R(folder, t, 'ridge', 0, 1, 0.01, 'ridges');

    const shape = folder.addFolder('Fine shape');
    R(shape, t, 'lacunarity', 1.5, 3, 0.01, 'octave step');
    R(shape, t, 'gain', 0.2, 0.7, 0.01, 'octave falloff');
    R(shape, t, 'seed', 0, 60, 0.1, 'seed').listen();
    shape
      .add(
        {
          randomize: () => {
            t.seed = Math.random() * 60;
          }
        },
        'randomize'
      )
      .name('Randomise landscape');
    // The only control in this folder that rebuilds anything: it swaps the
    // floor's grid, which is a one-frame hitch and 400 m / segments of vertex
    // spacing. Below about 128 the hills go visibly faceted in silhouette.
    shape
      .add(t, 'segments', [64, 128, 192, 256, 384, 512, 768])
      .name('floor mesh detail')
      .onChange((value) => {
        this.hooks.onToast?.(`Floor grid: ${(400 / value).toFixed(2)} m between vertices`);
      });
  }

  /**
   * The litter on the floor and the leaves in the air — see `world/Leaves.js`.
   *
   * One folder, because they are one look: the sheet, the grade, the backlight
   * and the wind at the top are shared by both populations by identity, and only
   * the two sub-folders differ. Everything here is live — the one control that
   * recompiles is the coverage switch, and it is called out where it sits.
   *
   * The control worth reaching for first is `backlight`. Leaves are one cell
   * thick and they glow when the moon is behind them; at 0 they are opaque chips
   * and the whole field reads as stickers on the ground.
   */
  _buildLeaves() {
    const folder = this.gui.addFolder('Leaves');
    const g = settings.leaves;
    const R = Editor.range;

    folder.add(g, 'enabled').name('leaves enabled');
    R(folder, g, 'size', 0.02, 0.6, 0.005, 'leaf length (m)');
    R(folder, g, 'sizeVariance', 0, 0.9, 0.01, 'size spread');

    // The sheet is a daylight photograph of a green beech and this stage is a
    // blue night. Without this the leaves are the one summer-coloured thing in
    // the frame.
    const look = folder.addFolder('Grade & backlight');
    look.addColor(g, 'tint').name('tint toward');
    R(look, g, 'tintAmount', 0, 1, 0.01, 'tint amount');
    look.addColor(g, 'backlightColor').name('through-leaf colour');
    R(look, g, 'backlight', 0, 3, 0.01, 'backlight');
    R(look, g, 'backlightPower', 1, 24, 0.5, 'backlight tightness');
    R(look, g, 'roughness', 0.02, 1, 0.01, 'roughness');
    R(look, g, 'normalScale', 0, 3, 0.05, 'relief (normals)');

    // The cut-out. Lower is a fatter leaf and a rougher edge; the coverage
    // switch is what keeps that edge from crawling, and it is the only control
    // in this folder that recompiles. It does nothing until there is MSAA to
    // resolve against — raise `samples` under Post processing first.
    const cut = look.addFolder('Cut-out');
    R(cut, g, 'alphaTest', 0.05, 0.95, 0.01, 'alpha cutoff');
    cut
      .add(g, 'alphaToCoverage')
      .name('smooth edge (needs MSAA)')
      .onChange((value) => {
        if (value && (settings.post.samples ?? 0) === 0) {
          this.hooks.onToast?.('Smooth leaf edges need post → samples above 0');
        }
      });
    R(cut, g, 'atlasInset', 0, 0.15, 0.005, 'sheet inset');

    // One wind for both populations: it quivers the litter where it lies and
    // carries the leaves in the air, so a gust crosses the whole field at once.
    const wind = folder.addFolder('Wind');
    R(wind, g, 'windX', -8, 8, 0.05, 'wind X (m/s)');
    R(wind, g, 'windZ', -8, 8, 0.05, 'wind Z (m/s)');
    R(wind, g, 'gustSpeed', 0, 3, 0.01, 'gust speed');
    R(wind, g, 'gustScale', 0.005, 0.4, 0.005, 'gust size (rad/m)');
    R(wind, g, 'gustStrength', 0, 3, 0.01, 'gust strength');

    /* ---- the ground ---- */
    const l = g.litter;
    const litter = folder.addFolder('Litter (on the ground)');
    litter.add(l, 'enabled').name('litter enabled');
    // The two cost dials. Live like everything else — they only decide where
    // the leaves are laid out, so moving one re-lays the grid rather than
    // rebuilding a buffer. `perCell` × 400 is the leaf count.
    R(litter, l, 'perCell', 1, 20, 1, 'per cell (cost)');
    R(litter, l, 'field', 20, 120, 1, 'window (m)');
    litter
      .add(
        {
          get leaves() {
            return Math.round(settings.leaves.litter.perCell) * LITTER_CELLS * LITTER_CELLS;
          }
        },
        'leaves'
      )
      .name('leaves drawn')
      .listen()
      .disable();
    R(litter, l, 'hover', 0, 0.2, 0.002, 'float above floor (m)');
    R(litter, l, 'rustle', 0, 1, 0.01, 'wind quiver (rad)');
    // Keep `gone by` inside half the window, or the edge of the field itself
    // comes into view.
    R(litter, l, 'fadeStart', 2, 80, 0.5, 'erodes from (m)');
    R(litter, l, 'fadeEnd', 3, 100, 0.5, 'gone by (m)');

    // What a foot does to them. `push speed` is the dead band that stops the
    // leaves under a standing character boiling; `forward blend` is what turns
    // the throw from an explosion underneath you into a sweep.
    const push = litter.addFolder('Underfoot');
    R(push, l, 'pushRadius', 0.1, 3, 0.05, 'sweep radius (m)');
    R(push, l, 'pushLead', -1, 2, 0.05, 'sweep ahead of body (m)');
    R(push, l, 'pushForce', 0, 3, 0.01, 'force');
    R(push, l, 'pushLift', 0, 2, 0.01, 'lift');
    R(push, l, 'pushForward', 0, 1, 0.01, 'forward blend');
    R(push, l, 'pushSpeed', 0, 3, 0.05, 'moves at least (m/s)');
    R(push, l, 'pushBudget', 1, 200, 1, 'leaves per frame (cap)');

    // And what the wind does: a few a second come unstuck and skitter downwind.
    const skitter = litter.addFolder('Blown along');
    R(skitter, l, 'gustRate', 0, 60, 0.5, 'lifted per second');
    R(skitter, l, 'gustForce', 0, 3, 0.01, 'force');
    R(skitter, l, 'gustLift', 0, 2, 0.01, 'lift');
    R(skitter, l, 'gustSpread', 0, 3.2, 0.05, 'fan (rad)');

    // The flight itself. The swirl and the spin both die out exactly as the leaf
    // lands, which is what makes the landing place computable — and that is what
    // lets a leaf be kicked again from where it came down.
    const flight = litter.addFolder('Flight');
    R(flight, l, 'flight', 0.1, 5, 0.05, 'flight (s)');
    R(flight, l, 'drag', 0.1, 8, 0.05, 'drag');
    R(flight, l, 'swirl', 0, 1.5, 0.01, 'swirl (m)');
    R(flight, l, 'swirlSpeed', 0, 20, 0.1, 'swirl speed');
    R(flight, l, 'spin', 0, 60, 0.5, 'tumble (rad/s)');

    /* ---- the air ---- */
    const d = g.drift;
    const drift = folder.addFolder('Drift (in the air)');
    drift.add(d, 'enabled').name('drift enabled');
    R(drift, d, 'count', 0, 1024, 1, 'leaves (cost)');
    R(drift, d, 'radius', 2, 90, 0.5, 'spawn radius (m)');
    R(drift, d, 'life', 2, 60, 0.5, 'life (s)');
    R(drift, d, 'lifeVariance', 0, 0.9, 0.01, 'life spread');
    R(drift, d, 'heightMin', 0, 20, 0.1, 'born from (m)');
    R(drift, d, 'heightMax', 0, 40, 0.1, 'born to (m)');
    R(drift, d, 'sizeScale', 0.1, 4, 0.05, 'size against litter');

    // The glide. A leaf is a wing: it does not drop, it swings across its own
    // fall, and this pair is most of why these read as leaves.
    const fall = drift.addFolder('Fall & flutter');
    R(fall, d, 'fall', 0, 4, 0.01, 'sink (m/s)');
    R(fall, d, 'flutter', 0, 3, 0.01, 'swing (m)');
    R(fall, d, 'flutterSpeed', 0, 8, 0.05, 'swing speed');
    R(fall, d, 'tumble', 0, 4, 0.01, 'turn over');
    R(fall, d, 'yawDrift', 0, 3, 0.01, 'yaw drift (rad/s)');
    // What makes one land instead of stopping dead on its edge.
    R(fall, d, 'settle', 0.05, 5, 0.05, 'flatten over (m)');
    R(fall, d, 'hover', 0, 0.3, 0.005, 'rests above floor (m)');

    const seen = drift.addFolder('Fade');
    R(seen, d, 'fadeIn', 0.005, 0.5, 0.005, 'in (of life)');
    R(seen, d, 'fadeOut', 0.005, 0.6, 0.005, 'out (of life)');
    R(seen, d, 'fadeStart', 2, 90, 0.5, 'erodes from (m)');
    R(seen, d, 'fadeEnd', 3, 120, 0.5, 'gone by (m)');
    // Nothing else can fix a leaf sitting on the lens.
    R(seen, d, 'nearFade', 0, 6, 0.05, 'clear of camera (m)');
    R(seen, d, 'nearFadeRange', 0.05, 6, 0.05, 'clear ramp (m)');
  }

  /**
   * Ascendance — the light, and the ten seconds it leaves behind.
   *
   * Five layers, one folder each, because that is how the effect is built and
   * dialling one of them means turning the other four off in your head first.
   *
   * The three worth reaching for before any of the rest are `duration` (how
   * long the boon is up), `haste` and `might` (what it is actually worth), and
   * `pillar -> height`, the number that decides whether the shaft came out of
   * the sky or out of a lamp just above the frame. "Call it down" fires the
   * whole thing on the spot, which is the only sane way to tune a move whose
   * first second is an intro.
   */
  _buildAscendance() {
    const folder = this.gui.addFolder('Ascendance (the light)');
    const a = settings.ascendance;
    const R = Editor.range;

    folder
      .add({ cast: () => this.hooks.onCastAscendance?.() }, 'cast')
      .name('Call it down (on you)');
    folder.add(a, 'enabled').name('enabled');
    R(folder, a, 'duration', 1, 60, 0.5, 'boon lasts (s)');
    R(folder, a, 'warn', 0, 6, 0.1, 'warns for last (s)');
    R(folder, a, 'haste', 1, 3, 0.01, 'movement x');
    R(folder, a, 'might', 1, 4, 0.01, 'blows x');
    R(folder, a, 'shake', 0, 1.5, 0.01, 'arrival shake (m)');

    // The choreography. `duration` is not one of these — it is the beat
    // between `descend` and `fade`.
    const beats = folder.addFolder('Beats (s)');
    const b = a.beats;
    R(beats, b, 'gather', 0.05, 3, 0.01, 'circle draws itself');
    R(beats, b, 'descend', 0.05, 2, 0.01, 'the shaft comes down');
    R(beats, b, 'settle', 0.05, 3, 0.01, 'the bore closes');
    R(beats, b, 'fade', 0.1, 3, 0.01, 'drawn back up');

    // Layer 1. The same shader the fist's seal is drawn with, bound to the
    // height field so this one lies on the ground instead of hanging over it.
    const sigil = folder.addFolder('1 - The sigil');
    const g = a.sigil;
    R(sigil, g, 'radius', 0.5, 6, 0.05, 'radius (m)');
    R(sigil, g, 'lift', 0, 0.4, 0.005, 'off the floor (m)');
    sigil.addColor(g, 'color').name('line colour');
    sigil.addColor(g, 'coreColor').name('core colour');
    R(sigil, g, 'intensity', 0, 8, 0.05, 'brightness');
    R(sigil, g, 'spin', -2, 2, 0.01, 'turns a second');
    R(sigil, g, 'ticks', 4, 120, 1, 'ticks');
    R(sigil, g, 'runes', 3, 40, 1, 'runes');
    R(sigil, g, 'spokes', 2, 24, 1, 'spokes');
    R(sigil, g, 'width', 0.002, 0.06, 0.001, 'stroke weight');
    R(sigil, g, 'softness', 0.001, 0.06, 0.001, 'feather');
    R(sigil, g, 'haze', 0, 2, 0.01, 'inner glow');
    R(sigil, g, 'detail', 0, 1, 0.01, 'mottling');
    R(sigil, g, 'pulse', 0, 1, 0.01, 'breath depth');
    R(sigil, g, 'pulseSpeed', 0, 20, 0.1, 'breath speed');

    // Layer 2. `corePower` is the one to reach for: it is the profile the eye's
    // ray takes through the column, and it is the difference between a disc of
    // light and a filament with air around it.
    const pillar = folder.addFolder('2 - The pillar');
    const p = a.pillar;
    R(pillar, p, 'radius', 0.1, 4, 0.01, 'bore (m)');
    R(pillar, p, 'height', 4, 80, 0.5, 'reaches up (m)');
    pillar.addColor(p, 'color').name('shaft colour');
    pillar.addColor(p, 'coreColor').name('core colour');
    R(pillar, p, 'intensity', 0, 6, 0.01, 'brightness');
    R(pillar, p, 'corePower', 0.2, 8, 0.05, 'core tightness');
    R(pillar, p, 'rimPower', 0.2, 10, 0.05, 'rim tightness');
    R(pillar, p, 'rim', 0, 3, 0.01, 'rim strength');
    R(pillar, p, 'topFade', 0.02, 0.95, 0.01, 'dissolves over (frac)');
    R(pillar, p, 'streaks', 0, 2, 0.01, 'falling light');
    R(pillar, p, 'streakScale', 0.1, 8, 0.05, 'streak scale');
    R(pillar, p, 'streakSpeed', 0, 8, 0.05, 'streak speed');
    R(pillar, p, 'pulse', 0, 1, 0.01, 'breath depth');
    R(pillar, p, 'pulseSpeed', 0, 12, 0.05, 'breath speed');
    R(pillar, p, 'flare', 1, 4, 0.01, 'foot flare x');
    R(pillar, p, 'flareHeight', 0.005, 0.4, 0.005, 'flare reaches (frac)');
    R(pillar, p, 'gatherHead', 0, 0.95, 0.01, 'fallen by end of gather');
    R(pillar, p, 'arrivalWidth', 0, 3, 0.01, 'extra bore on arrival');
    R(pillar, p, 'flashTime', 0.05, 2, 0.01, 'arrival flash (s)');

    // Layer 3. One draw call however many there are, so `count` is very nearly
    // free — the buffer is built for 24.
    const ribbons = folder.addFolder('3 - The ribbons');
    const r = a.ribbons;
    R(ribbons, r, 'count', 0, 24, 1, 'how many');
    ribbons.addColor(r, 'color').name('ribbon colour');
    ribbons.addColor(r, 'coreColor').name('core colour');
    R(ribbons, r, 'intensity', 0, 6, 0.01, 'brightness');
    R(ribbons, r, 'radius', 0.1, 4, 0.01, 'ride out at (m)');
    R(ribbons, r, 'height', 0.5, 12, 0.05, 'climb to (m)');
    R(ribbons, r, 'turns', 0.1, 6, 0.05, 'turns per climb');
    R(ribbons, r, 'span', 0.05, 1, 0.01, 'length (frac of climb)');
    R(ribbons, r, 'speed', 0, 2, 0.01, 'climbs a second');
    R(ribbons, r, 'swirl', -3, 3, 0.01, 'extra turn a second');
    R(ribbons, r, 'width', 0.005, 0.5, 0.005, 'width (m)');
    R(ribbons, r, 'topScale', 0.05, 1.5, 0.01, 'narrowed to, at the top');
    R(ribbons, r, 'waist', 0, 0.6, 0.01, 'waist depth');
    R(ribbons, r, 'softness', 0.2, 6, 0.05, 'edge falloff');
    R(ribbons, r, 'corePower', 1, 16, 0.1, 'core tightness');

    // Layer 4. One frame of white on the floor — the petals are the read, and
    // the core is what makes the first two frames a hole rather than a fan.
    const burst = folder.addFolder('4 - The burst');
    const bu = a.burst;
    R(burst, bu, 'radius', 0.5, 12, 0.1, 'reaches (m)');
    R(burst, bu, 'life', 0.1, 3, 0.01, 'lasts (s)');
    burst.addColor(bu, 'color').name('wave colour');
    burst.addColor(bu, 'coreColor').name('core colour');
    R(burst, bu, 'intensity', 0, 8, 0.05, 'brightness');
    R(burst, bu, 'petals', 1, 48, 1, 'petals');
    R(burst, bu, 'petalWidth', 0.005, 0.4, 0.005, 'petal width');
    R(burst, bu, 'petalLength', 0.1, 1, 0.01, 'petal reach');
    R(burst, bu, 'ringWidth', 0.005, 0.3, 0.005, 'front width');
    R(burst, bu, 'softness', 0.005, 0.5, 0.005, 'feather');
    R(burst, bu, 'core', 0, 6, 0.05, 'centre flash');
    R(burst, bu, 'lift', 0, 0.3, 0.005, 'off the floor (m)');

    // Layer 5. The only loose thing in the ability, and the reason the other
    // four read as one event rather than as four decals in the same place.
    const embers = folder.addFolder('5 - The embers');
    const e = a.embers;
    embers.addColor(e, 'color').name('mote colour');
    embers.addColor(e, 'coreColor').name('core colour');
    R(embers, e, 'intensity', 0, 6, 0.05, 'brightness');
    R(embers, e, 'rate', 0, 120, 1, 'a second, while held');
    R(embers, e, 'gatherRate', 0, 60, 1, 'a second, while gathering');
    R(embers, e, 'burst', 0, 300, 1, 'on arrival');
    R(embers, e, 'spread', 0.1, 2, 0.01, 'born within (frac of sigil)');
    R(embers, e, 'life', 0.2, 8, 0.05, 'one lives (s)');
    R(embers, e, 'speed', 0, 6, 0.05, 'leaves at (m/s)');
    R(embers, e, 'spawnHeight', 0, 4, 0.05, 'born up to (m)');
    R(embers, e, 'drag', 0.05, 6, 0.05, 'air resistance');
    R(embers, e, 'rise', 0, 8, 0.05, 'pulled up at (m/s2)');
    R(embers, e, 'size', 0.005, 0.4, 0.005, 'size (m)');
    R(embers, e, 'grow', 0, 3, 0.01, 'grows by x');
    R(embers, e, 'sway', 0, 2, 0.01, 'wander (m)');
    R(embers, e, 'swaySpeed', 0, 6, 0.05, 'wander speed');
    R(embers, e, 'halo', 0, 2, 0.01, 'halo');
    R(embers, e, 'sharpness', 0.01, 0.6, 0.005, 'edge hardness');
    R(embers, e, 'twinkle', 0, 1, 0.01, 'shimmer');
    R(embers, e, 'spin', 0, 12, 0.05, 'turns at (rad/s)');

    // The one part of it that lights anything at all.
    const light = folder.addFolder('The light');
    const l = a.light;
    light.addColor(l, 'color').name('colour');
    R(light, l, 'intensity', 0, 40, 0.1, 'while held');
    R(light, l, 'flash', 0, 120, 0.5, 'on arrival');
    R(light, l, 'height', 0, 1.5, 0.01, 'hangs at (frac of body)');
    R(light, l, 'distance', 1, 40, 0.5, 'reaches (m)');
    R(light, l, 'decay', 0.5, 4, 0.05, 'falloff');
  }

  /**
   * Shadow Boost — the dark, and the seconds it leaves behind.
   *
   * Five layers again, one folder each, and laid out in the order they are
   * drawn rather than the order they are noticed: the pool is at the bottom of
   * the stack and is doing more for the read than anything above it.
   *
   * Three to reach for before the rest. `might` is what the ability is *worth*
   * (it is the heavier of the two boons and the slower). `swirl -> stretch` is
   * the single number that decides whether the shadow going round the body is a
   * *spiral* or a cloud of blobs — it is how far each puff is drawn out along
   * its own orbit, and at 1 the layer stops working. And `column -> shade`,
   * which darkens the shaft's **edges** (not its middle — see
   * `vfx/DarkPillar.js`): it is what gives the column an outside, and it is the
   * slider to reach for if the shaft looks like a neon tube.
   */
  _buildShadowBoost() {
    const folder = this.gui.addFolder('Shadow Boost (the dark)');
    const s = settings.shadowBoost;
    const R = Editor.range;

    folder
      .add({ cast: () => this.hooks.onCastShadowBoost?.() }, 'cast')
      .name('Call it up (under you)');
    folder.add(s, 'enabled').name('enabled');
    R(folder, s, 'duration', 1, 60, 0.5, 'boon lasts (s)');
    R(folder, s, 'warn', 0, 6, 0.1, 'warns for last (s)');
    R(folder, s, 'haste', 1, 3, 0.01, 'movement x');
    R(folder, s, 'might', 1, 4, 0.01, 'blows x');
    R(folder, s, 'shake', 0, 1.5, 0.01, 'arrival shake (m)');

    // The choreography. `duration` is not one of these — it is the beat between
    // `erupt` and `fade`.
    const beats = folder.addFolder('Beats (s)');
    const b = s.beats;
    R(beats, b, 'gather', 0.05, 3, 0.01, 'the pool opens');
    R(beats, b, 'erupt', 0.05, 2, 0.01, 'the column comes up');
    R(beats, b, 'settle', 0.05, 3, 0.01, 'the bore closes');
    R(beats, b, 'fade', 0.1, 3, 0.01, 'drawn back down');

    // Layer 1. No shape at all, and the thing every other layer is seen
    // against — `falloff` is the whole control: low is a wash, high is a bloom.
    const glow = folder.addFolder('1 - The base glow');
    const g = s.glow;
    R(glow, g, 'radius', 0.5, 8, 0.05, 'radius (m)');
    R(glow, g, 'lift', 0, 0.4, 0.005, 'off the floor (m)');
    glow.addColor(g, 'color').name('spill colour');
    glow.addColor(g, 'coreColor').name('core colour');
    R(glow, g, 'intensity', 0, 6, 0.05, 'brightness');
    R(glow, g, 'falloff', 0.2, 8, 0.05, 'spill falloff');
    R(glow, g, 'core', 0.02, 1, 0.01, 'hot middle (frac)');
    R(glow, g, 'corePower', 0.2, 8, 0.05, 'core tightness');
    R(glow, g, 'pulse', 0, 1, 0.01, 'breath depth');
    R(glow, g, 'pulseSpeed', 0, 12, 0.05, 'breath speed');
    R(glow, g, 'mottle', 0, 1, 0.01, 'mottling');
    R(glow, g, 'mottleScale', 0.2, 8, 0.05, 'mottle scale');
    R(glow, g, 'mottleSpeed', 0, 2, 0.01, 'mottle crawl');

    // Layer 2. `trough` is the one that matters: it is the shadow behind each
    // front, and it is what stands a drawn circle up off the floor.
    const rings = folder.addFolder('2 - The ground distortion');
    const r = s.rings;
    R(rings, r, 'radius', 0.5, 12, 0.05, 'reaches (m)');
    R(rings, r, 'lift', 0, 0.4, 0.005, 'off the floor (m)');
    rings.addColor(r, 'color').name('front colour');
    rings.addColor(r, 'coreColor').name('core colour');
    R(rings, r, 'intensity', 0, 6, 0.05, 'brightness');
    R(rings, r, 'rings', 1, 12, 1, 'fronts at once');
    R(rings, r, 'speed', -3, 3, 0.01, 'fronts a second');
    R(rings, r, 'width', 0.002, 0.2, 0.002, 'front width');
    R(rings, r, 'softness', 0.002, 0.1, 0.002, 'feather');
    R(rings, r, 'glow', 0, 2, 0.01, 'bloom off the line');
    R(rings, r, 'glowWidth', 0.005, 0.6, 0.005, 'bloom reach');
    R(rings, r, 'trough', 0, 2, 0.01, 'trough depth');
    R(rings, r, 'troughWidth', 0.005, 0.4, 0.005, 'trough reach');
    R(rings, r, 'warp', 0, 0.4, 0.005, 'distortion (frac)');
    R(rings, r, 'warpScale', 0.2, 10, 0.05, 'distortion scale');
    R(rings, r, 'warpSpeed', 0, 3, 0.01, 'distortion crawl');
    R(rings, r, 'spin', -2, 2, 0.01, 'turns a second');

    // Layer 3. Two tubes on one geometry — see `vfx/DarkPillar.js`. `shade` is
    // the dark half and `rim` is the bright one, and the balance between them
    // is the entire look of the column.
    const column = folder.addFolder('3 - The dark column');
    const c = s.column;
    R(column, c, 'radius', 0.1, 4, 0.01, 'bore (m)');
    R(column, c, 'height', 2, 40, 0.5, 'reaches up (m)');
    column.addColor(c, 'color').name('energy colour');
    column.addColor(c, 'coreColor').name('core colour');
    column.addColor(c, 'shadeColor').name('shade colour');
    R(column, c, 'intensity', 0, 4, 0.01, 'brightness');
    R(column, c, 'shade', 0, 1, 0.01, 'edges darken by');
    R(column, c, 'shadePower', 0.2, 8, 0.05, 'dark edge tightness');
    R(column, c, 'corePower', 0.2, 8, 0.05, 'core tightness');
    R(column, c, 'rimPower', 0.2, 10, 0.05, 'rim tightness');
    R(column, c, 'rim', 0, 3, 0.01, 'rim accent');
    R(column, c, 'topFade', 0.02, 0.95, 0.01, 'dissolves over (frac)');
    R(column, c, 'streaks', 0, 2, 0.01, 'falling light');
    R(column, c, 'streakScale', 0.1, 8, 0.05, 'streak scale');
    R(column, c, 'streakSpeed', 0, 8, 0.05, 'streak speed');
    R(column, c, 'veins', 0, 3, 0.01, 'lightning');
    R(column, c, 'veinScale', 0.2, 10, 0.05, 'bolt scale');
    R(column, c, 'veinRate', 0.5, 20, 0.1, 'strikes a second');
    R(column, c, 'veinPower', 1, 20, 0.1, 'bolt thinness');
    R(column, c, 'veinBranch', 0, 1, 0.01, 'forking');
    R(column, c, 'front', 0, 1, 0.01, 'near wall worth x');
    R(column, c, 'pulse', 0, 1, 0.01, 'breath depth');
    R(column, c, 'pulseSpeed', 0, 12, 0.05, 'breath speed');
    R(column, c, 'flare', 1, 4, 0.01, 'foot flare x');
    R(column, c, 'flareHeight', 0.005, 0.4, 0.005, 'flare reaches (frac)');
    R(column, c, 'arrivalWidth', 0, 3, 0.01, 'extra bore on arrival');
    R(column, c, 'flashTime', 0.05, 2, 0.01, 'arrival flash (s)');

    // Layer 4. One draw call however many there are, so `count` is very nearly
    // free — the buffer is built for 24.
    const wisps = folder.addFolder('4 - The rising wisps');
    const w = s.wisps;
    R(wisps, w, 'count', 0, 24, 1, 'how many');
    wisps.addColor(w, 'color').name('smoke colour');
    wisps.addColor(w, 'rimColor').name('fringe colour');
    R(wisps, w, 'opacity', 0, 1, 0.01, 'opacity');
    R(wisps, w, 'rim', 0, 2, 0.01, 'fringe strength');
    R(wisps, w, 'radius', 0.1, 4, 0.01, 'stand out at (m)');
    R(wisps, w, 'height', 0.5, 12, 0.05, 'climb to (m)');
    R(wisps, w, 'curl', 0, 3, 0.01, 'turns per climb');
    R(wisps, w, 'writhe', -3, 3, 0.01, 'extra turn a second');
    R(wisps, w, 'sway', 0, 2, 0.01, 'wander (m)');
    R(wisps, w, 'span', 0.05, 1, 0.01, 'length (frac of climb)');
    R(wisps, w, 'speed', 0, 2, 0.01, 'climbs a second');
    R(wisps, w, 'width', 0.01, 1.5, 0.01, 'width at the foot (m)');
    R(wisps, w, 'spread', 0.2, 4, 0.01, 'widens to x');
    R(wisps, w, 'topScale', 0.2, 3, 0.01, 'stands out to x');
    R(wisps, w, 'softness', 0.2, 6, 0.05, 'edge falloff');
    R(wisps, w, 'detail', 0.2, 10, 0.05, 'tear scale');
    R(wisps, w, 'churn', 0, 3, 0.01, 'tear crawl');
    R(wisps, w, 'erode', 0, 1.5, 0.01, 'eaten away by');

    // Layer 5. The fast layer, against the wisps' slow one. `spin` first.
    const swirl = folder.addFolder('5 - The swirling shadow');
    const sw = s.swirl;
    swirl.addColor(sw, 'color').name('smoke colour');
    swirl.addColor(sw, 'rimColor').name('fringe colour');
    R(swirl, sw, 'opacity', 0, 1, 0.01, 'opacity');
    R(swirl, sw, 'rim', 0, 2, 0.01, 'fringe strength');
    R(swirl, sw, 'rate', 0, 120, 1, 'a second, while held');
    R(swirl, sw, 'gatherRate', 0, 60, 1, 'a second, while gathering');
    R(swirl, sw, 'burst', 0, 300, 1, 'on arrival');
    R(swirl, sw, 'spread', 0.1, 2, 0.01, 'born within (frac of pool)');
    R(swirl, sw, 'life', 0.2, 8, 0.05, 'one lives (s)');
    R(swirl, sw, 'spin', -8, 8, 0.05, 'winds at (rad/s)');
    swirl.add(sw, 'reverse').name('half turn the other way');
    R(swirl, sw, 'widen', -1, 2, 0.01, 'orbit widens by');
    R(swirl, sw, 'rise', -2, 6, 0.05, 'lifts at (m/s)');
    R(swirl, sw, 'spawnHeight', 0, 4, 0.05, 'born up to (m)');
    R(swirl, sw, 'size', 0.02, 2, 0.01, 'size (m)');
    R(swirl, sw, 'grow', 0, 3, 0.01, 'grows by x');
    R(swirl, sw, 'stretch', 1, 8, 0.05, 'drawn out along orbit x');
    R(swirl, sw, 'wobble', 0, 2, 0.01, 'wander (m)');
    R(swirl, sw, 'wobbleSpeed', 0, 6, 0.05, 'wander speed');
    R(swirl, sw, 'detail', 0.2, 6, 0.05, 'tear scale');
    R(swirl, sw, 'churn', 0, 3, 0.01, 'tear crawl');
    R(swirl, sw, 'softness', 0.01, 0.8, 0.01, 'inner feather');
    R(swirl, sw, 'erode', 0, 1.5, 0.01, 'eaten away by');

    // And the one part of it that lights anything at all — which a dark aura
    // needs more than a bright one does, not less.
    const light = folder.addFolder('The light');
    const l = s.light;
    light.addColor(l, 'color').name('colour');
    R(light, l, 'intensity', 0, 40, 0.1, 'while held');
    R(light, l, 'flash', 0, 120, 0.5, 'on arrival');
    R(light, l, 'height', 0, 1.5, 0.01, 'hangs at (frac of body)');
    R(light, l, 'distance', 1, 40, 0.5, 'reaches (m)');
    R(light, l, 'decay', 0.5, 4, 0.05, 'falloff');
  }

  _buildPost() {
    const folder = this.gui.addFolder('Post processing');
    const p = settings.post;
    const R = Editor.range;

    folder.add(p, 'enabled').name('enabled');
    // The only anti-aliasing in the project — the scene never touches the canvas
    // directly, so the renderer's own flag has nothing to act on. It is also the
    // heaviest thing in the stack, hence a dial rather than a constant.
    folder.add(p, 'samples', [0, 2, 4, 8]).name('anti-aliasing');
    R(folder, p, 'exposure', 0.1, 3, 0.01, 'exposure');
    R(folder, p, 'bloomStrength', 0, 3, 0.01, 'bloom intensity');
    R(folder, p, 'bloomRadius', 0, 1.5, 0.01, 'bloom radius');
    R(folder, p, 'bloomThreshold', 0, 2, 0.01, 'bloom threshold');
    R(folder, p, 'contrast', 0.5, 2, 0.01, 'contrast');
    R(folder, p, 'saturation', 0, 2.5, 0.01, 'saturation');
    R(folder, p, 'temperature', -0.5, 0.5, 0.01, 'temperature');
    R(folder, p, 'lift', -0.2, 0.2, 0.005, 'lift');
    R(folder, p, 'gain', 0.5, 2, 0.01, 'gain');
    R(folder, p, 'vignette', 0, 1.5, 0.01, 'vignette');
    R(folder, p, 'chromaticAberration', 0, 3, 0.01, 'chromatic aberration');
    R(folder, p, 'grain', 0, 0.2, 0.001, 'film grain');
  }

  _buildCamera() {
    const folder = this.gui.addFolder('Camera');
    const c = settings.camera;
    const R = Editor.range;

    // The wheel writes `distance` straight into settings, so the slider listens.
    R(folder, c, 'distance', 1, 40, 0.1, 'distance').listen();
    R(folder, c, 'minDistance', 1, 20, 0.1, 'min distance');
    R(folder, c, 'maxDistance', 4, 40, 0.1, 'max distance');
    R(folder, c, 'zoomSpeed', 0.1, 3, 0.01, 'zoom speed');
    R(folder, c, 'fov', 20, 90, 0.5, 'field of view');
    R(folder, c, 'targetHeight', 0, 4, 0.01, 'target height');
    R(folder, c, 'minPolar', 0.05, 1.5, 0.01, 'min pitch');
    // Past π/2 the camera drops below its target and the view tilts up, which is
    // the only way anything in the sky gets into frame. Nothing collides the
    // lens against the floor, so a long zoom at the top of this range will go
    // through the ground — which is why the default stops just past level.
    R(folder, c, 'maxPolar', 0.2, 2.2, 0.01, 'max pitch');
    R(folder, c, 'damping', 0.001, 0.5, 0.001, 'follow damping');
    // The captured pointer's turn rate, for every weapon and none — the sights
    // only multiply it (see the gunplay folder).
    R(folder, c, 'sensitivity', 0.0004, 0.008, 0.0001, 'mouse (rad/px)');
  }

  _buildCharacter() {
    const folder = this.gui.addFolder('Character');
    const c = settings.character;
    const R = Editor.range;

    // The mixer's own rate.
    R(folder, settings.global, 'animationSpeed', 0.1, 3, 0.01, 'playback rate');
    R(folder, settings.global, 'timeScale', 0.02, 2, 0.01, 'time scale');

    // The turntable advances `facing` itself, so that slider listens.
    R(folder, c, 'spin', -0.5, 0.5, 0.005, 'turntable (rev/s)');
    R(folder, c, 'facing', -Math.PI, Math.PI * 3, 0.01, 'facing').listen();

    // The skin's response to the stage's lights. The body wears the glTF
    // palette's authored maps, so these two only reach it once the override is
    // on — off, they still drive any material the palette had no match for.
    const material = folder.addFolder('Skin');
    material.add(c, 'overrideSurface').name('override authored PBR');
    R(material, c, 'roughness', 0, 1, 0.01, 'roughness');
    R(material, c, 'metalness', 0, 1, 0.01, 'metalness');

    // The rig is re-normalised against `targetHeight` every frame, so this
    // rescales the body live — and anything attached to a bone with it.
    const rig = folder.addFolder('Rig');
    R(rig, c, 'targetHeight', 1, 3, 0.01, 'height (m)');
    R(rig, c, 'turnRate', 0.000001, 0.02, 0.000001, 'turn follow');
  }

  _buildLocomotion() {
    const folder = this.gui.addFolder('Locomotion');
    const l = settings.locomotion;
    const R = Editor.range;

    folder.add(l, 'enabled').name('controls enabled');

    // How fast the body travels. The stride rate divides these by the clip
    // speeds below, so raising one speeds the legs up to match.
    R(folder, l, 'walkSpeed', 0.2, 4, 0.01, 'walk (m/s)');
    R(folder, l, 'runSpeed', 1, 12, 0.01, 'run (m/s)');
    R(folder, l, 'acceleration', 1, 60, 0.1, 'acceleration');
    R(folder, l, 'deceleration', 1, 60, 0.1, 'deceleration');
    R(folder, l, 'blendRate', 0.000001, 0.05, 0.000001, 'blend follow');
    // The cross-fade between the two idles — the plain stand and the rifle one.
    // Faster than the gait blend: it is answering a weapon appearing in the
    // hand and has to be done by the time the burn is (see `Weapons` below).
    R(folder, l, 'stanceRate', 0.0000001, 0.01, 0.0000001, 'stance follow');

    const gait = folder.addFolder('Gait');
    R(gait, l, 'idleThreshold', 0, 0.5, 0.001, 'idle below (m/s)');
    // The speeds the clips themselves cover at rate 1 — the divisor. Tune these
    // once against the animation; move `walkSpeed`/`runSpeed` for design.
    R(gait, l, 'clipWalkSpeed', 0.2, 4, 0.01, 'walk clip (m/s)');
    R(gait, l, 'clipRunSpeed', 1, 12, 0.01, 'run clip (m/s)');
    // Trim on top of that division, per gait — for the part of the mismatch the
    // clip speeds do not account for. Blended between the two by the same curve
    // the weights use, and bounded by the stride clamp below.
    R(gait, l, 'walkAnimSpeed', 0.25, 3, 0.01, 'walk anim ×');
    R(gait, l, 'runAnimSpeed', 0.25, 3, 0.01, 'run anim ×');
    R(gait, l, 'strideMin', 0.2, 1, 0.01, 'stride min');
    R(gait, l, 'strideMax', 1, 5, 0.01, 'stride max');

    // Space, from a run. `distance` renormalises the clip's own travel, so it is
    // the reach of the jump in metres — 0 hands it back to the animation.
    const jump = folder.addFolder('Long jump');
    const j = settings.jump;
    jump.add(j, 'enabled').name('long jump enabled');
    R(jump, j, 'distance', 0, 20, 0.1, 'distance (m)');
    R(jump, j, 'minRunFraction', 0, 1, 0.01, 'launch above run ×');
    R(jump, j, 'landAt', 0.4, 1, 0.01, 'control returns at');
    R(jump, j, 'blendIn', 0.01, 0.6, 0.01, 'blend in (s)');
    R(jump, j, 'blendOut', 0.01, 0.8, 0.01, 'blend out (s)');

    // Space at anything less. It covers no ground of its own, so what there is
    // to tune is how it sits over the gait: `gaitBleed` is how much of the walk
    // or run keeps playing under it, which is what keeps the legs carrying the
    // body instead of planting while the controller travels.
    const hop = folder.addFolder('Hop');
    const h = settings.hop;
    hop.add(h, 'enabled').name('hop enabled');
    R(hop, h, 'gaitBleed', 0, 1, 0.01, 'gait under hop');
    R(hop, h, 'landAt', 0.4, 1, 0.01, 'feet down at');
    R(hop, h, 'blendIn', 0.01, 0.6, 0.01, 'blend in (s)');
    R(hop, h, 'blendOut', 0.01, 0.8, 0.01, 'blend out (s)');
  }

  /**
   * The kick and the bodies it lands on.
   *
   * Two halves that meet in one place. The **kick** half is the animation
   * contract: `hitAt`, `recoverAt` and `approach` are normalised times in the
   * clip, and they are the three numbers to reach for after watching the move
   * once — the foot connects here, control comes back there, and the warp has
   * that long to put the body where the animator assumed it was standing.
   *
   * The **enemies** half is the sandbox around it. Everything is live except
   * the height and the ring, which are read when a body is spawned — hit
   * "Respawn all" after moving those.
   */
  /**
   * The swap between the katana and the rifle — see `equipment/WeaponSwitch.js`.
   *
   * All of it is the *look* of one exchange: how long it takes, how much its
   * two halves overlap, and what the mask that eats each weapon looks like
   * while it does. Nothing here decides which weapon is out — that is `1`, the
   * chip along the bottom, or the Weapon buttons on the character screen.
   */
  _buildWeapons() {
    const folder = this.gui.addFolder('Weapons (the swap)');
    const w = settings.weapons;
    const R = Editor.range;

    R(folder, w, 'switchTime', 0.1, 2.5, 0.01, 'swap takes (s)');
    // 0 empties the hand between the two; past about half and both are simply
    // on screen together. A quarter reads as one becoming the other.
    R(folder, w, 'overlap', 0, 0.9, 0.01, 'halves overlap');
    // Where in that the body's grip changes — it belongs to the weapon
    // arriving, not to either end of the swap.
    R(folder, w, 'handover', 0, 1, 0.01, 'grip changes at');

    const mask = folder.addFolder('The mask');
    mask.addColor(w, 'edgeColor').name('edge colour');
    R(mask, w, 'edgeEmissive', 0, 24, 0.1, 'edge glow');
    R(mask, w, 'edgeWidth', 0.01, 0.6, 0.005, 'edge width');
    // Features per metre. Weapons are small, so this runs far higher than the
    // same control on a body.
    R(mask, w, 'detail', 2, 120, 0.5, 'noise detail');
    // 1 is a clean line travelling the length of the piece; 0 is static eating
    // it from everywhere at once.
    R(mask, w, 'rise', 0, 1, 0.01, 'burn along piece');
  }

  /**
   * The shooter, in the order the numbers are actually reached for.
   *
   * The lens first, because where the camera stands is the whole mode; then the
   * body, because a torso that will not come round far enough is the next thing
   * anyone notices; then the gun; then what it costs to be hit. The look — the
   * tracer, the flash, the sparks — is last, on the grounds that nobody tunes a
   * muzzle flash before they have decided how the gun handles.
   */
  _buildGunplay() {
    const folder = this.gui.addFolder('Gunplay (the rifle)');
    const g = settings.gunplay;
    const R = Editor.range;

    folder.add(g, 'enabled').name('enabled');
    // The key and the middle mouse button both write this, so it listens.
    folder.add(g, 'shoulder', { Left: -1, Right: 1 }).name('shoulder').listen();

    const lens = folder.addFolder('The lens');
    const c = g.camera;
    // The number the whole mode stands on: with it at 0 the body is in front of
    // its own aim and there is nowhere honest to put a reticle.
    R(lens, c, 'offset', 0, 1.6, 0.01, 'off the axis (m)');
    R(lens, c, 'rise', -0.4, 0.4, 0.01, 'rise (m)');
    R(lens, c, 'distance', 0.8, 6, 0.05, 'distance (m)');
    R(lens, c, 'targetHeight', 0.6, 2.4, 0.01, 'looks at (m)');
    R(lens, c, 'fov', 25, 80, 0.5, 'field of view');
    R(lens, c, 'blend', 0.00001, 0.02, 0.00001, 'comes up over');

    const sights = lens.addFolder('Down the sights');
    R(sights, c, 'adsOffset', 0, 1.6, 0.01, 'off the axis (m)');
    R(sights, c, 'adsDistance', 0.6, 4, 0.05, 'distance (m)');
    R(sights, c, 'adsTargetHeight', 0.6, 2.4, 0.01, 'looks at (m)');
    R(sights, c, 'adsFov', 15, 70, 0.5, 'field of view');
    R(sights, c, 'adsSensitivity', 0.2, 1.5, 0.01, 'mouse multiplier');

    const body = folder.addFolder('The body');
    const a = g.aim;
    R(body, a, 'maxYaw', 10, 120, 1, 'torso twist (deg)');
    R(body, a, 'maxPitch', 10, 85, 1, 'torso pitch (deg)');
    // The one that decides whether a strafe reads as a person or as a body on
    // rails: how far the hips are allowed off the lens toward the travel.
    R(body, a, 'lean', 0, 90, 1, 'legs lean (deg)');
    R(body, a, 'rate', 0.000001, 0.005, 0.000001, 'twist follow');
    R(body, a, 'turnRate', 0.0000001, 0.001, 0.0000001, 'heading follow');
    R(body, a, 'enter', 0.00001, 0.05, 0.00001, 'aim comes up over');
    R(body, a, 'range', 20, 400, 5, 'reticle reaches (m)');

    const gun = folder.addFolder('The gun');
    const f = g.fire;
    R(gun, f, 'rate', 1, 20, 0.1, 'rounds / second');
    gun.add(f, 'auto').name('holds down');
    R(gun, f, 'speed', 30, 400, 5, 'round speed (m/s)');
    R(gun, f, 'drop', 0, 20, 0.1, 'round falls (m/s²)');
    R(gun, f, 'spread', 0, 6, 0.01, 'spread standing (deg)');
    R(gun, f, 'moveSpread', 0, 10, 0.01, 'spread moving (deg)');
    R(gun, f, 'adsSpread', 0, 3, 0.01, 'spread sighted (deg)');
    R(gun, f, 'bloom', 0, 2, 0.01, 'per round (deg)');
    R(gun, f, 'bloomMax', 0, 10, 0.1, 'piles up to (deg)');
    R(gun, f, 'bloomRecover', 0.5, 20, 0.1, 'bleeds off (deg/s)');
    R(gun, f, 'recoilPitch', 0, 3, 0.01, 'kick up (deg)');
    R(gun, f, 'recoilYaw', 0, 2, 0.01, 'kick sideways (deg)');
    R(gun, f, 'recoilRecover', 0.0000001, 0.001, 0.0000001, 'kick returns');
    R(gun, f, 'shake', 0, 0.3, 0.001, 'lens knock (m)');

    const hurt = folder.addFolder('What a round costs');
    const d = g.damage;
    // Three of these into a hundred is the whole design: change `body` and the
    // rifle changes from a three-round weapon to something else.
    R(hurt, d, 'health', 10, 400, 5, 'a body is worth');
    R(hurt, d, 'body', 1, 200, 1, 'body shot');
    R(hurt, d, 'head', 1, 400, 1, 'head shot');
    R(hurt, d, 'impulse', 0, 12, 0.1, 'shove (m/s)');
    R(hurt, d, 'lift', 0, 8, 0.1, 'lift (m/s)');
    R(hurt, d, 'spin', 0, 5, 0.05, 'fold');
    R(hurt, d, 'headImpulse', 0, 12, 0.1, 'head shove (m/s)');
    R(hurt, d, 'headLift', 0, 8, 0.1, 'head lift (m/s)');
    R(hurt, d, 'headSpin', 0, 6, 0.05, 'head fold');
    R(hurt, d, 'flinch', 0, 1, 0.01, 'flare lasts (s)');
    R(hurt, d, 'flinchRim', 0, 20, 0.1, 'flare brightness');
    R(hurt, d, 'hitShake', 0, 0.2, 0.001, 'knock on a hit (m)');
    R(hurt, d, 'killShake', 0, 0.4, 0.001, 'knock on a kill (m)');
    R(hurt, d, 'killHitStop', 0, 0.3, 0.005, 'kill freeze (s)');
    R(hurt, d, 'killHitStopScale', 0.01, 1, 0.01, 'freeze depth');
    R(hurt, d, 'bodyBlood', 0, 80, 1, 'droplets, body');
    R(hurt, d, 'headBlood', 0, 120, 1, 'droplets, head');
    R(hurt, d, 'bloodSpeed', 0.2, 12, 0.1, 'droplet speed (m/s)');

    // The bar over a head, which exists only because the rifle spends health a
    // piece at a time — see `vfx/HealthBars.js`.
    const bars = hurt.addFolder('The bar over a head');
    const b = g.healthBar;
    bars.add(b, 'enabled').name('bars shown');
    bars.add(b, 'onlyWounded').name('only once hit');
    bars.addColor(b, 'color').name('health left');
    bars.addColor(b, 'trackColor').name('ground behind');
    bars.addColor(b, 'frameColor').name('frame');
    R(bars, b, 'width', 0.1, 1.5, 0.01, 'width (m)');
    R(bars, b, 'height', 0.01, 0.3, 0.005, 'height (m)');
    R(bars, b, 'lift', 0, 1.2, 0.01, 'above the head (m)');
    // What keeps a bar readable once the body is a speck.
    R(bars, b, 'minWidth', 0, 120, 1, 'never under (px)');
    R(bars, b, 'range', 5, 200, 5, 'shown within (m)');
    R(bars, b, 'trackOpacity', 0, 1, 0.01, 'ground opacity');
    R(bars, b, 'frameOpacity', 0, 1, 0.01, 'frame opacity');
    R(bars, b, 'border', 0, 0.5, 0.01, 'frame thickness');
    R(bars, b, 'fadeIn', 0.02, 1, 0.01, 'comes up over (s)');
    R(bars, b, 'fadeOut', 0.02, 2, 0.01, 'fades over (s)');

    const boxes = folder.addFolder('Hitboxes');
    const h = g.hitbox;
    // The head is deliberately a shade larger than a head — see `Hitboxes.js`.
    R(boxes, h, 'headRadius', 0.05, 0.4, 0.005, 'head (m)');
    R(boxes, h, 'torsoRadius', 0.1, 0.6, 0.005, 'torso (m)');
    R(boxes, h, 'legRadius', 0.05, 0.5, 0.005, 'legs (m)');

    const look = folder.addFolder('The look');
    const t = g.tracer;
    look.addColor(t, 'color').name('tracer colour');
    R(look, t, 'brightness', 0.2, 20, 0.1, 'tracer glow');
    R(look, t, 'length', 0.2, 12, 0.1, 'tracer length (m)');
    R(look, t, 'width', 0.005, 0.2, 0.005, 'tracer width (m)');
    R(look, t, 'life', 0.2, 6, 0.1, 'round lives (s)');

    const flash = look.addFolder('Muzzle');
    const m = g.muzzle;
    flash.addColor(m, 'color').name('colour');
    R(flash, m, 'size', 0.05, 1.2, 0.01, 'size (m)');
    R(flash, m, 'life', 0.01, 0.3, 0.005, 'lasts (s)');
    R(flash, m, 'light', 0, 40, 0.5, 'light');
    R(flash, m, 'lightRange', 1, 30, 0.5, 'light reach (m)');
    // The three that fix a barrel this project guessed the end of.
    R(flash, m, 'forward', -0.6, 0.6, 0.005, 'along barrel (m)');
    R(flash, m, 'up', -0.3, 0.3, 0.005, 'above barrel (m)');
    R(flash, m, 'right', -0.3, 0.3, 0.005, 'beside barrel (m)');

    const sparks = look.addFolder('Impact');
    const i = g.impact;
    sparks.addColor(i, 'color').name('spark colour');
    R(sparks, i, 'brightness', 0.2, 10, 0.1, 'spark glow');
    R(sparks, i, 'sparks', 0, 60, 1, 'sparks per round');
    R(sparks, i, 'speed', 0.5, 20, 0.1, 'thrown at (m/s)');
    R(sparks, i, 'life', 0.05, 2, 0.01, 'last (s)');
    R(sparks, i, 'size', 0.01, 0.3, 0.005, 'size (m)');
    R(sparks, i, 'gravity', -40, 0, 0.5, 'fall (m/s²)');

    this._buildFocus(folder);
  }

  /**
   * The held shot, in the order it happens: what earns it, what it costs the
   * thing it hits, and only then what it looks like.
   *
   * The seven layers of the burst each get their own sub-folder rather than one
   * long list, because the way anyone actually tunes a stack this deep is by
   * switching six of them off — and a `*Enabled` box at the top of its own
   * folder is a solo button.
   */
  _buildFocus(parent) {
    const R = Editor.range;
    const f = settings.gunplay.focus;
    const folder = parent.addFolder('The held shot (hold right button)');

    folder.add(f, 'enabled').name('enabled');
    // The number the whole gesture is: three seconds of standing still in the
    // open. Under about one and it is not a decision, over about five and
    // nobody ever takes the shot.
    R(folder, f, 'charge', 0.2, 8, 0.1, 'held for (s)');
    // 0 is "the offer stands while the button is down", which is the default.
    R(folder, f, 'hold', 0, 6, 0.1, 'offer lapses after (s)');
    R(folder, f, 'speed', 50, 500, 5, 'round speed (m/s)');
    R(folder, f, 'drop', 0, 10, 0.1, 'round falls (m/s²)');
    R(folder, f, 'tracer', 1, 8, 0.1, 'tracer × ordinary');

    const cost = folder.addFolder('What it costs');
    R(cost, f, 'damage', 10, 500, 5, 'body shot');
    R(cost, f, 'headDamage', 10, 600, 5, 'head shot');
    // The one that decides whether this is an anti-body round or a way of
    // clearing a group.
    R(cost, f, 'blastRadius', 0, 12, 0.1, 'blast reaches (m)');
    R(cost, f, 'blastDamage', 0, 400, 5, 'blast at the centre');
    R(cost, f, 'impulse', 0, 20, 0.1, 'shove (m/s)');
    R(cost, f, 'lift', 0, 12, 0.1, 'lift (m/s)');
    R(cost, f, 'spin', 0, 8, 0.05, 'fold');

    const feel = folder.addFolder('What it feels like');
    R(feel, f, 'recoilPitch', 0, 8, 0.05, 'kick up (deg)');
    R(feel, f, 'recoilYaw', 0, 4, 0.05, 'kick sideways (deg)');
    R(feel, f, 'shake', 0, 0.5, 0.005, 'knock firing (m)');
    R(feel, f, 'blastShake', 0, 0.6, 0.005, 'knock landing (m)');
    R(feel, f, 'hitStop', 0, 0.4, 0.005, 'freeze (s)');
    R(feel, f, 'hitStopScale', 0.01, 1, 0.01, 'freeze depth');

    const b = f.burst;
    const burst = folder.addFolder('The burst');
    burst.add(b, 'enabled').name('burst enabled');
    // The two masters. `radius` sets the scale of every shaped layer at once;
    // `life` is what the shell's and the core's own fractions are measured on.
    R(burst, b, 'radius', 0.5, 8, 0.05, 'opens to (m)');
    R(burst, b, 'life', 0.2, 4, 0.05, 'lasts (s)');
    R(burst, b, 'intensity', 0.1, 4, 0.05, 'brightness');
    R(burst, b, 'light', 0, 300, 1, 'light');
    R(burst, b, 'lightRange', 2, 80, 0.5, 'light reach (m)');
    burst.addColor(b, 'lightColor').name('light colour');

    const shell = burst.addFolder('1. The arc mesh');
    shell.add(b, 'shellEnabled').name('shown');
    shell.addColor(b, 'shellColor').name('colour');
    shell.addColor(b, 'shellCoreColor').name('line colour');
    R(shell, b, 'meridians', 1, 16, 1, 'meridians');
    R(shell, b, 'parallels', 1, 12, 1, 'parallels');
    // A fraction of the gap between two lines, so it means the same thing at
    // any count.
    R(shell, b, 'arcWidth', 0.005, 0.4, 0.005, 'arc width');
    R(shell, b, 'shellRim', 0.5, 8, 0.1, 'rim falloff');
    R(shell, b, 'shellWarp', 0, 0.6, 0.005, 'boil (m)');
    R(shell, b, 'shellDetail', 0.5, 8, 0.1, 'boil detail');
    R(shell, b, 'shellLife', 0.05, 1, 0.01, 'share of the life');

    const core = burst.addFolder('2. The core');
    core.add(b, 'coreEnabled').name('shown');
    core.addColor(b, 'coreColor').name('colour');
    core.addColor(b, 'coreHalo').name('halo');
    R(core, b, 'coreSize', 0.2, 10, 0.05, 'size (m)');
    R(core, b, 'coreLife', 0.02, 1, 0.01, 'share of the life');
    R(core, b, 'coreSpikes', 0, 12, 1, 'spikes');
    R(core, b, 'coreSpikeLength', 0, 4, 0.05, 'spike reach');

    const decal = burst.addFolder('3. The cracks');
    decal.add(b, 'decalEnabled').name('shown');
    decal.addColor(b, 'decalColor').name('colour');
    decal.addColor(b, 'decalCoreColor').name('hot colour');
    R(decal, b, 'decalRadius', 0.2, 12, 0.1, 'radius (m)');
    // Above this much floor clearance the round leaves no mark at all.
    R(decal, b, 'decalReach', 0.2, 10, 0.1, 'fades over (m) up');
    R(decal, b, 'decalDetail', 0.5, 16, 0.1, 'web detail');
    R(decal, b, 'decalSpokes', 0, 24, 1, 'big cracks');
    R(decal, b, 'decalScorch', 0, 2, 0.05, 'burn');
    R(decal, b, 'decalWrite', 0.01, 1, 0.01, 'written over');

    const debris = burst.addFolder('4. The debris');
    debris.add(b, 'debrisEnabled').name('shown');
    debris.addColor(b, 'debrisColor').name('colour');
    R(debris, b, 'debris', 0, 48, 1, 'chunks');
    R(debris, b, 'debrisSize', 0.01, 0.6, 0.005, 'size (m)');
    R(debris, b, 'debrisSpeed', 0.5, 30, 0.1, 'thrown at (m/s)');
    R(debris, b, 'debrisSpread', 0, 2, 0.01, 'spread');
    R(debris, b, 'debrisGravity', -40, 0, 0.5, 'fall (m/s²)');
    R(debris, b, 'debrisLife', 0.1, 4, 0.05, 'last (s)');

    const shower = burst.addFolder('5. The sparks');
    shower.add(b, 'sparksEnabled').name('shown');
    shower.addColor(b, 'sparkColor').name('colour');
    R(shower, b, 'sparks', 0, 200, 1, 'sparks');
    R(shower, b, 'sparkSpeed', 0.5, 40, 0.5, 'thrown at (m/s)');
    R(shower, b, 'sparkSize', 0.005, 0.4, 0.005, 'size (m)');
    R(shower, b, 'sparkLife', 0.05, 3, 0.05, 'last (s)');
    R(shower, b, 'sparkStretch', 0, 0.3, 0.005, 'streak');
    R(shower, b, 'sparkDrag', 0.05, 8, 0.05, 'drag');
    R(shower, b, 'sparkGravity', -40, 0, 0.5, 'fall (m/s²)');

    const shards = burst.addFolder('6. The shards');
    shards.add(b, 'shardsEnabled').name('shown');
    shards.addColor(b, 'shardColor').name('colour');
    shards.addColor(b, 'shardColorAlt').name('second colour');
    R(shards, b, 'shards', 0, 160, 1, 'shards');
    R(shards, b, 'shardSpeed', 0.5, 40, 0.5, 'thrown at (m/s)');
    R(shards, b, 'shardSize', 0.01, 0.8, 0.005, 'length (m)');
    R(shards, b, 'shardLife', 0.05, 3, 0.05, 'last (s)');
    R(shards, b, 'shardDrag', 0.05, 8, 0.05, 'drag');
    R(shards, b, 'shardGravity', -40, 0, 0.5, 'fall (m/s²)');

    const haze = burst.addFolder('7. The haze');
    haze.add(b, 'hazeEnabled').name('shown');
    haze.addColor(b, 'hazeColor').name('colour');
    R(haze, b, 'haze', 0, 32, 1, 'puffs');
    R(haze, b, 'hazeOpacity', 0, 1, 0.01, 'opacity');
    R(haze, b, 'hazeSize', 0.1, 4, 0.05, 'size (m)');
    R(haze, b, 'hazeGrowth', 1, 8, 0.05, 'grows to ×');
    R(haze, b, 'hazeRise', 0, 6, 0.05, 'climbs at (m/s)');
    R(haze, b, 'hazeLife', 0.1, 5, 0.05, 'last (s)');
  }

  _buildCombat() {
    const folder = this.gui.addFolder('Combat');
    const R = Editor.range;

    // One folder per move, built from the same three groups — every attack is
    // the same machine (`animation/Attack.js`) with different numbers, so there
    // is nothing to say about one of them that is not a field on all of them.
    this._buildAttack(folder, settings.kick, 'Kick (E)');
    this._buildAttack(folder, settings.slashHit, 'Slash hit (R)');
    this._buildAttack(folder, settings.crouchSlash, 'Slide cut (T)');
    this._buildAttack(folder, settings.flipKick, 'Flip kick (Q)');
    this._buildAttack(folder, settings.swordCombo, 'Sword combo (Z)');
    this._buildSwordCombo(folder);
    this._buildAttack(folder, settings.voidBeam, 'Unmaking (B)');
    this._buildVoidBeam(folder);
    this._buildAttack(folder, settings.crimsonRite, 'Crimson rite (V)');
    this._buildCrimsonRite(folder);
    this._buildTargetRing(folder);
    this._buildSlice(folder);

    const e = settings.enemies;
    const enemies = folder.addFolder('Enemies');
    enemies.add(e, 'enabled').name('enemies enabled');
    R(enemies, e, 'count', 0, 20, 1, 'standing at once');
    R(enemies, e, 'radius', 2, 40, 0.5, 'spawn radius (m)');
    R(enemies, e, 'minRadius', 1, 20, 0.5, 'no closer than (m)');
    R(enemies, e, 'separation', 0.5, 6, 0.1, 'apart from each other (m)');
    R(enemies, e, 'height', 1, 3, 0.01, 'height (m)');
    R(enemies, e, 'corpseTime', 0, 30, 0.5, 'corpse stays (s)');
    R(enemies, e, 'dissolveTime', 0.1, 6, 0.1, 'burns away over (s)');
    R(enemies, e, 'respawnDelay', 0, 15, 0.1, 'respawn after (s)');
    enemies.add(e, 'watch').name('watch the player');
    R(enemies, e, 'watchRadius', 2, 40, 0.5, 'watch within (m)');
    R(enemies, e, 'turnRate', 0.000001, 0.2, 0.000001, 'turn follow');
    enemies.add(e, 'collide').name('block the player');
    R(enemies, e, 'bodyRadius', 0.1, 1.5, 0.01, 'body radius (m)');
    enemies
      .add({ respawn: () => this.hooks.onRespawnEnemies?.() }, 'respawn')
      .name('Respawn all');

    // Authored rather than imported — the export carries no textures at all.
    const look = enemies.addFolder('Look');
    const el = e.look;
    look.addColor(el, 'color').name('body colour');
    R(look, el, 'roughness', 0, 1, 0.01, 'roughness');
    R(look, el, 'metalness', 0, 1, 0.01, 'metalness');
    look.addColor(el, 'rimColor').name('rim colour');
    R(look, el, 'rimPower', 0.2, 8, 0.05, 'rim tightness');
    R(look, el, 'rimEmissive', 0, 8, 0.01, 'rim emissive');
    look.addColor(el, 'edgeColor').name('burn colour');
    R(look, el, 'edgeEmissive', 0, 20, 0.1, 'burn emissive');
    R(look, el, 'edgeWidth', 0.01, 0.5, 0.01, 'burn width');
    R(look, el, 'dissolveDetail', 1, 40, 0.5, 'burn detail');
    R(look, el, 'dissolveRise', 0, 1, 0.01, 'burn rises');

    // The ragdoll. `brace` is the one worth understanding: bone lengths alone
    // give a rope, and these extra constraints across the pelvis and chest are
    // what give the body a shape it is trying to keep as it falls.
    const doll = enemies.addFolder('Ragdoll');
    const r = e.ragdoll;
    R(doll, r, 'gravity', -60, -1, 0.5, 'gravity (m/s²)');
    R(doll, r, 'damping', 0, 0.9, 0.01, 'air drag /s');
    R(doll, r, 'iterations', 1, 20, 1, 'solver passes');
    R(doll, r, 'substeps', 1, 6, 1, 'substeps');
    R(doll, r, 'brace', 0, 1, 0.01, 'torso stiffness');
    R(doll, r, 'radius', 0.01, 0.4, 0.005, 'joint radius (m)');
    R(doll, r, 'friction', 0, 1, 0.01, 'ground friction');
    R(doll, r, 'bounce', 0, 0.8, 0.01, 'bounce');
    R(doll, r, 'sleep', 0, 0.5, 0.005, 'sleeps below');
  }

  /**
   * One melee move's three groups: who it goes to, when it lands, what it does.
   *
   * The numbers to reach for after watching a move once are the normalised
   * times — the blow connects *here*, control comes back *there*, and the warp
   * has that long to put the body where the animator assumed it was standing.
   * Everything else follows from those three.
   *
   * @param {import('lil-gui').GUI} parent
   * @param {object} config a `settings.kick`-shaped block
   * @param {string} title what the folder is called, hotkey included
   */
  _buildAttack(parent, config, title) {
    const folder = parent.addFolder(title);
    const R = Editor.range;

    folder.add(config, 'enabled').name('enabled');

    // Who the blow goes to. `range` and `cone` decide what can be locked at
    // all; `standoff` is the distance the strike is thrown from, and it is the
    // one that decides whether the foot lands on the chest or through it.
    const aim = folder.addFolder('Target & warp');
    R(aim, config, 'range', 0.5, 12, 0.05, 'lock range (m)');
    R(aim, config, 'cone', 20, 360, 1, 'lock cone (°)');
    R(aim, config, 'standoff', 0.4, 2.5, 0.01, 'strike from (m)');
    R(aim, config, 'maxWarp', 0, 12, 0.05, 'max step in (m)');
    // Only the combo states one: it stands still and throws for two thirds of
    // its clip before it closes, and the gap between this and `warpAt` is the
    // dash. Everything else begins closing on the frame it starts.
    if ('warpFrom' in config) R(aim, config, 'warpFrom', 0, 0.9, 0.01, 'approach starts at');
    R(aim, config, 'warpAt', 0.05, 0.9, 0.01, 'approach ends at');
    R(aim, config, 'turnAt', 0.05, 1, 0.01, 'turn done by');
    // Only the two moves that do not stop on their mark carry these, so they
    // are on the blocks that asked for them rather than on every move. The
    // sign on the first is the direction: positive is the far side of the body
    // (the slide cut), negative is back off it (the flip kick).
    if ('passThrough' in config) {
      R(aim, config, 'passThrough', -5, 5, 0.05, 'ends off mark by (m)');
      if ('passFrom' in config) R(aim, config, 'passFrom', 0.05, 1, 0.01, 'leaves the mark at');
      R(aim, config, 'passAt', 0.1, 1, 0.01, 'pass ends at');
    }

    // The clip's own timeline. Every time here is normalised, so `timeScale`
    // rides over all of them: it changes how long the move takes without moving
    // where in it the blow lands.
    const timing = folder.addFolder('Timing');
    R(timing, config, 'hitAt', 0.05, 0.95, 0.01, 'blow connects at');
    R(timing, config, 'reach', 0.5, 4, 0.05, 'connects within (m)');
    R(timing, config, 'recoverAt', 0.3, 1, 0.01, 'control returns at');
    if ('timeScale' in config) R(timing, config, 'timeScale', 0.25, 3, 0.01, 'played at ×');
    R(timing, config, 'blendIn', 0.01, 0.6, 0.01, 'blend in (s)');
    R(timing, config, 'blendOut', 0.01, 0.8, 0.01, 'blend out (s)');

    // What the blow does. `spin` is the one with the least obvious name and the
    // most obvious effect: it is how much harder the shoulders are thrown than
    // the feet, which is the whole difference between sliding and folding.
    const impact = folder.addFolder('Impact');
    R(impact, config, 'impulse', 0, 25, 0.1, 'force (m/s)');
    R(impact, config, 'lift', 0, 15, 0.1, 'lift (m/s)');
    R(impact, config, 'spin', 0, 4, 0.05, 'upper body ×');
    R(impact, config, 'hitStop', 0, 0.3, 0.005, 'hit stop (s)');
    R(impact, config, 'hitStopScale', 0, 1, 0.01, 'hit stop time ×');
    R(impact, config, 'shake', 0, 1, 0.01, 'camera shake (m)');
    // A fact about the move, not about the body it lands on — which is why it
    // is a field here and not in the enemies' block.
    if ('slices' in config) impact.add(config, 'slices').name('cuts in half');
  }


  /**
   * Everything the three-hit combo throws — see `vfx/SwordCombo.js`.
   *
   * The move's own numbers are in the `Sword combo (Z)` folder above, with
   * every other attack's, because it is the same machine as they are. This is
   * only the part of it that is *light*, and it is a folder of its own because
   * there is far more of it than of the move.
   *
   * If only one control here is ever touched, make it the crescent's `razor` —
   * it is where the hard white line sits along the leading edge, and it is the
   * whole difference between a cut and a glowing ribbon.
   */
  _buildSwordCombo(parent) {
    const folder = parent.addFolder('Sword combo VFX');
    const R = Editor.range;
    const c = settings.swordCombo;

    // The crescents themselves: what is thrown, and what it is made of.
    const wave = folder.addFolder('Thrown cuts');
    wave.add(c.wave, 'enabled').name('enabled');
    R(wave, c.wave, 'aimHeight', 0, 2.2, 0.01, 'aimed at height (m)');
    R(wave, c.wave, 'size', 0.4, 4, 0.05, 'arc radius (m)');
    R(wave, c.wave, 'speed', 8, 90, 1, 'travels at (m/s)');
    R(wave, c.wave, 'life', 0.2, 3, 0.05, 'expires after (s)');
    R(wave, c.wave, 'hold', 0.05, 1, 0.01, 'hangs on contact (s)');
    R(wave, c.wave, 'finishLife', 0.1, 1.5, 0.01, 'finisher arc holds (s)');
    R(wave, c.wave, 'homing', 0, 12, 0.1, 'steers at (1/s)');

    // The shape. `converge` and `tipTaper` decide the silhouette, `razor` and
    // `erode` decide whether it reads as an edge or as smoke.
    const shape = wave.addFolder('Shape');
    R(shape, c.wave, 'spread', 0.6, 3.1, 0.01, 'arc subtends (rad)');
    R(shape, c.wave, 'converge', 0, 0.95, 0.01, 'inner edge bows in');
    R(shape, c.wave, 'bow', 0, 1, 0.01, 'tips cup out by');
    R(shape, c.wave, 'tail', 0, 2, 0.01, 'veil length (× radius)');
    R(shape, c.wave, 'tipTaper', 0.15, 2, 0.01, 'tip sharpness');
    R(shape, c.wave, 'razor', 0.5, 0.995, 0.005, 'edge line at');
    R(shape, c.wave, 'erode', 0, 3, 0.01, 'veil eaten by');
    R(shape, c.wave, 'grow', 0, 1.5, 0.01, 'opens over flight by');

    const waveColour = wave.addFolder('Colour');
    waveColour.addColor(c.wave, 'coreColor').name('edge line');
    waveColour.addColor(c.wave, 'edgeColor').name('edge glow');
    waveColour.addColor(c.wave, 'bodyColor').name('body');
    waveColour.addColor(c.wave, 'tailColor').name('veil');
    R(waveColour, c.wave, 'intensity', 0, 10, 0.05, 'brightness');

    // The finisher's own shape, and the only thing in the move that is not a
    // cut. Five layers, one sub-folder each, in the order they are drawn — and
    // every one of them has an `enabled` at the top of its folder so it can be
    // soloed against the other four, which is the only sane way to tune a stack
    // of additive light.
    const rift = folder.addFolder('Finisher burst');
    rift.add(c.rift, 'enabled').name('enabled');

    // 1. The air around it, lit. There is no bloom pass worth the name on this
    //    stage, so this layer is the glow.
    const halo = rift.addFolder('1 · Halo');
    halo.add(c.rift, 'haloEnabled').name('enabled');
    R(halo, c.rift, 'haloRadius', 0.5, 14, 0.1, 'reaches (m)');
    R(halo, c.rift, 'haloLife', 0.1, 2, 0.01, 'lasts (s)');
    R(halo, c.rift, 'haloIntensity', 0, 6, 0.05, 'brightness');
    halo.addColor(c.rift, 'haloColor').name('inner');
    halo.addColor(c.rift, 'haloEdgeColor').name('outer');

    // 2. The sphere, drawn on its rim. `rim tightness` is the control: high is
    //    a shell, low is a ball.
    const shell = rift.addFolder('2 · Shell');
    R(shell, c.rift, 'radius', 0.3, 6, 0.05, 'reaches (m)');
    R(shell, c.rift, 'life', 0.1, 2, 0.01, 'lasts (s)');
    R(shell, c.rift, 'fresnel', 0.4, 6, 0.05, 'rim tightness');
    R(shell, c.rift, 'churn', 0, 1, 0.01, 'surface displaced by');
    R(shell, c.rift, 'churnSpeed', 0, 8, 0.05, 'surface crawls at');
    R(shell, c.rift, 'intensity', 0, 10, 0.05, 'brightness');
    shell.addColor(c.rift, 'coreColor').name('flash (shared)');
    shell.addColor(c.rift, 'rimColor').name('rim');
    shell.addColor(c.rift, 'deepColor').name('interior');

    // 3. The grain inside it. `smear` is what stops the field strobing.
    const motes = rift.addFolder('3 · Core');
    motes.add(c.rift, 'moteEnabled').name('enabled');
    R(motes, c.rift, 'moteCount', 0, 320, 1, 'motes (cost)');
    R(motes, c.rift, 'moteReach', 0.2, 8, 0.05, 'thrown to (m)');
    R(motes, c.rift, 'moteLife', 0.1, 2, 0.01, 'last (s)');
    R(motes, c.rift, 'moteSize', 0.005, 0.2, 0.001, 'size (m)');
    R(motes, c.rift, 'moteStretch', 0, 0.1, 0.001, 'smear');
    R(motes, c.rift, 'escape', 0, 0.6, 0.01, 'fraction escaping');
    R(motes, c.rift, 'escapeReach', 0, 6, 0.05, 'escapees go × further');
    R(motes, c.rift, 'moteIntensity', 0, 10, 0.05, 'brightness');
    motes.addColor(c.rift, 'moteColor').name('colour');

    // 4. The shockwave, outrunning the shell on three planes.
    const rings = rift.addFolder('4 · Rings');
    R(rings, c.rift, 'ringRadius', 0.3, 10, 0.05, 'reach (m)');
    R(rings, c.rift, 'ringLife', 0.1, 2, 0.01, 'last (s)');
    R(rings, c.rift, 'ringWidth', 0.01, 0.4, 0.005, 'band width');
    R(rings, c.rift, 'ringSoftness', 0.01, 0.5, 0.005, 'band feather');
    R(rings, c.rift, 'ringSpin', 0, 10, 0.05, 'turn at (rad/s)');
    R(rings, c.rift, 'spokes', 0, 60, 1, 'spokes');
    R(rings, c.rift, 'spokeDepth', 0, 1, 0.01, 'spoke depth');
    R(rings, c.rift, 'ringIntensity', 0, 10, 0.05, 'brightness');
    rings.addColor(c.rift, 'ringColor').name('colour');

    // 5. The needles. `reach` is the single strongest control over the shape of
    //    the finisher; `out of plane` is what stops it being a flat sun.
    const shards = rift.addFolder('5 · Shards');
    shards.add(c.rift, 'shardEnabled').name('enabled');
    R(shards, c.rift, 'shardCount', 0, 28, 1, 'needles');
    R(shards, c.rift, 'shardLength', 0.5, 12, 0.1, 'reach (m)');
    R(shards, c.rift, 'shardWidth', 0.005, 0.3, 0.005, 'width (m)');
    R(shards, c.rift, 'shardLife', 0.05, 1.2, 0.01, 'last (s)');
    R(shards, c.rift, 'shardRoot', 0, 0.6, 0.01, 'root starts at (× reach)');
    R(shards, c.rift, 'shardBias', 0, 1, 0.01, 'out of plane');
    R(shards, c.rift, 'shardIntensity', 0, 10, 0.05, 'brightness');
    shards.addColor(c.rift, 'shardColor').name('colour');

    // The flash and the shower — `vfx/BladeImpact.js`, and the three
    // multipliers that separate leaving, landing and finishing.
    const impact = folder.addFolder('Flash & sparks');
    impact.add(c.impact, 'enabled').name('enabled');
    R(impact, c, 'launchFlash', 0, 3, 0.05, 'flash on leaving ×');
    R(impact, c, 'arriveFlash', 0, 3, 0.05, 'flash on landing ×');
    R(impact, c, 'finishFlash', 0, 4, 0.05, 'flash on finisher ×');
    R(impact, c.impact, 'life', 0.05, 1, 0.01, 'flash life (s)');
    R(impact, c.impact, 'size', 0.1, 3, 0.05, 'flash size (m)');
    R(impact, c.impact, 'intensity', 0, 10, 0.05, 'brightness');
    R(impact, c.impact, 'spikes', 0, 16, 1, 'star spikes');
    R(impact, c.impact, 'spikeLength', 0, 4, 0.05, 'spike reach');
    R(impact, c.impact, 'sparks', 0, 300, 1, 'sparks');
    R(impact, c.impact, 'sparkSpeed', 0, 30, 0.1, 'spark speed (m/s)');
    R(impact, c.impact, 'sparkSpread', 0, 1.3, 0.01, 'spark cone (rad)');
    R(impact, c.impact, 'sparkLife', 0.05, 2, 0.01, 'spark life (s)');
    R(impact, c.impact, 'sparkSize', 0.005, 0.15, 0.001, 'spark size (m)');
    R(impact, c.impact, 'sparkStretch', 0, 0.2, 0.001, 'spark streak');
    R(impact, c.impact, 'sparkDrag', 0.05, 6, 0.05, 'spark drag');
    R(impact, c.impact, 'sparkGravity', -40, 0, 0.5, 'spark gravity');
    impact.addColor(c.impact, 'color').name('flash colour');
    impact.addColor(c.impact, 'ringColor').name('ring colour');
    impact.addColor(c.impact, 'sparkColor').name('spark colour');

    // The ground's answer under the finisher — `vfx/ShockRing.js`.
    const shock = folder.addFolder('Ground wave');
    shock.add(c.shock, 'enabled').name('enabled');
    R(shock, c.shock, 'radius', 0.5, 10, 0.1, 'reaches (m)');
    R(shock, c.shock, 'life', 0.1, 2, 0.01, 'takes (s)');
    R(shock, c.shock, 'intensity', 0, 8, 0.05, 'brightness');
    R(shock, c.shock, 'width', 0.005, 0.4, 0.005, 'front width');
    R(shock, c.shock, 'softness', 0.005, 0.4, 0.005, 'front feather');
    R(shock, c.shock, 'cracks', 0, 30, 1, 'cracks');
    R(shock, c.shock, 'crackLength', 0, 1.5, 0.01, 'crack reach');
    R(shock, c.shock, 'crackWidth', 0.001, 0.1, 0.001, 'crack width');
    R(shock, c.shock, 'crackGlow', 0, 4, 0.05, 'crack glow');
    R(shock, c.shock, 'lift', 0, 0.2, 0.001, 'lifted off floor (m)');
    shock.addColor(c.shock, 'color').name('front colour');
    shock.addColor(c.shock, 'crackColor').name('crack colour');

    // One light for all of it. `decay` is the control that matters — long
    // enough and the whole combo is lit from its own cuts.
    const light = folder.addFolder('Light');
    R(light, c.light, 'intensity', 0, 120, 1, 'peak');
    R(light, c.light, 'range', 2, 40, 0.5, 'carries (m)');
    R(light, c.light, 'decay', 0.05, 1.5, 0.01, 'decays over (s)');
    R(light, c.light, 'launch', 0, 1, 0.01, 'on leaving ×');
    R(light, c.light, 'arrive', 0, 1, 0.01, 'on landing ×');
    R(light, c.light, 'finish', 0, 1, 0.01, 'on finisher ×');
    light.addColor(c.light, 'color').name('colour');

    // The one part of the move that happens on the body — `vfx/ShadowDash.js`.
    // `starts before` and `holds past` are stated against the move's own
    // approach (`warpFrom`/`warpAt` in the folder above), so retiming the dash
    // carries the burn with it and neither control has to be touched again.
    const dash = folder.addFolder('Shadow dash');
    const d = c.shadowDash;
    dash.add(d, 'enabled').name('enabled');
    R(dash, d, 'lead', 0, 0.3, 0.005, 'starts before dash (phase)');
    R(dash, d, 'linger', 0, 0.3, 0.005, 'holds past arrival (phase)');
    R(dash, d, 'enter', 0.02, 1, 0.01, 'goes dark over (s)');
    R(dash, d, 'exit', 0.02, 1.5, 0.01, 'comes back over (s)');
    R(dash, d, 'detail', 1, 40, 0.5, 'burn detail (/m)');
    R(dash, d, 'rise', 0, 1, 0.01, 'burn rises');
    R(dash, d, 'drift', 0, 4, 0.05, 'field crawls at (/s)');
    R(dash, d, 'roughness', 0, 1, 0.01, 'roughness');
    R(dash, d, 'metalness', 0, 1, 0.01, 'metalness');
    R(dash, d.fresnel, 'power', 0.2, 8, 0.05, 'rim tightness');
    R(dash, d.fresnel, 'emissive', 0, 8, 0.01, 'rim emissive');
    R(dash, d, 'edgeEmissive', 0, 20, 0.1, 'burn emissive');
    R(dash, d, 'edgeWidth', 0.01, 0.5, 0.005, 'burn width');
    dash.addColor(d, 'color').name('shade colour');
    dash.addColor(d.fresnel, 'color').name('rim colour');
    dash.addColor(d, 'edgeColor').name('burn colour');
  }

  /**
   * Everything the unmaking calls up — see `vfx/RunicBeam.js`.
   *
   * The move's own numbers are in the `Unmaking (B)` folder above, with every
   * other attack's, because it is the same machine as they are. This is the
   * part of it that is *light*, plus the one block that is neither — `unmake`,
   * which is how a body taken by the beam goes away.
   *
   * Five layers, a sub-folder each, in the order they are drawn, and every one
   * with an `enabled` at the top of its folder so it can be soloed against the
   * other four.
   *
   * If only one control here is ever touched, make it the beam's `axis gather`:
   * it is the exponent on how square a piece of the wall is to the lens, and it
   * is the whole difference between a column of light and a glowing pipe.
   */
  _buildVoidBeam(parent) {
    const folder = parent.addFolder('Unmaking VFX');
    const R = Editor.range;
    const c = settings.voidBeam;

    // The pacing. `charge` is the odd one: it is a timeout rather than a beat,
    // and it has to stay longer than the gap between the clip's two strikes.
    const beats = folder.addFolder('Timing');
    R(beats, c.beats, 'open', 0.05, 1.5, 0.01, 'rune writes over (s)');
    R(beats, c.beats, 'charge', 0.2, 3, 0.01, 'gathers for, max (s)');
    R(beats, c.beats, 'strike', 0.05, 1, 0.01, 'column rises in (s)');
    R(beats, c.beats, 'hold', 0.1, 4, 0.05, 'stands for (s)');
    R(beats, c.beats, 'close', 0.05, 2, 0.01, 'pinches out over (s)');
    R(beats, c.beats, 'ripple', 0.05, 1.5, 0.01, 'rune ripple (s)');

    // 1. The circle on the ground. The same shader the light's seal uses.
    const seal = folder.addFolder('1 · Runes');
    R(seal, c.seal, 'radius', 0.4, 6, 0.05, 'radius (m)');
    R(seal, c.seal, 'lift', 0, 0.3, 0.005, 'off the floor (m)');
    R(seal, c.seal, 'intensity', 0, 6, 0.05, 'brightness');
    R(seal, c.seal, 'spin', -1, 1, 0.005, 'turns a second');
    R(seal, c.seal, 'ticks', 4, 120, 1, 'ticks');
    R(seal, c.seal, 'runes', 3, 40, 1, 'glyphs');
    R(seal, c.seal, 'spokes', 2, 24, 1, 'spokes');
    R(seal, c.seal, 'width', 0.002, 0.06, 0.001, 'stroke weight');
    R(seal, c.seal, 'softness', 0.002, 0.06, 0.001, 'stroke feather');
    R(seal, c.seal, 'haze', 0, 1.5, 0.01, 'light pooled inside');
    R(seal, c.seal, 'detail', 0, 1, 0.01, 'how mottled');
    R(seal, c.seal, 'pulse', 0, 1, 0.01, 'breath depth');
    R(seal, c.seal, 'pulseSpeed', 0, 14, 0.1, 'breath speed');
    seal.addColor(c.seal, 'color').name('lines');
    seal.addColor(c.seal, 'coreColor').name('centre');

    // 2. The column. `axis gather` is the control; everything else dresses it.
    const beam = folder.addFolder('2 · Beam');
    beam.add(c.beam, 'enabled').name('enabled');
    R(beam, c.beam, 'height', 1, 20, 0.1, 'height (m)');
    R(beam, c.beam, 'radius', 0.05, 3, 0.01, 'radius (m)');
    R(beam, c.beam, 'flare', 0, 2, 0.01, 'foot flare');
    R(beam, c.beam, 'swell', 0, 1.5, 0.01, 'swell on opening');
    R(beam, c.beam, 'breathe', 0, 0.2, 0.005, 'breath depth');
    R(beam, c.beam, 'breatheSpeed', 0, 20, 0.1, 'breath speed');
    R(beam, c.beam, 'corePower', 0.2, 10, 0.05, 'axis gather');
    R(beam, c.beam, 'glowPower', 0.1, 4, 0.05, 'glow spread');
    R(beam, c.beam, 'grain', 0.2, 12, 0.05, 'features up it');
    R(beam, c.beam, 'swirl', 0.2, 6, 0.05, 'features round it');
    R(beam, c.beam, 'flow', 0, 8, 0.05, 'falls at');
    R(beam, c.beam, 'erode', 0, 1.5, 0.01, 'eaten by noise');
    R(beam, c.beam, 'headWidth', 0.005, 0.4, 0.005, 'head band');
    R(beam, c.beam, 'footGlow', 0.01, 0.6, 0.005, 'foot bloom');
    R(beam, c.beam, 'crown', 0.1, 0.999, 0.005, 'top fades from');
    R(beam, c.beam, 'intensity', 0, 8, 0.05, 'brightness');
    beam.addColor(c.beam, 'coreColor').name('axis');
    beam.addColor(c.beam, 'innerColor').name('body');
    beam.addColor(c.beam, 'edgeColor').name('edges');

    // 3. The cords. `count` is capped at 6 by the buffer they share.
    const spiral = folder.addFolder('3 · Spirals');
    spiral.add(c.spiral, 'enabled').name('enabled');
    R(spiral, c.spiral, 'count', 0, 6, 1, 'cords');
    R(spiral, c.spiral, 'radius', 0.05, 3, 0.01, 'radius (m)');
    R(spiral, c.spiral, 'reach', 0.1, 1.2, 0.01, 'run × the height');
    R(spiral, c.spiral, 'turns', 0.2, 8, 0.05, 'turns');
    R(spiral, c.spiral, 'width', 0.005, 0.4, 0.005, 'width (m)');
    R(spiral, c.spiral, 'taper', 0, 1, 0.01, 'width left at the top');
    R(spiral, c.spiral, 'spin', -8, 8, 0.05, 'winds at (rad/s)');
    R(spiral, c.spiral, 'flare', 0, 2, 0.01, 'opens out by');
    R(spiral, c.spiral, 'sharpness', 0.5, 8, 0.05, 'edge falloff');
    R(spiral, c.spiral, 'pulse', 0, 40, 0.5, 'waves along it');
    R(spiral, c.spiral, 'intensity', 0, 8, 0.05, 'brightness');
    spiral.addColor(c.spiral, 'coreColor').name('middle');
    spiral.addColor(c.spiral, 'colorA').name('cord A');
    spiral.addColor(c.spiral, 'colorB').name('cord B');

    // 4. The burst at its foot — the blades' own system again.
    const impact = folder.addFolder('4 · Burst');
    impact.add(c.impact, 'enabled').name('enabled');
    R(impact, c, 'strikeFlash', 0, 3, 0.05, 'size ×');
    R(impact, c, 'impactHeight', 0, 3, 0.05, 'thrown at height (m)');
    R(impact, c.impact, 'life', 0.05, 1.5, 0.01, 'flash life (s)');
    R(impact, c.impact, 'size', 0.1, 4, 0.05, 'flash size (m)');
    R(impact, c.impact, 'intensity', 0, 10, 0.05, 'brightness');
    R(impact, c.impact, 'spikes', 0, 16, 1, 'star spikes');
    R(impact, c.impact, 'spikeLength', 0, 4, 0.05, 'spike reach');
    R(impact, c.impact, 'sparks', 0, 300, 1, 'sparks');
    R(impact, c.impact, 'sparkSpeed', 0, 30, 0.1, 'spark speed (m/s)');
    R(impact, c.impact, 'sparkSpread', 0, 1.3, 0.01, 'spark cone (rad)');
    R(impact, c.impact, 'sparkLife', 0.05, 2, 0.01, 'spark life (s)');
    R(impact, c.impact, 'sparkSize', 0.005, 0.15, 0.001, 'spark size (m)');
    R(impact, c.impact, 'sparkStretch', 0, 0.2, 0.001, 'spark streak');
    R(impact, c.impact, 'sparkDrag', 0.05, 6, 0.05, 'spark drag');
    R(impact, c.impact, 'sparkGravity', -40, 0, 0.5, 'spark gravity');
    impact.addColor(c.impact, 'color').name('flash colour');
    impact.addColor(c.impact, 'ringColor').name('ring colour');
    impact.addColor(c.impact, 'sparkColor').name('spark colour');

    // 5. The grain. `count` is nearly free — each shard is a closed form.
    const grain = folder.addFolder('5 · Grain');
    grain.add(c.grain, 'enabled').name('enabled');
    R(grain, c.grain, 'count', 0, 320, 1, 'shards');
    R(grain, c.grain, 'radius', 0.05, 4, 0.05, 'start out at (m)');
    R(grain, c.grain, 'spread', 0, 4, 0.05, 'drift out by (m)');
    R(grain, c.grain, 'rise', 0.5, 16, 0.1, 'climb (m)');
    R(grain, c.grain, 'swirl', -10, 10, 0.05, 'turn at (rad/s)');
    R(grain, c.grain, 'size', 0.005, 0.4, 0.005, 'size (m)');
    R(grain, c.grain, 'life', 0.2, 6, 0.05, 'one loop takes (s)');
    R(grain, c.grain, 'spike', 1, 16, 0.1, 'needle length');
    R(grain, c.grain, 'intensity', 0, 8, 0.05, 'brightness');
    grain.addColor(c.grain, 'color').name('shard');
    grain.addColor(c.grain, 'coreColor').name('centre');

    // The light, hung partway up rather than at the foot.
    const light = folder.addFolder('Light');
    R(light, c.light, 'intensity', 0, 200, 1, 'peak');
    R(light, c.light, 'range', 2, 45, 0.5, 'carries (m)');
    R(light, c.light, 'decay', 0.05, 2, 0.01, 'flash decays over (s)');
    R(light, c.light, 'height', 0, 1, 0.01, 'hangs at × the height');
    R(light, c.light, 'hold', 0, 2, 0.01, 'standing ×');
    R(light, c.light, 'gather', 0, 2, 0.01, 'gathering ×');
    light.addColor(c.light, 'color').name('colour');

    // Not light at all: how the body it takes goes away. It is here rather than
    // in `Enemies` for the same reason `cuts in half` is on the move — what
    // killed a body decides how it leaves, and this block is that decision.
    const unmake = folder.addFolder('The burn');
    R(unmake, c.unmake, 'corpseTime', 0, 6, 0.05, 'lies there (s)');
    R(unmake, c.unmake, 'dissolveTime', 0.1, 6, 0.05, 'burns away over (s)');
    R(unmake, c.unmake, 'edgeEmissive', 0, 20, 0.1, 'burn line heat');
    R(unmake, c.unmake, 'edgeWidth', 0.01, 0.6, 0.005, 'burn line width');
    R(unmake, c.unmake, 'dissolveRise', 0, 1, 0.01, 'burns bottom-up by');
    unmake.addColor(c.unmake, 'edgeColor').name('burn line');
  }

  /**
   * Everything the crimson rite calls up — see `vfx/CrimsonRite.js`.
   *
   * The move's own numbers are in the `Crimson rite (V)` folder above, with
   * every other attack's, because it is the same machine as they are. This is
   * the part of it that is *light* — and there is a great deal more of it than
   * of the move, which is why it is a folder of its own.
   *
   * The folders are numbered in the order the layers are drawn, which is also
   * the order the reference breaks the effect into. Every one of them has an
   * `enabled` at the top so it can be soloed against the other five, and that
   * is by far the fastest way to understand what any single number is doing.
   *
   * If only one control here is ever touched, make it the strokes' `tear`: it
   * is how hard a stroke comes apart as it dies, and it is the whole difference
   * between a cut and a glowing ribbon fading out.
   */
  _buildCrimsonRite(parent) {
    const folder = parent.addFolder('Crimson rite VFX');
    const R = Editor.range;
    const c = settings.crimsonRite;

    // The pacing. Everything after the cast is here rather than in `hits`,
    // because the clip only marks two frames and the move has four impacts.
    const beats = folder.addFolder('Choreography');
    R(beats, c, 'height', 0, 2.4, 0.01, 'blades ring at (m)');
    R(beats, c, 'stabs', 1, 6, 1, 'thrusts');
    R(beats, c, 'wound', 0, 20, 0.5, 'per thrust (health)');
    R(beats, c.beats, 'mark', 0.05, 2, 0.01, 'ink wells up over (s)');
    R(beats, c.beats, 'charge', 0.2, 4, 0.05, 'gives up after (s)');
    R(beats, c.beats, 'between', 0.05, 1, 0.01, 'thrusts ordered every (s)');
    R(beats, c.beats, 'hold', 0, 1.5, 0.01, 'held on the points (s)');
    R(beats, c.beats, 'rend', 0.1, 2, 0.05, 'tear-out (s)');
    R(beats, c.beats, 'settle', 0.1, 3, 0.05, 'ink sinks over (s)');
    R(beats, c.beats, 'abandon', 0.5, 8, 0.05, 'gives up waiting after (s)');
    R(beats, c, 'stabShake', 0, 1, 0.01, 'thrust shake (m)');
    R(beats, c, 'rendShake', 0, 1, 0.01, 'tear-out shake (m)');
    R(beats, c, 'markRing', 0, 3, 0.05, 'mark ring ×');
    R(beats, c, 'stabRing', 0, 3, 0.05, 'thrust ring ×');
    R(beats, c, 'rendRing', 0, 3, 0.05, 'tear-out ring ×');
    R(beats, c, 'stabMist', 0, 4, 0.05, 'thrust cloud ×');
    R(beats, c, 'rendMist', 0, 4, 0.05, 'tear-out cloud ×');

    /* ---- 1 · the strokes ---- */
    const trails = folder.addFolder('1. Slash trails');
    const t = c.trails;
    trails.add(t, 'enabled').name('shown');
    trails.addColor(t, 'coreColor').name('razor colour');
    trails.addColor(t, 'color').name('body colour');
    trails.addColor(t, 'edgeColor').name('tail colour');
    R(trails, t, 'intensity', 0, 8, 0.05, 'brightness');
    R(trails, t, 'razor', 0, 1, 0.01, 'razor sits at');
    R(trails, t, 'razorWidth', 0.01, 0.5, 0.005, 'razor width');
    R(trails, t, 'core', 0, 5, 0.05, 'razor heat');
    R(trails, t, 'falloff', 0.2, 6, 0.05, 'body falloff');
    R(trails, t, 'tip', 0.05, 2, 0.01, 'tip sharpness');
    R(trails, t, 'draw', 0.01, 0.9, 0.01, 'swept over (of life)');
    R(trails, t, 'headSoft', 0.01, 0.4, 0.005, 'head feather');
    R(trails, t, 'headFlare', 0, 6, 0.05, 'head heat');
    R(trails, t, 'detail', 0.2, 12, 0.1, 'tear detail');
    R(trails, t, 'flow', 0, 6, 0.05, 'tear crawl');
    R(trails, t, 'tear', 0, 3, 0.01, 'tears apart by');
    R(trails, t, 'hair', 2, 80, 0.5, 'filaments');
    R(trails, t, 'hairDepth', 0, 1, 0.01, 'filament depth');

    // The same look, twice, as two gestures. A big radius with a small sweep is
    // a nearly straight streak (a thrust); a small radius with a large sweep is
    // most of a circle (the tear-out).
    for (const [key, title] of [
      ['stabArc', "1a. The thrust's stroke"],
      ['rendArc', "1b. The tear-out's strokes"]
    ]) {
      const arc = folder.addFolder(title);
      const a = c[key];
      R(arc, a, 'count', 0, 8, 1, 'strokes');
      R(arc, a, 'spread', 0, 2, 0.01, 'fan opens by (rad)');
      R(arc, a, 'radius', 0.2, 6, 0.05, 'arc radius (m)');
      R(arc, a, 'sweep', 0.1, 5, 0.05, 'arc spans (rad)');
      R(arc, a, 'width', 0.02, 1.5, 0.01, 'width (of radius)');
      R(arc, a, 'life', 0.05, 2, 0.01, 'lasts (s)');
      R(arc, a, 'pitch', 0, 3, 0.05, 'sheared forward by');
      R(arc, a, 'strength', 0, 3, 0.05, 'master ×');
    }

    /* ---- 2 · the mist ---- */
    const mist = folder.addFolder('2. Blood mist & splatter');
    const m = c.mist;
    mist.add(m, 'enabled').name('shown');
    mist.addColor(m, 'deepColor').name('deep colour');
    mist.addColor(m, 'color').name('body colour');
    mist.addColor(m, 'hotColor').name('hot colour');
    R(mist, m, 'intensity', 0, 3, 0.01, 'master ×');
    R(mist, m, 'drag', 0.05, 10, 0.05, 'drag');
    R(mist, m, 'gravity', -30, 0, 0.1, 'fall (m/s²)');
    R(mist, m, 'puffs', 0, 90, 1, 'cloud puffs');
    R(mist, m, 'puffSpeed', 0, 10, 0.05, 'puffs thrown at (m/s)');
    R(mist, m, 'puffRise', -2, 4, 0.05, 'puffs lift (m/s)');
    R(mist, m, 'puffLife', 0.1, 4, 0.05, 'puffs last (s)');
    R(mist, m, 'size', 0.05, 2, 0.01, 'puff size (m)');
    R(mist, m, 'grow', 0, 8, 0.05, 'puff grows by ×');
    R(mist, m, 'opacity', 0, 1, 0.01, 'cloud opacity');
    R(mist, m, 'setback', 0, 1.5, 0.01, 'cloud sits back (m)');
    R(mist, m, 'erode', 0, 1.5, 0.01, 'cloud raggedness');
    R(mist, m, 'detail', 0.2, 10, 0.1, 'cloud detail');
    R(mist, m, 'churn', 0, 4, 0.05, 'cloud churn');
    R(mist, m, 'drops', 0, 140, 1, 'drops');
    R(mist, m, 'dropSpeed', 0, 30, 0.1, 'drops thrown at (m/s)');
    R(mist, m, 'dropLife', 0.05, 3, 0.05, 'drops last (s)');
    R(mist, m, 'spray', 0, 2, 0.01, 'drop cone (rad)');
    R(mist, m, 'splatSize', 0.005, 0.3, 0.005, 'drop size (m)');
    R(mist, m, 'splatStretch', 0, 8, 0.05, 'drop stretch');
    R(mist, m, 'hot', 0, 2, 0.01, 'heat in the blood');

    /* ---- 3 · the floor ---- */
    const rings = folder.addFolder('3. Impact shockwave');
    const g = c.rings;
    rings.add(g, 'enabled').name('shown');
    rings.addColor(g, 'color').name('front colour');
    rings.addColor(g, 'coreColor').name('flash colour');
    rings.addColor(g, 'crackColor').name('crack colour');
    rings.addColor(g, 'scorchColor').name('burn colour');
    R(rings, g, 'intensity', 0, 6, 0.05, 'brightness');
    R(rings, g, 'radius', 0.5, 10, 0.1, 'reaches (m)');
    R(rings, g, 'life', 0.2, 5, 0.05, 'lasts (s)');
    R(rings, g, 'rings', 1, 6, 1, 'fronts in the train');
    R(rings, g, 'ringGap', 0.02, 0.4, 0.005, 'launched apart by (of life)');
    R(rings, g, 'ringReach', 0.4, 1, 0.01, 'each reaches ×');
    R(rings, g, 'width', 0.005, 0.2, 0.001, 'front width');
    R(rings, g, 'softness', 0.005, 0.2, 0.001, 'front feather');
    R(rings, g, 'cracks', 0, 40, 1, 'cracks');
    R(rings, g, 'crackLength', 0.1, 1, 0.01, 'crack length');
    R(rings, g, 'crackWidth', 0.002, 0.08, 0.001, 'crack width');
    R(rings, g, 'crackGlow', 0, 5, 0.05, 'crack heat');
    R(rings, g, 'scorch', 0, 1, 0.01, 'burn depth');
    R(rings, g, 'scorchRadius', 0.05, 1, 0.01, 'burn reaches');
    R(rings, g, 'scorchFade', 0.05, 1, 0.01, 'burn fades over');
    R(rings, g, 'lift', 0, 0.2, 0.005, 'off the floor (m)');

    /* ---- 4 · the ink ---- */
    const aura = folder.addFolder('4. Dark aura');
    const a = c.aura;
    aura.add(a, 'enabled').name('shown');
    aura.addColor(a, 'inkColor').name('ink colour');
    aura.addColor(a, 'rimColor').name('rim colour');
    R(aura, a, 'opacity', 0, 1, 0.01, 'opacity');
    R(aura, a, 'rim', 0, 2, 0.01, 'rim heat');
    R(aura, a, 'radius', 0.2, 5, 0.05, 'stands out at (m)');
    R(aura, a, 'height', 0.5, 8, 0.05, 'reaches up (m)');
    R(aura, a, 'scale', 0.2, 5, 0.05, 'feature size');
    R(aura, a, 'rise', 0, 3, 0.01, 'climbs at');
    R(aura, a, 'warp', 0, 3, 0.01, 'threads hook by');
    R(aura, a, 'threshold', 0.1, 0.95, 0.01, 'ink cut at');
    R(aura, a, 'sharpness', 0.01, 0.6, 0.005, 'cut sharpness');
    R(aura, a, 'curl', 0, 2, 0.01, 'lean at the top (m)');
    R(aura, a, 'curlSpeed', 0, 4, 0.05, 'lean speed');
    R(aura, a, 'swirl', 0, 2, 0.01, 'shell turns at');

    /* ---- 5 · the cinders ---- */
    const cinders = folder.addFolder('5. Embers & particles');
    const e = c.cinders;
    cinders.add(e, 'enabled').name('shown');
    cinders.addColor(e, 'color').name('colour');
    cinders.addColor(e, 'coreColor').name('hot colour');
    R(cinders, e, 'intensity', 0, 8, 0.05, 'brightness');
    R(cinders, e, 'speed', 0, 30, 0.1, 'thrown at (m/s)');
    R(cinders, e, 'life', 0.1, 4, 0.05, 'last (s)');
    R(cinders, e, 'drag', 0.05, 8, 0.05, 'drag');
    R(cinders, e, 'gravity', -20, 4, 0.1, 'fall (m/s²)');
    R(cinders, e, 'rise', -2, 5, 0.05, 'lift (m/s)');
    R(cinders, e, 'size', 0.005, 0.15, 0.001, 'size (m)');
    R(cinders, e, 'stretch', 0, 8, 0.05, 'stretched by speed');
    R(cinders, e, 'maxStretch', 1, 24, 0.5, 'longest streak ×');
    R(cinders, e, 'halo', 0, 2, 0.01, 'halo');
    R(cinders, e, 'flicker', 0, 1, 0.01, 'flicker depth');
    R(cinders, e, 'flickerSpeed', 1, 60, 0.5, 'flicker speed');
    R(cinders, e, 'stabCount', 0, 120, 1, 'shed per thrust');
    R(cinders, e, 'stabStrength', 0, 3, 0.05, 'thrust ×');
    R(cinders, e, 'spread', 0, 2, 0.01, 'shed cone (rad)');
    R(cinders, e, 'rendCount', 0, 300, 1, 'thrown by the tear-out');
    R(cinders, e, 'rendStrength', 0, 3, 0.05, 'tear-out ×');
    R(cinders, e, 'rendRadius', 0, 3, 0.05, 'tear-out spread (m)');
    R(cinders, e, 'drift', 0, 120, 1, 'drift out of the ink (/s)');
    R(cinders, e, 'driftHeight', 0, 2, 0.01, 'drift starts at (m)');
    R(cinders, e, 'driftSpread', 0, 2, 0.01, 'drift spread (of radius)');
    R(cinders, e, 'driftStrength', 0, 2, 0.01, 'drift ×');

    /* ---- 6 · the blades ---- */
    const blades = folder.addFolder('6. The katanas');
    const b = c.blades;
    blades.add(b, 'enabled').name('shown');
    R(blades, b, 'count', 1, 6, 1, 'blades');
    // Rebuilds the pool when it moves — the scale is baked into the template
    // rather than onto the instances, so this is the one control here that is
    // not free. It is still live; it just does more work than its neighbours.
    R(blades, b, 'length', 0.4, 3, 0.01, 'length (m)');
    blades.add(b, 'flip').name('point is the other end');
    R(blades, b, 'standoff', 0.3, 5, 0.05, 'wait at (m)');
    R(blades, b, 'bite', 0, 1.5, 0.01, 'drive in to (m)');
    R(blades, b, 'spreadHeight', 0, 1.5, 0.01, 'height spread (m)');
    R(blades, b, 'stagger', 0, 0.6, 0.01, 'arrive apart by (s)');
    R(blades, b, 'gatherDrift', 0, 2, 0.01, 'drifts in by (m)');
    R(blades, b, 'hover', 0, 0.4, 0.005, 'hover (m)');
    R(blades, b, 'hoverSpeed', 0, 10, 0.1, 'hover speed');
    R(blades, b, 'spin', 0, 8, 0.05, 'turns at ± (rad/s)');
    R(blades, b, 'quiver', 0, 0.2, 0.001, 'ring in the steel (m)');
    R(blades, b, 'quiverSpeed', 5, 120, 1, 'ring speed');
    R(blades, b, 'quiverDecay', 1, 30, 0.5, 'ring dies at');
    R(blades, b, 'throughDistance', 0.5, 8, 0.05, 'leaves out to (m)');
    R(blades, b, 'throughLift', 0, 4, 0.05, 'leaves rising by (m)');
    R(blades, b, 'throughArc', 0, 3, 0.05, 'exit arc (m)');
    R(blades, b, 'throughRoll', 0, 12, 0.1, 'rolls out by (rad)');
    R(blades, b, 'fadeRise', 0, 4, 0.05, 'drifts up at (m/s)');
    R(blades, b.beats, 'gather', 0.05, 1.5, 0.01, 'resolves over (s)');
    R(blades, b.beats, 'thrust', 0.03, 0.6, 0.005, 'thrust takes (s)');
    R(blades, b.beats, 'wrench', 0.05, 2, 0.01, 'tear-out takes (s)');
    R(blades, b.beats, 'fade', 0.05, 2, 0.01, 'burns off over (s)');

    const steel = blades.addFolder('The steel');
    steel.addColor(b, 'bodyColor').name('body');
    steel.addColor(b, 'sheenColor').name('sheen');
    steel.addColor(b, 'rimColor').name('rim');
    R(steel, b, 'rim', 0, 5, 0.05, 'rim strength');
    R(steel, b, 'rimPower', 0.2, 8, 0.05, 'rim tightness');
    steel.addColor(b, 'edgeColor').name('burn line');
    R(steel, b, 'edgeEmissive', 0, 24, 0.1, 'burn line heat');
    R(steel, b, 'edgeWidth', 0.01, 0.6, 0.005, 'burn line width');
    R(steel, b, 'detail', 2, 120, 0.5, 'burn detail');
    R(steel, b, 'burnRise', 0, 1, 0.01, 'burn runs along by');
    R(steel, b, 'veins', 0, 2, 0.01, 'energy in the steel');
    R(steel, b, 'veinFlow', 0, 6, 0.05, 'energy speed');

    /* ---- the one light all six share ---- */
    const light = folder.addFolder('The light');
    const l = c.light;
    light.addColor(l, 'color').name('colour');
    R(light, l, 'intensity', 0, 60, 0.5, 'brightness');
    R(light, l, 'range', 1, 40, 0.5, 'range (m)');
    R(light, l, 'decay', 0.05, 2, 0.01, 'falls away over (s)');
    R(light, l, 'mark', 0, 1, 0.01, 'mark ×');
    R(light, l, 'stab', 0, 1, 0.01, 'thrust ×');
    R(light, l, 'rend', 0, 1, 0.01, 'tear-out ×');

    /* ---- and how the body leaves ---- */
    const burn = folder.addFolder('The burn');
    const u = c.unmake;
    R(burn, u, 'corpseTime', 0, 6, 0.05, 'lies there (s)');
    R(burn, u, 'dissolveTime', 0.1, 6, 0.05, 'burns away over (s)');
    burn.addColor(u, 'edgeColor').name('burn line');
    R(burn, u, 'edgeEmissive', 0, 24, 0.1, 'burn line heat');
    R(burn, u, 'edgeWidth', 0.01, 0.6, 0.005, 'burn line width');
    R(burn, u, 'dissolveRise', 0, 1, 0.01, 'burns bottom-up by');
  }

  /**
   * The circle under a body in reach — see `vfx/TargetRings.js`.
   *
   * There is nothing here about *who* wears one: that is the two moves' own
   * lock range and cone above, and this only draws the answer. `falloff` is the
   * one to reach for — it is the exponent on the radius, so low is a glow that
   * fills the circle and high is a hard rim with nothing inside it.
   */
  _buildTargetRing(parent) {
    const folder = parent.addFolder('Target ring');
    const R = Editor.range;
    const t = settings.targetRing;

    folder.add(t, 'enabled').name('enabled');
    folder.addColor(t, 'color').name('colour');
    R(folder, t, 'radius', 0.2, 3, 0.01, 'radius (m)');
    R(folder, t, 'falloff', 0.2, 12, 0.1, 'edge falloff');
    R(folder, t, 'softness', 0.01, 0.6, 0.01, 'outer feather');
    R(folder, t, 'intensity', 0, 6, 0.05, 'brightness');
    R(folder, t, 'pulse', 0, 1, 0.01, 'breath depth');
    R(folder, t, 'pulseSpeed', 0, 12, 0.1, 'breath speed');
    R(folder, t, 'lift', 0, 0.2, 0.005, 'off the floor (m)');
    R(folder, t, 'fadeIn', 0.01, 1, 0.01, 'fade in (s)');
    R(folder, t, 'fadeOut', 0.01, 1, 0.01, 'fade out (s)');

    // The caps ride the ring's own fades, so there is nothing here but where
    // they sit and how big they are.
    const keys = folder.addFolder('Hotkeys over the head');
    keys.add(t.hotkeys, 'enabled').name('enabled');
    R(keys, t.hotkeys, 'lift', 0, 2, 0.01, 'above the head (m)');
    R(keys, t.hotkeys, 'scale', 0.5, 2.5, 0.05, 'size ×');
  }

  /**
   * The cut, the meat and the blood — see `combat/Enemy.js`.
   *
   * Everything here is live *except* the plane itself: `height` and `tilt` are
   * read once, at the moment of the blow, because a plane that moved afterwards
   * would slide up a corpse already lying in two pieces. Cut something new to
   * see those two move. Colours, the meat and the blood are all per-frame.
   *
   * The two multiplier groups are the ones worth playing with: `upper` is what
   * the top half takes of the move's own impulse, lift and spin, and `lower` is
   * what is left for a pair of legs. Give the lower half much of anything and
   * the body stops reading as cut and starts reading as two bodies that were
   * standing very close together.
   */
  _buildSlice(parent) {
    const folder = parent.addFolder('Slice & blood');
    const R = Editor.range;
    const s = settings.slice;

    folder.add(s, 'enabled').name('slicing enabled');

    const plane = folder.addFolder('The cut (read at the blow)');
    R(plane, s, 'height', 0.1, 0.9, 0.01, 'cuts at (× height)');
    R(plane, s, 'tilt', 0, 60, 1, 'tilt off level (°)');
    R(plane, s, 'separation', 0, 0.6, 0.01, 'halves part by (m)');
    R(plane, s, 'split', 0, 8, 0.05, 'driven apart at (m/s)');

    const halves = folder.addFolder('What each half takes');
    R(halves, s.upper, 'impulse', 0, 3, 0.05, 'top: force ×');
    R(halves, s.upper, 'lift', 0, 3, 0.05, 'top: lift ×');
    R(halves, s.upper, 'spin', 0, 3, 0.05, 'top: spin ×');
    R(halves, s.lower, 'impulse', 0, 2, 0.01, 'legs: force ×');
    R(halves, s.lower, 'lift', 0, 2, 0.01, 'legs: lift ×');
    R(halves, s.lower, 'spin', 0, 2, 0.01, 'legs: spin ×');

    // Turn this off and the torso falls through the legs, which is the clearest
    // way to see what it is doing.
    const hit = folder.addFolder('Halves against each other');
    const c = s.collide;
    hit.add(c, 'enabled').name('halves collide');
    R(hit, c, 'radius', 0, 0.3, 0.005, 'joint size (m)');
    R(hit, c, 'bounce', 0, 1, 0.01, 'bounce');
    R(hit, c, 'friction', 0, 1, 0.01, 'grip');
    R(hit, c, 'maxPush', 0.005, 0.3, 0.005, 'push cap /frame (m)');

    // The hollow the cut opens is the material's own back faces, painted as
    // meat — there is no cap geometry anywhere in this.
    const meat = folder.addFolder('The wound');
    meat.addColor(s, 'interiorColor').name('inside colour');
    R(meat, s, 'interiorEmissive', 0, 3, 0.01, 'inside glow');
    meat.addColor(s, 'edgeColor').name('cut line colour');
    R(meat, s, 'edgeEmissive', 0, 20, 0.1, 'cut line glow');
    R(meat, s, 'edgeWidth', 0.001, 0.08, 0.001, 'cut line width');

    const blood = folder.addFolder('Blood');
    const b = s.blood;
    blood.add(b, 'enabled').name('blood enabled');
    blood.addColor(b, 'color').name('blood colour');
    R(blood, b, 'brightness', 0, 4, 0.05, 'brightness');
    R(blood, b, 'burst', 0, 600, 5, 'droplets on the cut');
    R(blood, b, 'speed', 0, 15, 0.1, 'thrown at (m/s)');
    R(blood, b, 'spread', 0, 2, 0.01, 'spray spread');
    R(blood, b, 'drip', 0, 300, 1, 'stump drip (/s)');
    R(blood, b, 'dripSpeed', 0, 6, 0.05, 'drip speed (m/s)');
    R(blood, b, 'bleedTime', 0, 8, 0.1, 'bleeds for (s)');
    R(blood, b, 'size', 0.002, 0.15, 0.002, 'droplet size (m)');
    R(blood, b, 'sizeVariance', 0, 1, 0.01, 'size variance');
    R(blood, b, 'life', 0.1, 5, 0.05, 'droplet life (s)');
    R(blood, b, 'lifeVariance', 0, 0.95, 0.01, 'life variance');
    R(blood, b, 'gravity', -60, 0, 0.5, 'gravity (m/s²)');
    R(blood, b, 'drag', 0.02, 4, 0.01, 'air drag /s');
    R(blood, b, 'stretch', 0, 0.4, 0.005, 'motion streak');
    R(blood, b, 'maxStretch', 1, 20, 0.5, 'streak ceiling');
    R(blood, b, 'fade', 0.02, 1, 0.01, 'fades over (× life)');
  }

  /**
   * The character screen's set.
   *
   * Same contract as everything above — `StudioStage` re-resolves the whole rig
   * from these fields every frame, so a slider moved with the screen open
   * re-lights it on the next one. The screen has to be up (`Tab`) to see any of
   * it; the play stage next door reads none of these.
   */
  _buildStudio() {
    const folder = this.gui.addFolder('Character screen');
    const s = settings.studio;
    const R = Editor.range;

    R(folder, s, 'turntable', -0.3, 0.3, 0.005, 'turntable (rev/s)').listen();

    const camera = folder.addFolder('Camera');
    R(camera, s.camera, 'fov', 15, 80, 0.5, 'field of view');
    R(camera, s.camera, 'targetHeight', 0, 2.2, 0.01, 'look at (m)');
    R(camera, s.camera, 'minDistance', 0.2, 3, 0.05, 'min distance');
    R(camera, s.camera, 'maxDistance', 1, 20, 0.1, 'max distance');
    R(camera, s.camera, 'autoOrbit', -0.2, 0.2, 0.005, 'camera drift (rev/s)');

    // Key and fill are each a spot plus a softbox at the same angle; moving the
    // angle moves both, which is what keeps them reading as one source.
    const key = folder.addFolder('Key');
    const l = s.lights;
    R(key, l, 'keyIntensity', 0, 400, 1, 'spot (cd)');
    key.addColor(l, 'keyColor').name('colour');
    R(key, l, 'keyAzimuth', 0, Math.PI * 2, 0.01, 'azimuth');
    R(key, l, 'keyElevation', 0.05, 1.5, 0.01, 'elevation');
    R(key, l, 'keyDistance', 1, 10, 0.05, 'distance (m)');
    R(key, l, 'keyAngle', 0.1, 1.4, 0.01, 'cone');
    R(key, l, 'keyPenumbra', 0, 1, 0.01, 'penumbra');
    R(key, l, 'keySoftbox', 0, 20, 0.1, 'softbox (nits)');
    R(key, l, 'keySoftboxSize', 0.2, 8, 0.1, 'softbox size (m)');

    const fill = folder.addFolder('Fill');
    R(fill, l, 'fillIntensity', 0, 12, 0.05, 'intensity (nits)');
    fill.addColor(l, 'fillColor').name('colour');
    R(fill, l, 'fillAzimuth', 0, Math.PI * 2, 0.01, 'azimuth');
    R(fill, l, 'fillElevation', 0.05, 1.5, 0.01, 'elevation');
    R(fill, l, 'fillDistance', 1, 10, 0.05, 'distance (m)');
    R(fill, l, 'fillSize', 0.2, 8, 0.1, 'panel size (m)');

    const edges = folder.addFolder('Rim, kicker & hair');
    R(edges, l, 'rimIntensity', 0, 600, 1, 'rim (cd)');
    edges.addColor(l, 'rimColor').name('rim colour');
    R(edges, l, 'rimAzimuth', 0, Math.PI * 2, 0.01, 'rim azimuth');
    R(edges, l, 'rimElevation', 0.05, 1.5, 0.01, 'rim elevation');
    R(edges, l, 'rimDistance', 1, 10, 0.05, 'rim distance (m)');
    R(edges, l, 'kickerIntensity', 0, 400, 1, 'kicker (cd)');
    edges.addColor(l, 'kickerColor').name('kicker colour');
    R(edges, l, 'kickerAzimuth', 0, Math.PI * 2, 0.01, 'kicker azimuth');
    R(edges, l, 'kickerElevation', 0.05, 1.5, 0.01, 'kicker elevation');
    R(edges, l, 'kickerDistance', 1, 10, 0.05, 'kicker distance (m)');
    R(edges, l, 'topIntensity', 0, 300, 1, 'hair light (cd)');
    edges.addColor(l, 'topColor').name('hair colour');

    const ambient = folder.addFolder('Ambient & shadow');
    R(ambient, l, 'ambientIntensity', 0, 1, 0.005, 'ambient');
    ambient.addColor(l, 'ambientColor').name('ambient colour');
    R(ambient, l, 'envIntensity', 0, 3, 0.01, 'env (IBL)');
    R(ambient, l, 'shadowRadius', 0, 12, 0.1, 'shadow softness');
    R(ambient, l, 'shadowBias', -0.01, 0.001, 0.0001, 'shadow bias');
    R(ambient, l, 'shadowNormalBias', 0, 0.1, 0.001, 'normal bias');

    const stage = folder.addFolder('Set');
    const st = s.stage;
    stage.addColor(st, 'backdropTop').name('backdrop top');
    stage.addColor(st, 'backdropBottom').name('backdrop bottom');
    stage.addColor(st, 'backdropGlow').name('halo colour');
    R(stage, st, 'glowStrength', 0, 3, 0.01, 'halo strength');
    R(stage, st, 'glowSpread', 0, 1, 0.01, 'halo spread');
    stage.addColor(st, 'floorColor').name('floor colour');
    R(stage, st, 'floorRoughness', 0.02, 1, 0.01, 'floor roughness');
    R(stage, st, 'floorMetalness', 0, 1, 0.01, 'floor metalness');
    R(stage, st, 'floorRadius', 1, 8, 0.05, 'plinth radius (m)');
    stage.addColor(st, 'ringColor').name('ring colour');
    R(stage, st, 'ringIntensity', 0, 6, 0.01, 'ring intensity');
    R(stage, st, 'contactShadow', 0, 2, 0.01, 'contact shadow');
    R(stage, st, 'dust', 0, 3, 0.01, 'studio haze');

    const post = folder.addFolder('Grade');
    const p = s.post;
    post.add(p, 'enabled').name('enabled');
    R(post, p, 'exposure', 0.1, 3, 0.01, 'exposure');
    R(post, p, 'bloomStrength', 0, 3, 0.01, 'bloom intensity');
    R(post, p, 'bloomRadius', 0, 1.5, 0.01, 'bloom radius');
    R(post, p, 'bloomThreshold', 0, 2, 0.01, 'bloom threshold');
    R(post, p, 'contrast', 0.5, 2, 0.01, 'contrast');
    R(post, p, 'saturation', 0, 2.5, 0.01, 'saturation');
    R(post, p, 'temperature', -0.5, 0.5, 0.01, 'temperature');
    R(post, p, 'vignette', 0, 1.5, 0.01, 'vignette');
    R(post, p, 'chromaticAberration', 0, 3, 0.01, 'chromatic aberration');
    R(post, p, 'grain', 0, 0.2, 0.001, 'film grain');
  }

  dispose() {
    this.gui.destroy();
  }
}
