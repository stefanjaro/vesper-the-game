/* ─────────────────────────────────────────────────────────────────────────────
   VESPER · engine.js
   Math, deterministic noise, and thin WebGL2 helpers.
   Everything here is written from scratch — no libraries, no assets.
   ───────────────────────────────────────────────────────────────────────────── */

/* ── vec3 (plain arrays: [x,y,z]) ─────────────────────────────────────────── */

export const v3 = {
  set: (x, y, z) => [x, y, z],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  mad: (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  len2: (a) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2],
  norm: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  lerp: (a, b, t) => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ],
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  dist2: (a, b) => {
    const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2];
    return x * x + y * y + z * z;
  },
};

/* ── misc math ────────────────────────────────────────────────────────────── */

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const smootherstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
export const mix = {
  color: (a, b, t) => [
    lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t),
  ],
};
/* frame-rate independent exponential approach */
export const damp = (cur, target, lambda, dt) =>
  lerp(cur, target, 1 - Math.exp(-lambda * dt));

/* deterministic PRNG (mulberry32) */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* ── 4×4 matrices, column-major, WebGL layout ─────────────────────────────── */

export function m4identity() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function m4mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    o[c * 4 + 0] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    o[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    o[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    o[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return o;
}

export function m4perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f;
  m[10] = (far + near) * nf; m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

export function m4ortho(l, r, b, t, n, f) {
  const m = new Float32Array(16);
  m[0] = 2 / (r - l); m[5] = 2 / (t - b); m[10] = -2 / (f - n);
  m[12] = -(r + l) / (r - l); m[13] = -(t + b) / (t - b); m[14] = -(f + n) / (f - n);
  m[15] = 1;
  return m;
}

export function m4lookAt(eye, center, up) {
  const z = v3.norm(v3.sub(eye, center));
  let x = v3.cross(up, z);
  if (v3.len2(x) < 1e-8) x = v3.cross([0, 0, 1], z); // looking straight up/down
  x = v3.norm(x);
  const y = v3.cross(z, x);
  const m = m4identity();
  m[0] = x[0]; m[1] = y[0]; m[2] = z[0];
  m[4] = x[1]; m[5] = y[1]; m[6] = z[1];
  m[8] = x[2]; m[9] = y[2]; m[10] = z[2];
  m[12] = -v3.dot(x, eye); m[13] = -v3.dot(y, eye); m[14] = -v3.dot(z, eye);
  return m;
}

/* build model matrix from position + basis vectors */
export function m4basis(pos, x, y, z, scale = 1) {
  const m = m4identity();
  m[0] = x[0] * scale; m[1] = x[1] * scale; m[2] = x[2] * scale;
  m[4] = y[0] * scale; m[5] = y[1] * scale; m[6] = y[2] * scale;
  m[8] = z[0] * scale; m[9] = z[1] * scale; m[10] = z[2] * scale;
  m[12] = pos[0]; m[13] = pos[1]; m[14] = pos[2];
  return m;
}

export function m4rotY(a) {
  const m = m4identity();
  const c = Math.cos(a), s = Math.sin(a);
  m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
  return m;
}

/* general 4×4 inverse (Gauss-Jordan with partial pivoting) */
export function m4inverse(m) {
  const a = [...m];
  const inv = m4identity();
  for (let col = 0; col < 4; col++) {
    let piv = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(a[r * 4 + col]) > Math.abs(a[piv * 4 + col])) piv = r;
    if (Math.abs(a[piv * 4 + col]) < 1e-12) return m4identity();
    if (piv !== col) {
      for (let k = 0; k < 4; k++) {
        const t1 = a[col * 4 + k]; a[col * 4 + k] = a[piv * 4 + k]; a[piv * 4 + k] = t1;
        const t2 = inv[col * 4 + k]; inv[col * 4 + k] = inv[piv * 4 + k]; inv[piv * 4 + k] = t2;
      }
    }
    const d = a[col * 4 + col];
    for (let k = 0; k < 4; k++) { a[col * 4 + k] /= d; inv[col * 4 + k] /= d; }
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const f = a[r * 4 + col];
      if (f === 0) continue;
      for (let k = 0; k < 4; k++) {
        a[r * 4 + k] -= a[col * 4 + k] * f;
        inv[r * 4 + k] -= inv[col * 4 + k] * f;
      }
    }
  }
  return inv;
}

/* ── deterministic 2D value noise + fbm/ridged ──────────────────────────────
   Used by terrain generation, prop placement, thermals. Fast integer hashing.
   ──────────────────────────────────────────────────────────────────────────── */

