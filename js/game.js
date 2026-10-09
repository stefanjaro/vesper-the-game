/* ─────────────────────────────────────────────────────────────────────────────
   VESPER · game.js
   The flight: the manta's motion, the chase camera, input, and the quiet
   quest of gathering light and waking the beacons.
   ───────────────────────────────────────────────────────────────────────────── */

import { v3, clamp, clamp01, lerp, smoothstep, damp, mulberry32, m4basis } from './engine.js';
import { terrainHeight, WORLD, moistureAt } from './world.js';

/* weather kinds and their target intensities [storm, rain, dust] */
const WEATHER = {
  clear: { storm: 0.0, rain: 0.0, dust: 0.0, ember: 0.0 },
  haze: { storm: 0.25, rain: 0.0, dust: 0.45, ember: 0.0 },
  dust: { storm: 0.75, rain: 0.0, dust: 0.9, ember: 0.0 },
  rain: { storm: 0.45, rain: 0.75, dust: 0.0, ember: 0.0 },
  storm: { storm: 1.0, rain: 0.95, dust: 0.12, ember: 1.0 },
};

const GRAV = 9.8;
export const BEACON_COSTS = [4, 10, 18, 28, 40];

export class Ship {
  constructor(spawn) {
    this.pos = [...spawn];
    this.pos[1] = Math.max(terrainHeight(spawn[0], spawn[2]) + 60, WORLD.WATER_LEVEL + 60);
    this.yaw = 0;          // radians, 0 = +Z
    this.pitch = 0.04;
    this.roll = 0;
    this.speed = 26;
    this.energy = 30;
    this.flapPhase = Math.random() * 6.28;
    this.lowTimer = 0;
  }

  basis() {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const fwd = [sy * cp, sp, cy * cp];
    const right0 = [cy, 0, -sy];
    const up0 = v3.cross(fwd, right0);
    const cr = Math.cos(this.roll), sr = Math.sin(this.roll);
    const right = v3.mad(right0, up0, sr);
    const up = v3.mad(up0, right0, -sr);
    return { fwd, right, up };
  }

  matrix() {
    const b = this.basis();
    return m4basis(this.pos, b.right, b.up, b.fwd, 1.5);
  }

