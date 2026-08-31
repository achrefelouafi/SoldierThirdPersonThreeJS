/**
 * Screenshot harness — temporary, deleted after the README media is regenerated.
 *
 * Boots the real app, kills its rAF loop, and steps `App#frame()` on a fixed
 * delta so a scenario can be driven to an exact moment and photographed. Only
 * the frames actually wanted are drawn (`post.render` and the contact-shadow
 * pass are stubbed out while stepping), because the machine rendering this has
 * no GPU.
 */
import { App } from './src/core/App.js';
import { settings } from './src/config/settings.js';

const params = new URLSearchParams(location.search);
const name = params.get('shot') ?? 'hero';
const stops = (params.get('t') ?? '2').split(',').map(Number);
const cols = Number(params.get('cols') ?? 0);
const step = 1 / 60;
const id = params.get('id') ?? name;

/*
 * Pin Chrome's virtual clock. It pauses while a fetch is outstanding and
 * otherwise spends the entire budget the first time the main thread goes idle,
 * which it does for seconds at a time while the textures decode — the page is
 * then photographed still on the loading veil. This request stays open until
 * the frame is drawn.
 */
fetch(`http://127.0.0.1:5211/hold?id=${encodeURIComponent(id)}`).catch(() => {});
const release = () =>
  fetch(`http://127.0.0.1:5211/release?id=${encodeURIComponent(id)}`).catch(() => {});

/*
 * The renderer asks for no `preserveDrawingBuffer`, which is right for the game
 * and fatal here: the frames are drawn outside rAF, so by the time Chrome takes
 * its screenshot the buffer has been thrown away and the canvas is black.
 */
const realGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (type, attributes) {
  const attrs =
    type === 'webgl2' || type === 'webgl'
      ? { ...attributes, preserveDrawingBuffer: true }
      : attributes;
  return realGetContext.call(this, type, attrs);
};

const logEl = document.createElement('pre');
logEl.style.cssText =
  'position:fixed;left:6px;top:6px;z-index:99;margin:0;color:#9f9;font:11px monospace;' +
  'text-shadow:0 0 3px #000;pointer-events:none;white-space:pre-wrap;max-width:40vw';
document.body.appendChild(logEl);
const log = (line) => {
  logEl.textContent += `${line}\n`;
};
window.addEventListener('error', (e) => log(`ERROR ${e.message}`));
console.error = (...a) => log(`console.error ${a.join(' ')}`);

/* ---------------------------------------------------------------- helpers */

/** The rig's own follow, kept for the shots that want the lens carried. */
let follow = null;

/** Stand bodies at (distance, angle-from-facing) around the player. */
function stand(specs) {
  const list = app.enemies.enemies;
  const p = app.character.position;
  const facing = app.character.facing;
  specs.forEach((spec, i) => {
    const enemy = list[i];
    if (!enemy) return;
    const yaw = facing + spec.a;
    const x = p.x + Math.sin(yaw) * spec.d;
    const z = p.z + Math.cos(yaw) * spec.d;
    enemy.place(x, z, Math.atan2(p.x - x, p.z - z));
  });
}

/**
 * Point the lens at a spot on the ground from `yaw`, `pitch` degrees up.
 *
 * `swing` is the offset from the body's own heading, which is what stops a
 * caster and the body it is casting at from standing on the same pixel: aimed
 * straight down the character's facing they eclipse each other.
 *
 * The rig re-aims itself at the character every frame, so the anchor is pinned
 * and `setAnchor` stood down — the shot decides where the lens looks, not the
 * follow.
 */
function lens({
  swing = 0,
  pitch = 11,
  distance = 7,
  height = 1.3,
  focus = null,
  pin = true
} = {}) {
  const p = app.character.position;
  const spot = focus ?? { x: p.x, z: p.z };
  const ground = app.terrain.heightAt(spot.x, spot.z);
  const cam = settings.camera;
  cam.distance = distance;
  cam.targetHeight = height;

  app.rig.anchor.set(spot.x, ground, spot.z);
  app.rig.setAnchor = pin ? () => {} : follow;

  const target = app.rig.controls.target;
  target.set(spot.x, ground + height, spot.z);

  const az = app.character.facing + swing + Math.PI;
  const polar = Math.PI / 2 - (pitch * Math.PI) / 180;
  app.rig.distance = distance;
  app.camera.position.set(
    target.x + distance * Math.sin(polar) * Math.sin(az),
    target.y + distance * Math.cos(polar),
    target.z + distance * Math.sin(polar) * Math.cos(az)
  );
  app.camera.lookAt(target);
  app.rig.controls.update();
}

