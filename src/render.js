// Ink renderer: scene is drawn into a data buffer (shade, inkId, normal.xy) + depth, then a
// full-screen "pen on lined paper" pass draws outlines, hatching, paper grain and ruled lines.
import * as THREE from 'three';

export const INK = { BLUE: 0, RED: 1, BLACK: 2, ORANGE: 3, GREEN: 4, PINK: 5, FOE: 6 };
export const INK_COLORS = [
  new THREE.Vector3(0.10, 0.19, 0.76), // blue ballpoint
  new THREE.Vector3(0.86, 0.12, 0.20), // red pen
  new THREE.Vector3(0.18, 0.20, 0.26), // graphite
  new THREE.Vector3(0.92, 0.55, 0.08), // orange highlighter
  new THREE.Vector3(0.12, 0.60, 0.30), // green
  new THREE.Vector3(0.90, 0.40, 0.66), // pink eraser
  new THREE.Vector3(0.09, 0.09, 0.11), // black marker: enemies, so nothing of theirs reads as blood
];
export const LIGHT_WORLD = new THREE.Vector3(0.45, 0.72, 0.52).normalize();
// Watercolour / felt-marker washes laid under the ink. Level pieces carry one of these in a 'wash'
// vertex attribute (see level.js); anything without one is tinted from its own ink colour.
export const WASH = { NONE: 0, GROUND: 1, OUTER: 2, ROOF: 3, PAVING: 4, BUILD: 5, PROP: 11, SUN: 12, CLOUD: 13 };
const hex = (h) => new THREE.Vector3(((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255);
export const WASH_COLORS = [
  0xffffff, 0xead9b8, 0xe6ad9a, 0xd9805f, 0xd8d2c2,                // none, ground, outer walls, roofs, paving
  0xf3cf72, 0x9fcdbb, 0xf0a593, 0xaab8ec, 0xc8e09a, 0xe6b4dc,       // six building colours
  0xe2b06e, 0xffd84a, 0xdde8f6,                                    // props, the sun, clouds
].map(hex);
export const shared = { uLightDir: { value: new THREE.Vector3(0, 1, 0) }, uTime: { value: 0 } };

const inkVert = /* glsl */`
attribute float wash;
varying vec3 vNormalV;
varying vec4 vColorData;
varying float vWash;
uniform float uTime;
void main() {
  vWash = wash;
  vec3 transformed = position;
  vec3 objectNormal = normal;
  #ifdef USE_INSTANCING
    transformed = (instanceMatrix * vec4(transformed, 1.0)).xyz;
    objectNormal = mat3(instanceMatrix) * objectNormal;
  #endif
  #ifdef USE_INSTANCING_COLOR
    vColorData = vec4(instanceColor, 1.0);
  #else
    vColorData = vec4(0.0, 0.0, 0.0, -1.0);
  #endif
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  vNormalV = normalize(normalMatrix * objectNormal);
  gl_Position = projectionMatrix * mvPosition;
}`;

const inkFrag = /* glsl */`
precision highp float;
uniform float uInk;
uniform float uFill;
uniform float uShadeScale;
uniform float uShadeBias;
uniform vec3 uLightDir;
varying vec3 vNormalV;
varying vec4 vColorData;
varying float vWash;
void main() {
  vec3 n = normalize(vNormalV);
  if (!gl_FrontFacing) n = -n;
  float ndl = dot(n, uLightDir) * 0.5 + 0.5;
  float ink = uInk; float fill = uFill;
  if (vColorData.a > 0.0) { ink = vColorData.r; fill = vColorData.g; }
  float shade = clamp(ndl * uShadeScale + uShadeBias, 0.0, 1.0);
  if (fill > 0.5) shade = -1.0;
  // ink id and wash share a channel: ink + 8 * wash
  gl_FragColor = vec4(shade, ink + 8.0 * floor(vWash + 0.5), n.x, n.y);
}`;

export function makeInkMaterial(opts = {}) {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uInk: { value: opts.ink ?? INK.BLUE }, uFill: { value: opts.fill ? 1 : 0 },
      uShadeScale: { value: opts.shadeScale ?? 1.0 }, uShadeBias: { value: opts.shadeBias ?? 0.0 },
      uLightDir: shared.uLightDir, uTime: shared.uTime,
    },
    vertexShader: inkVert, fragmentShader: inkFrag, side: opts.side ?? THREE.FrontSide,
  });
  m.defaultAttributeValues = { ...m.defaultAttributeValues, wash: [0] };
  m.inkId = opts.ink ?? INK.BLUE;
  return m;
}
export function setInk(mat, ink) { mat.uniforms.uInk.value = ink; mat.inkId = ink; }
export function setFill(mat, fill) { mat.uniforms.uFill.value = fill ? 1 : 0; }

