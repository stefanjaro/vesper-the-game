/* ─────────────────────────────────────────────────────────────────────────────
   VESPER · entities.js
   Everything that lives and moves: the sky-manta you fly, its wingtip
   trails, flocks of gliders, light shards, ancient beacons, crystals,
   thermals and particles.
   ───────────────────────────────────────────────────────────────────────────── */

import {
  v3, clamp, clamp01, lerp, smoothstep,
  createProgram, uniforms, Mesh, mulberry32,
} from './engine.js';
import { terrainHeight, WORLD } from './world.js';

/* ── shared GLSL chunks ───────────────────────────────────────────────────── */

const LIGHT_CHUNK = /* glsl */`
uniform vec3 uLightDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
uniform vec3 uGroundAmbient;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uCamPos;
uniform float uNight;
vec3 applyLight(vec3 albedo, vec3 n, vec3 p){
  float ndl = clamp(dot(n, uLightDir), 0.0, 1.0);
  ndl = floor(ndl * 3.0 + 0.5) / 3.0;      // flat cel bands
  vec3 amb = mix(uGroundAmbient, uSkyAmbient, clamp(n.y * 0.5 + 0.5, 0.0, 1.0)) * 1.35;
  vec3 lit = albedo * (uSunColor * ndl + amb);
  float fog = 1.0 - exp(-length(p - uCamPos) * uFogDensity);
  return mix(lit, uFogColor, fog);
}`;

