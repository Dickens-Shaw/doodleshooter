// Game bootstrap: solo waves, free-for-all lobbies, checkpoints, scoring, screens and the loop.
// Online play is peer-to-peer: one player's browser hosts the lobby and keeps score, every
// player runs their own body, and each one tells the others what it did.
import * as THREE from 'three';
import { InkRenderer, INK, makeInkMaterial } from './render.js';
import { World } from './physics.js';
import { Input } from './input.js';
import { buildLevel, LEVELS } from './level.js';
import { NavGrid } from './nav.js';
import { Effects } from './effects.js';
import { EnemyManager, BOSSES } from './enemies.js';
import { Player } from './player.js';
import { RemotePlayer, encodeLocal } from './players.js';
import { Net } from './net.js';
import { HUD, CONTROLS_HTML, TOUCH_CONTROLS_HTML, MOVE_KEYS, keyName } from './hud.js';
import { TouchUI, ICONS } from './touch.js';
import { audio } from './audio.js';
import { rand, choose, clamp } from './util.js';
import { t, lang, LANGS, setLang } from './i18n.js';
import { platform, platformReady, store } from './platform.js';
import { cleanName, NAME_MAX } from './names.js';
import { useTheme } from './theme.js';

// boot order: SDK ready (awaited, with a timeout) -> saves and language -> build the level
await platformReady;
platform.loadingStart();

const canvas = document.getElementById('c');
const R = new InkRenderer(canvas);
let enemiesRef = null;
function applyTheme(id) {
  const preset = useTheme(id);
  document.documentElement.dataset.theme = preset.id;
  store.set('doodle_theme', preset.id);
  R.applyTheme(preset);
  if (enemiesRef) enemiesRef.syncTheme(preset);
}
applyTheme(store.get('doodle_theme') || 'marker');
const world = new World();
const knownMap = (k) => (LEVELS.some((m) => m.key === k) ? k : 'district');
let mapKey = knownMap(store.get('doodle_map') || 'district');
let level = buildLevel(R.scene, world, mapKey, { arena: false });
let nav = new NavGrid(world, level.bounds, 1).build();
let loadedKey = mapKey, arenaLoaded = false;
audio.setTune(mapKey === 'mexico' ? 'mexico' : 'district');
// the map in play: solo uses the picked map, a match uses the host's choice; a rebuild wipes broken props
function setLevel(key, on, force = false) {
  if (!force && key === loadedKey && on === arenaLoaded) return; loadedKey = key; arenaLoaded = on;
  for (const m of level.meshes) { R.scene.remove(m); if (m.geometry) m.geometry.dispose(); if (m.traverse) m.traverse((o) => { if (o !== m && o.geometry) o.geometry.dispose(); }); }
  level.animated.length = 0; world.clear();
  level = buildLevel(R.scene, world, key, { arena: on }); nav = new NavGrid(world, level.bounds, 1).build();
  ctx.level = level; ctx.nav = nav; if (window.__game) { window.__game.level = level; window.__game.nav = nav; }
  audio.setTune(key === 'mexico' ? 'mexico' : 'district');
}
const setArena = (on) => setLevel(knownMap(net.active ? (lobby.map || mapKey) : mapKey), on);
const input = new Input(canvas);
const hud = new HUD(document.getElementById('hud'));
const touchUI = new TouchUI(input, hud.root);
const effects = new Effects(R.scene, world);
const ctx = { scene: R.scene, camera: R.camera, world, level, nav, input, hud, effects, audio, renderer: R };

// ---------------- persistent bits ----------------
let best = Number(store.get('doodle_best') || 0);
let musicWanted = store.get('doodle_music') !== '0';
let checkpoint = Number(store.get('doodle_checkpoint') || 0);
// names: a signed-in CrazyGames player is shown by their account name (friends must recognise each
// other); a guest keeps a self-picked or random name, which other players see, so it goes through
// the word filter in names.js
const guestName = () => t('name.prefix') + Math.floor(Math.random() * 90 + 10);
let account = await platform.getUser();
function pickName() {
  const acct = account && String(account.username || '').trim().slice(0, NAME_MAX);
  return acct || cleanName((store.get('doodle_name') || '').slice(0, 14), guestName());
}
let myName = pickName();
const remoteName = (n) => cleanName(n, t('name.prefix'));
// a first visit skips the menu: one full-screen click starts wave 1 with the coach
const firstVisit = !store.get('doodle_played') && !best && !checkpoint;
const settings = { sens: Number(store.get('doodle_sens') || 100), invert: store.get('doodle_invert') === '1' };
function applySettings() {
  input.mouseSens = 0.0022 * settings.sens / 100; input.invertY = settings.invert;
  store.set('doodle_sens', String(settings.sens)); store.set('doodle_invert', settings.invert ? '1' : '0');
}
// ---------------- game state ----------------
const FFA_TARGET = 20, FFA_TIME = 600, RESPAWN = 2.5;
let matchLeft = FFA_TIME, clockT = 0, clockRunning = false;
const mmss = (t) => { t = Math.max(0, Math.ceil(t)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
const game = ctx.game = {
  state: 'start', mode: 'solo', menu: false, time: 0, hitstopT: 0, hitstopScale: 1, wave: 0, score: 0, combo: 0, comboT: 0, kills: 0, intermission: 0, queue: [], spawnT: 0, maxAlive: 6, deathT: 0,
  focus: { active: false, t: 0, chain: 0, target: null, dash: null, arm: 0, ready: false }, katanaStreak: 0, boss: null, revived: false, reviveOffered: false, respawnT: 0, matchT: 0, over: null, overT: 0,
  hitstop(d, s) { this.hitstopT = Math.max(this.hitstopT, d); this.hitstopScale = s; },
  addScore(pts, label) { const mult = 1 + Math.min(this.combo, 9) * 0.25; const p = Math.round(pts * mult); this.score += p; if (label) hud.kill(label, p); hud.setScore(this.score, this.combo); },
  onPlayerDeath() { endFocus(); onLocalDeath(); },
};
const online = () => game.mode === 'ffa';
const enemies = ctx.enemies = enemiesRef = new EnemyManager(ctx);
const player = ctx.player = new Player(ctx);
player.name = myName;
const net = new Net();
const remote = new Map();      // peer id -> RemotePlayer
const lobby = { players: new Map(), hostId: null, isPublic: false, status: '', code: '', map: null, hall: false };
const scores = new Map();      // peer id -> { name, kills, deaths }
let screen = 'main';           // which start-screen panel is showing: main | online | lobby
window.__game = { ctx, game, player, enemies, nav, world, level, hud, effects, input, net, remote, lobby, scores };

// anything a bullet or a blade can hit besides enemies
ctx.targets = () => [player, ...remote.values()];
ctx.canHurt = (t) => online() && t !== player;
ctx.raycastPlayers = (o, d, maxDist) => {
  let best = null;
  for (const t of remote.values()) {
    if (!t.alive || !ctx.canHurt(t)) continue;
    for (let i = 0; i < t.hit.length; i++) {
      const c = t.hitSpheres[i], r = t.hit[i][1];
      _v.subVectors(c, o); const tca = _v.dot(d); if (tca < 0 || tca > maxDist) continue;
      const d2 = _v.lengthSq() - tca * tca; if (d2 > r * r) continue;
      const tt = tca - Math.sqrt(r * r - d2); if (tt < 0) continue;
      if (!best || tt < best.dist) best = { player: t, part: t.hit[i][0], dist: tt, point: new THREE.Vector3(o.x + d.x * tt, o.y + d.y * tt, o.z + d.z * tt) };
    }
    // a raised katana sits in front of the chest: a ray that reaches it before the body is turned aside
    if (t.blocking) {
      _bc.set(t.center.x + t.forward.x * 0.5, t.center.y + 0.3, t.center.z + t.forward.z * 0.5); const r = 0.42;
      _v.subVectors(_bc, o); const tca = _v.dot(d);
      if (tca > 0 && tca <= maxDist) { const d2 = _v.lengthSq() - tca * tca; if (d2 <= r * r) { const tt = tca - Math.sqrt(r * r - d2); if (tt >= 0 && (!best || best.player !== t || tt < best.dist)) best = { player: t, part: 'blade', dist: tt, point: new THREE.Vector3(o.x + d.x * tt, o.y + d.y * tt, o.z + d.z * tt) }; } }
    }
  }
  return best;
};
const _bc = new THREE.Vector3();
ctx.playersInArc = (pos, dir, range, cosHalf) => { const out = []; for (const t of remote.values()) { if (!t.alive || !ctx.canHurt(t)) continue; _v.subVectors(t.center, pos); const d = _v.length(); if (d > range + 0.3) continue; if (d > 0.3 && _v.normalize().dot(dir) < cosHalf) continue; if (!world.hasLineOfSight(pos, t.center)) continue; out.push(t); } return out; };
ctx.hitPlayer = (victim, dmg, info) => {
  if (!ctx.canHurt(victim) || !victim.alive) return;
  // a raised katana facing you parries a slash outright and turns some bullets aside
  // the bullet met the blade itself: it glances off, and now and then comes straight back at you
  if (info.part === 'blade') {
    effects.strokeBurst(info.point, INK.ORANGE, 8, 6, { life: 0.22, size: 0.035 }); audio.shieldHit(victim.center);
    const ret = Math.random() < 0.4;
    if (ret) {
      effects.tracer(info.point, player.eye, INK.FOE, 0.03, 0.08); hud.tip(t('tip.deflected'), 0.9);
      player.lastHitBy = victim.id; player.lastHit = { from: victim.center.toArray(), crit: false, amount: dmg * 0.6, src: 'deflect' }; player.takeDamage(dmg * 0.6, victim.center);
    } else hud.tip(t('tip.bounced'), 0.7);
    net.sendTo(victim.id, 'parry', { ret, by: net.id });
    return;
  }
  const facing = victim.blocking ? _v.subVectors(player.center, victim.center).normalize().dot(victim.forward) : -1;
  const frontHit = /^(head|torso|arm|fore)/.test(info.part || '');
  // a slash is only parried by a guard that just came up and faces you
  if (facing > 0.6 && frontHit && info.source === 'katana' && victim.parryWindow) { effects.strokeBurst(info.point, INK.ORANGE, 10, 6, { life: 0.25, size: 0.04 }); audio.shieldHit(victim.center); game.hitstop(0.08, 0.15); player.weapons[player.katanaIndex].cooldown = Math.max(player.weapons[player.katanaIndex].cooldown, 0.6); hud.tip(t('tip.blocked'), 0.9); return; }
  effects.blood(info.point, info.dir, clamp(0.4 + dmg / 80, 0.4, 1.6), { ink: INK.RED }); hud.hitmarker(false, info.crit); audio.hitEnemy(victim.center); victim.flash();
  net.sendTo(victim.id, 'pdmg', { amount: Math.round(dmg), from: player.center.toArray().map((v) => +v.toFixed(1)), by: net.id, crit: !!info.crit, src: info.source });
};
// a slash through another player's rope cuts it: their client drops the hook
const _rp = new THREE.Vector3(), _rq = new THREE.Vector3();
ctx.cutRopes = (eye, dir, range) => {
  let cut = false;
  for (const r of remote.values()) {
    if (!r.alive || !r.grappling) continue;
    _rp.set(r.body.pos.x + r.right.x * 0.35, r.body.pos.y + 1.25, r.body.pos.z + r.right.z * 0.35);
    for (let i = 0; i <= 14; i++) {
      _rq.lerpVectors(_rp, r.gPoint, i / 14).sub(eye); const along = _rq.dot(dir); if (along < 0.3 || along > range) continue;
      const lat = Math.sqrt(Math.max(0, _rq.lengthSq() - along * along)); if (lat > 0.9) continue;
      _rq.add(eye); effects.strokeBurst(_rq, INK.ORANGE, 10, 5, { life: 0.25, size: 0.035 }); net.sendTo(r.id, 'cut', {}); hud.tip(t('tip.ropeCut'), 0.9); cut = true; break;
    }
  }
  return cut;
};
const _v = new THREE.Vector3();
// breakable props: bullets, blades and blasts break them, and everyone in a match sees it go
ctx.breakHit = (br, dmg, point, dir) => {
  if (!br.alive) return; br.hp -= dmg;
  if (br.hp <= 0) breakProp(br, dir, true); else { effects.strokeBurst(point, br.ink, 5, 4, { life: 0.2, size: 0.03 }); audio.shieldHit(point); }
};
ctx.breakablesInArc = (pos, dir, range, cosHalf) => level.breakables.filter((br) => { if (!br.alive) return false; _v.subVectors(br.pos, pos); const d = _v.length(); return d < range + 0.5 && (d < 0.4 || _v.divideScalar(d).dot(dir) > cosHalf); });
ctx.blastBreakables = (c, R) => { for (const br of level.breakables) if (br.alive && br.pos.distanceTo(c) < R * 0.9) breakProp(br, br.pos.clone().sub(c).normalize(), true); };
function breakProp(br, dir, local, quiet = false) {
  if (!br.alive) return; br.alive = false; world.removeBox(br.box);
  const g = br.group, pos = br.pos; const d = dir && dir.lengthSq() > 0.01 ? dir.clone().normalize() : new THREE.Vector3(rand(-1, 1), 1, rand(-1, 1)).normalize();
  if (quiet) { R.scene.remove(g); return; }
  g.updateMatrixWorld(true);
  for (const child of [...g.children]) {
    child.updateWorldMatrix(true, false); R.scene.attach(child);
    const v = d.clone().multiplyScalar(rand(2, 6)); v.x += rand(-3, 3); v.z += rand(-3, 3); v.y += rand(2.5, 6.5);
    effects.debris(child, child.position, v, new THREE.Vector3(rand(-9, 9), rand(-9, 9), rand(-9, 9)), { radius: 0.14, blood: false, life: rand(6, 9) });
  }
  R.scene.remove(g);
  const up = new THREE.Vector3(0, 1, 0);
  if (br.kind === 'pinata') {
    for (const ink of [INK.PINK, INK.ORANGE, INK.GREEN]) effects.strokeBurst(pos, ink, 16, 7, { life: 0.7, size: 0.05 });
    effects.explosion(pos, 2.5, INK.PINK); if (!net.active || net.isHost) for (let i = 0; i < 2; i++) spawnPickup('health', pos.clone().add(new THREE.Vector3(rand(-1.2, 1.2), 0, rand(-1.2, 1.2))));
    if (game.mode === 'solo') game.addScore(25, t('pts.pinata'));
  } else if (br.kind === 'cactus') { effects.blood(pos, d, 1.4, { ink: INK.GREEN }); effects.bloodPool(new THREE.Vector3(pos.x, 0, pos.z), 1.1, INK.GREEN); }
  else { effects.strokeBurst(pos, br.ink, 12, 5, { life: 0.35, size: 0.04 }); effects.smoke(pos, up, 3); }
  audio.smash(pos, br.kind === 'barrel' || br.kind === 'crate' || br.kind === 'cactus');
  if (local && net.active) net.broadcast('brk', { id: br.id });
}
// every ray a gun fires this tick is sent to the others, who draw it as a tracer from the shooter's gun
const shotQueue = [];
ctx.onShot = (end) => { if (net.active && inMatch()) shotQueue.push(+end.x.toFixed(1), +end.y.toFixed(1), +end.z.toFixed(1)); };
const TRACER_THICK = { rifle: 0.02, shotgun: 0.014, sniper: 0.03 };
const _sm = new THREE.Vector3(), _se = new THREE.Vector3();

// ---------------- pickups ----------------
const pickups = []; let pickupId = 1;
const pmat = { ammo: makeInkMaterial({ ink: INK.BLUE }), health: makeInkMaterial({ ink: INK.GREEN }), cap: makeInkMaterial({ ink: INK.BLACK }), shell: makeInkMaterial({ ink: INK.ORANGE }) };
function makePickup(kind) {
  const g = new THREE.Group();
  if (kind === 'ammo') { g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.5, 10), pmat.ammo)); const c = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.16, 8), pmat.cap); c.position.y = 0.33; g.add(c); const l = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.02), pmat.cap); l.position.set(0, 0, 0.24); g.add(l); }
  else if (level.key === 'mexico') { const sh = new THREE.CylinderGeometry(0.42, 0.42, 0.22, 12, 1, false, 0, Math.PI); sh.rotateZ(Math.PI / 2); sh.rotateX(-Math.PI / 2); g.add(new THREE.Mesh(sh, pmat.shell)); const f = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.1, 0.2), pmat.health); f.position.y = 0.02; g.add(f); const m = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.08, 0.14), pmat.cap); m.position.y = 0.1; g.add(m); }
  else { g.add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.2, 0.2), pmat.health), new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), pmat.health)); }
  return g;
}
function spawnPickup(kind, pos, id = null) {
  const m = makePickup(kind); m.position.copy(pos); m.position.y += 0.6; R.scene.add(m);
  const p = { id: id ?? pickupId++, kind, mesh: m, base: m.position.y, t: rand(0, 6), life: 45 }; pickups.push(p);
  if (net.isHost) net.send('pickup', { id: p.id, kind, pos: pos.toArray() });
  return p;
}
function removePickup(p) { R.scene.remove(p.mesh); const i = pickups.indexOf(p); if (i >= 0) pickups.splice(i, 1); }
function collectPickup(p) {
  if (p.kind === 'ammo') { player.addAmmoAll(0.4); player.grenades = Math.min(player.maxGrenades, player.grenades + 1); hud.kill(t('pick.ammo'), 0); } else { player.hp = Math.min(player.maxHp, player.hp + 35); hud.kill(level.key === 'mexico' ? t('pick.taco') : t('pick.health'), 0); }
  audio.pickup(); effects.strokeBurst(p.mesh.position, p.kind === 'ammo' ? INK.BLUE : INK.GREEN, 12, 4, { life: 0.3 });
}
function updatePickups(dt) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i]; p.t += dt; p.mesh.position.y = p.base + Math.sin(p.t * 2.5) * 0.12; p.mesh.rotation.y += dt * 1.8;
    if (player.alive && p.mesh.position.distanceTo(player.center) < 1.5) {
      collectPickup(p); removePickup(p);
      if (net.active) net.send(net.isHost ? 'taken' : 'take', { id: p.id });
      continue;
    }
    if (!net.active || net.isHost) { p.life -= dt; if (p.life <= 0) { removePickup(p); if (net.isHost) net.send('taken', { id: p.id }); } }
  }
}
let pickupClock = 0;
function updateArenaPickups(dt) {
  if (!net.isHost) return; pickupClock -= dt;
  if (pickupClock <= 0 && pickups.length < 10) { pickupClock = 7; spawnPickup('ammo', choose(level.pickups)); }
}

