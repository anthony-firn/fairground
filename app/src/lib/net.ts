/**
 * The relay connection. It also remembers which relay delivered each post first, so donations reach the relays that
 * actually served the reader (see commons.ts).
 */
import type { Filter } from 'nostr-tools/filter';
import { SimplePool } from 'nostr-tools/pool';
import type { Event } from 'nostr-tools/pure';
import { DEFAULT_RELAYS } from '@core/defaults.ts';
import { normalizeRelayUrl } from '@core/memos.ts';
import { periodOf } from '@core/support.ts';
import { load, save } from './storage.ts';

export const pool = new SimplePool();

/** `?relay=ws://localhost:7777` (repeatable) points the app at other relays, e.g. the dev relay. */
const override = new URLSearchParams(location.search).getAll('relay');

export function relays(): string[] {
  return override.length ? override : load<string[]>('relays', DEFAULT_RELAYS);
}

export function setRelays(urls: string[]): void {
  save('relays', [...new Set(urls.map(normalizeRelayUrl))]);
}

/** Test builds (VITE_READONLY=1) read real relays without writing anything to them. */
const READ_ONLY = import.meta.env.VITE_READONLY === '1';

export async function publish(ev: Event): Promise<number> {
  if (READ_ONLY) return relays().length;
  const results = await Promise.allSettled(pool.publish(relays(), ev));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  if (!ok) throw new Error('No relay accepted it. Check your connection and try again.');
  return ok;
}

export const query = (filter: Filter, maxWait = 4000): Promise<Event[]> => pool.querySync(relays(), filter, { maxWait });

export function subscribe(filter: Filter, onevent: (ev: Event) => void, oneose?: () => void): () => void {
  const sub = pool.subscribeMany(relays(), filter, { onevent, oneose });
  return () => sub.close();
}

const firstRelay = new Map<string, string>();
const credited = new Set<string>();

/** Subscribes on each relay separately, so every event is attributed to the relay that delivered it first. */
export function subscribeAttributed(filter: Filter, onevent: (ev: Event) => void, oneose?: () => void): () => void {
  let pending = relays().length;
  const subs = relays().map((url) => pool.subscribeMany([url], filter, {
    onevent(ev) {
      if (!firstRelay.has(ev.id)) firstRelay.set(ev.id, normalizeRelayUrl(url));
      onevent(ev);
    },
    oneose() {
      if (--pending === 0) oneose?.();
    },
  }));
  return () => subs.forEach((s) => s.close());
}

type Credits = Record<string, Record<string, number>>;

/** Called when the reader actually saw a post: credits the relay that delivered it first, once. */
export function markSeen(eventId: string): void {
  const relay = firstRelay.get(eventId);
  if (!relay || credited.has(eventId)) return;
  credited.add(eventId);
  const credits = load<Credits>('credits', {});
  const month = periodOf(Math.floor(Date.now() / 1000));
  credits[month] = { ...credits[month], [relay]: (credits[month]?.[relay] ?? 0) + 1 };
  save('credits', credits);
}

/** Relay credits for the current and previous month, which donations are weighted by. */
export function recentCredits(): Map<string, number> {
  const credits = load<Credits>('credits', {});
  const months = Object.keys(credits).sort().slice(-2);
  const total = new Map<string, number>();
  for (const m of months) for (const [relay, n] of Object.entries(credits[m])) total.set(relay, (total.get(relay) ?? 0) + n);
  return total;
}
