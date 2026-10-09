/* ─────────────────────────────────────────────────────────────────────────────
   VESPER · game.js
   The flight: the manta's motion, the chase camera, input, and the quiet
   quest of gathering light and waking the beacons.
   ───────────────────────────────────────────────────────────────────────────── */

import { v3, clamp, clamp01, lerp, smoothstep, damp, mulberry32, m4basis } from './engine.js';
import { terrainHeight, WORLD } from './world.js';

const GRAV = 9.8;

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
    return m4basis(this.pos, b.right, b.up, b.fwd, 1.7);
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
    const boost = !!(K['ShiftLeft'] || K['ShiftRight'] || K['Space']);

    r += this.mouseDX * 0.055;
    p += -this.mouseDY * 0.045;   // mouse up = climb (chase-cam convention)
    if (this.touch.active) {
      r += this.touch.dx * 0.045;
      p += this.touch.dy * 0.04;
      this.touch.dx *= 0.4; this.touch.dy *= 0.4;
    }
    this.mouseDX *= Math.exp(-dt * 22);
    this.mouseDY *= Math.exp(-dt * 22);

    this.roll = clamp(r, -1, 1);
    this.pitch = clamp(p, -1, 1);
    this.boost = boost;
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
    this.paused = false;
    this.fps = 60;
    this.stats = { chunks: 0, draws: 0, ms: 16 };
    this.spawn = deps.spawn;
    this.ship = new Ship(deps.spawn);
    this.input = new Input(deps.canvas);
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
        document.getElementById('hud').classList.toggle('on', !this.photoMode && this.state === 'flying');
      }
      if (e.code === 'KeyM') this.audio.setMuted(!this.audio.muted);
      if (e.code === 'Enter' && this.state === 'title') begin();
    });
  }

  update(dt) {
    this.time += dt;
    this.frame++;
    this.input.sample(dt);

    if (!this.paused && (this.state === 'flying' || this.state === 'finale')) {
      this.stepShip(dt);
      this.stepGameplay(dt);
      this.entities.update(dt, this);
      this.stepCamera(dt);
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

    /* day cycle */
    if (!this.finaleDone) {
      this.dayT += dt / WORLD.DAY_LENGTH;
    } else {
      /* after the finale the sun rises and gently floats */
      this.dayT = lerp(this.dayT, 0.08 + 0.02 * Math.sin(this.time * 0.01), 1 - Math.exp(-dt * 0.05));
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
        this.energyPool = Math.min(100, (this.energyPool ?? 30) + 14);
        s.energy = this.energyPool;
        this.audio.chime(this.shardsCollected);
        this.glowPulse = Math.min(1, this.glowPulse + 0.5);
      }
    }

    /* beacon ignition */
    for (const b of e.beacons) {
      if (b.target === 1) continue;
      const d = v3.dist([s.pos[0], 0, s.pos[2]], [b.pos[0], 0, b.pos[2]]);
      const need = [3, 8, 14, 22, 32][this.beaconsLit];
      if (d < 70 && this.shardsCollected >= need) {
        this.entities.igniteBeacon(b);
        this.beaconsLit++;
        this.flash = Math.min(1, this.flash + 0.7);
        this.audio.ignite();
        if (this.beaconsLit === 5) this.startFinale();
      }
    }
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
    const target = v3.mad(v3.mad(s.pos, b.fwd, -11.5), upBlend, 4.2);
    /* keep camera out of the ground */
    const g = Math.max(terrainHeight(target[0], target[2]), WORLD.WATER_LEVEL) + 2.2;
    target[1] = Math.max(target[1], g);

    const lambda = 4.2;
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
    return this.envFn(dayT, time);
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
    if (this.state === 'title' || this.photoMode) return;
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

    /* compass: aim at nearest unlit beacon we can afford */
    const elC = document.querySelector('#compass .marker');
    const elL = document.querySelector('#compass .label');
    if (elC && this.beacons.length) {
      let target = null, bestD = 1e18;
      const need = [4, 10, 18, 28, 40];
      for (let i = 0; i < this.beacons.length; i++) {
        const b = this.beacons[i];
        if (b.target === 1) continue;
        const d = v3.dist2([s.pos[0], 0, s.pos[2]], [b.pos[0], 0, b.pos[2]]);
        if (d < bestD) { bestD = d; target = b; }
      }
      if (target) {
        const dx = target.pos[0] - s.pos[0];
        const dz = target.pos[2] - s.pos[2];
        const worldAngle = Math.atan2(dx, dz);
        let rel = worldAngle - s.yaw;
        rel = Math.atan2(Math.sin(rel), Math.cos(rel));
        const px = clamp(rel / Math.PI, -1, 1) * 130;
        elC.style.transform = `translateX(${px.toFixed(1)}px)`;
        const dist = Math.round(Math.sqrt(bestD));
        if (elL) elL.textContent = `BEACON · ${dist} M`;
      } else if (elL) {
        elL.textContent = 'ALL BEACONS AWAKE';
        elC.style.transform = 'translateX(0)';
      }
    }
  }
}
