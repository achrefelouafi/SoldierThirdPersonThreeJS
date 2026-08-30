import {
  AdditiveBlending,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  NormalBlending,
  ShaderMaterial
} from 'three';

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

/** Segments up it — only the flare at the foot needs any. */
const HEIGHT_SEGMENTS = 8;

/**
 * A column of dark energy, standing out of the ground.
 *
 * ## Two tubes, and which way round they go
 *
 * The obvious build of a "dark energy cylinder" is a shaft of light with the
 * brightness inverted — dark down the axis, bright at the silhouette. It is
 * wrong, and the reference says so plainly: the cylinder there is **brightest
 * through its middle**, with a white-violet core and lightning inside it, and
 * it goes *dark at its edges* where the wall turns away. The darkness of the
 * whole aura is carried by the smoke layers, not by the shaft. A shaft that is
 * dark in the middle reads as a hole cut in the frame, and it swallows the
 * character standing inside it.
 *
 * So it is two meshes on one geometry, drawn one after the other, and they take
 * *opposite* halves of the same profile:
 *
 *  - **the glow** — additive, violet, weighted to the **core**: brightest along
 *    the axis where the eye's ray takes the longest chord through the column,
 *    exactly as a real shaft of lit air is (`vfx/LightPillar.js` builds its
 *    whole look on this). It carries the striations, the lightning and the
 *    flash.
 *  - **the shade** — `NormalBlending`, near-black, weighted to the **rim**:
 *    `pow(1 - chord, shadePower)`, so it darkens only the *edges*, where the
 *    wall is grazing and the light is falling off anyway.
 *
 * Bright middle, dark edges, and the two halves are the same term read from
 * opposite ends — so they cannot disagree about where the column is. It also
 * means the near wall is at its most transparent exactly where the player's
 * body is, which is the difference between standing in a column and being
 * deleted by one.
 *
 * ## Coming up, not down
 *
 * The light comes down out of the sky; this comes *up out of the floor*, and
 * that is deliberate — it is the same gesture read backwards, and it is most of
 * why the two abilities do not look like recolours of each other. `head` is 0
 * when nothing has risen and 1 when the column is at full height, and the
 * fragment shader simply refuses to draw above the front, with a hot edge
 * riding on it while it climbs.
 *
 * ## The lightning
 *
 * The reference's bolts are *discrete strikes* — a jagged branching filament
 * that holds for an instant, dies, and is replaced by a different one somewhere
 * else. A noise field scrolled through the column gives none of that; it gives
 * a plasma lamp. So the field is sampled at a **quantised clock**: `floor(t *
 * veinRate)` picks the beat, a hash of that beat jumps the whole field
 * somewhere new, and within the beat the bolt decays off an exponential. The
 * shape itself is a ridge (the zero crossing of the noise, which is a thin
 * filament) multiplied by a second, finer ridge — which is what splits a trunk
 * into forks rather than leaving one clean worm.
 *
 * It is the one layer of the ability that is *fast*. The swirl, the wisps and
 * the rings are all slow, and without something with a short beat in it the
 * whole aura reads as sedate.
 *
 * ## The striations
 *
 * Two noise bands crawling up the core, as the light pillar has. In the
 * reference they are what stops the shaft being a flat violet rectangle: a
 * column of energy has *stuff falling through it*, and one band alone reads as
 * a texture sliding on a pipe.
 *
 * ## What it owns
 *
 * Two meshes and their uniforms, in a group. Where it stands, how far up it has
 * come and how hard it is burning are told to it once a frame by
 * `vfx/ShadowBoost.js`. It never allocates after construction.
 */
