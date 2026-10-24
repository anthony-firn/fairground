/**
 * Podcasts that reach every podcast app.
 *
 * A show is a signed, replaceable record (kind 33478); its episodes are NIP-F4 audio events (kind 54) that name the
 * show and carry the details podcast directories need. A gateway (gateway.ts) turns them into a standard RSS feed that
 * Apple Podcasts, Spotify, YouTube Music, Podcast Index and every other app can subscribe to, and stitches host-read
 * ads into downloads (ads.ts). The audio lives wherever the creator uploaded it; the feed is only a view of signed
 * events, so any gateway can serve it and a show can move between gateways.
 */
import { sha1 } from '@noble/hashes/legacy.js';
import { npubEncode } from 'nostr-tools/nip19';
import { finalizeEvent, type Event } from 'nostr-tools/pure';
import { KIND } from './kinds.ts';
import type { Mp3Layout } from './mp3.ts';
import { now, tag, tagValue } from './tags.ts';

/** Apple Podcasts categories, which Spotify and most other apps also use. */
export const PODCAST_CATEGORIES: Record<string, string[]> = {
  Arts: ['Books', 'Design', 'Fashion & Beauty', 'Food', 'Performing Arts', 'Visual Arts'],
  Business: ['Careers', 'Entrepreneurship', 'Investing', 'Management', 'Marketing', 'Non-Profit'],
  Comedy: ['Comedy Interviews', 'Improv', 'Stand-Up'],
  Education: ['Courses', 'How To', 'Language Learning', 'Self-Improvement'],
  Fiction: ['Comedy Fiction', 'Drama', 'Science Fiction'],
  Government: [],
  History: [],
  'Health & Fitness': ['Alternative Health', 'Fitness', 'Medicine', 'Mental Health', 'Nutrition', 'Sexuality'],
  'Kids & Family': ['Education for Kids', 'Parenting', 'Pets & Animals', 'Stories for Kids'],
  Leisure: ['Animation & Manga', 'Automotive', 'Aviation', 'Crafts', 'Games', 'Hobbies', 'Home & Garden', 'Video Games'],
  Music: ['Music Commentary', 'Music History', 'Music Interviews'],
  News: ['Business News', 'Daily News', 'Entertainment News', 'News Commentary', 'Politics', 'Sports News', 'Tech News'],
  'Religion & Spirituality': ['Buddhism', 'Christianity', 'Hinduism', 'Islam', 'Judaism', 'Religion', 'Spirituality'],
  Science: ['Astronomy', 'Chemistry', 'Earth Sciences', 'Life Sciences', 'Mathematics', 'Natural Sciences', 'Nature', 'Physics', 'Social Sciences'],
  'Society & Culture': ['Documentary', 'Personal Journals', 'Philosophy', 'Places & Travel', 'Relationships'],
  Sports: ['Baseball', 'Basketball', 'Cricket', 'Fantasy Sports', 'Football', 'Golf', 'Hockey', 'Rugby', 'Running', 'Soccer', 'Swimming', 'Tennis', 'Volleyball', 'Wilderness', 'Wrestling'],
  Technology: [],
  'True Crime': [],
  'TV & Film': ['After Shows', 'Film History', 'Film Interviews', 'Film Reviews', 'TV Reviews'],
};

export interface ShowInput {
  slug: string;
  title: string;
  description: string;
  /** Square artwork, 1400 to 3000 pixels, JPEG or PNG. */
  image: string;
  author: string;
  category: string;
  subcategory?: string;
  explicit: boolean;
  /** ISO 639 code, e.g. `en`. */
  language: string;
  type?: 'episodic' | 'serial';
  ownerName?: string;
  /** Apple and Spotify send a verification code here. It is public in the feed; it can be removed after verifying. */
  ownerEmail?: string;
  link?: string;
  copyright?: string;
  /** The show's permanent Podcasting 2.0 GUID, set when the show is created. */
  guid: string;
  created_at?: number;
}

export interface Show extends Omit<ShowInput, 'created_at'> {
  event: Event;
  creator: string;
  /** `33478:<creator>:<slug>`, which episodes use to name their show. */
  address: string;
}

export const showAddress = (creator: string, slug: string) => `${KIND.show}:${creator}:${slug}`;

const PODCAST_GUID_NAMESPACE = 'ead4c236-bf58-58c6-a2c6-a6b28d128cb6';

