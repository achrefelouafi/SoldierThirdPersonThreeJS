import { AdditiveBlending, CylinderGeometry, DoubleSide, Mesh, ShaderMaterial } from 'three';

import { LAYER } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { copyColor, makeColor } from '../utils/color.js';

/**
 * Segments round the shaft.
 *
 * It is a silhouette, not a surface: the whole look is a term that peaks where
 * the wall turns away from the lens, and a coarse ring puts visible corners on
 * exactly that peak. Forty-eight is the first count with none in it at three
 * metres, which is as near as the player ever stands.
 */
const RADIAL = 48;

/**
 * Segments up it. The shaft is straight and every gradient along it is resolved
 * per fragment, so this is only here for the flare at the foot.
 */
const HEIGHT_SEGMENTS = 8;

/**
 * A shaft of light coming down out of the sky.
 *
 * ## Why a cylinder is a volume
 *
 * There is no volumetric anything here: it is one open-ended tube, additive,
 * depth-tested and never written. What makes it read as a *column of lit air*
 * rather than as a tube is one number — `abs(dot(N, V))`, the cosine between
 * the wall's normal and the eye. On a cylinder that is very nearly the length
 * of the chord the eye's ray takes through the inside, so raising it to a power
 * gives the exact profile a real shaft has: densest along the axis, falling off
 * to nothing at the edges, and *round* from every angle without a single extra
 * vertex.
 *
 * The rim is the same number inverted. Real shafts have both — a bright core
 * and a hot skin where the eye grazes the boundary — and they are two colours
 * here for the same reason the seal's lines and pool are: the shaft is gold and
 * what is coming down inside it is white.
 *
 * The tube is `DoubleSide`, which is not laziness. Front and back walls are both
 * drawn and both add, so the density doubles through the middle of the column
 * for free and the shaft stays solid when the camera walks inside it.
 *
 * ## Coming down
 *
 * `head` is 0 when the shaft is entirely in the sky and 1 when it has reached
 * the floor, and the fragment shader simply refuses to draw below the front —
 * with a bright edge riding on it. So the light *descends*: nothing is scaled,
 * nothing is keyframed, and the beam arrives at the ground on the frame the
 * owner says it does.
 *
 * ## What it owns
 *
 * One mesh and its uniforms. Where the shaft stands, how far down it has come
 * and how hard it is burning are told to it once a frame by `vfx/Ascendance.js`.
 * It never allocates after construction.
 */