// ---------------- solo waves ----------------
const ROSTER = [
  { t: 'grunt', from: 1, w: 10 }, { t: 'rusher', from: 2, w: 6 }, { t: 'bomber', from: 3, w: 3 },
  { t: 'sniper', from: 3, w: 4 }, { t: 'flyer', from: 4, w: 4 }, { t: 'heavy', from: 5, w: 4 }, { t: 'shield', from: 6, w: 4 },
];
const MODIFIERS = [
  { key: '', name: '', apply: () => { enemies.mods.speed = 1; enemies.mods.damage = 1; } },
  { key: 'caffeine', name: t('mod.caffeine'), apply: () => { enemies.mods.speed = 1.35; enemies.mods.damage = 0.85; } },
  { key: 'heavyInk', name: t('mod.heavyInk'), apply: () => { enemies.mods.speed = 0.9; enemies.mods.damage = 1.4; } },
  { key: 'swarm', name: t('mod.swarm'), apply: () => { enemies.mods.speed = 1.15; enemies.mods.damage = 0.9; } },
];
// first-run coach: move, shoot, grapple, each shown as the keys to press until the player has done it
const coach = { step: -1, n: 0 };
const MOUSE_SVG = '<svg class="mouse" viewBox="0 0 24 36"><rect x="2" y="2" width="20" height="32" rx="10" fill="#fff" stroke="currentColor" stroke-width="2"/><path d="M12 3 A9 9 0 0 0 3 12 V15 H12 Z" fill="#ff6b6b"/><path d="M2 15 H22 M12 2 V15" stroke="currentColor" stroke-width="2" fill="none"/></svg>';
function coachHTML(step) {
  const keys = input.touch ? `<kbd class="tkb">${ICONS[['move', 'fire', 'grapple'][step]]}</kbd>`
    : step === 0 ? `<span class="wasd">${MOVE_KEYS.map((k) => `<kbd>${k}</kbd>`).join('')}</span>` : step === 1 ? MOUSE_SVG : `<kbd>${hud.key('grapple')}</kbd>`;
  const [label, ...hint] = t(['coach.move', 'coach.shoot', 'coach.grapple'][step]).split(' · ');
  return `<div class="c-row">${keys}<span>${label}${hint.length ? `<small>${hint.join(' · ')}</small>` : ''}</span></div><div class="c-foot"><span>${step + 1} / 3</span>${input.touch ? '' : `<span>${t('coach.skip', { key: '<kbd>Enter</kbd>' })}</span>`}</div>`;
}
function coachStart() { coach.step = 0; coach.n = 0; hud.coach(coachHTML(0)); }
function coachEnd(done) { if (coach.step < 0) return; coach.step = -1; hud.coach(null); if (done) hud.tip(t('coach.done'), 3); }
function updateCoach(dt) {
  if (coach.step < 0) return;
  if (game.mode !== 'solo' || game.state === 'start' || game.state === 'dead') { coachEnd(false); return; }
  if (game.state !== 'play' || game.menu) return;
  if (input.pressed('confirm')) { coachEnd(false); return; }
  let ok = false;
  if (coach.step === 0) { if (input.move.x || input.move.y) coach.n += dt; ok = coach.n > 0.8; }
  else if (coach.step === 1) { if (input.pressed('fire')) coach.n++; ok = coach.n >= 3; }
  else { if (input.pressed('grapple')) coach.n++; ok = player.grapple.state === 'on' || coach.n >= 3; }
  if (!ok) return;
  coach.step++; coach.n = 0;
  if (coach.step > 2) coachEnd(true); else hud.coach(coachHTML(coach.step));
}
const tips = () => [
  t('tip.reel', { key: hud.key('grapple') }),
  t('tip.block', { key: hud.key('block') }),
  t('tip.air'),
  t('tip.grenade', { key: hud.key('grenade') }),
  t('tip.double', { key: hud.key('jump') }),
];
const bossFor = (n) => BOSSES[(Math.floor(n / 5) - 1) % BOSSES.length];
const enemyName = (type) => t('foe.' + type);
function startWave(n) {
  game.wave = n; game.queue = []; game.spawnT = 2; game.intermission = 0; game.boss = null; hud.setBoss(null, null);
  const boss = n > 0 && n % 5 === 0;
  const allowed = boss || n < 4 ? 1 : n < 6 ? 3 : MODIFIERS.length; const mod = MODIFIERS[Math.floor(Math.random() * allowed)];
  mod.apply(); enemies.mods.damage *= 1.2; hud.setModifier(mod.name);
  const swarm = mod.key === 'swarm';
  // the crowd on screen and the wave size both keep growing with the wave number
  game.maxAlive = Math.min(4 + Math.floor(n * 0.9) + (swarm ? 3 : 0), (swarm ? 22 : 18) + Math.floor(n / 3));
  let count = Math.round(Math.min(5 + n * 2.0, 32 + n) * (swarm ? 1.35 : 1));
  if (boss) { count = 7 + n; game.maxAlive += 2 + Math.floor(n / 5); game.queue.push(bossFor(n)); }
  const pool = ROSTER.filter((r) => n >= r.from).map((r) => ({ t: r.t, w: r.w * Math.min(1, 0.3 + 0.25 * (n - r.from)) }));
  const total = pool.reduce((a, r) => a + r.w, 0);
  for (let i = 0; i < count; i++) { let r = Math.random() * total, t = pool[0].t; for (const c of pool) { r -= c.w; if (r <= 0) { t = c.t; break; } } game.queue.push(t); }
  if (boss) { hud.message(t('wave.n', { n }), t('wave.boss', { name: enemyName(bossFor(n)) }), 3); audio.bossRoar(player.center); }
  else hud.message(t('wave.n', { n }), n === 1 ? t('wave.first') : mod.name || t(choose(['wave.f1', 'wave.f2', 'wave.f3', 'wave.f4', 'wave.f5'])), 2.6);
  audio.wave();
  if (n <= tips().length && !(n === 1 && coach.step >= 0)) hud.tip(tips()[n - 1], 7);
  player.grenades = Math.min(player.maxGrenades, player.grenades + 1);
  for (let i = 0; i < 7; i++) spawnPickup(i < 5 ? 'ammo' : 'health', choose(level.pickups));
  if (n >= 5 && n % 5 === 0 && n > checkpoint) { checkpoint = n; store.set('doodle_checkpoint', String(n)); hud.kill(t('wave.checkpoint', { n }), 0); platform.happytime(); }
}
function pickSpawn(type) {
  const spots = type === 'sniper' ? level.snipers : level.spawns; const pp = player.body.pos;
  if (type === 'flyer') { const a = Math.random() * Math.PI * 2, r = 22 + Math.random() * 10; return new THREE.Vector3(clamp(pp.x + Math.cos(a) * r, level.bounds.minX + 4, level.bounds.maxX - 4), pp.y + 12 + Math.random() * 6, clamp(pp.z + Math.sin(a) * r, level.bounds.minZ + 4, level.bounds.maxZ - 4)); }
  if (BOSSES.includes(type)) {
    const fits = (sp) => !world.overlapsAABB({ x: sp.x - 1.1, y: sp.y + 0.1, z: sp.z - 1.1 }, { x: sp.x + 1.1, y: sp.y + 5.2, z: sp.z + 1.1 });
    const open = spots.filter((sp) => fits(sp)); const far = open.filter((sp) => sp.distanceTo(pp) > 20);
    if (far.length) return choose(far).clone(); if (open.length) return choose(open).clone();
    for (let i = 0; i < 200; i++) { const a = Math.random() * Math.PI * 2, r = 22 + Math.random() * 18; const c = new THREE.Vector3(clamp(pp.x + Math.cos(a) * r, -44, 44), 0, clamp(pp.z + Math.sin(a) * r, -44, 44)); c.y = world.groundBelow(c.x, 30, c.z, 40); if (c.y > -3 && fits(c)) return c; }
    return level.playerStart.clone();
  }
  let cands = spots.filter((s) => { const d = s.distanceTo(pp); return d > 14 && d < 48; });
  if (cands.length < 2) cands = spots.filter((s) => s.distanceTo(pp) > 14);
  const hidden = cands.filter((s) => !world.hasLineOfSight(player.eye, new THREE.Vector3(s.x, s.y + 1.2, s.z)));
  return (choose(hidden.length ? hidden : cands.length ? cands : spots)).clone();
}
function updateWaves(dt) {
  if (game.intermission > 0) {
    game.intermission -= dt; hud.setTimer(t('wave.next', { n: Math.ceil(game.intermission) }));
    if (game.intermission <= 0) { hud.setTimer(''); startWave(game.wave + 1); }
    return;
  }
  if (game.queue.length && enemies.alive < game.maxAlive) {
    game.spawnT -= dt;
    if (game.spawnT <= 0) {
      game.spawnT = Math.max(0.7, 2.9 - game.wave * 0.13); const t = game.queue.shift(); const e = enemies.spawn(t, pickSpawn(t));
      if (e.T.boss) { const mul = 1 + 0.35 * Math.floor((game.wave - 5) / 15); e.hp = e.maxHp = Math.round(e.T.hp * mul); }
    }
  }
  if (!game.queue.length && enemies.alive === 0) {
    game.intermission = 8; hud.message(t('wave.cleared', { n: game.wave }), t('wave.breath', { pts: 200 * game.wave }), 2.5);
    game.addScore(200 * game.wave, null); audio.waveClear(); player.hp = Math.min(player.maxHp, player.hp + 40);
  }
  hud.setWave(game.wave, enemies.alive + game.queue.length);
}
enemies.onKill = (e, info, over) => {
  game.kills++; game.combo++; game.comboT = 3.5;
  let label = e.T.name, pts = e.T.score;
  if (info.crit) { label = t('pts.headshot'); pts += 60; }
  if (info.source === 'katana') { label = over ? t('pts.cleanCut') : t('pts.slashed'); pts += 50; }
  if (info.source === 'focus') { label = t('pts.executed'); pts += 150; }
  if (info.source === 'katana' || info.source === 'focus') { game.katanaStreak++; player.weapons[player.katanaIndex].addBlood(0.42); if (game.katanaStreak >= KATANA_CHARGE_KILLS) enterFocus(); }
  else if (info.source !== 'blast') game.katanaStreak = 0;
  if (info.source === 'deflect') { label = t('pts.returned'); pts += 120; }
  if (info.source === 'fall') label = t('pts.fell');
  else if (!player.body.onGround && info.source !== 'deflect') { label += t('pts.air'); pts += 40; }
  game.addScore(pts, label); audio.kill(!!info.crit || e.T.boss); if (e.T.boss) platform.happytime();
  const r = Math.random(); if (r < 0.5) spawnPickup('ammo', e.body.pos); else if (r < 0.62) spawnPickup('health', e.body.pos);
};
enemies.onBoss = (e) => { if (!e.alive) { hud.setBoss(null, null); game.boss = null; } else { game.boss = e; hud.setBoss(e.T.name, e.hp / e.maxHp); } };
player.onThrow = (d) => { if (net.active) net.broadcast('nade', d); };