const NOISE_SEED = 1717;

function hash2i(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296; // 0..1
}

function quintic(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

/* value noise, 0..1, smooth */
export function noise2(x, y, seed = NOISE_SEED) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = quintic(fx), v = quintic(fy);
  const a = hash2i(ix, iy, seed);
  const b = hash2i(ix + 1, iy, seed);
  const c = hash2i(ix, iy + 1, seed);
  const d = hash2i(ix + 1, iy + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/* fbm 0..1 */
export function fbm2(x, y, oct = 4, seed = NOISE_SEED, lac = 2, gain = 0.5) {
  let s = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < oct; i++) {
    s += noise2(x, y, seed + i * 101) * amp;
    norm += amp;
    x *= lac; y *= lac; amp *= gain;
  }
  return s / norm;
}

/* ridged multifractal 0..1 with sharp crests */
export function ridged2(x, y, oct = 4, seed = NOISE_SEED) {
  let s = 0, amp = 0.5, norm = 0, prev = 1;
  for (let i = 0; i < oct; i++) {
    let n = noise2(x, y, seed + i * 131);
    n = 1 - Math.abs(2 * n - 1); // crest
    n *= n;
    s += n * amp * prev;
    prev = n;
    norm += amp;
    x *= 2; y *= 2; amp *= 0.55;
  }
  return clamp01(s / norm);
}

/* ── tiny GL helpers ──────────────────────────────────────────────────────── */

export function createProgram(gl, vsSrc, fsSrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    throw new Error('program link failed: ' + log);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return p;
}

function compileShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    const numbered = src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
    throw new Error(`${kind} shader compile failed:\n${log}\n${numbered}`);
  }
  return s;
}

/* lazily-cached uniform locations */
export function uniforms(gl, prog) {
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  const map = {};
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i);
    const name = info.name.replace(/\[0\]$/, '');
    map[name] = gl.getUniformLocation(prog, name);
  }
  return map;
}

/* interleaved dynamic VBO helper */
export class Mesh {
  constructor(gl, { dynamic = false } = {}) {
    this.gl = gl;
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    this.ibo = gl.createBuffer();
    this.count = 0;
    this.mode = gl.TRIANGLES;
    this.usage = dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW;
    this.attribs = [];
  }
  upload(data, indexData) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, this.usage);
    let stride = 0, offset = 0;
    for (const a of this.attribs) stride += a.size * 4;
    for (const a of this.attribs) {
      gl.enableVertexAttribArray(a.loc);
      gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, stride, offset);
      offset += a.size * 4;
    }
    if (indexData) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexData, this.usage);
      this.count = indexData.length;
      this.hasIndex = true;
    } else {
      this.count = data.length / (stride / 4);
    }
    gl.bindVertexArray(null);
    return this;
  }
  attrib(loc, size) { this.attribs.push({ loc, size }); return this; }
  draw(count = null) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    if (this.hasIndex) {
      gl.drawElements(gl.TRIANGLES, count ?? this.count, gl.UNSIGNED_INT, 0);
    } else {
      gl.drawArrays(this.mode, 0, count ?? this.count);
    }
    gl.bindVertexArray(null);
  }
}

/* render target helper */
export function createRenderTarget(gl, w, h, { internalFormat = gl.RGBA8, filter = gl.LINEAR, depth = false, wrap = gl.CLAMP_TO_EDGE } = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, gl.RGBA, internalFormat === gl.RGBA8 ? gl.UNSIGNED_BYTE : gl.HALF_FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  let depthTex = null;
  if (depth) {
    depthTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, depthTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTex, 0);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo, depthTex, w, h };
}

export function deleteRenderTarget(gl, rt) {
  if (!rt) return;
  gl.deleteFramebuffer(rt.fbo);
  gl.deleteTexture(rt.tex);
  if (rt.depthTex) gl.deleteTexture(rt.depthTex);
}

export function resizeRenderTarget(gl, rt, w, h, opts) {
  if (rt && rt.w === w && rt.h === h) return rt;
  if (rt) deleteRenderTarget(gl, rt);
  return createRenderTarget(gl, w, h, opts);
}

/* fullscreen triangle */
export function createFullscreenMesh(gl) {
  const mesh = new Mesh(gl);
  mesh.attrib(0, 2);
  mesh.upload(new Float32Array([
    -1, -1,
    3, -1,
    -1, 3,
  ]));
  return mesh;
}
