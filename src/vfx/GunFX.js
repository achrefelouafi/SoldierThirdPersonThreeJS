import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Group,
  Mesh,
  PlaneGeometry,
  PointLight,
  Points,
  PointsMaterial,
  ShaderMaterial,
  Vector3
} from 'three';

import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import { getColor } from '../utils/color.js';

const _up = /* @__PURE__ */ new Vector3();
const _spread = /* @__PURE__ */ new Vector3();

/**
 * The two things a shot leaves behind that are not the round itself.
 *
 * Both live here rather than in files of their own because neither is a system
 * — they are one quad and one point cloud, they are only ever driven by
 * `combat/Gunplay.js`, and the thing that makes a shot land is the *pair* of
 * them going off on the same frame. Splitting them would be two files that can
 * only be read together.
 */

/**
 * The flash at the barrel.
 *
 * Two halves, and it needs both: a quad that is the flash itself, and a light
 * that is what the flash does to everything around it. The quad alone reads as
 * a sticker on the gun; the light alone reads as a bug in the lighting. Fired
 * together for fifty milliseconds they read as a gun going off in the dark —
 * which, on a night stage with a moon for a key light, is most of what sells
 * the whole mode.
 *
 * The light is a real `PointLight` and is deliberately the only dynamic one on
 * the stage. It costs nothing while it is off (intensity 0 is a light the
 * renderer still uploads, but nothing more) and it is never allowed to cast a
 * shadow — a shadow map rebuilt for fifty milliseconds, ten times a second, is
 * the one thing here that would actually cost frames.
 */