  wingTip(w) {
    const b = this.basis();
    const local = w === 0 ? [2.6, 0.16, 0.1] : [-2.6, 0.16, 0.1];
    const m = this.matrix();
    return [
      m[0] * local[0] + m[4] * local[1] + m[8] * local[2] + m[12],
      m[1] * local[0] + m[5] * local[1] + m[9] * local[2] + m[13],
      m[2] * local[0] + m[6] * local[1] + m[10] * local[2] + m[14],
    ];
  }
}

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.roll = 0; this.pitch = 0; this.boost = false;
    this.keys = {};
    this.mouseDX = 0; this.mouseDY = 0;
    this.pointerLocked = false;
    this.touch = { active: false, dx: 0, dy: 0 };
    this.touchBoost = false;
    this.gamepad = null;
    this.sensitivity = 1;
    this.invertY = false;

    const boostBtn = document.getElementById('boost-btn');
    if (boostBtn) {
      const on = (e) => { this.touchBoost = true; e.preventDefault(); };
      const off = () => { this.touchBoost = false; };
      boostBtn.addEventListener('pointerdown', on);
      boostBtn.addEventListener('pointerup', off);
      boostBtn.addEventListener('pointercancel', off);
      boostBtn.addEventListener('pointerleave', off);
    }

    addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      if (e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => { this.keys[e.code] = false; });

    canvas.addEventListener('click', () => {
      if (!this.pointerLocked && canvas.requestPointerLock) {
        canvas.requestPointerLock();
      }
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === canvas;
    });
    document.addEventListener('mousemove', (e) => {
      if (this.pointerLocked) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });

    /* touch steering */
    let lastTouch = null;
    canvas.addEventListener('touchstart', (e) => {
      lastTouch = e.touches[0];
      this.touch.active = true;
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      if (lastTouch) {
        this.touch.dx += (t.clientX - lastTouch.clientX) * 2.4;
        this.touch.dy += (t.clientY - lastTouch.clientY) * 2.4;
      }
      lastTouch = t;
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchend', () => { this.touch.active = false; lastTouch = null; });
  }

  sample(dt) {
    /* accumulate → smooth axis values */
    const K = this.keys;
    let r = (K['ArrowLeft'] || K['KeyA'] ? -1 : 0) + (K['ArrowRight'] || K['KeyD'] ? 1 : 0);
    let p = (K['ArrowUp'] || K['KeyW'] ? 1 : 0) + (K['ArrowDown'] || K['KeyS'] ? -1 : 0);
    let boost = !!(K['ShiftLeft'] || K['ShiftRight'] || K['Space']);

    /* gamepad (first connected pad): left stick + RT/A */
    const pads = navigator.getGamepads ? navigator.getGamepads() : null;
    const gp = pads && pads[0];
    if (gp) {
      const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      r += Math.abs(ax) > 0.12 ? ax : 0;
      p += Math.abs(ay) > 0.12 ? -ay : 0;
      boost = boost || !!(gp.buttons[7] && gp.buttons[7].pressed) || !!(gp.buttons[0] && gp.buttons[0].pressed);
      this.gamepad = gp;
    }

    const sign = this.invertY ? -1 : 1;
    r += this.mouseDX * 0.055 * this.sensitivity;
    p += -this.mouseDY * 0.045 * this.sensitivity * sign;  // mouse up = climb
    if (this.touch.active) {
      r += this.touch.dx * 0.045;
      p += -this.touch.dy * 0.04 * sign;   // same convention as the mouse
      this.touch.dx *= 0.4; this.touch.dy *= 0.4;
    }
    this.mouseDX *= Math.exp(-dt * 22);
    this.mouseDY *= Math.exp(-dt * 22);

    this.roll = clamp(r, -1, 1);
    this.pitch = clamp(p, -1, 1);
    this.boost = boost || this.touchBoost;
  }
}

/* ── the Game ─────────────────────────────────────────────────────────────── */

export class Game {
  constructor(deps) {
    Object.assign(this, deps);   // renderer, terrain, sky, entities, audio, canvas
    deps.entities.game = this;
    if (deps.dayT !== undefined) this.dayT = deps.dayT;
    this.time = 0;
    this.state = 'title';        // title | flying | paused | finale
    this.width = innerWidth; this.height = innerHeight;
    this.env = null;
    this.frame = 0;
    this.flash = 0;    this.worldFogDensity = 0.00023;
    this.shadowExtent = 320;
    this.shardsCollected = 0;
    this.beaconsLit = 0;
    this.glowPulse = 0;
    this.photoMode = false;
    this.photoCam = false;
    this.photoFilter = 0;
    this.paused = false;
    this.fps = 60;
    this.stats = { chunks: 0, draws: 0, ms: 16 };
    this.spawn = deps.spawn;
    this.ship = new Ship(deps.spawn);
    this.input = new Input(deps.canvas);
    this.weather = {
      kind: 'clear',
      windAngle: 0.7,
      storm: 0, rain: 0, dust: 0,
      tStorm: 0, tRain: 0, tDust: 0,
      nextChange: 35 + Math.random() * 40,
      nextBolt: 0,
    };
    this.eclipsePhase = 'wait';
    this.eclipseT = 70 + Math.random() * 80;
    this.eclipse = 0;              // 0..1 how deeply the sun is swallowed
    this.eclipseDark = 0;
    this.camera = { pos: [...this.ship.pos], look: [...this.ship.pos], fov: 1.12, shake: 0 };
    this.camVel = [0, 0, 0];
    this.thermals = deps.entities.thermals;
    this.beacons = deps.entities.beacons;

    /* click to begin */
    const begin = () => {
      if (this.state === 'title') {
        this.state = 'flying';
        document.getElementById('veil').classList.add('gone');
        document.getElementById('hint').classList.add('gone');
        document.getElementById('colophon').classList.add('gone');
        document.getElementById('hud').classList.add('on');
        this.audio.start();
        this.audio.setProgress(this.beaconsLit);
        /* fade the tips in, then out again */
        const tips = document.getElementById('tips');
        tips.style.opacity = 0.8;
        setTimeout(() => { tips.style.opacity = 0; }, 11000);
      } else if (this.paused) {
        this.paused = false;
        document.getElementById('pause').classList.remove('on');
      }
    };
    this.canvas.addEventListener('click', begin);
    addEventListener('keydown', (e) => {
      if (e.code === 'KeyP') {
        if (this.state !== 'title') {
          this.paused = !this.paused;
          document.getElementById('pause').classList.toggle('on', this.paused);
        }
      }
      if (e.code === 'KeyH') {
        this.photoMode = !this.photoMode;
        document.getElementById('hud').classList.toggle('on', !this.photoMode && !this.photoCam && this.state === 'flying');
      }
      if (e.code === 'KeyM') this.audio.setMuted(!this.audio.muted);
      if (e.code === 'KeyC') this.togglePhotoCam();
      if (e.code === 'KeyF' && this.photoCam) this.photoFilter = ((this.photoFilter || 0) + 1) % 5;
      if (e.code === 'BracketLeft' && this.photoCam) this.dayT = ((this.dayT - 0.01) % 2 + 2) % 2;
      if (e.code === 'BracketRight' && this.photoCam) this.dayT = ((this.dayT + 0.01) % 2 + 2) % 2;
      if (e.code === 'F2') { e.preventDefault(); if (this.photoCam) this.capturePhoto(); }
      if (e.code === 'Enter' && this.state === 'title') begin();
    });
    this.canvas.addEventListener('wheel', (e) => {
      if (!this.photoCam) return;
      e.preventDefault();
      this.photoFov = clamp((this.photoFov || this.camera.fov) + e.deltaY * 0.0009, 0.32, 2.4);
    }, { passive: false });
  }