/** UUID v5 (RFC 9562) of a name in a namespace. */
function uuidV5(namespace: string, name: string): string {
  const ns = Uint8Array.from(namespace.replace(/-/g, '').match(/../g)!.map((h) => parseInt(h, 16)));
  const bytes = sha1(new Uint8Array([...ns, ...new TextEncoder().encode(name)])).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The Podcasting 2.0 GUID for a feed: UUID v5 of its URL without the scheme or trailing slashes. */
export const podcastGuid = (feedUrl: string): string => uuidV5(PODCAST_GUID_NAMESPACE, feedUrl.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, ''));

export const feedUrl = (gateway: string, creator: string, slug: string) => `${gateway.replace(/\/+$/, '')}/podcast/${npubEncode(creator)}/${slug}.xml`;

export function createShow(nostrKey: Uint8Array, s: ShowInput): Event {
  const tags = [
    ['d', s.slug],
    ['title', s.title],
    ['image', s.image],
    ['author', s.author],
    ['category', s.category, ...(s.subcategory ? [s.subcategory] : [])],
    ['explicit', s.explicit ? 'true' : 'false'],
    ['language', s.language],
    ['type', s.type ?? 'episodic'],
    ['guid', s.guid],
  ];
  if (s.ownerName || s.ownerEmail) tags.push(['owner', s.ownerName ?? s.author, s.ownerEmail ?? '']);
  if (s.link) tags.push(['r', s.link]);
  if (s.copyright) tags.push(['copyright', s.copyright]);
  return finalizeEvent({ kind: KIND.show, created_at: s.created_at ?? now(), content: s.description, tags }, nostrKey);
}

export function parseShow(ev: Event): Show | undefined {
  const slug = tagValue(ev, 'd');
  const title = tagValue(ev, 'title');
  const image = tagValue(ev, 'image');
  const [, category, subcategory] = tag(ev, 'category') ?? [];
  const guid = tagValue(ev, 'guid');
  if (ev.kind !== KIND.show || !slug || !title || !image || !category || !guid) return undefined;
  const [, ownerName, ownerEmail] = tag(ev, 'owner') ?? [];
  const type = tagValue(ev, 'type');
  return {
    event: ev,
    creator: ev.pubkey,
    address: showAddress(ev.pubkey, slug),
    slug,
    title,
    description: ev.content,
    image,
    author: tagValue(ev, 'author') ?? title,
    category,
    subcategory: subcategory || undefined,
    explicit: tagValue(ev, 'explicit') === 'true',
    language: tagValue(ev, 'language') ?? 'en',
    type: type === 'serial' ? 'serial' : 'episodic',
    ownerName: ownerName || undefined,
    ownerEmail: ownerEmail || undefined,
    link: tagValue(ev, 'r'),
    copyright: tagValue(ev, 'copyright'),
    guid,
  };
}

/** A point where an ad can play, chosen by the creator at a natural pause. */
export interface BreakMark {
  /** Seconds into the episode. */
  at: number;
  /** The MP3 frame boundary at that time, which lets a gateway splice an ad into downloads. */
  byteOffset?: number;
}

export interface EpisodeInput {
  show: string;
  /** Stays the same across edits, so podcast apps never list an episode twice. */
  guid: string;
  title: string;
  description: string;
  audio: { url: string; type: string; size?: number; duration?: number };
  image?: string;
  episode?: number;
  season?: number;
  episodeType?: 'full' | 'trailer' | 'bonus';
  explicit?: boolean;
  /** An HLS stream of the same audio, for players that prefer it. */
  hls?: string;
  transcript?: { url: string; type: string };
  /** Mid-roll positions. Pre-rolls play at the start and post-rolls at the end without a mark. */
  breaks?: BreakMark[];
  /** The MP3's structure, when it is one: what a gateway needs to stitch ads in without downloading it first. */
  mp3?: Pick<Mp3Layout, 'version' | 'sampleRate' | 'channels' | 'id3End' | 'audioStart' | 'audioEnd'>;
  topics?: string[];
  created_at?: number;
}

export interface Episode extends Omit<EpisodeInput, 'created_at' | 'topics'> {
  event: Event;
  creator: string;
  published: number;
}

export const mp3Tag = (m: NonNullable<EpisodeInput['mp3']>) =>
  ['mp3', String(m.version), String(m.sampleRate), String(m.channels), String(m.id3End), String(m.audioStart), String(m.audioEnd)];

