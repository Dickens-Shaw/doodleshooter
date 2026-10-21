// Keyboard and mouse input.
import { clamp } from './util.js';

const KEYMAP = {
  KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right', ArrowUp: 'forward', ArrowDown: 'back', ArrowLeft: 'left', ArrowRight: 'right',
  Space: 'jump', ShiftLeft: 'sprint', ShiftRight: 'sprint', KeyC: 'crouch',
  KeyR: 'reload', KeyQ: 'grapple', KeyE: 'grapple', KeyF: 'melee', KeyV: 'melee',
  Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3', Digit4: 'slot4', Digit5: 'slot5', Escape: 'pause', KeyP: 'pause', Enter: 'confirm', KeyG: 'grenade', KeyX: 'dash', KeyM: 'music', Tab: 'score',
};
const MOUSEMAP = { 0: 'fire', 2: 'aim', 1: 'grapple', 3: 'grapple', 4: 'melee' };

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.state = {}; this.prev = {}; this.frameState = {};
    this.keys = {}; this.mouseBtns = {};
    this.move = { x: 0, y: 0 };
    this.look = { x: 0, y: 0 };
    this.mx = 0; this.my = 0; this.wheel = 0;
    this.mouseSens = 0.0022;
    this.pointerLocked = false; this.anyInput = false;
    this.onLockChange = null; this.onAnyInput = null; this.lastActive = performance.now();
    this.invertY = false;
    // touch play (see touch.js): stick movement, drag-to-look deltas, and when a finger last landed
    this.releaseNext = new Set();   // touch buttons let go before the game saw them pressed
    this.touch = false; this.tMove = { x: 0, y: 0 }; this.tx = 0; this.ty = 0; this.touchSens = 1.8; this._lastTouch = -1e9;

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.lastActive = performance.now(); const a = KEYMAP[e.code]; if (a) this.keys[a] = true;
      if (!e.shiftKey) this.keys.sprint = false;
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
      this.anyInput = true;
    });
    window.addEventListener('keyup', (e) => { const a = KEYMAP[e.code]; if (a) this.keys[a] = false; if (!e.shiftKey) this.keys.sprint = false; });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { this.keys = {}; this.mouseBtns = {}; } });
    window.addEventListener('blur', () => { this.keys = {}; this.mouseBtns = {}; });
    document.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      let dx = e.movementX, dy = e.movementY;
      // guard against pointer-lock spikes
      if (Math.abs(dx) > 400) dx = 0; if (Math.abs(dy) > 400) dy = 0;
      this.mx += dx; this.my += dy; this.lastActive = performance.now();
    });
    document.addEventListener('mousedown', (e) => {
      // a tap also sends a fake click a moment later; it must not fire the gun
      if (this.touch && performance.now() - this._lastTouch < 1000) return;
      const a = MOUSEMAP[e.button]; if (a) this.mouseBtns[a] = true;
      this.anyInput = true; this.lastActive = performance.now();
      if (e.button === 1 || e.button === 3 || e.button === 4) e.preventDefault();
    });
    document.addEventListener('mouseup', (e) => { const a = MOUSEMAP[e.button]; if (a) this.mouseBtns[a] = false; });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (this.onLockChange) this.onLockChange(this.pointerLocked);
    });
  }

  // browsers refuse a new pointer lock for about a second after Esc released the last one, so a
  // failed request is retried until it takes or the game stops wanting it
  requestLock() {
    this.wantLock = true; if (this.pointerLocked) return;
    if (this.touch) { this.pointerLocked = true; return; }   // nothing to capture on a touch screen
    const attempt = (opts) => { try { const p = this.canvas.requestPointerLock(opts); return p && p.catch ? p : Promise.resolve(); } catch (err) { return Promise.reject(err); } };
    attempt({ unadjustedMovement: true }).catch(() => attempt()).catch(() => {
      clearTimeout(this._lockRetry); this._lockRetry = setTimeout(() => { if (this.wantLock && !this.pointerLocked) this.requestLock(); }, 1200);
    });
  }
  exitLock() { this.wantLock = false; clearTimeout(this._lockRetry); if (this.touch) this.pointerLocked = false; if (document.pointerLockElement) document.exitPointerLock(); }
  // switch to touch play; a game already running counts as captured from here on
  enableTouch() {
    if (this.touch) return; this.touch = true; clearTimeout(this._lockRetry);
    if (document.pointerLockElement) document.exitPointerLock();
    this.pointerLocked = !!this.wantLock;
  }
  noteTouch() { this._lastTouch = performance.now(); this.lastActive = this._lastTouch; this.anyInput = true; }

  update(dt) {
    // rotate button states
    this.prev = this.state; this.state = {};
    const s = this.state;
    for (const k in this.keys) if (this.keys[k]) s[k] = true;
    for (const k in this.mouseBtns) if (this.mouseBtns[k]) s[k] = true;
    if (this.wheel > 0) s.nextWeapon = true; else if (this.wheel < 0) s.prevWeapon = true; this.wheel = 0;
    for (const k of this.releaseNext) this.keys[k] = false; this.releaseNext.clear();

    // movement from keys
    let mx = (s.right ? 1 : 0) - (s.left ? 1 : 0);
    let my = (s.forward ? 1 : 0) - (s.back ? 1 : 0);
    if (!mx && !my) { mx = this.tMove.x; my = this.tMove.y; }
    // look from mouse
    const ts = this.mouseSens * this.touchSens;
    const lx = -this.mx * this.mouseSens - this.tx * ts, ly = -this.my * this.mouseSens - this.ty * ts; this.mx = 0; this.my = 0; this.tx = 0; this.ty = 0;

    const ml = Math.hypot(mx, my); if (ml > 1) { mx /= ml; my /= ml; }
    this.move.x = mx; this.move.y = my;
    this.look.x = lx; this.look.y = this.invertY ? -ly : ly;
  }

  down(a) { return !!this.state[a]; }
  get idleSeconds() { return (performance.now() - this.lastActive) / 1000; }
  pressed(a) { return !!this.state[a] && !this.prev[a]; }
  released(a) { return !this.state[a] && !!this.prev[a]; }
  consume(a) { this.state[a] = false; }
  anyPressed() { for (const k in this.state) if (this.state[k] && !this.prev[k]) return true; return false; }

}