export class LightPillar {
  constructor() {
    // Unit tube, base on the origin: the owner scales it in metres, and the
    // shader wants `y` in [0, 1] with 0 at the ground.
    const geometry = new CylinderGeometry(1, 1, 1, RADIAL, HEIGHT_SEGMENTS, true).translate(
      0,
      0.5,
      0
    );

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      // Tested, so the shaft is cut by the body standing in it and by anything
      // between it and the lens. That occlusion is most of what puts it in the
      // world rather than over it.
      depthTest: true,
      side: DoubleSide,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uColor: { value: makeColor('#ffcf72') },
        uCoreColor: { value: makeColor('#fffaf0') },
        uIntensity: { value: 1.5 },
        /** 0..1 — how far down the front of the beam has travelled. */
        uHead: { value: 0 },
        /** 0..1 — master, for the descent's arrival and the fade at the end. */
        uFade: { value: 0 },
        /** 0..1 — decaying, the white left over from the moment it landed. */
        uFlash: { value: 0 },
        uTime: { value: 0 },
        uCorePower: { value: 2.2 },
        uRimPower: { value: 3.4 },
        uRim: { value: 0.8 },
        uTopFade: { value: 0.42 },
        uStreaks: { value: 0.55 },
        uStreakScale: { value: 2.4 },
        uStreakSpeed: { value: 0.9 },
        uPulse: { value: 0.12 },
        uPulseSpeed: { value: 3.1 },
        uFlare: { value: 1.35 },
        uFlareHeight: { value: 0.22 },
        uSeed: { value: 11.7 }
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'LightPillar';
    // It stands wherever the body is and is scaled from nothing on the way in.
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.VFX);
    // Over the ground effects, under the embers — the shaft is the thing the
    // motes are meant to be floating in front of.
    this.mesh.renderOrder = 6;
    this.mesh.visible = false;
    this.mesh.raycast = () => {};
  }

  /**
   * Where it stands. The foot of the shaft, in world space.
   *
   * @param {number} x
   * @param {number} y the ground under the body
   * @param {number} z
   */
  place(x, y, z) {
    this.mesh.position.set(x, y, z);
  }

  /**
   * @param {object} config `settings.ascendance.pillar`
   * @param {object} state
   * @param {number} state.head 0..1, how far down the front has come
   * @param {number} state.width multiplier on the radius, so it can narrow
   * @param {number} state.flash 0..1, decaying, after it struck the ground
   * @param {number} state.fade master
   * @param {number} elapsed the shared clock
   */
  update(config, { head = 0, width = 1, flash = 0, fade = 1 }, elapsed = 0) {
    const u = this.material.uniforms;

    this.mesh.visible = fade > 0.001 && head > 0.001 && width > 0.001;
    if (!this.mesh.visible) return;

    const radius = Math.max(0.02, config.radius) * width;
    this.mesh.scale.set(radius, Math.max(0.1, config.height), radius);

    copyColor(u.uColor.value, config.color);
    copyColor(u.uCoreColor.value, config.coreColor);
    u.uIntensity.value = config.intensity;
    u.uHead.value = head;
    u.uFade.value = fade;
    u.uFlash.value = flash;
    u.uTime.value = elapsed;
    u.uCorePower.value = Math.max(0.05, config.corePower);
    u.uRimPower.value = Math.max(0.05, config.rimPower);
    u.uRim.value = config.rim;
    u.uTopFade.value = config.topFade;
    u.uStreaks.value = config.streaks;
    u.uStreakScale.value = config.streakScale;
    u.uStreakSpeed.value = config.streakSpeed;
    u.uPulse.value = config.pulse;
    u.uPulseSpeed.value = config.pulseSpeed;
    u.uFlare.value = Math.max(0.05, config.flare);
    u.uFlareHeight.value = Math.max(0.01, config.flareHeight);
  }

  /** A fresh set of streaks, for the next cast. */
  reseed() {
    this.material.uniforms.uSeed.value = Math.random() * 128;
  }

  /** Off, immediately. */
  clear() {
    this.mesh.visible = false;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/* -------------------------------------------------------------------- */

/**
 * The tube, flared at its foot.
 *
 * The flare is done here rather than in the geometry so it stays a *taste*
 * control: a shaft that widens where it meets the floor reads as light pooling
 * on a surface, and one that does not reads as a pipe. It only touches the
 * bottom `uFlareHeight` of the column, so the shaft itself stays parallel all
 * the way up into the sky where the eye is checking it against the clouds.
 */
const VERTEX = /* glsl */ `
uniform float uFlare;
uniform float uFlareHeight;

varying vec3 vWorld;
varying vec3 vNormal;
varying float vY;
varying float vAngle;

const float TAU = 6.28318530718;

void main() {
  vY = position.y;
  vAngle = atan(position.z, position.x) / TAU + 0.5;

  vec3 local = position;
  local.xz *= mix(uFlare, 1.0, smoothstep(0.0, uFlareHeight, position.y));

  vec4 world = modelMatrix * vec4(local, 1.0);
  vWorld = world.xyz;
  // The wall's normals are purely radial and the scale is equal in x and z, so
  // the model matrix carries them correctly without an inverse-transpose.
  vNormal = normalize(mat3(modelMatrix) * vec3(normal.x, 0.0, normal.z));

  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * How much light this piece of the wall is worth.
 *
 * Everything is built on `depth` — `abs(dot(N, V))` — which stands in for the
 * length of the eye's chord through the column at this angle. The core is that
 * raised to a power, the rim is its complement raised to another, and the
 * streaks are a noise field that only exists inside the core so the shaft has
 * something moving in it without the silhouette breaking up.
 */
const FRAGMENT = /* glsl */ `
${noiseGLSL}

uniform vec3 uColor;
uniform vec3 uCoreColor;
uniform float uIntensity;
uniform float uHead;
uniform float uFade;
uniform float uFlash;
uniform float uTime;
uniform float uCorePower;
uniform float uRimPower;
uniform float uRim;
uniform float uTopFade;
uniform float uStreaks;
uniform float uStreakScale;
uniform float uStreakSpeed;
uniform float uPulse;
uniform float uPulseSpeed;
uniform float uSeed;

varying vec3 vWorld;
varying vec3 vNormal;
varying float vY;
varying float vAngle;

const float TAU = 6.28318530718;

void main() {
  /* ---- how far down it has come ---- */
  // The front travels from the sky to the floor, so the shaft exists only
  // *above* it. Nothing is scaled: the beam is masked into being.
  float front = 1.0 - uHead;
  float lit = smoothstep(front - 0.06, front + 0.02, vY);
  if (lit <= 0.001) discard;
  // And the leading edge itself, brightest while it is still travelling.
  float edge = (1.0 - smoothstep(0.0, 0.09, abs(vY - front))) * (0.35 + 0.65 * (1.0 - uHead)) * 1.6;

  /* ---- the volume ---- */
  vec3 view = normalize(vWorld - cameraPosition);
  float depth = abs(dot(normalize(vNormal), view));
  float core = pow(depth, uCorePower);
  float rim = pow(1.0 - depth, uRimPower) * uRim;

  /* ---- what is falling inside it ---- */
  // Two bands crossing at different rates: one scrolling straight down, one
  // turning as it goes. A single field reads as a texture sliding on a pipe.
  float streaks = 0.0;
  if (uStreaks > 0.001) {
    float a = vAngle * TAU;
    float n1 = snoise01(vec3(cos(a) * 1.7, vY * uStreakScale - uTime * uStreakSpeed, sin(a) * 1.7 + uSeed));
    float n2 = snoise01(vec3(cos(a) * 3.3 + uSeed, vY * uStreakScale * 2.3 - uTime * uStreakSpeed * 1.7, sin(a) * 3.3));
    streaks = (n1 * 0.65 + n2 * 0.35 - 0.34) * uStreaks * core;
  }

  /* ---- the ends ---- */
  // Dissolved into the sky at the top: a column that stops in mid-air at a
  // clean disc is the one thing that gives the trick away from below.
  float top = 1.0 - smoothstep(1.0 - uTopFade, 1.0, vY);
  // And brightest where it lands, because that is where the light is doing
  // something.
  float foot = 1.0 + 0.4 * (1.0 - smoothstep(0.0, 0.08, vY));

  float breath = 1.0 - uPulse * (0.5 - 0.5 * cos(uTime * uPulseSpeed));
  float gain = uIntensity * uFade * breath * lit * top;

  float body = max(0.0, core + streaks) * foot;
  // The flash rides the core and very little else: put any of it on the rim and
  // the arrival draws a hard bright outline down both sides of the column,
  // which is the one moment the shaft must not look like a cut-out.
  float hot = edge + uFlash * (core * 1.4 + rim * 0.15);

  vec3 rgb = uColor * (body + rim) + uCoreColor * (hot + core * core * 0.28);
  float a = (body + rim + hot + core * core * 0.28) * gain;
  if (a < 0.003) discard;

  // Premultiplied against an additive blend: the alpha is the light.
  gl_FragColor = vec4(rgb * gain, a);
}
`;