/* instancing helper: shares a geometry VAO and adds an instance buffer */
function attachInstances(gl, mesh, buffer, slots, divisor = 1) {
  gl.bindVertexArray(mesh.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  let offset = 0;
  for (const s of slots) {
    gl.enableVertexAttribArray(s.loc);
    gl.vertexAttribPointer(s.loc, s.size, gl.FLOAT, false, s.stride, offset);
    gl.vertexAttribDivisor(s.loc, divisor);
    offset += s.size * 4;
  }
  gl.bindVertexArray(null);
}

/* ── the sky-manta: sleek low-poly glider with clean analytic normals ─────── */

function buildManta() {
  /* vertices: nose, wingtips, tail corners, keel, spine */
  const V = [
    [0, 0.00, -2.3],      // 0 nose
    [-2.6, 0.42, 1.0],    // 1 left wingtip
    [2.6, 0.42, 1.0],     // 2 right wingtip
    [0, 0.18, 1.9],       // 3 tail top
    [-0.62, -0.12, 1.75], // 4 left tail
    [0.62, -0.12, 1.75],  // 5 right tail
    [0, -0.42, 0.55],     // 6 keel bottom
    [-0.8, 0.10, -0.9],   // 7 left shoulder
    [0.8, 0.10, -0.9],    // 8 right shoulder
  ];
  const F = [
    // top surface
    [0, 7, 1], [0, 2, 8], [7, 3, 1], [8, 2, 3], [7, 8, 3],
    // underside
    [0, 1, 6], [0, 6, 2], [1, 4, 6], [2, 6, 5], [4, 5, 6], [1, 3, 4], [2, 5, 3],
  ];
  const verts = [];
  for (const [a, b, c] of F) {
    const p1 = V[a], p2 = V[b], p3 = V[c];
    const n = v3.cross(v3.sub(p2, p1), v3.sub(p3, p1));
    const l = v3.len(n) || 1;
    const nn = [n[0] / l, n[1] / l, n[2] / l];
    for (const i of [a, b, c]) verts.push(...V[i], ...nn);
  }
  const idx = new Uint32Array(verts.length / 6);
  for (let i = 0; i < idx.length; i++) idx[i] = i;
  return { verts: new Float32Array(verts), idx };
}

/* ── glider shader ────────────────────────────────────────────────────────── */

/* wingtip deforms onto the flat delta: bend wingtip points, keep body rigid */
const GLIDER_VS = /* glsl */`#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform float uTime;
uniform float uFlap;
out vec3 vWorld;
out vec3 vNormal;
void main(){
  vec3 p = aPos;
  float spanF = clamp(abs(p.x) / 2.6, 0.0, 1.0);
  float bend = sin(uTime * 2.6 - spanF * 1.2) * spanF * spanF * 0.65 * uFlap;
  p.y += bend;
  vec4 w = uModel * vec4(p, 1.0);
  vWorld = w.xyz;
  vec3 n = aNormal;
  n.y += spanF * cos(uTime * 2.6 - spanF * 1.2) * 0.55 * uFlap;
  vNormal = n;
  gl_Position = uViewProj * w;
}`;

const GLIDER_FS = /* glsl */`#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
uniform vec3 uGlowColor;
uniform float uGlowAmt;
out vec4 fragColor;
${LIGHT_CHUNK}
void main(){
  vec3 n = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorld);
  vec3 albedoTop = vec3(0.20, 0.18, 0.25);
  vec3 albedoBel = vec3(0.58, 0.50, 0.40);
  float bel = clamp(-n.y, 0.0, 1.0);
  vec3 albedo = mix(albedoTop, albedoBel, bel * 0.85);
  float rim = pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 2.5);
  vec3 lit = applyLight(albedo, n, vWorld);
  lit += uSunColor * rim * 0.35;
  lit += uGlowColor * uGlowAmt;
  fragColor = vec4(lit, 1.0);
}`;

/* ── sky-whales: slow leviathans that graze the high air ──────────────────── */

function buildWhale() {
  const rings = 11, seg = 12;
  const prof = [0.05, 0.18, 0.34, 0.52, 0.72, 0.90, 1.0, 0.97, 0.84, 0.6, 0.3];
  const verts = [], idx = [];
  const vpush = (x, y, z, nx, ny, nz) => verts.push(x, y, z, nx, ny, nz);
  for (let r = 0; r < rings; r++) {
    const z = (r / (rings - 1)) * 3.4 - 1.7;      // -1.7 tail … +1.7 nose
    for (let sIdx = 0; sIdx < seg; sIdx++) {
      const a = (sIdx / seg) * Math.PI * 2;
      const rIdx = prof[r] * (0.9 + 0.18 * Math.sin(sIdx * 3.1 + r * 1.3));
      const x = Math.cos(a) * rIdx * 0.50;
      const y = Math.sin(a) * rIdx * 0.46 + 0.04;
      const nl = Math.hypot(x, y) || 1;
      vpush(x, y, z, x / nl, y / nl, 0);
    }
  }
  for (let r = 0; r < rings - 1; r++) {
    for (let sIdx = 0; sIdx < seg; sIdx++) {
      const s2 = (sIdx + 1) % seg;
      const a = r * seg + sIdx, b = r * seg + s2, c = (r + 1) * seg + sIdx, d = (r + 1) * seg + s2;
      idx.push(a, c, b, b, c, d);
    }
  }
  /* long pectoral fins, swept back and down */
  const fin = (sx) => {
    const base = verts.length / 6;
    vpush(sx * 0.42, -0.06, 0.45, 0, 1, 0);
    vpush(sx * 1.75, -0.30, -0.85, 0, 1, 0);
    vpush(sx * 0.46, -0.06, 0.85, 0, 1, 0);
    idx.push(base, base + 1, base + 2, base + 2, base + 1, base);
  };
  fin(1); fin(-1);
  /* tail fluke */
  const tb = verts.length / 6;
  vpush(0, 0, -1.6, 0, 1, 0);
  vpush(-1.05, 0, -2.25, 0, 1, 0);
  vpush(1.05, 0, -2.25, 0, 1, 0);
  idx.push(tb, tb + 1, tb + 2, tb + 2, tb + 1, tb);
  return { verts: new Float32Array(verts), idx: new Uint32Array(idx) };
}

const WHALE_VS = /* glsl */`#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform float uTime;
out vec3 vWorld;
out vec3 vNormal;
void main(){
  vec3 p = aPos;
  p.y += sin(uTime * 0.8 + p.z * 2.4) * 0.09 * (1.0 - abs(p.z));
  vec4 w = uModel * vec4(p, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(uModel[0].xyz, uModel[1].xyz, uModel[2].xyz) * aNormal);
  gl_Position = uViewProj * w;
}`;

const WHALE_FS = /* glsl */`#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
out vec4 fragColor;
${LIGHT_CHUNK}
void main(){
  vec3 n = normalize(vNormal);
  vec3 albedo = mix(vec3(0.09, 0.11, 0.18), vec3(0.50, 0.54, 0.56), clamp(-n.y * 0.6 + 0.5, 0.0, 1.0));
  vec3 lit = applyLight(albedo, n, vWorld);
  vec3 V = normalize(uCamPos - vWorld);
  lit += uSunColor * pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 3.0) * 0.22;
  fragColor = vec4(lit, 1.0);
}`;

/* ── trails (dynamic ribbons, billboarded around their own axis) ──────────── */

const TRAIL_VS = /* glsl */`#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aInfo;
uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform float uWidth;
out vec2 vInfo;
void main(){
  vInfo = aInfo;
  /* widen perpendicular to view, horizontal-ish */
  vec3 dir = aPos - uCamPos;
  vec3 side = normalize(cross(dir, vec3(0.0, 1.0, 0.0)) + vec3(1e-4));
  float sideF = aInfo.y;
  float w = uWidth * (1.0 - aInfo.x * 0.85);
  gl_Position = uViewProj * vec4(aPos + side * sideF * w, 1.0);
}`;

const TRAIL_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vInfo;
uniform vec3 uColor;
uniform float uFade;
out vec4 fragColor;
void main(){
  float a = 1.0 - vInfo.x;
  a *= a;
  float edge = 1.0 - abs(vInfo.y);
  vec3 c = uColor * (0.5 + a * 1.6) * (0.35 + 0.65 * edge);
  fragColor = vec4(c * a * uFade, 1.0);
}`;

/* ── birds (instanced) ────────────────────────────────────────────────────── */

const BIRD_VS = /* glsl */`#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aInst;
layout(location=2) in vec4 bInst;
uniform mat4 uViewProj;
uniform float uTime;
out vec3 vWorld;
out vec3 vNormal;
out float vGlint;
void main(){
  vec3 p = aPos;
  float flap = sin(uTime * 7.0 + bInst.x * 6.28);
  float spanF = clamp(abs(p.x), 0.0, 1.0);
  p.y += flap * spanF * 0.85;
  vGlint = clamp(flap * spanF, 0.0, 1.0);
  float ca = cos(aInst.w), sa = sin(aInst.w);
  p = vec3(p.x * ca - p.z * sa, p.y, p.x * sa + p.z * ca);
  vec3 world = aInst.xyz + p * bInst.y;
  vWorld = world;
  vNormal = normalize(vec3(flap * 0.4, 1.0, 0.25));
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

const BIRD_FS = /* glsl */`#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in float vGlint;
${LIGHT_CHUNK}
out vec4 fragColor;
void main(){
  vec3 albedo = vec3(0.17, 0.15, 0.19);
  vec3 lit = applyLight(albedo, normalize(vNormal), vWorld);
  lit += uSunColor * vGlint * 0.30;
  fragColor = vec4(lit, 1.0);
}`;

/* ── beacons ──────────────────────────────────────────────────────────────── */

function buildBeacon() {
  const verts = [], idx = [];
  const rings = [
    { y: 0, r: 3.4 }, { y: 5, r: 2.6 }, { y: 12, r: 2.0 }, { y: 19, r: 1.7 }, { y: 24, r: 2.4 }, { y: 27, r: 1.2 },
  ];
  const SEG = 6;
  const ringStart = [];
  for (const ring of rings) {
    ringStart.push(verts.length / 6);
    for (let s = 0; s < SEG; s++) {
      const a = (s / SEG) * Math.PI * 2 + 0.26;
      const r = ring.r * (0.92 + 0.16 * Math.sin(s * 12.9898 + ring.y * 3.7));
      verts.push(Math.cos(a) * r, ring.y, Math.sin(a) * r, 0, 1, 0);
    }
  }
  for (let ri = 0; ri < rings.length - 1; ri++) {
    for (let s = 0; s < SEG; s++) {
      const s2 = (s + 1) % SEG;
      const a = ringStart[ri] + s, b = ringStart[ri] + s2;
      const c = ringStart[ri + 1] + s, d = ringStart[ri + 1] + s2;
      idx.push(a, b, d, a, d, c);
    }
  }
  const top = verts.length / 6;
  verts.push(0, rings[rings.length - 1].y + 1.4, 0, 0, 1, 0);
  for (let s = 0; s < SEG; s++) {
    idx.push(ringStart[ringStart.length - 1] + s, ringStart[ringStart.length - 1] + (s + 1) % SEG, top);
  }
  return { verts: new Float32Array(verts), idx: new Uint32Array(idx) };
}

const BEACON_VS = /* glsl */`#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
uniform mat4 uViewProj;
uniform mat4 uModel;
out vec3 vWorld;
out vec3 vLocal;
void main(){
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vLocal = aPos;
  gl_Position = uViewProj * w;
}`;

const BEACON_FS = /* glsl */`#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vLocal;
uniform float uLit;
uniform float uTime;
${LIGHT_CHUNK}
out vec4 fragColor;
void main(){
  vec3 n = normalize(vec3(vLocal.x, 0.0, vLocal.z));
  vec3 stone = vec3(0.30, 0.27, 0.26) * (0.85 + 0.3 * sin(vLocal.y * 2.7));
  float ch = smoothstep(0.55, 0.75, sin(vLocal.y * 1.9 + 1.3) * 0.5 + 0.5);
  vec3 ember = vec3(1.5, 0.85, 0.35);
  float pulse = 0.75 + 0.25 * sin(uTime * 2.2);
  vec3 lit = applyLight(stone, n, vWorld);
  lit += ember * ch * uLit * pulse * 1.7;
  lit += ember * uLit * 0.20;
  fragColor = vec4(lit, 1.0);
}`;

/* ── lore stones: weathered monoliths with glyph light ────────────────────── */

function buildStone() {
  const H = 4.6, rB = 0.85, rT = 0.48;
  const B = [[rB, 0, rB], [-rB, 0, rB], [-rB, 0, -rB], [rB, 0, -rB]];
  const T = [[rT, H, rT], [-rT, H, rT], [-rT, H, -rT], [rT, H, -rT]];
  const verts = [];
  const tri = (p0, p1, p2, n) => {
    verts.push(p0[0], p0[1], p0[2], n[0], n[1], n[2]);
    verts.push(p1[0], p1[1], p1[2], n[0], n[1], n[2]);
    verts.push(p2[0], p2[1], p2[2], n[0], n[1], n[2]);
  };
  const quad = (p0, p1, p2, p3) => {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p3[0] - p0[0], vy = p3[1] - p0[1], vz = p3[2] - p0[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    tri(p0, p1, p2, [nx, ny, nz]);
    tri(p0, p2, p3, [nx, ny, nz]);
  };
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad(B[i], B[j], T[j], T[i]);
  }
  tri(T[0], T[1], T[2], [0, 1, 0]);
  tri(T[0], T[2], T[3], [0, 1, 0]);
  return { verts: new Float32Array(verts) };
}

const STONE_VS = /* glsl */`#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
uniform mat4 uViewProj;
uniform mat4 uModel;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vLocal;
void main(){
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(uModel[0].xyz, uModel[1].xyz, uModel[2].xyz) * aNormal);
  vLocal = aPos;
  gl_Position = uViewProj * w;
}`;

const STONE_FS = /* glsl */`#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec3 vLocal;
uniform float uGlow;
uniform float uTime;
out vec4 fragColor;
${LIGHT_CHUNK}
void main(){
  vec3 n = normalize(vNormal);
  vec3 stone = vec3(0.32, 0.29, 0.27) * (0.82 + 0.28 * sin(vLocal.y * 2.2 + vLocal.x * 3.0));
  float band = sin(vLocal.y * 7.0) * 0.5 + 0.5;
  float glyph = smoothstep(0.70, 0.92, band) * (0.55 + 0.45 * sin(vLocal.y * 23.0 + vLocal.x * 17.0));
  vec3 lit = applyLight(stone, n, vWorld);
  lit += vec3(0.45, 0.95, 0.78) * glyph * uGlow * (0.7 + 0.3 * sin(uTime * 2.0 + vLocal.y * 3.0));
  fragColor = vec4(lit, 1.0);
}`;

/* ── crystals (instanced spikes) ──────────────────────────────────────────── */

function buildCrystal() {
  const verts = [], idx = [];
  const SEG = 5;
  const H = 1.0, R = 0.22;
  const tip = 0;
  for (let s = 0; s < SEG; s++) {
    const a = (s / SEG) * Math.PI * 2;
    verts.push(Math.cos(a) * R, 0, Math.sin(a) * R, 0, 1, 0);
  }
  verts.push(0, H, 0, 0, 1, 0);
  verts.push(0, -0.2, 0, 0, 1, 0);
  const tipI = SEG, baseI = SEG + 1;
  for (let s = 0; s < SEG; s++) {
    const s2 = (s + 1) % SEG;
    idx.push(tipI, s, s2);
    idx.push(baseI, s2, s);
  }
  return { verts: new Float32Array(verts), idx: new Uint32Array(idx) };
}

const CRYSTAL_VS = /* glsl */`#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aInst;
layout(location=2) in vec4 bInst;
uniform mat4 uViewProj;
out vec3 vWorld;
out vec3 vLocal;
out float vGlow;
void main(){
  float c = cos(bInst.x), s = sin(bInst.x);
  vec3 p = vec3(aPos.x * c - aPos.z * s, aPos.y, aPos.x * s + aPos.z * c) * aInst.w;
  vec3 world = aInst.xyz + p;
  vWorld = world;
  vLocal = aPos * aInst.w;
  vGlow = bInst.y;
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

const CRYSTAL_FS = /* glsl */`#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vLocal;
in float vGlow;
${LIGHT_CHUNK}
out vec4 fragColor;
void main(){
  vec3 n = normalize(vec3(vLocal.x, max(vLocal.y, 0.3) * 0.6, vLocal.z));
  vec3 stone = vec3(0.22, 0.28, 0.33);
  float fres = pow(1.0 - clamp(n.y, 0.0, 1.0), 1.5);
  vec3 lit = applyLight(stone, n, vWorld);
  lit += vec3(0.22, 0.85, 0.70) * (vGlow * (0.4 + fres * 1.6));
  fragColor = vec4(lit, 1.0);
}`;

/* ── additive billboards (shards) ─────────────────────────────────────────── */

const BILLBOARD_VS = /* glsl */`#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aInst;
layout(location=2) in vec4 bInst;
uniform mat4 uViewProj;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform float uTime;
out vec2 vCorner;
out float vTw;
void main(){
  vCorner = aCorner;
  float bob = sin(uTime * 1.3 + bInst.x * 6.28) * aInst.w * 0.14;
  vec3 world = aInst.xyz + vec3(0.0, bob, 0.0);
  vTw = 0.8 + 0.2 * sin(uTime * 5.0 + bInst.x * 40.0) * bInst.y;
  vec3 p = world + uCamRight * aCorner.x * aInst.w + uCamUp * aCorner.y * aInst.w;
  gl_Position = uViewProj * vec4(p, 1.0);
}`;

const BILLBOARD_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vCorner;
in float vTw;
uniform vec3 uColor;
out vec4 fragColor;
void main(){
  float r = length(vCorner);
  float core = smoothstep(0.26, 0.0, r);
  float halo = exp(-r * 2.8) * 0.5;
  vec3 c = uColor * (core * 2.8 + halo) * vTw;
  float sp = max(0.0, 1.0 - (abs(vCorner.x) + abs(vCorner.y)) * 0.7);
  c += uColor * pow(sp, 7.0) * 1.5 * vTw;
  fragColor = vec4(c, 1.0);
}`;

/* ── rain (instanced streaks) ─────────────────────────────────────────────── */

const RAIN_MAX = 900;

const RAIN_VS = /* glsl */`#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aInst;   // xyz world, speed seed
layout(location=2) in vec4 bInst;   // length, alpha, 0, 0
uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform vec2 uWind;
out vec2 vCorner;
out float vAlpha;
void main(){
  vCorner = aCorner;
  vAlpha = bInst.y;
  vec3 up = normalize(vec3(uWind.x * 0.25, 1.0, uWind.y * 0.25));
  vec3 toCam = normalize(uCamPos - aInst.xyz + vec3(1e-4));
  vec3 side = normalize(cross(up, toCam) + vec3(1e-5));
  vec3 p = aInst.xyz + side * (aCorner.x - 0.5) * 0.075 + up * aCorner.y * bInst.x;
  gl_Position = uViewProj * vec4(p, 1.0);
}`;

const RAIN_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vCorner;
in float vAlpha;
uniform vec3 uColor;
out vec4 fragColor;
void main(){
  float a = (1.0 - abs(vCorner.x * 2.0 - 1.0)) * (0.45 + 0.55 * (1.0 - vCorner.y));
  fragColor = vec4(uColor * a * vAlpha, 1.0);
}`;

/* ── particles (points) ───────────────────────────────────────────────────── */

const PARTICLE_VS = /* glsl */`#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aData;
uniform mat4 uViewProj;
uniform vec3 uCamPos;
out vec4 vData;
void main(){
  vData = aData;
  vec4 clip = uViewProj * vec4(aPos, 1.0);
  gl_Position = clip;
  float dist = max(length(aPos - uCamPos), 1.0);
  gl_PointSize = clamp(aData.x * 640.0 / dist, 1.0, 40.0);
}`;

const PARTICLE_FS = /* glsl */`#version 300 es
precision highp float;
in vec4 vData;
out vec4 fragColor;
void main(){
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r = length(uv);
  float a = exp(-r * r * 3.0) * vData.y;
  if (a < 0.004) discard;
  vec3 warm = vec3(1.0, 0.82, 0.55);
  vec3 cool = vec3(0.55, 0.95, 0.85);
  vec3 c = mix(warm, cool, clamp(vData.z, 0.0, 1.0));
  fragColor = vec4(c * a, 1.0);
}`;

/* ── light pillar ─────────────────────────────────────────────────────────── */

const PILLAR_VS = /* glsl */`#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aInst;
uniform mat4 uViewProj;
out vec3 vWorld;
out float vY;
out vec3 vN;
void main(){
  vec3 world = aInst.xyz + vec3(aPos.x * aInst.w, aPos.y * 1100.0, aPos.z * aInst.w);
  vWorld = world;
  vY = aPos.y;
  vN = normalize(vec3(aPos.x, 0.0, aPos.z) + vec3(1e-4));
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

const PILLAR_FS = /* glsl */`#version 300 es
precision highp float;
in vec3 vWorld;
in float vY;
in vec3 vN;
uniform vec3 uCamPos;
uniform float uTime;
out vec4 fragColor;
void main(){
  vec3 V = normalize(uCamPos - vWorld);
  float edge = pow(clamp(1.0 - abs(dot(normalize(vN), V)), 0.0, 1.0), 1.6);
  float fadeTop = smoothstep(1.0, 0.12, vY);
  float fadeBot = smoothstep(0.0, 0.05, vY);
  float band = 0.74 + 0.26 * sin(vY * 21.0 - uTime * 2.1);
  vec3 c = mix(vec3(1.4, 0.86, 0.44), vec3(2.0, 1.3, 0.72), vY * 1.3) * band;
  float a = edge * (0.30 + 0.70 * fadeTop) * fadeBot;
  fragColor = vec4(c * a * 0.5, 1.0);
}`;

/* ── placement ────────────────────────────────────────────────────────────── */

const TRAIL_SEGS = 44;
const BIRDS_MAX = 140;

function m4model(pos, yaw, scale = 1, pitch = 0) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const m = new Float32Array(16);
  m[0] = c * scale; m[2] = -s * scale;
  m[4] = sp * s * scale; m[5] = cp * scale; m[6] = sp * c * scale;
  m[8] = cp * s * scale; m[9] = -sp * scale; m[10] = cp * c * scale;
  m[12] = pos[0]; m[13] = pos[1]; m[14] = pos[2]; m[15] = 1;
  return m;
}

export class Entities {
  constructor(gl) {
    this.gl = gl;

    /* glider */
    const manta = buildManta();
    this.gliderMesh = new Mesh(gl);
    this.gliderMesh.attrib(0, 3); this.gliderMesh.attrib(1, 3);
    this.gliderMesh.upload(manta.verts, manta.idx);
    this.gliderProg = createProgram(gl, GLIDER_VS, GLIDER_FS);
    this.gu = uniforms(gl, this.gliderProg);

    /* trails */
    this.trailProg = createProgram(gl, TRAIL_VS, TRAIL_FS);
    this.tu = uniforms(gl, this.trailProg);
    this.trailMesh = new Mesh(gl, { dynamic: true });
    this.trailMesh.attrib(0, 3); this.trailMesh.attrib(1, 2);
    this.trails = [makeTrailState(), makeTrailState()];

    /* birds */
    this.birdProg = createProgram(gl, BIRD_VS, BIRD_FS);
    this.bu2 = uniforms(gl, this.birdProg);
    const birdVerts = new Float32Array([
      0, 0, 0.45,  -1.0, 0, -0.35,  -0.14, 0.09, -0.28,
      0, 0, 0.45,  -0.14, 0.09, -0.28,  0, 0, -0.5,
      0, 0, 0.45,   0.14, 0.09, -0.28,  1.0, 0, -0.35,
      0, 0, 0.45,   0, 0, -0.5,  0.14, 0.09, -0.28,
    ]);
    this.birdMesh = new Mesh(gl, { dynamic: true });
    this.birdMesh.attrib(0, 3);
    this.birdMesh.upload(birdVerts);
    this.birdInstBuf = gl.createBuffer();
    this.birdData = new Float32Array(BIRDS_MAX * 8);
    attachInstances(gl, this.birdMesh, this.birdInstBuf, [
      { loc: 1, size: 4, offset: 0 }, { loc: 2, size: 4, offset: 16 },
    ], 1);

    /* shards */
    this.billProg = createProgram(gl, BILLBOARD_VS, BILLBOARD_FS);
    this.blu = uniforms(gl, this.billProg);
    const corners = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    this.billMesh = new Mesh(gl, { dynamic: true });
    this.billMesh.attrib(0, 2);
    this.billMesh.upload(corners);
    this.billMesh.mode = gl.TRIANGLE_STRIP;
    this.billInstBuf = gl.createBuffer();
    attachInstances(gl, this.billMesh, this.billInstBuf, [
      { loc: 1, size: 4, offset: 0 }, { loc: 2, size: 4, offset: 16 },
    ], 1);
    this.billData = new Float32Array(512 * 8);

    /* beacon */
    const bez = buildBeacon();
    this.beaconMesh = new Mesh(gl);
    this.beaconMesh.attrib(0, 3); this.beaconMesh.attrib(1, 3);
    this.beaconMesh.upload(bez.verts, bez.idx);
    this.beaconProg = createProgram(gl, BEACON_VS, BEACON_FS);
    this.bku = uniforms(gl, this.beaconProg);

    /* whales */
    const wh = buildWhale();
    this.whaleMesh = new Mesh(gl);
    this.whaleMesh.attrib(0, 3); this.whaleMesh.attrib(1, 3);
    this.whaleMesh.upload(wh.verts, wh.idx);
    this.whaleProg = createProgram(gl, WHALE_VS, WHALE_FS);
    this.whu = uniforms(gl, this.whaleProg);
    this.whales = [];

    /* lore stones */
    const stn = buildStone();
    this.stoneMesh = new Mesh(gl);
    this.stoneMesh.attrib(0, 3); this.stoneMesh.attrib(1, 3);
    this.stoneMesh.upload(stn.verts);
    this.stoneProg = createProgram(gl, STONE_VS, STONE_FS);
    this.stu = uniforms(gl, this.stoneProg);
    this.stones = [];

    /* crystals */
    const cr = buildCrystal();
    this.crystalMesh = new Mesh(gl);
    this.crystalMesh.attrib(0, 3);
    this.crystalMesh.upload(cr.verts, cr.idx);
    this.crystalProg = createProgram(gl, CRYSTAL_VS, CRYSTAL_FS);
    this.cru = uniforms(gl, this.crystalProg);
    this.crystalInstBuf = gl.createBuffer();
    this.crystalData = new Float32Array(600 * 8);
    attachInstances(gl, this.crystalMesh, this.crystalInstBuf, [
      { loc: 1, size: 4, offset: 0 }, { loc: 2, size: 4, offset: 16 },
    ], 1);

    /* pillar */
    this.pillarProg = createProgram(gl, PILLAR_VS, PILLAR_FS);
    this.pu = uniforms(gl, this.pillarProg);
    this.pillarMesh = new Mesh(gl, { dynamic: true });
    this.pillarMesh.attrib(0, 3);
    {
      const SEG = 12;
      const verts = [];
      for (let y = 0; y <= 2; y++) {
        for (let s = 0; s <= SEG; s++) {
          const a = (s / SEG) * Math.PI * 2;
          verts.push(Math.cos(a), y / 2, Math.sin(a));
        }
      }
      const idx = [];
      for (let r = 0; r < 2; r++) {
        for (let s = 0; s < SEG; s++) {
          const a = r * (SEG + 1) + s, b = a + 1, c = a + SEG + 1, d = c + 1;
          idx.push(a, b, d, a, d, c);
        }
      }
      this.pillarMesh.upload(new Float32Array(verts), new Uint32Array(idx));
    }
    this.pillarInstBuf = gl.createBuffer();
    this.pillarInst = new Float32Array(8);
    attachInstances(gl, this.pillarMesh, this.pillarInstBuf, [
      { loc: 1, size: 4, offset: 0 },
    ], 1);

    /* rain */
    this.rainProg = createProgram(gl, RAIN_VS, RAIN_FS);
    this.ru = uniforms(gl, this.rainProg);
    this.rainMesh = new Mesh(gl, { dynamic: true });
    this.rainMesh.attrib(0, 2);
    this.rainMesh.upload(new Float32Array([
      0, 0, 1, 0, 0, 1,
      1, 0, 1, 1, 0, 1,
    ]));
    this.rainInstBuf = gl.createBuffer();
    attachInstances(gl, this.rainMesh, this.rainInstBuf, [
      { loc: 1, size: 4, offset: 0 }, { loc: 2, size: 4, offset: 16 },
    ], 1);
    this.rainData = new Float32Array(RAIN_MAX * 8);
    this.rainDrops = [];
    for (let i = 0; i < RAIN_MAX; i++) {
      this.rainDrops.push({ x: 0, y: -1e5, z: 0, sp: Math.random() });
    }
    this.rainCount = 0;

    /* particles */
    this.partProg = createProgram(gl, PARTICLE_VS, PARTICLE_FS);
    this.pau = uniforms(gl, this.partProg);
    this.partMesh = new Mesh(gl, { dynamic: true });
    this.partMesh.attrib(0, 3); this.partMesh.attrib(1, 4);
    this.partMesh.mode = gl.POINTS;
    this.particles = [];
    this.partData = new Float32Array(4096 * 7);

    this.time = 0;
    this.birdCount = 0;
    this.shardCount = 0;
    this.crystalCount = 0;
    this.beacons = [];
    this.shards = [];
    this.shardDraw = [];
    this.crystals = [];
    this.thermals = [];
  }

  /* deterministic world population relative to spawn */
  populate(spawn) {
    const rng = mulberry32(424242);

    /* beacons: spread around spawn on high ground (relaxed fallback if needed) */
    this.beacons = [];
    const baseYaw = rng() * Math.PI * 2;
    for (let i = 0; i < 5; i++) {
      const dist = 900 + i * 420 + rng() * 260;
      const yaw = baseYaw + i * (Math.PI * 2 / 5) + (rng() - 0.5) * 0.9;
      let best = null;
      for (let relax = 0; relax < 3 && !best; relax++) {
        const minH = [WORLD.WATER_LEVEL + 8, WORLD.WATER_LEVEL + 3, WORLD.WATER_LEVEL + 1][relax];
        const spread = [1.1, 2.2, 4.0][relax];
        for (let k = 0; k < 60; k++) {
          const r = dist * (0.7 + rng() * 0.7) * (1 + relax * 0.35);
          const a = yaw + (rng() - 0.5) * spread;
          const x = spawn[0] + Math.cos(a) * r, z = spawn[2] + Math.sin(a) * r;
          const h = terrainHeight(x, z);
          if (h < minH) continue;
          if (!best || h > best.h) best = { x, z, h };
        }
      }
      if (!best) break;
      const pos = [best.x, best.h, best.z];
      this.beacons.push({
        pos,
        yaw: rng() * Math.PI * 2,
        model: m4model([best.x, best.h - 1.5, best.z], rng() * Math.PI * 2),
        lit: 0,
        target: 0,
      });
    }

    /* thermals */
    this.thermals = [];
    for (let i = 0; i < 16; i++) {
      const r = 500 + rng() * 2300;
      const a = rng() * Math.PI * 2;
      const x = spawn[0] + Math.cos(a) * r, z = spawn[2] + Math.sin(a) * r;
      const h = terrainHeight(x, z);
      if (h < WORLD.WATER_LEVEL + 4) { i--; continue; }
      this.thermals.push({ pos: [x, h, z], top: h + 420 + rng() * 260, r: 62 + rng() * 30, strength: 0.7 + rng() * 0.6 });
    }

    /* shards: rings near beacons + strings between */
    this.shards = [];
    const addShard = (x, y, z) => this.shards.push({ pos: [x, y, z], alive: true, ph: rng() });
    for (const b of this.beacons) {
      const n = 9 + (rng() * 5 | 0);
      for (let i = 0; i < n; i++) {
        const a = rng() * Math.PI * 2, r = 46 + rng() * 130;
        const x = b.pos[0] + Math.cos(a) * r, z = b.pos[2] + Math.sin(a) * r;
        const h = terrainHeight(x, z);
        const gy = Math.max(h, WORLD.WATER_LEVEL);
        addShard(x, gy + 16 + rng() * 40, z);
      }
    }
    /* strings linking consecutive beacons */
    for (let i = 0; i < this.beacons.length; i++) {
      const A = this.beacons[i].pos, B = this.beacons[(i + 1) % this.beacons.length].pos;
      const n = 13;
      for (let k = 1; k <= n; k++) {
        const t = k / (n + 1);
        const x = lerp(A[0], B[0], t), z = lerp(A[2], B[2], t);
        const gy = Math.max(terrainHeight(x, z), WORLD.WATER_LEVEL);
        addShard(x, gy + 26 + Math.sin(t * Math.PI) * 60 + rng() * 22, z);
      }
    }
    /* starter trail from spawn */
    {
      const yaw = rng() * Math.PI * 2;
      for (let k = 0; k < 9; k++) {
        const x = spawn[0] + Math.cos(yaw) * (90 + k * 55) + (rng() - 0.5) * 40;
        const z = spawn[2] + Math.sin(yaw) * (90 + k * 55) + (rng() - 0.5) * 40;
        const gy = Math.max(terrainHeight(x, z), WORLD.WATER_LEVEL);
        addShard(x, gy + 20 + rng() * 26, z);
      }
    }

    /* crystals: around beacons + wild */
    this.crystals = [];
    for (const b of this.beacons) {
      const n = 5 + (rng() * 5 | 0);
      for (let i = 0; i < n; i++) {
        const a = rng() * Math.PI * 2, r = 14 + rng() * 42;
        const x = b.pos[0] + Math.cos(a) * r, z = b.pos[2] + Math.sin(a) * r;
        this.crystals.push({ pos: [x, terrainHeight(x, z) - 0.4, z], s: 1.6 + rng() * 3.4, rot: rng() * 6.28, near: true });
      }
    }
    for (let i = 0; i < 26; i++) {
      const r = 300 + rng() * 2400, a = rng() * Math.PI * 2;
      const x = spawn[0] + Math.cos(a) * r, z = spawn[2] + Math.sin(a) * r;
      const h = terrainHeight(x, z);
      if (h < WORLD.WATER_LEVEL + 6) continue;
      this.crystals.push({ pos: [x, h - 0.4, z], s: 0.9 + rng() * 2.4, rot: rng() * 6.28, near: false });
    }
    /* loose field shards along scenic arcs */
    for (let i = 0; i < 34; i++) {
      const r = 200 + rng() * 2200, a = rng() * Math.PI * 2;
      const x = spawn[0] + Math.cos(a) * r, z = spawn[2] + Math.sin(a) * r;
      const gy = Math.max(terrainHeight(x, z), WORLD.WATER_LEVEL);
      addShard(x, gy + 14 + rng() * 60, z);
    }

    /* flocks */
    this.flocks = [];
    for (let f = 0; f < 3; f++) {
      const r = 500 + rng() * 1800, a = rng() * Math.PI * 2;
      const x = spawn[0] + Math.cos(a) * r, z = spawn[2] + Math.sin(a) * r;
      const gy = Math.max(terrainHeight(x, z), WORLD.WATER_LEVEL);
      const flock = { x, z, y: gy + 80 + rng() * 90, n: 22 + (rng() * 16 | 0), birds: [] };
      for (let i = 0; i < flock.n; i++) {
        flock.birds.push({ a: rng() * 6.28, va: 0.22 + rng() * 0.2, r: 26 + rng() * 60, h: (rng() - 0.5) * 30, ph: rng(), s: 0.75 + rng() * 0.9 });
      }
      this.flocks.push(flock);
    }

    /* sky-whales: vast, slow, and utterly indifferent to you */
    this.whales = [];
    for (let i = 0; i < 3; i++) {
      this.whales.push({
        cx: spawn[0] + (rng() - 0.5) * 3600,
        cz: spawn[2] + (rng() - 0.5) * 3600,
        cy: 300 + rng() * 300,
        r: 320 + rng() * 780,
        phase: rng() * 6.28,
        speed: 0.014 + rng() * 0.02,
        scale: 16 + rng() * 12,
        model: m4model([0, -1e5, 0], 0, 1),
      });
    }

    /* lore stones: little monuments waiting to be found */
    const LORE = [
      'we carved the wind here, before the sand came',
      'the beacons burned once before — the sky remembers',
      'the giant watches. it has always watched',
      'when the light returns, the rings will sing',
      'we walked to the sea and found only mirrors',
      'count five, and the world wakes',
      'the manta carries the last spark of the hearth',
      'do not fear the storm. it is only the desert dreaming',
    ];
    this.stones = [];
    let li = 0;
    for (let c = 0; c < 4; c++) {
      const r = 500 + rng() * 2100, a = rng() * Math.PI * 2;
      const cx = spawn[0] + Math.cos(a) * r, cz = spawn[2] + Math.sin(a) * r;
      const n = 2 + (rng() * 3 | 0);
      for (let k = 0; k < n; k++) {
        const x = cx + (rng() - 0.5) * 46, z = cz + (rng() - 0.5) * 46;
        const h = terrainHeight(x, z);
        if (h < WORLD.WATER_LEVEL + 3) continue;
        this.stones.push({
          pos: [x, h - 0.2, z],
          line: LORE[li++ % LORE.length],
          seen: false,
          model: m4model([x, h - 0.2, z], rng() * 6.28, 0.85 + rng() * 0.4, (rng() - 0.5) * 0.09),
        });
      }
    }
  }

  igniteBeacon(b) {
    b.target = 1;
    this.spawnBurst([b.pos[0], b.pos[1] + 14, b.pos[2]], 60, 0);
    this.spawnBurst([b.pos[0], b.pos[1] + 30, b.pos[2]], 40, 0);
  }

  collectShard(s) {
    s.alive = false;
    this.spawnBurst(s.pos, 24, 0);
  }

  spawnBurst(pos, n = 26, hue = 0) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 5 + Math.random() * 15;
      this.particles.push({
        p: [...pos],
        v: [Math.cos(a) * s, Math.random() * 14 + 2, Math.sin(a) * s],
        life: 1, decay: 1.0 + Math.random() * 1.2,
        size: 1.6 + Math.random() * 2.4, hue,
      });
    }
  }

  update(dt, game) {
    this.time += dt;
    const ship = game.ship;

    /* wingtip trails */
    for (let w = 0; w < 2; w++) {
      const st = this.trails[w];
      const tip = ship.wingTip(w);
      const last = st.points[(st.head - 0 + TRAIL_SEGS) % TRAIL_SEGS];
      if (!st.count || v3.dist(tip, last) > 1.3) {
        st.head = (st.head + 1) % TRAIL_SEGS;
        st.points[st.head] = tip;
        st.count = Math.min(st.count + 1, TRAIL_SEGS);
      }
    }

    /* beacon lit easing (charge makes it glow before it wakes) */
    for (const b of this.beacons) {
      const goal = Math.max(b.target, (b.charge || 0) * 0.55);
      b.lit = lerp(b.lit, goal, 1 - Math.exp(-dt * 1.6));
    }

    /* whales drift their slow circles */
    for (const wh of this.whales) {
      wh.phase += wh.speed * dt;
      const wx = wh.cx + Math.cos(wh.phase) * wh.r;
      const wz = wh.cz + Math.sin(wh.phase) * wh.r;
      const wy = wh.cy + Math.sin(this.time * 0.05 + wh.phase) * 26;
      const yaw = Math.atan2(-Math.sin(wh.phase), Math.cos(wh.phase));
      wh.model = m4model([wx, wy, wz], yaw, wh.scale, Math.sin(this.time * 0.11 + wh.phase) * 0.06);
    }

    /* particles */
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= p.decay * dt;
      if (p.life <= 0) { ps[i] = ps[ps.length - 1]; ps.pop(); continue; }
      p.p[0] += p.v[0] * dt; p.p[1] += p.v[1] * dt; p.p[2] += p.v[2] * dt;
      p.v[1] -= 7 * dt;
      p.v[0] *= (1 - 1.4 * dt); p.v[2] *= (1 - 1.4 * dt);
    }
    if (ps.length > 4200) ps.splice(0, ps.length - 4200);

    /* thermal dust: keep each thermal lightly fed */
    if (game.frame % 7 === 0) {
      for (const th of this.thermals) {
        const d = v3.dist2([ship.pos[0], 0, ship.pos[2]], [th.pos[0], 0, th.pos[2]]);
        if (d > 2600 * 2600) continue;
        const a = Math.random() * Math.PI * 2;
        const r = th.r * (0.4 + Math.random() * 0.8);
        ps.push({
          p: [th.pos[0] + Math.cos(a) * r, th.pos[1] + Math.random() * 30, th.pos[2] + Math.sin(a) * r],
          v: [Math.sin(a + 1.6) * 4, 16 + Math.random() * 8, Math.cos(a + 1.6) * 4],
          life: 1, decay: 0.16, size: 1.1 + Math.random() * 1.2, hue: 1,
        });
      }
    }

    /* ambient motes */
    if (Math.random() < 0.35 && ps.length < 2800) {
      const r = 50 + Math.random() * 170;
      const a = Math.random() * Math.PI * 2;
      const x = ship.pos[0] + Math.cos(a) * r, z = ship.pos[2] + Math.sin(a) * r;
      const gy = Math.max(terrainHeight(x, z), WORLD.WATER_LEVEL);
      ps.push({ p: [x, gy + 2 + Math.random() * 50, z], v: [7, 1, 3], life: 1, decay: 0.07, size: 0.8 + Math.random() * 1.3, hue: 0 });
    }

    /* weather: sand riding the wind, and rain streaks */
    const wth = game.weather;
    const dust = wth ? wth.dust : 0;
    const rain = wth ? wth.rain : 0;
    if (dust > 0.12) {
      const wa = wth.windAngle;
      const wx = Math.cos(wa), wz = Math.sin(wa);
      const n = Math.random() < dust ? 1 + (dust * 3 | 0) : 0;
      for (let i = 0; i < n && ps.length < 4200; i++) {
        const r = 20 + Math.random() * 170;
        const a = Math.random() * Math.PI * 2;
        const x = ship.pos[0] + Math.cos(a) * r, z = ship.pos[2] + Math.sin(a) * r;
        const gy = Math.max(terrainHeight(x, z), WORLD.WATER_LEVEL);
        ps.push({
          p: [x, gy + 2 + Math.random() * 70, z],
          v: [wx * (16 + dust * 34), 1.2 + Math.random() * 4, wz * (16 + dust * 34)],
          life: 1, decay: 0.06, size: 0.9 + Math.random() * 1.2, hue: 0.12,
        });
      }
    }
    if (rain > 0.02) {
      const n = Math.round(RAIN_MAX * Math.min(1, rain * 1.2));
      const cx = ship.pos[0], cy = ship.pos[1], cz = ship.pos[2];
      const wx = Math.cos(wth.windAngle), wz = Math.sin(wth.windAngle);
      const fall = 46 + wth.storm * 30;
      if (this.rainCount === 0) {
        for (const d of this.rainDrops) {
          d.x = cx + (Math.random() - 0.5) * 110;
          d.y = cy + (Math.random() - 0.5) * 60;
          d.z = cz + (Math.random() - 0.5) * 110;
          d.sp = Math.random();
        }
      }
      let wi = 0;
      for (let i = 0; i < n; i++) {
        const d = this.rainDrops[i];
        d.y -= (fall + d.sp * 26) * dt;
        d.x += wx * (5 + wth.storm * 24) * dt;
        d.z += wz * (5 + wth.storm * 24) * dt;
        if (d.y < cy - 28) {
          d.y = cy + 28 + Math.random() * 14;
          d.x = cx + (Math.random() - 0.5) * 100;
          d.z = cz + (Math.random() - 0.5) * 100;
          d.sp = Math.random();
        }
        if (d.x - cx > 56) d.x -= 112; else if (d.x - cx < -56) d.x += 112;
        if (d.z - cz > 56) d.z -= 112; else if (d.z - cz < -56) d.z += 112;
        this.rainData[wi++] = d.x; this.rainData[wi++] = d.y; this.rainData[wi++] = d.z; this.rainData[wi++] = d.sp;
        this.rainData[wi++] = 1.2 + d.sp * 1.8;
        this.rainData[wi++] = 0.22 + 0.38 * rain;
        this.rainData[wi++] = 0; this.rainData[wi++] = 0;
      }
      this.rainCount = n;
    } else {
      this.rainCount = 0;
    }

    /* birds: flocks scatter when the manta cuts through them */
    let w = 0;
    for (const f of this.flocks) {
      const fd = Math.hypot(f.x - ship.pos[0], f.y - ship.pos[1], f.z - ship.pos[2]);
      if (fd < 80) f.scare = Math.min(1, (f.scare || 0) + dt * 2.4);
      else f.scare = Math.max(0, (f.scare || 0) - dt * 0.45);
      const scare = f.scare || 0;
      for (const b of f.birds) {
        b.a += b.va * dt * (1 + scare * 2.8);
        const rr = b.r * (1 + scare * 0.9);
        const x = f.x + Math.cos(b.a) * rr;
        const z = f.z + Math.sin(b.a) * rr;
        const y = Math.max(f.y + b.h + Math.sin(this.time * 0.9 + b.ph) * 6 * (1 + scare), terrainHeight(x, z) + 12);
        this.birdData[w++] = x; this.birdData[w++] = y; this.birdData[w++] = z; this.birdData[w++] = -b.a;
        this.birdData[w++] = b.ph; this.birdData[w++] = b.s; this.birdData[w++] = 0; this.birdData[w++] = 0;
      }
    }
    this.birdCount = w / 8;

    /* visible shard set for the billboard pass (distance-culled) */
    this.shardDraw.length = 0;
    for (const s of this.shards) {
      if (!s.alive) continue;
      const dx = s.pos[0] - ship.pos[0], dz = s.pos[2] - ship.pos[2];
      if (dx * dx + dz * dz > 3400 * 3400) continue;
      this.shardDraw.push(s);
    }
  }

  setLightUniforms(u, env, viewProj, cam) {
    const gl = this.gl;
    gl.uniformMatrix4fv(u.uViewProj, false, viewProj);
    gl.uniform3fv(u.uLightDir, env.lightDir);
    gl.uniform3fv(u.uSunColor, env.sunColor);
    gl.uniform3fv(u.uSkyAmbient, env.skyAmbient);
    gl.uniform3fv(u.uGroundAmbient, env.groundAmbient);
    gl.uniform3fv(u.uFogColor, env.fogColor);
    gl.uniform1f(u.uFogDensity, env.fogDensity);
    gl.uniform3fv(u.uCamPos, cam.pos);
    gl.uniform1f(u.uNight, env.night);
  }

  drawOpaque(env, view, proj, viewProj, cam, renderer) {
    const gl = this.gl;

    gl.useProgram(this.gliderProg);
    this.setLightUniforms(this.gu, env, viewProj, cam);
    gl.uniform1f(this.gu.uTime, this.time);
    gl.uniform1f(this.gu.uFlap, 0.9);
    gl.uniform3f(this.gu.uGlowColor, 1.6, 1.1, 0.5);
    gl.uniform1f(this.gu.uGlowAmt, this.game ? this.game.glowPulse : 0);
    gl.uniformMatrix4fv(this.gu.uModel, false, this._shipMat);
    this.gliderMesh.draw();

    if (this.whales.length) {
      gl.useProgram(this.whaleProg);
      this.setLightUniforms(this.whu, env, viewProj, cam);
      gl.uniform1f(this.whu.uTime, this.time);
      for (const wh of this.whales) {
        gl.uniformMatrix4fv(this.whu.uModel, false, wh.model);
        this.whaleMesh.draw();
      }
    }

    if (this.birdCount > 0) {
      gl.useProgram(this.birdProg);
      this.setLightUniforms(this.bu2, env, viewProj, cam);
      gl.uniform1f(this.bu2.uTime, this.time);
      gl.bindVertexArray(this.birdMesh.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.birdInstBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.birdData.subarray(0, this.birdCount * 8), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, this.birdMesh.count, this.birdCount);
      gl.bindVertexArray(null);
    }

    gl.useProgram(this.beaconProg);
    this.setLightUniforms(this.bku, env, viewProj, cam);
    gl.uniform1f(this.bku.uTime, this.time);
    for (const b of this.beacons) {
      gl.uniform1f(this.bku.uLit, b.lit);
      gl.uniformMatrix4fv(this.bku.uModel, false, b.model);
      this.beaconMesh.draw();
    }

    if (this.stones.length) {
      gl.useProgram(this.stoneProg);
      this.setLightUniforms(this.stu, env, viewProj, cam);
      gl.uniform1f(this.stu.uTime, this.time);
      for (const stn of this.stones) {
        gl.uniformMatrix4fv(this.stu.uModel, false, stn.model);
        gl.uniform1f(this.stu.uGlow, stn.seen ? 0.10 : 0.7 + 0.3 * Math.sin(this.time * 1.6 + stn.pos[0] * 0.7));
        this.stoneMesh.draw();
      }
    }

    if (this.crystals.length > 0) {
      gl.useProgram(this.crystalProg);
      this.setLightUniforms(this.cru, env, viewProj, cam);
      let w = 0;
      for (const c of this.crystals) {
        let glow = 0.16;
        for (const b of this.beacons) {
          const d = v3.dist(c.pos, b.pos);
          glow = Math.max(glow, b.lit * clamp01(1.4 - d / 160) * 1.3);
        }
        this.crystalData[w++] = c.pos[0]; this.crystalData[w++] = c.pos[1]; this.crystalData[w++] = c.pos[2]; this.crystalData[w++] = c.s;
        this.crystalData[w++] = c.rot; this.crystalData[w++] = glow; this.crystalData[w++] = 0; this.crystalData[w++] = 0;
      }
      this.crystalCount = w / 8;
      gl.bindVertexArray(this.crystalMesh.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.crystalInstBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.crystalData.subarray(0, w), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, this.crystalMesh.count, this.crystalCount);
      gl.bindVertexArray(null);
    }
  }

  renderShadowPass(terrain, gl) {
    /* beacon stones cast shadows onto the sand */
    gl.useProgram(terrain.depthProg);
    gl.uniform2f(terrain.du.uWorldOffset, 0, 0);
    gl.uniform1f(terrain.du.uSpacing, 1);
    for (const b of this.beacons) {
      gl.uniformMatrix4fv(terrain.du.uLightViewProj, false, terrain.lightViewProj);
      gl.uniformMatrix4fv(terrain.du.uModel, false, b.model);
      this.beaconMesh.draw();
    }
  }

  drawAdditive(env, view, proj, viewProj, cam, renderer) {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    /* ribbons and billboards are two-sided: culling them punches holes */
    gl.disable(gl.CULL_FACE);

    /* trails */
    if (this._trailCount > 0) {
      gl.useProgram(this.trailProg);
      gl.uniformMatrix4fv(this.tu.uViewProj, false, viewProj);
      gl.uniform3fv(this.tu.uCamPos, cam.pos);
      gl.uniform1f(this.tu.uWidth, 0.22);
      gl.uniform3f(this.tu.uColor, 1.5, 0.95, 0.42);
      gl.uniform1f(this.tu.uFade, 1.0);
      this.trailMesh.upload(this._trailFloats.subarray(0, this._trailCount));
      this.trailMesh.draw();
    }

    /* shards */
    if (this.shardDraw.length > 0) {
      gl.useProgram(this.billProg);
      gl.uniformMatrix4fv(this.blu.uViewProj, false, viewProj);
      gl.uniform3fv(this.blu.uCamRight, this._camRight);
      gl.uniform3fv(this.blu.uCamUp, this._camUp);
      gl.uniform1f(this.blu.uTime, this.time);
      gl.uniform3f(this.blu.uColor, 1.65, 1.15, 0.5);
      let w = 0;
      for (const s of this.shardDraw) {
        this.billData[w++] = s.pos[0]; this.billData[w++] = s.pos[1]; this.billData[w++] = s.pos[2]; this.billData[w++] = 3.4;
        this.billData[w++] = s.ph; this.billData[w++] = 1; this.billData[w++] = 0; this.billData[w++] = 1;
      }
      gl.bindVertexArray(this.billMesh.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.billInstBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.billData.subarray(0, w), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, w / 8);
      gl.bindVertexArray(null);
    }

    /* pillars */
    gl.useProgram(this.pillarProg);
    gl.uniformMatrix4fv(this.pu.uViewProj, false, viewProj);
    gl.uniform3fv(this.pu.uCamPos, cam.pos);
    gl.uniform1f(this.pu.uTime, this.time);
    for (const b of this.beacons) {
      if (b.lit <= 0.01) continue;
      this.pillarInst[0] = b.pos[0]; this.pillarInst[1] = b.pos[1] + 10; this.pillarInst[2] = b.pos[2]; this.pillarInst[3] = 4.5;
      gl.bindVertexArray(this.pillarMesh.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pillarInstBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.pillarInst, gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, this.pillarMesh.count, 1);
      gl.bindVertexArray(null);
    }

    /* particles */
    if (this.particles.length > 0) {
      gl.useProgram(this.partProg);
      gl.uniformMatrix4fv(this.pau.uViewProj, false, viewProj);
      gl.uniform3fv(this.pau.uCamPos, cam.pos);
      let w = 0;
      for (const p of this.particles) {
        this.partData[w++] = p.p[0]; this.partData[w++] = p.p[1]; this.partData[w++] = p.p[2];
        this.partData[w++] = p.size; this.partData[w++] = clamp01(p.life) * 0.55; this.partData[w++] = p.hue; this.partData[w++] = 0;
      }
      gl.bindVertexArray(this.partMesh.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.partMesh.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, this.partData.subarray(0, w), gl.DYNAMIC_DRAW);
      const stride = 28;
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 12);
      gl.drawArrays(gl.POINTS, 0, w / 7);
      gl.bindVertexArray(null);
    }

    /* rain streaks */
    if (this.rainCount > 0) {
      gl.useProgram(this.rainProg);
      gl.uniformMatrix4fv(this.ru.uViewProj, false, viewProj);
      gl.uniform3fv(this.ru.uCamPos, cam.pos);
      const wd = (env && env.windDir) ? env.windDir : [1, 0, 0];
      gl.uniform2f(this.ru.uWind, wd[0], wd[2]);
      gl.uniform3f(this.ru.uColor, 0.52, 0.60, 0.70);
      gl.bindVertexArray(this.rainMesh.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.rainInstBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.rainData.subarray(0, this.rainCount * 8), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.rainCount);
      gl.bindVertexArray(null);
    }

    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  /* called by game each frame after ship update */
  syncShip(ship, view) {
    this._shipMat = ship.matrix();
    if (!view) return;
    this._camRight = [view[0], view[4], view[8]];
    this._camUp = [view[1], view[5], view[9]];

    /* rebuild trail ribbons into a reusable buffer (no per-frame GC) */
    if (!this._trailFloats) {
      this._trailFloats = new Float32Array(2 * TRAIL_SEGS * 6 * 5);
      this._pts = new Array(TRAIL_SEGS);
    }
    const f = this._trailFloats;
    let n = 0;
    for (const st of this.trails) {
      if (st.count < 2) continue;
      for (let k = 0; k < st.count; k++) {
        const idx = ((st.head - k) % TRAIL_SEGS + TRAIL_SEGS) % TRAIL_SEGS;
        this._pts[k] = st.points[idx];
      }
      const m = st.count;
      for (let k = 0; k < m - 1; k++) {
        const u0 = k / (m - 1), u1 = (k + 1) / (m - 1);
        const p0 = this._pts[k], p1 = this._pts[k + 1];
        /* both triangles CCW when seen from either side of the ribbon */
        f[n++] = p0[0]; f[n++] = p0[1]; f[n++] = p0[2]; f[n++] = u0; f[n++] = -1;
        f[n++] = p0[0]; f[n++] = p0[1]; f[n++] = p0[2]; f[n++] = u0; f[n++] = 1;
        f[n++] = p1[0]; f[n++] = p1[1]; f[n++] = p1[2]; f[n++] = u1; f[n++] = -1;
        f[n++] = p1[0]; f[n++] = p1[1]; f[n++] = p1[2]; f[n++] = u1; f[n++] = -1;
        f[n++] = p0[0]; f[n++] = p0[1]; f[n++] = p0[2]; f[n++] = u0; f[n++] = 1;
        f[n++] = p1[0]; f[n++] = p1[1]; f[n++] = p1[2]; f[n++] = u1; f[n++] = 1;
      }
    }
    this._trailCount = n;
  }
}

function makeTrailState() {
  return { points: new Array(TRAIL_SEGS), head: 0, count: 0 };
}