/** A point `t` of the way from the body to the first enemy standing. */
function between(t = 0.5) {
  const p = app.character.position;
  const e = app.enemies.enemies[0]?.position ?? p;
  return { x: p.x + (e.x - p.x) * t, z: p.z + (e.z - p.z) * t };
}

/** Buffer an attack press exactly as the key handler would. */
const press = (id) => {
  app.input._attacks[id] = true;
};

/* -------------------------------------------------------------- scenarios */
/*
 * `setup` runs once the stage is settled; `events` fire as the clock passes
 * them. `t` on the URL is seconds from the end of setup.
 */
const SHOTS = {
  /* --- the stage itself --------------------------------------------- */
  hero: {
    setup() {
      stand([
        { d: 7.5, a: -0.62 },
        { d: 9.5, a: -0.24 },
        { d: 8.2, a: 0.28 },
        { d: 11.5, a: 0.72 },
        { d: 13, a: -1.05 }
      ]);
      lens({ swing: 0.18, pitch: 8, distance: 6.4, height: 1.2 });
    }
  },

  night: {
    setup() {
      stand([
        { d: 13, a: -0.45 },
        { d: 17, a: 0.32 },
        { d: 22, a: 0.95 },
        { d: 26, a: -1.15 },
        { d: 31, a: 1.7 }
      ]);
      lens({ swing: 0.35, pitch: 4, distance: 13, height: 1.6 });
    }
  },

  blade: {
    setup() {
      stand([{ d: 34, a: 2.6 }]);
      lens({ swing: 2.35, pitch: 4, distance: 2.5, height: 1.2 });
    }
  },

  targeting: {
    setup() {
      stand([
        { d: 2.7, a: -0.3 },
        { d: 4.9, a: 0.4 },
        { d: 9, a: -1.15 },
        { d: 12, a: 1.35 },
        { d: 17, a: 0.12 }
      ]);
      lens({ swing: 0.22, pitch: 9, distance: 6.6, height: 1.25 });
    }
  },

  ragdoll: {
    setup() {
      stand([
        { d: 3.4, a: 0.0 },
        { d: 13, a: -1.25 },
        { d: 16, a: 1.4 }
      ]);
      lens({ swing: 0.75, pitch: 10, distance: 6.5, height: 1.1, focus: between(0.55) });
    },
    events: [{ at: 0.1, do: () => press('slashHit') }]
  },

  /* --- the abilities ------------------------------------------------ */
  combo: {
    setup() {
      stand([
        { d: 8, a: 0.0 },
        { d: 15, a: -1.25 },
        { d: 17, a: 1.4 }
      ]);
      // On the body it is thrown at: the finisher closes there, so that is
      // where the move ends up whatever it did on the way.
      lens({ swing: 0.72, pitch: 10, distance: 6.4, height: 1.3, focus: between(1) });
    },
    events: [{ at: 0.1, do: () => press('swordCombo') }]
  },

  'combo-wave': {
    setup() {
      stand([
        { d: 8, a: 0.0 },
        { d: 15, a: -1.25 },
        { d: 17, a: 1.4 }
      ]);
      lens({ swing: 0.78, pitch: 11, distance: 8.5, height: 1.3, focus: between(0.5) });
    },
    events: [{ at: 0.1, do: () => press('swordCombo') }]
  },

  unmaking: {
    setup() {
      stand([
        { d: 5.8, a: 0.0 },
        { d: 15, a: -1.3 },
        { d: 17, a: 1.4 }
      ]);
      lens({ swing: 0.62, pitch: 11, distance: 8.5, height: 1.45, focus: between(0.55) });
    },
    events: [{ at: 0.1, do: () => press('voidBeam') }]
  },

  rite: {
    setup() {
      stand([
        { d: 5.5, a: 0.0 },
        { d: 15, a: -1.3 },
        { d: 17, a: 1.4 }
      ]);
      lens({ swing: 0.62, pitch: 11, distance: 8.2, height: 1.35, focus: between(0.55) });
    },
    events: [{ at: 0.1, do: () => press('crimsonRite') }]
  },

  execution: {
    setup() {
      stand([
        { d: 5.5, a: 0.0 },
        { d: 15, a: -1.3 },
        { d: 17, a: 1.4 }
      ]);
      lens({ swing: 0.62, pitch: 11, distance: 8.2, height: 1.35, focus: between(0.55) });
    },
    events: [{ at: 0.1, do: () => press('shadowExecution') }]
  },

  ascendance: {
    setup() {
      stand([
        { d: 8, a: -0.75 },
        { d: 11, a: 0.85 },
        { d: 18, a: 1.6 }
      ]);
      lens({ swing: 0.5, pitch: 7, distance: 7.2, height: 1.5 });
    },
    events: [{ at: 0.1, do: () => app._castAscendance() }]
  },

  shadowboost: {
    setup() {
      stand([
        { d: 8, a: -0.75 },
        { d: 11, a: 0.85 },
        { d: 18, a: 1.6 }
      ]);
      lens({ swing: 0.5, pitch: 7, distance: 7.2, height: 1.5 });
    },
    events: [{ at: 0.1, do: () => app._castShadowBoost() }]
  },

  rifle: {
    setup() {
      stand([
        { d: 7, a: -0.04 },
        { d: 11, a: 0.5 },
        { d: 15, a: -0.8 }
      ]);
      lens({ swing: 0, pitch: 6, distance: 6, height: 1.3, pin: false });
      // The shooter reads the pointer's own state, and there is no pointer here.
      app.pointerLook.locked = true;
      app.rig.setPointerLocked(true);
      app._switchWeapon();
    },
    events: [
      {
        at: 1.4,
        do: () => {
          app.gunplay._sights = true;
        }
      },
      {
        at: 2.1,
        do: () => {
          app.gunplay._trigger = true;
          app.gunplay._pressed = true;
        }
      }
    ]
  },

  /* --- terrain ------------------------------------------------------ */
  'terrain-flat': {
    setup() {
      settings.terrain.amplitude = 0;
      stand([{ d: 34, a: 2.5 }]);
      lens({ swing: 0.3, pitch: 6, distance: 9, height: 1.4 });
    }
  },
  'terrain-rolling': {
    setup() {
      stand([{ d: 34, a: 2.5 }]);
      lens({ swing: 0.3, pitch: 6, distance: 9, height: 1.4 });
    }
  },
  'terrain-peaks': {
    setup() {
      settings.terrain.amplitude = 15;
      settings.terrain.ridge = 0.85;
      stand([{ d: 34, a: 2.5 }]);
      lens({ swing: 0.3, pitch: 6, distance: 9, height: 1.4 });
    }
  },

  /* --- the other two screens ---------------------------------------- */
  studio: {
    setup() {
      app.toggleCharacterScreen();
    }
  },
  'studio-skeleton': {
    setup() {
      app.toggleCharacterScreen();
      app.characterScreen._ensureSkeleton();
      if (app.characterScreen.skeleton) app.characterScreen.skeleton.visible = true;
      app.characterScreen.markerVisible = true;
      app.characterScreen.frame('bust');
    }
  },
  editor: {
    setup() {
      stand([
        { d: 7, a: -0.5 },
        { d: 10, a: 0.4 },
        { d: 14, a: 1.2 }
      ]);
      lens({ swing: 0.25, pitch: 8, distance: 6.6, height: 1.25 });
    }
  }
};