// ---------------- focus slash (solo only) ----------------
const FOCUS_TIME = 2.6, FOCUS_SCALE = 0.26, FOCUS_RANGE = 24, FOCUS_MAX_CHAIN = 2, FOCUS_ARM = 0.18, DASH_SPEED = 46, KATANA_CHARGE_KILLS = 3;
const _fv = new THREE.Vector3();
function focusCandidate() {
  let best = null, bestScore = -1;
  for (const e of enemies.enemies) {
    if (!e.alive || e.state === 'spawn') continue;
    _fv.subVectors(e.center, player.eye); const d = _fv.length(); if (d > FOCUS_RANGE || d < 0.5) continue;
    const aim = _fv.divideScalar(d).dot(player.forward); if (aim < 0.4) continue;
    if (!world.hasLineOfSight(player.eye, e.center)) continue;
    const score = aim * 3 - d / FOCUS_RANGE; if (score > bestScore) { bestScore = score; best = e; }
  }
  return best;
}
// Touch aim assist: thumbs can't track like a mouse, so on a touch screen the view is pulled
// toward the nearest target inside a wide cone and the gun fires by itself once the crosshair is on
// it. Against other players online the pull is gentler, so it helps without aiming for you.
const ASSIST_CONE = 0.3;   // radians either side of the crosshair
const _aa = new THREE.Vector3();
let touchWas = false;
function aimAssist(dt) {
  if (game.state !== 'play' || game.menu || !player.alive || player.dashLock) return;
  const w = player.weapon, melee = !w.isGun;
  const range = melee ? 3.4 : w.kind === 'shotgun' ? 26 : 80;
  let best = null, bestA = melee ? 0.7 : ASSIST_CONE, bestD = 0, pvp = false;
  const consider = (pt, isPlayer) => {
    _aa.subVectors(pt, player.eye); const d = _aa.length(); if (d < 0.4 || d > range) return;
    const a = Math.acos(clamp(_aa.dot(player.forward) / d, -1, 1)); if (a >= bestA) return;
    if (!world.hasLineOfSight(player.eye, pt)) return;
    best = pt; bestA = a; bestD = d; pvp = isPlayer;
  };
  for (const e of enemies.enemies) if (e.alive && e.state !== 'spawn') consider(e.center, false);
  if (online()) for (const r of remote.values()) if (r.alive && ctx.canHurt(r)) consider(r.center, true);
  if (!best) return;
  // magnet: turn toward the target, harder the closer it already is to the crosshair
  _aa.subVectors(best, player.eye).normalize();
  const wantYaw = Math.atan2(-_aa.x, -_aa.z), wantPitch = Math.asin(clamp(_aa.y, -1, 1));
  let dy = wantYaw - player.yaw; dy -= Math.round(dy / (Math.PI * 2)) * Math.PI * 2;
  const k = (pvp ? 4 : 9) * (0.35 + 0.65 * (1 - bestA / ASSIST_CONE));
  const f = Math.min(1, k * dt); player.yaw += dy * f; player.pitch += (wantPitch - player.pitch) * f;
  // auto fire once the crosshair sits on the body (a scoped rifle only while scoped in)
  const onTarget = bestA < Math.max(0.05, Math.atan(0.6 / bestD)) || melee;
  if (!onTarget || (w.scope && !input.down('aim'))) return;
  input.state.fire = w.auto || melee ? true : !input.prev.fire;
}
function enterFocus() {
  if (online() || game.focus.chain >= FOCUS_MAX_CHAIN || !focusCandidate()) return;
  const fresh = !game.focus.active;
  game.focus.active = true; game.focus.t = FOCUS_TIME; game.focus.chain++; game.focus.arm = FOCUS_ARM; game.focus.ready = false;
  if (fresh) { audio.focusIn(); hud.tip(t('tip.focusReady', { key: hud.key('focus') }), 2.2); }
}
function endFocus() { if (!game.focus.active && !game.focus.dash) return; game.focus.active = false; game.focus.target = null; game.focus.chain = 0; game.focus.dash = null; game.katanaStreak = 0; player.dashLock = false; hud.setFocusMark(null); }
function startFocusDash(target) { game.focus.dash = { target, t: 0, trail: player.center.clone(), lastTrail: 0 }; player.dashLock = true; player.body.vel.set(0, 0, 0); audio.dash(); player.kickFov(5); hud.setFocusMark(null); }
function marchBody(b, nx, nz, dist) {
  let moved = 0;
  for (let step = Math.min(0.22, dist); moved + 1e-4 < dist;) { const s2 = Math.min(step, dist - moved); b.pos.x += nx * s2; b.pos.z += nz * s2; if (world.overlapsBody(b)) { b.pos.y += 0.65; if (world.overlapsBody(b)) { b.pos.y -= 0.65; b.pos.x -= nx * s2; b.pos.z -= nz * s2; return moved; } } moved += s2; }
  return moved;
}
function updateFocusDash(dt) {
  const d = game.focus.dash; if (!d) return true;
  const target = d.target; d.t += dt;
  if (!target.alive || d.t > 1.2) { endDash(false); return true; }
  const b = player.body; const dx = target.body.pos.x - b.pos.x, dz = target.body.pos.z - b.pos.z; const flat = Math.hypot(dx, dz); const nx = dx / (flat || 1), nz = dz / (flat || 1);
  player.yaw = Math.atan2(-dx, -dz); _fv.subVectors(target.center, player.eye); player.pitch = clamp(Math.atan2(_fv.y, Math.hypot(_fv.x, _fv.z)), -1.2, 1.2);
  const want = Math.max(0, flat - 1.1); const moved = marchBody(b, nx, nz, Math.min(DASH_SPEED * dt, want));
  const aimY = target.body.pos.y + (target.T.flying ? 0.2 : 0); const dy = aimY - b.pos.y;
  if (Math.abs(dy) > 0.05) { const y = b.pos.y; b.pos.y += clamp(dy, -DASH_SPEED * dt, DASH_SPEED * dt); if (world.overlapsBody(b)) { b.pos.y = y; d.stuckY = (d.stuckY || 0) + dt; } else d.stuckY = 0; }
  d.lastTrail += dt; if (d.lastTrail > 0.02) { d.lastTrail = 0; effects.tracer(d.trail, player.center, INK.BLUE, 0.045, 0.28); d.trail.copy(player.center); effects.strokeBurst(player.center, INK.BLUE, 2, 5, { life: 0.22, size: 0.03 }); }
  const reach = Math.hypot(flat, Math.max(0, Math.abs(dy) - 0.6));
  if (reach <= 1.5) { focusExecute(target); return true; }
  if (moved < 1e-4 && want > 0.05 && (d.stuckY || 0) > 0.08) { endDash(true); return true; }
  return false;
}
function endDash(blocked) { player.dashLock = false; game.focus.dash = null; player.body.vel.set(0, 0, 0); if (blocked) { player.weapons[player.katanaIndex].startSlash(player._weaponState(false, false, 0)); audio.katanaSwing(); hud.tip(t('tip.dashBlocked'), 1.2); } }
function focusExecute(target) {
  player.dashLock = false; game.focus.dash = null; player.body.vel.set(0, 0, 0);
  player.weapons[player.katanaIndex].startSlash(player._weaponState(false, false, 0));
  _fv.subVectors(target.center, player.eye); const dir = _fv.clone().normalize(); const chainBefore = game.focus.chain;
  enemies.damage(target, 100000, { point: target.center.clone(), dir, part: 'head', source: 'focus', crit: true });
  audio.focusSlash(); game.hitstop(0.1, 0.08); effects.shakeAmt += 0.35; player.kickFov(6); player.hp = Math.min(player.maxHp, player.hp + 6);
  if (game.focus.chain === chainBefore) game.focus.t = Math.min(game.focus.t, 0.35);
  game.focus.target = null; hud.setFocusMark(null);
}
function updateFocus(dt) {
  const f = game.focus; if (!f.active) return;
  if (f.dash) { updateFocusDash(dt); return; }
  f.t -= dt; f.arm -= dt; if (f.t <= 0 || !player.alive) { endFocus(); return; }
  const combo = (input.down('aim') && input.down('fire')) || input.down('dash'); if (!combo) f.ready = true;
  const target = focusCandidate(); f.target = target;
  if (!target) { hud.setFocusMark(null); return; }
  _fv.copy(target.center).project(R.camera);
  if (_fv.z < 1) hud.setFocusMark((_fv.x * 0.5 + 0.5) * window.innerWidth, (-_fv.y * 0.5 + 0.5) * window.innerHeight); else hud.setFocusMark(null);
  if (combo && f.ready && f.arm <= 0) { input.consume('fire'); startFocusDash(target); }
}