export class DarkPillar {
  constructor() {
    // Unit tube, base on the origin: the owner scales it in metres, and both
    // shaders want `y` in [0, 1] with 0 at the ground.
    const geometry = new CylinderGeometry(1, 1, 1, RADIAL, HEIGHT_SEGMENTS, true).translate(
      0,
      0.5,
      0
    );
    /** Shared by both meshes, and disposed once. */
    this.geometry = geometry;

    /** Everything it is. Add this to the scene. */
    this.group = new Group();
    this.group.name = 'DarkPillar';

    const shared = () => ({
      uColor: { value: makeColor('#7c4dff') },
      uCoreColor: { value: makeColor('#e8dcff') },
      uShadeColor: { value: makeColor('#08060e') },
      uIntensity: { value: 1.0 },
      uShade: { value: 0.75 },
      /** How hard the dark is held to the silhouette. */
      uShadePower: { value: 2.4 },
      /** 0..1 — how far up the front of the column has climbed. */
      uHead: { value: 0 },
      /** 0..1 — master, for the rise and the sink. */
      uFade: { value: 0 },
      /** 0..1 — decaying, the white left over from the frame it broke through. */
      uFlash: { value: 0 },
      /** 0..1 — how much of the hot leading edge to draw. */
      uEdge: { value: 0 },
      uTime: { value: 0 },
      uCorePower: { value: 2.2 },
      uRimPower: { value: 3.0 },
      uRim: { value: 0.18 },
      uTopFade: { value: 0.5 },
      /** The stuff falling through the core. */
      uStreaks: { value: 0.5 },
      uStreakScale: { value: 1.2 },
      uStreakSpeed: { value: 1.5 },
      /** The bolts: how much, how big, how often they strike, how thin, how forked. */
      uVeins: { value: 0.9 },
      uVeinScale: { value: 2.4 },
      uVeinRate: { value: 7.0 },
      uVeinPower: { value: 6.0 },
      uVeinBranch: { value: 0.55 },
      /** How much of the glow the wall between the lens and the body is worth. */
      uFront: { value: 0.45 },
      uPulse: { value: 0.16 },
      uPulseSpeed: { value: 3.0 },
      uFlare: { value: 1.5 },
      uFlareHeight: { value: 0.06 },
      uSeed: { value: 9.1 }
    });

    // The volume. Laid over the frame, so the world behind the column dims.
    this.shadeMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      // Tested, so the column is cut by the body standing in it and by anything
      // between it and the lens. That occlusion is most of what puts it in the
      // world rather than over it.
      depthTest: true,
      side: DoubleSide,
      blending: NormalBlending,
      fog: false,
      toneMapped: false,
      uniforms: shared(),
      vertexShader: VERTEX,
      fragmentShader: SHADE_FRAGMENT
    });

    // The energy. Added on top of it.
    this.glowMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: DoubleSide,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
      uniforms: shared(),
      vertexShader: VERTEX,
      fragmentShader: GLOW_FRAGMENT
    });

    this.shade = new Mesh(geometry, this.shadeMaterial);
    this.shade.name = 'DarkPillarShade';
    this.glow = new Mesh(geometry, this.glowMaterial);
    this.glow.name = 'DarkPillarGlow';

    for (const mesh of [this.shade, this.glow]) {
      // It stands wherever the body is and is scaled out of nothing on the way
      // in, so there is no bounding volume that could be right.
      mesh.frustumCulled = false;
      mesh.layers.set(LAYER.VFX);
      mesh.visible = false;
      mesh.raycast = () => {};
    }
    // The dark first, then what is burning inside it. The order is the effect:
    // swapped, the glow is dimmed by the shade it is supposed to be inside.
    this.shade.renderOrder = 6;
    this.glow.renderOrder = 7;
    this.group.add(this.shade, this.glow);
  }

  /**
   * Where it stands. The foot of the column, in world space.
   *
   * @param {number} x
   * @param {number} y the ground under the body
   * @param {number} z
   */
  place(x, y, z) {
    this.group.position.set(x, y, z);
  }

  /**
   * @param {object} config `settings.shadowBoost.column`
   * @param {object} state
   * @param {number} state.head 0..1, how far up the front has climbed
   * @param {number} state.width multiplier on the radius, so it can swell
   * @param {number} state.flash 0..1, decaying, after it broke through
   * @param {number} state.edge 0..1, how much of the hot leading edge is drawn
   * @param {number} state.fade master
   * @param {number} elapsed the shared clock
   */
  update(config, { head = 0, width = 1, flash = 0, edge = 0, fade = 1 }, elapsed = 0) {
    const visible = fade > 0.001 && head > 0.001 && width > 0.001;
    this.shade.visible = visible;
    this.glow.visible = visible;
    if (!visible) return;

    const radius = Math.max(0.02, config.radius) * width;
    const height = Math.max(0.1, config.height);
    this.shade.scale.set(radius, height, radius);
    this.glow.scale.copy(this.shade.scale);

    for (const material of [this.shadeMaterial, this.glowMaterial]) {
      const u = material.uniforms;
      copyColor(u.uColor.value, config.color);
      copyColor(u.uCoreColor.value, config.coreColor);
      copyColor(u.uShadeColor.value, config.shadeColor);
      u.uIntensity.value = config.intensity;
      u.uShade.value = config.shade;
      u.uShadePower.value = Math.max(0.2, config.shadePower);
      u.uHead.value = head;
      u.uFade.value = fade;
      u.uFlash.value = flash;
      u.uEdge.value = edge;
      u.uTime.value = elapsed;
      u.uCorePower.value = Math.max(0.05, config.corePower);
      u.uRimPower.value = Math.max(0.05, config.rimPower);
      u.uRim.value = config.rim;
      u.uTopFade.value = config.topFade;
      u.uStreaks.value = config.streaks;
      u.uStreakScale.value = Math.max(0.05, config.streakScale);
      u.uStreakSpeed.value = config.streakSpeed;
      u.uVeins.value = config.veins;
      u.uVeinScale.value = Math.max(0.1, config.veinScale);
      u.uVeinRate.value = Math.max(0.1, config.veinRate);
      u.uVeinPower.value = Math.max(1, config.veinPower);
      u.uVeinBranch.value = config.veinBranch;
      u.uFront.value = config.front;
      u.uPulse.value = config.pulse;
      u.uPulseSpeed.value = config.pulseSpeed;
      u.uFlare.value = Math.max(0.05, config.flare);
      u.uFlareHeight.value = Math.max(0.01, config.flareHeight);
    }
  }

  /** A fresh set of veins, for the next cast. */
  reseed() {
    const seed = Math.random() * 128;
    this.shadeMaterial.uniforms.uSeed.value = seed;
    this.glowMaterial.uniforms.uSeed.value = seed;
  }

  /** Off, immediately. */
  clear() {
    this.shade.visible = false;
    this.glow.visible = false;
  }

  dispose() {
    this.group.parent?.remove(this.group);
    this.geometry.dispose();
    this.shadeMaterial.dispose();
    this.glowMaterial.dispose();
  }
}

