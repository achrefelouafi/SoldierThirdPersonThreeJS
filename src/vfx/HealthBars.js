import {
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial
} from 'three';

import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';

/** Bars that can be up at once. `enemies.count` tops out at 20; a corpse's bar fades. */
const CAPACITY = 32;

const _matrix = /* @__PURE__ */ new Matrix4();

/**
 * The small bar over a body's head while the rifle is out.
 *
 * ## Why it only exists for the gun
 *
 * Every melee blow in the project is a *kill* — a kick folds a body over a boot
 * and a slash takes it in half, and neither spends a number. The rifle is the
 * one weapon on the stage that has to be fired more than once
 * (`Enemy#health`), so it is the one weapon that leaves a question on screen:
 * *is this one nearly down, or did I just start on it?* The bar is the answer,
 * and it is up for exactly as long as that question exists — the gun comes out
 * and the bars come up, the gun goes away and they fade.
 *
 * ## What it says, and what it deliberately does not
 *
 * A short red bar on a dark ground, and nothing else. No number, no percentage,
 * no name: the length *is* the reading, and anything printed beside it would be
 * asking the player to do arithmetic in the middle of a firefight instead of
 * glancing. The fill drains from the right, so the red that is left is the
 * health that is left.
 *
 * ## How it is drawn
 *
 * The same machine as `vfx/TargetMarkers.js`: one `InstancedMesh` of quads
 * built in *view* space, so every bar faces the lens without a matrix being
 * composed on the CPU, and one instance per body with two attributes — how lit
 * the bar is and how full it is. Depth-tested off and drawn over the markers:
 * a bar behind a fold of ground is still the answer to "how much is left in
 * that one", and losing it there is worse than the small cheat of drawing
 * through.
 *
 * Unlike the markers it is not purely world-sized. A world-sized bar is honest
 * up close and unreadable at forty metres, so the width has a floor in *pixels*
 * (`minWidth`) and the shader takes whichever is larger — near bodies get a bar
 * that sits in the world, far ones get one that can still be read.
 *
 * Nothing here decides combat. It is handed the population and whether the gun
 * is up, and a body that dies simply stops being handed over and runs its bar
 * down from wherever it had got to.
 */