// ---------------- free for all: spawning, death, scoring ----------------
// how a player died travels over the network as a weapon key and is put into words by each reader
const HOW = ['rifle', 'shotgun', 'sniper', 'katana', 'grenade', 'deflect'];
const howWord = (src) => (HOW.includes(src) ? t('wpn.' + src) : null);
const howText = (src, crit) => { const w = howWord(src); return w ? ' · ' + w + (crit ? t('death.headshot') : '') : ''; };
const spawnSpots = () => (level.arenaSpawns && level.arenaSpawns.length ? level.arenaSpawns : level.spawns);
function arenaSpawn() {
  const spots = spawnSpots(); const others = [...remote.values()].filter((r) => r.alive && r.root && r.root.visible);
  const scored = spots.map((s) => ({ s, d: others.reduce((a, r) => Math.min(a, r.body.pos.distanceTo(s)), 999) }));
  scored.sort((a, b) => b.d - a.d);
  return choose(scored.slice(0, Math.min(3, scored.length))).s.clone();
}
// a spot for a late joiner: the one farthest from everybody already in the match
function farthestSpawnIndex() {
  const spots = spawnSpots(); const bodies = [player, ...remote.values()].filter((r) => r.alive); let best = 0, bd = -1;
  spots.forEach((s, i) => { const d = bodies.reduce((a, r) => Math.min(a, r.body.pos.distanceTo(s)), 999); if (d > bd) { bd = d; best = i; } });
  return best;
}
function onLocalDeath() {
  if (!online()) { game.state = 'dying'; game.deathT = 0; return; }
  const killer = player.lastHitBy || null; const h = player.lastHit || {};
  const dir = h.from ? player.center.clone().sub(new THREE.Vector3().fromArray(h.from)).normalize().toArray().map((v) => +v.toFixed(2)) : null;
  const how = killer && HOW.includes(h.src) ? h.src : null;
  net.broadcast('pdead', { killer, dir, over: !!(h.crit || h.amount >= 90 || h.src === 'katana'), how, crit: !!h.crit });
  if (net.isHost) tallyDeath(net.id, killer);
  game.respawnT = RESPAWN; game.state = 'dying'; game.deathT = 0;
  const kn = killer && scores.get(killer) ? scores.get(killer).name : null;
  hud.kill(kn ? t('death.by', { name: kn }) + howText(how, h.crit) : t('death.erased'), 0);
}
function respawnLocal() {
  player.reset(arenaSpawn()); player.name = myName; player.lastHitBy = null; player.lastHit = null; game.state = 'play'; player.shieldT = 2; hud.tip(t('tip.spawnShield'), 1.6);
  effects.strokeBurst(player.center, INK.BLUE, 24, 6, { life: 0.5, size: 0.03 }); audio.spawn(player.center);
}
function tallyDeath(victim, killer) {
  const v = scores.get(victim); if (v) v.deaths++;
  if (killer && killer !== victim) { const k = scores.get(killer); if (k) k.kills++; }
  sendScores(); checkWin();
}
function sendScores() { const rows = [...scores.entries()].map(([id, s]) => ({ id, ...s })); net.send('score', rows); applyScores(rows); }
function applyScores(rows) { scores.clear(); for (const r of rows) scores.set(r.id, { name: r.id === net.id ? myName : remoteName(r.name), kills: r.kills, deaths: r.deaths }); refreshScoreHud(); }
function sortedScores() { return [...scores.entries()].sort((a, b) => b[1].kills - a[1].kills || a[1].deaths - b[1].deaths); }
function refreshScoreHud() {
  if (!online()) return;
  const rows = sortedScores(); const top = rows.slice(0, 3); const myIdx = rows.findIndex(([id]) => id === net.id);
  if (myIdx >= 3) top.push(rows[myIdx]);
  hud.setPvpScore(top.map(([id, sc]) => `<div class="row${id === net.id ? ' me' : ''}"><span class="rank">${rows.findIndex(([x]) => x === id) + 1}.</span><span>${esc(sc.name)}${id === net.id ? t('who.youTag') : ''}</span><b>${sc.kills}</b></div>`).join('') + `<div class="target">${t('ffa.firstTo', { n: FFA_TARGET })}</div>`);
  hud.setModifier('');
  if (!hud.el.board.hidden) hud.setBoard(boardHTML());
}
function boardHTML(title = t('ffa.name')) {
  const rows = sortedScores();
  return `<h3>${title}</h3>${rows.map(([id, s]) => `<div class="${id === net.id ? 'me' : ''}"><span>${s.name}${id === net.id ? t('who.youTag') : ''}</span><span>${t('ffa.kd', { k: s.kills, d: s.deaths })}</span></div>`).join('')}<div class="foot">${t('ffa.foot', { n: FFA_TARGET, t: mmss(matchLeft), code: String(net.aliasCode || net.code || '').replace(/-\d+$/, '') })}</div>`;
}
function checkWin() {
  if (!net.isHost || !online() || game.over) return;
  let winner = null;
  for (const [id, s] of scores) if (s.kills >= FFA_TARGET) winner = { id, name: s.name };
  if (winner) { net.send('end', winner); endMatch(winner); }
}
function endMatch(winner) {
  game.over = winner; game.overT = 0; game.state = 'over'; endFocus(); input.exitLock(); hud.setBoard(null);
  platform.requestAd('midgame', adHooks); // the host's page keeps running underneath, so the match still wraps up for everyone
  const title = winner.id === net.id ? t('ffa.win') : t('ffa.wins', { name: winner.name || t('who.someone') });
  if (winner.id === net.id) platform.happytime();
  hud.setGameplayVisible(false); hud.showScreen(`<h1>${title}</h1><div class="scoreboard">${sortedScores().map(([id, s]) => `<div class="${id === net.id ? 'me' : ''}"><span>${s.name}</span><span>${t('ffa.kd', { k: s.kills, d: s.deaths })}</span></div>`).join('')}</div><div class="go" id="overGo">${lobby.hall ? t('hall.next') : t('ffa.backSoon')}</div>`);
}

// ---------------- networking ----------------
function addRemote(id, name) {
  if (remote.has(id)) { const r = remote.get(id); r.name = name; return r; }
  const rp = new RemotePlayer(ctx, id, name, 0, INK.FOE);
  rp.onDamage = (t, amount, fromPos) => { if (!ctx.canHurt(t) || !t.alive) return; hud.hitmarker(false, false); net.sendTo(t.id, 'pdmg', { amount: Math.round(amount), from: fromPos ? fromPos.toArray().map((v) => +v.toFixed(1)) : null, by: net.id, src: 'grenade' }); };
  remote.set(id, rp); return rp;
}
function removeRemote(id) { const r = remote.get(id); if (r) { r.dispose(); remote.delete(id); } lobby.players.delete(id); scores.delete(id); }
function lobbyRows() { return [...lobby.players.entries()].map(([id, p]) => ({ id, name: p.name })); }
function broadcastLobby() { net.send('lobby', { players: lobbyRows(), hostId: net.id, isPublic: lobby.isPublic, map: lobby.map || mapKey, shown: net.aliasCode || net.code }); renderLobby(); }
const inMatch = () => ['play', 'dying', 'over'].includes(game.state);
net.onPeerLeave = (id) => { const nm = (lobby.players.get(id) || {}).name; removeRemote(id); broadcastLobby(); if (inMatch()) { hud.kill(t('feed.left', { name: nm || t('who.someone') }), 0); sendScores(); } };
net.onDisconnect = () => { if (lobby.order && lobby.order.some((id) => id !== lobby.hostId)) migrateHost(); else if (lobby.hall) reopenHall(); else leaveOnline(t('host.leftLobby')); };
// ---- host transfer: when the host goes, the earliest-joined player left takes over on a generation
// code (the old code is slow to free up on the signalling server); everyone else rejoins there
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let migrating = false;
async function migrateHost(me) { if (migrating) return; migrating = true; try { await _migrateHost(me); } finally { migrating = false; } }
async function _migrateHost(me) {
  const oldHost = lobby.hostId, myId = me || net.id; const gen = (lobby.gen || 0) + 1; lobby.gen = gen;
  const base = (lobby.code || net.code || '').replace(/-\d+$/, ''); const code = base + '-' + gen;
  const roster = (lobby.order || []).filter((id) => id !== oldHost && lobby.players.has(id)); if (!roster.length || !base) { if (lobby.hall) reopenHall(); else leaveOnline(t('host.leftLobby')); return; }
  const successor = roster[0]; const wasInMatch = inMatch();
  if (oldHost) { const r = remote.get(oldHost); if (r) r.dispose(); remote.delete(oldHost); lobby.players.delete(oldHost); scores.delete(oldHost); }
  hud.message(t('host.left'), successor === myId ? t('host.youNow') : t('host.moving'), 2.6);
  if (successor === myId) {
    let ok = false;
    for (let tries = 0; tries < 2 && !ok; tries++) { try { await net.host({ isPublic: lobby.isPublic, code }); ok = true; } catch (e) { await sleep(800); } }
    if (!ok) { if (lobby.hall) reopenHall(); else leaveOnline(t('host.cantTake')); return; }
    const mine = lobby.players.get(myId) || { name: myName }; lobby.players.delete(myId); lobby.players.set(net.id, mine);
    const ms = scores.get(myId); scores.delete(myId); if (ms) scores.set(net.id, ms);
    lobby.hostId = net.id; lobby.code = code; lobby.order = [net.id, ...roster.filter((id) => id !== myId)]; net.accepting = true; game.clockStarted = clockRunning || matchLeft < FFA_TIME;
    net.onAlias = () => { broadcastLobby(); hud.kill(t('feed.codeBack', { code: base }), 0); }; net.claimAlias(base);
    if (game.state === 'over') { /* the results stay up; the host timer now runs here */ } else if (wasInMatch) { if (game.state !== 'play' && game.state !== 'dying') game.state = 'play'; refreshScoreHud(); } else { game.state = 'lobby'; screen = 'lobby'; showStart(); }
    broadcastLobby();
  } else {
    await sleep(1200);
    const deadline = performance.now() + 20000; let joined = false;
    while (!joined && performance.now() < deadline) { try { await net.join(code, { name: myName, prev: myId }); joined = true; } catch (e) { await sleep(1200); } }
    if (!joined) { if (lobby.hall) reopenHall(); else leaveOnline(t('host.lostMatch')); return; }
    lobby.code = code; if (!wasInMatch) { game.state = 'lobby'; screen = 'lobby'; showStart(); }
  }
}
net.on('refused', (d) => leaveOnline(d.reason));
net.hostName = myName;
net.onPeerJoin = (from, meta) => {
  const name = remoteName(meta && meta.name);
  if (meta && meta.prev && meta.prev !== from) { const sc = scores.get(meta.prev); if (sc) { scores.delete(meta.prev); scores.set(from, sc); } const r = remote.get(meta.prev); if (r) r.dispose(); remote.delete(meta.prev); lobby.players.delete(meta.prev); if (lobby.order) lobby.order = lobby.order.filter((id) => id !== meta.prev); }
  lobby.players.set(from, { name }); addRemote(from, name); broadcastLobby();
  if (game.state === 'play' || game.state === 'dying') { if (!scores.has(from)) scores.set(from, { name, kills: 0, deaths: 0 }); net.sendTo(from, 'start', { late: true, spawn: farthestSpawnIndex(), map: lobby.map || mapKey, broken: level.breakables.filter((b) => !b.alive).map((b) => b.id) }); sendScores(); hud.kill(t('feed.joined', { name }), 0); }
};
net.on('lobby', (d) => {
  lobby.hostId = d.hostId; lobby.isPublic = !!d.isPublic; lobby.code = net.code; lobby.shown = d.shown || net.code; if (d.map) lobby.map = knownMap(d.map); lobby.order = d.players.map((p) => p.id); lobby.players.clear();
  for (const p of d.players) { p.name = p.id === net.id ? myName : remoteName(p.name); lobby.players.set(p.id, { name: p.name }); }
  for (const p of d.players) if (p.id !== net.id) addRemote(p.id, p.name);
  for (const id of [...remote.keys()]) if (!lobby.players.has(id)) removeRemote(id);
  if (inMatch()) { for (const p of d.players) if (!scores.has(p.id)) scores.set(p.id, { name: p.name, kills: 0, deaths: 0 }); refreshScoreHud(); }
  renderLobby();
});
net.on('leave', (d) => { const nm = (lobby.players.get(d.id) || {}).name; removeRemote(d.id); if (inMatch()) hud.kill(t('feed.left', { name: nm || t('who.someone') }), 0); renderLobby(); });
net.on('start', (d) => { if (net.isHost) return; if (d.map) lobby.map = knownMap(d.map); startMatch(!!d.late, d.spawns ? d.spawns[net.id] : d.spawn); if (d.broken) for (const id of d.broken) { const br = level.breakables[id]; if (br) breakProp(br, null, false, true); } });
net.on('startreq', () => { if (net.isHost && game.state === 'lobby') hostStart(); });
net.on('end', (d) => endMatch(d));
net.on('backtolobby', () => { if (!net.isHost) toLobbyScreen(); });
net.on('pickup', (d) => { if (!net.isHost) spawnPickup(d.kind, new THREE.Vector3().fromArray(d.pos), d.id); });
net.on('taken', (d) => { const p = pickups.find((x) => x.id === d.id); if (p) removePickup(p); });
net.on('take', (d) => { if (!net.isHost) return; const p = pickups.find((x) => x.id === d.id); if (p) { removePickup(p); net.send('taken', { id: d.id }); } });
net.on('ps', (d, from) => { const r = remote.get(from); if (r) { r.push(d, performance.now() / 1000); r.lastSeen = performance.now(); } });
net.on('pdmg', (d) => {
  if (!player.alive || game.state !== 'play' || player.shieldT > 0) return; player.lastHitBy = d.by || null; player.lastHit = { from: d.from || null, crit: !!d.crit, amount: d.amount, src: d.src };
  player.takeDamage(d.amount, d.from ? new THREE.Vector3().fromArray(d.from) : null);
});
net.on('pdead', (d, from) => {
  const r = remote.get(from); const vn = r ? r.name : t('who.someone'); const kn = d.killer && scores.get(d.killer) ? scores.get(d.killer).name : null;
  if (r) { r.ragdoll(d.dir ? new THREE.Vector3().fromArray(d.dir) : null, !!d.over); audio.enemyDie(r.center); }
  const how = howText(d.how, d.crit);
  if (d.killer === net.id) { game.kills++; game.addScore(100, t('feed.erasedName', { name: vn }) + how); audio.kill(true); }
  else hud.kill(kn ? t('feed.erased', { killer: kn, victim: vn }) + how : t('feed.fell', { name: vn }), 0);
  if (net.isHost) tallyDeath(from, d.killer);
});
net.on('nade', (d) => player.throwGrenade(d));
net.on('brk', (d) => { const br = level.breakables[d.id]; if (br) breakProp(br, null, false); });
net.on('parry', (d) => { audio.shieldHit(player.center); effects.strokeBurst(player.eye.clone().addScaledVector(player.forward, 0.5), INK.ORANGE, 8, 5, { life: 0.2, size: 0.03 }); hud.kill(d.ret ? t('pts.returned') : t('tip.bounced'), d.ret ? 25 : 0); });
net.on('shots', (d, from) => {
  const r = remote.get(from); if (!r || !r.root || !r.alive) return;
  _sm.set(r.body.pos.x + r.right.x * 0.3 + r.forward.x * 0.8, r.body.pos.y + 1.35 + r.forward.y * 0.8, r.body.pos.z + r.right.z * 0.3 + r.forward.z * 0.8);
  const th = TRACER_THICK[d.k] || 0.02; const e = d.e || [];
  for (let i = 0; i + 2 < e.length; i += 3) { _se.set(e[i], e[i + 1], e[i + 2]); effects.tracer(_sm, _se, INK.BLUE, th, 0.06); }
  r.flash(); audio.remoteShot(d.k, _sm);
});
net.on('cut', () => { if (player.grapple.state !== 'idle') { player.detachGrapple(false); effects.strokeBurst(player.center, INK.ORANGE, 8, 4, { life: 0.25, size: 0.03 }); hud.tip(t('tip.yourRopeCut'), 1.3); } });
net.on('score', (rows) => { if (!net.isHost) applyScores(rows); });
net.on('fell', (d, from) => { if (!net.isHost) return; const sc = scores.get(from); if (sc) { sc.kills = Math.max(0, sc.kills - 1); sendScores(); net.send('feed', { key: 'feed.fellMinus', name: sc.name }); hud.kill(t('feed.fellMinus', { name: sc.name }), 0); } });
// feed lines travel as a key and a name so each player reads them in their own language
net.on('feed', (d) => { if (d && /^feed\.\w+$/.test(d.key)) hud.kill(t(d.key, { name: String(d.name || '') }), 0); });
player.onFall = () => {
  if (!online() || !inMatch()) return;
  hud.kill(t('feed.youFell'), 0);
  if (net.isHost) { const sc = scores.get(net.id); if (sc) { sc.kills = Math.max(0, sc.kills - 1); sendScores(); net.send('feed', { key: 'feed.fellMinus', name: sc.name }); } }
  else net.send('fell', {});
};
net.on('clock', (d) => { if (!net.isHost) { matchLeft = d.left; clockRunning = !!d.on; } });