const postVert = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const postFrag = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tDepth;
#if QUALITY >= 2
#define AO_TAPS 8
#else
#define AO_TAPS 4
#endif
uniform vec2 uRes;
uniform float uAspect;
uniform float uTime;
uniform float uNear;
uniform float uFar;
uniform float uHurt;
uniform float uFlash;
uniform float uSlow;
uniform float uLineSpacing;
uniform float uLowHp;
uniform vec3 uPaper;
uniform vec3 uInks[7];
uniform mat4 uInvProj;
uniform mat4 uInvView;
uniform sampler2D tShadow;
uniform mat4 uShadowMat;
uniform float uShadowTexel;
uniform mat3 uShadowRot;
uniform float uShadowK;
uniform vec3 uWash[14];
uniform vec3 uRule;
uniform float uRuleAmt;
uniform vec3 uMargin;
uniform float uMarginAmt;
uniform float uBallpoint;

float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0)), c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float linDepth(float z) { float zn = z * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - zn * (uFar - uNear)); }
vec3 inkColor(float id) {
  int i = int(mod(id + 0.5, 8.0));
  if (i <= 0) return uInks[0]; if (i == 1) return uInks[1]; if (i == 2) return uInks[2];
  if (i == 3) return uInks[3]; if (i == 4) return uInks[4]; if (i == 5) return uInks[5]; return uInks[6];
}
vec3 washColor(float id) {
  int i = int(id + 0.5); vec3 c = uWash[0];
  for (int k = 1; k < 14; k++) if (k == i) c = uWash[k];
  return c;
}
float stripes(vec2 p, vec2 dir, float spacing, float width) {
  float t = dot(p, vec2(-dir.y, dir.x));
  float f = abs(fract(t / spacing) - 0.5) * spacing;
  float soft = width * 0.6;
  return 1.0 - smoothstep(width * 0.5 - soft, width * 0.5 + soft, f);
}
// One family of hand-drawn strokes: parallel lines one spacing apart that break into dashes of
// uneven length and swell and thin with pen pressure. Once a line gets narrower than about a
// pixel it is filtered down to its average ink, so far or grazing surfaces settle into an even
// tone instead of shimmering.
float strokes(vec2 p, vec2 dir, float spacing, float width, float seed) {
  float t = dot(p, vec2(-dir.y, dir.x)) / spacing;
  float a = dot(p, dir) / spacing;
  float k = floor(t + 0.5);
  float f = abs(t - k);
  float fw = fwidth(t);
  float hw = 0.5 * (width / spacing) * (0.6 + 0.8 * vnoise(vec2(a * 0.3, k * 1.7 + seed)));
  float aa = max(fw * 0.75, 0.05 * width / spacing);
  float line = 1.0 - smoothstep(hw - aa, hw + aa, f);
  line = mix(line, 2.0 * hw, smoothstep(0.3, 0.8, fw));
  // dashes: each line is drawn as a run of strokes with small gaps where the pen lifted
  float key = k * spacing * 6.25;
  float len = 4.0 + 7.0 * hash21(vec2(key, seed));
  float g = fract(a / len + hash21(vec2(key + 7.1, seed * 3.0)));
  float dash = 1.0 - smoothstep(0.86, 0.9, g) * (1.0 - smoothstep(0.2, 0.6, fw));
  return line * dash;
}
// three hatch families, laid in as the surface gets darker
float hatching(vec2 hp, float sp, float shade) {
  float w = sp * 0.17;
  float h1 = strokes(hp, vec2(0.7071, 0.7071), sp, w, 1.0);
  float h2 = strokes(hp, vec2(-0.7071, 0.7071), sp * 1.15, w, 2.0);
  float h3 = strokes(hp, vec2(0.2588, 0.9659), sp * 0.7, w, 3.0);
  float h = h1 * smoothstep(0.64, 0.5, shade);
  h = max(h, h2 * smoothstep(0.42, 0.32, shade));
  h = max(h, h3 * smoothstep(0.24, 0.14, shade));
  return max(h, smoothstep(0.12, 0.0, shade) * 0.9);
}
// depth comparisons at the four nearest shadow texels, blended by position, so the edge is smooth.
// Taps land a few texels away from the surface point, so the surface's own depth is carried along its
// plane to each tap (g is how light depth changes across the map); without that a flat roof seen in
// slanting sun shadowed itself in streaks that swam as you moved.
float shadowBilinear(vec2 uv, float z, vec2 o, vec2 g) {
  vec2 t = uv / uShadowTexel - 0.5; vec2 f = fract(t); vec2 b = (floor(t) + 0.5) * uShadowTexel;
  vec2 bx = vec2(uShadowTexel, 0.0), by = vec2(0.0, uShadowTexel);
  float s00 = step(texture2D(tShadow, b).x + 0.0004, z + dot(g, b - o));
  float s10 = step(texture2D(tShadow, b + bx).x + 0.0004, z + dot(g, b + bx - o));
  float s01 = step(texture2D(tShadow, b + by).x + 0.0004, z + dot(g, b + by - o));
  float s11 = step(texture2D(tShadow, b + bx + by).x + 0.0004, z + dot(g, b + bx + by - o));
  return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}

