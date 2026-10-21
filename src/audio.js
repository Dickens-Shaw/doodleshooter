// Procedural WebAudio sound effects (no external assets).
// Everything plays through a small mixing desk: effects and music on their own buses, a short
// generated room reverb that sounds get sent to (more of it the farther away they are), a glue
// compressor and a limiter. Distant sounds also lose their top end, the way they do in air.
// The palette leans on the notebook: pen scratches, paper tears and taps sit next to the guns.
import * as THREE from 'three';
import { clamp, rand, choose } from './util.js';

const vary = (x, amt = 0.08) => x * (1 + (Math.random() * 2 - 1) * amt);

class Sfx {
  constructor() {
    this.ctx = null; this.master = null; this.noiseBuf = null; this.volume = 0.6;
    this.listenerPos = new THREE.Vector3(); this.listenerRight = new THREE.Vector3(1, 0, 0);
  }
  // silence everything while a CrazyGames ad plays (set on adStarted, cleared when it ends), and while
  // the platform's own sound setting is off; that one wins over the game's music toggle
  setAdMute(on) { this._adMute = on; this._applyMute(); }
  setPlatformMute(on) { this._pfMute = on; this._applyMute(); }
  get muted() { return !!(this._adMute || this._pfMute); }
  _applyMute() { if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.02); }
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ctx = this.ctx = new AC();
    // master: glue compressor, then a fast limiter so a grenade on top of a boss never clips
    this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : this.volume;
    this.comp = ctx.createDynamicsCompressor(); this.comp.threshold.value = -18; this.comp.knee.value = 8; this.comp.ratio.value = 3.5; this.comp.attack.value = 0.006; this.comp.release.value = 0.18;
    this.limit = ctx.createDynamicsCompressor(); this.limit.threshold.value = -3; this.limit.knee.value = 0; this.limit.ratio.value = 20; this.limit.attack.value = 0.001; this.limit.release.value = 0.08;
    this.master.connect(this.comp); this.comp.connect(this.limit); this.limit.connect(ctx.destination);
    // effects bus and a send into a small room
    this.sfx = ctx.createGain(); this.sfx.connect(this.master);
    this.verb = ctx.createConvolver(); this.verb.buffer = this._roomIR(1.3, 2.6);
    const verbTone = ctx.createBiquadFilter(); verbTone.type = 'lowpass'; verbTone.frequency.value = 4200;
    this.verbIn = ctx.createGain(); this.verbIn.gain.value = 0.55;
    this.verbIn.connect(this.verb); this.verb.connect(verbTone); verbTone.connect(this.master);
    const len = ctx.sampleRate * 2; this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    // a soft clipper for the low "thump" layers: rounds them off and adds punch
    this.drive = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; this.drive[i] = Math.tanh(x * 2.6) / Math.tanh(2.6); }
  }
  // a stereo room impulse: a few early reflections, then a decaying, darkening noise tail
  _roomIR(seconds, decay) {
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * seconds), ir = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c); let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n; const k = 0.25 + 0.7 * t; lp = lp * k + (Math.random() * 2 - 1) * (1 - k);
        d[i] = lp * Math.pow(1 - t, decay) * (i < ctx.sampleRate * 0.012 ? i / (ctx.sampleRate * 0.012) : 1);
      }
      for (const [ms, g] of [[11, 0.5], [19, 0.35], [31, 0.28], [47, 0.2]]) d[Math.floor(ctx.sampleRate * (ms + c * 3) / 1000)] += g * (c ? -1 : 1);
    }
    return ir;
  }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  setListener(pos, right) { this.listenerPos.copy(pos); this.listenerRight.copy(right); }
  // where a sound goes: panned and filtered by its position, with a share sent to the room
  _out(pos, base = 1, wet = 0.12) {
    const ctx = this.ctx; const g = ctx.createGain(); let vol = base, last = g, send = wet;
    if (pos) {
      const dx = pos.x - this.listenerPos.x, dy = pos.y - this.listenerPos.y, dz = pos.z - this.listenerPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      vol *= 1 / (1 + dist * 0.09);
      send = wet + Math.min(0.45, dist * 0.012);
      if (dist > 6) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = clamp(22000 / (1 + (dist - 6) * 0.12), 1200, 20000); f.Q.value = 0.5; last.connect(f); last = f; }
      if (dist > 0.5 && ctx.createStereoPanner) {
        const p = ctx.createStereoPanner(); p.pan.value = clamp((dx * this.listenerRight.x + dz * this.listenerRight.z) / dist, -1, 1) * 0.75; last.connect(p); last = p;
      }
    }
    g.gain.value = vol; last.connect(this.sfx);
    if (send > 0) { const s = ctx.createGain(); s.gain.value = send; last.connect(s); s.connect(this.verbIn); }
    return g;
  }
  noise({ dur = 0.1, gain = 0.5, type = 'lowpass', freq = 1000, freqEnd = null, q = 1, attack = 0.002, pos = null, delay = 0, hp = 0, at, wet, out }) {
    if (!this.ctx) return; const ctx = this.ctx; const t0 = at !== undefined ? at : ctx.currentTime + delay;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true; src.loopEnd = 2;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t0);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t0 + dur); f.Q.value = q;
    const env = ctx.createGain(); env.gain.setValueAtTime(0.0001, t0); env.gain.linearRampToValueAtTime(gain, t0 + attack); env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); let last = f;
    if (hp > 0) { const h = ctx.createBiquadFilter(); h.type = 'highpass'; h.frequency.value = hp; last.connect(h); last = h; }
    last.connect(env); env.connect(out || this._out(pos, 1, wet ?? 0.12));
    src.start(t0, Math.random() * 1.5); src.stop(t0 + dur + 0.05);
  }
  tone({ freq = 440, freqEnd = null, dur = 0.2, gain = 0.3, type = 'sine', attack = 0.005, pos = null, delay = 0, at, out, wet, drive = false }) {
    if (!this.ctx) return; const ctx = this.ctx; const t0 = at !== undefined ? at : ctx.currentTime + delay;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t0 + dur);
    const env = ctx.createGain(); env.gain.setValueAtTime(0.0001, t0); env.gain.linearRampToValueAtTime(gain, t0 + attack); env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let src = o; if (drive) { const ws = ctx.createWaveShaper(); ws.curve = this.drive; o.connect(ws); src = ws; }
    src.connect(env); env.connect(out || this._out(pos, 1, wet ?? 0.12)); o.start(t0); o.stop(t0 + dur + 0.05);
  }
  // ---------- building blocks ----------
  // the first few milliseconds of a gunshot: a hard, bright crack
  _crack(gain, pos, freq = 2200, delay = 0) { this.noise({ dur: 0.018, gain, type: 'highpass', freq: vary(freq, 0.1), attack: 0.0005, pos, delay, wet: 0.2 }); }
  // the low punch under it: a falling sine pushed into the soft clipper
  _thump(f0, f1, dur, gain, pos, delay = 0) { this.tone({ freq: vary(f0, 0.06), freqEnd: f1, dur, gain, type: 'sine', attack: 0.001, pos, delay, drive: true, wet: 0.05 }); }
  // the body and the tail that rings off the walls
  _body(freq, freqEnd, dur, gain, pos, q = 0.7, delay = 0) { this.noise({ dur, gain, type: 'bandpass', freq: vary(freq, 0.1), freqEnd, q, attack: 0.001, pos, delay, wet: 0.35 }); }
  // a pen scratching across paper: a run of tiny bright grains
  scribble(pos, dur = 0.25, gain = 0.22, delay = 0) {
    if (!this.ctx) return; const n = Math.max(3, Math.round(dur / 0.022));
    for (let i = 0; i < n; i++) this.noise({ dur: rand(0.012, 0.03), gain: gain * rand(0.5, 1), type: 'bandpass', freq: rand(1800, 4200), q: rand(2, 5), attack: 0.001, pos, delay: delay + i * dur / n + rand(0, 0.008), wet: 0.08 });
  }
  // paper tearing: a scribble with a low, papery rip under it
  _tear(pos, dur = 0.3, gain = 0.4, delay = 0) {
    this.noise({ dur, gain: gain * 0.7, type: 'bandpass', freq: rand(900, 1300), freqEnd: rand(2200, 3000), q: 1.2, attack: 0.01, pos, delay, wet: 0.15 });
    this.scribble(pos, dur * 0.8, gain * 0.6, delay);
  }
  // ---------- game sounds ----------
  shot() {
    this._crack(0.55); this._thump(150, 45, 0.14, 0.75);
    this._body(1300, 260, 0.16, 0.6); this.noise({ dur: 0.35, gain: 0.12, type: 'lowpass', freq: 900, freqEnd: 200, delay: 0.02, wet: 0.6 });
    this.noise({ dur: 0.02, gain: 0.12, type: 'bandpass', freq: vary(5200), q: 4, delay: 0.05, wet: 0 }); // the bolt
  }
  // another player's gun, heard from where they stand: a bit hotter than a bot's so it cuts through
  remoteShot(kind, pos) {
    if (kind === 'shotgun') { this._crack(0.6, pos, 1600); this._thump(95, 30, 0.28, 0.9, pos); this._body(1100, 140, 0.34, 0.9, pos, 0.5); }
    else if (kind === 'sniper') { this._crack(0.75, pos, 2800); this._thump(120, 30, 0.4, 0.8, pos); this._body(900, 110, 0.5, 0.9, pos, 0.5); }
    else { this._crack(0.5, pos); this._thump(160, 50, 0.12, 0.6, pos); this._body(rand(1100, 1500), 220, 0.16, 0.8, pos); }
  }
  enemyShot(pos) {
    this._crack(0.3, pos, 1800); this._body(rand(900, 1500), 200, 0.14, 0.5, pos, 0.8);
    this.tone({ freq: vary(240), freqEnd: 70, dur: 0.1, gain: 0.25, type: 'triangle', pos });
  }
  shotgun(pos) { this._crack(0.45, pos, 1500); this._thump(90, 30, 0.25, 0.6, pos); this._body(1000, 150, 0.3, 0.7, pos, 0.5); }
  sniperShot(pos) { this._crack(0.55, pos, 2600); this._thump(110, 35, 0.3, 0.5, pos); this._body(750, 120, 0.4, 0.7, pos, 0.5); }
  sniperAim(pos) { this.tone({ freq: 1800, dur: 0.12, gain: 0.12, type: 'sine', pos }); }
  empty() { this.noise({ dur: 0.025, gain: 0.35, type: 'bandpass', freq: 3200, q: 3, attack: 0.0005, wet: 0.05 }); this.noise({ dur: 0.02, gain: 0.15, type: 'bandpass', freq: 1400, q: 3, delay: 0.03, wet: 0.05 }); }
  winded() { this.tone({ freq: 220, freqEnd: 140, dur: 0.14, gain: 0.1, type: 'triangle' }); }
  // magazine out, magazine in, slap, charging handle
  reload() {
    this._click(0.0, 2600, 0.3); this.noise({ dur: 0.12, gain: 0.18, type: 'bandpass', freq: 700, q: 2, delay: 0.08, wet: 0.05 });
    this._click(0.55, 1800, 0.35); this.noise({ dur: 0.06, gain: 0.35, type: 'lowpass', freq: 600, delay: 0.9, wet: 0.08 }); this._click(0.9, 2400, 0.4);
    this._click(1.18, 3000, 0.3); this._click(1.27, 2100, 0.35);
  }
  _click(delay, freq, gain) { this.noise({ dur: 0.03, gain, type: 'bandpass', freq: vary(freq), q: 2.5, attack: 0.0005, delay, wet: 0.06 }); }
  katanaSwing() {
    this.noise({ dur: 0.22, gain: 0.32, type: 'bandpass', freq: vary(500), freqEnd: 3400, q: 2.2, attack: 0.04, wet: 0.1 });
    this.noise({ dur: 0.16, gain: 0.12, type: 'highpass', freq: 5000, attack: 0.05, wet: 0 });
  }
  katanaHit() {
    this._thump(170, 60, 0.12, 0.5); this.noise({ dur: 0.14, gain: 0.5, type: 'lowpass', freq: 1000, freqEnd: 200, wet: 0.15 });
    this._tear(null, 0.16, 0.35);
  }
  parry() {
    for (const f of [2200, 3300, 4700]) this.tone({ freq: vary(f, 0.02), freqEnd: f * 0.97, dur: 0.6, gain: 0.12, type: 'sine', wet: 0.4 });
    this._crack(0.5, null, 4000);
  }
  perfectParry() { this.parry(); this.tone({ freq: 880, freqEnd: 1760, dur: 0.25, gain: 0.2, type: 'triangle', delay: 0.03, wet: 0.4 }); }
  grappleFire() { this.noise({ dur: 0.08, gain: 0.35, type: 'highpass', freq: 1500 }); this.noise({ dur: 0.22, gain: 0.25, type: 'bandpass', freq: 900, freqEnd: 3500, q: 3, attack: 0.01 }); this.tone({ freq: 500, freqEnd: 1500, dur: 0.18, gain: 0.1, type: 'triangle' }); }
  grappleHit() { this._crack(0.4, null, 2000); this._thump(260, 120, 0.08, 0.35); }
  grappleRelease() { this.tone({ freq: 900, freqEnd: 300, dur: 0.12, gain: 0.1, type: 'triangle' }); this.noise({ dur: 0.1, gain: 0.12, type: 'bandpass', freq: 2500, freqEnd: 900, q: 2 }); }
  reelLoop(on) {
    if (!this.ctx) return;
    if (on && !this._reel) { const ctx = this.ctx; const o = ctx.createBufferSource(); o.buffer = this.noiseBuf; o.loop = true; const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 520; f.Q.value = 1.4; const g = ctx.createGain(); g.gain.value = 0.0001; g.gain.setTargetAtTime(0.07, ctx.currentTime, 0.12); o.connect(f); f.connect(g); g.connect(this.sfx); o.start(); this._reel = { o, g }; }
    else if (!on && this._reel) { const r = this._reel; this._reel = null; r.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05); r.o.stop(this.ctx.currentTime + 0.3); }
  }
  // footsteps: a soft heel and a papery scuff, never the same twice
  footstep(speedFrac = 1) { this.noise({ dur: vary(0.07, 0.2), gain: 0.13 * speedFrac, type: 'lowpass', freq: rand(350, 700), attack: 0.002, wet: 0.04 }); this.noise({ dur: 0.04, gain: 0.04 * speedFrac, type: 'bandpass', freq: rand(2500, 4000), q: 2, delay: 0.01, wet: 0 }); }
  jump() { this.noise({ dur: 0.06, gain: 0.12, type: 'lowpass', freq: 700, wet: 0.04 }); this.noise({ dur: 0.12, gain: 0.06, type: 'bandpass', freq: 1200, freqEnd: 2400, q: 1.5, wet: 0 }); }
  land(hard = 0.5) { this._thump(90, 40, 0.12, 0.15 + 0.4 * hard); this.noise({ dur: 0.14, gain: 0.12 + 0.25 * hard, type: 'lowpass', freq: 500, wet: 0.08 }); }
  slide() { this.noise({ dur: 0.45, gain: 0.2, type: 'bandpass', freq: 900, freqEnd: 400, q: 0.8, attack: 0.02 }); this.scribble(null, 0.35, 0.06); }
  wallJump() { this._thump(140, 60, 0.08, 0.3); this.noise({ dur: 0.08, gain: 0.2, type: 'lowpass', freq: 800 }); }
  mantle() { this.noise({ dur: 0.2, gain: 0.2, type: 'lowpass', freq: 900, freqEnd: 300 }); }
  dash() { this.noise({ dur: 0.28, gain: 0.32, type: 'bandpass', freq: 600, freqEnd: 3000, q: 1.4, attack: 0.01, wet: 0.15 }); }
  hurt() { this._thump(120, 50, 0.16, 0.5); this.noise({ dur: 0.15, gain: 0.3, type: 'lowpass', freq: 700, wet: 0.05 }); this.tone({ freq: 200, freqEnd: 110, dur: 0.18, gain: 0.12, type: 'triangle' }); }
  death() { this.tone({ freq: 220, freqEnd: 30, dur: 1.2, gain: 0.35, type: 'triangle', wet: 0.4 }); this._thump(80, 25, 0.8, 0.6); this._tear(null, 0.8, 0.45); }
  // hits on a doodle: a dull tap on the ink, with a little pen tick so you know it landed
  hitEnemy(pos) { this.noise({ dur: 0.06, gain: 0.3, type: 'lowpass', freq: 1100, pos, wet: 0.05 }); this._thump(rand(180, 240), 90, 0.07, 0.3, pos); }
  headshot(pos) { this._crack(0.45, pos, 3200); this.tone({ freq: 1500, freqEnd: 700, dur: 0.1, gain: 0.18, type: 'triangle', pos }); }
  // a kill: a short two-note ping over a thump, the kind of sound you want to hear again
  kill(strong = false) { this.tone({ freq: 880, dur: 0.07, gain: 0.16, type: 'square', wet: 0.2 }); this.tone({ freq: 1320, dur: 0.18, gain: 0.15, type: 'square', delay: 0.07, wet: 0.25 }); this._thump(140, 50, 0.16, strong ? 0.6 : 0.35); if (strong) this.tone({ freq: 1760, dur: 0.3, gain: 0.1, type: 'triangle', delay: 0.14, wet: 0.4 }); }
  // a doodle dying: it gets torn off the page
  enemyDie(pos) { this._thump(rand(150, 210), 40, 0.3, 0.45, pos); this._tear(pos, rand(0.25, 0.4), 0.5, 0.02); }
  gib(pos) { this.noise({ dur: 0.2, gain: 0.4, type: 'lowpass', freq: 600, freqEnd: 120, pos, wet: 0.1 }); this._tear(pos, 0.15, 0.3, 0.02); }
  // no-gore stand-in for gib: a sheet of paper scrunched up, with a soft pop
  crumple(pos) { this.noise({ dur: 0.16, gain: 0.3, type: 'bandpass', freq: 2600, freqEnd: 900, q: 0.8, pos, wet: 0.05 }); this.tone({ freq: 520, freqEnd: 240, dur: 0.08, gain: 0.12, type: 'triangle', pos }); }
  splat(pos) { this.noise({ dur: 0.08, gain: 0.15, type: 'lowpass', freq: 700, pos, wet: 0.05 }); }
  // a doodle being drawn into the world
  spawn(pos) { this.scribble(pos, 0.3, 0.3); }
  lunge(pos) { this.tone({ freq: 200, freqEnd: 700, dur: 0.3, gain: 0.22, type: 'sawtooth', pos }); this.scribble(pos, 0.25, 0.15); }
  bulletImpact(pos) { this.noise({ dur: 0.05, gain: 0.25, type: 'bandpass', freq: rand(1500, 2800), q: 1, pos, wet: 0.2 }); }
  ricochet(pos) { this.tone({ freq: rand(2000, 3500), freqEnd: 800, dur: 0.18, gain: 0.1, type: 'sine', pos, wet: 0.35 }); }
  pickup() { this.tone({ freq: 700, freqEnd: 1100, dur: 0.1, gain: 0.18, type: 'triangle', wet: 0.2 }); this.tone({ freq: 1100, freqEnd: 1500, dur: 0.16, gain: 0.18, type: 'triangle', delay: 0.09, wet: 0.3 }); }
  wave() { const notes = [440, 554, 659, 880]; notes.forEach((f, i) => this.tone({ freq: f, dur: 0.26, gain: 0.15, type: 'triangle', delay: i * 0.11, wet: 0.4 })); }
  waveClear() { const notes = [659, 880, 1108, 1318]; notes.forEach((f, i) => this.tone({ freq: f, dur: 0.34, gain: 0.14, type: 'triangle', delay: i * 0.13, wet: 0.45 })); }
  tick() { this.noise({ dur: 0.02, gain: 0.2, type: 'highpass', freq: 4000 }); }
  hitstop() { this._thump(70, 40, 0.12, 0.35); }
  switchWeapon() { this._click(0, 1800, 0.25); this._click(0.07, 2600, 0.15); }
  heartbeat() { this.tone({ freq: 55, dur: 0.15, gain: 0.35, type: 'sine', wet: 0 }); this.tone({ freq: 50, dur: 0.12, gain: 0.25, type: 'sine', delay: 0.18, wet: 0 }); }

  // ---------- more weapons / movement ----------
  shotgunFire() {
    this._crack(0.7, null, 1500); this._thump(100, 28, 0.3, 0.95);
    this._body(1200, 120, 0.34, 0.85, null, 0.5); this.noise({ dur: 0.6, gain: 0.16, type: 'lowpass', freq: 800, freqEnd: 120, delay: 0.03, wet: 0.7 });
  }
  revolver() {
    this._crack(0.65, null, 2600); this._thump(190, 40, 0.2, 0.85);
    this._body(950, 180, 0.24, 0.75, null, 0.6); this.tone({ freq: 2600, freqEnd: 900, dur: 0.14, gain: 0.08, type: 'sine', wet: 0.4 });
  }
  sniperFire() {
    this._crack(0.85, null, 3200); this._thump(120, 26, 0.45, 1.0);
    this._body(1500, 90, 0.5, 0.9, null, 0.45); this.noise({ dur: 1.1, gain: 0.18, type: 'lowpass', freq: 700, freqEnd: 90, delay: 0.04, wet: 0.8 });
    this.tone({ freq: 1800, freqEnd: 400, dur: 0.5, gain: 0.1, type: 'sine', delay: 0.05, wet: 0.5 });
  }
  focusIn() { this.tone({ freq: 1200, freqEnd: 420, dur: 0.45, gain: 0.25, type: 'sine', wet: 0.5 }); this.noise({ dur: 0.35, gain: 0.18, type: 'bandpass', freq: 2400, freqEnd: 500, q: 1.2, wet: 0.4 }); }
  focusSlash() { this.noise({ dur: 0.3, gain: 0.5, type: 'bandpass', freq: 600, freqEnd: 4000, q: 1.6, attack: 0.02 }); this._thump(180, 50, 0.3, 0.6); this._tear(null, 0.3, 0.4, 0.05); for (const f of [1600, 2400]) this.tone({ freq: f, freqEnd: f * 0.6, dur: 0.4, gain: 0.1, type: 'sine', delay: 0.04, wet: 0.5 }); }
  pump() { this._click(0, 1500, 0.35); this.noise({ dur: 0.06, gain: 0.2, type: 'lowpass', freq: 700, delay: 0.04, wet: 0.05 }); this._click(0.1, 950, 0.38); }
  shell() { this._click(0, 2500, 0.25); this.tone({ freq: vary(1400), freqEnd: 900, dur: 0.06, gain: 0.06, type: 'triangle' }); }
  cylinder() { this._click(0, 2000, 0.3); this.tone({ freq: 700, freqEnd: 400, dur: 0.12, gain: 0.08, type: 'triangle', delay: 0.05 }); this._click(1.6, 1800, 0.35); }
  // grenades: a crack, a deep clipped boom, debris and a long tail rolling round the streets
  explosion(pos) {
    this._crack(0.8, pos, 1200); this._thump(75, 22, 0.9, 1.1, pos);
    this.noise({ dur: 0.9, gain: 0.85, type: 'lowpass', freq: 1400, freqEnd: 60, pos, attack: 0.002, wet: 0.5 });
    this.noise({ dur: 1.8, gain: 0.22, type: 'lowpass', freq: 500, freqEnd: 50, pos, delay: 0.05, wet: 0.9 });
    for (let i = 0; i < 6; i++) this.noise({ dur: rand(0.03, 0.08), gain: rand(0.08, 0.18), type: 'bandpass', freq: rand(1500, 4500), q: 2, pos, delay: 0.15 + rand(0, 0.5), wet: 0.3 });
  }
  fuse(pos) { this.noise({ dur: 0.12, gain: 0.22, type: 'highpass', freq: 5000, pos }); }
  flyerDive(pos) { this.tone({ freq: 900, freqEnd: 300, dur: 0.35, gain: 0.18, type: 'sawtooth', pos }); this.noise({ dur: 0.3, gain: 0.15, type: 'bandpass', freq: 2500, freqEnd: 800, q: 1, pos }); }
  flyerBuzz(pos) { this.tone({ freq: rand(380, 460), dur: 0.14, gain: 0.05, type: 'sawtooth', pos }); }
  stomp(pos) { this._thump(60, 22, 0.55, 0.9, pos); this.noise({ dur: 0.45, gain: 0.6, type: 'lowpass', freq: 450, freqEnd: 60, pos, wet: 0.4 }); }
  bossRoar(pos) { this.tone({ freq: 90, freqEnd: 60, dur: 1.0, gain: 0.45, type: 'sawtooth', pos, wet: 0.5 }); this.tone({ freq: 45, freqEnd: 32, dur: 1.0, gain: 0.4, type: 'sine', pos, drive: true, wet: 0.2 }); this.noise({ dur: 0.9, gain: 0.35, type: 'bandpass', freq: 500, q: 0.8, pos, wet: 0.5 }); }
  shieldHit(pos) { this.tone({ freq: rand(600, 800), freqEnd: 300, dur: 0.14, gain: 0.18, type: 'square', pos, wet: 0.3 }); this._crack(0.3, pos, 3000); }
  airdrop() { this.tone({ freq: 660, dur: 0.15, gain: 0.15, type: 'triangle', wet: 0.3 }); this.tone({ freq: 880, dur: 0.22, gain: 0.15, type: 'triangle', delay: 0.15, wet: 0.4 }); }
  crateLand(pos) { this._thump(80, 30, 0.3, 0.6, pos); this.noise({ dur: 0.3, gain: 0.5, type: 'lowpass', freq: 600, freqEnd: 80, pos, wet: 0.3 }); }
  // ---------- music: an 8-bit theme, two pulse voices, a triangle bass, an arpeggio and drums ----------
  musicOn(on) {
    if (!this.ctx) return;
    if (on && !this._mus) { this.musicGain = this.ctx.createGain(); this.musicGain.gain.value = 0.05; if (!this.musicTone) { this.musicTone = this.ctx.createBiquadFilter(); this.musicTone.type = 'lowpass'; this.musicTone.frequency.value = 5200; this.musicTone.Q.value = 0.4; const mv = this.ctx.createGain(); mv.gain.value = 0.25; this.musicTone.connect(this.master); this.musicTone.connect(mv); mv.connect(this.verbIn); } this.musicGain.connect(this.musicTone); this._mus = { step: 0, next: this.ctx.currentTime + 0.1, timer: setInterval(() => this._musicTick(), 100) }; }
    else if (!on && this._mus) { clearInterval(this._mus.timer); this._mus = null; if (this.musicGain) this.musicGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2); }
  }
  get musicPlaying() { return !!this._mus; }
  setIntensity(v) { this._intensity = clamp(v, 0, 1); }
  setTune(key) { if (this._tuneKey === key) return; this._tuneKey = key; if (this._mus) { this._mus.step = 0; this._mus.next = this.ctx.currentTime + 0.1; } }
  _musicTick() {
    if (this._tuneKey === 'mexico') return this._mariachiTick();
    const ctx = this.ctx, m = this._mus; if (!m) return; const I = this._intensity || 0; const out = this.musicGain;
    const bpm = 156, step = 60 / bpm / 4; const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
    // a throttled tab can fall far behind; skip forward rather than replaying every missed note
    if (m.next < ctx.currentTime - 0.8) m.next = ctx.currentTime + 0.05;
    while (m.next < ctx.currentTime + 0.7) {
      const t = m.next, i = m.step % SONG.length, bar = Math.floor(i / 16), s16 = i % 16;
      const sec = SONG.section[bar], chord = SONG.chord[bar], root = chord[0];
      const firstBar = SONG.firstBar[bar], lastBar = SONG.lastBar[bar];
      // lead: a pulse with a slightly detuned twin for width, an optional octave shadow, and a dotted-eighth echo in the airy sections
      const n = SONG.lead[i];
      if (n > 0) {
        const dur = SONG.len[i] * step * 0.9, f = midi(n);
        this.tone({ freq: f, dur, gain: 0.1, type: 'square', at: t, out });
        this.tone({ freq: f * 1.004, dur, gain: 0.04, type: 'square', at: t, out });
        if (sec.shadow) this.tone({ freq: f * 2, dur: dur * 0.7, gain: sec.shadow, type: 'square', at: t, out });
        if (sec.echo) { this.tone({ freq: f, dur: dur * 0.8, gain: 0.035, type: 'square', at: t + step * 3, out }); this.tone({ freq: f, dur: dur * 0.6, gain: 0.012, type: 'square', at: t + step * 6, out }); }
      }
      // bass: each section has its own feel; 'drive' and 'pump' walk toward the next chord on the last eighth
      const b = root - 12; let nb = SONG.chord[(bar + 1) % SONG.bars][0] - 12; if (nb - b > 6) nb -= 12; else if (b - nb > 6) nb += 12;
      const approach = nb === b ? b + 7 : nb + (nb > b ? -1 : 1);
      const bass = (note, len, gain = 0.16) => this.tone({ freq: midi(note), dur: step * len, gain, type: 'triangle', at: t, out });
      if (sec.bass === 'bounce') { if (s16 % 2 === 0) bass(b + [0, 0, 12, 0, 0, 7, 0, 12][s16 / 2], 1.6); }
      else if (sec.bass === 'drive') { if (s16 % 2 === 0) bass(s16 === 14 ? approach : s16 === 6 ? b + 12 : s16 === 12 ? b + 7 : b, 1.4, 0.17); }
      else if (sec.bass === 'sparse') { if (s16 === 0) bass(b, 6, 0.14); else if (s16 === 8) bass(b + 7, 4, 0.12); }
      else if (sec.bass === 'pump') { if (s16 === 0 || s16 === 8) bass(b, 2.5); else if (s16 === 4) bass(b + 7, 2.5); else if (s16 === 12) bass(b + 12, 1.6); else if (s16 === 14) bass(approach, 1.4); }
      // arpeggio: chord tones on every sixteenth, quiet
      if (sec.arp) { const tones = [root, root + chord[1], root + 7, root + 12]; this.tone({ freq: midi(tones[s16 % 4] + 12), dur: step * 0.8, gain: 0.03 + I * 0.02, type: 'square', at: t, out }); }
      // counter voice: a soft triangle answering on the off-beats
      if (sec.counter && s16 % 4 === 2) { const tones = [root + 12, root + chord[1] + 12, root + 19, root + chord[1] + 12]; this.tone({ freq: midi(tones[(s16 - 2) / 4]), dur: step * 1.5, gain: 0.06, type: 'triangle', at: t, out }); }
      // drums: a splash on each new section, a rising snare fill into the next one, otherwise the section's own groove
      const D = sec.drums;
      if (firstBar && s16 === 0) this._noiseAt(t, 0.4, 0.14, 'highpass', 5000, out);
      if (lastBar && s16 >= 12) this._noiseAt(t, 0.08, 0.12 + (s16 - 12) * 0.05, 'bandpass', 1800 + (s16 - 12) * 350, out);
      else {
        const kick = D === 'driving' ? s16 % 4 === 0 : D === 'sparse' ? s16 === 0 : (s16 === 0 || s16 === 8 || (I > 0.5 && s16 === 10) || (s16 === 14 && D === 'full' && bar % 2 === 1));
        if (kick) this.tone({ freq: 160, freqEnd: 45, dur: 0.12, gain: D === 'sparse' ? 0.3 : 0.45, type: 'sine', at: t, out });
        if (D !== 'sparse' && (s16 === 4 || s16 === 12)) this._noiseAt(t, 0.11, D === 'light' ? 0.14 : 0.22, 'bandpass', 2200, out);
        const hat = D === 'driving' ? true : D === 'full' ? (s16 % 2 === 0 || I > 0.4) : D === 'light' ? s16 % 4 === 2 : s16 === 8;
        if (hat) { const open = s16 % 4 === 2; this._noiseAt(t, open ? 0.05 : 0.025, (open ? 0.1 : 0.06) * (s16 % 2 ? 0.5 : 1) * (D === 'sparse' ? 0.6 : 1), 'highpass', 8000, out); }
      }
      m.next += step; m.step++;
    }
  }
  // Doodle Mexico: a waltz in G, twelve sixteenths a bar; two trumpets in thirds over a guitarrón and strummed chords
  _mariachiTick() {
    const ctx = this.ctx, m = this._mus; if (!m) return; const I = this._intensity || 0; const out = this.musicGain;
    const T = MEXICO, step = 60 / T.bpm / 4; const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
    if (m.next < ctx.currentTime - 0.8) m.next = ctx.currentTime + 0.05;
    while (m.next < ctx.currentTime + 0.7) {
      const t = m.next, i = m.step % T.length, bar = Math.floor(i / 12), sb = i % 12; const chord = T.chord[bar], root = chord[0]; const n = T.lead[i];
      if (n > 0) { const dur = T.len[i] * step * 0.9; this.tone({ freq: midi(n), dur, gain: 0.1, type: 'square', at: t, out }); this.tone({ freq: midi(thirdBelow(n)), dur: dur * 0.9, gain: 0.055, type: 'square', at: t, out }); if (T.high[bar]) this.tone({ freq: midi(n) * 2, dur: dur * 0.6, gain: 0.02, type: 'square', at: t, out }); }
      if (sb === 0) this.tone({ freq: midi(root - 24), dur: step * 3.4, gain: 0.2, type: 'triangle', at: t, out });
      if (sb === 4 || sb === 8) for (const iv of [0, chord[1], 7]) this.tone({ freq: midi(root + iv), dur: step * 1.5, gain: 0.045, type: 'sawtooth', at: t, out });
      if (sb % 2 === 0) this._noiseAt(t, sb === 0 ? 0.05 : 0.03, sb === 0 ? 0.13 : 0.07, 'highpass', 6500, out);
      if (I > 0.45 && (sb === 6 || sb === 10)) this._noiseAt(t, 0.07, 0.16, 'bandpass', 1900, out);
      if (bar === T.bars - 1 && sb >= 8) this._noiseAt(t, 0.06, 0.1 + (sb - 8) * 0.04, 'bandpass', 1600 + (sb - 8) * 300, out);
      m.next += step; m.step++;
    }
  }
  // something made of clay, wood or paper giving way
  smash(pos, big = false) { this.noise({ dur: big ? 0.28 : 0.14, gain: big ? 0.7 : 0.45, type: 'lowpass', freq: big ? 900 : 1600, freqEnd: 200, pos, wet: 0.25 }); this._crack(0.3, pos, 3500); this._thump(big ? 120 : 220, 60, 0.12, 0.3, pos); for (let i = 0; i < (big ? 5 : 3); i++) this.noise({ dur: rand(0.03, 0.07), gain: rand(0.08, 0.16), type: 'bandpass', freq: rand(1200, 3500), q: 2, pos, delay: 0.05 + rand(0, 0.25), wet: 0.2 }); }
  _noiseAt(t0, dur, gain, type, freq, out) {
    const ctx = this.ctx; const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true; src.loopEnd = 2;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0); env.gain.linearRampToValueAtTime(gain, t0 + 0.003); env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(env); env.connect(out); src.start(t0, Math.random() * 1.5); src.stop(t0 + dur + 0.05);
  }
}