// ---- idle players: a warning, then out; a lobby with nobody active in it shuts down ----
const IDLE_FLAG = 30, IDLE_MATCH = 150, IDLE_LOBBY = 300, IDLE_WARN = 20;
let idleWarned = false, idleCheckT = 0;
function idleUpdate(dt) {
  if (!net.active) { idleWarned = false; return; }
  idleCheckT -= dt; if (idleCheckT > 0) return; idleCheckT = 1;
  const limit = inMatch() ? IDLE_MATCH : IDLE_LOBBY; const idle = input.idleSeconds;
  const othersActive = [...remote.values()].some((r) => !r.idle);
  // a host that still has active players stays; kicking it would end their match
  const canDrop = !net.isHost || !othersActive;
  if (idle > limit - IDLE_WARN && !idleWarned && canDrop) { idleWarned = true; hud.message(t('idle.title'), t('idle.sub'), 3); audio.empty(); }
  if (idle <= limit - IDLE_WARN) idleWarned = false;
  if (idle > limit && canDrop) { const back = net.isHost ? null : String(net.aliasCode || net.code || '').replace(/-\d+$/, ''); leaveOnline(net.isHost ? t('idle.closed') : t('idle.kicked')); lobby.rejoinCode = back; if (back) showStart(); return; }
  // the host also clears out a client that has sat idle past the limit, in case its tab cannot do it itself
  if (net.isHost) for (const [id, r] of remote) if (r.idle && r.idleSince && performance.now() / 1000 - r.idleSince > limit - IDLE_FLAG + 15) { net.sendTo(id, 'kick', { reason: 'idle' }); const c = net.conns.get(id); setTimeout(() => { try { c && c.close(); } catch (e) { /* ignore */ } }, 500); }
}
net.on('kick', (d) => { const back = String(net.aliasCode || net.code || '').replace(/-\d+$/, ''); leaveOnline(d && d.reason === 'idle' ? t('idle.kicked') : t('kick.removed')); lobby.rejoinCode = back; if (back) showStart(); });
let syncTick = 0;
function netUpdate(dt) {
  idleUpdate(dt);
  if (!net.active) return; const now = performance.now() / 1000; syncTick++;
  for (const r of remote.values()) r.update(dt, now);
  // a connection that died without saying so leaves a figure standing around: drop anyone silent too long
  if (inMatch() && !migrating) for (const [id, r] of remote) { if (r.lastSeen && performance.now() - r.lastSeen > 9000) { if (!net.isHost && id === net.hostId) { const me = net.id; net.leave(); migrateHost(me); break; } const nm = r.name; removeRemote(id); hud.kill(t('feed.lost', { name: nm }), 0); if (net.isHost) { const c = net.conns.get(id); if (c) { try { c.close(); } catch (e) { /* ignore */ } net.conns.delete(id); } net.send('leave', { id }); broadcastLobby(); sendScores(); } } }
  if (syncTick % 3 === 0 && inMatch()) net.send('ps', encodeLocal(player, player.weaponIndex, { firing: player.firing, idle: input.idleSeconds > IDLE_FLAG }), true);
  if (shotQueue.length) net.broadcast('shots', { k: player.weapon.kind, e: shotQueue.splice(0) });
  if (net.isHost && inMatch() && remote.size > 0 && !game.clockStarted) { game.clockStarted = true; if (lobby.hall) hallFight(); }
  // the hall emptied out around the host: the clock stops and the warm-up doodles come back
  if (net.isHost && lobby.hall && game.state !== 'over' && remote.size === 0 && game.clockStarted) { game.clockStarted = false; matchLeft = FFA_TIME; }
  const clockOn = inMatch() && !game.over && (net.isHost ? !!game.clockStarted : clockRunning);
  if (inMatch() && !game.over) { if (clockOn) matchLeft = Math.max(0, matchLeft - dt); if (net.isHost) { clockT -= dt; if (clockT <= 0) { clockT = 2; net.send('clock', { left: Math.round(matchLeft), on: clockOn }); } } hud.setTimer(clockOn ? mmss(matchLeft) : t('ffa.timerWait')); }
  if (net.isHost && clockOn) { game.matchT += dt; if (matchLeft <= 0) { const rows = sortedScores(); const w = rows.length ? { id: rows[0][0], name: rows[0][1].name } : { id: net.id, name: myName }; net.send('end', w); endMatch(w); } }
}
// the lobby's code as players know it (a host change adds a -N generation suffix behind the scenes)
const shownCode = () => String(net.isHost ? (net.aliasCode || net.code) : (lobby.shown || net.code) || '').replace(/-\d+$/, '');
// tell CrazyGames which lobby the player is in and whether a friend can still get in; checked every
// frame, only changes are sent. A host change keeps the same code, so it is not reported as leaving.
function syncRoom() {
  if (migrating) return;
  if (!net.active) { platform.setRoom(null); return; }
  const code = shownCode(); if (!code) return;
  platform.setRoom({ code, joinable: (!net.isHost || net.accepting) && Math.max(1, lobby.players.size) < net.maxPlayers });
}
async function copyInvite() {
  const code = shownCode(); if (!code) return;
  const link = await platform.inviteLink(code);
  let ok = false; try { await navigator.clipboard.writeText(link); ok = true; } catch (e) { /* clipboard blocked in this frame */ }
  setStatus(ok ? t('inv.copied') : t('inv.manual', { link }));
}
// a friend's invite (link, CrazyGames party or invite accepted mid-game): leave whatever is going on
// and head for their lobby
function joinFromInvite(code) {
  if (net.active && shownCode() === code) return;
  coachEnd(false); input.exitLock();
  if (/^HALL\d/.test(code)) { enterHall(); return; }
  if (net.active) leaveOnline(''); else if (game.state !== 'start') toMainMenu();
  lobby.rejoinCode = null; screen = 'online'; showStart(); setStatus(t('inv.joining'));
  const box = hud.el.panel.querySelector('#online'); if (box) lockButtons(box);
  joinLobby(code);
}
function leaveOnline(reason) {
  net.leave(); for (const id of [...remote.keys()]) removeRemote(id); lobby.players.clear(); scores.clear(); hud.setBoard(null);
  if (game.state !== 'start') { game.state = 'start'; game.mode = 'solo'; setArena(false); resetGame(); hud.setGameplayVisible(false); }
  const wasHall = lobby.hall; lobby.hall = false; practice.on = false;
  game.menu = false; lobby.status = reason || ''; screen = wasHall ? 'main' : 'online'; showStart();
}
async function createLobby(isPublic, map = mapKey) {
  setStatus(t('net.creating'));
  try { await net.host({ isPublic }); }
  catch (err) { setStatus(friendlyError(err)); unlockButtons(); return; }
  lobby.isPublic = isPublic; lobby.map = map; lobby.players.clear(); lobby.players.set(net.id, { name: myName }); lobby.hostId = net.id; lobby.status = '';
  game.state = 'lobby'; screen = 'lobby'; showStart();
}
async function joinLobby(code) {
  if (/^HALL\d/.test(code)) { enterHall(); return; }
  setStatus(t('net.connecting'));
  try { await net.join(code, { name: myName }); } catch (err) { setStatus(friendlyError(err)); unlockButtons(); return; }
  lobby.isPublic = net.isPublic; lobby.status = ''; game.state = 'lobby'; screen = 'lobby'; showStart();
}
// ---- the online hall: Online drops you straight into a match that keeps going, no lobby to sit in ----
let hallTry = 0;
async function enterHall() {
  const my = ++hallTry; coachEnd(false);
  if (net.active) { net.leave(); for (const id of [...remote.keys()]) removeRemote(id); }
  lobby.players.clear(); scores.clear(); lobby.hall = true; lobby.isPublic = true; lobby.rejoinCode = null; lobby.order = null; lobby.gen = 0;
  if (game.state !== 'start') { game.state = 'start'; game.mode = 'solo'; setArena(false); resetGame(); hud.setGameplayVisible(false); }
  game.menu = false; lobby.status = t('hall.entering'); screen = 'hall'; showStart();
  try { await net.enterHall({ name: myName }, setStatus); }
  catch (err) { if (my !== hallTry) return; net.leave(); lobby.hall = false; lobby.status = t('hall.failed', { err: friendlyError(err) }); screen = 'hall'; showStart(); return; }
  if (my !== hallTry) { net.leave(); return; } // gave up on it while it was connecting
  lobby.status = ''; lobby.code = net.code;
  if (net.isHost) {
    lobby.map = knownMap(mapKey); lobby.players.set(net.id, { name: myName }); lobby.hostId = net.id; lobby.order = [net.id];
    hostStart();
  } else { game.state = 'lobby'; screen = 'lobby'; showStart(); } // the host sends a start as soon as it seats us
}
// left on our own (host gone, nobody to take over): quietly open or find a hall again
async function reopenHall() { if (!lobby.hall) return; hud.message(t('host.left'), t('hall.reopening'), 2.6); await sleep(600); enterHall(); }
function leaveHall() { hallTry++; net.leave(); lobby.hall = false; lobby.status = ''; screen = 'main'; showStart(); }
// two players arriving at an empty hall together can each open one; a host sitting alone moves into a
// hall that has people in it (or, between two lone hosts, the one with the lower id stays put)
let mergeT = 20, merging = false;
async function hallMerge(dt) {
  if (!lobby.hall || !net.isHost || remote.size > 0 || merging || migrating || game.state !== 'play') { mergeT = Math.max(mergeT, 8); return; }
  mergeT -= dt; if (mergeT > 0) return; mergeT = 20; merging = true;
  try {
    const halls = await net.surveyHalls({ name: myName });
    if (!lobby.hall || !net.isHost || remote.size > 0 || game.state !== 'play') return;
    const to = halls.find((h) => !h.full && (h.players >= 2 || (h.players === 1 && h.hostId < net.id)));
    if (!to) return;
    hud.message(t('hall.title'), t('hall.moving'), 2.4);
    net.leave(); lobby.players.clear(); scores.clear(); enemies.clear(); lobby.order = null; lobby.gen = 0;
    try { await net.join(to.code, { name: myName }); lobby.code = net.code; } catch (e) { enterHall(); }
  } catch (e) { /* the survey failed; try again later */ } finally { merging = false; }
}
// the fight proper starts the moment a second player is in: everyone back to zero, the clock runs
function hallFight() {
  enemies.clear(); for (const sc of scores.values()) { sc.kills = 0; sc.deaths = 0; } matchLeft = FFA_TIME; clockT = 0;
  sendScores(); net.send('hallfight', {}); hud.message(t('hall.fight'), t('hall.fightSub', { n: FFA_TARGET }), 2.6); audio.wave();
}
net.on('hallfight', () => { enemies.clear(); hud.message(t('hall.fight'), t('hall.fightSub', { n: FFA_TARGET }), 2.6); audio.wave(); });
// alone in the hall: a trickle of doodles to warm up on until somebody else turns up
const PRACTICE = ['grunt', 'grunt', 'grunt', 'rusher', 'rusher', 'flyer', 'bomber'];
const practice = { on: false, t: 0 };
function updatePractice(dt) {
  hallMerge(dt);
  const alone = lobby.hall && net.isHost && remote.size === 0 && !migrating && (game.state === 'play' || game.state === 'dying');
  if (!alone) { if (practice.on) { practice.on = false; enemies.clear(); } return; }
  if (!practice.on) { practice.on = true; practice.t = 4; enemies.mods.speed = 1; enemies.mods.damage = 1; hud.message(t('hall.alone'), t('hall.aloneSub'), 4); }
  if (game.state !== 'play' || game.menu) return;
  practice.t -= dt; if (practice.t > 0 || enemies.alive >= 4) return;
  practice.t = 3; const type = choose(PRACTICE); enemies.spawn(type, pickSpawn(type));
}
function friendlyError(err) {
  const m = String(err && err.message || err || ''); if (!m) return t('err.generic');
  if (err && /network|server-error|socket/.test(String(err.type || ''))) return t('err.server');
  if (/networking library/.test(m)) return t('err.lib');
  if (/timed out|signalling/.test(m)) return t('err.server');
  if (/no lobby with that code/.test(m)) return t('err.noCode');
  if (/no answer/.test(m)) return t('err.noAnswer');
  if (/full/.test(m)) return t('err.full');
  if (/leave the lobby/.test(m)) return t('err.leaveFirst');
  if (/hall is busy/.test(m)) return t('hall.busy');
  return m;
}
function setStatus(t) { lobby.status = t; const el = hud.el.panel.querySelector('#status'); if (el) el.textContent = t; }

