// Peer-to-peer networking over WebRTC, using the public PeerJS signalling service.
// Nothing runs on a server of ours: the host player's browser is the authority, every other
// player connects straight to it. That is what lets multiplayer work from a static Vercel deploy.
//
// Lobby codes are just peer ids. A private lobby takes a random 5 letter code; the online hall
// claims one of a handful of well-known ids (HALL0..HALL3) so players can find it by knocking on
// every slot at once - a directory with no directory server. A connection only counts once the
// host has answered with a welcome, so a full or closed lobby can be skipped for the next one.

import { t } from './i18n.js';

// a local dev server gets its own namespace so testing can never wander into a live lobby
const LOCAL = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const PREFIX = LOCAL ? 'doodledev-' : 'doodledistrict-';
const HALL_SLOTS = 4;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const makeCode = () => Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
const STUN = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
const JOIN_TIMEOUT = 14000, QUICK_TIMEOUT = 11000, SIGNAL_TIMEOUT = 12000, ICE_TIMEOUT = 3000, ICE_MAX_AGE = 60 * 60 * 1000;

// TURN relays for players whose NAT blocks a direct link. Short-lived credentials come from our own
// server (./api/ice), which keeps the Cloudflare API token off the client. Where that endpoint does
// not exist (local dev, other hosts) or is slow, play carries on with STUN only. A build hosted
// elsewhere (CrazyGames) sets window.DOODLE_ICE_URL to the full address of that endpoint.
const ICE_URL = (typeof window !== 'undefined' && window.DOODLE_ICE_URL) || './api/ice';
let iceCache = null;
async function peerOpts() {
  if (!iceCache || Date.now() - iceCache.at > ICE_MAX_AGE) {
    const at = Date.now();
    iceCache = { at, servers: (async () => {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl && setTimeout(() => ctrl.abort(), ICE_TIMEOUT);
      try {
        const res = await fetch(ICE_URL, { signal: ctrl && ctrl.signal, cache: 'no-store' });
        if (!res.ok) throw new Error('ice ' + res.status);
        const body = await res.json();
        const list = Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : [];
        if (!list.length) throw new Error('no ice servers');
        return list;
      } catch (e) {
        if (iceCache && iceCache.at === at) iceCache.at = 0; // try again next time
        return [];
      } finally { if (timer) clearTimeout(timer); }
    })() };
  }
  return { debug: 0, config: { iceServers: [...STUN, ...(await iceCache.servers)] } };
}

function peerAvailable() { return typeof window !== 'undefined' && typeof window.Peer === 'function'; }
const idFromError = (err) => { const m = /peer\s+(\S+)/.exec(String(err && err.message || '')); return m ? m[1] : null; };

export class Net {
  constructor() {
    this.peer = null; this.conns = new Map(); this.isHost = false; this.id = null; this.code = null; this.hostId = null;
    this.handlers = new Map(); this.connected = false; this.onPeerJoin = null; this.onPeerLeave = null; this.onDisconnect = null;
    this.maxPlayers = 10; this.accepting = true; this.hostName = ''; this.stats = { sent: 0, recv: 0 }; this.isPublic = false;
  }
  get active() { return !!this.peer && this.connected; }
  get peerIds() { return [...this.conns.keys()]; }
  on(type, fn) { this.handlers.set(type, fn); }
  _emit(type, data, from) { const h = this.handlers.get(type); if (h) h(data, from); }

