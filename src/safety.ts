/**
 * What a reader sees by default. Nostr relays carry everything anyone posts, so the client has to decide.
 *
 * - Sexual content involving minors is never shown, whatever the settings, and its author is blocked.
 * - Sexual content, hate and threats, spam, junk and self-declared bots are hidden by default; readers can show
 *   sexual or offensive posts in settings.
 * - Posts in scripts the reader doesn't read are left out by default.
 *
 * The term lists below exist only to recognise abuse; they are not exhaustive, and the reputation gate in the feed
 * (strangers must be followed by the starting network) does most of the work against new spam accounts.
 */
import type { Event } from 'nostr-tools/pure';

const text = (ev: Event) =>
  `${ev.content} ${ev.tags.filter((t) => t[0] === 't').map((t) => `#${t[1]}`).join(' ')}`.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

const MINOR = /\b(teen(s|age|ager|agers)?|young(er)?|underage|minors?|child(ren)?|kids?|kiddies|pre-?teens?|infants?|babies|toddlers?|lolita|schoolgirls?|schoolboys?|schoolthot|pyt|(1[0-7]|[1-9]) ?(yo|y\/o|years? old))\b/;
const SEXUAL = /\b(sex|sexy|nudes?|naked|porn\w*|xxx|nsfw|horny|blowjobs?|cum|dicks?|cocks?|pussy|tits?|boobs?|nipples?|lewd|rape\w*|cnc\w*|fetish\w*|onlyfans|explicit|erotic\w*|incest|bestiality|snapleak|nolimit|taboo|momson)\b/;
const ABUSE_CODES = /\b(pthc|child ?porn\w*|csam|jailbait|loli|shota)\b/;
const SELLING = /(t\.me\/|telegram|dm me|\bcontents?\b|\bleaks?\b)/;
const ADULT = /\b(porn\w*|xxx|nsfw|nudes?|naked|horny|blowjobs?|onlyfans|lewd|erotic\w*|cum|dicks?|cocks?|pussy|tits|boobs|nipples?|fetish\w*)\b/;
const HATE = /\b(fag(got)?s?|homos|n[i1y]gg(a|as|er|ers|ah)|kikes?|retards?|trann(y|ies)|chinks?|spics?|wetbacks?|kys)\b|you('| ha)ve been warned|i('| wi)ll kill you|kill yourself/;

/** Sexual content involving minors, or the codes used to sell it. */
export function isChildAbuse(ev: Event): boolean {
  const t = text(ev);
  if (ABUSE_CODES.test(t)) return true;
  if (MINOR.test(t) && SEXUAL.test(t)) return true;
  if (/\b(cp|pedo\w*)\b/.test(t) && (SEXUAL.test(t) || MINOR.test(t) || SELLING.test(t))) return true;
  return false;
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
  if (isChildAbuse(ev)) return { block: true };
  const t = text(ev);
  if (ev.tags.some((tag) => tag[0] === 'content-warning') || ADULT.test(t)) return { block: false, hide: 'sexual' };
  if (HATE.test(t)) return { block: false, hide: 'hate' };
  if (hashtagCount(ev) > 10) return { block: false, hide: 'spam' };
  if (looksLikeJson(ev.content) || ev.content.trim().length < 2) return { block: false, hide: 'junk' };
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
    const key = `${ev.pubkey}:${ev.content.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 200)}`;
    if (seen.has(key)) out.add(ev.id);
    else seen.add(key);
  }
  return out;
}

/**
 * Long-standing, widely followed Nostr accounts whose follows form the starting network: for a reader who follows no
 * one yet, strangers must be followed by one of these to appear in "For you". Identities checked against their NIP-05
 * addresses in October 2026. Readers can change the list, or turn the gate off, in settings.
 */
export const SEED_ACCOUNTS: { name: string; pubkey: string }[] = [
  { name: 'jack', pubkey: '82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2' },
  { name: 'fiatjaf', pubkey: '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d' },
  { name: 'jb55', pubkey: '32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245' },
  { name: 'ODELL', pubkey: '04c915daefee38317fa734444acee390a8269fe5810b2241e5e6dd343dfbecc9' },
  { name: 'Gigi', pubkey: '6e468422dfb74a5738702a8823b9b28168abab8655faacb6853cd0ee15deee93' },
  { name: 'pablof7z', pubkey: 'fa984bd7dbb282f07e16e7ae87b26a2a7b9b90b7246a44771f0cf5ae58018f52' },
  { name: 'hodlbod', pubkey: '97c70a44366a6535c145b333f973ea86dfdc2d7a99da618c40c64705ad98e322' },
  { name: 'Vitor Pamplona', pubkey: '460c25e682fda7832b52d1f22d3d22b3176d972f60dcdc3212ed8c92ef85065c' },
  { name: 'Derek Ross', pubkey: '3f770d65d3a764a9c5cb503ae123e62ec7598ad035d836e2a810f3877a745b24' },
  { name: 'Lyn Alden', pubkey: 'eab0e756d32b80bcd464f3d844b8040303075a13eabc3599a762c9ac7ab91f4f' },
  { name: 'miljan', pubkey: 'd61f3bc5b3eb4400efdae6169a5c17cabf3246b514361de939ce4a1a0da6ef4a' },
];

/** The starting network: the seed accounts and everyone they follow, from their contact lists (kind 3). */
export function networkFrom(contactLists: Event[], seeds: string[]): Set<string> {
  const network = new Set(seeds);
  const newest = new Map<string, Event>();
  for (const ev of contactLists) {
    if (ev.kind !== 3 || !seeds.includes(ev.pubkey)) continue;
    const prev = newest.get(ev.pubkey);
    if (!prev || ev.created_at > prev.created_at) newest.set(ev.pubkey, ev);
  }
  for (const list of newest.values()) for (const t of list.tags) if (t[0] === 'p' && /^[0-9a-f]{64}$/.test(t[1] ?? '')) network.add(t[1]);
  return network;
}