// ---------------- screens ----------------
// the language picker only sits on the main menu: switching reloads the page
function langHTML() { return `<label class="langsel">${t('set.lang')} <select id="setLang">${LANGS.map(([code, label]) => `<option value="${code}"${code === lang ? ' selected' : ''}>${label}</option>`).join('')}</select></label>`; }
function styleHTML() {
  const cur = document.documentElement.dataset.theme === 'ballpoint' ? 'ballpoint' : 'marker';
  return `<label class="langsel">${t('set.style')} <select id="setStyle">${['marker', 'ballpoint'].map((k) => `<option value="${k}"${k === cur ? ' selected' : ''}>${t('style.' + k)}</option>`).join('')}</select></label>`;
}
function settingsHTML(withLang = false) {
  return `<div class="settings" id="settings">${withLang ? langHTML() : ''}${styleHTML()}
    <label class="langsel">${t('set.quality')} <select id="setQual">${['auto', 'high', 'med', 'low'].map((k) => `<option value="${k}"${k === R.mode ? ' selected' : ''}>${t('q.' + k)}</option>`).join('')}</select></label>
    <label>${t('set.sens')} <input type="range" id="setSens" min="25" max="250" step="5" value="${settings.sens}"><b id="setSensV">${settings.sens}%</b></label>
    <div class="checks"><label><input type="checkbox" id="setInv" ${settings.invert ? 'checked' : ''}> ${t('set.invert')}</label>
    <label><input type="checkbox" id="setMus" ${musicWanted ? 'checked' : ''}> ${t('set.music')} <span class="k">(${keyName('KeyM')})</span></label></div>
  </div>`;
}
function wireSettings() {
  const box = hud.el.panel.querySelector('#settings'); if (!box) return;
  box.addEventListener('click', (e) => e.stopPropagation()); box.addEventListener('keydown', (e) => e.stopPropagation());
  const sens = box.querySelector('#setSens'), out = box.querySelector('#setSensV');
  sens.addEventListener('input', () => { settings.sens = Number(sens.value); out.textContent = settings.sens + '%'; applySettings(); });
  box.querySelector('#setInv').addEventListener('change', (e) => { settings.invert = e.target.checked; applySettings(); });
  box.querySelector('#setQual').addEventListener('change', (e) => R.setQualityMode(e.target.value));
  const style = box.querySelector('#setStyle'); if (style) style.addEventListener('change', () => applyTheme(style.value));
  const ls = box.querySelector('#setLang'); if (ls) ls.addEventListener('change', () => setLang(ls.value));
  box.querySelector('#setMus').addEventListener('change', (e) => { musicWanted = e.target.checked; store.set('doodle_music', musicWanted ? '1' : '0'); audio.musicOn(musicWanted); });
}
function wireName(box) {
  const nb = box.querySelector('#setName'); if (!nb) return;
  if (account) return; // an account name is not changed here
  const setName = (v) => { myName = v; player.name = myName; net.hostName = myName; };
  nb.addEventListener('input', (e) => { const v = e.target.value.trim().slice(0, 14); if (v) setName(v); });
  // the filter runs once the player is done typing, so half a word is never judged
  nb.addEventListener('change', (e) => { setName(cleanName(e.target.value.slice(0, 14), guestName())); e.target.value = myName; store.set('doodle_name', myName); });
}
function checkpointHTML() {
  if (checkpoint < 5) return '';
  let h = `<div class="checkpoints"><span>${t('cp.label')}</span>`;
  for (let w = 5; w <= checkpoint; w += 5) h += `<button type="button" data-cp="${w}">${t('wave.n', { n: w })}</button>`;
  return h + '</div>';
}
function wireCheckpoints(onGo) { const box = hud.el.panel.querySelector('.checkpoints'); if (!box) return; box.addEventListener('click', (e) => { e.stopPropagation(); const b = e.target.closest('button'); if (b) onGo(Number(b.dataset.cp)); }); }
const mapName = (k) => (LEVELS.find((m) => m.key === k) || LEVELS[0]).name;
function mapHTML(sel, canPick) { if (LEVELS.length < 2) return ''; return `<div class="mapsel" id="mapsel"><span>${t('map.label')}</span>${LEVELS.map((m) => `<button type="button" class="mapbtn${m.key === sel ? ' on' : ''}" data-map="${m.key}" ${canPick ? '' : 'disabled'}>${m.name}<i>${m.blurb}</i></button>`).join('')}</div>`; }
function wireMap(onPick) { const box = hud.el.panel.querySelector('#mapsel'); if (!box) return; box.addEventListener('click', (e) => { e.stopPropagation(); const b = e.target.closest('.mapbtn'); if (b && !b.disabled) onPick(b.dataset.map); }); }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function mainHTML() {
  return `${!account && platform.canLogin ? `<button type="button" class="cglogin" id="cgLogin">${t('acct.login')}</button>` : ''}<h1 class="logo">Doodle Survivors <span>FPS</span></h1><h2>${t('menu.tagline')}</h2>${deviceNote()}
    <div class="mainbtns"><button type="button" class="start" id="soloBtn">${t('menu.start')}<i>${t('menu.startSub')}</i></button><button type="button" id="onlineBtn">${t('menu.online')}<i>${t('menu.onlineSub')}</i></button></div>
    <div class="online friendsrow"><div class="row"><button type="button" class="alt" id="friendsBtn">${t('menu.friends')}</button></div>${lobby.status ? `<div class="status">${esc(lobby.status)}</div>` : ''}</div>
    ${mapHTML(mapKey, true)}${ctlHTML()}${settingsHTML(true)}${checkpointHTML()}${best ? `<div class="beststat">${t('menu.best', { n: best })}</div>` : ''}`;
}
function introHTML() { return `<h1 class="logo">Doodle Survivors <span>FPS</span></h1><h2>${t('menu.tagline')}</h2>${deviceNote()}<div class="intro-go">${t(input.touch ? 'intro.tap' : 'intro.click')}</div>`; }
// the one click a new player needs: it also grants the pointer lock and starts the sound
function startFirstRun() { screen = 'main'; hud.el.screen.classList.remove('intro'); coachStart(); begin(); game.spawnT = Math.max(game.spawnT, 5); }
function onlineHTML() {
  return `<h1>${t('on.friendsTitle')}</h1><h2>${t('on.friendsSub')}</h2>
    <div class="online" id="online">
      <div class="row"><span>${t('on.name')}</span><input type="text" class="namebox" id="setName" maxlength="14" value="${esc(myName)}"${account ? ` readonly title="${esc(t('acct.nameLocked'))}"` : ''}></div>
      <div class="row"><button type="button" class="big" id="createBtn">${t('on.createPrivate')}</button></div>
      <div class="row"><span>${t('on.haveCode')}</span><input type="text" id="codeBox" placeholder="${t('on.code')}" maxlength="5" autocomplete="off"><button type="button" id="joinBtn">${t('on.join')}</button></div>
      <div class="status" id="status">${esc(lobby.status || '')}</div>
      <div class="privnote">${t('on.privacy')}</div>
      ${lobby.rejoinCode ? `<div class="row"><button type="button" class="big" id="rejoinBtn">${t('on.rejoin', { code: esc(lobby.rejoinCode) })}</button></div>` : ''}
      <div class="row"><button type="button" class="alt" id="backBtn">${t('on.back')}</button></div>
    </div>`;
}
// while the hall is being found or opened, and when that failed
function hallHTML() {
  const failed = !lobby.hall;
  return `<h1>${t('hall.title')}</h1><h2>${t('on.sub', { n: FFA_TARGET })}</h2>
    <div class="online" id="online">
      <div class="status" id="status">${esc(lobby.status || '')}</div>
      <div class="privnote">${t('on.privacy')}</div>
      <div class="row">${failed ? `<button type="button" class="big" id="hallRetry">${t('hall.retry')}</button>` : ''}<button type="button" class="alt" id="hallBack">${t('on.back')}</button></div>
    </div>`;
}
function lobbyHTML() {
  const rows = lobbyRows(); const host = net.isHost; const n = rows.length;
  if (lobby.hall) {
    return `<h1>${t('hall.title')}</h1><h2>${t('lob.sub', { n: FFA_TARGET, p: n, max: net.maxPlayers })}</h2>
    <div class="online" id="online">
      <div class="plist">${rows.map((p) => `<div class="${p.id === net.id ? 'me' : ''}"><span>${esc(p.name)}</span><span>${p.id === net.id ? t('who.you') : ''}</span></div>`).join('')}</div>
      <div class="status" id="status">${esc(lobby.status || t('hall.next'))}</div>
      <div class="row"><button type="button" class="alt" id="leaveBtn">${t('lob.leave')}</button></div>
    </div>`;
  }
  return `<h1>${t('lob.title')}</h1><h2>${t('lob.sub', { n: FFA_TARGET, p: n, max: net.maxPlayers })}</h2>
    <div class="online" id="online">
      <div class="row"><span>${t('lob.code')}</span><span class="code">${shownCode()}</span><button type="button" class="alt" id="inviteBtn">${t('inv.copy')}</button></div>
      ${mapHTML(lobby.map || mapKey, host)}
      <div class="hint">${lobby.isPublic ? t('lob.publicHint') : t('lob.privateHint')}</div>
      <div class="plist">${rows.map((p) => `<div class="${p.id === lobby.hostId ? 'host' : ''}${p.id === net.id ? ' me' : ''}"><span>${esc(p.name)}</span><span>${p.id === net.id ? t('who.you') : ''}</span></div>`).join('')}</div>
      <div class="row"><button type="button" class="big" id="startBtn">${t('lob.start')}</button><button type="button" class="alt" id="leaveBtn">${t('lob.leave')}</button></div>
      <div class="status" id="status">${esc(lobby.status || '')}</div><div class="hint">${t('lob.anyone')} · ${n < 2 ? t('lob.lateJoin') : t('lob.ready', { n })}</div>
    </div>`;
}
function wireOnline() {
  const box = hud.el.panel.querySelector('#online'); if (!box) return;
  box.addEventListener('click', (e) => e.stopPropagation()); box.addEventListener('keydown', (e) => e.stopPropagation());
  const q = (id) => box.querySelector('#' + id); wireName(box);
  if (q('createBtn')) q('createBtn').addEventListener('click', () => { lockButtons(box); createLobby(false); });
  if (q('joinBtn')) { q('joinBtn').addEventListener('click', () => { const c = q('codeBox').value.trim().toUpperCase(); if (!c) { setStatus(t('net.enterCode')); return; } lockButtons(box); joinLobby(c); }); q('codeBox').addEventListener('keydown', (e) => { if (e.key === 'Enter') q('joinBtn').click(); }); }
  if (q('rejoinBtn')) q('rejoinBtn').addEventListener('click', () => { const c = lobby.rejoinCode; lobby.rejoinCode = null; lockButtons(box); joinLobby(c); });
  if (q('backBtn')) q('backBtn').addEventListener('click', () => { lobby.status = ''; lobby.rejoinCode = null; screen = 'main'; showStart(); });
  if (q('hallRetry')) q('hallRetry').addEventListener('click', () => enterHall());
  if (q('hallBack')) q('hallBack').addEventListener('click', () => leaveHall());
  wireMap((k) => { if (net.isHost) { lobby.map = k; broadcastLobby(); } });
  if (q('startBtn')) q('startBtn').addEventListener('click', () => { if (net.isHost) hostStart(); else { net.send('startreq', {}); setStatus(t('net.askStart')); } });
  if (q('leaveBtn')) q('leaveBtn').addEventListener('click', () => { lobby.rejoinCode = null; leaveOnline(''); });
  if (q('inviteBtn')) q('inviteBtn').addEventListener('click', () => copyInvite());
}
function lockButtons(box) { for (const b of box.querySelectorAll('button')) if (b.id !== 'backBtn' && b.id !== 'hallBack') b.disabled = true; }
function unlockButtons() { const box = hud.el.panel.querySelector('#online'); if (box) for (const b of box.querySelectorAll('button')) b.disabled = false; }
function renderLobby() { if (game.state === 'lobby') showStart(); }
function showStart() {
  hud.setGameplayVisible(false);
  if (game.state === 'lobby') screen = 'lobby';
  const html = screen === 'lobby' ? lobbyHTML() : screen === 'online' ? onlineHTML() : screen === 'hall' ? hallHTML() : screen === 'intro' ? introHTML() : mainHTML();
  hud.el.screen.classList.toggle('intro', screen === 'intro');
  hud.showScreen(html);
  const p = hud.el.panel;
  if (screen === 'main') {
    wireSettings(); wireCheckpoints((w) => beginAtWave(w)); wireMap((k) => { mapKey = k; store.set('doodle_map', k); showStart(); });
    p.querySelector('#soloBtn').addEventListener('click', (e) => { e.stopPropagation(); begin(); });
    p.querySelector('#onlineBtn').addEventListener('click', (e) => { e.stopPropagation(); enterHall(); });
    p.querySelector('#friendsBtn').addEventListener('click', (e) => { e.stopPropagation(); lobby.status = ''; screen = 'online'; showStart(); });
    const lb = p.querySelector('#cgLogin'); if (lb) lb.addEventListener('click', (e) => { e.stopPropagation(); lb.disabled = true; platform.login().then(() => { lb.disabled = false; }); });
  } else wireOnline();
}
function showPause() {
  if (online()) {
    hud.showScreen(`<h1>${t('pause.menu')}</h1><h2>${lobby.hall ? t('hall.title') : t('pause.lobbySub', { code: String(net.aliasCode || net.code || '').replace(/-\d+$/, '') })}</h2><div class="scoreboard">${sortedScores().map(([id, s]) => `<div class="${id === net.id ? 'me' : ''}"><span>${esc(s.name)}</span><span>${t('ffa.kd', { k: s.kills, d: s.deaths })}</span></div>`).join('')}</div>${deviceNote()}${ctlHTML()}${settingsHTML()}<div class="online" id="online"><div class="row"><button type="button" class="alt" id="leaveBtn">${t('pause.leaveMatch')}</button></div></div><div class="go">${goText('go.resumeMatch')}</div>`);
    wireSettings(); wireOnline(); return;
  }
  hud.showScreen(`<h1>${t('pause.title')}</h1><h2><span class="badge">${t('wave.n', { n: game.wave })}</span><span class="dot">·</span>${t('pause.score')} <b class="num">${game.score}</b></h2>${deviceNote()}${ctlHTML()}${settingsHTML()}${menuBtnHTML()}<div class="go">${goText('go.resume')}</div>`);
  wireSettings(); wireMenuBtn();
}
function showClickToPlay() { hud.showScreen(`<h1>${lobby.hall ? t('hall.title') : t('start.title')}</h1><h2>${t('ffa.name')} · ${t('ffa.firstTo', { n: FFA_TARGET })}</h2><div class="go">${goText('go.fight')}</div>`); }
function showDead() {
  hud.setGameplayVisible(false); const nb = game.score > best; if (nb) { if (best > 0) platform.happytime(); best = game.score; store.set('doodle_best', String(best)); }
  deadScreen(nb);
}
// ---------------- ads ----------------
// Midgame ads come between runs (restart / checkpoint after a death, the end of a match), never
// mid-wave. A rewarded ad offers one revive per run from wave 4 on; when that offer was on screen
// the restart skips the midgame ad, as CrazyGames requires. During playback all sound is off, and
// afterwards the pointer lock is gone, so a click to continue comes first.
const adHooks = { start: () => audio.setAdMute(true), end: () => audio.setAdMute(false) };
// CrazyGames sound setting: off there means silent here, whatever the music toggle says
audio.setPlatformMute(platform.muteAudio);
platform.onSettings((st) => { if ('muteAudio' in st) audio.setPlatformMute(!!st.muteAudio); });
// the game is keyboard and mouse only; a phone or tablet gets told so (it still loads)
// Phones and tablets play with on-screen controls (touch.js); a touch on any device switches them on
const touchOnly = ['mobile', 'tablet'].includes(platform.deviceType);
function enableTouch(boot = false) {
  if (input.touch) return;
  input.enableTouch(); hud.touch = true; document.body.classList.add('touch');
  if (boot) return;
  if (game.state === 'start' || game.state === 'lobby' || game.state === 'dead') showStart(); else if (game.menu && game.state === 'pause') showPause();
}
window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') enableTouch(); }, true);
if (touchOnly) enableTouch(true);
// the game is laid out for a landscape screen; held upright, a phone gets asked to turn
const deviceNote = () => (input.touch ? `<div class="devnote rotnote">${t('dev.rotate')}</div>` : '');
const ctlHTML = () => (input.touch ? TOUCH_CONTROLS_HTML : CONTROLS_HTML);
const goText = (key) => (input.touch ? t('go.tap') : t(key, { key: `<kbd class="kd">${hud.key('confirm')}</kbd>` }));
const portrait = matchMedia('(orientation: portrait)');
portrait.addEventListener('change', () => { if (input.touch && portrait.matches) pause(); });
let adBusy = false, afterAd = null, adblock = false;
platform.hasAdblock().then((v) => { adblock = v; });
const VIDEO_ICON = '<svg class="vidicon" viewBox="0 0 24 18" aria-hidden="true"><rect x="1" y="1" width="16" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M17 7l6-4v12l-6-4z" fill="currentColor"/><path d="M7 5.5v7l5.5-3.5z" fill="currentColor"/></svg>';
const canRevive = () => platform.active && game.mode === 'solo' && game.wave > 3 && !game.revived;
function deadScreen(nb, note = '') {
  const offer = canRevive();
  game.reviveOffered = offer && !adblock;
  const adRow = !offer ? '' : `<div class="online adrow"><div class="row">${adblock ? '' : `<button type="button" class="big" id="reviveBtn">${VIDEO_ICON}${t('ad.revive')}</button>`}<button type="button" class="big" id="againBtn">${t('ad.restart')}</button></div>${adblock ? `<div class="adnote">${t('ad.adblock')}</div>` : note ? `<div class="adnote">${note}</div>` : ''}</div>`;
  hud.showScreen(`<h1>${t('dead.title')}</h1><div class="stats">${t('dead.stats', { w: game.wave, k: game.kills, s: game.score })}${nb ? ` · <b>${t('dead.record')}</b>` : ` · ${t('dead.best', { n: best })}`}</div>${adRow}${checkpointHTML()}${menuBtnHTML()}<div class="go">${goText('go.again')}</div>`);
  wireCheckpoints((w) => restartAfterDeath(() => beginAtWave(w))); wireMenuBtn();
  const p = hud.el.panel, rb = p.querySelector('#reviveBtn'), ab = p.querySelector('#againBtn');
  if (ab) ab.addEventListener('click', (e) => { e.stopPropagation(); restartAfterDeath(() => begin()); });
  if (rb) rb.addEventListener('click', (e) => { e.stopPropagation(); watchToRevive(nb); });
}
async function restartAfterDeath(go) {
  if (adBusy) return;
  if (game.reviveOffered) { go(); return; }
  adBusy = true;
  const r = await platform.requestAd('midgame', adHooks);
  adBusy = false;
  if (game.state !== 'dead') return;
  if (r.shown) showAfterAd(t('dead.title'), go); else go();
}
async function watchToRevive(nb) {
  if (adBusy) return;
  adBusy = true; hud.showScreen(`<h1>${t('ad.loading')}</h1>`);
  const r = await platform.requestAd('rewarded', adHooks);
  adBusy = false;
  if (game.state !== 'dead') return;
  if (!r.ok) { deadScreen(nb, t('ad.failed')); return; }
  showAfterAd(t('ad.revived'), revive);
}
function showAfterAd(title, go) {
  afterAd = go;
  hud.showScreen(`<h1>${title}</h1><div class="go">${(input.touch ? t('go.tap') : t('ad.continue', { key: `<kbd class="kd">${hud.key('confirm')}</kbd>` }))}</div>`);
}
// back on your feet where you fell, with a fresh loadout and a few seconds of cover
function revive() {
  game.revived = true; game.reviveOffered = false;
  player.reset(player.body.pos.clone()); player.name = myName; player.lastHitBy = null; player.lastHit = null; player.shieldT = 3; endFocus(); game.katanaStreak = 0;
  beginCommon(); game.state = 'play'; hud.tip(t('ad.revived'), 2);
}
function menuBtnHTML() { return `<div class="online menubtn"><div class="row"><button type="button" class="alt" id="menuBtn">${t('menu.main')}</button></div></div>`; }
function wireMenuBtn() { const b = hud.el.panel.querySelector('#menuBtn'); if (b) b.addEventListener('click', (e) => { e.stopPropagation(); toMainMenu(); }); }
function toMainMenu() { game.state = 'start'; game.mode = 'solo'; game.menu = false; setArena(false); resetGame(); audio.reelLoop(false); input.exitLock(); hud.setGameplayVisible(false); screen = 'main'; showStart(); }
function toLobbyScreen() { net.inMatch = false; for (const r of remote.values()) r.lastSeen = performance.now(); setArena(true); resetGame(); game.state = 'lobby'; game.over = null; game.menu = false; hud.setGameplayVisible(false); hud.setBoard(null); screen = 'lobby'; showStart(); }

