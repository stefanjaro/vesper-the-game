/* ─────────────────────────────────────────────────────────────────────────────
   VESPER · world.js
   The land itself: a deterministic fractal height field, streamed as a
   quadtree of LOD chunks with skirts (crack-free), shaded with sun shadows.
   ───────────────────────────────────────────────────────────────────────────── */

import {
  v3, clamp, clamp01, lerp, smoothstep, fbm2, ridged2,
  m4ortho, m4mul, m4identity, m4lookAt,
  createProgram, uniforms, Mesh,
} from './engine.js';

export const WORLD = {
  WATER_LEVEL: -10,          // metres
  DAY_LENGTH: 600,           // seconds per full day cycle
};

/* ── the height field ─────────────────────────────────────────────────────── */

const S_CONT = 2201, S_RIDGE = 3307, S_WARP = 4409, S_PHASE = 5501, S_DET = 6607, S_MOIST = 7703;

export function continentAt(x, z) {
  return fbm2(x * 3.1e-4, z * 3.1e-4, 4, S_CONT);
}

export function terrainHeight(x, z) {
  const c = fbm2(x * 3.1e-4, z * 3.1e-4, 4, S_CONT);

  // broad basins and ranges
  let h = (c - 0.46) * 330;

  // mountains where the continent is high
  const mMask = smoothstep(0.52, 0.74, c);
  const r = ridged2(x * 7.3e-4, z * 7.3e-4, 5, S_RIDGE);
  h += mMask * Math.pow(r, 1.35) * 430;

  // dune seas on mid flats
  const duneZone = smoothstep(0.40, 0.52, c) * (1 - smoothstep(0.62, 0.72, c));
  const wx = x + (fbm2(x * 0.0042, z * 0.0042, 2, S_WARP) - 0.5) * 180;
  const wz = z + (fbm2(x * 0.0038 + 31.7, z * 0.0038 - 17.3, 2, S_WARP) - 0.5) * 180;
  const phase = wx * 0.0165 + wz * 0.0093 + (fbm2(x * 0.0011, z * 0.0011, 2, S_PHASE) - 0.5) * 5.0;
  const crest = 0.5 + 0.5 * Math.sin(phase);
  h += Math.pow(crest, 1.7) * 17 * duneZone;

  // fine undulation
  const detMask = 1 - mMask * 0.85;
  h += (fbm2(x * 0.021, z * 0.021, 3, S_DET) - 0.5) * 7 * detMask;

  return h;
}

export function terrainNormal(x, z, eps = 1.5) {
  const hL = terrainHeight(x - eps, z);
  const hR = terrainHeight(x + eps, z);
  const hD = terrainHeight(x, z - eps);
  const hU = terrainHeight(x, z + eps);
  return v3.norm([hL - hR, 2 * eps, hD - hU]);
}

export function moistureAt(x, z) {
  return fbm2(x * 0.0013, z * 0.0013, 3, S_MOIST);
}

/* ── quadtree constants ───────────────────────────────────────────────────── */

const CELLS = 32;                 // quads per chunk edge
const VERTS = CELLS + 1;
const BASE_SIZE = 96;             // metres, level 0 chunk
const MAX_LEVEL = 4;              // sizes: 96, 288, 864, 2592, 7776
const sizeOf = (l) => BASE_SIZE * Math.pow(3, l);
const spacingOf = (l) => BASE_SIZE * Math.pow(3, l) / CELLS;