export function parseMp3Tag(t: string[] | undefined): EpisodeInput['mp3'] {
  if (!t) return undefined;
  const [version, sampleRate, channels, id3End, audioStart, audioEnd] = t.slice(1).map(Number);
  if (![1, 2, 2.5].includes(version) || !(sampleRate > 0) || (channels !== 1 && channels !== 2)) return undefined;
  if (![id3End, audioStart, audioEnd].every(Number.isSafeInteger) || !(id3End <= audioStart && audioStart < audioEnd)) return undefined;
  return { version: version as 1 | 2 | 2.5, sampleRate, channels, id3End, audioStart, audioEnd };
}

export const breakTags = (breaks: BreakMark[] = []) =>
  [...breaks].sort((a, b) => a.at - b.at).map((b) => ['break', b.at.toFixed(3), ...(b.byteOffset !== undefined ? [String(b.byteOffset)] : [])]);

export function parseBreaks(ev: Pick<Event, 'tags'>): BreakMark[] {
  return ev.tags
    .filter((t) => t[0] === 'break')
    .map((t) => ({ at: Number(t[1]), byteOffset: t[2] === undefined ? undefined : Number(t[2]) }))
    .filter((b) => Number.isFinite(b.at) && b.at > 0 && (b.byteOffset === undefined || Number.isSafeInteger(b.byteOffset)))
    .sort((a, b) => a.at - b.at);
}

export function createPodcastEpisode(nostrKey: Uint8Array, e: EpisodeInput): Event {
  const tags = [
    ['a', e.show],
    ['guid', e.guid],
    ['title', e.title],
    ['description', e.description.slice(0, 500)],
    ['audio', e.audio.url, e.audio.type],
  ];
  if (e.audio.size) tags.push(['size', String(e.audio.size)]);
  if (e.audio.duration) tags.push(['duration', e.audio.duration.toFixed(3)]);
  if (e.image) tags.push(['image', e.image]);
  if (e.episode) tags.push(['episode', String(e.episode)]);
  if (e.season) tags.push(['season', String(e.season)]);
  if (e.episodeType && e.episodeType !== 'full') tags.push(['episode_type', e.episodeType]);
  if (e.explicit) tags.push(['explicit', 'true']);
  if (e.hls) tags.push(['hls', e.hls]);
  if (e.transcript) tags.push(['transcript', e.transcript.url, e.transcript.type]);
  if (e.mp3) tags.push(mp3Tag(e.mp3));
  tags.push(...breakTags(e.breaks), ...(e.topics ?? []).map((t) => ['t', t.toLowerCase()]));
  return finalizeEvent({ kind: 54, created_at: e.created_at ?? now(), content: e.description, tags }, nostrKey);
}

const positive = (v?: string) => (v && /^\d+(\.\d+)?$/.test(v) && Number(v) > 0 ? Number(v) : undefined);

export function parseEpisode(ev: Event): Episode | undefined {
  const show = tagValue(ev, 'a');
  const guid = tagValue(ev, 'guid');
  const title = tagValue(ev, 'title');
  const [, url, type = 'audio/mpeg'] = tag(ev, 'audio') ?? [];
  if (ev.kind !== 54 || !show?.startsWith(`${KIND.show}:${ev.pubkey}:`) || !guid || !title || !url?.startsWith('https://')) return undefined;
  const [, transcriptUrl, transcriptType] = tag(ev, 'transcript') ?? [];
  const episodeType = tagValue(ev, 'episode_type');
  return {
    event: ev,
    creator: ev.pubkey,
    published: ev.created_at,
    show,
    guid,
    title,
    description: ev.content || tagValue(ev, 'description') || '',
    audio: { url, type, size: positive(tagValue(ev, 'size')), duration: positive(tagValue(ev, 'duration')) },
    image: tagValue(ev, 'image'),
    episode: positive(tagValue(ev, 'episode')),
    season: positive(tagValue(ev, 'season')),
    episodeType: episodeType === 'trailer' || episodeType === 'bonus' ? episodeType : 'full',
    explicit: tagValue(ev, 'explicit') === 'true',
    hls: tagValue(ev, 'hls'),
    transcript: transcriptUrl ? { url: transcriptUrl, type: transcriptType ?? 'text/plain' } : undefined,
    breaks: parseBreaks(ev),
    mp3: parseMp3Tag(tag(ev, 'mp3')),
  };
}

/** A show's current episodes: the newest version of each GUID, newest first. */
export function currentEpisodes(events: Event[], show: string): Episode[] {
  const byGuid = new Map<string, Episode>();
  for (const ev of events) {
    const ep = parseEpisode(ev);
    if (!ep || ep.show !== show) continue;
    const prev = byGuid.get(ep.guid);
    if (!prev || ev.created_at > prev.event.created_at) byGuid.set(ep.guid, ep);
  }
  return [...byGuid.values()].sort((a, b) => b.published - a.published);
}