void main() {
  vec2 px = 1.0 / uRes;
  float sc = uRes.y / 900.0;
  vec2 nuv = vUv * vec2(uAspect, 1.0);
  vec2 wob = vec2(vnoise(nuv * 6.0 + 11.3), vnoise(nuv * 6.0 + 37.0)) - 0.5;
  // the scene is read straight: a screen-fixed wobble here makes every edge ripple as it slides past,
  // like looking through floaters in your eye
  vec2 suv = vUv;
  vec4 s = texture2D(tScene, suv);
  float z = texture2D(tDepth, suv).x;
  float d = linDepth(z);
  // never less than a whole texel: on a small render target (a phone) a sub-texel offset reads the
  // same depth sample on both sides and outlines break up into dashes
  float o = max(1.0, 1.15 * sc);
  vec2 ox = vec2(o, 0.0) * px, oy = vec2(0.0, o) * px;
  float zl = texture2D(tDepth, suv - ox).x, zr = texture2D(tDepth, suv + ox).x;
  float zu = texture2D(tDepth, suv + oy).x, zd = texture2D(tDepth, suv - oy).x;
  vec4 sl = texture2D(tScene, suv - ox), sr = texture2D(tScene, suv + ox);
  vec4 su = texture2D(tScene, suv + oy), sd = texture2D(tScene, suv - oy);
  // Edge test in inverse depth (1/d). For ANY plane - including ones seen at a
  // grazing angle, like the floor - 1/d is affine across the screen, so its second
  // difference is zero there and only real silhouettes register. Comparing it against
  // 1/d itself makes the test scale invariant, so distant outlines stay as crisp as near ones.
  float iw = 1.0 / d;
  float lap = abs(1.0 / linDepth(zl) + 1.0 / linDepth(zr) - 2.0 * iw)
            + abs(1.0 / linDepth(zu) + 1.0 / linDepth(zd) - 2.0 * iw);
  float edge = smoothstep(0.07, 0.30, lap / (iw + 1e-7));
  float nEdge = length(sl.ba - sr.ba) + length(su.ba - sd.ba);
  edge = max(edge, smoothstep(0.42, 0.85, nEdge));
  // ink colour of the front-most sample around the edge
  float zmin = z; float inkId = s.g;
  if (zl < zmin) { zmin = zl; inkId = sl.g; }
  if (zr < zmin) { zmin = zr; inkId = sr.g; }
  if (zu < zmin) { zmin = zu; inkId = su.g; }
  if (zd < zmin) { zmin = zd; inkId = sd.g; }
  float dFront = linDepth(zmin);
  bool sky = z >= 0.99999;

  // Hatching is anchored to the surface itself, not to the screen. The fragment's world position
  // is rebuilt from depth and the strokes are laid out in world units on whichever pair of axes
  // faces away from the surface normal, so the pattern stays put on a wall as you move past it.
  // Line spacing is picked from how much world one pixel covers on that surface (so walls seen
  // edge-on get looser lines instead of moire) and cross-fades between powers of two, so every
  // other line fades out with distance rather than the whole pattern jumping.
  // Everything here runs for every pixel: the screen-space derivatives need uniform control flow.
  float shade = s.r;
  vec4 clip = vec4(vUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  vec4 vpos = uInvProj * clip; vpos /= vpos.w;
  vec3 wpos = (uInvView * vec4(vpos.xyz, 1.0)).xyz;
  vec2 nxy = s.ba;
  vec3 nView = vec3(nxy, sqrt(max(0.0, 1.0 - dot(nxy, nxy))));
  vec3 wn = normalize(mat3(uInvView) * nView);
  vec3 an = abs(wn);
  vec2 hpW = an.y > max(an.x, an.z) ? wpos.xz : (an.x > an.z ? wpos.zy : wpos.xy);
  float pxDist = 1.678 * d / uRes.y;
  float pxW = max(length(dFdx(hpW)), length(dFdy(hpW)));
  float target = 9.0 * sc * clamp(pxW, pxDist, 4.0 * pxDist);
  float lodF = log2(max(1e-4, target / 0.16));
  float sp = 0.16 * exp2(floor(lodF));
  float lodBlend = smoothstep(0.2, 0.8, fract(lodF));
  vec2 hp = hpW + (vnoise(hpW * (1.25 / sp)) - 0.5) * sp * 0.4; // hand-drawn waver, fixed to the surface
  bool held = d < 2.0;
  if (held) {
    // the held weapon rides with the camera, so for it the screen is the stable frame
    hp = gl_FragCoord.xy + wob * 5.0 * sc; sp = 8.5 * sc; lodBlend = 0.0;
  }

  // Contact shading: corners, the ground at the foot of a wall and the spot under anything
  // standing get hatched in, which is what makes things sit on the page instead of floating.
  // 1/d is affine across any plane, so each tap is compared with this pixel's own plane extended
  // to it; only taps in front of that plane count, so open floor seen at a grazing angle stays clean.
  float ao = 0.0;
#if QUALITY >= 1
  if (!sky && !held && d < 120.0) {
    // work on exact texel centres: the depth buffer is sampled nearest, and an offset that lands
    // a fraction of a texel off would skew the slope estimate and smear blobs over flat ground
    vec2 bc = (floor(suv * uRes) + 0.5) * px;
    float ib = 1.0 / linDepth(texture2D(tDepth, bc).x);
    float il = 1.0 / linDepth(texture2D(tDepth, bc - vec2(px.x, 0.0)).x), ir = 1.0 / linDepth(texture2D(tDepth, bc + vec2(px.x, 0.0)).x);
    float idn = 1.0 / linDepth(texture2D(tDepth, bc - vec2(0.0, px.y)).x), iu = 1.0 / linDepth(texture2D(tDepth, bc + vec2(0.0, px.y)).x);
    // one-sided slopes, taking the gentler side so a silhouette next door doesn't tilt the plane
    float gx = abs(ir - ib) < abs(ib - il) ? ir - ib : ib - il;
    float gy = abs(iu - ib) < abs(ib - idn) ? iu - ib : ib - idn;
    float rpx = clamp(0.6 * uRes.y / (1.678 * d), 4.0 * sc, 80.0 * sc);
    for (int i = 0; i < AO_TAPS; i++) {
      float ang = float(i) * (6.2832 / float(AO_TAPS)) + 0.4;
      vec2 off = floor(vec2(cos(ang), sin(ang)) * rpx * (i % 2 == 0 ? 1.0 : 0.5) + 0.5);
      float ie = ib + gx * off.x + gy * off.y;
      if (ie <= 0.0) continue;
      float ds = linDepth(texture2D(tDepth, bc + off * px).x);
      float diff = (1.0 / ie - ds) * step(2.0, ds); // the held weapon never shades the world
      ao += smoothstep(0.04, 0.25, diff) * (1.0 - smoothstep(1.0, 2.4, diff));
    }
    ao = clamp(ao * (2.0 / float(AO_TAPS)), 0.0, 1.0) * (1.0 - smoothstep(60.0, 120.0, d));
  }
#endif

  // Cast shadows from the sun, read from a depth map rendered from the light, drawn as cross-hatching
  // the way a pen artist shades a shadow. The lookup is nudged out along the normal to avoid acne.
  float shadow = 0.0;
#if QUALITY >= 1
  if (!sky && !held) {
    vec4 lp = uShadowMat * vec4(wpos + wn * (0.05 + 0.004 * d), 1.0);
    vec3 sp3 = lp.xyz / lp.w * 0.5 + 0.5;
    vec2 edgeD = abs(sp3.xy - 0.5) * 2.0;
    if (max(edgeD.x, edgeD.y) < 1.0 && sp3.z < 1.0) {
      vec3 nL = uShadowRot * wn;
      vec2 sg = clamp(nL.xy / max(nL.z, 0.3), -3.0, 3.0) * uShadowK;
      // the edge wobbles a little in world space, like a shadow outline drawn by hand
      vec2 wob2 = (vec2(vnoise(wpos.xz * 1.1 + wpos.y), vnoise(wpos.zx * 1.1 - wpos.y + 7.0)) - 0.5) * 3.0 * uShadowTexel;
#if QUALITY >= 2
      for (int i = 0; i < 4; i++) {
        vec2 so = vec2(i == 1 || i == 3 ? 1.0 : -1.0, i >= 2 ? 1.0 : -1.0) * 0.9 * uShadowTexel;
        shadow += shadowBilinear(sp3.xy + so + wob2, sp3.z, sp3.xy, sg);
      }
      shadow *= 0.25;
#else
      shadow = shadowBilinear(sp3.xy + wob2, sp3.z, sp3.xy, sg);
#endif
      shadow *= 1.0 - smoothstep(0.85, 1.0, max(edgeD.x, edgeD.y));
    }
  }
#endif

  float hatch = 0.0;
  if (!sky) {
    // contact shading deepens the hatch but never floods a recess with solid ink; a cast shadow
    // takes the surface down to two crossing layers of hatch
    float sh = min(shade, max(shade - 0.5 * ao, 0.3));
    sh = mix(sh, min(sh, 0.38), shadow);
#if QUALITY >= 1
    hatch = mix(hatching(hp, sp, sh), hatching(hp, sp * 2.0, sh), lodBlend);
#else
    hatch = hatching(hp, lodBlend > 0.5 ? sp * 2.0 : sp, sh);
#endif
    if (shade < 0.0) hatch = 1.0;
    // marker only: the outer walls stay a plain wash, so the boundary reads calm
    if (uBallpoint < 0.5 && abs(floor((s.g + 0.5) / 8.0) - 2.0) < 0.5) hatch = 0.0;
  }
  // hatching right at your feet is drawn lighter so it never buries the HUD
  float fade = mix(1.0, 0.28, smoothstep(14.0, 110.0, d)) * mix(0.55, 1.0, smoothstep(2.0, 7.0, d));
  float fadeE = mix(1.0, 0.45, smoothstep(30.0, 220.0, dFront));

  // paper with grain; ballpoint adds the ruled lines and red margin below
  vec2 pp = gl_FragCoord.xy;
  // Only a fine paper tooth stays fixed to the screen, sized against a 1080-line picture so a phone's
  // small render target doesn't blow it up. Coarser screen-fixed blotches (paper, wash or ink
  // weight) stay put while the world turns behind them and read as floaters, so there are none.
  vec2 pg = pp * (1.2 / sc);
  float grain = vnoise(pg * 0.8);
  vec3 paper = uPaper * (0.95 + 0.06 * grain);
  // ballpoint: lined notebook paper and a red margin, instead of the marker wash
  if (uBallpoint > 0.5) {
    float ls = uLineSpacing;
    float ly = mod(pp.y + ls * 0.5, ls);
    float rule = 1.0 - smoothstep(0.5 * sc, 1.7 * sc, abs(ly - ls * 0.5));
    paper = mix(paper, uRule, rule * uRuleAmt);
    float margin = 1.0 - smoothstep(0.9 * sc, 2.3 * sc, abs(pp.x - uRes.x * 0.07));
    paper = mix(paper, uMargin, margin * uMarginAmt);
  }

  // Colour: a felt-marker / watercolour wash under the ink. It is read a few pixels off the line art,
  // so the colour sits slightly out of register with the outlines like hand colouring, carries
  // grain from the paper, deepens in shadow and fades with distance.
  vec2 woff = vec2(2.5, -2.0) * sc * px;
  vec4 sw = texture2D(tScene, suv + woff);
  bool wsky = texture2D(tDepth, suv + woff).x >= 0.99999;
  float wId = floor((sw.g + 0.5) / 8.0);
  int wInk = int(mod(sw.g + 0.5, 8.0));
  vec3 washC = vec3(1.0); float wk = 0.0;
  if (wsky) {
    // the sky: a loose wash, deep blue overhead, warm and almost clear toward the horizon
    vec4 fr = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 dir = normalize(mat3(uInvView) * (fr.xyz / fr.w));
    float up = clamp(dir.y, 0.0, 1.0);
    float blot = vnoise(dir.xz / (dir.y + 0.35) * 2.2 + 3.0) * 0.6 + vnoise(dir.xz / (dir.y + 0.35) * 6.0) * 0.4;
    washC = mix(vec3(0.99, 0.88, 0.72), vec3(0.55, 0.74, 0.95), smoothstep(0.02, 0.55, up));
    wk = (0.35 + 0.4 * smoothstep(0.0, 0.6, up)) * (0.75 + 0.35 * blot);
  } else if (wId > 0.5) {
    washC = washColor(wId); wk = 0.85;
  } else if (wInk != 0) {
    washC = mix(vec3(1.0), inkColor(float(wInk)), 0.5); wk = 0.85;   // coloured-ink things: enemies, props, pickups
  } else {
    washC = vec3(0.86, 0.9, 1.0); wk = 0.55;                          // plain blue-ink things get a pale blue
  }
  if (!wsky) {
    wk *= 0.925 * 0.97;   // even wash: marker streaks and blotches fixed to the screen read as scratches and floaters
    float lit = clamp(sw.r, 0.0, 1.0);
    washC *= mix(0.86, 1.0, lit);
    washC = mix(washC, washC * washC * 0.9, shadow * 0.7);
    wk *= mix(1.0, 0.4, smoothstep(35.0, 170.0, d));
  }
  vec3 col = uBallpoint > 0.5 ? paper : paper * mix(vec3(1.0), washC, clamp(wk, 0.0, 1.0));
  col = mix(col, inkColor(s.g), hatch * 0.72 * fade);
  float ew = 0.925;
  col = mix(col, inkColor(inkId) * 0.92, clamp(edge * ew, 0.0, 1.0) * fadeE);

  // hurt: red scribble vignette; low hp: pulsing
  vec2 vc = (vUv - 0.5) * vec2(uAspect, 1.0);
  float vig = smoothstep(0.32, 0.9, length(vc));
  float scr = 0.55 + 0.45 * stripes(pp + wob * 8.0, normalize(vec2(1.0, 0.8)), 7.0 * sc, 2.2 * sc);
  float hurt = clamp(uHurt + uLowHp * (0.35 + 0.25 * sin(uTime * 6.0)), 0.0, 1.0);
  col = mix(col, uInks[1] * 0.9, hurt * vig * scr);
  // the page darkens a touch toward its corners, like paper under a desk lamp
  col *= 1.0 - 0.07 * smoothstep(0.45, 1.15, length(vc));
  col = mix(col, uPaper, uFlash);
  float lum = dot(col, vec3(0.3, 0.5, 0.2));
  col = mix(col, vec3(lum) * vec3(0.8, 0.86, 1.0), uSlow * 0.55);
  gl_FragColor = vec4(col, 1.0);
}`;

export class InkRenderer {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.autoClear = false;
    this.pixelRatio = 1; this.quality = 2;
    this._q = { last: 0, sum: 0, n: 0, settle: 0, skips: 0, win: 0, slowWin: 0, failed: -1, failedRounds: 0 };
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(80, 1, 0.08, 420);
    const depthTexture = new THREE.DepthTexture(2, 2); depthTexture.format = THREE.DepthFormat; depthTexture.type = THREE.FloatType;
    this.rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthTexture, depthBuffer: true, stencilBuffer: false, generateMipmaps: false });
    this.post = new THREE.ShaderMaterial({
      defines: { QUALITY: 2 },
      uniforms: {
        tScene: { value: this.rt.texture }, tDepth: { value: depthTexture }, uRes: { value: new THREE.Vector2(2, 2) }, uAspect: { value: 1 },
        uTime: { value: 0 }, uNear: { value: this.camera.near }, uFar: { value: this.camera.far }, uHurt: { value: 0 }, uFlash: { value: 0 }, uSlow: { value: 0 },
        uLowHp: { value: 0 }, uLineSpacing: { value: 60 }, uPaper: { value: new THREE.Vector3(0.965, 0.955, 0.905) }, uInks: { value: INK_COLORS },
        uInvProj: { value: new THREE.Matrix4() }, uInvView: { value: new THREE.Matrix4() },
        tShadow: { value: null }, uShadowMat: { value: new THREE.Matrix4() }, uShadowTexel: { value: 1 / 2048 }, uShadowRot: { value: new THREE.Matrix3() }, uShadowK: { value: 0 }, uWash: { value: WASH_COLORS },
        uRule: { value: new THREE.Vector3(0.58, 0.70, 0.92) }, uRuleAmt: { value: 0 },
        uMargin: { value: new THREE.Vector3(0.92, 0.48, 0.55) }, uMarginAmt: { value: 0 }, uBallpoint: { value: 0 },
      },
      vertexShader: postVert, fragmentShader: postFrag, depthTest: false, depthWrite: false,
    });
    // sun shadows: a depth map from an orthographic camera that follows the player
    this.shadowSize = 1024; this.shadowExtent = 70;
    const sdt = new THREE.DepthTexture(this.shadowSize, this.shadowSize); sdt.type = THREE.FloatType;
    this.shadowRT = new THREE.WebGLRenderTarget(this.shadowSize, this.shadowSize, { depthTexture: sdt, depthBuffer: true, stencilBuffer: false, generateMipmaps: false });
    const E = this.shadowExtent; this.shadowCam = new THREE.OrthographicCamera(-E, E, E, -E, 1, 420);
    // depth only; sky doodles (sun, clouds) never throw a shadow
    this.shadowMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
    this.shadowMat.defaultAttributeValues = { ...this.shadowMat.defaultAttributeValues, wash: [0] };
    this.shadowMat.onBeforeCompile = (sh) => {
      sh.vertexShader = 'attribute float wash;\nvarying float vWash;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvWash = wash;');
      sh.fragmentShader = 'varying float vWash;\n' + sh.fragmentShader.replace('void main() {', 'void main() {\nif (vWash > 11.5) discard;');
    };
    this.post.uniforms.tShadow.value = sdt; this.post.uniforms.uShadowTexel.value = 1 / this.shadowSize;
    this.post.uniforms.uShadowK.value = (2 * E) / (this.shadowCam.far - this.shadowCam.near);
    this._st = new THREE.Vector3();
    this.postScene = new THREE.Scene(); this.postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    // one oversized triangle instead of a two-triangle quad: a quad's diagonal seam shows up as a
    // faint line through the screen-space derivatives used by the hatching
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    const postMesh = new THREE.Mesh(tri, this.post); postMesh.frustumCulled = false;
    this.postScene.add(postMesh);
    this._clear = new THREE.Color(1, 0, 0);
    this._ld = new THREE.Vector3();
    this.light = LIGHT_WORLD.clone();
    this.setQualityMode(localStorage.getItem('doodle_quality') || 'auto');
    window.addEventListener('resize', () => this.resize());
  }
  // Uploads one source's page, ink table and sun. Ballpoint is sources/old (ruled paper,
  // foe slot = red pen). Marker is sources/new (wash, foe slot = near-black).
  applyTheme(preset) {
    const u = this.post.uniforms;
    const ball = preset.id === 'ballpoint';
    u.uBallpoint.value = ball ? 1 : 0;
    u.uPaper.value.set(preset.paper[0], preset.paper[1], preset.paper[2]);
    const inks = u.uInks.value;
    for (let i = 0; i < 7; i++) inks[i].set(preset.inks[i][0], preset.inks[i][1], preset.inks[i][2]);
    u.uRule.value.set(preset.rule[0], preset.rule[1], preset.rule[2]);
    u.uRuleAmt.value = preset.ruleAmt;
    u.uMargin.value.set(preset.margin[0], preset.margin[1], preset.margin[2]);
    u.uMarginAmt.value = preset.marginAmt;
    this.light.set(preset.light[0], preset.light[1], preset.light[2]).normalize();
    this._sR = null;
  }
  // Quality is a ladder of steps, worst first: each pairs an effects tier (0 low: no cast shadows or
  // contact shading, one hatch layer; 1 medium: lighter versions of both; 2 high: everything) with a
  // render scale. Auto walks the whole ladder, trading sharpness and effects in turn, and remembers where
  // it settled so the next visit starts there. It never goes below 0.7x: lower than that the ink lines
  // break up into visible blocks, which looks worse than losing shadows and hatching.
  // A fixed tier stays exactly as chosen.
  setQualityMode(mode) {
    if (!['auto', 'high', 'med', 'low'].includes(mode)) mode = 'auto';
    this.mode = mode; localStorage.setItem('doodle_quality', mode);
    // phones and tablets: few CSS pixels on a very dense screen, so they render above 1x or the
    // picture goes soft; start in the middle and let the between-round check move it either way
    const phone = matchMedia('(hover: none) and (pointer: coarse)').matches;
    const maxRatio = Math.min(window.devicePixelRatio || 1, phone ? 2 : 1.5) + 1e-3;
    if (mode === 'auto' && phone) {
      this.steps = [[0, 1], [1, 1.25], [1, 1.5], [2, 1.5], [2, 2]].filter(([, r]) => r <= maxRatio);
    } else if (mode === 'auto') {
      this.steps = [[0, 0.7], [1, 0.7], [1, 0.85], [2, 0.85], [2, 1]].filter(([, r]) => r <= maxRatio);
    } else {
      this.steps = [[{ low: 0, med: 1, high: 2 }[mode], phone ? Math.min(1.5, Math.max(1, maxRatio - 1e-3)) : 1]];
    }
    const key = (s) => s[0] + '@' + s[1], saved = mode === 'auto' ? localStorage.getItem('doodle_qstep') : null;
    let i = saved ? this.steps.findIndex((s) => key(s) === saved) : -1;
    // iPhones and iPads all have strong GPUs: they start one step higher, at high quality
    const apple = phone && /Apple/i.test(this.gpuName());
    if (i < 0) i = phone && mode === 'auto' ? Math.min(apple ? 3 : 2, this.steps.length - 1) : this.steps.reduce((best, s, j) => (s[1] <= 1 && (mode !== 'auto' || s[0] === 2) ? j : best), 0);
    this._q.win = 0; this._q.slowWin = 0; this._q.failedRounds = 0;
    this._setStep(i);
  }
  gpuName() {
    if (this._gpu == null) { try { const gl = this.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info'); this._gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)); } catch (e) { this._gpu = ''; } }
    return this._gpu;
  }
  _setStep(i) {
    this.step = i; const [q, r] = this.steps[i];
    if (q !== this.quality) { this.quality = q; this.post.defines.QUALITY = q; this.post.needsUpdate = true; }
    this.pixelRatio = r; this.resize();
    if (this.mode === 'auto') localStorage.setItem('doodle_qstep', q + '@' + r);
    this._q.settle = performance.now() + 1500; // a recompile or resize hitches; don't count it as a slow frame
  }
  resize() {
    const w = Math.max(2, window.innerWidth), h = Math.max(2, window.innerHeight);
    this.renderer.setPixelRatio(this.pixelRatio); this.renderer.setSize(w, h, false);
    const rw = Math.floor(w * this.pixelRatio), rh = Math.floor(h * this.pixelRatio);
    this.rt.setSize(rw, rh);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    const u = this.post.uniforms; u.uRes.value.set(rw, rh); u.uAspect.value = w / h; u.uLineSpacing.value = rh / 13.5;
  }
  // Loading a level, spawning a wave or coming back from a menu hitches for a moment; the caller says so
  // and those frames are left out, so a one-off stall can't push the picture down to a blurry scale.
  holdAdapt(ms = 3000) {
    const q = this._q; q.settle = Math.max(q.settle, performance.now() + ms); q.sum = 0; q.n = 0; q.skips = 0;
  }
  // Called once per frame. Never changes the picture: a resolution switch mid-fight is jarring, so this
  // only measures, in ~1s windows, how often the GPU couldn't keep up while a game was running. The
  // verdict is applied by roundStart(), before the next game begins.
  _adapt() {
    const q = this._q, now = performance.now(), dt = now - q.last; q.last = now;
    if (!this.playing || dt <= 0 || dt > 1000 || now < q.settle) { q.sum = 0; q.n = 0; q.skips = 0; return; } // menus, tab switch, loading hitch: not a measurement
    q.sum += Math.min(dt, 250); q.n++;
    if (q.sum < 1000) return;
    const n = q.n, avg = q.sum / n, skips = q.skips; q.sum = 0; q.n = 0; q.skips = 0;
    // Only the GPU falling behind (frames skipped because the last one was still drawing) is something a
    // lower render scale can fix. Slow frames with the GPU keeping up mean busy game logic, a browser
    // capping the frame rate (battery saver, background throttling) or a 30 Hz screen; dropping the
    // scale then only blurs the picture without making anything faster.
    const gpuBound = !this._canFence || skips * 5 >= n;
    q.win++; if (avg > 19 && gpuBound) q.slowWin++;
  }
  // A new game is about to start (not a resume or a revive). In auto mode, move one step on the ladder
  // based on the last game: down if the GPU was behind for a good share of it, up if it never was.
  // A step that was just left for being too slow isn't retried for the next few games.
  roundStart() {
    const q = this._q, w = q.win, slow = q.slowWin; q.win = 0; q.slowWin = 0;
    if (this.mode === 'auto' && w >= 8) {
      let lv = this.step;
      if (slow >= w * 0.25 && lv > 0) { q.failed = lv; q.failedRounds = 3; lv--; }
      else if (slow <= w * 0.05 && lv < this.steps.length - 1) {
        if (q.failedRounds > 0 && lv + 1 === q.failed) q.failedRounds--; else lv++;
      }
      if (lv !== this.step) this._setStep(lv);
    }
    this.holdAdapt();
  }
  render(time, fx = {}) {
    // Never let the GPU fall more than one frame behind. The browser happily queues several frames of
    // GPU work when the GPU is the bottleneck, and every queued frame is a frame of delay between moving
    // the mouse and seeing the view turn. So if the last frame hasn't finished drawing, skip this one:
    // the game still updates, and the next frame drawn shows the newest view. The gap between frames
    // actually drawn is also the honest measure of GPU speed that the quality ladder needs.
    const gl = this.renderer.getContext();
    if (this._fence) {
      if (gl.getSyncParameter(this._fence, gl.SYNC_STATUS) !== gl.SIGNALED && this._skipped < 6) { this._skipped++; this._q.skips++; return; }
      gl.deleteSync(this._fence); this._fence = null;
    }
    this._skipped = 0; this.drawn = (this.drawn || 0) + 1;
    this._adapt();
    shared.uTime.value = time;
    this.camera.updateMatrixWorld(); this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    shared.uLightDir.value.copy(this.light).transformDirection(this.camera.matrixWorldInverse);
    const r = this.renderer;
    // shadow pass: centre the light's box on the camera, snapped to whole shadow texels so edges don't crawl.
    // The snap is done along the light camera's own right/up axes: the sun is at a slant, so snapping
    // world x/z still moved the map by a fraction of a texel every step and shadow edges shimmered.
    const sc = this.shadowCam, tex = (2 * this.shadowExtent) / this.shadowSize, st = this._st.set(this.camera.position.x, 0, this.camera.position.z);
    if (!this._sR) {
      sc.position.copy(this.light); sc.lookAt(0, 0, 0); sc.updateMatrixWorld();
      this._sR = new THREE.Vector3().setFromMatrixColumn(sc.matrixWorld, 0); this._sU = new THREE.Vector3().setFromMatrixColumn(sc.matrixWorld, 1);
    }
    const a = Math.round(st.dot(this._sR) / tex) * tex, b = Math.round(st.dot(this._sU) / tex) * tex, c = st.dot(this.light);
    st.copy(this._sR).multiplyScalar(a).addScaledVector(this._sU, b).addScaledVector(this.light, c);
    sc.position.copy(st).addScaledVector(this.light, 200); sc.lookAt(st); sc.updateMatrixWorld(); sc.matrixWorldInverse.copy(sc.matrixWorld).invert();
    if (this.quality > 0) {
    const held = this.camera.children, was = held.map((c) => c.visible); for (const c of held) c.visible = false;
    this.scene.overrideMaterial = this.shadowMat;
    r.setRenderTarget(this.shadowRT); r.setClearColor(this._clear, 0); r.clear(true, true, false);
    r.render(this.scene, sc);
    this.scene.overrideMaterial = null; held.forEach((c, i) => { c.visible = was[i]; });
    this.post.uniforms.uShadowMat.value.multiplyMatrices(sc.projectionMatrix, sc.matrixWorldInverse);
    this.post.uniforms.uShadowRot.value.setFromMatrix4(sc.matrixWorldInverse);
    }
    r.setRenderTarget(this.rt); r.setClearColor(this._clear, 0); r.clear(true, true, false);
    r.render(this.scene, this.camera);
    r.setRenderTarget(null);
    const u = this.post.uniforms; u.uTime.value = time; u.uNear.value = this.camera.near; u.uFar.value = this.camera.far;
    u.uInvProj.value.copy(this.camera.projectionMatrixInverse); u.uInvView.value.copy(this.camera.matrixWorld);
    u.uHurt.value = fx.hurt || 0; u.uFlash.value = fx.flash || 0; u.uSlow.value = fx.slow || 0; u.uLowHp.value = fx.lowHp || 0;
    r.render(this.postScene, this.postCam);
    this._canFence = !!gl.fenceSync; if (gl.fenceSync) { this._fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush(); }
  }
}