export class MuzzleFlash {
  constructor() {
    this.group = new Group();
    this.group.name = 'MuzzleFlash';

    this.material = new ShaderMaterial({
      uniforms: {
        uColor: { value: getColor(settings.gunplay.muzzle.color).clone() },
        uStrength: { value: 0 }
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uStrength;
        varying vec2 vUv;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float core = pow(max(0.0, 1.0 - length(p)), 2.6);
          // The four spikes. A flash without them is a ball of light, and a
          // ball of light is what an explosion looks like, not a muzzle.
          float star =
            pow(max(0.0, 1.0 - abs(p.y) * 3.2), 8.0) * max(0.0, 1.0 - abs(p.x)) +
            pow(max(0.0, 1.0 - abs(p.x) * 3.2), 8.0) * max(0.0, 1.0 - abs(p.y));
          gl_FragColor = vec4(uColor * (core * 2.4 + star * 1.6) * uStrength, 1.0);
        }
      `,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
      fog: false
    });

    this.mesh = new Mesh(new PlaneGeometry(1, 1), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.visible = false;

    /**
     * The light the flash throws, and the one rule about it: it is never made
     * invisible, only dark.
     *
     * A light appearing in a scene changes the lighting *hash* every material
     * on the stage was compiled against, so the first shot of the session would
     * otherwise recompile every shader in the world — on the one frame that
     * cannot afford it. Held visible at zero intensity it is part of the scene
     * the boot path warms up (`App#load`), and switching it on afterwards costs
     * one uniform.
     */
    this.light = new PointLight(0xffffff, 0, 8, 2);
    this.light.castShadow = false;

    this.group.add(this.mesh, this.light);

    /** Seconds left of this flash. */
    this._life = 0;
    /** A different roll of the dice per shot, so two flashes never match. */
    this._roll = 0;
  }

  /**
   * Light one, at the muzzle.
   *
   * @param {Vector3} position world
   * @param {Vector3} direction the way the barrel points — the quad is turned
   *   face-on to the camera by `update`, so this only rolls it
   */
  flash(position, direction) {
    const config = settings.gunplay.muzzle;
    this.mesh.position.copy(position);
    // The light sits a little *ahead* of the flash, out of the gun: put it on
    // the muzzle and the barrel it is attached to eats most of it.
    this.light.position.copy(position).addScaledVector(direction, 0.12);
    this._life = Math.max(0.01, config.life);
    this._roll = Math.random() * Math.PI;
  }

  /**
   * @param {number} dt real seconds — a flash is fifty milliseconds long and
   *   holding it through a hit-stop would leave it hanging on the gun
   * @param {import('three').Camera} camera what to face
   */
  update(dt, camera) {
    const config = settings.gunplay.muzzle;

    if (this._life <= 0) {
      if (this.mesh.visible) {
        this.mesh.visible = false;
        this.light.intensity = 0;
      }
      return;
    }

    this._life = Math.max(0, this._life - dt);
    const t = this._life / Math.max(0.01, config.life);
    // Squared, so the flash is at full brightness for barely a frame and then
    // falls off a cliff. A linear fade reads as a lamp being switched off.
    const strength = t * t;

    this.mesh.visible = true;
    this.mesh.quaternion.copy(camera.quaternion);
    this.mesh.rotateZ(this._roll);
    this.mesh.scale.setScalar(config.size * (0.7 + strength * 0.5));
    this.material.uniforms.uStrength.value = strength;
    this.material.uniforms.uColor.value.copy(getColor(config.color));

    this.light.color.copy(getColor(config.color));
    this.light.intensity = config.light * strength;
    this.light.distance = config.lightRange;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.light.dispose?.();
    this.group.parent?.remove(this.group);
  }
}

/* -------------------------------------------------------------------- */

/**
 * What comes off the ground where a round lands.
 *
 * A few dozen points thrown out of the impact along the surface, falling under
 * their own gravity and fading as they go. Integrated on the CPU, because at
 * this population the whole system is a few hundred adds a frame and doing it
 * on the GPU would mean a shader, a clock and a buffer upload to save nothing.
 *
 * The one thing worth knowing about the update: live sparks are **compacted**
 * into the front of the attribute buffers and the draw range is set to how many
 * there were. The obvious alternative — leave the dead ones where they died and
 * write them black, since an additive blend draws black as nothing — is what
 * this did first, and it is a trap. A black point is still a point: it is
 * transformed, rasterised and blended, and six hundred of them at close range
 * are six hundred overlapping quads of pure overdraw for no pixels. Copying six
 * floats per live spark is far cheaper than drawing a dead one.
 */
export class ImpactSparks {
  constructor(capacity = 640) {
    this.capacity = capacity;

    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);

    this._head = 0;
    /** How many were drawn last frame — so an empty pool uploads nothing. */
    this._drawn = 0;

    const positions = new BufferAttribute(new Float32Array(capacity * 3), 3);
    const colors = new BufferAttribute(new Float32Array(capacity * 3), 3);
    positions.setUsage(DynamicDrawUsage);
    colors.setUsage(DynamicDrawUsage);

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', positions);
    geometry.setAttribute('color', colors);
    // The sparks are thrown all over the field and the bounding sphere would
    // have to be rebuilt every frame to say so.
    geometry.boundingSphere = null;

    this.material = new PointsMaterial({
      size: settings.gunplay.impact.size,
      sizeAttenuation: true,
      vertexColors: true,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
      fog: false
    });

    this.points = new Points(geometry, this.material);
    this.points.name = 'ImpactSparks';
    this.points.frustumCulled = false;
    this.points.layers.set(LAYER.VFX);
    geometry.setDrawRange(0, 0);

    this.positions = positions;
    this.colors = colors;
  }

  /**
   * Throw a burst out of a point.
   *
   * The direction handed in is the round's, so the sparks are reflected off it
   * rather than thrown along it — which is the difference between debris coming
   * *off* a surface and debris being pushed into one.
   *
   * @param {Vector3} point world
   * @param {Vector3} direction the way the round was travelling
   */
  burst(point, direction) {
    const config = settings.gunplay.impact;
    const count = Math.max(0, Math.round(config.sparks));

    // Reflected off a floor that is treated as flat here: the height field has
    // a normal, but a spark thrown off a one-in-eight slope goes somewhere no
    // one can tell from straight up.
    _up.set(direction.x * 0.5, Math.abs(direction.y) * 0.6 + 0.55, direction.z * 0.5).normalize();

    for (let i = 0; i < count; i++) {
      const slot = this._head;
      this._head = (this._head + 1) % this.capacity;

      _spread.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
      const speed = config.speed * (0.25 + Math.random() * 1.1);

      this.px[slot] = point.x;
      this.py[slot] = point.y;
      this.pz[slot] = point.z;
      this.vx[slot] = _up.x * speed + _spread.x * config.speed * 0.7;
      this.vy[slot] = _up.y * speed + _spread.y * config.speed * 0.35;
      this.vz[slot] = _up.z * speed + _spread.z * config.speed * 0.7;
      this.age[slot] = 0;
      this.life[slot] = config.life * (0.5 + Math.random() * 0.7);
    }
  }

  /** @param {number} dt the simulation's clock — sparks slow with the world */
  update(dt) {
    const config = settings.gunplay.impact;
    const color = getColor(config.color);
    const position = this.positions.array;
    const tint = this.colors.array;

    this.material.size = config.size;

    let drawn = 0;

    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;

      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.life[i] = 0;
        continue;
      }

      this.vy[i] += config.gravity * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;

      const o = drawn * 3;
      position[o] = this.px[i];
      position[o + 1] = this.py[i];
      position[o + 2] = this.pz[i];

      // Cubed, so a spark is a bright dot for most of its life and then gone,
      // rather than a grey speck drifting for half a second.
      const remaining = 1 - this.age[i] / this.life[i];
      const fade = remaining * remaining * remaining * config.brightness;
      tint[o] = color.r * fade;
      tint[o + 1] = color.g * fade;
      tint[o + 2] = color.b * fade;
      drawn++;
    }

    this.points.geometry.setDrawRange(0, drawn);
    if (drawn === 0 && this._drawn === 0) return; // nothing to upload either
    this._drawn = drawn;

    this.positions.addUpdateRange(0, drawn * 3);
    this.colors.addUpdateRange(0, drawn * 3);
    this.positions.needsUpdate = true;
    this.colors.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this._drawn = 0;
    this.points.geometry.setDrawRange(0, 0);
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
    this.points.parent?.remove(this.points);
  }
}