/** What still keeps a show out of Apple Podcasts or Spotify. Empty when it's ready to submit. */
export function feedProblems(show: Show, episodes: Episode[]): string[] {
  const problems: string[] = [];
  if (!show.ownerEmail) problems.push('Add an owner email: Apple and Spotify send a code there to confirm the show is yours.');
  if (!episodes.length) problems.push('Publish at least one episode.');
  if (episodes.some((e) => !e.audio.size)) problems.push('Some episodes don’t record their file size; upload them here, or re-save them, so podcast apps can show download progress.');
  if (episodes.some((e) => !/^audio\/(mpeg|mp4|x-m4a|aac)$/.test(e.audio.type))) problems.push('Podcast apps need MP3 or M4A audio files.');
  return problems;
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const el = (name: string, value: string | number | undefined) => (value === undefined || value === '' ? '' : `<${name}>${escape(String(value))}</${name}>`);
// Characters XML 1.0 forbids, which would make the whole feed unreadable.
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');

export interface RssContext {
  feedUrl: string;
  /** Where podcast apps download an episode: a gateway URL that can stitch ads in, or the audio itself. */
  enclosureUrl: (episode: Episode) => string;
  /** A page for the show or an episode in the Fairground app. */
  pageUrl: (episode?: Episode) => string;
  generatedAt?: number;
}

/** A podcast RSS 2.0 feed with the iTunes and Podcasting 2.0 tags Apple, Spotify and Podcast Index read. */
export function renderRss(show: Show, episodes: Episode[], ctx: RssContext): string {
  const date = (t: number) => new Date(t * 1000).toUTCString();
  const category = show.subcategory
    ? `<itunes:category text="${escape(show.category)}"><itunes:category text="${escape(show.subcategory)}"/></itunes:category>`
    : `<itunes:category text="${escape(show.category)}"/>`;
  const owner = show.ownerEmail ? `<itunes:owner>${el('itunes:name', show.ownerName ?? show.author)}${el('itunes:email', show.ownerEmail)}</itunes:owner>` : '';
  const items = episodes.map((e) => [
    '<item>',
    el('title', e.title),
    el('description', e.description),
    el('link', ctx.pageUrl(e)),
    `<guid isPermaLink="false">${escape(e.guid)}</guid>`,
    el('pubDate', date(e.published)),
    `<enclosure url="${escape(ctx.enclosureUrl(e))}" length="${e.audio.size ?? 0}" type="${escape(e.audio.type)}"/>`,
    el('itunes:duration', e.audio.duration ? Math.round(e.audio.duration) : undefined),
    el('itunes:episode', e.episode),
    el('itunes:season', e.season),
    el('itunes:episodeType', e.episodeType ?? 'full'),
    el('itunes:explicit', e.explicit || show.explicit ? 'true' : 'false'),
    e.image ? `<itunes:image href="${escape(e.image)}"/>` : '',
    e.transcript ? `<podcast:transcript url="${escape(e.transcript.url)}" type="${escape(e.transcript.type)}"/>` : '',
    e.hls ? `<podcast:alternateEnclosure type="application/x-mpegURL"><podcast:source uri="${escape(e.hls)}"/></podcast:alternateEnclosure>` : '',
    '</item>',
  ].join(''));
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '<channel>',
    `<atom:link href="${escape(ctx.feedUrl)}" rel="self" type="application/rss+xml"/>`,
    el('title', show.title),
    el('link', show.link ?? ctx.pageUrl()),
    el('language', show.language),
    el('description', show.description),
    el('itunes:author', show.author),
    `<itunes:image href="${escape(show.image)}"/>`,
    `<image>${el('url', show.image)}${el('title', show.title)}${el('link', show.link ?? ctx.pageUrl())}</image>`,
    category,
    el('itunes:explicit', show.explicit ? 'true' : 'false'),
    el('itunes:type', show.type ?? 'episodic'),
    owner,
    el('copyright', show.copyright),
    el('podcast:guid', show.guid),
    show.ownerEmail ? `<podcast:locked owner="${escape(show.ownerEmail)}">yes</podcast:locked>` : '',
    el('generator', 'Fairground'),
    el('lastBuildDate', date(ctx.generatedAt ?? now())),
    ...items,
    '</channel>',
    '</rss>',
  ].join('\n');
  return clean(xml);
}