// ---------- the theme: seven eight-bar sections (~86s) on a sixteenth grid; 0 is a rest ----------
const N = (...pairs) => { const notes = [], lens = []; for (let k = 0; k < pairs.length; k += 2) { notes.push(pairs[k]); lens.push(pairs[k + 1]); for (let j = 1; j < pairs[k + 1]; j++) { notes.push(0); lens.push(0); } } return { notes, lens }; };
const C = [60, 4], G = [55, 4], Am = [57, 3], F = [53, 4], Em = [52, 3]; // [root, third] for the arpeggio and counter voice
const HOOK = [
  N(76, 2, 79, 2, 84, 3, 0, 1, 79, 2, 76, 2, 0, 4),           // C: the leap, then a breath
  N(74, 3, 79, 3, 83, 2, 81, 2, 79, 4, 0, 2),                 // G: swung answer
  N(81, 2, 84, 2, 88, 4, 86, 2, 84, 2, 81, 4),                // Am: the lift
  N(77, 2, 81, 2, 84, 2, 81, 2, 79, 2, 77, 2, 76, 2, 74, 2),  // F: tumbling back down
];
const TAIL_A = [
  N(72, 2, 76, 2, 79, 4, 0, 2, 84, 4, 0, 2),                  // C
  N(83, 2, 81, 2, 79, 2, 74, 4, 0, 2, 79, 2, 81, 2),          // G
  N(81, 3, 77, 3, 84, 3, 81, 3, 79, 4),                       // F: three-against-four
  N(79, 4, 77, 2, 76, 2, 74, 4, 0, 4),                        // G: walks back to the top
];
const TAIL_B = [
  N(76, 2, 79, 2, 84, 2, 88, 6, 0, 4),                        // C: reaches higher
  N(86, 2, 83, 2, 79, 4, 0, 2, 81, 2, 83, 4),                 // G
  N(84, 2, 81, 2, 77, 4, 81, 2, 84, 2, 86, 4),                // F
  N(83, 3, 0, 1, 79, 3, 0, 1, 74, 4, 0, 4),                   // G: stabs, then hands off
];
const BRIDGE = [
  N(69, 2, 69, 2, 72, 2, 76, 4, 0, 2, 69, 4),                 // Am: low and punchy
  N(65, 2, 65, 2, 69, 2, 72, 4, 0, 2, 74, 2, 72, 2),          // F
  N(76, 2, 76, 2, 74, 2, 72, 4, 0, 2, 67, 4),                 // C
  N(71, 2, 74, 2, 79, 4, 0, 2, 77, 2, 76, 2, 74, 2),          // G
  N(69, 2, 69, 2, 72, 2, 76, 4, 0, 2, 81, 4),                 // Am: same call, higher answer
  N(77, 3, 0, 1, 77, 2, 81, 2, 84, 8),                        // F: opens up
  N(83, 2, 81, 2, 79, 4, 74, 4, 79, 4),                       // G
  N(83, 2, 86, 6, 0, 8),                                      // G: one long note, then silence into the breakdown
];
const BREAK = [
  N(81, 8, 84, 8), N(83, 8, 86, 8), N(79, 8, 76, 8), N(81, 12, 0, 4),   // F G Em Am: long floating notes
  N(77, 4, 81, 4, 84, 8), N(79, 4, 83, 4, 86, 8), N(88, 8, 86, 4, 84, 4), N(79, 4, 0, 12), // F G C C: climbs, then drops out for the fill
];
const CHORUS = [
  N(84, 3, 86, 1, 88, 4, 0, 2, 79, 6),                        // C: bright, dotted
  N(83, 3, 79, 1, 76, 4, 0, 2, 83, 6),                        // Em
  N(81, 3, 84, 1, 81, 4, 0, 2, 77, 6),                        // F
  N(79, 2, 81, 2, 83, 4, 86, 4, 0, 4),                        // G: climbs
  N(84, 3, 86, 1, 88, 4, 0, 2, 86, 3, 84, 3),                 // C
  N(83, 3, 79, 1, 76, 4, 0, 2, 83, 3, 84, 3),                 // Em
  N(81, 2, 84, 2, 81, 2, 77, 4, 0, 2, 81, 4),                 // F
  N(79, 4, 83, 2, 86, 2, 79, 4, 0, 4),                        // G: back to the hook
];
const PROG_A = [C, G, Am, F, C, G, F, G], PROG_B = [Am, F, C, G, Am, F, G, G], PROG_C = [F, G, Em, Am, F, G, C, C], PROG_D = [C, Em, F, G, C, Em, F, G];
const SECTIONS = [
  { bars: [...HOOK, ...TAIL_A], chords: PROG_A, bass: 'bounce', drums: 'full', arp: true },
  { bars: [...HOOK, ...TAIL_B], chords: PROG_A, bass: 'bounce', drums: 'full', arp: true, shadow: 0.02 },
  { bars: BRIDGE, chords: PROG_B, bass: 'drive', drums: 'driving' },
  { bars: BREAK, chords: PROG_C, bass: 'sparse', drums: 'sparse', echo: true },
  { bars: CHORUS, chords: PROG_D, bass: 'pump', drums: 'full', counter: true, shadow: 0.02 },
  { bars: [...HOOK, ...TAIL_A], chords: PROG_A, bass: 'bounce', drums: 'full', arp: true, shadow: 0.045 },
  { bars: CHORUS, chords: PROG_D, bass: 'pump', drums: 'driving', arp: true, counter: true, shadow: 0.03 },
];
const SONG = { lead: [], len: [], chord: [], section: [], firstBar: [], lastBar: [] };
for (const s of SECTIONS) s.bars.forEach((b, k) => { SONG.lead.push(...b.notes); SONG.len.push(...b.lens); SONG.chord.push(s.chords[k]); SONG.section.push(s); SONG.firstBar.push(k === 0); SONG.lastBar.push(k === s.bars.length - 1); });
SONG.bars = SONG.chord.length; SONG.length = SONG.bars * 16;
// ---------- Doodle Mexico: sixteen bars of waltz in G, twelve sixteenths a bar ----------
const Gm = [67, 4], D7 = [62, 4], Cm = [60, 4], Em7 = [64, 3], Am7 = [69, 3];
const MEX_BARS = [
  N(74, 2, 79, 2, 83, 2, 86, 4, 83, 2),      N(84, 2, 83, 2, 81, 2, 78, 4, 81, 2),      // G: the call · D7
  N(79, 2, 83, 2, 86, 2, 91, 4, 86, 2),      N(83, 4, 79, 4, 74, 4),                     // G: to the top · and down
  N(76, 2, 79, 2, 84, 2, 88, 4, 84, 2),      N(86, 2, 83, 2, 79, 2, 83, 4, 86, 2),      // C · G
  N(81, 2, 84, 2, 78, 2, 81, 4, 84, 2),      N(83, 2, 81, 2, 79, 8),                     // D7 · G: hold
  N(79, 4, 83, 4, 86, 4),                     N(88, 2, 86, 2, 83, 2, 79, 4, 0, 2),        // G · Em: the second verse sings higher
  N(84, 2, 88, 2, 91, 4, 88, 2, 84, 2),      N(86, 4, 83, 4, 79, 4),                     // C · G
  N(81, 2, 84, 2, 88, 2, 86, 4, 84, 2),      N(83, 2, 86, 2, 91, 4, 88, 2, 86, 2),      // Am · D7
  N(84, 2, 83, 2, 81, 2, 79, 4, 78, 2),      N(79, 6, 0, 2, 74, 4),                      // C D7 · G: the grito lands
];
const MEXICO = { lead: MEX_BARS.flatMap((b) => b.notes), len: MEX_BARS.flatMap((b) => b.lens), bpm: 150, chord: [Gm, D7, Gm, Gm, Cm, Gm, D7, Gm, Gm, Em7, Cm, Gm, Am7, D7, Cm, Gm], high: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1] };
MEXICO.bars = MEXICO.chord.length; MEXICO.length = MEXICO.bars * 12;
// the harmony trumpet sits a diatonic third under the lead (G major)
const G_SCALE = [7, 9, 11, 0, 2, 4, 6];
function thirdBelow(n) { const pc = ((n % 12) + 12) % 12; let k = G_SCALE.indexOf(pc); if (k < 0) return n - 4; k = (k + 5) % 7; let m = n - 1; while (((m % 12) + 12) % 12 !== G_SCALE[k]) m--; return m; }
export const audio = new Sfx();
