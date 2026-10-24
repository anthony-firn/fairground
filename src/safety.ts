/**
 * What a reader sees. Nostr relays carry everything anyone posts, so the client has to decide.
 *
 * - Never shown, whatever the settings, with the author blocked: sexual content involving minors, bestiality, and
 *   intimate imagery shared without consent. These are illegal in most places, and a client can't check each
 *   reader's local law, so they are blocked everywhere.
 * - Hidden by safe search, which is on by default: explicit sexual content. Adults (18+, self-declared) can turn it
 *   off and see everything else that's legal.
 * - Hidden by default: slurs and threats (a separate setting), spam, junk and self-declared bots.
 * - Posts in scripts the reader doesn't read are left out by default.
 *
 * The term lists below exist only to recognise abuse; they are not exhaustive. Showing only Fairground accounts (see
 * network.ts) keeps out the spam and abuse that circulate on the wider Nostr network.
 */
import type { Event } from 'nostr-tools/pure';

/** What a post says: its content plus, for photos, videos and episodes, the title, summary and alt text in its tags. */
const words = (ev: Event) => [
  ev.content,
  ...ev.tags.filter((t) => ['title', 'summary', 'description', 'alt'].includes(t[0])).map((t) => t[1] ?? ''),
  ...ev.tags.filter((t) => t[0] === 'imeta').flatMap((t) => t.filter((e) => e.startsWith('alt ')).map((e) => e.slice(4))),
].join(' ').trim();
const mediaUrl = (ev: Event) => ev.tags.find((t) => t[0] === 'imeta')?.find((e) => e.startsWith('url ')) ?? ev.tags.find((t) => t[0] === 'audio')?.[1] ?? '';

const text = (ev: Event) =>
  `${words(ev)} ${ev.tags.filter((t) => t[0] === 't').map((t) => `#${t[1]}`).join(' ')}`.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

const MINOR = /\b(teen(s|age|ager|agers)?|young(er)?|underage|minors?|child(ren)?|kids?|kiddies|pre-?teens?|infants?|babies|toddlers?|lolita|schoolgirls?|schoolboys?|schoolthot|pyt|(1[0-7]|[1-9]) ?(yo|y\/o|years? old))\b/;
const SEXUAL = /\b(sex|sexy|nudes?|naked|porn\w*|xxx|nsfw|horny|blowjobs?|cum|dicks?|cocks?|pussy|tits?|boobs?|nipples?|lewd|rape\w*|cnc\w*|fetish\w*|onlyfans|explicit|erotic\w*|incest|bestiality|snapleak|nolimit|taboo|momson)\b/;
const ABUSE_CODES = /\b(pthc|child ?porn\w*|csam|jailbait|loli|shota)\b/;
const SELLING = /(t\.me\/|telegram|dm me|\bcontents?\b|\bleaks?\b)/;
const ADULT = /\b(porn\w*|xxx|nsfw|nudes?|naked|horny|blowjobs?|onlyfans|lewd|erotic\w*|cum|dicks?|cocks?|pussy|tits|boobs|nipples?|fetish\w*)\b/;
const BESTIALITY = /\b(bestiality|zoophil\w*)\b/;
const NON_CONSENSUAL = /\b(revenge ?porn|hidden ?cams?|spy ?cams?|upskirts?|creepshots?|leaked ?nudes|deepfake ?(porn|nudes?))\b/;
const HATE = /\b(fag(got)?s?|homos|n[i1y]gg(a|as|er|ers|ah)|kikes?|retards?|trann(y|ies)|chinks?|spics?|wetbacks?|kys)\b|you('| ha)ve been warned|i('| wi)ll kill you|kill yourself/;

/** Sexual content involving minors, or the codes used to sell it. */
export function isChildAbuse(ev: Event): boolean {
  const t = text(ev);
  if (ABUSE_CODES.test(t)) return true;
  if (MINOR.test(t) && SEXUAL.test(t)) return true;
  if (/\b(cp|pedo\w*)\b/.test(t) && (SEXUAL.test(t) || MINOR.test(t) || SELLING.test(t))) return true;
  return false;
}

