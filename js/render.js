/* ─────────────────────────────────────────────────────────────────────────────
   VESPER · render.js
   The frame pipeline: environment model (time of day → light), HDR scene
   pass, sun shadows, analytic water, bloom, god rays, tonemapping + grade.
   ───────────────────────────────────────────────────────────────────────────── */

import {
  v3, clamp, clamp01, lerp, smoothstep,
  m4perspective, m4lookAt, m4mul, m4inverse, m4identity,
  createProgram, uniforms, Mesh, createRenderTarget, deleteRenderTarget, resizeRenderTarget,
} from './engine.js';
import { WORLD } from './world.js';

/* ── environment model ──────────────────────────────────────────────────────
   Keyed by sun elevation e. Each stop is a full lighting palette.
   ──────────────────────────────────────────────────────────────────────────── */

const STOPS = [
  { e: 0.9,  sun: [2.45, 2.38, 2.18], zen: [0.19, 0.42, 0.80], hor: [0.62, 0.76, 0.92], ember: [0.55, 0.55, 0.62], fog: [0.66, 0.73, 0.86], sky: [0.38, 0.46, 0.60], gnd: [0.23, 0.18, 0.14], star: 0, aur: 0, night: 0, dusk: 0, cloud: [1.05, 1.0, 0.95] },
  { e: 0.25, sun: [2.30, 1.85, 1.38], zen: [0.21, 0.40, 0.74], hor: [0.88, 0.72, 0.60], ember: [0.95, 0.58, 0.34], fog: [0.76, 0.66, 0.63], sky: [0.35, 0.40, 0.55], gnd: [0.21, 0.16, 0.12], star: 0, aur: 0, night: 0, dusk: 0.2, cloud: [1.1, 0.95, 0.82] },
  { e: 0.0,  sun: [1.85, 0.78, 0.34], zen: [0.15, 0.22, 0.50], hor: [0.98, 0.50, 0.30], ember: [1.05, 0.44, 0.20], fog: [0.58, 0.42, 0.40], sky: [0.30, 0.28, 0.44], gnd: [0.16, 0.11, 0.10], star: 0.12, aur: 0, night: 0.08, dusk: 1.0, cloud: [1.15, 0.75, 0.55] },
  { e: -0.1, sun: [0.55, 0.22, 0.14], zen: [0.07, 0.10, 0.26], hor: [0.34, 0.20, 0.28], ember: [0.60, 0.24, 0.20], fog: [0.20, 0.17, 0.25], sky: [0.17, 0.19, 0.32], gnd: [0.10, 0.08, 0.09], star: 0.65, aur: 0.45, night: 0.55, dusk: 0.45, cloud: [0.45, 0.38, 0.45] },
  { e: -0.5, sun: [0.20, 0.30, 0.42], zen: [0.012, 0.018, 0.048], hor: [0.07, 0.095, 0.16], ember: [0.12, 0.10, 0.15], fog: [0.055, 0.075, 0.135], sky: [0.115, 0.15, 0.26], gnd: [0.055, 0.06, 0.075], star: 1, aur: 1, night: 1, dusk: 0, cloud: [0.22, 0.26, 0.37] },
];

function lerpArr(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}
function lerpNum(a, b, t) { return lerp(a, b, t); }

