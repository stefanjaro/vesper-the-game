/* ─────────────────────────────────────────────────────────────────────────────
   VESPER · audio.js
   Procedural sound: wind that follows the airspeed, a slow generative
   score in a warm mode, chimes for light gathered, swells for beacons.
   No samples — everything synthesized live.
   ───────────────────────────────────────────────────────────────────────────── */

const SCALE = [0, 2, 3, 5, 7, 10];          // dorian-ish pentatonic hexachord
const ROOT = 146.83;                        // D3
const CHORDS = [
  [0, 3, 7],       // i
  [8, 0, 3],       // VI (minor submediant flavour)
  [5, 8, 0],       // III-ish
  [10, 2, 5],      // VII-ish
];

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;

function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

export class AudioEngine {
  constructor() {
    this.ready = false;
    this.ctx = null;
    this.enabled = true;
    this.muted = false;
  }

  start() {
    if (this.ready) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.ctx = ctx;

      this.master = ctx.createGain();
      this.master.gain.value = 0.9;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18; comp.knee.value = 22; comp.ratio.value = 5;
      this.master.connect(comp).connect(ctx.destination);

      /* reverb: generated impulse */
      const len = ctx.sampleRate * 2.8;
      const imp = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = imp.getChannelData(ch);
        for (let i = 0; i < len; i++) {
          const t = i / len;
          d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.6) * 0.5;
        }
      }
      this.verb = ctx.createConvolver();
      this.verb.buffer = imp;
      this.verbGain = ctx.createGain();
      this.verbGain.gain.value = 0.65;
      this.verb.connect(this.verbGain).connect(this.master);

      /* ── wind ── */
      this.windGain = ctx.createGain();
      this.windGain.gain.value = 0;
      const windFilter = ctx.createBiquadFilter();
      windFilter.type = 'bandpass';
      windFilter.frequency.value = 480;
      windFilter.Q.value = 0.6;
      this.windFilter = windFilter;
      const noise = this.noiseSource();
      noise.connect(windFilter).connect(this.windGain);
      this.windGain.connect(this.master);
      this.windGain.connect(this.verb);

      /* ── pad: three voices per chord tone, detuned, lowpassed ── */
      this.padGain = ctx.createGain();
      this.padGain.gain.value = 0.16;
      this.padFilter = ctx.createBiquadFilter();
      this.padFilter.type = 'lowpass';
      this.padFilter.frequency.value = 900;
      this.padFilter.Q.value = 0.4;
      this.padGain.connect(this.padFilter);
      this.padFilter.connect(this.master);
      this.padFilter.connect(this.verb);
      this.padVoices = [];

      /* ── sub bass ── */
      this.subGain = ctx.createGain();
      this.subGain.gain.value = 0.12;
      this.subOsc = ctx.createOscillator();
      this.subOsc.type = 'sine';
      this.subOsc.frequency.value = ROOT / 2;
      this.subOsc.connect(this.subGain).connect(this.master);
      this.subOsc.start();

      /* ── plucks: FM chime through delay ── */
      this.pluckBus = ctx.createGain();
      this.pluckBus.gain.value = 0.5;
      const delay = ctx.createDelay(1.5);
      delay.delayTime.value = 0.42;
      const fb = ctx.createGain();
      fb.gain.value = 0.34;
      delay.connect(fb).connect(delay);
      this.pluckBus.connect(this.master);
      this.pluckBus.connect(delay);
      delay.connect(this.master);
      delay.connect(this.verb);

      this.ready = true;
      this.chordIndex = 0;
      this.nextChordAt = ctx.currentTime + 0.5;
      this.nextPluckAt = ctx.currentTime + 3;
      this.startPad();
    } catch (e) {
      console.warn('[audio] unavailable', e);
    }
  }

  noiseSource() {
    const ctx = this.ctx;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.start();
    return src;
  }

  startPad() {
    const ctx = this.ctx;
    this.padOscs = [];
    for (let v = 0; v < 6; v++) {
      const o = ctx.createOscillator();
      o.type = v < 3 ? 'sawtooth' : 'triangle';
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(g).connect(this.padGain);
      o.start();
      this.padOscs.push({ o, g });
    }
  }

  setChord(ci, when) {
    const ctx = this.ctx;
    const chord = CHORDS[ci % CHORDS.length];
    const octaves = [0, 0, 1, 0, 1, 2];
    for (let v = 0; v < this.padOscs.length; v++) {
      const { o, g } = this.padOscs[v];
      const semitone = chord[v % chord.length] + 12 * octaves[v];
      const f = midiToFreq(50 + semitone) * (1 + (v % 2 ? 0.0016 : -0.0016));
      o.frequency.setTargetAtTime(f, when, 2.2);
      g.gain.setTargetAtTime(v < 3 ? 0.16 : 0.10, when, 2.6);
    }
  }

  /* called every frame from the game */
  update(dt, game) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const ship = game.ship;

    /* wind follows airspeed + altitude */
    const spd = ship ? clamp(ship.speed / 80, 0.1, 1.1) : 0.2;
    const wTarget = (game.state === 'flying' ? 0.05 + spd * 0.24 : 0.03) * (game.paused ? 0.4 : 1);
    this.windGain.gain.setTargetAtTime(wTarget, t, 0.7);
    this.windFilter.frequency.setTargetAtTime(320 + spd * 950 + Math.sin(t * 0.7) * 60, t, 0.5);

    /* pad brightness follows night + speed */
    const bright = lerp(1500, 500, game.env.night) + spd * 700;
    this.padFilter.frequency.setTargetAtTime(bright, t, 1.2);

    /* chord progression */
    if (t >= this.nextChordAt) {
      this.setChord(this.chordIndex, t);
      this.chordIndex = (this.chordIndex + 1) % CHORDS.length;
      this.nextChordAt = t + 13;
      /* sub follows root of chord */
      const rootSemis = CHORDS[(this.chordIndex - 1 + CHORDS.length) % CHORDS.length][0];
      this.subOsc.frequency.setTargetAtTime(midiToFreq(38 + rootSemis), t, 1.8);
    }

    /* sparse melodic plucks */
    if (t >= this.nextPluckAt && game.state === 'flying') {
      const deg = SCALE[Math.floor(Math.random() * SCALE.length)];
      const oct = Math.random() < 0.4 ? 12 : 0;
      this.pluck(midiToFreq(62 + deg + oct), 0.10 + Math.random() * 0.10);
      this.nextPluckAt = t + 2.5 + Math.random() * 5.5;
    }
  }

  pluck(freq, amp = 0.12) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const m = ctx.createOscillator();
    m.type = 'sine';
    m.frequency.value = freq * 2.01;
    const mg = ctx.createGain();
    mg.gain.value = freq * 0.5;
    m.connect(mg).connect(o.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    o.connect(g).connect(this.pluckBus);
    o.start(t); m.start(t);
    o.stop(t + 1.8); m.stop(t + 1.8);
  }

  chime(step = 0) {
    if (!this.ready || this.muted) return;
    const deg = SCALE[step % SCALE.length];
    this.pluck(midiToFreq(74 + deg), 0.16);
    this.pluck(midiToFreq(86 + deg), 0.07);
  }

  ignite() {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    /* a deep warm bloom */
    [0, 7, 12, 16].forEach((s, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = midiToFreq(38 + s + 12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + i * 0.09);
      g.gain.linearRampToValueAtTime(0.14, t + i * 0.09 + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 3.6);
      o.connect(g).connect(this.master);
      o.connect(g).connect(this.verb);
      o.start(t + i * 0.09);
      o.stop(t + i * 0.09 + 4);
    });
  }

  finale() {
    if (!this.ready || this.muted) return;
    this.ignite();
    setTimeout(() => this.ignite(), 900);
    /* shimmering high bell */
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (let i = 0; i < 10; i++) {
      setTimeout(() => {
        const deg = SCALE[Math.floor(Math.random() * SCALE.length)];
        this.pluck(midiToFreq(86 + deg + (Math.random() < 0.5 ? 12 : 0)), 0.12);
      }, i * 420);
    }
  }

  setMuted(m) {
    this.muted = m;
    if (this.ready) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.2);
    }
  }
}