/** Content that is never shown: child abuse, bestiality, and intimate imagery shared without consent. */
export function isIllegal(ev: Event): boolean {
  if (isChildAbuse(ev)) return true;
  const t = text(ev);
  return BESTIALITY.test(t) || NON_CONSENSUAL.test(t);
}

export type HideReason = 'sexual' | 'hate' | 'spam' | 'junk' | 'bot';

export type Verdict = { block: true } | { block: false; hide?: HideReason };

const hashtagCount = (ev: Event) =>
  new Set([...ev.content.matchAll(/#[\p{L}\p{N}_]+/gu)].map((m) => m[0].toLowerCase()).concat(ev.tags.filter((t) => t[0] === 't').map((t) => `#${t[1]}`))).size;

function looksLikeJson(s: string): boolean {
  const trimmed = s.trim();
  if (!/^[{[]/.test(trimmed)) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function assess(ev: Event, profile?: { bot?: boolean }): Verdict {
  if (isIllegal(ev)) return { block: true };
  const t = text(ev);
  if (ev.tags.some((tag) => tag[0] === 'content-warning') || ADULT.test(t)) return { block: false, hide: 'sexual' };
  if (HATE.test(t)) return { block: false, hide: 'hate' };
  if (hashtagCount(ev) > 10) return { block: false, hide: 'spam' };
  if (looksLikeJson(ev.content) || words(ev).length < 2) return { block: false, hide: 'junk' };
  if (profile?.bot) return { block: false, hide: 'bot' };
  return { block: false };
}

export type Script = 'latin' | 'cjk' | 'cyrillic' | 'arabic' | 'hebrew' | 'devanagari' | 'thai' | 'greek' | 'other' | 'none';

const SCRIPTS: [Script, RegExp][] = [
  ['latin', /\p{Script=Latin}/gu],
  ['cjk', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu],
  ['cyrillic', /\p{Script=Cyrillic}/gu],
  ['arabic', /\p{Script=Arabic}/gu],
  ['hebrew', /\p{Script=Hebrew}/gu],
  ['devanagari', /\p{Script=Devanagari}/gu],
  ['thai', /\p{Script=Thai}/gu],
  ['greek', /\p{Script=Greek}/gu],
];

/** The writing system most of a post's words use, ignoring links, mentions and hashtags. */
export function scriptOf(content: string): Script {
  const words = content.replace(/(https?:\/\/|nostr:)\S+/g, ' ').replace(/#[\p{L}\p{N}_]+/gu, ' ');
  const letters = (words.match(/\p{L}/gu) ?? []).length;
  if (letters < 3) return 'none';
  let best: Script = 'other';
  let most = 0;
  for (const [script, pattern] of SCRIPTS) {
    const n = (words.match(pattern) ?? []).length;
    if (n > most) [best, most] = [script, n];
  }
  return most / letters > 0.5 ? best : 'other';
}

const LANGUAGE_SCRIPTS: Record<string, Script> = {
  ja: 'cjk', zh: 'cjk', ko: 'cjk', ru: 'cyrillic', uk: 'cyrillic', bg: 'cyrillic', sr: 'cyrillic', mk: 'cyrillic', be: 'cyrillic',
  kk: 'cyrillic', ar: 'arabic', fa: 'arabic', ur: 'arabic', he: 'hebrew', hi: 'devanagari', mr: 'devanagari', ne: 'devanagari',
  th: 'thai', el: 'greek',
};

/** Scripts a reader reads, from their browser languages. Latin is always included; most Nostr posts use it. */
export function readerScripts(languages: readonly string[]): Set<Script> {
  const scripts = new Set<Script>(['latin', 'none']);
  for (const lang of languages) scripts.add(LANGUAGE_SCRIPTS[lang.toLowerCase().split('-')[0]] ?? 'latin');
  return scripts;
}

/** Posts that repeat an earlier post by the same author (ignoring digits), so a bot's stream shows once. */
export function repeats(events: Event[]): Set<string> {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const ev of [...events].sort((a, b) => b.created_at - a.created_at)) {
    const key = `${ev.pubkey}:${mediaUrl(ev)}:${words(ev).toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 200)}`;
    if (seen.has(key)) out.add(ev.id);
    else seen.add(key);
  }
  return out;
}
