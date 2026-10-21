// DOM heads-up display drawn in "pen" style (multiplied over the paper canvas).
import { t } from './i18n.js';
import { ICONS, TOUCH_KEYS } from './touch.js';
export class HUD {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="scope" id="scope"><div class="mask"></div><div class="ring"></div><div class="cx"></div><div class="cy"></div><div class="dot"></div></div>
      <div class="focus-meter" id="focusmeter"><div class="fm-label">${t('hud.katana')}</div><div class="fm-tube"><div class="fm-fill" id="fmfill"></div><i class="fm-f1"></i><i class="fm-f2"></i><i class="fm-f3"></i></div><div class="fm-ready" id="fmready">${t('hud.drawReady')}</div></div>
      <div class="focus-mark" id="focusmark"><i></i><i></i><i></i><i></i></div>
      <div class="crosshair" id="crosshair"><i class="ch-t"></i><i class="ch-b"></i><i class="ch-l"></i><i class="ch-r"></i><i class="ch-dot"></i></div>
      <div class="grapple-ret" id="gret"></div><div class="gstam" id="gstam" hidden><i id="gstamfill"></i></div>
      <div class="hitmarker" id="hitmarker"><i></i><i></i></div>
      <div class="dmg-ind" id="dmg"></div>
      <div class="hud-tl"><div class="score">${t('hud.score')} <b id="score">0</b></div><div class="combo" id="combo"></div></div>
      <div class="hud-tr"><div class="wave">${t('hud.wave')} <b id="wave">1</b></div><div class="modifier" id="modifier"></div><div class="left">${t('hud.enemiesLeft', { n: '<b id="left">0</b>' })}</div><div class="timer" id="timer"></div><div class="pvpscore" id="pvpscore" hidden></div></div><div class="board" id="board" hidden></div>
      <div class="bossbar" id="bossbar"><div class="bossname" id="bossname"></div><div class="bar big"><div class="fill red" id="bossfill"></div></div></div>
      <div class="hud-bl">
        <div class="health"><span>${t('hud.health')}</span><div class="bar"><div class="fill" id="hpfill"></div></div><span id="hpnum">100</span></div>
        <div class="ammo"><b id="mag">30</b><span id="reserve">/120</span><span class="reloading" id="reloading"></span><span class="nades" id="nades" title="${t('hud.grenades')}"></span></div>
        <div class="tally" id="tally"></div>
      </div>
      <div class="hud-br"><div class="slots" id="slots"></div><div class="weapon" id="weapon">${t('wpn.rifle')}</div><div class="hint" id="hint"></div></div>
      <div class="tip" id="tip"></div><div class="coach" id="coach"></div>
      <div class="message"><div class="msg-main" id="msg"></div><div class="msg-sub" id="msgsub"></div></div>
      <div class="nametags" id="nametags"></div><div class="killfeed" id="killfeed"></div>
      <div class="screen" id="screen"><div class="panel" id="panel"></div></div>`;
    const q = (id) => root.querySelector('#' + id);
    this.el = { crosshair: q('crosshair'), gret: q('gret'), hitmarker: q('hitmarker'), dmg: q('dmg'), score: q('score'), combo: q('combo'), wave: q('wave'), modifier: q('modifier'), left: q('left'), timer: q('timer'), hpfill: q('hpfill'), hpnum: q('hpnum'), mag: q('mag'), reserve: q('reserve'), reloading: q('reloading'), tally: q('tally'), weapon: q('weapon'), hint: q('hint'), slots: q('slots'), tip: q('tip'), coach: q('coach'), msg: q('msg'), msgsub: q('msgsub'), killfeed: q('killfeed'), screen: q('screen'), panel: q('panel'), nades: q('nades'), scope: q('scope'), focusmark: q('focusmark'), focusmeter: q('focusmeter'), fmfill: q('fmfill'), bossbar: q('bossbar'), bossname: q('bossname'), bossfill: q('bossfill'), pvpscore: q('pvpscore'), board: q('board'), gstam: q('gstam'), gstamfill: q('gstamfill'), nametags: q('nametags') };
    this._tags = new Map();
    this._msgT = 0; this._scope = false; this._nades = -1; this._fmShow = false; this._fmFrac = -1; this._fmReady = false; this._lastTally = -1; this._lastSlots = ''; this._ads = false; this._mode = ''; this.onScreenClick = null; this._tipT = 0;
    this.el.screen.addEventListener('click', () => { if (this.onScreenClick) this.onScreenClick(); });
  }
  // katana charge gauge: fills with katana kills, catches fire when a focus slash is ready
  setFocusMeter(show, frac, ready, label = t('hud.katana')) {
    const m = this.el.focusmeter;
    if (show !== this._fmShow) { this._fmShow = show; m.classList.toggle('on', show); }
    if (!show) return;
    if (label !== this._fmLabel) { this._fmLabel = label; m.querySelector('.fm-label').textContent = label; }
    const f = Math.max(0, Math.min(1, frac));
    if (Math.abs(f - (this._fmFrac ?? -1)) > 0.005) { this._fmFrac = f; this.el.fmfill.style.height = (f * 100).toFixed(1) + '%'; }
    if (ready !== this._fmReady) { this._fmReady = ready; m.classList.toggle('ready', ready); }
  }
  setGrenades(n) { if (n === this._nades) return; this._nades = n; let h = ''; for (let i = 0; i < n; i++) h += '<i></i>'; this.el.nades.innerHTML = h; }
  // control labels follow whatever you touched last
  key(action) { return (this.touch && TOUCH_KEYS[action]) || KB_KEYS[action] || action; }
  setScope(on) { if (on === this._scope) return; this._scope = on; this.el.scope.classList.toggle('on', on); }
  setFocusMark(x, y) {
    const m = this.el.focusmark;
    if (x == null) { m.classList.remove('on'); return; }
    m.classList.add('on'); m.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
  }
  setSpread(px) { this.el.crosshair.style.setProperty('--s', px.toFixed(1) + 'px'); }
  setCrosshairMode(mode) { this._mode = mode; this._applyCross(); }
  setAds(on) { if (on === this._ads) return; this._ads = on; this._applyCross(); }
  _applyCross() { this.el.crosshair.className = 'crosshair ' + this._mode + (this._ads ? ' ads' : ''); }
  setGrappleStamina(f) { const show = f < 0.995; if (this.el.gstam.hidden === show) this.el.gstam.hidden = !show; if (show) { this.el.gstamfill.style.width = (f * 100).toFixed(0) + '%'; this.el.gstam.classList.toggle('low', f < 0.2); } }
  grappleTarget(state) { this.el.gret.className = 'grapple-ret' + (state === 1 ? ' on' : state === 2 ? ' on attached' : ''); }
  hitmarker(kill = false, crit = false) { const h = this.el.hitmarker; h.className = 'hitmarker' + (kill ? ' kill' : '') + (crit ? ' crit' : ''); void h.offsetWidth; h.classList.add('show'); }
  setAmmo(mag, reserve, magSize, reloading = false) {
    this.el.mag.textContent = mag; this.el.reserve.textContent = '/' + reserve; this.el.reloading.textContent = reloading ? t('hud.reloading') : '';
    if (mag !== this._lastTally) { this._lastTally = mag; let s = ''; for (let i = 0; i < Math.min(mag, 40); i++) s += '<i></i>'; this.el.tally.innerHTML = s; }
  }
  setKatana() { this.el.mag.textContent = '∞'; this.el.reserve.textContent = ''; this.el.reloading.textContent = ''; if (this._lastTally !== -1) { this.el.tally.innerHTML = ''; this._lastTally = -1; } }
  setSlots(slots) {
    const key = slots.map((s) => `${s.name}|${s.active ? 1 : 0}|${s.ammo}`).join(';'); if (key === this._lastSlots) return; this._lastSlots = key;
    this.el.slots.innerHTML = slots.map((s, i) => `<div class="slot${s.active ? ' active' : ''}${s.empty ? ' empty' : ''}"><span class="num">${i + 1}</span>${s.name}<span class="sammo">${s.ammo}</span></div>`).join('');
  }
  setHealth(hp, max) { const f = Math.max(0, hp / max); this.el.hpfill.style.width = (f * 100).toFixed(1) + '%'; this.el.hpnum.textContent = Math.ceil(hp); this.root.classList.toggle('low', f < 0.3); }
  setBoard(html) { const on = !!html; this.el.board.hidden = !on; if (on) this.el.board.innerHTML = html; }
  setPvpScore(html) { const on = !!html; this.el.pvpscore.hidden = !on; if (on) this.el.pvpscore.innerHTML = html; this.el.wave.parentElement.hidden = on; this.el.left.parentElement.hidden = on; }
  setWave(n, left) { this.el.wave.textContent = n; this.el.left.textContent = left; }
  setModifier(text) { this.el.modifier.textContent = text || ''; }
  setTimer(text) { this.el.timer.textContent = text || ''; }
  setScore(score, combo) { this.el.score.textContent = score; this.el.combo.textContent = combo > 1 ? t('hud.combo', { n: combo }) : ''; }
  setWeapon(name, hint) { this.el.weapon.textContent = name; this.el.hint.textContent = hint || ''; }
  setBoss(name, frac) { if (frac == null) { this.el.bossbar.classList.remove('show'); return; } this.el.bossbar.classList.add('show'); this.el.bossname.textContent = name; this.el.bossfill.style.width = (Math.max(0, frac) * 100).toFixed(1) + '%'; }
  // first-run coach card under the crosshair; null hides it
  coach(html) { const c = this.el.coach; if (html == null) { c.classList.remove('show'); return; } c.innerHTML = html; c.classList.add('show'); }
  tip(text, dur = 5) { this.el.tip.innerHTML = text; this.el.tip.classList.add('show'); this._tipT = dur; }
  message(main, sub = '', dur = 2.2) { const m = this.el.msg; m.textContent = main; m.classList.remove('show'); void m.offsetWidth; m.classList.add('show'); this.el.msgsub.textContent = sub; this._msgT = dur; }
  kill(text, pts) {
    const d = document.createElement('div'); d.innerHTML = pts > 0 ? `${text} <span class="pts">+${pts}</span>` : text; this.el.killfeed.appendChild(d);
    setTimeout(() => d.remove(), 1700); while (this.el.killfeed.children.length > 6) this.el.killfeed.firstChild.remove();
  }
  damageFrom(angle) { const i = document.createElement('i'); i.style.transform = `rotate(${(angle * 180 / Math.PI).toFixed(1)}deg)`; this.el.dmg.appendChild(i); setTimeout(() => i.remove(), 1000); }
  showScreen(html) {
    this.el.panel.innerHTML = html; this.el.screen.classList.add('show');
    // in a short window the controls list starts folded so the menu fits; a click on its heading opens it
    for (const d of this.el.panel.querySelectorAll('details.controls')) { d.open = innerHeight >= 700; d.addEventListener('click', (e) => e.stopPropagation()); }
  }
  hideScreen() { this.el.screen.classList.remove('show'); }
  // name and health over other players' heads: tags = [{ id, name, hp, x, y, s }] in screen pixels
  setNameTags(tags) {
    const seen = new Set();
    for (const g of tags) {
      let el = this._tags.get(g.id);
      if (!el) { el = document.createElement('div'); el.className = 'ntag'; el.innerHTML = '<span></span><div class="bar"><div class="fill"></div></div>'; this.el.nametags.appendChild(el); this._tags.set(g.id, el); el._n = null; el._hp = -1; }
      seen.add(g.id);
      if (el._n !== g.name) { el._n = g.name; el.firstChild.textContent = g.name; }
      const hp = Math.round(g.hp * 100); if (el._hp !== hp) { el._hp = hp; el.lastChild.firstChild.style.width = hp + '%'; el.classList.toggle('low', hp < 35); }
      el.style.transform = `translate(${g.x.toFixed(1)}px, ${g.y.toFixed(1)}px) translate(-50%, -100%) scale(${g.s.toFixed(3)})`;
    }
    for (const [id, el] of this._tags) if (!seen.has(id)) { el.remove(); this._tags.delete(id); }
  }
  setGameplayVisible(v) { this.root.classList.toggle('nogame', !v); }
  update(dt) {
    if (this._msgT > 0) { this._msgT -= dt; if (this._msgT <= 0) { this.el.msg.classList.remove('show'); this.el.msgsub.textContent = ''; } }
    if (this._tipT > 0) { this._tipT -= dt; if (this._tipT <= 0) this.el.tip.classList.remove('show'); }
  }
}

// Key names as printed on this player's keyboard: the game reads physical keys, so on AZERTY the
// "W" key is labelled Z. Chrome and Edge can tell us the layout; elsewhere (or inside a frame that
// isn't allowed to ask) the QWERTY names stay.
let LAYOUT = null;
try { if (navigator.keyboard && navigator.keyboard.getLayoutMap) LAYOUT = await Promise.race([navigator.keyboard.getLayoutMap(), new Promise((r) => setTimeout(() => r(null), 300))]); } catch (e) { /* not allowed here */ }
export const keyName = (code) => { const fb = code.replace(/^Key|^Digit/, ''); const v = LAYOUT && LAYOUT.get(code); return v && /^\S$/u.test(v) ? v.toUpperCase() : fb; };
export const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD'].map(keyName);
export const KB_KEYS = { fire: 'LMB', aim: 'RMB', block: 'RMB', jump: 'Space', sprint: 'Shift', slide: keyName('KeyC'), dash: keyName('KeyC'), grapple: keyName('KeyQ'), melee: keyName('KeyF'), reload: keyName('KeyR'), grenade: keyName('KeyG'), get focus() { return t('key.focus'); }, get next() { return t('key.wheel'); }, pause: 'Esc', confirm: 'Space', score: 'Tab' };
// key chips: kd dark, kr red, ky yellow, kp purple, kt teal, kk pink
export const CONTROLS_HTML = `
<details class="controls" open><summary class="colhead">${t('ctl.head')}</summary>
  <div class="cgrid">
    <div><kbd class="kd">${MOVE_KEYS.join('')}</kbd>${t('ctl.move')}</div>
    <div><kbd class="kd">${t('key.mouse')}</kbd>${t('ctl.look')}</div>
    <div><kbd class="kr">Shift</kbd>${t('ctl.sprint')}</div>
    <div><kbd class="kd">LMB</kbd>${t('ctl.fire')}</div>
    <div><kbd class="kd">RMB</kbd>${t('ctl.aim')}</div>
    <div><kbd class="ky">Space</kbd>${t('ctl.jump')}</div>
    <div><kbd class="ky">${keyName('KeyC')}</kbd>${t('ctl.slide')}</div>
    <div><kbd class="kp">${keyName('KeyQ')} / ${keyName('KeyE')}</kbd>${t('ctl.grapple')}</div>
    <div><kbd class="kr">${keyName('KeyF')}</kbd>${t('ctl.quickSlash')}</div>
    <div><kbd class="kr">${keyName('KeyR')}</kbd>${t('ctl.reload')}</div>
    <div><kbd class="ky">${keyName('KeyG')}</kbd>${t('ctl.grenade')}</div>
    <div><kbd class="ky">1-4 / ${t('key.wheel')}</kbd>${t('ctl.switch')}</div>
    <div><kbd class="kk">${t('key.bothButtons')}</kbd>${t('ctl.focus')}</div>
    <div><kbd class="kt">Tab</kbd>${t('ctl.board')}</div>
    <div><kbd class="kt">Esc</kbd>${t('ctl.pause')}</div>
  </div>
</details>`;
// the same card for touch play: each on-screen button next to what it does
const ti = (a) => `<kbd class="kd tkb">${ICONS[a]}</kbd>`;
export const TOUCH_CONTROLS_HTML = `
<details class="controls" open><summary class="colhead">${t('ctl.touchHead')}</summary>
  <div class="cgrid">
    <div>${ti('move')}${t('ctl.move')} · ${t('ctl.sprint')}</div>
    <div>${ti('look')}${t('ctl.look')}</div>
    <div>${ti('fire')}${t('ctl.fire')}</div>
    <div>${ti('aim')}${t('ctl.aim')}</div>
    <div>${ti('jump')}${t('ctl.jump')}</div>
    <div>${ti('crouch')}${t('ctl.slide')}</div>
    <div>${ti('grapple')}${t('ctl.grapple')}</div>
    <div>${ti('melee')}${t('ctl.quickSlash')}</div>
    <div>${ti('reload')}${t('ctl.reload')}</div>
    <div>${ti('grenade')}${t('ctl.grenade')}</div>
    <div>${ti('swap')}${t('ctl.switch')}</div>
    <div>${ti('aim')}${ti('fire')}${t('ctl.focus')}</div>
    <div>${ti('score')}${t('ctl.board')}</div>
    <div>${ti('pause')}${t('ctl.pause')}</div>
  </div>
</details>`;