export class HealthBars {
  constructor() {
    /** Per body: how lit its bar is. Keyed by the body, so there is no slot to leak. */
    this._bars = new Map();

    const geometry = new PlaneGeometry(1, 1);
    geometry.setAttribute('aFade', new InstancedBufferAttribute(new Float32Array(CAPACITY), 1));
    geometry.setAttribute('aHealth', new InstancedBufferAttribute(new Float32Array(CAPACITY), 1));

    const look = settings.gunplay.healthBar;

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      // See the note above: a bar is an answer, not a piece of the world.
      depthTest: false,
      // Not additive, unlike every other overlay here. The ground behind the
      // fill has to read as *dark* — an additive bar has no empty half at all,
      // it just gets dimmer, which is the one thing this must never do.
      blending: NormalBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uColor: { value: new Color(look.color) },
        uTrack: { value: new Color(look.trackColor) },
        uFrame: { value: new Color(look.frameColor) },
        uTrackOpacity: { value: look.trackOpacity },
        uFrameOpacity: { value: look.frameOpacity },
        uWidth: { value: look.width },
        uHeight: { value: look.height },
        uBorder: { value: look.border },
        /** Pixels of width the bar may never fall below, and what that is measured in. */
        uMinWidth: { value: look.minWidth },
        uViewport: { value: 1080 }
      },
      vertexShader: /* glsl */ `
        uniform float uWidth;
        uniform float uHeight;
        uniform float uMinWidth;
        uniform float uViewport;
        attribute float aFade;
        attribute float aHealth;
        varying vec2 vUv;
        varying float vFade;
        varying float vHealth;
        varying float vAspect;

        void main() {
          vUv = uv;
          vFade = aFade;
          vHealth = aHealth;

          // Screen-aligned by construction: the instance contributes its
          // *position* only and the quad's corners are added in view space, so
          // the bar faces the lens from every angle and stays level with the
          // horizon however the camera is rolled around it.
          vec4 view = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);

          // Metres, at this depth, that one pixel of the viewport's height
          // covers. The projection's own [1][1] is the whole conversion — no
          // field of view has to be passed in, and a lens that zooms down the
          // sights is accounted for on the frame it zooms.
          float perPixel = 2.0 * max(-view.z, 1e-3) / (projectionMatrix[1][1] * uViewport);
          // Whichever is larger: the authored size, or the readable one.
          float scale = max(1.0, (uMinWidth * perPixel) / max(uWidth, 1e-4));
          vec2 size = vec2(uWidth, uHeight) * scale;
          vAspect = size.x / max(size.y, 1e-4);

          view.xy += position.xy * size;
          gl_Position = projectionMatrix * view;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform vec3 uTrack;
        uniform vec3 uFrame;
        uniform float uTrackOpacity;
        uniform float uFrameOpacity;
        uniform float uBorder;
        varying vec2 vUv;
        varying float vFade;
        varying float vHealth;
        varying float vAspect;

        void main() {
          // Distance to the nearest edge, measured in units of the bar's
          // *height* on both axes — which is what makes one border number
          // mean the same thickness along a shape that is ten times wider than
          // it is tall.
          vec2 d = min(vUv, 1.0 - vUv) * vec2(vAspect, 1.0);
          float edge = min(d.x, d.y);

          // Antialiasing taken off the derivative rather than from a constant:
          // the bar is a handful of pixels tall at range and a hundred up
          // close, and a fixed softness is a blur at one end or a stair at the
          // other.
          float soft = max(fwidth(edge), 1e-4);
          float inner = smoothstep(uBorder - soft, uBorder + soft, edge);

          float fillSoft = max(fwidth(vUv.x), 1e-4);
          float fill = (1.0 - smoothstep(vHealth - fillSoft, vHealth + fillSoft, vUv.x)) * inner;

          vec3 color = mix(mix(uFrame, uTrack, inner), uColor, fill);
          float a = mix(uFrameOpacity, mix(uTrackOpacity, 1.0, fill), inner) * vFade;
          if (a < 0.004) discard;

          gl_FragColor = vec4(color, a);
        }
      `
    });

    this.mesh = new InstancedMesh(geometry, this.material, CAPACITY);
    this.mesh.count = 0;
    // They follow bodies around the world; a bounding sphere built at the origin
    // would blink them out at the edges.
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.VFX);
    // Over the diamonds, which are the only other thing drawn above a head.
    this.mesh.renderOrder = 4;
    this.mesh.name = 'HealthBars';

    this._fades = geometry.getAttribute('aFade');
    this._health = geometry.getAttribute('aHealth');
  }

  /**
   * Draw a bar over everyone still standing, while the gun is out.
   *
   * @param {number} dt seconds, on the simulation's clock
   * @param {Iterable<{position: import('three').Vector3, alive: boolean, health: number, maxHealth: number}>} enemies
   * @param {boolean} live whether the rifle is the weapon in the hand
   * @param {import('three').Camera} camera what the range is measured from
   */
  update(dt, enemies, live, camera) {
    const config = settings.gunplay.healthBar;
    const on = live && config.enabled;

    const rise = dt / Math.max(1e-3, config.fadeIn);
    const fall = dt / Math.max(1e-3, config.fadeOut);
    const range = config.range * config.range;
    const lens = camera?.position;

    if (on) {
      for (const enemy of enemies) {
        if (!enemy?.alive) continue;
        const max = Math.max(1e-3, enemy.maxHealth);
        const health = Math.max(0, Math.min(1, enemy.health / max));
        // A body nobody has touched yet says nothing, if that is how the
        // sandbox is set: the bar is then a *wound*, and its appearing is the
        // confirmation the first round landed.
        if (config.onlyWounded && health >= 1) continue;
        if (lens && enemy.position.distanceToSquared(lens) > range) continue;
        this._touch(enemy, rise, health);
      }
    }

    for (const [enemy, bar] of this._bars) {
      if (bar.seen) {
        bar.seen = false;
        continue;
      }
      bar.fade -= fall;
      if (bar.fade <= 0) this._bars.delete(enemy);
    }

    const height = settings.enemies.height + config.lift;
    const fades = this._fades.array;
    const health = this._health.array;
    let count = 0;

    for (const [enemy, bar] of this._bars) {
      if (count >= CAPACITY) break;
      const position = enemy.position;
      // Translation only: the size is a uniform, because the quad is grown in
      // view space rather than by the instance's own matrix (see the shader).
      _matrix.identity().setPosition(position.x, position.y + height, position.z);
      this.mesh.setMatrixAt(count, _matrix);
      fades[count] = bar.fade;
      health[count] = bar.health;
      count++;
    }

    this.mesh.count = count;
    if (!count) return;

    this.mesh.instanceMatrix.needsUpdate = true;
    this._fades.needsUpdate = true;
    this._health.needsUpdate = true;

    const uniforms = this.material.uniforms;
    uniforms.uColor.value.set(config.color);
    uniforms.uTrack.value.set(config.trackColor);
    uniforms.uFrame.value.set(config.frameColor);
    uniforms.uTrackOpacity.value = config.trackOpacity;
    uniforms.uFrameOpacity.value = config.frameOpacity;
    uniforms.uWidth.value = Math.max(0.01, config.width);
    uniforms.uHeight.value = Math.max(0.004, config.height);
    uniforms.uBorder.value = Math.max(0, config.border);
    uniforms.uMinWidth.value = Math.max(0, config.minWidth);
    // Read here rather than off a resize listener: it is one number a frame,
    // and it is the same one `Crosshair`'s spread is converted through.
    uniforms.uViewport.value = Math.max(1, window.innerHeight);
  }

  /** One body's bar, brought up and given the health it has left this frame. */
  _touch(enemy, rise, health) {
    let bar = this._bars.get(enemy);
    if (!bar) {
      bar = { fade: 0, health, seen: false };
      this._bars.set(enemy, bar);
    }
    bar.fade = Math.min(1, bar.fade + rise);
    bar.health = health;
    bar.seen = true;
  }

  /** Take every bar off now, without a fade — the studio, a respawn. */
  clear() {
    this._bars.clear();
    this.mesh.count = 0;
  }

  dispose() {
    this.clear();
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
