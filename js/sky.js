/* ─────────────────────────────────────────────────────────────────────────────
   VESPER · sky.js
   The heavens: analytic atmosphere, sun, a banded ringed giant, stars,
   high clouds and night aurora — one fullscreen shader, zero assets.
   ───────────────────────────────────────────────────────────────────────────── */

import { createProgram, uniforms, Mesh, m4inverse } from './engine.js';

const SKY_VS = /* glsl */`#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
uniform mat4 uInvViewProj;
out vec3 vRay;
void main(){
  vec4 far0 = uInvViewProj * vec4(aPos, 0.99, 1.0);
  vec4 far1 = uInvViewProj * vec4(aPos, 1.0, 1.0);
  vRay = normalize(far1.xyz / far1.w - far0.xyz / far0.w);
  gl_Position = vec4(aPos, 0.99999, 1.0);
}`;

const SKY_FS = /* glsl */`#version 300 es
precision highp float;
in vec3 vRay;
out vec4 fragColor;

uniform vec3 uCamPos;
uniform vec3 uSunDir;        // normalized, toward sun
uniform vec3 uSunTint;       // colour of sun glow
uniform float uNight;        // 0 day .. 1 night
uniform float uDusk;         // 1 near horizon moments
uniform float uTime;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uEmber;         // horizon ember band colour
uniform float uStarAlpha;
uniform float uAuroraAlpha;
uniform float uPlanetGlow;
uniform vec3 uCloudTint;
uniform float uCloudCover;
uniform vec2 uWind;
uniform float uEclipse;

const float PI = 3.14159265;

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
  for (int i = 0; i < 5; i++){ s += vnoise(p) * a; p *= 2.03; a *= 0.5; }
  return s;
}

/* ── the ringed giant ─────────────────────────────────────────────────────── */
const vec3 PLANET_DIR = normalize(vec3(-0.52, 0.40, -0.62));
const float PLANET_R = 0.30;          // angular radius on the unit dome
const vec3 PLANET_AXIS = normalize(vec3(0.36, 0.80, 0.48));

vec3 planetBody(vec3 ray, float tSurf){
  vec3 pos = ray * tSurf;
  vec3 n = normalize(pos - PLANET_DIR);
  float lat = dot(n, PLANET_AXIS);
  float bandN = fbm(vec2(lat * 14.0, uTime * 0.004) + 31.7);
  /* discrete painted bands survive the palette step */
  float bands = floor((0.5 + 0.5 * sin(lat * 22.0 + bandN * 5.0)) * 4.0) / 4.0;
  vec3 surf = mix(vec3(0.94, 0.87, 0.72), vec3(0.40, 0.55, 0.56), bands);
  vec3 surf2 = mix(vec3(0.62, 0.66, 0.60), vec3(0.26, 0.36, 0.48), bands);
  surf = mix(surf, surf2, smoothstep(0.45, 0.95, abs(lat)));
  float nl = clamp(dot(n, uSunDir), 0.0, 1.0);
  float nightSide = smoothstep(0.0, -0.25, dot(n, uSunDir));
  vec3 lit = surf * (nl * 1.2 + 0.03) * mix(1.0, 0.45, uNight * 0.55);
  lit *= 1.0 - nightSide * 0.82;
  float term = smoothstep(-0.04, 0.05, nl);   // crisp terminator
  return mix(lit * 0.14, lit, term);
}

vec3 ringColour(vec3 ray, float tRing, float R, out float alpha){
  alpha = 0.0;
  vec3 h = ray * tRing;
  float r = length(h - PLANET_DIR);
  if (r < R * 1.25 || r > R * 2.35) return vec3(0.0);
  float rn = fbm(vec2(r * 14.0, 0.5) + 7.3);
  float bandPattern = 0.5 + 0.5 * sin(r * 34.0 + rn * 6.0);
  float gaps = smoothstep(0.25, 0.55, bandPattern)
             * smoothstep(R * 2.35, R * 2.05, r)
             * smoothstep(R * 1.25, R * 1.45, r);
  /* shadow where the planet blocks the sun for this part of the ring */
  vec3 rel = normalize(h - PLANET_DIR);
  float behind = smoothstep(0.05, 0.45, dot(rel, -uSunDir));
  float lit = mix(1.0, 0.22, behind * 0.9);
  vec3 ringCol = mix(vec3(0.82, 0.78, 0.65), vec3(0.56, 0.63, 0.68), bandPattern) * lit;
  ringCol *= mix(1.0, 0.52, uNight * 0.65);
  alpha = gaps;
  return ringCol * 1.35;
}

vec3 planetSystem(vec3 ray, out float coverage){
  float b = dot(ray, PLANET_DIR);
  float disc = b * b - (1.0 - PLANET_R * PLANET_R);
  float tSurf = (disc > 0.0 && b > 0.0) ? b - sqrt(disc) : -1.0;

  float ringA = 0.0;
  vec3 ringC = vec3(0.0);
  float d = dot(ray, PLANET_AXIS);
  if (abs(d) > 1e-4) {
    float t = dot(PLANET_DIR, PLANET_AXIS) / d;
    if (t > 0.0) {
      /* ring hidden where the planet body is in front of it */
      if (!(tSurf > 0.0 && t > tSurf)) {
        ringC = ringColour(ray, t, PLANET_R, ringA);
      }
    }
  }

  vec3 col = (tSurf > 0.0) ? planetBody(ray, tSurf) : vec3(0.0);
  if (ringA > 0.0) col = mix(col, ringC, ringA);
  coverage = (tSurf > 0.0 ? 1.0 : 0.0) * max(ringA, tSurf > 0.0 ? 1.0 : 0.0);
  coverage = max(coverage, ringA);
  return col;
}

/* ── stars ────────────────────────────────────────────────────────────────── */
vec3 stars(vec3 ray){
  vec3 col = vec3(0.0);
  if (uStarAlpha <= 0.001) return col;
  /* project onto octahedral-ish mapping to avoid poles clustering */
  vec3 d = normalize(ray);
  vec2 uv = d.xz / (1.0 + abs(d.y)) * 3.0;
  vec2 cell = floor(uv * 60.0);
  vec2 f = fract(uv * 60.0);
  float h = hash21(cell);
  vec2 starPos = vec2(hash21(cell + 7.1), hash21(cell + 3.7));
  float dist = length(f - starPos);
  float bright = smoothstep(0.08, 0.0, dist);
  bright *= pow(h, 6.0) * 3.0;
  /* twinkle */
  bright *= 0.7 + 0.3 * sin(uTime * (2.0 + h * 5.0) + h * 40.0);
  /* only above horizon-ish, denser near zenith */
  float horizonFade = smoothstep(-0.06, 0.15, d.y);
  /* a faint milky band */
  float band = fbm(uv * 2.0 + 3.0) * 0.5;
  vec3 tint = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.85, 0.7), hash21(cell + 11.0));
  col += tint * bright * horizonFade * uStarAlpha;
  col += vec3(0.5, 0.6, 0.8) * band * 0.012 * horizonFade * uStarAlpha;
  return col;
}

/* ── clouds ───────────────────────────────────────────────────────────────── */
vec4 clouds(vec3 ray, vec3 sunLight){
  if (ray.y < 0.015) return vec4(0.0);
  float H = 1500.0;
  float t = (H - uCamPos.y) / ray.y;
  if (t < 0.0) return vec4(0.0);
  vec2 uv = (uCamPos.xz + ray.xz * t) * 0.00055;
  uv += uWind * uTime * 0.002;
  float n = fbm(uv * 2.2);
  float n2 = fbm(uv * 5.1 + 9.0);
  float dens = smoothstep(1.0 - uCloudCover, 1.05 - uCloudCover + 0.35, n * 0.75 + n2 * 0.35);
  /* lighting: brighter toward sun, shaded base */
  float toward = 0.5 + 0.5 * dot(normalize(vec3(ray.x, 0.0, ray.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z)));
  vec3 base = uCloudTint * mix(0.35, 1.0, toward * 0.6 + 0.25);
  vec3 litc = mix(base, sunLight * 1.15, toward * toward * 0.5);
  litc = mix(litc, sunLight * 1.35, smoothstep(0.75, 1.0, dens) * 0.25);
  float alpha = dens * smoothstep(0.015, 0.09, ray.y) * 0.78;
  /* fade far */
  float dist = t * length(vec3(ray.x, 0.0, ray.z));
  alpha *= 1.0 - smoothstep(9000.0, 26000.0, dist);
  return vec4(litc, alpha);
}

/* ── aurora ───────────────────────────────────────────────────────────────── */
vec3 aurora(vec3 ray){
  if (uAuroraAlpha <= 0.001 || ray.y < 0.03) return vec3(0.0);
  vec3 col = vec3(0.0);
  /* march the curtain band between altitudes 600..1900 with bounded steps */
  float T1 = (1900.0 - uCamPos.y) / max(ray.y, 0.03);
  float T0 = (600.0 - uCamPos.y) / max(ray.y, 0.03);
  T0 = max(T0, 0.0);
  if (T1 <= T0) return col;
  const int STEPS = 20;
  float dt = min((T1 - T0) / float(STEPS), 90.0);
  float t = T0 + dt * 0.5;
  for (int i = 0; i < STEPS; i++){
    vec3 p = uCamPos + ray * t;
    vec2 q = p.xz * 0.0011 + vec2(uTime * 0.006, uTime * 0.0023);
    float curtain = fbm(q + vec2(0.0, p.y * 0.0009));
    float sheet = pow(max(0.0, sin(curtain * 9.0 + p.x * 0.00045 + uTime * 0.02)), 3.0);
    float alt = smoothstep(600.0, 1000.0, p.y) * (1.0 - smoothstep(1400.0, 1900.0, p.y));
    float d = sheet * alt;
    if (d > 0.001){
      float g = clamp((p.y - 600.0) / 1300.0, 0.0, 1.0);
      vec3 a = mix(vec3(0.05, 0.55, 0.35), vec3(0.25, 0.20, 0.65), g);
      a = mix(a, vec3(0.75, 0.25, 0.45), pow(sheet, 3.0) * 0.35);
      col += a * d * 0.0011 * dt;
    }
    t += dt;
  }
  col *= 1.0 - smoothstep(0.55, 0.05, ray.y) * 0.9;
  return col * uAuroraAlpha;
}

/* ── meteors ──────────────────────────────────────────────────────────────── */
/* one scheduled streak per 22-second window, placed by an integer hash */
vec3 meteor(vec3 ray){
  if (uStarAlpha <= 0.05 || ray.y < 0.02) return vec3(0.0);
  uint win = uint(floor(uTime / 22.0));
  float pick = float(uhash(uvec2(win * 3u + 7u, 1u))) * (1.0/4294967295.0);
  if (pick > 0.55) return vec3(0.0);
  float ha = float(uhash(uvec2(win * 5u + 1u, 2u))) * (1.0/4294967295.0);
  float hb = float(uhash(uvec2(win * 5u + 2u, 2u))) * (1.0/4294967295.0);
  float hc = float(uhash(uvec2(win * 5u + 3u, 2u))) * (1.0/4294967295.0);
  vec3 dirA = normalize(vec3(ha - 0.5, 0.25 + 0.55 * hb, hc - 0.5));
  float hd = float(uhash(uvec2(win * 5u + 4u, 3u))) * (1.0/4294967295.0);
  float he = float(uhash(uvec2(win * 5u + 5u, 3u))) * (1.0/4294967295.0);
  float hf = float(uhash(uvec2(win * 5u + 6u, 3u))) * (1.0/4294967295.0);
  vec3 dirB = normalize(dirA + vec3((hd - 0.5) * 0.6, -0.25 - 0.35 * he, (hf - 0.5) * 0.6));
  float mt = fract(uTime / 22.0);
  float span = 0.55 + 0.3 * float(uhash(uvec2(win * 7u + 1u, 4u))) * (1.0/4294967295.0);
  if (mt > span) return vec3(0.0);
  float t = mt / span;
  vec3 head = normalize(mix(dirA, dirB, t));
  vec3 tail = normalize(mix(dirA, dirB, max(t - 0.25, 0.0)));
  float dHead = length(ray - head * dot(ray, head));
  float dTail = length(ray - tail * dot(ray, tail));
  float dSeg = min(dHead, dTail);
  float streak = smoothstep(0.016, 0.0, dSeg);
  float fade = smoothstep(0.0, 0.1, t) * (1.0 - smoothstep(0.8, 1.0, t));
  vec3 c = vec3(1.0, 0.95, 0.85) * (streak * 2.2) * fade;
  return c;
}

void main(){
  vec3 ray = normalize(vRay);
  float sunH = uSunDir.y;

  /* base gradient */
  float up = clamp(ray.y, -0.12, 1.0);
  float horiz = pow(1.0 - clamp(ray.y, 0.0, 1.0), 3.0);
  vec3 col = mix(uZenith, uHorizon, horiz * 0.85);

  /* ember band at the sun side horizon */
  float toSun = dot(normalize(vec3(ray.x, 0.0, ray.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z)));
  float sunSide = clamp(toSun * 0.5 + 0.5, 0.0, 1.0);
  float bandH = exp(-abs(ray.y - 0.02) * 14.0);
  col += uEmber * bandH * (0.35 + 0.65 * sunSide) * uDusk;

  /* mie glow around the sun */
  float sdot = clamp(dot(ray, uSunDir), -1.0, 1.0);
  float glow = pow(max(sdot, 0.0), 14.0) * 0.55 + pow(max(sdot, 0.0), 90.0) * 0.9;
  col += uSunTint * glow * (1.0 - uNight * 0.55) * (1.0 - uEclipse * 0.9);

  /* stars + planet behind atmosphere haze near horizon */
  float planetCov = 0.0;
  vec3 planet = planetSystem(ray, planetCov);
  float haze = 1.0 - exp(-max(ray.y, 0.0) * 2.2);   // planets fade into horizon haze
  planet *= haze * uPlanetGlow;
  col += stars(ray) * haze * (1.0 - planetCov);
  col += planet;

  /* clouds composite */
  vec4 cl = clouds(ray, uSunTint);
  col = mix(col, cl.rgb, cl.a);

  /* sun disc on top (dimmed by cloud) */
  float sunDisc = smoothstep(0.9993, 0.99975, sdot);
  vec3 sunCol = uSunTint * 2.4 + vec3(1.0, 0.9, 0.8);
  col += sunCol * sunDisc * (1.0 - cl.a * 0.85) * (1.0 - uNight * 0.9) * (1.0 - uEclipse);

  /* eclipse: a dark disc swallows the sun with a thin ring of fire */
  if (uEclipse > 0.002) {
    float rAng = acos(clamp(sdot, -1.0, 1.0));
    float shadowR = 0.012 + uEclipse * 0.055;
    float disc = 1.0 - smoothstep(shadowR - 0.004, shadowR + 0.004, rAng);
    col = mix(col, vec3(0.006, 0.008, 0.016), disc * clamp(uEclipse * 1.5, 0.0, 1.0));
    float rim = exp(-pow(abs(rAng - shadowR) * 200.0, 2.0));
    col += vec3(1.4, 0.82, 0.42) * rim * uEclipse * 1.2;
  }

  /* aurora over everything */
  col += aurora(ray);

  /* and the occasional falling star */
  col += meteor(ray) * haze;

  /* gentle dither to kill banding */
  col += (hash21(gl_FragCoord.xy + fract(uTime) * 61.7) - 0.5) * (1.5 / 255.0);

  fragColor = vec4(col, 1.0);
}`;

