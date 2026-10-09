/* ─────────────────────────────────────────────────────────────────────────────
   VESPER · main.js — bootstrap
   ───────────────────────────────────────────────────────────────────────────── */

import { mulberry32, hashString } from './engine.js';
import { Terrain, WORLD, terrainHeight } from './world.js';
import { Sky } from './sky.js';
import { Renderer, computeEnv } from './render.js';
import { Entities } from './entities.js';
import { AudioEngine } from './audio.js';
import { Game } from './game.js';

const params = new URLSearchParams(location.search);
const P = (k, d) => (params.has(k) ? parseFloat(params.get(k)) : d);
const seedName = (params.get('seed') || 'vesper-dawn').slice(0, 64);

const canvas = document.getElementById('gl');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
if (!gl) {
  const el = document.getElementById('err');
  el.style.display = 'block';
  el.textContent = 'WebGL2 is not available in this browser.';
  throw new Error('no webgl2');
}

/* a lost GPU context should not leave the player staring at a dead canvas */
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  const el = document.getElementById('err');
  el.style.display = 'block';
  el.textContent = 'The graphics context was lost — restoring the world…';
  setTimeout(() => location.reload(), 900);
});

window.addEventListener('error', (e) => {
  const el = document.getElementById('err');
  el.style.display = 'block';
  el.textContent += (el.textContent ? '\n' : '') + String(e.message || e);
});

const rng = mulberry32(hashString(seedName));

/* ── spawn: a dune-belt valley with mountains as a backdrop ── */
let spawn = [0, 0, 0];
{
  let best = null;
  for (let i = 0; i < 900; i++) {
    const x = (rng() - 0.5) * 60000, z = (rng() - 0.5) * 60000;
    const h = terrainHeight(x, z);
    if (h < WORLD.WATER_LEVEL + 15 || h > WORLD.WATER_LEVEL + 90) continue;
    let mn = h, mx = h;
    for (let k = 0; k < 12; k++) {
      const hh = terrainHeight(x + (rng() - 0.5) * 500, z + (rng() - 0.5) * 500);
      mn = Math.min(mn, hh); mx = Math.max(mx, hh);
    }
    const relief = mx - mn;
    const hn = terrainHeight(x, z - 1200);
    if (relief < 12 || relief > 70) continue;
    if (hn - h < 180 || hn - h > 500) continue;
    const score = relief * 2 + (hn - h) * 0.3 - Math.abs(h - (WORLD.WATER_LEVEL + 40)) * 0.4;
    if (!best || score > best.score) best = { x, z, h, score };
  }
  if (best) spawn = [best.x, best.h + 42, best.z];
}
console.log('[vesper] spawn', spawn.map(x => x.toFixed(0)).join(','));

/* ── systems ── */
const terrain = new Terrain(gl);
const sky = new Sky(gl);
const renderer = new Renderer(gl, canvas);
renderer.attach(terrain, sky);
const entities = new Entities(gl);
entities.populate(spawn, (hashString(seedName) ^ 0x9e3779b9) >>> 0);
const audio = new AudioEngine();

const game = new Game({
  renderer, terrain, sky, entities, audio, canvas, gl, spawn,
  envFn: computeEnv,
  dayT: P('t', 0.93),
  seedName,
});
game.saveKey = 'vesper:save:' + seedName;
game.loadGame();

/* stored options */
const OPT_KEY = 'vesper:opts';
const PIXEL_PRESETS = { chunky: 320, classic: 480, fine: 720 };
const PALETTE_PRESETS = { smooth: 0, dusk: 1, ember: 2, mono: 3 };
let opts = { sens: 1, invert: false, autoq: true, quality: 1, pixel: 480, palette: 1 };
try { opts = Object.assign(opts, JSON.parse(localStorage.getItem(OPT_KEY) || '{}')); } catch (e) {}
if (params.has('pixel')) {
  const v = params.get('pixel');
  opts.pixel = PIXEL_PRESETS[v] || parseInt(v, 10) || 480;
}
if (params.has('palette')) {
  const v = params.get('palette');
  const byName = PALETTE_PRESETS[v];
  opts.palette = byName !== undefined ? byName : (parseInt(v, 10) || 0);
}
game.input.sensitivity = opts.sens;
game.input.invertY = !!opts.invert;
if (!opts.autoq) { renderer.quality = opts.quality; game.qualityLock = true; }
renderer.capPixels = opts.pixel;
renderer.palette = opts.palette;

/* phones: thumbs, not keyboards */
const coarsePointer = window.matchMedia && matchMedia('(hover: none) and (pointer: coarse)').matches;
if (coarsePointer) {
  const hint = document.getElementById('hint');
  const tips = document.getElementById('tips');
  if (hint) hint.textContent = 'TAP TO BEGIN';
  if (tips) tips.textContent = 'drag to steer · BURN for speed · wake the beacons';
  document.getElementById('boost-btn').style.display = 'flex';
  document.getElementById('menu-btn').style.display = 'flex';
}

window.__game = game;
window.__terrain = terrain;
window.__renderer = renderer;
window.__terrainHeight = terrainHeight;
window.__gl2 = gl;
game.raw = params.has('raw');

const bt0 = performance.now();
terrain.update(spawn[0], spawn[2], spawn[1], 1e9);
console.log('[vesper] world built in', (performance.now() - bt0).toFixed(0) + 'ms',
  terrain.drawList.length, 'chunks ·', 'hdr:', renderer.hdr ? 'yes' : 'no');

/* ── resize ── */
function resize() {
  game.width = innerWidth;
  game.height = innerHeight;
}
addEventListener('resize', resize);
resize();

