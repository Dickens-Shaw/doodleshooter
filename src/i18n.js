// Interface language. English is the source; the other files in ./lang/ use the same keys.
import en from './lang/en.js';
import es from './lang/es.js';
import fr from './lang/fr.js';
import de from './lang/de.js';
import it from './lang/it.js';
import pt from './lang/pt.js';
import zhCN from './lang/zh-CN.js';
import zhTW from './lang/zh-TW.js';
import ja from './lang/ja.js';
import ko from './lang/ko.js';
import vi from './lang/vi.js';
import ar from './lang/ar.js';
import hi from './lang/hi.js';
import id from './lang/id.js';
import th from './lang/th.js';
import ru from './lang/ru.js';
import uk from './lang/uk.js';
import { platformReady, store } from './platform.js';

// the SDK's locale is only readable once it has started
await platformReady;

export const LANGS = [
  ['en', 'English', en], ['zh-CN', '简体中文', zhCN], ['zh-TW', '繁體中文', zhTW],
  ['es', 'Español (Latinoamérica)', es], ['fr', 'Français', fr], ['de', 'Deutsch', de],
  ['it', 'Italiano', it], ['pt', 'Português (Brasil)', pt], ['ja', '日本語', ja],
  ['ko', '한국어', ko], ['vi', 'Tiếng Việt', vi], ['ar', 'العربية', ar], ['hi', 'हिन्दी', hi],
  ['id', 'Bahasa Indonesia', id], ['th', 'ไทย', th], ['ru', 'Русский', ru], ['uk', 'Українська', uk],
];
const TABLE = Object.fromEntries(LANGS.map(([code, , dict]) => [code, dict]));

// a browser or platform locale ("pt-BR", "zh-Hant-HK", "es-419") mapped to one of ours, or null
export function matchLang(loc) {
  if (!loc) return null;
  const l = String(loc).replace('_', '-').toLowerCase();
  if (l.startsWith('zh')) return /hant|tw|hk|mo/.test(l) ? 'zh-TW' : 'zh-CN';
  const base = l.split('-')[0];
  if (base === 'in') return 'id';
  return TABLE[base] ? base : null;
}
function detect() {
  const saved = store.get('doodle_lang'); if (saved && TABLE[saved]) return saved;
  try { const cg = window.CrazyGames && window.CrazyGames.SDK && window.CrazyGames.SDK.user && window.CrazyGames.SDK.user.systemInfo; const m = cg && matchLang(cg.locale); if (m) return m; } catch (e) { /* no SDK */ }
  for (const loc of navigator.languages || [navigator.language]) { const m = matchLang(loc); if (m) return m; }
  return 'en';
}
export const lang = detect();
const dict = TABLE[lang];
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';

// t('wave.n', { n: 3 }) → "Wave 3"; a key missing from a translation falls back to English
export function t(key, vars) {
  let s = dict[key] ?? en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}
// remember the choice and reload, so every label (including the ones built at start-up) is redrawn
export function setLang(code) {
  if (!TABLE[code] || code === lang) return;
  store.set('doodle_lang', code);
  location.reload();
}