export class Sky {
  constructor(gl) {
    this.gl = gl;
    this.prog = createProgram(gl, SKY_VS, SKY_FS);
    this.u = uniforms(gl, this.prog);
    this.mesh = new Mesh(gl);
    this.mesh.attrib(0, 2);
    this.mesh.upload(new Float32Array([-1, -1, 3, -1, -1, 3]));
  }

  draw(env) {
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u.uInvViewProj, false, m4inverse(env.viewProj));
    gl.uniform3fv(this.u.uCamPos, env.camPos);
    gl.uniform3fv(this.u.uSunDir, env.sunDir);
    gl.uniform3fv(this.u.uSunTint, env.sunTint);
    gl.uniform1f(this.u.uNight, env.night);
    gl.uniform1f(this.u.uDusk, env.dusk);
    gl.uniform1f(this.u.uTime, env.time);
    gl.uniform3fv(this.u.uZenith, env.zenith);
    gl.uniform3fv(this.u.uHorizon, env.horizon);
    gl.uniform3fv(this.u.uEmber, env.ember);
    gl.uniform1f(this.u.uStarAlpha, env.starAlpha);
    gl.uniform1f(this.u.uAuroraAlpha, env.auroraAlpha);
    gl.uniform1f(this.u.uPlanetGlow, env.planetGlow);
    gl.uniform3fv(this.u.uCloudTint, env.cloudTint);
    gl.uniform1f(this.u.uCloudCover, env.cloudCover);
    gl.uniform2f(this.u.uWind, env.windDir[0], env.windDir[2]);
    gl.uniform1f(this.u.uEclipse, env.eclipse || 0);
    this.mesh.draw();
  }
}
