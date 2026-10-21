// Player names other people will see. A guest picks their own, so it goes through a word filter
// before it is shown or sent; anything that trips it is swapped for a plain guest name. Names that
// arrive from other players are filtered the same way, in case a modified client sends one.
// The list is deliberately short and blunt: whole-word matches for short words, substring matches
// for longer roots, after undoing the usual disguises (case, accents, l33t digits, sp.a.c.e.s,
// repeated letters).

export const NAME_MAX = 20;

// substrings (latin roots are matched after normalising; others as written)
const ROOTS = [
  // English
  'fuck', 'fck', 'shit', 'bitch', 'cunt', 'dick', 'cock', 'pussy', 'whore', 'slut', 'bastard', 'asshole',
  'nigger', 'nigga', 'faggot', 'retard', 'rapist', 'nazi', 'hitler', 'porn', 'penis', 'vagina', 'twat',
  'wank', 'jizz', 'dildo', 'boob', 'blowjob', 'handjob', 'motherf', 'kike', 'chink', 'tranny',
  // Spanish / Portuguese
  'hijodeputa', 'putamadre', 'mierda', 'pendej', 'cabron', 'verga', 'chinga', 'maricon', 'caralho', 'buceta',
  'viado', 'arrombad',
  // French
  'merde', 'putain', 'connard', 'conasse', 'salope', 'encule', 'batard', 'niquetamere', 'ntm',
  // German
  'scheis', 'fotze', 'hurensohn', 'wichser', 'schlampe', 'arschloch', 'missgeburt',
  // Italian
  'cazzo', 'stronz', 'vaffancul', 'puttan', 'merda', 'coglion',
  // Russian / Ukrainian
  'хуй', 'хуе', 'хуё', 'пизд', 'ебат', 'ебан', 'еблан', 'бляд', 'блять', 'сука', 'мудак', 'пидор', 'залуп',
  // Chinese
  '操你', '肏', '他妈', '他媽', '你妈', '你媽', '傻逼', '傻屄', '屄', '鸡巴', '雞巴', '婊子', '干你娘', '幹你娘', '贱人', '賤人', '王八蛋',
  // Japanese
  'ちんこ', 'まんこ', 'ちんぽ', '死ね', 'しね', 'くたばれ',
  // Korean
  '씨발', '시발', '병신', '개새끼', '좆', '지랄', '썅',
  // Arabic / Hindi / Thai / Vietnamese / Indonesian
  'شرموط', 'मादरचोद', 'भोसड', 'चूतिय', 'रंडी', 'เหี้ย', 'ควย', 'địt', 'lồn', 'cặc', 'kontol', 'memek', 'ngentot', 'bangsat',
];
// whole words only (too short to match inside other words)
const WORDS = ['ass', 'arse', 'fag', 'fuk', 'cum', 'sex', 'kkk', 'tits', 'xxx', 'stfu', 'rape', 'spic', 'puta', 'puto', 'pute', 'cono', 'foda', 'nmsl', 'cnm'];
// innocent words that contain a root
const ALLOW = ['peacock', 'cockatoo', 'cockpit', 'cocktail', 'hancock', 'hitchcock', 'scunthorpe', 'dickens', 'dickinson', 'shitake', 'shiitake',
  'therapist', 'cassandra', 'shitzu'];

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '!': 'i', '|': 'l', '€': 'e' };
const squash = (s) => s.replace(/(.)\1+/gu, '$1');
function normalise(s) {
  let out = String(s).normalize('NFKC').toLowerCase();
  out = out.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC'); // é -> e (Vietnamese keeps its own copy below)
  out = [...out].map((c) => LEET[c] || c).join('');
  return out;
}
const ROOT_N = ROOTS.map((r) => squash(normalise(r)));
const ALLOW_N = ALLOW.map((r) => squash(normalise(r)));
const WORDS_N = WORDS.map((w) => squash(normalise(w))).filter((w) => w.length >= 3);

export function isRude(raw) {
  const text = String(raw || '');
  const lower = text.normalize('NFKC').toLowerCase();
  const n = normalise(text);
  // tokens for whole-word checks; one squashed string with everything but letters removed for roots
  const tokens = n.split(/[^\p{L}\p{N}]+/u).filter(Boolean).flatMap((tk) => [tk, tk.replace(/(.)\1{2,}/gu, '$1$1'), squash(tk)]);
  let compact = squash(n.replace(/[^\p{L}\p{N}]+/gu, ''));
  for (const a of ALLOW_N) compact = compact.split(a).join('_');
  if (ROOT_N.some((r) => r && compact.includes(r))) return true;
  if (ROOTS.some((r) => /[^\x00-\x7f]/.test(r) && lower.includes(r))) return true; // diacritics that carry meaning (Vietnamese)
  return tokens.some((tk) => WORDS.includes(tk) || WORDS_N.includes(tk)) || WORDS.includes(compact);
}

// a name safe to show: trimmed, length-capped, control characters gone; rude ones become `fallback`
export function cleanName(raw, fallback) {
  const s = String(raw || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  if (!s || isRude(s)) return fallback;
  return s;
}