export function computeEnv(dayT, time, sunBoost = 1, weather = null) {
  /* art-directed elevation curve: long golden hours, deep nights.
     φ: 0 dawn horizon → 0.5 noon → 1 sunset horizon → 1.5 midnight → 2 */
  const phi = ((dayT % 2) + 2) % 2;
  const e = 0.62 * Math.sin((1 - phi) * Math.PI);
  const az = phi * Math.PI;
  const ce = Math.sqrt(Math.max(0, 1 - e * e));
  const sunDir = v3.norm([ce * Math.cos(az), e, ce * Math.sin(az) * 0.6]);

  const dust = weather ? weather.dust : 0;
  const rain = weather ? weather.rain : 0;
  const storm = weather ? weather.storm : 0;
  const windAngle = weather ? weather.windAngle : 0.7;
  const gloom = 1 - 0.36 * dust - 0.30 * rain;

  /* at deep night the "light" becomes planetshine from the ringed giant.
     During day the light elevation is floored a little above the visual sun
     so the low-sun moments keep rich, usable golden light on the land. */
  const planetDir = v3.norm([-0.52, 0.40, -0.62]);
  const nightMix = smoothstep(-0.06, -0.30, e);
  const litE = Math.max(e, 0.20);
  const litSun = v3.norm([sunDir[0], litE, sunDir[2]]);
  const lightDir = v3.norm(v3.lerp(litSun, planetDir, nightMix));

  // find bracketing stops
  let i0 = 0, i1 = 0;
  if (e >= STOPS[0].e) { i0 = i1 = 0; }
  else if (e <= STOPS[STOPS.length - 1].e) { i0 = i1 = STOPS.length - 1; }
  else {
    for (let i = 0; i < STOPS.length - 1; i++) {
      if (e <= STOPS[i].e && e >= STOPS[i + 1].e) { i0 = i; i1 = i + 1; break; }
    }
  }
  const A = STOPS[i0], B = STOPS[i1];
  const t = i0 === i1 ? 0 : clamp01((A.e - e) / (A.e - B.e));

    const env = {
      time, dayT: phi, sunDir, lightDir,
      gliderPos: null,          // filled by the renderer frame hook
      sunVisibility: 1,
    sunColor: lerpArr(A.sun, B.sun, t).map(x => x * sunBoost),
    sunTint: lerpArr(A.sun, B.sun, t).map(x => x * 0.55).map(x => x * (1 - dust * 0.4)),
    zenith: lerpArr(A.zen, B.zen, t).map(x => x * gloom),
    horizon: lerpArr(A.hor, B.hor, t).map(x => x * (0.75 + 0.25 * gloom)),
    ember: lerpArr(A.ember, B.ember, t).map(x => x * (1 - rain * 0.5) * (1 - dust * 0.45)),
    fogColor: lerpArr(A.fog, B.fog, t)
      .map((x, i) => lerp(lerp(x, [0.55, 0.42, 0.30][i], dust * 0.75), [0.42, 0.44, 0.48][i], rain * 0.45)),
    skyAmbient: lerpArr(A.sky, B.sky, t).map(x => x * gloom),
    groundAmbient: lerpArr(A.gnd, B.gnd, t).map(x => x * (0.8 + 0.2 * gloom)),
    cloudTint: lerpArr(A.cloud, B.cloud, t).map(x => x * (1 - 0.35 * rain) * (1 - 0.3 * dust)),
    starAlpha: lerpNum(A.star, B.star, t) * (1 - 0.85 * Math.max(dust, rain * 0.6)),
    auroraAlpha: lerpNum(A.aur, B.aur, t) * (1 - 0.9 * Math.max(dust, rain * 0.7)),
    night: lerpNum(A.night, B.night, t),
    dusk: lerpNum(A.dusk, B.dusk, t),
    planetGlow: 1 - 0.8 * Math.max(dust, rain * 0.7),
    cloudCover: clamp01(0.34 + 0.08 * Math.sin(time * 0.004) + rain * 0.55 + dust * 0.1 - 0.05),
    windDir: [Math.cos(windAngle), 0, Math.sin(windAngle)],
    fogDensity: 0.00023 + dust * 0.0022 + rain * 0.0011,
    storm, rain, dust,
  };
  return env;
}

/* ── shaders for the pipeline ─────────────────────────────────────────────── */

const QUAD_VS = /* glsl */`#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const DEPTH_COPY_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uDepth;
uniform float uNear;
uniform float uFar;
float linearize(float z){
  z = z * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}
void main(){
  float z = linearize(texture(uDepth, vUv).r);
  /* pack linear depth (0..far) into 24-bit RG-ish via RGBA */
  float d = clamp(z / uFar, 0.0, 1.0 - 1e-5);
  float x = d * 16777215.0;
  float r = floor(x / 65536.0) / 255.0;
  float g = floor(mod(x, 65536.0) / 256.0) / 255.0;
  float b = mod(x, 256.0) / 255.0;
  fragColor = vec4(r, g, b, 1.0);
}`;

const WATER_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform vec3 uCamPos;
uniform vec3 uLightDir;
uniform vec3 uSunColor;
uniform vec3 uSunTint;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uEmber;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uNight;
uniform float uDusk;
uniform float uTime;
uniform float uNear;
uniform float uFar;
uniform mat4 uInvViewProj;
uniform mat4 uViewProj;
uniform vec3 uSkyAmbient;
uniform vec3 uGroundAmbient;
uniform sampler2D uDepthPack;
uniform vec2 uWind;
uniform float uStorm;