/* ------------------------------------------------------------------ boot */

const canvas = document.getElementById('viewport');
const app = new App(canvas);
window.app = app;
window.settings = settings;

/*
 * Compile on this thread rather than off it. `compileAsync` polls for the
 * driver to finish, and Chrome's virtual clock runs on while it waits — a
 * whole budget can be spent inside the warm-up and the page is photographed
 * still on the loading veil. Synchronous work freezes virtual time instead.
 */
app.renderer.gl.compileAsync = (scene, camera) => {
  app.renderer.gl.compile(scene, camera);
  return Promise.resolve([]);
};

try {
  await app.load();
} catch (error) {
  log(`load failed: ${error?.message}\n${error?.stack ?? ''}`);
  release();
  throw error;
}
app.stop();
document.body.classList.add('shot');
follow = app.rig.setAnchor.bind(app.rig);

// Only draw the frames we actually want. Everything else is simulation.
const realPost = app.post.render.bind(app.post);
const realContact = app.contactShadows.render.bind(app.contactShadows);
let drawing = false;
app.post.render = () => {
  if (drawing) realPost();
};
app.contactShadows.render = (scene) => {
  if (drawing) realContact(scene);
};

// A fixed clock, so a shot is the same picture every time it is taken.
app.time.tick = () => step;

