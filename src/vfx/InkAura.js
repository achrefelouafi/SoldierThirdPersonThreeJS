import {
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial
} from 'three';

import { LAYER } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { copyColor, makeColor } from '../utils/color.js';

/**
 * Slabs in the shell.
 *
 * Each is one quad and they are stacked round the mark at staggered bearings,
 * so the count is the *density* of the aura rather than a level of detail.
 * Twelve is where the shell closes from every angle the third-person camera can
 * take without any single slab being asked to carry a whole side.
 */
const SLABS = 12;

/** Subdivisions of one slab — only the curl up its height needs any. */
const SEGMENTS_X = 1;
const SEGMENTS_Y = 10;

const _matrix = /* @__PURE__ */ new Matrix4();

/**
 * The dark, standing up around whatever is being unmade.
 *
 * ## What it is for
 *
 * The fourth panel of the reference, and the layer the whole thing would fall
 * apart without. Strokes, mist, rings and cinders are all *bright* — thrown on
 * top of a night scene they read as a fireworks display. The aura is the only
 * element that **subtracts**: black ink standing up out of the ground and
 * curling, which gives every bright thing in front of it something to be bright
 * *against*. Remove it and the ability loses about half its contrast without
 * losing a single lumen.
 *
 * It is also the thing the blades come out of. A katana that fades in against
 * open air is a decal; one that comes forward out of a wall of smoke was
 * *always there*, and the aura is the only reason that reads.
 *
 * ## Why slabs and not a shell
 *
 * The obvious build is a cylinder — one mesh, one silhouette. It is wrong for
 * this: a cylinder has a single depth, so the ink is a *skin* at a fixed radius
 * and the eye reads it as a curtain hung round the body. The reference's aura
 * has ribbons at obviously different distances passing in front of and behind
 * one another.
 *
 * So it is a dozen flat slabs on a ring, each **billboarded about the vertical
 * only** — turned to face the lens but never tipped, because smoke rising out
 * of the ground has an up and a slab that pitched with the camera would tumble.
 * At a dozen slabs and a fifth of a metre of radius jitter each, the overlaps
 * *are* the volume: what the eye reads as depth is one ribbon occluding another
 * at a different radius, which is exactly what is happening.
 *
 * ## The ink itself
 *
 * A domain-warped ridged field scrolled downward, which is the standard recipe
 * for filaments and the right one here — `ridged()` peaks along the *zero
 * crossings* of its noise, so its features are thin curling threads rather than
 * blobs, and warping its lookup with a slower copy of itself is what bends
 * those threads into hooks instead of leaving them combed.
 *
 * It is thresholded hard rather than used as a density. Soft smoke is a haze;
 * the reference's ink has an **edge** on it, and a hard cut is the only way to
 * get one out of a noise field.
 *
 * ## Premultiplied, so it can be black
 *
 * `ONE, ONE_MINUS_SRC_ALPHA` with `rgb * a` out of the shader. A near-black
 * fragment at high alpha genuinely hides what is behind it — an additive one
 * could only ever brighten, and an ordinary alpha blend could never let the
 * crimson rim be hotter than the ink is dark. Here the rim can bloom while the
 * body of the ribbon puts out the sky behind it.
 */