uint uhash(uvec2 q){
  uint h = q.x * 374761393u + q.y * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return h ^ (h >> 16u);
}
float hash21(vec2 p){
  return float(uhash(uvec2(ivec2(floor(p))))) * (1.0 / 4294967295.0);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1,0)), c = hash21(i + vec2(0,1)), d = hash21(i + vec2(1,1));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
float fbm(vec2 p){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++){ s += vnoise(p) * a; p *= 2.07; a *= 0.5; }
  return s;
}
float linearize(float z){
  z = z * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}
float unpackDepth(vec4 c){
  float x = dot(c, vec4(65536.0, 256.0, 1.0, 0.0)) * 255.0;
  return x / 16777215.0 * uFar;
}

vec3 skyTint(vec3 dir){
  float up = clamp(dir.y, 0.0, 1.0);
  vec3 c = mix(uHorizon, uZenith, pow(up, 0.55));
  float toSun = dot(normalize(vec3(dir.x, 0.0, dir.z)), normalize(vec3(uLightDir.x, 0.0, uLightDir.z)));
  float bandH = exp(-abs(dir.y - 0.02) * 12.0);
  c += uEmber * bandH * (0.3 + 0.7 * clamp(toSun * 0.5 + 0.5, 0.0, 1.0)) * uDusk;
  c += uSunTint * pow(max(dot(dir, uLightDir), 0.0), 24.0) * 0.5;
  return c;
}

void main(){
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 f0 = uInvViewProj * vec4(ndc, 0.0, 1.0);
  vec4 f1 = uInvViewProj * vec4(ndc, 1.0, 1.0);
  vec3 ray = normalize(f1.xyz / f1.w - f0.xyz / f0.w);

  float waterLevel = -10.0;
  float wl = (waterLevel - uCamPos.y) / ray.y;

  /* read terrain depth (packed linear) */
  float terrainDist = unpackDepth(texture(uDepthPack, vUv));

  bool waterHit = ray.y < -0.0005 && wl > 0.0;
  /* never paint water where no opaque geometry exists: that is sky or a
     chunk that is still streaming in, not a lake */
  if (!waterHit || terrainDist > uFar * 0.985) {
    fragColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }

  float waterDist = wl;
  vec3 p = uCamPos + ray * wl;

  /* LOD: flatten waves with distance so they stop aliasing into static */
  float detail = exp(-waterDist * 0.0024);
  vec2 w = normalize(uWind + vec2(1e-5, 0.0));
  vec2 q = p.xz * 0.045;
  float e = 0.5;
  vec2 drift = w * uTime * 1.25;
  float chop = 1.0 + uStorm * 1.7;
  float h0 = fbm(q + drift) * 0.7 + fbm(q * 2.6 - drift * 1.9) * 0.3;
  float hx = fbm(q + drift + vec2(e, 0.0)) * 0.7 + fbm((q + vec2(e, 0.0)) * 2.6 - drift * 1.9) * 0.3;
  float hz = fbm(q + drift + vec2(0.0, e)) * 0.7 + fbm((q + vec2(0.0, e)) * 2.6 - drift * 1.9) * 0.3;
  /* long swell */
  float sw = p.x * w.x + p.z * w.y;
  float swellAmp = 0.05 + 0.06 * uStorm;
  float swellPh = sw * 0.012 - uTime * 1.1;
  float swellDx = cos(swellPh) * swellAmp * 0.012 * w.x;
  float swellDz = cos(swellPh) * swellAmp * 0.012 * w.y;
  vec3 nFlat = normalize(vec3(-swellDx, 1.0, -swellDz));
  vec3 nWave = normalize(vec3(-(hx - h0) * 1.15 / e * chop - swellDx, 1.0, -(hz - h0) * 1.15 / e * chop - swellDz));
  vec3 n = normalize(mix(nFlat, nWave, clamp(detail, 0.0, 1.0)));

  vec3 V = -ray;
  float fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(V, n), 0.0, 1.0), 5.0);
  vec3 refl = reflect(-V, n);
  refl.y = abs(refl.y);
  vec3 reflCol = skyTint(refl);

  /* sun glitter, faded with distance to kill fireflies */
  vec3 H = normalize(V + uLightDir);
  float ndh = clamp(dot(n, H), 0.0, 1.0);
  float spec = (pow(ndh, 240.0) * 1.35 + pow(ndh, 42.0) * 0.10) * detail * detail;

  vec3 deep = vec3(0.05, 0.13, 0.16) * (uSkyAmbient * 2.2 + uGroundAmbient);
  float thick = max(terrainDist - waterDist, 0.0);
  vec3 body = deep * (1.0 - exp(-thick * 0.28));

  vec3 col = mix(body, reflCol, fres);
  col += uSunColor * spec * (1.0 - uNight * 0.75);

  /* broken shoreline foam, gone by ~1.5 m depth, faded with distance */
  float shore = smoothstep(1.6, 0.0, thick);
  float foamN = fbm(p.xz * 0.55 + vec2(uTime * 0.13, uTime * 0.09)) * 0.6
              + fbm(p.xz * 1.9 - vec2(uTime * 0.21, uTime * 0.15)) * 0.4;
  float foam = shore * smoothstep(0.52, 0.80, foamN) * (0.55 + 0.45 * uStorm)
             * clamp(detail + 0.3, 0.0, 1.0);
  col = mix(col, vec3(0.82, 0.84, 0.84) * (1.0 - uNight * 0.55), clamp(foam, 0.0, 1.0) * 0.5);

  float alpha = clamp(fres * 1.4 + smoothstep(0.0, 1.6, thick) * 0.75, 0.0, 1.0);
  alpha *= smoothstep(0.02, 0.35, thick + 0.001) * 0.98 + 0.02;
  alpha = clamp(alpha, 0.0, 1.0) * (1.0 - smoothstep(0.985, 1.0, fres));

  float fog = 1.0 - exp(-waterDist * uFogDensity);
  col = mix(col, uFogColor, fog);

  float occl = smoothstep(-1.4, 1.8, terrainDist - waterDist);
  alpha *= occl;
  if (alpha <= 0.004) {
    fragColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  fragColor = vec4(col, alpha);
}`;

const WATER_VS = QUAD_VS;

const BRIGHT_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uScene;
uniform float uThreshold;
void main(){
  vec3 c = texture(uScene, vUv).rgb;
  float l = max(max(c.r, c.g), c.b);
  float k = max(l - uThreshold, 0.0);
  fragColor = vec4(c * (k / max(l, 1e-4)), 1.0);
}`;

