// CrazyGames SDK adapter. Everything the game asks of the platform goes through here, so the rest
// of the code never touches the SDK. Off CrazyGames (local files, Vercel, any other host) the SDK
// reports itself 'disabled' and every call here quietly does nothing.
const sdk = () => window.CrazyGames && window.CrazyGames.SDK;
const INIT_TIMEOUT_MS = 4000;
let ready = false, playing = false, loading = false, lastHappy = -Infinity, lastRoom = '';

function call(fn) { if (!ready) return; try { fn(sdk()); } catch (e) { console.warn('[platform]', e); } }

export const platform = {
  get active() { return ready; },
  // Start the SDK. Never throws and never waits longer than INIT_TIMEOUT_MS: a blocked script, a
  // failed init or one that hangs just leaves the game running without the platform. An init that
  // finishes after the timeout still switches the calls on, and reports gameplay already running.
  async init() {
    const s = sdk(); if (!s) return;
    const done = s.init().then(() => {
      if (s.environment !== 'crazygames' && s.environment !== 'local') return;
      ready = true;
      if (playing) call((s) => s.game.gameplayStart());
    }).catch((e) => console.warn('[platform] init failed', e));
    let timer;
    const timeout = new Promise((r) => { timer = setTimeout(() => { console.warn('[platform] init timed out'); r(); }, INIT_TIMEOUT_MS); });
    await Promise.race([done, timeout]); clearTimeout(timer);
  },
  // loadingStart while the first level is built, loadingStop once its first frame is on screen
  loadingStart() { if (loading || !ready) return; loading = true; call((s) => s.game.loadingStart()); },
  loadingStop() { if (!loading) return; loading = false; call((s) => s.game.loadingStop()); },
  // CrazyGames account: the signed-in user ({ username, profilePictureUrl }) or null for a guest
  async getUser() { if (!ready) return null; try { return (await sdk().user.getUser()) || null; } catch (e) { console.warn('[platform] getUser failed', e); return null; } },
  // whether this portal offers accounts at all (some CrazyGames domains do not)
  get canLogin() { if (!ready) return false; try { return !!sdk().user.isUserAccountAvailable; } catch (e) { return false; } },
  // the CrazyGames sign-in window; only ever opened from the player's own click
  async login() { if (!ready) return null; try { return (await sdk().user.showAuthPrompt()) || null; } catch (e) { return null; } },
  // sign-in or sign-out while the game runs
  onAuth(fn) { call((s) => s.user.addAuthListener((user) => fn(user || null))); },
  // Ads. Resolves once the ad is over (or never started): { shown, ok }. ok means a rewarded ad
  // was watched to the end. hooks.start/end run around actual playback (mute, then unmute).
  requestAd(type, hooks = {}) {
    return new Promise((resolve) => {
      if (!ready) { resolve({ shown: false, ok: false }); return; }
      let shown = false, settled = false, timer = 0;
      const done = (ok) => { if (settled) return; settled = true; clearTimeout(timer); if (shown && hooks.end) hooks.end(); resolve({ shown, ok }); };
      timer = setTimeout(() => done(false), 120000); // never leave the game stuck waiting on the SDK
      try {
        sdk().ad.requestAd(type, {
          adStarted: () => { shown = true; if (hooks.start) hooks.start(); },
          adFinished: () => done(true),
          adError: (e) => { console.warn('[platform] ad', type, e); done(false); },
        });
      } catch (e) { console.warn('[platform] ad', e); done(false); }
    });
  },
  async hasAdblock() { if (!ready) return false; try { return !!(await sdk().ad.hasAdblock()); } catch (e) { return false; } },
  // a real high point only (new record, boss down, checkpoint, match won); spaced out so it stays rare
  happytime() { const now = performance.now(); if (now - lastHappy < 10000) return; lastHappy = now; call((s) => s.game.happytime()); },
  // Called every frame with whether the player is actually playing; reports only the changes.
  // gameplayStart on start, resume, respawn and the next run; gameplayStop on menus, pause and death.
  setPlaying(on) {
    if (on === playing) return; playing = on;
    call((s) => (on ? s.game.gameplayStart() : s.game.gameplayStop()));
  },
  // ---- platform settings and device ----
  // the CrazyGames sound setting (true = the player turned game sound off there); and its changes
  get muteAudio() { if (!ready) return false; try { return !!(sdk().game.settings || {}).muteAudio; } catch (e) { return false; } },
  onSettings(fn) { call((s) => s.game.addSettingsChangeListener((st) => fn(st || {}))); },
  // 'desktop' | 'tablet' | 'mobile'. Off CrazyGames: a touch screen with no mouse counts as mobile.
  get deviceType() {
    if (ready) { try { const d = sdk().user.systemInfo.device.type; if (d) return String(d).toLowerCase(); } catch (e) { /* not reported */ } }
    try { if (navigator.maxTouchPoints > 0 && matchMedia('(hover: none) and (pointer: coarse)').matches) return 'mobile'; } catch (e) { /* ignore */ }
    return 'desktop';
  },
  // ---- multiplayer rooms (lobbies) ----
  // The lobby the player is in, so friends can join from the CrazyGames UI; null when they leave it.
  // Only changes are sent.
  setRoom(room) {
    const key = room ? JSON.stringify(room) : '';
    if (key === lastRoom) return;
    const had = lastRoom; lastRoom = key;
    if (room) call((s) => s.game.updateRoom({ roomId: room.code, isJoinable: !!room.joinable, inviteParams: { code: room.code } }));
    else if (had) call((s) => s.game.leftRoom());
  },
  // A link that opens the game straight into this lobby. Off CrazyGames it is this page with ?join=.
  async inviteLink(code) {
    if (ready) { try { const l = await sdk().game.inviteLink({ code }); if (l) return String(l); } catch (e) { console.warn('[platform] inviteLink', e); } }
    const u = new URL(location.href); u.search = ''; u.hash = ''; u.searchParams.set('join', code); return u.toString();
  },
  // the lobby code the game was opened with (an invite link), or null
  inviteCode() {
    let c = null;
    if (ready) { try { const s = sdk(), p = s.game.inviteParams; c = (p && p.code) || s.game.getInviteParam('code'); } catch (e) { /* no invite */ } }
    if (!c) { try { c = new URLSearchParams(location.search).get('join'); } catch (e) { /* ignore */ } }
    c = String(c || '').trim().toUpperCase();
    return /^[A-Z0-9]{3,8}$/.test(c) ? c : null;
  },
  // started from the CrazyGames party UI: go straight into a fresh private lobby
  get instantMultiplayer() { if (!ready) return false; try { return !!sdk().game.isInstantMultiplayer; } catch (e) { return false; } },
  // a friend's invite accepted while the game is already running
  onJoinRoom(fn) { call((s) => s.game.addJoinRoomListener((p) => { const c = String((p && p.code) || '').trim().toUpperCase(); if (/^[A-Z0-9]{3,8}$/.test(c)) fn(c); })); },
};

// Saves. On CrazyGames they go to the SDK's Data module (kept on the device for guests, synced to
// the account once signed in); anywhere else, or if the SDK never started, to localStorage. Only
// read after platformReady. Same calls as localStorage: strings in, strings (or null) out.
const local = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
};
export const store = {
  get(k) {
    if (ready) { try { return sdk().data.getItem(k); } catch (e) { console.warn('[platform] data read failed', e); } }
    return local.get(k);
  },
  set(k, v) {
    v = String(v);
    if (ready) { try { sdk().data.setItem(k, v); return; } catch (e) { console.warn('[platform] data write failed', e); } }
    local.set(k, v);
  },
};

// Started once, as soon as anything imports this file. i18n waits on it before picking the
// language and main.js before reading saves and building the level.
export const platformReady = platform.init().catch(() => {});
