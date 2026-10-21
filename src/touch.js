// Touch controls for phones and tablets: a floating stick on the left half moves, dragging anywhere
// else looks around, and a cluster of buttons on the right stands in for the keys. Everything is fed
// into Input as the same actions the keyboard produces, so the game itself never knows the difference.

const S = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICONS = {
  fire: S('<circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/>'),
  jump: S('<path d="M12 20V5M5 11l7-7 7 7"/>'),
  aim: S('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>'),
  grapple: S('<path d="M12 4v10"/><path d="M6 11a6 6 0 0 0 12 0"/><path d="M6 11l-2.5 2M18 11l2.5 2"/><circle cx="12" cy="3" r="1.6"/>'),
  crouch: S('<path d="M5 6l7 7 7-7"/><path d="M4 19h16"/>'),
  reload: S('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 3.5v5h-5"/>'),
  melee: S('<path d="M6 18L19 5l1 -1"/><path d="M4.5 13.5l6 6M3 21l3-3"/>'),
  grenade: S('<circle cx="12" cy="14" r="7"/><path d="M10 7V4.5h4V7M14 4.5l4-2"/>'),
  swap: S('<path d="M4 8h15l-4-4M20 16H5l4 4"/>'),
  pause: S('<path d="M8.5 5v14M15.5 5v14"/>'),
  score: S('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".8" fill="currentColor"/><circle cx="4.5" cy="12" r=".8" fill="currentColor"/><circle cx="4.5" cy="18" r=".8" fill="currentColor"/>'),
  move: S('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="currentColor"/>'),
  look: S('<path d="M4 12h16M7 9l-3 3 3 3M17 9l3 3-3 3"/>'),
};
const icon = (a) => `<i class="tki">${ICONS[a]}</i>`;
// what the prompts and tips show in place of a key name while playing by touch
export const TOUCH_KEYS = { fire: icon('fire'), aim: icon('aim'), block: icon('aim'), jump: icon('jump'), slide: icon('crouch'), dash: icon('crouch'), grapple: icon('grapple'), melee: icon('melee'), reload: icon('reload'), grenade: icon('grenade'), focus: icon('aim') + ' + ' + icon('fire'), next: icon('swap'), pause: icon('pause'), score: icon('score') };

const BUTTONS = ['fire', 'jump', 'aim', 'grapple', 'crouch', 'reload', 'melee', 'grenade', 'swap', 'pause', 'score'];
const HELD = new Set(['fire', 'jump', 'grapple', 'crouch', 'reload', 'melee', 'grenade', 'pause', 'score']);

export class TouchUI {
  constructor(input, root) {
    this.input = input; this.ptrs = new Map(); this.joyId = null;
    const el = this.el = document.createElement('div');
    el.className = 'touchui';
    el.innerHTML = `<div class="tjoy"><i class="tj-knob"></i></div>${BUTTONS.map((a) => `<div class="tb tb-${a}" data-a="${a}">${ICONS[a]}</div>`).join('')}`;
    root.insertBefore(el, root.querySelector('#screen'));
    this.joy = el.querySelector('.tjoy'); this.knob = el.querySelector('.tj-knob'); this.aimBtn = el.querySelector('.tb-aim');
    el.addEventListener('pointerdown', (e) => this._down(e));
    el.addEventListener('pointermove', (e) => this._move(e));
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(ev, (e) => this._up(e));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // no synthesized click afterwards: it would land on whatever menu the tap just opened (pause) and close it again
    el.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  }
  _down(e) {
    if (e.pointerType === 'mouse') return;
    e.preventDefault(); this.input.noteTouch();
    const p = { x: e.clientX, y: e.clientY, kind: 'look' };
    const b = e.target.closest('.tb');
    if (b) { p.kind = 'btn'; p.a = b.dataset.a; p.b = b; b.classList.add('on'); this._press(p.a); }
    else if (e.clientX < innerWidth * 0.45 && this.joyId === null) {
      // the stick appears under the thumb wherever it lands on the left side
      p.kind = 'joy'; p.ox = e.clientX; p.oy = e.clientY; this.joyId = e.pointerId;
      this.joy.classList.add('live'); this.joy.style.left = e.clientX + 'px'; this.joy.style.top = e.clientY + 'px'; this.joy.style.bottom = 'auto';
    }
    this.ptrs.set(e.pointerId, p);
    try { this.el.setPointerCapture(e.pointerId); } catch (err) { /* already gone */ }
  }
  _move(e) {
    const p = this.ptrs.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    if (p.kind === 'joy') {
      const R = Math.max(36, Math.min(innerHeight * 0.13, 72));
      let vx = (e.clientX - p.ox) / R, vy = (e.clientY - p.oy) / R; const m = Math.hypot(vx, vy);
      if (m > 1) { vx /= m; vy /= m; }
      this.knob.style.transform = `translate(${(vx * R).toFixed(1)}px, ${(vy * R).toFixed(1)}px)`;
      const live = m > 0.15; this.input.tMove.x = live ? vx : 0; this.input.tMove.y = live ? -vy : 0;
      // pushing the stick all the way forward sprints
      this.input.keys.sprint = m > 0.92 && -vy > 0.6;
    } else if (p.kind === 'look' || p.a === 'fire' || p.a === 'aim') { this.input.tx += dx; this.input.ty += dy; }
  }
  _up(e) {
    const p = this.ptrs.get(e.pointerId); if (!p) return;
    this.ptrs.delete(e.pointerId);
    if (p.kind === 'btn') { p.b.classList.remove('on'); if (HELD.has(p.a)) this._release(p.a); }
    else if (p.kind === 'joy') this._resetJoy();
  }
  _press(a) {
    const k = this.input.keys;
    if (a === 'aim') k.aim = !k.aim;              // aiming is a toggle: holding it would tie up a thumb
    else if (a === 'swap') this.input.wheel += 1;
    else k[a] = true;
  }
  // a quick tap can start and end between two frames; keep the key down until the game has seen it
  _release(a) { const i = this.input; if (i.state[a]) i.keys[a] = false; else i.releaseNext.add(a); }
  _resetJoy() {
    this.joyId = null; this.input.tMove.x = 0; this.input.tMove.y = 0; this.input.keys.sprint = false;
    this.knob.style.transform = ''; this.joy.classList.remove('live'); this.joy.style.left = ''; this.joy.style.top = ''; this.joy.style.bottom = '';
  }
  // let go of everything, e.g. when a menu opens over the game
  reset() {
    for (const p of this.ptrs.values()) if (p.kind === 'btn') p.b.classList.remove('on');
    this.ptrs.clear(); this._resetJoy();
    for (const a of HELD) this.input.keys[a] = false; this.input.keys.aim = false;
  }
  sync(online) {
    this.aimBtn.classList.toggle('lit', !!this.input.keys.aim);
    if (online !== this._online) { this._online = online; this.el.classList.toggle('online', online); }
  }
}