/* ── main loop ── */
let last = performance.now();
let statTimer = 0, tuneTimer = 0;
function frame() {
  const now = performance.now();
  let dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  try {
    game.update(dt);
    terrain.update(game.camera.pos[0], game.camera.pos[2], game.camera.pos[1], 5);
    renderer.renderFrame(game);

    /* fps + autotune */
    game.fps = game.fps + (1 / Math.max(dt, 1e-3) - game.fps) * 0.05;
    tuneTimer += dt;
    if (tuneTimer > 2.5) {
      tuneTimer = 0;
      if (!game.qualityLock) {
        if (game.fps < 34 && renderer.quality > 0.62) renderer.quality = Math.max(0.62, renderer.quality - 0.13);
        else if (game.fps > 55 && renderer.quality < 1.0) renderer.quality = Math.min(1.0, renderer.quality + 0.06);
      }
      game.stats.chunks = terrain.drawList.length;
    }
    statTimer += dt;
    const dbg = document.getElementById('dbg');
    if (dbg) {
      if (game.showStats) {
        if (statTimer > 0.25) {
          statTimer = 0;
          dbg.textContent = `${game.fps.toFixed(0)} fps · ${game.stats.chunks} chunks · ${game.entities.particles.length} particles · q${renderer.quality.toFixed(2)} · ${game.entities.birdCount} birds`;
        }
        dbg.style.display = 'block';
      } else dbg.style.display = 'none';
    }
  } catch (e) {
    const el = document.getElementById('err');
    el.style.display = 'block';
    el.textContent = 'render error: ' + (e.message || e);
    throw e;
  }
  requestAnimationFrame(frame);
}
frame();

addEventListener('keydown', (e) => {
  if (e.code === 'F3') {
    e.preventDefault();
    game.showStats = !game.showStats;
  }
});

/* ── settings overlay ── */
const overlay = document.getElementById('settings');
const setMeta = document.getElementById('set-meta');
const OPT_KEY_CHECK = () => { try { localStorage.setItem(OPT_KEY, JSON.stringify(opts)); } catch (e) {} };
function openSettings(open) {
  overlay.classList.toggle('on', open);
  if (open && setMeta) {
    setMeta.textContent = `seed “${seedName}” · ${game.beaconsLit} / 5 beacons · ${game.foundLore || 0} stones found`;
  }
}
addEventListener('keydown', (e) => {
  if (e.code === 'KeyO') openSettings(!overlay.classList.contains('on'));
  if (e.code === 'Escape' && overlay.classList.contains('on')) openSettings(false);
});
document.getElementById('set-close').addEventListener('click', () => openSettings(false));
document.getElementById('set-sens').addEventListener('input', (e) => {
  opts.sens = parseFloat(e.target.value);
  game.input.sensitivity = opts.sens;
  OPT_KEY_CHECK();
});
document.getElementById('set-invert').addEventListener('change', (e) => {
  opts.invert = e.target.checked;
  game.input.invertY = opts.invert;
  OPT_KEY_CHECK();
});
document.getElementById('set-autoq').addEventListener('change', (e) => {
  opts.autoq = e.target.checked;
  game.qualityLock = !opts.autoq;
  if (opts.autoq) { renderer.quality = 1; opts.quality = 1; document.getElementById('set-quality').value = 1; }
  OPT_KEY_CHECK();
});
document.getElementById('set-quality').addEventListener('input', (e) => {
  opts.quality = parseFloat(e.target.value);
  renderer.quality = opts.quality;
  if (opts.autoq) {
    opts.autoq = false;
    game.qualityLock = true;
    document.getElementById('set-autoq').checked = false;
  }
  OPT_KEY_CHECK();
});
document.getElementById('set-pixel').addEventListener('change', (e) => {
  opts.pixel = parseInt(e.target.value, 10);
  renderer.capPixels = opts.pixel;
  OPT_KEY_CHECK();
});
document.getElementById('set-palette').addEventListener('change', (e) => {
  opts.palette = parseInt(e.target.value, 10);
  renderer.palette = opts.palette;
  OPT_KEY_CHECK();
});
document.getElementById('set-new').addEventListener('click', () => {
  try { localStorage.removeItem(game.saveKey); } catch (e) {}
  location.reload();
});
document.getElementById('set-sens').value = opts.sens;
document.getElementById('set-invert').checked = !!opts.invert;
document.getElementById('set-autoq').checked = !!opts.autoq;
document.getElementById('set-quality').value = opts.quality;
document.getElementById('set-pixel').value = String(opts.pixel);
document.getElementById('set-palette').value = String(opts.palette);

/* the settings button is the phone's only menu */
document.getElementById('menu-btn').addEventListener('click', () => {
  openSettings(!overlay.classList.contains('on'));
});

/* save the day position on the way out */
addEventListener('beforeunload', () => game.saveGame());

/* test hooks */
window.__sim = (steps, dt = 0.016) => game.stepSim(steps, dt);
window.__render = () => renderer.renderFrame(game);
window.__read = (x0, y0, w, h) => {
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const out = [];
  for (let i = 0; i < w * h; i++) out.push([px[i*4], px[i*4+1], px[i*4+2]]);
  return out;
};
if (params.has('autoplay')) {
  setTimeout(() => {
    game.state = 'flying';
    document.getElementById('veil').classList.add('gone');
    document.getElementById('hint').classList.add('gone');
    document.getElementById('colophon').classList.add('gone');
    document.getElementById('hud').classList.add('on');
    try { audio.start(); } catch (e) {}
  }, 300);
}