/* -------------------------------------------------------------------- */

/**
 * The tube, flared at its foot.
 *
 * The flare is done here rather than in the geometry so it stays a taste
 * control: a column that widens where it meets the floor reads as something
 * pouring *out* of the ground, and one that does not reads as a pipe.
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
 * Everything both halves have to agree on: where the column exists, how thick
 * it is at this fragment, and how much of it has risen.
 *
 * Kept as one string pasted into both shaders rather than as two copies,
 * because the moment the shade and the glow disagree about the profile the
 * column separates into a dark tube with a bright tube inside it.
 */
const COMMON = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uCoreColor;
uniform vec3 uShadeColor;
uniform float uIntensity;
uniform float uShade;
uniform float uShadePower;
uniform float uHead;
uniform float uFade;
uniform float uFlash;
uniform float uEdge;
uniform float uTime;
uniform float uCorePower;
uniform float uRimPower;
uniform float uRim;
uniform float uTopFade;
uniform float uStreaks;
uniform float uStreakScale;
uniform float uStreakSpeed;
uniform float uVeins;
uniform float uVeinScale;
uniform float uVeinRate;
uniform float uVeinPower;
uniform float uVeinBranch;
uniform float uFront;
uniform float uPulse;
uniform float uPulseSpeed;
uniform float uSeed;

varying vec3 vWorld;
varying vec3 vNormal;
varying float vY;
varying float vAngle;

const float TAU = 6.28318530718;

/** How much column the eye is looking through here, 0..1. */
float chord() {
  vec3 view = normalize(vWorld - cameraPosition);
  return abs(dot(normalize(vNormal), view));
}

/**
 * How much of the column exists at this height.
 *
 * The front travels *up* from the floor, and above it there is nothing at all.
 * Below it the column dissolves as it nears the head, so the top is a ragged
 * end rather than a lid — a column that stopped at a clean disc is the one
 * thing that gives the trick away from any angle.
 */
float risen() {
  if (vY > uHead) return 0.0;
  float dissolve = max(0.02, uTopFade * uHead);
  return 1.0 - smoothstep(uHead - dissolve, uHead, vY);
}

/** The breath the standing column sits on. */
float breath() {
  return 1.0 - uPulse * (0.5 - 0.5 * cos(uTime * uPulseSpeed));
}
`;

/**
 * The half that darkens — and it darkens the **edges**.
 *
 * `pow(1 - chord, shadePower)`: the complement of the profile the glow uses, so
 * the two are the same column read from opposite ends. Down the axis this is
 * very nearly zero, which is deliberate and is the whole reason the character
 * survives standing in the middle of the effect — the near wall is at its most
 * transparent exactly where their body is.
 *
 * What it buys is the thing additive blending cannot: the silhouette of the
 * column is genuinely *darker than the world behind it*, so the shaft has an
 * outside as well as an inside.
 */
const SHADE_FRAGMENT = /* glsl */ `
${noiseGLSL}
${COMMON}