  /* ── free camera photo mode ── */
  togglePhotoCam() {
    if (this.state === 'title') return;
    this.photoCam = !this.photoCam;
    document.getElementById('hud').classList.toggle('on', !this.photoCam && !this.photoMode && this.state === 'flying');
    document.getElementById('photo-bar').classList.toggle('on', this.photoCam);
    document.getElementById('boost-btn').style.opacity = this.photoCam ? '0' : '';
    if (this.photoCam) {
      this.photoFov = this.camera.fov;
      const d = v3.norm(v3.sub(this.camera.look, this.camera.pos));
      this.camYaw = Math.atan2(d[0], d[2]);
      this.camPitch = Math.asin(clamp(d[1], -1, 1));
      this.photoFilter = this.photoFilter || 0;
    }
    this.input.mouseDX = 0; this.input.mouseDY = 0;
  }

  stepPhotoCam(dt) {
    const c = this.camera;
    const K = this.input.keys;
    if (this.photoFov === undefined) this.photoFov = c.fov;
    if (this.camYaw === undefined) this.camYaw = 0;
    if (this.camPitch === undefined) this.camPitch = 0;
    this.camYaw -= this.input.mouseDX * 0.0026;
    this.camPitch = clamp(this.camPitch - this.input.mouseDY * 0.0023, -1.42, 1.42);
    const speed = 34 * ((K['ShiftLeft'] || K['ShiftRight']) ? 4 : 1);
    const cy = Math.cos(this.camYaw), sy = Math.sin(this.camYaw);
    const cp = Math.cos(this.camPitch), sp = Math.sin(this.camPitch);
    const fwd = [sy * cp, sp, cy * cp];
    const right = [cy, 0, -sy];
    let move = [0, 0, 0];
    if (K['KeyW'] || K['ArrowUp']) move = v3.add(move, fwd);
    if (K['KeyS'] || K['ArrowDown']) move = v3.sub(move, fwd);
    if (K['KeyD'] || K['ArrowRight']) move = v3.add(move, right);
    if (K['KeyA'] || K['ArrowLeft']) move = v3.sub(move, right);
    if (K['KeyE'] || K['Space']) move[1] += 1;
    if (K['KeyQ'] || K['ControlLeft']) move[1] -= 1;
    const m = v3.norm(move);
    if (m[0] || m[1] || m[2]) c.pos = v3.mad(c.pos, m, speed * dt);
    c.look = v3.add(c.pos, fwd);
    c.fov = damp(c.fov, this.photoFov, 10, dt);
    this.camera.shake = 0;

    /* photo bar readout */
    const elF = document.getElementById('photo-fov');
    const elX = document.getElementById('photo-filter');
    const FILTERS = ['NATURAL', 'AMBER', 'NOCTURNE', 'SUNBLEACH', 'EMBER'];
    if (elF) elF.textContent = `FOV ${Math.round(c.fov * 180 / Math.PI)}°`;
    if (elX) elX.textContent = FILTERS[this.photoFilter || 0];
  }