const BLUR_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTex;
uniform vec2 uDir;   // texel-scaled direction
void main(){
  vec3 s = texture(uTex, vUv).rgb * 0.2270270270;
  vec2 o1 = uDir * 1.3846153846;
  vec2 o2 = uDir * 3.2307692308;
  s += (texture(uTex, vUv + o1).rgb + texture(uTex, vUv - o1).rgb) * 0.3162162162;
  s += (texture(uTex, vUv + o2).rgb + texture(uTex, vUv - o2).rgb) * 0.0702702703;
  fragColor = vec4(s, 1.0);
}`;

const RAY_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uScene;
uniform vec2 uSunPos;   // in uv space, may be offscreen
uniform float uIntensity;
uniform float uAspect;
void main(){
  vec2 dir = (uSunPos - vUv) * vec2(uAspect, 1.0);
  float len = length(dir);
  vec2 step = dir / 42.0;
  vec3 acc = vec3(0.0);
  float w = 1.0;
  float wsum = 0.0;
  vec2 uv = vUv;
  for (int i = 0; i < 42; i++){
    vec3 c = texture(uScene, clamp(uv, vec2(0.001), vec2(0.999))).rgb;
    float l = max(max(c.r, c.g), c.b);
    float k = max(l - 1.0, 0.0) / max(l, 1e-4);
    acc += c * k * w;
    wsum += w;
    w *= 0.955;
    uv += step;
  }
  acc /= wsum;
  acc *= uIntensity * clamp(1.0 - len * 0.55, 0.0, 1.0);
  fragColor = vec4(acc, 1.0);
}`;

const COMPOSITE_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uScene;
uniform sampler2D uBloom0;
uniform sampler2D uBloom1;
uniform sampler2D uBloom2;
uniform sampler2D uBloom3;
uniform sampler2D uRays;
uniform float uBloomStrength;
uniform float uRayStrength;
uniform float uVignette;
uniform float uGrain;
uniform float uTime;
uniform float uAberration;
uniform float uFlash;       // white flash 0..1 for beacon ignition
uniform vec2 uRes;
uniform float uWarm;        // grade warmth (dusk boost)
uniform float uFilter;      // photo filter: 0 natural 1 amber 2 nocturne 3 bleach 4 ember