const shot = SHOTS[name] ?? SHOTS.hero;

// Let the stage settle before the scenario places anything: the loadout, the
// idle blend and the mist all need a few frames to stop being their first one.
for (let i = 0; i < 30; i++) app.frame();
shot.setup?.();
for (let i = 0; i < 4; i++) app.frame();
shot.setup?.();

const events = (shot.events ?? []).map((e) => ({ ...e, done: false }));
let clock = 0;

function advance(to) {
  while (clock < to - 1e-6) {
    for (const event of events) {
      if (!event.done && clock >= event.at) {
        event.done = true;
        try {
          event.do();
        } catch (error) {
          log(`event failed: ${error?.message}`);
        }
      }
    }
    app.frame();
    clock += step;
  }
}

function draw() {
  drawing = true;
  app.frame();
  clock += step;
  drawing = false;
}

/** Where everything actually is, for when a frame looks wrong. */
function report() {
  const v = (o) => `${o.x.toFixed(2)},${o.y.toFixed(2)},${o.z.toFixed(2)}`;
  log(`player ${v(app.character.position)} facing ${app.character.facing.toFixed(2)}`);
  log(`camera ${v(app.camera.position)} target ${v(app.rig.controls.target)}`);
  log(`distance ${app.rig.distance.toFixed(2)} fov ${app.camera.fov.toFixed(1)}`);
  app.enemies.enemies.forEach((e, i) => log(`enemy${i} ${v(e.position)} alive=${e.alive}`));
  for (const move of app.character.attacks ?? []) {
    if (move.locked) log(`locked ${move.configKey} t=${move.time?.toFixed?.(2)}`);
  }
}

/**
 * Hand the picture to the compositor, then let Chrome take it.
 *
 * The order matters both ways. A canvas drawn outside `requestAnimationFrame`
 * is never committed and photographs black — but rAF is driven by the virtual
 * clock, which the held request has stopped dead, so the hold has to go first
 * or the callback never comes. Released, the clock advances to the next frame
 * long before it reaches the end of its budget.
 */
async function shoot(redraw = () => {}) {
  release();
  await new Promise((resolve) => {
    let left = 2;
    const tick = () => {
      redraw();
      if (--left <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // A floor, in case no frame is ever produced.
    setTimeout(resolve, 4000);
  });
}

if (params.has('probe')) {
  advance(stops[0]);
  report();
  await shoot();
} else if (cols > 0) {
  /* Contact sheet: many moments in one page load, for choosing a frame. */
  const tileW = Math.round(canvas.clientWidth / 3);
  const tileH = Math.round(canvas.clientHeight / 3);
  const rows = Math.ceil(stops.length / cols);
  const sheet = document.createElement('canvas');
  sheet.width = tileW * cols;
  sheet.height = tileH * rows;
  sheet.style.cssText = 'position:fixed;inset:0;z-index:50;width:100vw;height:auto';
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, sheet.width, sheet.height);

  stops.forEach((time, i) => {
    advance(time);
    draw();
    const x = (i % cols) * tileW;
    const y = Math.floor(i / cols) * tileH;
    ctx.drawImage(canvas, x, y, tileW, tileH);
    ctx.fillStyle = '#7fd4ff';
    ctx.font = '13px monospace';
    ctx.fillText(`${name} t=${time.toFixed(2)}`, x + 8, y + 18);
  });

  document.body.appendChild(sheet);
  log(`sheet ${name} ${stops.length} tiles`);
  await shoot();
} else {
  advance(stops[0]);
  draw();
  await shoot(draw);

  const gl = app.renderer.gl.getContext();
  const pixels = new Uint8Array(4 * 64);
  gl.readPixels(
    Math.round(gl.drawingBufferWidth * 0.5) - 4,
    Math.round(gl.drawingBufferHeight * 0.5) - 4,
    8,
    8,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixels
  );
  let sum = 0;
  for (const value of pixels) sum += value;
  log(
    `${name} t=${stops[0]} draws=${app.renderer.gl.info.render.calls} ` +
      `buffer=${gl.drawingBufferWidth}x${gl.drawingBufferHeight} centre=${(sum / pixels.length).toFixed(1)}`
  );
  if (!params.has('debug')) logEl.remove();
}

// The frame is up. Let the clock off its leash, and Chrome takes the picture.