export class InkAura {
  constructor() {
    // Anchored on its own foot, so `y` in the shader runs 0 at the ground to 1
    // at the top of the slab and the instance's scale is its height in metres.
    const geometry = new PlaneGeometry(1, 1, SEGMENTS_X, SEGMENTS_Y).translate(0, 0.5, 0);
    geometry.setAttribute('aSeed', new InstancedBufferAttribute(new Float32Array(SLABS), 1));
    geometry.setAttribute('aPhase', new InstancedBufferAttribute(new Float32Array(SLABS), 1));

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      // Tested, so the body standing in the aura is in it rather than behind
      // it, and a ribbon crossing in front of the character actually occludes.
      depthTest: true,
      blending: NormalBlending,
      premultipliedAlpha: true,
      fog: false,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        /** The ink, and the heat caught in its edges. */
        uInkColor: { value: makeColor('#050205') },
        uRimColor: { value: makeColor('#8e0a14') },
        uOpacity: { value: 0.85 },
        uRim: { value: 0.5 },
        /** 0..1 master, for the well-up and the sink. */
        uFade: { value: 0 },
        /** How much of its full height the shell has reached, 0..1. */
        uReach: { value: 1 },
        /** Feature size, how fast the threads climb, and how hard they hook. */
        uScale: { value: 1.5 },
        uRise: { value: 0.42 },
        uWarp: { value: 0.75 },
        /** Where the ink is cut out of the field, and how sharp that cut is. */
        uThreshold: { value: 0.52 },
        uSharpness: { value: 0.2 },
        /** The lean, and how fast the whole shell turns about the mark. */
        uCurl: { value: 0.4 },
        uCurlSpeed: { value: 0.8 },
        uSwirl: { value: 0.35 }
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT
    });

    this.mesh = new InstancedMesh(geometry, this.material, SLABS);
    this.mesh.name = 'InkAura';
    this.mesh.count = SLABS;
    // Billboarded per instance in the vertex shader, and standing wherever the
    // mark is — there is no bounding volume that could be right.
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.layers.set(LAYER.VFX);
    // Behind the mist and the strokes, in front of the floor. The ink is the
    // backdrop the bright layers are read against.
    this.mesh.renderOrder = 5;
    this.mesh.raycast = () => {};

    this._seeds = geometry.getAttribute('aSeed');
    this._phases = geometry.getAttribute('aPhase');
    /**
     * How much of the full height each slab gets, and how far off the ring it
     * stands. CPU-side only: both are baked into the instance matrix by
     * `_layout`, so the shader never has to be told either of them.
     */
    this._reaches = new Float32Array(SLABS);
    this._offsets = new Float32Array(SLABS);

    /** Where the shell stands and how big it was told to be, this frame. */
    this._x = 0;
    this._y = 0;
    this._z = 0;
    this._radius = 1;
    this._height = 1;

    this.reseed();
  }

  /**
   * Fresh bearings, radii and heights for every slab.
   *
   * Called on each cast rather than once at construction: two rites in a row on
   * two bodies should not stand up the same silhouette twice, and it is a dozen
   * floats.
   */
  reseed() {
    const seeds = this._seeds.array;
    const phases = this._phases.array;

    for (let i = 0; i < SLABS; i++) {
      seeds[i] = Math.random() * 64;
      // Spread over the ring rather than placed at random on it — a dozen
      // random bearings leave gaps and clumps, and a gap in a shell is a hole
      // straight through to whatever is inside it.
      phases[i] = ((i + Math.random() * 0.7) / SLABS) * Math.PI * 2;
      // How much of the full height this one gets. The short ones are the body
      // of the aura and the tall ones are the ribbons out of the top of it.
      this._reaches[i] = 0.45 + Math.random() * Math.random() * 0.8;
      // And how far off the ring — the thickness the shell occludes through.
      this._offsets[i] = 0.55 + Math.random() * 0.7;
    }

    this._seeds.needsUpdate = true;
    this._phases.needsUpdate = true;
    // The layout is what carries both of the numbers above onto the GPU.
    this._layout();
  }

  /**
   * Stand it here — `y` is the ground, and the ink comes up off it.
   *
   * @param {number} x world
   * @param {number} y the ground under the mark
   * @param {number} z
   */
  place(x, y, z) {
    this._x = x;
    this._y = y;
    this._z = z;
  }

  /**
   * @param {object} config `settings.crimsonRite.aura`
   * @param {{fade?: number, scale?: number, reach?: number}} state how much of
   *   it there is this frame, how wide, and how far up it has come
   * @param {number} [elapsed] the shared clock, for the ink's own crawl
   */
  update(config, { fade = 1, scale = 1, reach = 1 }, elapsed = 0) {
    const visible = config.enabled && fade > 0.001 && scale > 0.001;
    this.mesh.visible = visible;
    if (!visible) return;

    const radius = Math.max(0.05, config.radius) * scale;
    const height = Math.max(0.05, config.height) * scale;
    // Only rebuilt when the shape actually moved: the slabs are billboarded in
    // the shader, so a frame that changed nothing about where the shell is has
    // nothing to restream.
    if (
      radius !== this._radius ||
      height !== this._height ||
      this.mesh.position.x !== this._x ||
      this.mesh.position.y !== this._y ||
      this.mesh.position.z !== this._z
    ) {
      this._radius = radius;
      this._height = height;
      this._layout();
    }

    const u = this.material.uniforms;
    u.uTime.value = elapsed;
    copyColor(u.uInkColor.value, config.inkColor);
    copyColor(u.uRimColor.value, config.rimColor);
    u.uOpacity.value = config.opacity;
    u.uRim.value = config.rim;
    u.uFade.value = fade;
    u.uReach.value = reach;
    u.uScale.value = config.scale;
    u.uRise.value = config.rise;
    u.uWarp.value = config.warp;
    u.uThreshold.value = config.threshold;
    u.uSharpness.value = Math.max(0.01, config.sharpness);
    u.uCurl.value = config.curl;
    u.uCurlSpeed.value = config.curlSpeed;
    u.uSwirl.value = config.swirl;
  }

  /** Everything off, immediately — for leaving the stage and for a reset. */
  clear() {
    this.mesh.visible = false;
    this.material.uniforms.uFade.value = 0;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }

  /**
   * Put the slabs on their ring.
   *
   * Only the *anchor* of each slab is written here — where its foot stands and
   * how tall and wide it is. Which way it faces is the vertex shader's, once a
   * frame, because that answer changes every time the lens moves and no CPU
   * pass should be re-solving it.
   */
  _layout() {
    this.mesh.position.set(this._x, this._y, this._z);

    const phases = this._phases.array;

    for (let i = 0; i < SLABS; i++) {
      const angle = phases[i];
      // Jittered off the ring rather than on it, so the shell has a thickness
      // to occlude through instead of being a fence.
      const radius = this._radius * this._offsets[i];
      const height = this._height * this._reaches[i];
      // Narrower than the ring it stands on, so the shell has gaps in it. At
      // anything much wider a dozen slabs overlap into a solid box and the aura
      // stops being a thing standing *around* the body and becomes a room it is
      // inside — which hides the blades the aura exists to deliver.
      _matrix.makeScale(this._radius * 0.9, height, 1);
      _matrix.setPosition(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      this.mesh.setMatrixAt(i, _matrix);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/* -------------------------------------------------------------------- */

/**
 * One slab, turned to the lens about the vertical only.
 *
 * The instance matrix carries the foot and the size; the facing is resolved
 * here from `cameraPosition`, which three.js gives every shader. The quad's
 * own `x` is laid along the horizontal right of the view and its `y` is left on
 * world up — so the ribbon always presents its face and never lies down, which
 * is the one thing a pillar of smoke must not do.
 */
const VERTEX = /* glsl */ `
${noiseGLSL}

uniform float uTime;
uniform float uCurl;
uniform float uCurlSpeed;
uniform float uSwirl;
uniform float uReach;

attribute float aSeed;
attribute float aPhase;

varying vec2 vUv;
varying float vSeed;

const float TAU = 6.28318530718;

void main() {
  vUv = uv;
  vSeed = aSeed;

  // The foot in world space, and the size the instance matrix was given — read
  // off the lengths of its own basis vectors, because the slab is rebuilt to
  // face the lens here and the matrix's rotation is therefore thrown away.
  vec4 anchor = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float width = length((modelMatrix * instanceMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
  float height = length((modelMatrix * instanceMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz) * uReach;

  // The whole shell turns slowly about the mark, so the aura is *moving* even
  // on a frame where the ink itself has barely crawled.
  float turn = uTime * uSwirl;
  vec2 offset = anchor.xz - (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz;
  float c = cos(turn);
  float s = sin(turn);
  anchor.xz = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz +
              vec2(offset.x * c - offset.y * s, offset.x * s + offset.y * c);

  // Face the lens, about the vertical only.
  vec3 toCamera = cameraPosition - anchor.xyz;
  toCamera.y = 0.0;
  float len = length(toCamera);
  vec3 forward = len > 1e-4 ? toCamera / len : vec3(0.0, 0.0, 1.0);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), forward));

  float v = position.y;
  // The lean. It grows with the square of the height, so the foot is planted
  // and the top is the part that hooks over — which is how smoke behaves and
  // how the reference's ribbons are drawn.
  float lean = sin(uTime * uCurlSpeed + aPhase + aSeed) * uCurl * v * v;

  vec3 world = anchor.xyz + right * (position.x * width + lean) + vec3(0.0, v * height, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

/**
 * The ink: a warped ridged field, cut hard, with heat in the cut.
 *
 * `ridged()` is the whole shape — it peaks where its noise crosses zero, which
 * is a *thin curling filament* rather than a blob, and that is what smoke of
 * this kind is made of. Warping its lookup with a slower copy of itself bends
 * those filaments into hooks; without the warp they comb themselves into
 * parallel stripes and the aura reads as a curtain of hair.
 */
const FRAGMENT = /* glsl */ `
${noiseGLSL}

uniform float uTime;
uniform vec3 uInkColor;
uniform vec3 uRimColor;
uniform float uOpacity;
uniform float uRim;
uniform float uFade;
uniform float uScale;
uniform float uRise;
uniform float uWarp;
uniform float uThreshold;
uniform float uSharpness;

varying vec2 vUv;
varying float vSeed;

void main() {
  float u = vUv.x;
  float v = vUv.y;

  /* ---- the envelope the ink is allowed to exist inside ---- */
  // Out at the sides, so a slab has no vertical edges to give itself away.
  float across = 1.0 - smoothstep(0.25, 0.5, abs(u - 0.5));
  // Off the ground over the first tenth, and gone well before the top: ink that
  // reaches the last row of vertices ends in a straight cut.
  float along = smoothstep(0.0, 0.1, v) * (1.0 - smoothstep(0.45, 1.0, v));
  float envelope = across * along;
  if (envelope <= 0.002) discard;

  /* ---- the filaments ---- */
  // Scrolled *down* through the slab, which reads as the ink climbing: the
  // features are moving up the screen because the field is moving down past
  // them. The seed puts every slab in a different part of the field.
  vec2 q = vec2(u * uScale * 2.2, v * uScale * 1.3 - uTime * uRise) + vSeed;

  // The warp: a slower copy of the same field, dragging the lookup sideways.
  vec2 warp = vec2(
    fbm3(vec3(q * 0.7, vSeed)),
    fbm3(vec3(q * 0.7 + 11.3, vSeed))
  ) * uWarp;

  float n = ridged(vec3(q + warp, vSeed * 0.5), 4);

  // Cut hard. A soft threshold gives haze; the reference's ink has an edge on
  // it, and this is the only place that edge can come from.
  float ink = smoothstep(uThreshold, uThreshold + uSharpness, n);
  ink *= envelope;
  if (ink <= 0.003) discard;

  /* ---- and the heat in the edge of it ---- */
  // A band, not a fill: it lives in the transition between ink and air, which
  // is where the reference's crimson actually is. Everything deeper than the
  // band is black.
  float rim = (1.0 - smoothstep(0.0, 0.45, ink)) * smoothstep(0.02, 0.2, ink) * uRim;

  float a = ink * uOpacity * uFade;
  if (a < 0.004) discard;

  vec3 rgb = uInkColor + uRimColor * rim * 2.6;

  // Premultiplied: black at high alpha puts the sky out, and the rim can still
  // be hot enough to bloom.
  gl_FragColor = vec4(rgb * a, a);
}
`;