// ---------------- run control ----------------
function resetGame() {
  if (level.breakables.some((b) => !b.alive)) setLevel(loadedKey, arenaLoaded, true);
  enemies.clear(); effects.clear(); for (const p of pickups) R.scene.remove(p.mesh); pickups.length = 0; pickupClock = 0;
  player.maxHp = online() ? 110 : 120; player.regenDelay = online() ? 4 : 4.5; player.regenRate = online() ? 14 : 11;
  player.reset(level.playerStart); player.name = myName; player.lastHitBy = null; player.lastHit = null; enemies.mods.speed = 1; enemies.mods.damage = 1; hud.setModifier(''); hud.setBoss(null, null); game.boss = null; endFocus(); game.katanaStreak = 0;
  game.score = 0; game.kills = 0; game.combo = 0; game.revived = false; game.wave = 0; game.intermission = 0; game.queue = []; game.time = 0; game.over = null; game.matchT = 0; hud.setScore(0, 0); hud.setTimer(''); hud.setPvpScore(null); hud.setWave(1, 0); hud.setBoard(null);
}
function beginCommon() { if (input.touch) goFullscreen(); R.holdAdapt(); store.set('doodle_played', '1'); audio.init(); audio.resume(); input.requestLock(); if (musicWanted && !audio.musicPlaying) audio.musicOn(true); hud.hideScreen(); hud.setGameplayVisible(true); game.menu = false; }
// on a phone the browser bars eat a third of a landscape screen; ask for the whole of it (refused quietly where not allowed)
function goFullscreen() {
  const d = document, el = d.documentElement;
  if (!d.fullscreenElement && el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).then(() => { try { window.screen.orientation.lock('landscape').catch(() => {}); } catch (e) { /* not supported */ } }).catch(() => {});
}
function begin() { game.mode = 'solo'; setArena(false); if (game.state === 'start' || game.state === 'dead') R.roundStart(); beginCommon(); if (game.state === 'start' || game.state === 'dead') { resetGame(); startWave(1); } game.state = 'play'; }
function beginAtWave(n) { game.mode = 'solo'; setArena(false); R.roundStart(); beginCommon(); resetGame(); startWave(n); game.state = 'play'; }
function jumpToWave(n) { enemies.clear(); effects.clear(); enemies.mods.speed = 1; enemies.mods.damage = 1; endFocus(); game.intermission = 0; game.queue = []; startWave(n); hud.hideScreen(); hud.setGameplayVisible(true); game.state = 'play'; game.menu = false; audio.reelLoop(false); }
function hostStart() {
  if (lobby.hall && game.state === 'over') { const i = LEVELS.findIndex((m) => m.key === lobby.map); lobby.map = LEVELS[(i + 1) % LEVELS.length].key; }
  scores.clear(); for (const [id, p] of lobby.players) scores.set(id, { name: p.name, kills: 0, deaths: 0 });
  // deal everyone a different spot, shuffled so the same people do not always start together
  setArena(true); const order = spawnSpots().map((_, i) => i); for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const spawns = {}; [...lobby.players.keys()].forEach((id, i) => { spawns[id] = order[i % order.length]; });
  net.send('start', { spawns, map: lobby.map || mapKey }); startMatch(false, spawns[net.id]); sendScores();
}
function startMatch(late, spawnIdx) {
  net.inMatch = true; game.mode = 'ffa'; setArena(true); resetGame(); matchLeft = FFA_TIME; clockT = 0;
  // a new hall round with people already in it is a fight from the first second, no "challenger" call
  game.clockStarted = lobby.hall && net.isHost && remote.size > 0;
  // nobody sends snapshots in the lobby, so the silence clock restarts here or the sweep would drop everyone
  for (const r of remote.values()) r.lastSeen = performance.now();
  if (!scores.size) for (const [id, p] of lobby.players) scores.set(id, { name: p.name, kills: 0, deaths: 0 });
  const spots = spawnSpots(); player.reset(spawnIdx != null && spots[spawnIdx] ? spots[spawnIdx].clone() : arenaSpawn()); R.roundStart(); beginCommon(); game.state = 'play'; screen = 'lobby'; player.shieldT = 2;
  refreshScoreHud(); hud.message(t('ffa.name'), late ? t('ffa.joinedLate') : t('ffa.rules', { n: FFA_TARGET, m: Math.round(FFA_TIME / 60) }), 3);
  hud.tip(t('tip.holdBoard', { key: hud.key('score') }), 5);
  // a match started by someone else's click cannot grab the mouse: ask for a click
  setTimeout(() => { if (game.state === 'play' && !input.pointerLocked) { game.menu = true; showClickToPlay(); } }, 250);
}
function pause() { if ((game.state !== 'play' && !(game.state === 'dying' && online())) || game.menu) return; if (!online()) game.state = 'pause'; game.menu = true; showPause(); audio.reelLoop(false); }
function resume() { if (online()) { game.menu = false; if (game.state === 'dying' && game.respawnT <= 0) game.respawnArm = input.lastActive; hud.hideScreen(); hud.setGameplayVisible(true); input.requestLock(); return; } begin(); }
Object.assign(window.__game, { startWave, updateWaves, begin, beginAtWave, jumpToWave, resetGame, spawnPickup, focusCandidate, enterFocus, pickSpawn, startMatch, createLobby, joinLobby, enterHall, leaveOnline, hostStart });
hud.onScreenClick = () => {
  const st = game.state;
  if (adBusy) return;
  if (afterAd) { const go = afterAd; afterAd = null; go(); return; }
  if (st === 'over') { if (net.isHost && !lobby.hall) { net.send('backtolobby', {}); toLobbyScreen(); } return; }
  if (st === 'lobby') return;
  if (st === 'start') { if (screen === 'intro') startFirstRun(); else if (screen === 'main') begin(); return; }
  if ((st === 'play' || st === 'dying') && game.menu) { resume(); return; }
  if (st === 'pause') resume();
  if (st === 'dead') restartAfterDeath(() => begin());
};
canvas.addEventListener('click', () => { if (game.state === 'play' && !game.menu && !input.pointerLocked) input.requestLock(); });
input.onLockChange = (locked) => { if (!locked && (game.state === 'play' || (game.state === 'dying' && online())) && !game.menu) pause(); };
window.addEventListener('pagehide', () => { if (net.active) net.leave(); });
// browsers only let audio start on a gesture; any press wakes the context if it went to sleep
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => { audio.init(); audio.resume(); }, { passive: true });
// signing in (or out) mid-game: take the account name and that account's saves; the level only
// changes on the menus, never under a player in the middle of a run
function readSaves() {
  best = Number(store.get('doodle_best') || 0); checkpoint = Number(store.get('doodle_checkpoint') || 0); musicWanted = store.get('doodle_music') !== '0';
  settings.sens = Number(store.get('doodle_sens') || 100); settings.invert = store.get('doodle_invert') === '1'; applySettings();
  if (game.state === 'start' && !net.active) { const k = knownMap(store.get('doodle_map') || mapKey); if (k !== mapKey) { mapKey = k; setLevel(k, false); } }
}
platform.onAuth((user) => {
  account = user;
  myName = pickName();
  player.name = myName; net.hostName = myName; if (lobby.players.has(net.id)) { lobby.players.get(net.id).name = myName; if (net.isHost) broadcastLobby(); }
  readSaves();
  if ((game.state === 'start' || game.state === 'lobby') && screen !== 'intro') showStart();
});
applySettings(); hud.setWeapon(player.weapon.name, player.weapon.hint); // Opened from an invite: straight to that lobby, no intro or coach. Started from the CrazyGames party
// UI: straight into a new private lobby on the default map, open to friends at once.
const bootInvite = platform.inviteCode();
if (bootInvite) { try { const u = new URL(location.href); if (u.searchParams.has('join')) { u.searchParams.delete('join'); history.replaceState(null, '', u); } } catch (e) { /* ignore */ } }
if (bootInvite) joinFromInvite(bootInvite);
else if (platform.instantMultiplayer) { screen = 'online'; showStart(); const box = hud.el.panel.querySelector('#online'); if (box) lockButtons(box); createLobby(false, LEVELS[0].key); }
else { if (firstVisit) screen = 'intro'; showStart(); }
platform.onJoinRoom((code) => joinFromInvite(code));