  capturePhoto() {
    const gl = this.gl;
    const renderer = this.renderer;
    if (!gl || !renderer) return;
    renderer.renderFrame(this);
    const w = this.canvas.width, h = this.canvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const c2 = document.createElement('canvas');
    c2.width = w; c2.height = h;
    const ctx = c2.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4;
      img.data.set(px.subarray(src, src + w * 4), y * w * 4);
    }
    ctx.putImageData(img, 0, 0);
    const a = document.createElement('a');
    a.href = c2.toDataURL('image/png');
    a.download = `vesper-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    a.click();
  }

  /* ── persistence (per seed) ── */
  saveGame() {
    if (!this.saveKey) return;
    try {
      const shards = [];
      this.entities.shards.forEach((s, i) => { if (!s.alive) shards.push(i); });
      const lore = [];
      (this.entities.stones || []).forEach((st, i) => { if (st.seen) lore.push(i); });
      const litIdx = [];
      this.entities.beacons.forEach((b, i) => { if (b.target === 1) litIdx.push(i); });
      localStorage.setItem(this.saveKey, JSON.stringify({
        v: 3,
        lit: this.beaconsLit,
        litIdx,
        shards,
        lore,
        dayT: +this.dayT.toFixed(4),
      }));
    } catch (e) { /* private mode */ }
  }

  loadGame() {
    if (!this.saveKey) return;
    try {
      const raw = localStorage.getItem(this.saveKey);
      if (!raw) return;
      const d = JSON.parse(raw);
      /* v3 saves which beacons were lit; older saves only the count */
      const litIdx = Array.isArray(d.litIdx)
        ? d.litIdx.slice(0, this.entities.beacons.length)
        : Array.from({ length: Math.min(d.lit | 0, this.entities.beacons.length) }, (_, i) => i);
      for (const i of litIdx) {
        const b = this.entities.beacons[i];
        if (b) { b.target = 1; b.lit = 1; b.charge = 1; }
      }
      this.beaconsLit = litIdx.length;
      if (this.beaconsLit === this.entities.beacons.length) this.finaleDone = true;
      (d.shards || []).forEach((i) => {
        const s = this.entities.shards[i];
        if (s) s.alive = false;
      });
      this.shardsCollected = (d.shards || []).length;
      (d.lore || []).forEach((i) => {
        const st = this.entities.stones[i];
        if (st) st.seen = true;
      });
      this.foundLore = (d.lore || []).length;
      if (typeof d.dayT === 'number' && d.dayT >= 0 && d.dayT < 2) this.dayT = d.dayT;
      this.audio.setProgress(this.beaconsLit);
    } catch (e) { /* ignore corrupt saves */ }
  }

  update(dt) {
    this.time += dt;
    this.frame++;
    this.input.sample(dt);

    if (!this.paused && (this.state === 'flying' || this.state === 'finale')) {
      if (!this.photoCam) {
        this.stepShip(dt);
        this.stepGameplay(dt);
      }
      this.entities.update(dt, this);
      if (this.photoCam) this.stepPhotoCam(dt);
      else this.stepCamera(dt);
    } else if (this.state === 'title') {
      /* the manta drifts forward while the title plays */
      const s = this.ship;
      const b = s.basis();
      s.pos = v3.mad(s.pos, b.fwd, 7.5 * dt);
      s.pos[1] += Math.sin(this.time * 0.7) * 1.5 * dt;
      const gy = Math.max(terrainHeight(s.pos[0], s.pos[2]), WORLD.WATER_LEVEL) + 38;
      if (s.pos[1] < gy) s.pos[1] = gy;
      s.yaw += Math.sin(this.time * 0.13) * 0.06 * dt;
      this.stepCameraTitle(dt);
      this.entities.update(dt, this);
    }

    /* day cycle (frozen while composing a photograph) */
    if (!this.finaleDone) {
      if (!this.photoCam) this.dayT += dt / WORLD.DAY_LENGTH;
    } else {
      /* after the finale the sun rises and gently floats */
      this.dayT = lerp(this.dayT, 0.08 + 0.02 * Math.sin(this.time * 0.01), 1 - Math.exp(-dt * 0.05));
    }
    if (!this.paused) {
      this.stepWeather(dt);
      this.stepEclipse(dt);
    }
    this.env = this.computeEnv(this.dayT, this.time);

    /* flash decay */
    this.flash = Math.max(0, this.flash - dt * 1.4);
    this.glowPulse = Math.max(0, this.glowPulse - dt * 0.8);

    this.updateHUD();
    this.audio.update(dt, this);
  }

  stepShip(dt) {
    const s = this.ship;
    const inp = this.input;

    /* steering: roll follows input; yaw from roll; pitch eases to input or glide */
    const targetRoll = inp.roll * 0.82;
    s.roll = damp(s.roll, targetRoll, 6, dt);
    const yawRate = s.roll * (0.9 + clamp(s.speed / 80, 0, 1) * 0.75);
    s.yaw += yawRate * dt;

    let targetPitch;
    if (Math.abs(inp.pitch) > 0.03) targetPitch = inp.pitch * 0.5;
    else targetPitch = 0.0;                        // level by default
    s.pitch = damp(s.pitch, targetPitch, 3.2, dt);

    /* soft speed dynamics: dives rush, climbs drift, nothing strands you */
    const speedEq = 30 - Math.sin(s.pitch) * 36;
    s.speed = damp(s.speed, clamp(speedEq, 15, 60), 0.55, dt);
    if (inp.boost && s.energy > 0.5) {
      s.speed += 34 * dt;
      s.energy -= 17 * dt;
      this.camera.shake = Math.min(1, this.camera.shake + dt * 1.4);
    }
    s.speed = clamp(s.speed, 13, 88);

    /* thermal updrafts */
    let updraft = 0;
    for (const th of this.thermals) {
      const d = v3.dist2([s.pos[0], 0, s.pos[2]], [th.pos[0], 0, th.pos[2]]);
      const rr = th.r;
      if (d < rr * rr && s.pos[1] < th.top) {
        const f = 1 - Math.sqrt(d) / rr;
        updraft = Math.max(updraft, th.strength * 9.5 * f);
        s.speed += th.strength * 3.0 * f * dt;    // thermals feed airspeed too
      }
    }
    const sink = updraft > 0.1 ? 0 : 1.1;
    s.pos[1] += (Math.sin(s.pitch) * s.speed + updraft - sink) * dt;

    /* horizontal motion */
    const b = s.basis();
    s.pos[0] += b.fwd[0] * s.speed * dt;
    s.pos[2] += b.fwd[2] * s.speed * dt;

    /* gales shove the manta off its line */
    const w = this.weather;
    const push = w.storm * 8 + w.dust * 7;
    if (push > 0.2) {
      s.pos[0] += Math.cos(w.windAngle) * push * dt;
      s.pos[2] += Math.sin(w.windAngle) * push * dt;
    }

    /* terrain interaction: soft floor */
    const ground = Math.max(terrainHeight(s.pos[0], s.pos[2]), WORLD.WATER_LEVEL + 1.2);
    const minH = ground + 5;
    if (s.pos[1] < minH) {
      const push = minH - s.pos[1];
      s.pos[1] += push * Math.min(1, dt * 9);
      s.speed = Math.max(20, s.speed - push * 0.9);
      s.pitch = Math.max(s.pitch, 0.16);
      this.camera.shake = Math.min(1, this.camera.shake + push * 0.05);
    }
    /* ceiling */
    s.pos[1] = Math.min(s.pos[1], ground + 640);

    /* flap intensity rises when climbing/thermal */
    s.flapPhase += dt * (2 + updraft * 0.4);
  }

  stepGameplay(dt) {
    const s = this.ship;
    const e = this.entities;

    /* shard pickup */
    for (const sh of e.shards) {
      if (!sh.alive) continue;
      const d2 = v3.dist2(s.pos, sh.pos);
      if (d2 < 11 * 11) {
        e.collectShard(sh);
        this.shardsCollected++;
        s.energy = Math.min(100, s.energy + 14);
        this.audio.chime(this.shardsCollected);
        this.glowPulse = Math.min(1, this.glowPulse + 0.5);
        this.saveGame();
      }
    }

    /* beacon ignition: circle the obelisk with enough light and it wakes */
    this.chargeTarget = null;
    for (const b of e.beacons) {
      if (b.target === 1) continue;
      const d = v3.dist([s.pos[0], 0, s.pos[2]], [b.pos[0], 0, b.pos[2]]);
      const need = BEACON_COSTS[this.beaconsLit];
      if (d < 70 && this.shardsCollected >= need) {
        b.charge = Math.min(1, (b.charge || 0) + dt / 2.5);
        this.chargeTarget = { b, need, charge: b.charge };
        if (b.charge >= 1) {
          this.entities.igniteBeacon(b);
          this.beaconsLit++;
          this.audio.setProgress(this.beaconsLit);
          this.audio.ignite();
          this.flash = Math.min(1, this.flash + 0.7);
          if (this.beaconsLit === 5) this.startFinale();
          this.saveGame();
        }
      } else if (b.charge) {
        b.charge = Math.max(0, b.charge - dt * 0.8);
      }
    }

    /* lore stones: glide close and the world whispers */
    if (e.stones) {
      for (const st of e.stones) {
        if (st.seen) continue;
        if (v3.dist2(s.pos, st.pos) < 28 * 28) {
          st.seen = true;
          this.foundLore = (this.foundLore || 0) + 1;
          this.showLore(st.line);
          this.audio.chime(6);
          this.saveGame();
        }
      }
    }
  }

  showLore(text) {
    this.loreText = text;
    this.loreUntil = this.time + 9;
  }

  startFinale() {
    this.finaleDone = true;
    document.getElementById('finale').classList.add('on');
    this.audio.finale();
    this.flash = 1;
    setTimeout(() => {
      document.getElementById('finale').classList.remove('on');
    }, 9000);
  }

  stepCameraTitle(dt) {
    const cam = this.camera;
    const orbit = this.time * 0.055 + 2.4;
    const r = 118;
    const pos = [
      this.ship.pos[0] + Math.cos(orbit) * r,
      this.ship.pos[1] + 14 + Math.sin(this.time * 0.11) * 4,
      this.ship.pos[2] + Math.sin(orbit) * r,
    ];
    const g = Math.max(terrainHeight(pos[0], pos[2]), WORLD.WATER_LEVEL) + 3;
    pos[1] = Math.max(pos[1], g);
    cam.pos = pos;
    cam.look = [this.ship.pos[0], this.ship.pos[1] + 2.5, this.ship.pos[2]];
    cam.fov = 1.05;
  }

  stepCamera(dt) {
    const s = this.ship;
    const cam = this.camera;
    const b = s.basis();
    /* chase position behind and above */
    const upBlend = v3.norm(v3.lerp(b.up, [0, 1, 0], 0.55));
    const target = v3.mad(v3.mad(s.pos, b.fwd, -13.2), upBlend, 4.6);
    /* keep camera out of the ground */
    const g = Math.max(terrainHeight(target[0], target[2]), WORLD.WATER_LEVEL) + 2.2;
    target[1] = Math.max(target[1], g);

    const lambda = 5.4;
    cam.pos = [
      damp(cam.pos[0], target[0], lambda, dt),
      damp(cam.pos[1], target[1], lambda, dt),
      damp(cam.pos[2], target[2], lambda, dt),
    ];

    /* shake */
    this.camera.shake = Math.max(0, this.camera.shake - dt * 2.2);
    const sh = this.camera.shake * 0.5;
    const jitter = [Math.sin(this.time * 61) * sh, Math.cos(this.time * 47) * sh * 0.6, Math.sin(this.time * 53 + 2) * sh];

    cam.look = [
      s.pos[0] + b.fwd[0] * 26 + jitter[0],
      s.pos[1] + b.fwd[1] * 26 + 2.0 + jitter[1],
      s.pos[2] + b.fwd[2] * 26 + jitter[2],
    ];

    /* fov widens with speed + boost */
    const targetFov = 1.10 + clamp01((s.speed - 24) / 60) * 0.14 + (this.input.boost && s.energy > 0.5 ? 0.05 : 0);
    cam.fov = damp(cam.fov, targetFov, 3, dt);
  }

  computeEnv(dayT, time) {
    const w = this.weather;
    const sunBoost = Math.max(0.16,
      (1 - 0.72 * w.dust - 0.55 * w.rain) * (1 - this.eclipseDark * 0.86));
    const env = this.envFn(dayT, time, sunBoost, w);
    env.eclipse = this.eclipse;
    return env;
  }

  /* weather rolls through on its own schedule */
  stepWeather(dt) {
    const w = this.weather;
    if (this.time >= w.nextChange) {
      const m = moistureAt(this.ship.pos[0], this.ship.pos[2]);
      const r = Math.random();
      let kind;
      if (r < 0.13 + m * 0.42) kind = 'storm';
      else if (r < 0.40 + m * 0.30) kind = 'rain';
      else if (r < 0.62) kind = 'dust';
      else if (r < 0.78) kind = 'haze';
      else kind = 'clear';
      const cfg = WEATHER[kind];
      w.kind = kind;
      w.tStorm = cfg.storm; w.tRain = cfg.rain; w.tDust = cfg.dust;
      w.nextChange = this.time + (kind === 'clear' ? 90 + Math.random() * 130 : 65 + Math.random() * 85);
    }
    w.storm = damp(w.storm, w.tStorm, 0.085, dt);
    w.rain = damp(w.rain, w.tRain, 0.085, dt);
    w.dust = damp(w.dust, w.tDust, 0.085, dt);
    w.windAngle += (0.04 + w.storm * 0.16) * dt + Math.sin(this.time * 0.013) * 0.0015;

    /* thunder when the storm is deep */
    if (w.rain > 0.5 && this.time > w.nextBolt) {
      w.nextBolt = this.time + 2.5 + Math.random() * 9;
      this.flash = Math.min(1, this.flash + 0.45 + Math.random() * 0.35);
      this.audio.thunder();
    }
    this.worldFogDensity = 0.00023 + w.dust * 0.0021 + w.rain * 0.0010;
  }

  /* the ringed giant swallows the sun for a while */
  stepEclipse(dt) {
    if (this.eclipsePhase === 'wait') {
      this.eclipseT -= dt;
      this.eclipse = 0;
      if (this.eclipseT <= 0) {
        /* only while the sun is actually up */
        const sunUp = !this.env || this.env.sunDir[1] > 0.04;
        if (!sunUp) { this.eclipseT = 30; return; }
        this.eclipsePhase = 'transit';
        this.eclipseT = 26;
        this.showLore('the ringed giant swallows the sun');
        this.audio.eclipse();
      }
    } else {
      this.eclipseT -= dt;
      const t = 1 - Math.max(this.eclipseT, 0) / 26;
      this.eclipse = smoothstep(0.02, 0.2, t) * (1 - smoothstep(0.8, 0.98, t));
      if (this.eclipseT <= 0) {
        this.eclipsePhase = 'wait';
        this.eclipseT = 150 + Math.random() * 170;
        this.eclipse = 0;
      }
    }
    this.eclipseDark = damp(this.eclipseDark, this.eclipse, 1.4, dt);
  }

  /* fast-forward the simulation without rendering (test harness) */
  stepSim(steps, dt = 0.016) {
    for (let i = 0; i < steps; i++) {
      this.update(dt);
      if (i % 30 === 0) {
        this.terrain.update(this.camera.pos[0], this.camera.pos[2], this.camera.pos[1], 20);
      }
    }
    this.terrain.update(this.camera.pos[0], this.camera.pos[2], this.camera.pos[1], 20);
  }

  updateHUD() {
    if (this.state === 'title' || this.photoMode || this.photoCam) return;
    /* the HUD does not need 60 Hz DOM writes */
    if (this.time - (this._hudAt || 0) < 0.08) return;
    this._hudAt = this.time;
    const s = this.ship;
    const alt = Math.max(0, Math.round(s.pos[1] - Math.max(terrainHeight(s.pos[0], s.pos[2]), WORLD.WATER_LEVEL)));
    const spd = Math.round(s.speed);
    const elA = document.getElementById('alt');
    const elS = document.getElementById('speed');
    if (elA) elA.textContent = `ALTITUDE ${String(alt).padStart(3, '0')} M`;
    if (elS) elS.textContent = `AIRSPEED ${String(spd).padStart(2, '0')} M/S`;
    const elN = document.querySelector('#shards .n');
    if (elN) elN.textContent = this.shardsCollected;
    const elB = document.getElementById('beacons');
    if (elB) elB.textContent = `BEACONS AWAKENED ${this.beaconsLit} / 5`;

    /* boost fuel */
    const elF = document.getElementById('energy-fill');
    if (elF) {
      elF.style.width = `${Math.max(0, Math.min(100, s.energy)).toFixed(0)}%`;
      elF.classList.toggle('low', s.energy < 18);
    }

    /* communion with a beacon */
    const elCh = document.getElementById('charge');
    if (elCh) {
      if (this.chargeTarget) {
        elCh.classList.add('on');
        elCh.textContent = `THE BEACON STIRS — ${Math.round(this.chargeTarget.charge * 100)}%`;
      } else {
        elCh.classList.remove('on');
      }
    }

    /* lore */
    const elLore = document.getElementById('lore');
    if (elLore) {
      const show = this.loreText && this.time < (this.loreUntil || 0);
      elLore.classList.toggle('on', !!show);
      if (show) elLore.textContent = this.loreText;
    }

    /* compass: prefer the nearest beacon we can actually wake */
    const elC = document.querySelector('#compass .marker');
    const elL = document.querySelector('#compass .label');
    if (elC && this.beacons.length) {
      const need = BEACON_COSTS[this.beaconsLit];
      const canAfford = this.shardsCollected >= need;
      let best = null, bestD = 1e18;
      let afford = null, affordD = 1e18;
      for (let i = 0; i < this.beacons.length; i++) {
        const b = this.beacons[i];
        if (b.target === 1) continue;
        const d = v3.dist2([s.pos[0], 0, s.pos[2]], [b.pos[0], 0, b.pos[2]]);
        if (d < bestD) { bestD = d; best = b; }
        if (canAfford && d < affordD) { affordD = d; afford = b; }
      }
      const target = afford || best;
      if (target) {
        const dx = target.pos[0] - s.pos[0];
        const dz = target.pos[2] - s.pos[2];
        const worldAngle = Math.atan2(dx, dz);
        let rel = worldAngle - s.yaw;
        rel = Math.atan2(Math.sin(rel), Math.cos(rel));
        const px = clamp(rel / Math.PI, -1, 1) * 130;
        elC.style.transform = `translateX(${px.toFixed(1)}px)`;
        elC.classList.toggle('ready', canAfford);
        const dist = Math.round(Math.sqrt(afford ? affordD : bestD));
        if (elL) {
          elL.textContent = canAfford
            ? `BEACON · ${dist} M`
            : `BEACON · ${dist} M · LIGHT ${need - this.shardsCollected} MORE`;
        }
      } else if (elL) {
        elL.textContent = 'ALL BEACONS AWAKE';
        elC.style.transform = 'translateX(0)';
        elC.classList.remove('ready');
      }
    }
  }
}