vec3 aces(vec3 x){
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main(){
  vec2 uv = vUv;
  vec2 fromC = uv - 0.5;
  float r2 = dot(fromC, fromC) * 4.0;

  /* chromatic aberration grows to the edges */
  float ca = uAberration * r2;
  vec3 c;
  c.r = texture(uScene, uv + fromC * ca).r;
  c.g = texture(uScene, uv).g;
  c.b = texture(uScene, uv - fromC * ca).b;

  vec3 bloom = texture(uBloom0, uv).rgb * 0.5
             + texture(uBloom1, uv).rgb * 0.75
             + texture(uBloom2, uv).rgb * 0.85
             + texture(uBloom3, uv).rgb * 0.9;
  c += bloom * uBloomStrength;
  c += texture(uRays, uv).rgb * uRayStrength;

  /* grading: warm highlights, teal-lifted shadows */
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(c, c * vec3(1.07, 0.99, 0.90), uWarm * clamp(lum, 0.0, 1.0) * 0.7);
  c += vec3(-0.008, 0.004, 0.014) * (1.0 - clamp(lum, 0.0, 1.0));

  /* photo filters */
  if (uFilter > 0.5) {
    if (uFilter < 1.5) {            /* amber */
      c *= vec3(1.14, 1.0, 0.78);
      c = mix(vec3(dot(c, vec3(0.299, 0.587, 0.114))), c, 1.12);
    } else if (uFilter < 2.5) {     /* nocturne */
      c *= vec3(0.80, 0.94, 1.22);
      c = mix(vec3(dot(c, vec3(0.299, 0.587, 0.114))), c, 0.92);
    } else if (uFilter < 3.5) {     /* sunbleach */
      c = mix(c, vec3(0.78, 0.76, 0.72), 0.16);
      c = c / (c + 0.55) * 1.75;
    } else {                        /* ember */
      c *= vec3(1.18, 0.94, 0.80);
      c = (c - 0.5) * 1.18 + 0.5;
    }
  }

  c = aces(c * 0.80);

  /* vignette */
  float vig = 1.0 - uVignette * smoothstep(0.45, 1.45, length(fromC) * 1.7);
  c *= vig;

  /* grain */
  float g = fract(sin(dot(gl_FragCoord.xy + uTime * 61.7, vec2(12.9898, 78.233))) * 43758.5453);
  c += (g - 0.5) * uGrain;

  c = mix(c, vec3(1.0), uFlash);

  fragColor = vec4(c, 1.0);
}`;

/* ── water quad + Renderer ────────────────────────────────────────────────── */

export class Renderer {
  constructor(gl, canvas) {
    this.gl = gl;
    this.canvas = canvas;
    this.quad = new Mesh(gl);
    this.quad.attrib(0, 2);
    this.quad.upload(new Float32Array([-1, -1, 3, -1, -1, 3]));

    this.depthCopyProg = createProgram(gl, QUAD_VS, DEPTH_COPY_FS);
    this.dcu = uniforms(gl, this.depthCopyProg);
    this.waterProg = createProgram(gl, WATER_VS, WATER_FS);
    this.wu = uniforms(gl, this.waterProg);
    this.brightProg = createProgram(gl, QUAD_VS, BRIGHT_FS);
    this.bu = uniforms(gl, this.brightProg);
    this.blurProg = createProgram(gl, QUAD_VS, BLUR_FS);
    this.blurU = uniforms(gl, this.blurProg);
    this.rayProg = createProgram(gl, QUAD_VS, RAY_FS);
    this.ru = uniforms(gl, this.rayProg);
    this.compProg = createProgram(gl, QUAD_VS, COMPOSITE_FS);
    this.cu = uniforms(gl, this.compProg);

    this.hdr = gl.getExtension('EXT_color_buffer_float');
    const sceneFormat = this.hdr ? gl.RGBA16F : gl.RGBA8;
    this.sceneFormat = sceneFormat;
    this.rts = {};
    this.bloomRTs = [];
    this.rayRT = null;
    this.quality = 1.0;         // resolution scale
    this.bloomLevels = 4;
    this.frames = 0;
    this.fpsEMA = 60;
  }

  ensureTargets(w, h) {
    const gl = this.gl;
    const fmt = { internalFormat: this.sceneFormat, depth: true };
    const hw = Math.max(2, w >> 1), hh = Math.max(2, h >> 1);
    this.rts.scene = resizeRenderTarget(gl, this.rts.scene, w, h, fmt);
    this.rts.depthPack = resizeRenderTarget(gl, this.rts.depthPack, w, h, { internalFormat: gl.RGBA8 });
    this.rts.ray = resizeRenderTarget(gl, this.rts.ray, hw, hh, { internalFormat: this.sceneFormat });
    this.rts.rayB = resizeRenderTarget(gl, this.rts.rayB, hw, hh, { internalFormat: this.sceneFormat });
    while (this.bloomRTs.length < this.bloomLevels) {
      this.bloomRTs.push({ a: null, b: null, w: 0, h: 0 });
    }
    let bw = hw, bh = hh;
    for (let i = 0; i < this.bloomLevels; i++) {
      this.bloomRTs[i].a = resizeRenderTarget(gl, this.bloomRTs[i].a, bw, bh, { internalFormat: this.sceneFormat });
      this.bloomRTs[i].b = resizeRenderTarget(gl, this.bloomRTs[i].b, bw, bh, { internalFormat: this.sceneFormat });
      this.bloomRTs[i].w = bw; this.bloomRTs[i].h = bh;
      bw = Math.max(2, bw >> 1); bh = Math.max(2, bh >> 1);
    }
  }

  blit(prog, u, target, extra = null) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? target.w : this.canvas.width, target ? target.h : this.canvas.height);
    gl.useProgram(prog);
    extra && extra();
    this.quad.draw();
  }

  renderFrame(game) {
    const gl = this.gl;
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    const env = game.env;
    const cam = game.camera;

    /* sizing */
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.quality;
    const w = Math.max(2, Math.round(game.width * dpr));
    const h = Math.max(2, Math.round(game.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this.ensureTargets(w, h);

    const near = 0.5, far = 12000;
    const view = m4lookAt(cam.pos, cam.look, [0, 1, 0]);
    const proj = m4perspective(cam.fov, w / h, near, far);
    const viewProj = m4mul(proj, view);
    game.lastViewProj = viewProj;
    game.renderState = { view, proj, viewProj, near, far };
    game.entities.syncShip(game.ship, view);

    env.fogDensity = game.worldFogDensity;
    /* the manta's drop-shadow needs its position + sun factor */
    env.gliderPos = game.ship ? game.ship.pos : cam.pos;
    env.sunVisibility = clamp01(env.lightDir[1] * 7.0) * (1 - (game.eclipseDark || 0) * 0.9);
    env.shadowExtent = game.shadowExtent;
    env.storm = game.weather ? game.weather.storm : 0;

    /* ── shadow pass ── */
    this.terrain.computeLightMatrix(env.lightDir, cam.pos, game.shadowExtent);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.terrain.shadowFbo);
    gl.viewport(0, 0, this.terrain.shadowMapSize, this.terrain.shadowMapSize);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    this.terrain.renderShadow();
    game.entities.renderShadowPass(this.terrain, gl, view, proj);
    if (game.debugShadow) {
      const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      console.log('[shadow] status', st === gl.FRAMEBUFFER_COMPLETE ? 'COMPLETE' : 'INCOMPLETE(' + st + ')',
        'err', gl.getError(), 'chunks', this.terrain.drawList.length,
        'lvp', [...this.terrain.lightViewProj].slice(0, 4).map(x => x.toFixed(3)).join(','),
        [...this.terrain.lightViewProj].slice(12, 16).map(x => x.toFixed(2)).join(','));
      const lp = this.terrain.lightViewProj;
      const probe = m4mul(lp, [cam.pos[0], cam.pos[1] - 20, cam.pos[2], 1]);
      console.log('[shadow] probe ndc', (probe[0] / probe[3]).toFixed(3), (probe[1] / probe[3]).toFixed(3), (probe[2] / probe[3]).toFixed(3), 'w', probe[3].toFixed(2));
    }

    /* ── scene pass ── */
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.rts.scene.fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);

    const fullEnv = { ...env, viewProj, camPos: cam.pos };

    /* sky: no depth write */
    gl.depthMask(false);
    this.sky.draw(fullEnv);
    gl.depthMask(true);

    this.terrain.draw(fullEnv);

    /* opaque entities (glider, beacons, birds, rocks, crystals) */
    game.entities.drawOpaque(env, view, proj, viewProj, cam, this);

    /* depth pack copy (for water + gameplay readbacks) */
    this.blit(this.depthCopyProg, this.dcu, this.rts.depthPack, () => {
      gl.uniform1i(this.dcu.uDepth, 0);
      gl.uniform1f(this.dcu.uNear, near);
      gl.uniform1f(this.dcu.uFar, far);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.rts.scene.depthTex);
    });

    /* ── water (reads depthPack, writes into scene) ── */
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.rts.scene.fbo);
    gl.viewport(0, 0, w, h);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.useProgram(this.waterProg);
    gl.uniform3fv(this.wu.uCamPos, cam.pos);
    gl.uniform3fv(this.wu.uLightDir, env.lightDir);
    gl.uniform3fv(this.wu.uSunColor, env.sunColor);
    gl.uniform3fv(this.wu.uSunTint, env.sunTint);
    gl.uniform3fv(this.wu.uZenith, env.zenith);
    gl.uniform3fv(this.wu.uHorizon, env.horizon);
    gl.uniform3fv(this.wu.uEmber, env.ember);
    gl.uniform3fv(this.wu.uFogColor, env.fogColor);
    gl.uniform1f(this.wu.uFogDensity, env.fogDensity);
    gl.uniform3fv(this.wu.uSkyAmbient, env.skyAmbient);
    gl.uniform3fv(this.wu.uGroundAmbient, env.groundAmbient);
    gl.uniform1f(this.wu.uNight, env.night);
    gl.uniform1f(this.wu.uDusk, env.dusk);
    gl.uniform1f(this.wu.uTime, env.time);
    gl.uniform1f(this.wu.uNear, near);
    gl.uniform1f(this.wu.uFar, far);
    gl.uniformMatrix4fv(this.wu.uInvViewProj, false, m4inverse(viewProj));
    gl.uniformMatrix4fv(this.wu.uViewProj, false, viewProj);
    gl.uniform2f(this.wu.uWind, env.windDir[0], env.windDir[2]);
    gl.uniform1f(this.wu.uStorm, env.storm || 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.rts.depthPack.tex);
    gl.uniform1i(this.wu.uDepthPack, 0);
    this.quad.draw();
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    /* additive entities (trails, shards, pillars, particles) */
    game.entities.drawAdditive(env, view, proj, viewProj, cam, this);

    /* ── post chain ── */
    if (game.raw) { this.rawView(); return; }
    if (game.debugShadow) { this.debugShadowView(game); return; }
    this.postProcess(env, game, view, proj, viewProj, w, h);
  }

  rawView() {
    const gl = this.gl;
    if (!this.copyProg) {
      this.copyProg = createProgram(gl, QUAD_VS, /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTex;
void main(){
  vec3 c = texture(uTex, vUv).rgb;
  fragColor = vec4(c * 0.35, 1.0);
}`);
      this.copyU = uniforms(gl, this.copyProg);
    }
    this.blit(this.copyProg, this.copyU, null, () => {
      gl.uniform1i(this.copyU.uTex, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.rts.scene.tex);
    });
  }

  debugShadowView(game) {
    const gl = this.gl;
    /* variant A: draw the terrain with the depth program straight to screen
       (no depth test) — proves the program+geometry rasterize */
    if (game.debugShadowRaw) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.clearColor(0, 0, 0.1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.terrain.depthProg);
      gl.uniformMatrix4fv(this.terrain.du.uLightViewProj, false, game.lastViewProj || this.terrain.lightViewProj);
      let n0 = 0;
      for (const n of this.terrain.drawList) {
        if (!n.mesh) continue;
        gl.uniform2f(this.terrain.du.uWorldOffset, n.minX, n.minZ);
        gl.uniform1f(this.terrain.du.uSpacing, n.spacing);
        n.mesh.draw();
        n0++;
      }
      console.log('[rawdbg] drew', n0, 'chunks, err', gl.getError(),
        'prog?', gl.getParameter(gl.CURRENT_PROGRAM) === this.terrain.depthProg);
      return;
    }
    /* raw depth → grayscale fullscreen */
    if (!this.dsvProg) {
      this.dsvProg = createProgram(this.gl, QUAD_VS, /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uDepth;
void main(){
  float d = texture(uDepth, vUv).r;
  fragColor = vec4(vec3(d * 2.0), 1.0);
}`);
      this.dsvu = uniforms(this.gl, this.dsvProg);
    }
    this.blit(this.dsvProg, this.dsvu, null, () => {
      gl.uniform1i(this.dsvu.uDepth, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.terrain.shadowTex);
    });
  }

  postProcess(env, game, view, proj, viewProj, w, h) {
    const gl = this.gl;

    /* bright pass → bloom0 */
    this.blit(this.brightProg, this.bu, this.bloomRTs[0].a, () => {
      gl.uniform1i(this.bu.uScene, 0);
      gl.uniform1f(this.bu.uThreshold, 1.12);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.rts.scene.tex);
    });
    /* blur bloom0 A→B→A */
    this.blurChain(this.bloomRTs[0]);

    /* downsample chain */
    for (let i = 1; i < this.bloomLevels; i++) {
      const prev = this.bloomRTs[i - 1];
      this.blit(this.brightProg, this.bu, this.bloomRTs[i].a, () => {
        gl.uniform1i(this.bu.uScene, 0);
        gl.uniform1f(this.bu.uThreshold, 0.0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, prev.a.tex);
      });
      this.blurChain(this.bloomRTs[i]);
    }

    /* god rays from scene */
    const s = v3.mad(game.camera.pos, env.sunDir, 6000);
    const sunNDC = m4mul(viewProj, [s[0], s[1], s[2], 1]);
    let sunUv = [0.5, 1.5], raysIntensity = 0;
    if (sunNDC[3] > 0) {
      sunUv = [sunNDC[0] / sunNDC[3] * 0.5 + 0.5, sunNDC[1] / sunNDC[3] * 0.5 + 0.5];
      const onScreen = sunUv[0] > -0.4 && sunUv[0] < 1.4 && sunUv[1] > -0.2 && sunUv[1] < 1.4;
      const elevFade = clamp01((env.sunDir[1] + 0.06) * 5.0);
      raysIntensity = onScreen ? 0.85 * elevFade * (1 - env.night * 0.85) : 0;
    }
    this.blit(this.rayProg, this.ru, this.rts.ray, () => {
      gl.uniform1i(this.ru.uScene, 0);
      gl.uniform2f(this.ru.uSunPos, sunUv[0], sunUv[1]);
      gl.uniform1f(this.ru.uIntensity, raysIntensity);
      gl.uniform1f(this.ru.uAspect, w / h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.rts.scene.tex);
    });

    /* soften god rays */
    this.blurPair(this.rts.ray, this.rts.rayB);

    /* composite to screen */
    this.blit(this.compProg, this.cu, null, () => {
      const bind = (name, tex, unit) => {
        gl.uniform1i(this.cu[name], unit);
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
      };
      bind('uScene', this.rts.scene.tex, 0);
      bind('uBloom0', this.bloomRTs[0].a.tex, 1);
      bind('uBloom1', this.bloomRTs[1].a.tex, 2);
      bind('uBloom2', this.bloomRTs[2].a.tex, 3);
      bind('uBloom3', this.bloomRTs[3].a.tex, 4);
      bind('uRays', this.rts.ray.tex, 5);
      gl.uniform1f(this.cu.uBloomStrength, 0.42);
      gl.uniform1f(this.cu.uRayStrength, 0.30);
      gl.uniform1f(this.cu.uVignette, 0.42);
      gl.uniform1f(this.cu.uGrain, 0.028);
      gl.uniform1f(this.cu.uTime, env.time);
      gl.uniform1f(this.cu.uAberration, 0.0035);
      gl.uniform1f(this.cu.uFlash, game.flash);
      gl.uniform2f(this.cu.uRes, w, h);
      gl.uniform1f(this.cu.uWarm, 0.35 + 0.65 * env.dusk);
      gl.uniform1f(this.cu.uFilter, game.photoFilter || 0);
    });
  }

  blurPair(a, b) {
    const gl = this.gl;
    /* H: a→b, V: b→a (b holds blurred, but composite reads a) */
    this.blit(this.blurProg, this.blurU, b, () => {
      gl.uniform1i(this.blurU.uTex, 0);
      gl.uniform2f(this.blurU.uDir, 2.2 / a.w, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, a.tex);
    });
    this.blit(this.blurProg, this.blurU, a, () => {
      gl.uniform1i(this.blurU.uTex, 0);
      gl.uniform2f(this.blurU.uDir, 0, 2.2 / b.h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, b.tex);
    });
  }

  blurChain(rt) {
    const gl = this.gl;
    const blur = (src, dst, dirx, diry) => {
      this.blit(this.blurProg, this.blurU, dst, () => {
        gl.uniform1i(this.blurU.uTex, 0);
        gl.uniform2f(this.blurU.uDir, dirx / src.w, diry / src.h);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
      });
    };
    blur(rt.a, rt.b, 1, 0);
    blur(rt.b, rt.a, 0, 1);
  }

  /* NOTE: terrain + sky handles injected by game at boot */
  attach(terrain, sky) {
    this.terrain = terrain;
    this.sky = sky;
  }
}