// ---------------- loop ----------------
let last = performance.now(), lockTipT = 0.5, musicHealT = 2;
let firstFrame = true;
function tick(now) { requestAnimationFrame(tick); step(now); perfTick(now); if (firstFrame) { firstFrame = false; R.holdAdapt(); platform.loadingStop(); } }
// performance readout, toggled with the ` key (under Esc): frame rate, render scale and which GPU the browser is using
const perfEl = document.createElement('div');
perfEl.style.cssText = 'position:fixed;left:50%;top:6px;transform:translateX(-50%);z-index:99;font:12px/1.3 monospace;color:#fff;background:rgba(0,0,0,.65);padding:3px 8px;border-radius:4px;pointer-events:none;white-space:nowrap';
let perfOn = localStorage.getItem('doodle_perf') === '1', perfN = 0, perfT0 = 0, perfWorst = 0, perfPrev = 0, perfDrawn = 0;
const gpuName = (() => { try { const gl = R.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch { return '?'; } })();
perfEl.hidden = !perfOn; document.body.appendChild(perfEl);
window.addEventListener('keydown', (e) => { if (e.code === 'Backquote') { perfOn = !perfOn; perfEl.hidden = !perfOn; localStorage.setItem('doodle_perf', perfOn ? '1' : '0'); } });
function perfTick(now) {
  if (perfPrev) perfWorst = Math.max(perfWorst, now - perfPrev); perfPrev = now; perfN++;
  if (now - perfT0 < 500) return;
  if (perfOn) perfEl.textContent = `${Math.round((R.drawn - perfDrawn) * 1000 / (now - perfT0))} FPS (loop ${Math.round(perfN * 1000 / (now - perfT0))}) · worst ${perfWorst.toFixed(0)} ms · ${['low', 'med', 'high'][R.quality]} (${R.mode}) · scale ${R.pixelRatio}x · ${R.renderer.domElement.width}x${R.renderer.domElement.height} · ${gpuName}`;
  perfN = 0; perfT0 = now; perfWorst = 0; perfDrawn = R.drawn || 0;
}
// browsers starve animation frames in hidden tabs; a host that alt-tabs would freeze everyone's
// match, so a coarse timer runs extra steps (never extra frame chains) while that happens
setInterval(() => { if (net.active && performance.now() - last > 300) step(performance.now()); }, 250);
function step(now) {
  // never more than 50 ms a step: a bigger jump (a tab coming back) makes the springs in the view model fly apart
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  input.update(dt);
  const st = game.state; const playing = st === 'play' || st === 'dying';
  if (input.touch) {
    // let go of every on-screen button when a menu or result screen comes up
    const live = playing && !game.menu; if (touchWas && !live) touchUI.reset(); touchWas = live;
    touchUI.sync(online()); if (live) aimAssist(dt);
    if (live && portrait.matches) pause();
  }
  // in a match the respawn countdown is still the match; solo death goes to the result screen
  platform.setPlaying((st === 'play' || (st === 'dying' && online())) && !game.menu);
  syncRoom(); effects.setBudget(R.quality); R.playing = game.state === 'play' && !game.menu;
  if (st === 'start' || st === 'pause' || st === 'dead' || st === 'over') { if (input.pressed('jump') || input.pressed('confirm') || (st === 'pause' && input.pressed('pause'))) hud.onScreenClick(); }
  else if ((st === 'play' || (st === 'dying' && online())) && input.pressed('pause')) { if (game.menu) resume(); else { pause(); input.exitLock(); } }
  else if ((st === 'play' || st === 'dying') && game.menu && (input.pressed('jump') || input.pressed('confirm'))) resume();
  if (input.pressed('music')) { musicWanted = !musicWanted; store.set('doodle_music', musicWanted ? '1' : '0'); audio.musicOn(musicWanted); hud.tip(audio._pfMute ? t('tip.platformMuted') : musicWanted ? t('tip.musicOn') : t('tip.musicOff'), 1.5); }
  if (online() && playing) {
    const want = input.down('score') && !game.menu; if (want !== !hud.el.board.hidden) hud.setBoard(want ? boardHTML() : null);
  }
  if (st === 'play' && !game.menu && !input.pointerLocked) { lockTipT -= dt; if (lockTipT <= 0) { lockTipT = 2.5; hud.tip(t('tip.clickLock'), 2); } }
  let scale = 1;
  if (game.hitstopT > 0) { game.hitstopT -= dt; scale = game.hitstopScale; }
  else if (game.focus.active) scale = FOCUS_SCALE;
  const sdt = dt * scale;
  if (st === 'play' && !online()) updateFocus(dt); else endFocus();
  updateCoach(dt);
  if (playing) {
    game.time += sdt; if (player.shieldT > 0) player.shieldT -= dt;
    musicHealT -= dt; if (musicHealT <= 0) { musicHealT = 2; if (musicWanted && st === 'play' && !audio.musicPlaying && audio.ctx) audio.musicOn(true); if (input.anyInput) audio.resume(); }
    { const B = level.bounds, bp = player.body.pos; if (bp.x < B.minX - 8 || bp.x > B.maxX + 8 || bp.z < B.minZ - 8 || bp.z > B.maxZ + 8 || bp.y > 150) bp.y = -100; }
    player.update(sdt); enemies.update(sdt); effects.update(sdt); updatePickups(sdt); netUpdate(dt);
    if (st === 'play' && !online()) updateWaves(sdt);
    if (online()) { updateArenaPickups(dt); updatePractice(dt); }
    if (game.comboT > 0) { game.comboT -= sdt; if (game.comboT <= 0) { game.combo = 0; hud.setScore(game.score, 0); } }
    if (st === 'dying') {
      game.deathT += dt;
      if (online()) {
        const before = Math.ceil(game.respawnT); game.respawnT -= dt; const left = Math.ceil(game.respawnT);
        if (left > 0) { if (left !== before || game.deathT <= dt) hud.message(String(left), t('death.soon'), 1.1); }
        else if (before > 0) { game.respawnArm = input.lastActive; game.promptT = 0; }
        else if (!game.menu) {
          // waiting on a press: any key, button or click brings you back; pause opens the menu instead
          game.promptT -= dt; if (game.promptT <= 0) { game.promptT = 1.4; hud.message(t('death.ready'), input.touch ? t('death.tap') : t('death.press', { key: hud.key('confirm') }), 1.5); }
          if (input.lastActive !== game.respawnArm && !input.pressed('pause') && !input.down('pause')) respawnLocal();
        }
      }
      else if (game.deathT > 1.7) { game.state = 'dead'; showDead(); input.exitLock(); }
    }
  } else {
    game.time += dt; if (st === 'start' || st === 'dead' || st === 'lobby' || st === 'over') player.idleCam(game.time); effects.update(dt); if (net.active) netUpdate(dt);
    if (st === 'over') { game.overT += dt; if (lobby.hall) { if (net.isHost && game.overT > 8) hostStart(); else if (!net.isHost && game.overT > 20) toLobbyScreen(); } else if (net.isHost && game.overT > 8) { net.send('backtolobby', {}); toLobbyScreen(); } else if (!net.isHost && game.overT > 15) { toLobbyScreen(); } }
  }
  for (const a of level.animated) a.update(game.time);
  audio.setListener(player.eye, player.right);
  const w = player.weapon; if (w.isGun) hud.setAmmo(w.mag, w.reserve, w.magSize, w.reloading); else hud.setKatana();
  hud.setSlots(player.weapons.map((wp, i) => ({ name: wp.name, active: i === player.weaponIndex, ammo: wp.isGun ? wp.mag + '/' + wp.reserve : '∞', empty: wp.isGun && wp.mag === 0 && wp.reserve === 0 })));
  hud.setGrenades(player.grenades); hud.setGrappleStamina(player.grapStam); hud.setHealth(player.hp, player.maxHp); hud.setSpread(w.spreadPx); updateNameTags(); hud.update(dt);
  if (online()) hud.setFocusMeter(playing, player.grapStam, false, t('hud.grapple'));
  else hud.setFocusMeter(playing && (w.kind === 'katana' || game.katanaStreak > 0 || game.focus.active), game.focus.active ? 1 : clamp(game.katanaStreak / KATANA_CHARGE_KILLS, 0, 1), game.focus.active, t('hud.katana'));
  if (game.boss) { if (game.boss.alive) hud.setBoss(game.boss.T.name, game.boss.hp / game.boss.maxHp); else { hud.setBoss(null, null); game.boss = null; } }
  audio.setIntensity(clamp((enemies.alive + game.queue.length + remote.size * 2) / 12, 0, 1) * (game.intermission > 0 ? 0.25 : 1));
  R.render(game.time, { hurt: player.hurtFx, flash: player.flashFx, slow: scale < 1 ? 1 : 0, lowHp: player.alive && player.hp < 30 ? 1 - player.hp / 30 : 0 });
}
requestAnimationFrame(tick);
// name and health over everyone else in an online match; hidden behind walls (checked a few times a second)
const _tag = new THREE.Vector3(), _tagList = [];
function updateNameTags() {
  _tagList.length = 0;
  if (online() && net.active && inMatch()) {
    const cam = R.camera, W = window.innerWidth, H = window.innerHeight, now = game.time;
    cam.updateMatrixWorld(); cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    for (const [id, r] of remote) {
      if (!r.alive || !r.root || !r.root.visible || r.away) continue;
      const dist = r.eye.distanceTo(player.eye); if (dist > 90) continue;
      if (!(r._losT > now)) { r._losT = now + 0.2; r._los = world.hasLineOfSight(player.eye, r.eye); }
      if (!r._los) continue;
      _tag.set(r.body.pos.x, r.body.pos.y + r.body.height + 0.3, r.body.pos.z).project(cam);
      if (_tag.z > 1 || Math.abs(_tag.x) > 1.1 || Math.abs(_tag.y) > 1.1) continue;
      _tagList.push({ id, name: r.name, hp: clamp(r.hp / Math.max(r.maxHp, r.hp, 1), 0, 1), x: (_tag.x * 0.5 + 0.5) * W, y: (-_tag.y * 0.5 + 0.5) * H, s: clamp(14 / Math.max(dist, 1), 0.6, 1) });
    }
  }
  hud.setNameTags(_tagList);
}
