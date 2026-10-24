/**
 * Media formats, each with its own interface: photos (NIP-68), videos and shorts (NIP-71), podcast episodes (NIP-F4),
 * and ordinary posts. Ordinary posts that carry an image, video or audio link count towards those formats too, since
 * that is how most people share media on Nostr.
 */
import { finalizeEvent, type Event } from 'nostr-tools/pure';
import { now, tag, tagValue } from './tags.ts';

export type MediaKind = 'post' | 'photo' | 'video' | 'short' | 'audio';

export const MEDIA_KINDS = {
  photo: [20],
  video: [21, 34235],
  short: [22, 34236],
  audio: [54],
} as const;

/** Every event kind the media interfaces read. */
export const ALL_MEDIA_KINDS = [1, 20, 21, 22, 54, 34235, 34236];

export interface MediaItem {
  event: Event;
  kind: MediaKind;
  title?: string;
  description: string;
  images: string[];
  video?: { url: string; poster?: string; duration?: number; width?: number; height?: number };
  audio?: { url: string; type?: string; duration?: number };
}

const URL_RE = /https:\/\/[^\s<>"']+/g;
const IMAGE = /\.(jpe?g|png|gif|webp|avif)(\?\S*)?$/i;
const VIDEO = /\.(mp4|webm|mov|m3u8)(\?\S*)?$/i;
const AUDIO = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav)(\?\S*)?$/i;

/** NIP-92 `imeta`: space-separated "key value" entries. */
export function parseImeta(t: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const entry of t.slice(1)) {
    const i = entry.indexOf(' ');
    if (i < 1) continue;
    (out[entry.slice(0, i)] ??= []).push(entry.slice(i + 1));
  }
  return out;
}

const httpsOnly = (u?: string) => (u && u.startsWith('https://') ? u : undefined);
const dims = (d?: string) => {
  const m = /^(\d+)x(\d+)$/.exec(d ?? '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : {};
};

/** Classifies an event into one of the media formats, or undefined if it carries nothing playable. */
export function toMedia(ev: Event): MediaItem | undefined {
  const imetas = ev.tags.filter((t) => t[0] === 'imeta').map(parseImeta);
  const title = tagValue(ev, 'title')?.slice(0, 200);
  if (ev.kind === 20) {
    const images = imetas.map((m) => httpsOnly(m.url?.[0])).filter((u): u is string => !!u);
    return images.length ? { event: ev, kind: 'photo', title, description: ev.content, images } : undefined;
  }
  if ([21, 22, 34235, 34236].includes(ev.kind)) {
    const variant = imetas.find((m) => httpsOnly(m.url?.[0]) && (m.m?.[0] ?? 'video/mp4').startsWith('video/') && !m.url![0].endsWith('.m3u8')) ?? imetas[0];
    const url = httpsOnly(variant?.url?.[0]);
    if (!url) return undefined;
    const short = ev.kind === 22 || ev.kind === 34236;
    return {
      event: ev, kind: short ? 'short' : 'video', title, description: ev.content, images: [],
      video: { url, poster: httpsOnly(variant.image?.[0]), duration: Number(variant.duration?.[0]) || undefined, ...dims(variant.dim?.[0]) },
    };
  }
  if (ev.kind === 54) {
    const [, url, type] = tag(ev, 'audio') ?? [];
    if (!httpsOnly(url)) return undefined;
    const image = httpsOnly(tagValue(ev, 'image'));
    return { event: ev, kind: 'audio', title, description: tagValue(ev, 'description') ?? ev.content, images: image ? [image] : [], audio: { url: url!, type } };
  }
  if (ev.kind === 1) {
    const urls = ev.content.match(URL_RE) ?? [];
    const text = ev.content.replace(URL_RE, '').trim();
    const video = urls.find((u) => VIDEO.test(u) && !u.endsWith('.m3u8'));
    if (video) return { event: ev, kind: 'video', description: text, images: [], video: { url: video } };
    const audio = urls.find((u) => AUDIO.test(u));
    if (audio) return { event: ev, kind: 'audio', description: text, images: urls.filter((u) => IMAGE.test(u)), audio: { url: audio } };
    const images = urls.filter((u) => IMAGE.test(u));
    if (images.length) return { event: ev, kind: 'photo', description: text, images };
    return { event: ev, kind: 'post', description: ev.content, images: [] };
  }
  return undefined;
}

const hashtags = (text: string) => [...new Set([...text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1].toLowerCase()))].map((t) => ['t', t]);

export function createPhotoPost(nostrKey: Uint8Array, p: { title: string; description: string; images: { url: string; dim?: string; alt?: string; m?: string }[]; created_at?: number }): Event {
  const tags = [
    ['title', p.title],
    ...p.images.map((i) => ['imeta', `url ${i.url}`, `m ${i.m ?? 'image/jpeg'}`, ...(i.dim ? [`dim ${i.dim}`] : []), ...(i.alt ? [`alt ${i.alt}`] : [])]),
    ...hashtags(`${p.title} ${p.description}`),
  ];
  return finalizeEvent({ kind: 20, created_at: p.created_at ?? now(), content: p.description, tags }, nostrKey);
}

export function createVideo(
  nostrKey: Uint8Array,
  v: { short: boolean; title: string; description: string; url: string; m?: string; poster?: string; duration?: number; dim?: string; created_at?: number },
): Event {
  const imeta = ['imeta', `url ${v.url}`, `m ${v.m ?? 'video/mp4'}`];
  if (v.poster) imeta.push(`image ${v.poster}`);
  if (v.duration) imeta.push(`duration ${v.duration.toFixed(3)}`);
  if (v.dim) imeta.push(`dim ${v.dim}`);
  const tags = [['title', v.title], imeta, ['published_at', String(v.created_at ?? now())], ...hashtags(`${v.title} ${v.description}`)];
  return finalizeEvent({ kind: v.short ? 22 : 21, created_at: v.created_at ?? now(), content: v.description, tags }, nostrKey);
}

/** A podcast episode (NIP-F4). The publishing account is the podcast. */
export function createEpisode(nostrKey: Uint8Array, e: { title: string; description: string; audio: string; type?: string; image?: string; created_at?: number }): Event {
  const tags = [['title', e.title], ['description', e.description.slice(0, 500)], ['audio', e.audio, e.type ?? 'audio/mpeg']];
  if (e.image) tags.push(['image', e.image]);
  tags.push(...hashtags(`${e.title} ${e.description}`));
  return finalizeEvent({ kind: 54, created_at: e.created_at ?? now(), content: e.description, tags }, nostrKey);
}

export const formatDuration = (seconds?: number): string | undefined => {
  if (!seconds || !Number.isFinite(seconds)) return undefined;
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
