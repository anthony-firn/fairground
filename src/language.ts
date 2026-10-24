/**
 * Which language a post is in, offline and in a few microseconds: the writing system first, then, for Latin-script
 * text, the most frequent short function words. Readers start with their browser's languages, and pick up others they
 * actually engage with, so the feed feels like their own community without a settings screen.
 */
const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'is', 'to', 'of', 'in', 'that', 'it', 'you', 'for', 'with', 'this', 'are', 'was', 'have', 'not', 'but', 'what', 'just', 'my'],
  es: ['el', 'la', 'de', 'que', 'y', 'en', 'los', 'las', 'del', 'por', 'con', 'para', 'una', 'es', 'no', 'lo', 'se', 'pero', 'muy', 'como'],
  pt: ['o', 'a', 'de', 'que', 'e', 'do', 'da', 'em', 'um', 'uma', 'para', 'com', 'não', 'os', 'as', 'no', 'na', 'mais', 'você', 'isso'],
  fr: ['le', 'la', 'les', 'de', 'des', 'et', 'est', 'un', 'une', 'du', 'que', 'qui', 'pour', 'dans', 'pas', 'ce', 'sur', 'avec', 'je', 'vous'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'zu', 'den', 'mit', 'ein', 'eine', 'auf', 'es', 'sie', 'für', 'auch', 'dem', 'wir', 'aber'],
  it: ['il', 'la', 'di', 'che', 'e', 'è', 'non', 'un', 'una', 'per', 'del', 'della', 'con', 'sono', 'gli', 'le', 'ma', 'come', 'anche', 'questo'],
  nl: ['de', 'het', 'een', 'en', 'van', 'is', 'dat', 'niet', 'ik', 'je', 'op', 'te', 'met', 'voor', 'zijn', 'maar', 'ook', 'er', 'wat', 'naar'],
  sv: ['och', 'att', 'det', 'som', 'är', 'en', 'på', 'av', 'för', 'med', 'inte', 'jag', 'har', 'till', 'den', 'du', 'om', 'men', 'var', 'ett'],
  pl: ['i', 'w', 'nie', 'na', 'się', 'jest', 'to', 'że', 'do', 'z', 'jak', 'co', 'ale', 'tak', 'po', 'już', 'od', 'dla', 'czy', 'ten'],
  cs: ['a', 'je', 'se', 'na', 'to', 'že', 'v', 'jsem', 'ale', 'jak', 'tak', 'by', 'pro', 's', 'co', 'už', 'jsou', 'když', 'ze', 'tady'],
  tr: ['ve', 'bir', 'bu', 'da', 'de', 'için', 'ne', 'çok', 'ile', 'mi', 'gibi', 'daha', 'ama', 'var', 'ben', 'sen', 'olarak', 'kadar', 'diye', 'şey'],
  id: ['dan', 'yang', 'di', 'ini', 'itu', 'dengan', 'untuk', 'tidak', 'ada', 'ke', 'dari', 'saya', 'akan', 'juga', 'bisa', 'kita', 'aku', 'sudah', 'atau', 'karena'],
  vi: ['và', 'là', 'của', 'có', 'không', 'những', 'được', 'cho', 'một', 'người', 'này', 'với', 'các', 'trong', 'đã', 'tôi', 'mình', 'khi', 'thì', 'cũng'],
};

/** A best guess at a post's language as an ISO 639-1 code, or undefined when there is too little text to tell. */
export function detectLanguage(content: string): string | undefined {
  const text = content.replace(/(https?:\/\/|nostr:)\S+/g, ' ').replace(/[#@][\p{L}\p{N}_]+/gu, ' ');
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (letters < 6) return undefined;
  const count = (re: RegExp) => (text.match(re) ?? []).length;
  const share = (re: RegExp) => count(re) / letters;
  if (share(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) > 0.1) return 'ja';
  if (share(/\p{Script=Hangul}/gu) > 0.3) return 'ko';
  if (share(/\p{Script=Han}/gu) > 0.3) return 'zh';
  if (share(/\p{Script=Cyrillic}/gu) > 0.5) return /[ієїґ]/i.test(text) ? 'uk' : 'ru';
  if (share(/\p{Script=Arabic}/gu) > 0.5) return /[پچژگ]/.test(text) ? 'fa' : 'ar';
  if (share(/\p{Script=Hebrew}/gu) > 0.5) return 'he';
  if (share(/\p{Script=Devanagari}/gu) > 0.5) return 'hi';
  if (share(/\p{Script=Thai}/gu) > 0.5) return 'th';
  if (share(/\p{Script=Greek}/gu) > 0.5) return 'el';
  if (share(/\p{Script=Latin}/gu) < 0.5) return undefined;
  const words = text.toLowerCase().split(/[^\p{L}']+/u).filter(Boolean);
  if (words.length < 3) return undefined;
  let best: string | undefined;
  let most = 0;
  let second = 0;
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    const hits = words.filter((w) => set.has(w)).length;
    if (hits > most) [best, most, second] = [lang, hits, most];
    else if (hits > second) second = hits;
  }
  return most >= 2 && most > second ? best : undefined;
}

/** Languages a reader reads: their browser's, plus any they keep engaging with. */
export function readerLanguages(browser: readonly string[], learned: Record<string, number> = {}): Set<string> {
  const langs = new Set(browser.map((l) => l.toLowerCase().split('-')[0]).filter(Boolean));
  if (!langs.size) langs.add('en');
  const total = Object.values(learned).reduce((a, b) => a + b, 0);
  for (const [lang, n] of Object.entries(learned)) if (n >= 5 && n / total >= 0.15) langs.add(lang);
  return langs;
}