void main() {
  float exists = risen();
  if (exists <= 0.003) discard;

  float depth = chord();
  // The rim, not the core. See the class note.
  float dark = pow(1.0 - depth, uShadePower);

  // Torn along its length, so the wall of dark is not a clean gradient.
  float grain = fbm3(vec3(
    cos(vAngle * TAU) * 1.4,
    vY * 2.2 - uTime * 0.35,
    sin(vAngle * TAU) * 1.4 + uSeed
  ));

  float a = dark * uShade * exists * uFade * mix(0.72, 1.15, grain) * breath();
  // The frame it breaks through, the dark is thinnest: the flash is light, and
  // light this bright is light the shade must get out of the way of.
  a *= 1.0 - uFlash * 0.75;
  if (a < 0.004) discard;

  // Not premultiplied: this is the layer that is laid over the frame.
  gl_FragColor = vec4(uShadeColor, clamp(a, 0.0, 0.94));
}
`;

/**
 * The energy — the half that adds, and it is weighted to the **core**.
 *
 * `pow(chord, corePower)` is the length of the eye's ray through the column, so
 * the shaft is densest along its axis and falls off to nothing at the edges,
 * and it is *round* from every angle without a single extra vertex. The rim
 * survives only as a thin accent: past about 0.3 it draws a hard boundary down
 * both sides and the column becomes a rectangle, whatever the core is doing.
 *
 * On top of the core go the two things the reference has inside its cylinder:
 * striations crawling upward, and lightning.
 */
const GLOW_FRAGMENT = /* glsl */ `
${noiseGLSL}
${COMMON}

void main() {
  float exists = risen();
  if (exists <= 0.003) discard;

  float depth = chord();
  float core = pow(depth, uCorePower);
  float rim = pow(1.0 - depth, uRimPower) * uRim;

  /* ---- what is falling through it ---- */
  // Two bands at different rates: one straight up the wall, one turning as it
  // goes. A single field reads as a texture sliding on a pipe.
  float streaks = 0.0;
  if (uStreaks > 0.001) {
    float a = vAngle * TAU;
    float n1 = snoise01(vec3(cos(a) * 1.7, vY * uStreakScale - uTime * uStreakSpeed, sin(a) * 1.7 + uSeed));
    float n2 = snoise01(vec3(cos(a) * 3.3 + uSeed, vY * uStreakScale * 2.1 - uTime * uStreakSpeed * 1.7, sin(a) * 3.3));
    streaks = (n1 * 0.65 + n2 * 0.35 - 0.34) * uStreaks * core;
  }

  /* ---- the lightning ---- */
  float veins = 0.0;
  if (uVeins > 0.001) {
    float a = vAngle * TAU;
    // A quantised clock. Every beat the whole field jumps somewhere new, so a
    // bolt does not travel — it is replaced. That is the difference between
    // lightning and a lava lamp.
    float beat = floor(uTime * uVeinRate);
    float jump = hash11(beat + uSeed) * 53.0;
    vec3 p = vec3(cos(a) * uVeinScale, vY * uVeinScale * 3.2, sin(a) * uVeinScale) + jump;

    // The zero crossing of the field is a thin filament — that is the bolt.
    float trunk = pow(1.0 - abs(snoise(p)), uVeinPower);
    // And a second, finer one multiplied into it, which is what splits a trunk
    // into forks instead of leaving one clean worm down the column.
    float fork = pow(1.0 - abs(snoise(p * 2.7 + 13.0)), uVeinPower * 0.6);
    float bolt = mix(trunk, trunk * fork * 2.2, uVeinBranch);

    // Struck, then gone: an exponential decay across the beat rather than a
    // fade, because a discharge has all of its light in its first instant.
    float strike = exp(-fract(uTime * uVeinRate) * 3.6);
    // Held toward the middle of the column, where the eye reads it as being
    // *inside* the shaft rather than crawling on its skin.
    veins = bolt * strike * uVeins * mix(0.4, 1.0, core);
  }

  /* ---- the ends ---- */
  // Brightest where it comes out of the floor, because that is where the ground
  // is being opened.
  float foot = 1.0 + 0.85 * (1.0 - smoothstep(0.0, 0.1, vY));
  // And the front itself, while it is still climbing.
  float edge = (1.0 - smoothstep(0.0, 0.07, uHead - vY)) * uEdge * 1.8;

  // The tube is two-sided, and the wall the lens sees *through* is the one
  // standing between it and the character. Both walls adding equally is what
  // doubles the density of a shaft of light — and it is also what paints the
  // player out of the middle of their own ability. So the near wall is worth a
  // fraction of the far one: the same light, moved to the side of the body that
  // can afford it. gl_FrontFacing is the whole test — from outside the tube,
  // the near wall shows its front face and the far wall its back.
  float side = gl_FrontFacing ? uFront : 1.0;

  float gain = uIntensity * uFade * exists * breath() * side;
  float body = max(0.0, core + streaks) * foot + rim;
  // The flash rides the core and the bolts. Put any of it on the rim and the
  // arrival draws a hard bright outline down both sides of the column, which is
  // the one moment the shaft must not look like a cut-out.
  float hot = edge + veins + uFlash * (core * 1.3 + veins * 1.2);

  vec3 rgb = uColor * body + uCoreColor * (hot + core * core * 0.35);
  float a = (body + hot + core * core * 0.35) * gain;
  if (a < 0.003) discard;

  // Premultiplied against an additive blend: the alpha is the light.
  gl_FragColor = vec4(rgb * gain, a);
}
`;