/* indices for a (VERTS)² grid plus skirt ring, identical for every chunk */
function buildIndices() {
  const idx = [];
  const grid = (i, j) => j * VERTS + i;
  for (let j = 0; j < CELLS; j++) {
    for (let i = 0; i < CELLS; i++) {
      const a = grid(i, j), b = grid(i + 1, j), c = grid(i + 1, j + 1), d = grid(i, j + 1);
      idx.push(a, c, b, a, d, c);
    }
  }
  /* skirt strips: 4 edges, each VERTS*2 verts laid down edge by edge
     (top copy then dropped copy), both windings so orientation never matters */
  let base = VERTS * VERTS;
  const edgeQuad = (a, b, sa, sb) => {
    // sa/sb = top copies of a/b on skirt, +1 = dropped copies
    idx.push(a, b, sa + 1, b, sb + 1, sa + 1);
    idx.push(b, a, sa + 1, sb + 1, b, sa + 1);
  };
  for (let i = 0; i < CELLS; i++) {
    edgeQuad(grid(i, 0), grid(i + 1, 0), base + i * 2, base + (i + 1) * 2);
  }
  base += VERTS * 2;
  for (let i = 0; i < CELLS; i++) {
    edgeQuad(grid(i, CELLS), grid(i + 1, CELLS), base + i * 2, base + (i + 1) * 2);
  }
  base += VERTS * 2;
  for (let j = 0; j < CELLS; j++) {
    edgeQuad(grid(0, j), grid(0, j + 1), base + j * 2, base + (j + 1) * 2);
  }
  base += VERTS * 2;
  for (let j = 0; j < CELLS; j++) {
    edgeQuad(grid(CELLS, j), grid(CELLS, j + 1), base + j * 2, base + (j + 1) * 2);
  }
  return new Uint32Array(idx);
}

/* ── shaders ──────────────────────────────────────────────────────────────── */