  async _newPeer(id) {
    const opts = await peerOpts();
    return new Promise((resolve, reject) => {
      if (!peerAvailable()) return reject(new Error('networking library did not load'));
      const peer = new window.Peer(id, opts); let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; peer.destroy(); reject(new Error('signalling server timed out')); } }, SIGNAL_TIMEOUT);
      peer.on('open', () => { if (settled) return; settled = true; clearTimeout(timer); resolve(peer); });
      peer.on('error', (err) => { if (settled) return; settled = true; clearTimeout(timer); peer.destroy(); reject(err); });
    });
  }
  _wire(conn) {
    conn.on('data', (msg) => { this.stats.recv++; if (!msg || typeof msg !== 'object') return; this._route(msg, conn.peer); });
    conn.on('close', () => this._drop(conn.peer));
    conn.on('error', () => this._drop(conn.peer));
  }
  _drop(pid) {
    if (this.leaving || !this.conns.has(pid)) return; this.conns.delete(pid);
    if (this.isHost) { if (this.onPeerLeave) this.onPeerLeave(pid); this.broadcast('leave', { id: pid }); }
    else if (pid === this.hostId) { this.connected = false; if (this.onDisconnect) this.onDisconnect(); }
  }
  _route(msg, from) {
    // clients can address each other; the host forwards those
    if (this.isHost && msg.to && msg.to !== this.id) { const c = this.conns.get(msg.to); if (c && c.open) c.send(msg); return; }
    if (this.isHost && msg.relay) { for (const [pid, c] of this.conns) if (pid !== from && c.open) c.send({ t: msg.t, d: msg.d, from }); }
    this._emit(msg.t, msg.d, msg.from || from);
  }
  _keepAlive(peer) { peer.on('disconnected', () => { if (this.peer === peer && !peer.destroyed) { try { peer.reconnect(); } catch (e) { /* ignore */ } } }); }

  // ---- lobby creation / joining ----
  async host({ isPublic = false, code = null } = {}) {
    this.leave(); this.isHost = true; this.isPublic = isPublic;
    if (code) { this.code = String(code).toUpperCase(); this.peer = await this._newPeer(PREFIX + this.code); }
    else {
      for (let tries = 0; tries < 3 && !this.peer; tries++) {
        this.code = makeCode();
        try { this.peer = await this._newPeer(PREFIX + this.code); } catch (e) { if (!(e && e.type === 'unavailable-id') || tries === 2) throw e; }
      }
    }
    this.id = this.peer.id; this.hostId = this.id; this.connected = true; this.accepting = true;
    this.peer.on('connection', (conn) => this._incoming(conn));
    this._keepAlive(this.peer);
    return this.code;
  }
  // someone knocking: a quick-play probe is told how full we are and only seated once it says it is staying
  _incoming(conn) {
    conn.on('open', () => {
      // a full lobby still says who it is, so the lobby list can show it
      if (!this.accepting || this.conns.size >= this.maxPlayers - 1) { conn.send({ t: 'refused', d: { reason: this.accepting ? 'that lobby is full' : 'that lobby is closed', code: this.aliasCode || this.code, players: this.conns.size + 1, max: this.maxPlayers, inMatch: !!this.inMatch, hostName: this.hostName } }); setTimeout(() => { try { conn.close(); } catch (e) { /* ignore */ } }, 600); return; }
      const seat = () => { if (this.conns.has(conn.peer)) return; this.conns.set(conn.peer, conn); this._wire(conn); if (this.onPeerJoin) this.onPeerJoin(conn.peer, conn.metadata || {}); };
      const welcome = { hostId: this.id, code: this.aliasCode || this.code, isPublic: this.isPublic, players: this.conns.size + 1, max: this.maxPlayers, inMatch: !!this.inMatch, hostName: this.hostName };
      if (conn.metadata && conn.metadata.probe) {
        conn.send({ t: 'welcome', d: welcome, from: this.id });
        const onData = (msg) => { if (msg && msg.t === 'stay') { conn.off('data', onData); seat(); } };
        conn.on('data', onData);
      } else { conn.send({ t: 'welcome', d: welcome, from: this.id }); seat(); }
    });
  }
  // after a host transfer the lobby lives on a generation code; keep trying to open the original code
  // as a second front door so it stays the code people know
  claimAlias(code, tries = 20) {
    if (!this.isHost || this.alias || this._aliasTimer) return;
    const attempt = async () => {
      this._aliasTimer = null; if (!this.isHost || this.alias) return;
      try { const peer = await this._newPeer(PREFIX + code); if (!this.isHost) { peer.destroy(); return; } this.alias = peer; this.aliasCode = code; peer.on('connection', (conn) => this._incoming(conn)); if (this.onAlias) this.onAlias(code); }
      catch (e) { if (--tries > 0) this._aliasTimer = setTimeout(attempt, 6000); }
    };
    this._aliasTimer = setTimeout(attempt, 1500);
  }
  async join(code, meta = {}, wantId = null) {
    this.leave(); this.isHost = false; code = String(code || '').trim().toUpperCase();
    if (!code) throw new Error('enter a lobby code');
    this.peer = await this._newPeer(null);
    this.id = this.peer.id; this._keepAlive(this.peer);
    // a lobby that changed hosts lives on a generation code; the plain code still finds it
    const base = code.replace(/-\d+$/, ''); const ids = [code, ...['-1', '-2', '-3'].map((suf) => base + suf).filter((c) => c !== code)].map((c) => PREFIX + c);
    let res; try { res = await this._knockAny(ids, meta, JOIN_TIMEOUT); } catch (e) { this.leave(); throw e; }
    const { hostId, conn, welcome } = res; this._adopt(hostId, conn, welcome); this.code = (welcome && welcome.code) || hostId.slice(PREFIX.length); return this.code;
  }
  // ---- the online hall: a few well-known lobbies (HALL0..HALL3) that everyone choosing Online lands in ----
  // a look at every hall: who hosts it and how full it is. Nothing is joined; a throwaway peer does the knocking.
  async surveyHalls(meta = {}) {
    const peer = await this._newPeer(null);
    const ids = []; for (let i = 0; i < HALL_SLOTS; i++) for (const suf of ['', '-1', '-2', '-3']) ids.push(PREFIX + 'HALL' + i + suf);
    const found = await new Promise((resolve) => {
      let pending = ids.length, done = false; const attempts = [], offers = []; let gather = null;
      const settle = () => { if (done) return; done = true; clearTimeout(timer); clearTimeout(gather); peer.off('error', onErr); for (const a of attempts) { try { a.conn.close(); } catch (e) { /* ignore */ } } resolve(offers); };
      const failOne = (a) => { if (a.done) return; a.done = true; pending--; if (pending <= 0) settle(); };
      const onErr = (err) => { if (err && err.type === 'peer-unavailable') { const a = attempts.find((x) => x.hostId === idFromError(err)); if (a) failOne(a); } };
      peer.on('error', onErr);
      const timer = setTimeout(settle, QUICK_TIMEOUT);
      const probeMeta = { ...meta, probe: true };
      for (const hostId of ids) {
        let conn; try { conn = peer.connect(hostId, { reliable: true, serialization: 'json', metadata: probeMeta }); } catch (e) { pending--; continue; }
        const a = { conn, hostId, done: false }; attempts.push(a);
        conn.on('data', (msg) => { if (!msg || a.done) return; if (msg.t === 'welcome' || msg.t === 'refused') { a.done = true; pending--; const d = msg.d || {}; offers.push({ hostId, code: hostId.slice(PREFIX.length), slot: Number(/^HALL(\d+)/.exec(hostId.slice(PREFIX.length))[1]), players: d.players || 0, max: d.max || 10, full: msg.t === 'refused' }); if (pending <= 0) settle(); else if (!gather) gather = setTimeout(settle, 1500); } });
        conn.on('error', () => failOne(a)); conn.on('close', () => failOne(a));
      }
      if (pending <= 0) settle();
    });
    try { peer.destroy(); } catch (e) { /* ignore */ }
    // a hall that changed hosts can answer on two ids for a moment; one entry per host is enough
    return found.filter((o) => o.hostId !== this.id && o.code !== this.aliasCode).sort((a, b) => a.slot - b.slot || b.players - a.players);
  }
  // join the first hall with room in it, or open the first free one. Lower halls fill first so players end up together.
  async enterHall(meta = {}, onStatus = null) {
    this.leave();
    for (let round = 0; round < 3; round++) {
      const halls = await this.surveyHalls(meta);
      for (const h of halls.filter((x) => !x.full)) {
        try { await this.join(h.code, meta); return this.code; } catch (e) { /* gone or full by now: try the next */ }
      }
      if (onStatus) onStatus(t('hall.opening'));
      const taken = new Set(halls.map((h) => h.slot));
      for (let slot = 0; slot < HALL_SLOTS; slot++) {
        if (taken.has(slot)) continue;
        try { await this.host({ isPublic: true, code: 'HALL' + slot }); return this.code; }
        catch (e) { this.leave(); if (!(e && e.type === 'unavailable-id')) throw e; }
        // the id is taken by a hall the survey did not hear from (just opened, or slow to answer): knock on it
        // directly; if nobody answers it is a closed tab still holding the id, so move on to the next slot
        if (onStatus) onStatus(t('hall.entering'));
        try { await this.join('HALL' + slot, meta); return this.code; } catch (e) { /* try the next slot */ }
        if (onStatus) onStatus(t('hall.opening'));
      }
    }
    throw new Error('the online hall is busy - try again');
  }
  _knockAny(ids, meta, timeoutMs) {
    return new Promise((resolve, reject) => {
      let pending = ids.length, done = false, lastErr = null; const attempts = [];
      const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); this.peer.off('error', onErr); for (const a of attempts) if (!val || a.conn !== val.conn) { try { a.conn.close(); } catch (e) { /* ignore */ } } if (val) resolve(val); else reject(err || new Error('no lobby with that code')); };
      const failOne = (a, err) => { if (a.done) return; a.done = true; if (err && !/no lobby/.test(String(err.message))) lastErr = err; pending--; if (pending <= 0) finish(lastErr || new Error('no lobby with that code')); };
      const onErr = (err) => { if (err && err.type === 'peer-unavailable') { const a = attempts.find((x) => x.hostId === idFromError(err)); if (a) failOne(a, new Error('no lobby with that code')); } };
      this.peer.on('error', onErr);
      const timer = setTimeout(() => finish(new Error('no answer from that lobby')), timeoutMs);
      for (const hostId of ids) {
        let conn; try { conn = this.peer.connect(hostId, { reliable: true, serialization: 'json', metadata: meta }); } catch (e) { pending--; continue; }
        const a = { conn, hostId, done: false }; attempts.push(a);
        conn.on('data', (msg) => { if (!msg || a.done) return; if (msg.t === 'welcome') { a.done = true; finish(null, { hostId, conn, welcome: msg.d }); } else if (msg.t === 'refused') failOne(a, new Error(msg.d && msg.d.reason || 'the lobby turned you away')); });
        conn.on('error', (e) => failOne(a, e instanceof Error ? e : new Error('could not connect'))); conn.on('close', () => failOne(a, null));
      }
      if (pending <= 0) finish(lastErr || new Error('no lobby with that code'));
    });
  }
  _knock(hostId, meta, timeoutMs) {
    return new Promise((resolve, reject) => {
      let conn; try { conn = this.peer.connect(hostId, { reliable: true, serialization: 'json', metadata: meta }); } catch (e) { return reject(new Error('could not start a connection')); }
      let done = false;
      const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); this.peer.off('error', onErr); if (err) { try { conn.close(); } catch (e) { /* ignore */ } reject(err); } else resolve(val); };
      const timer = setTimeout(() => finish(new Error('no answer from that lobby')), timeoutMs);
      const onErr = (err) => { if (err && err.type === 'peer-unavailable' && idFromError(err) === hostId) finish(new Error('no lobby with that code')); };
      this.peer.on('error', onErr);
      conn.on('data', (msg) => { if (!msg) return; if (msg.t === 'welcome') finish(null, { conn, welcome: msg.d }); else if (msg.t === 'refused') finish(new Error(msg.d && msg.d.reason || 'the lobby turned you away')); });
      conn.on('error', (e) => finish(e instanceof Error ? e : new Error('could not connect')));
      conn.on('close', () => finish(new Error('the lobby closed the connection')));
    });
  }
  _adopt(hostId, conn, welcome) {
    this.hostId = hostId; this.conns.set(hostId, conn); this.connected = true; this.isPublic = !!(welcome && welcome.isPublic); this._wire(conn);
  }
  leave() {
    // closing our own connections must not look like other people leaving
    this.leaving = true; clearTimeout(this._aliasTimer); this._aliasTimer = null; if (this.alias) { try { this.alias.destroy(); } catch (e) { /* ignore */ } } this.alias = null; this.aliasCode = null;
    for (const c of this.conns.values()) { try { c.close(); } catch (e) { /* ignore */ } }
    this.conns.clear(); if (this.peer) { try { this.peer.destroy(); } catch (e) { /* ignore */ } }
    this.peer = null; this.connected = false; this.isHost = false; this.id = null; this.code = null; this.hostId = null; this.leaving = false;
  }

  // ---- messaging ----
  // host: to everyone; client: to the host (and on to everyone if relay is set)
  send(type, data, relay = false) {
    this.stats.sent++;
    if (this.isHost) { const m = { t: type, d: data, from: this.id }; for (const c of this.conns.values()) if (c.open) c.send(m); }
    else { const c = this.conns.get(this.hostId); if (c && c.open) c.send({ t: type, d: data, relay }); }
  }
  broadcast(type, data) { this.send(type, data, true); }
  sendTo(pid, type, data) {
    this.stats.sent++;
    if (this.isHost) { const c = this.conns.get(pid); if (c && c.open) c.send({ t: type, d: data, from: this.id }); }
    else { const c = this.conns.get(this.hostId); if (c && c.open) c.send({ t: type, d: data, to: pid, from: this.id }); }
  }
}