const TERRAIN_VS = /* glsl */`#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
uniform mat4 uViewProj;
uniform mat4 uLightViewProj;
uniform vec2 uWorldOffset;
uniform float uSpacing;
out vec3 vWorld;
out vec3 vNormal;
out vec4 vShadowPos;
void main(){
  vec3 world = vec3(aPos.x * uSpacing + uWorldOffset.x, aPos.y, aPos.z * uSpacing + uWorldOffset.y);
  vWorld = world;
  vNormal = aNormal;
  vShadowPos = uLightViewProj * vec4(world, 1.0);
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

const TERRAIN_FS = /* glsl */`#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec4 vShadowPos;
uniform vec3 uLightDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
uniform vec3 uGroundAmbient;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uCamPos;
uniform float uWaterLevel;
uniform float uTime;
uniform sampler2D uShadowMap;
uniform float uShadowTexel;
uniform float uShadowExtent;
uniform mat4 uLightViewProjM;
uniform vec3 uGliderPos;     // manta position, for its soft drop-shadow
uniform float uSunVisibility;
out vec4 fragColor;uint uhash(uvec2 q){
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

float shadowFactor(vec3 world, vec3 n, float ndl){
  vec3 sp = world + n * (uShadowExtent / 2048.0) * 2.0;
  vec4 off = uLightViewProjM * vec4(sp, 1.0);
  vec3 proj = off.xyz / off.w;
  if (proj.z > 1.0) return 1.0;
  float bias = clamp(0.0012 * tan(acos(clamp(ndl, 0.0, 1.0))), 0.0004, 0.05);
  float shadow = 0.0;
  for (int i = -1; i <= 1; i++){
    for (int j = -1; j <= 1; j++){
      float d = texture(uShadowMap, proj.xy + vec2(float(i), float(j)) * uShadowTexel).r;
      shadow += (proj.z - bias > d) ? 0.0 : 1.0;
    }
  }
  return shadow / 9.0;
}

void main(){
  vec3 nGeom = normalize(vNormal);
  vec3 n = nGeom;
  vec3 p = vWorld;

  /* drifting micro-ripples in the sand, faded with distance to stop aliasing */
  float viewDist = length(p - uCamPos);
  float detailFade = clamp(1.0 - viewDist / 2600.0, 0.12, 1.0);
  vec2 rp = p.xz * 0.16;
  float e = 0.35;
  float n0 = vnoise(rp + vec2(uTime * 0.01, uTime * 0.007));
  float nx = vnoise(rp + vec2(uTime * 0.01, uTime * 0.007) + vec2(e, 0.0));
  float nz = vnoise(rp + vec2(uTime * 0.01, uTime * 0.007) + vec2(0.0, e));
  vec3 ripple = normalize(vec3((n0 - nx) * 0.6, e, (n0 - nz) * 0.6));
  float rippleAmt = clamp(n.y, 0.0, 1.0) * 0.09 * detailFade;
  n = normalize(n + ripple * rippleAmt);

  float slope = 1.0 - clamp(n.y, 0.0, 1.0);
  float h = p.y;

  vec3 sandA = vec3(0.86, 0.64, 0.40);
  vec3 sandB = vec3(0.66, 0.45, 0.28);
  vec3 rock  = vec3(0.38, 0.29, 0.25);
  vec3 salt  = vec3(0.80, 0.77, 0.71);
  vec3 oasis = vec3(0.33, 0.40, 0.21);

  float grain = (vnoise(p.xz * 0.9) - 0.5) * (0.35 + 0.45 * detailFade);
  vec3 col = mix(sandB, sandA, 0.5 + grain * 0.9);
  col = mix(col, col * vec3(1.06, 0.97, 0.9), vnoise(p.xz * 0.013) * 0.8);

  col = mix(col, rock * (0.8 + 0.4 * vnoise(p.xz * 0.4)), smoothstep(0.22, 0.55, slope));

  float nearWater = smoothstep(uWaterLevel + 6.0, uWaterLevel + 0.5, h);
  col = mix(col, salt * (0.9 + 0.2 * vnoise(p.xz * 0.7)), nearWater * (1.0 - smoothstep(0.3, 0.5, slope)) * 0.9);
  /* a narrow green ribbon just above the waterline, not the whole desert */
  float fringe = smoothstep(uWaterLevel + 3.2, uWaterLevel + 0.9, h);
  col = mix(col, oasis, fringe * (1.0 - smoothstep(0.18, 0.42, slope)) * 0.72);
  /* lakebeds shade down into the depths instead of a hard salt plane */
  float submerged = smoothstep(uWaterLevel + 0.2, uWaterLevel - 3.0, h);
  col = mix(col, vec3(0.16, 0.20, 0.19) * (0.85 + 0.3 * vnoise(p.xz * 0.5)), submerged);

  float ndlGeom = dot(nGeom, uLightDir);
  float ndl = dot(n, uLightDir);
  float sh = shadowFactor(p, nGeom, ndlGeom);
  float sunTerm = clamp(ndl, 0.0, 1.0) * sh;
  vec3 amb = mix(uGroundAmbient, uSkyAmbient, clamp(n.y * 0.5 + 0.5, 0.0, 1.0)) * 1.35;
  vec3 lit = col * (uSunColor * sunTerm + amb);

  /* the manta's soft drop-shadow on the sand */
  float dGl = distance(p.xz, uGliderPos.xz);
  float glFade = clamp(1.0 - (uGliderPos.y - p.y) / 170.0, 0.0, 1.0);
  lit *= 1.0 - 0.5 * exp(-dGl * dGl * 0.09) * glFade * uSunVisibility;

  float dist = length(p - uCamPos);
  float fog = 1.0 - exp(-dist * uFogDensity);
  lit = mix(lit, uFogColor, fog);

  fragColor = vec4(lit, 1.0);
}`;

const DEPTH_VS = /* glsl */`#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uLightViewProj;
uniform mat4 uModel;
uniform vec2 uWorldOffset;
uniform float uSpacing;
void main(){
  vec3 world = vec3(aPos.x * uSpacing + uWorldOffset.x, aPos.y, aPos.z * uSpacing + uWorldOffset.y);
  gl_Position = uLightViewProj * uModel * vec4(world, 1.0);
}`;

const DEPTH_FS = /* glsl */`#version 300 es
precision highp float;
out vec4 fragColor;
void main(){ fragColor = vec4(1.0); }`;

const IDENTITY4 = (() => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; })();

/* clip-space plane extraction (Gribb–Hartmann), column-major viewProj */
function extractPlanes(m, out) {
  const row = (r) => [m[r], m[4 + r], m[8 + r], m[12 + r]];
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
  const put = (i, a, b, s) => {
    out[i * 4 + 0] = a[0] + s * b[0];
    out[i * 4 + 1] = a[1] + s * b[1];
    out[i * 4 + 2] = a[2] + s * b[2];
    out[i * 4 + 3] = a[3] + s * b[3];
  };
  put(0, r3, r0, 1);   // left
  put(1, r3, r0, -1);  // right
  put(2, r3, r1, 1);   // bottom
  put(3, r3, r1, -1);  // top
  put(4, r3, r2, 1);   // near
  put(5, r3, r2, -1);  // far
  return out;
}

function aabbVisible(planes, minX, minY, minZ, maxX, maxY, maxZ) {
  for (let i = 0; i < 6; i++) {
    const a = planes[i * 4], b = planes[i * 4 + 1], c = planes[i * 4 + 2], d = planes[i * 4 + 3];
    /* p-vertex: corner furthest along the plane normal */
    const px = a >= 0 ? maxX : minX;
    const py = b >= 0 ? maxY : minY;
    const pz = c >= 0 ? maxZ : minZ;
    if (a * px + b * py + c * pz + d < 0) return false;
  }
  return true;
}

/* ── Terrain: quadtree streaming ──────────────────────────────────────────── */

export class Terrain {
  constructor(gl) {
    this.gl = gl;
    this.prog = createProgram(gl, TERRAIN_VS, TERRAIN_FS);
    this.u = uniforms(gl, this.prog);
    this.depthProg = createProgram(gl, DEPTH_VS, DEPTH_FS);
    this.du = uniforms(gl, this.depthProg);
    this.indices = buildIndices();
    this.nodes = new Map();      // key → node
    this.buildQueue = [];
    this.fallbackSet = new Set();
    this.shadowMapSize = 2048;
    this.shadowTex = null;
    this.shadowFbo = null;
    this.makeShadowTexture(this.shadowMapSize);
    this.lightViewProj = m4identity();
    this.drawList = [];
    this.visited = new Set();
    this.splitState = new Map();
    this.frame = 0;
    this.firstBuild = true;
  }

  makeShadowTexture(size) {
    const gl = this.gl;
    this.shadowTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, size, size, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.shadowFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    /* dummy colour attachment: some drivers skip draws on colour-less FBOs */
    const dummy = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, dummy);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dummy, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  key(l, gx, gz) { return `${l}:${gx}:${gz}`; }

  buildChunk(l, gx, gz) {
    const size = sizeOf(l);
    const spacing = spacingOf(l);
    const minX = gx * size, minZ = gz * size;
    const verts = new Float32Array((VERTS * VERTS + VERTS * 8) * 6);
    const heights = new Float32Array(VERTS * VERTS);
    let w = 0;
    for (let j = 0; j < VERTS; j++) {
      const z = minZ + j * spacing;
      for (let i = 0; i < VERTS; i++) {
        heights[j * VERTS + i] = terrainHeight(minX + i * spacing, z);
      }
    }
    for (let j = 0; j < VERTS; j++) {
      for (let i = 0; i < VERTS; i++) {
        const h = heights[j * VERTS + i];
        const hl = i > 0 ? heights[j * VERTS + i - 1] : terrainHeight(minX - spacing, minZ + j * spacing);
        const hr = i < CELLS ? heights[j * VERTS + i + 1] : terrainHeight(minX + size + spacing, minZ + j * spacing);
        const hd = j > 0 ? heights[(j - 1) * VERTS + i] : terrainHeight(minX + i * spacing, minZ - spacing);
        const hu = j < CELLS ? heights[(j + 1) * VERTS + i] : terrainHeight(minX + i * spacing, minZ + size + spacing);
        let nx = (hl - hr), nz = (hd - hu), ny = 2 * spacing;
        const nl = Math.hypot(nx, ny, nz);
        nx /= nl; ny /= nl; nz /= nl;
        /* raw grid indices — the VS multiplies by uSpacing */
        verts[w++] = i; verts[w++] = h; verts[w++] = j;
        verts[w++] = nx; verts[w++] = ny; verts[w++] = nz;
      }
    }
    /* skirt: 4 edges × VERTS × (top copy, dropped copy) */
    const drop = Math.min(spacing * 2.5, 22);
    const emitSkirt = (i0, j0, di, dj) => {
      for (let k = 0; k < VERTS; k++) {
        const i = i0 + di * k, j = j0 + dj * k;
        const gi = (j * VERTS + i) * 6;
        verts[w++] = verts[gi]; verts[w++] = verts[gi + 1]; verts[w++] = verts[gi + 2];
        verts[w++] = verts[gi + 3]; verts[w++] = verts[gi + 4]; verts[w++] = verts[gi + 5];
        verts[w++] = verts[gi]; verts[w++] = verts[gi + 1] - drop; verts[w++] = verts[gi + 2];
        verts[w++] = verts[gi + 3]; verts[w++] = verts[gi + 4]; verts[w++] = verts[gi + 5];
      }
    };
    emitSkirt(0, 0, 1, 0);            // north edge (j=0)
    emitSkirt(0, CELLS, 1, 0);        // south edge
    emitSkirt(0, 0, 0, 1);            // west edge
    emitSkirt(CELLS, 0, 0, 1);        // east edge

    const gl = this.gl;
    const mesh = new Mesh(gl);
    mesh.attrib(0, 3); mesh.attrib(1, 3);
    mesh.upload(verts, this.indices);
    mesh.gridIndexCount = CELLS * CELLS * 6;  // grid only (no skirts) — used by shadow pass
    return { l, gx, gz, minX, minZ, size, spacing, mesh };
  }

  /* distance from a point to chunk AABB in xz */
  static aabbDist(px, pz, minX, minZ, size) {
    const dx = Math.max(minX - px, 0, px - (minX + size));
    const dz = Math.max(minZ - pz, 0, pz - (minZ + size));
    return Math.hypot(dx, dz);
  }

  /* build list of visible chunk nodes via recursive subdivision */
  update(px, pz, camY, budgetMs = 5) {
    this.frame++;
    this.buildQueue.length = 0;
    this.visited.clear();
    this.fallbackSet.clear();
    this.drawList.length = 0;

    const wantNode = (l, gx, gz) => {
      const k = this.key(l, gx, gz);
      this.visited.add(k);
      let node = this.nodes.get(k);
      if (!node) {
        this.buildQueue.push([l, gx, gz]);
        node = { l, gx, gz, key: k, size: sizeOf(l), spacing: spacingOf(l), minX: gx * sizeOf(l), minZ: gz * sizeOf(l), pending: true };
        this.nodes.set(k, node);
      }
      node.lastSeen = this.frame;
      /* freshly split chunks may not be built yet: fall back to the nearest
         built ancestor so the world never opens a hole while streaming. */
      let drawNode = node;
      if (!node.mesh) {
        let al = l + 1, agx = Math.floor(gx / 3), agz = Math.floor(gz / 3);
        while (al <= MAX_LEVEL) {
          const an = this.nodes.get(this.key(al, agx, agz));
          if (an && an.mesh) { drawNode = an; an.lastSeen = this.frame; break; }
          agx = Math.floor(agx / 3); agz = Math.floor(agz / 3); al++;
        }
      }
      if (!this.fallbackSet.has(drawNode.key)) {
        this.fallbackSet.add(drawNode.key);
        this.drawList.push(drawNode);
      }
      return node;
    };

    const rec = (l, gx, gz) => {
      const size = sizeOf(l);
      const minX = gx * size, minZ = gz * size;
      const d = Terrain.aabbDist(px, pz, minX, minZ, size);
      let willSplit = false;
      if (l > 0) {
        const hystKey = `${l}:${gx}:${gz}`;
        const wasSplit = this.splitState.get(hystKey) || false;
        const threshold = wasSplit ? 1.22 : 0.92;
        willSplit = d < size * threshold;
        this.splitState.set(hystKey, willSplit);
      }
      if (willSplit) {
        // children at level l-1 occupy indices 3gx .. 3gx+2
        for (let j = -1; j <= 1; j++)
          for (let i = -1; i <= 1; i++)
            rec(l - 1, gx * 3 + 1 + i, gz * 3 + 1 + j);
      } else {
        wantNode(l, gx, gz);
      }
    };

    // root grid: 3x3 at max level around the player's max-level chunk
    const rootSize = sizeOf(MAX_LEVEL);
    const rcx = Math.floor(px / rootSize), rcz = Math.floor(pz / rootSize);
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++)
        rec(MAX_LEVEL, rcx + i, rcz + j);

    /* GC + build with budget, nearest first */
    for (const [k, node] of this.nodes) {
      if (node.lastSeen !== undefined && this.frame - node.lastSeen > 180) {
        this.destroyNode(node);
        this.nodes.delete(k);
      }
    }
    this.buildQueue.sort((a, b) => {
      const sa = sizeOf(a[0]), sb = sizeOf(b[0]);
      const da = Terrain.aabbDist(px, pz, a[1] * sa, a[2] * sa, sa);
      const db = Terrain.aabbDist(px, pz, b[1] * sb, b[2] * sb, sb);
      return da - db;
    });
    const t0 = performance.now();
    const budget = this.firstBuild ? 1e9 : budgetMs;
    for (const [l, gx, gz] of this.buildQueue) {
      const k = this.key(l, gx, gz);
      const node = this.nodes.get(k);
      if (!node || !node.pending) continue;
      const built = this.buildChunk(l, gx, gz);
      node.mesh = built.mesh;
      node.pending = false;
      if (performance.now() - t0 > budget) break;
    }
    if (this.firstBuild && this.buildQueue.length && performance.now() - t0 > 2000) {
      /* keep draining on the first call until the world is there */
      this.update(px, pz, camY, budgetMs);
    }
    this.firstBuild = false;
  }

  destroyNode(node) {
    const gl = this.gl;
    if (node.mesh) {
      gl.deleteVertexArray(node.mesh.vao);
      gl.deleteBuffer(node.mesh.vbo);
      gl.deleteBuffer(node.mesh.ibo);
    }
  }

  /* pending nodes are drawn via parent fallback — handled by traversal order:
     a pending node still added to drawList; if its mesh is missing, skip. */

  computeLightMatrix(lightDir, camPos, size = 320) {
    const center = [camPos[0] + lightDir[0] * 140, camPos[1], camPos[2] + lightDir[2] * 140];
    const eye = v3.mad(center, lightDir, 500);
    const view = m4lookAt(eye, center, [0, 1, 0]);
    const half = size / 2;
    const proj = m4ortho(-half, half, -half, half, 10, 1100);
    this.lightViewProj = m4mul(proj, view);
  }

  renderShadow() {
    const gl = this.gl;
    gl.useProgram(this.depthProg);
    gl.uniformMatrix4fv(this.du.uLightViewProj, false, this.lightViewProj);
    gl.uniformMatrix4fv(this.du.uModel, false, IDENTITY4);
    for (const n of this.drawList) {
      if (!n.mesh) continue;
      gl.uniform2f(this.du.uWorldOffset, n.minX, n.minZ);
      gl.uniform1f(this.du.uSpacing, n.spacing);
      /* grid triangles only — skirts must not cast shadows */
      n.mesh.draw(n.mesh.gridIndexCount);
    }
  }

  draw(env) {
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u.uViewProj, false, env.viewProj);
    gl.uniformMatrix4fv(this.u.uLightViewProj, false, this.lightViewProj);
    gl.uniform3fv(this.u.uLightDir, env.lightDir);
    gl.uniform3fv(this.u.uSunColor, env.sunColor);
    gl.uniform3fv(this.u.uSkyAmbient, env.skyAmbient);
    gl.uniform3fv(this.u.uGroundAmbient, env.groundAmbient);
    gl.uniform3fv(this.u.uFogColor, env.fogColor);
    gl.uniform1f(this.u.uFogDensity, env.fogDensity);
    gl.uniform3fv(this.u.uCamPos, env.camPos);
    gl.uniform1f(this.u.uWaterLevel, WORLD.WATER_LEVEL);
    gl.uniform1f(this.u.uTime, env.time);
    gl.uniform1f(this.u.uShadowTexel, 1 / this.shadowMapSize);
    gl.uniform1f(this.u.uShadowExtent, env.shadowExtent || 320);
    gl.uniformMatrix4fv(this.u.uLightViewProjM, false, this.lightViewProj);
    gl.uniform3fv(this.u.uGliderPos, env.gliderPos || [0, 0, 0]);
    gl.uniform1f(this.u.uSunVisibility, env.sunVisibility !== undefined ? env.sunVisibility : 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.uniform1i(this.u.uShadowMap, 0);
    this._planes = this._planes || new Float32Array(24);
    extractPlanes(env.viewProj, this._planes);
    let draws = 0, culled = 0;
    for (const n of this.drawList) {
      if (!n.mesh) continue;
      if (!aabbVisible(this._planes, n.minX, -400, n.minZ, n.minX + n.size, 1100, n.minZ + n.size)) { culled++; continue; }
      gl.uniform2f(this.u.uWorldOffset, n.minX, n.minZ);
      gl.uniform1f(this.u.uSpacing, n.spacing);
      n.mesh.draw();
      draws++;
    }
    this.lastDraws = draws;
    this.lastCulled = culled;
  }
}
