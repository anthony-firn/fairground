/**
 * The feed for one media format (photos, videos, shorts or listening). Same sources, safety rules and ranking as the
 * home feed: people the reader follows and the starting network, through allowed(), ranked by the reader's recipe.
 */
import { useEffect, useRef, useState } from 'react';
import type { Event } from 'nostr-tools/pure';
import { rankFeed } from '@core/feed.ts';
import { MEDIA_KINDS, toMedia, type MediaItem, type MediaKind } from '@core/media.ts';
import { repeats } from '@core/safety.ts';
import { currentRecipe } from './feedEngine.ts';
import { rememberProfile } from './hooks.ts';
import { query, subscribeAttributed } from './net.ts';
import { allowed, loadNetwork, safetySettings } from './safety.ts';
import { load } from './storage.ts';

export function useMediaFeed(kind: Exclude<MediaKind, 'post'>, recipeVersion: number): { items: MediaItem[]; ready: boolean } {
  const events = useRef(new Map<string, Event>());
  const [items, setItems] = useState<MediaItem[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    events.current.clear();
    setReady(false);
    const closers: (() => void)[] = [];
    (async () => {
      const network = await loadNetwork().catch(() => new Set<string>());
      const settings = safetySettings();
      const follows = new Set(load<string[]>('follows', []));
      const kinds = [...MEDIA_KINDS[kind], 1];
      const add = (ev: Event) => events.current.set(ev.id, ev);
      if (settings.unvetted || !network.size) closers.push(subscribeAttributed({ kinds, limit: 300 }, add));
      else {
        const members = [...new Set([...follows, ...network])];
        for (let i = 0; i < members.length; i += 700) closers.push(subscribeAttributed({ kinds, authors: members.slice(i, i + 700), limit: 120 }, add));
      }
      await new Promise((r) => setTimeout(r, 1800));
      const authors = [...new Set([...events.current.values()].map((e) => e.pubkey))].slice(0, 300);
      (await query({ kinds: [0], authors }, 2500)).forEach(rememberProfile);
      if (cancelled) return;
      const all = [...events.current.values()];
      const repeated = repeats(all);
      const candidates = all.filter((ev) => {
        if (repeated.has(ev.id) || ev.tags.some((t) => t[0] === 'e' && (!t[3] || t[3] === 'reply' || t[3] === 'root'))) return false;
        const known = follows.has(ev.pubkey);
        if (!allowed(ev, settings, known)) return false;
        if (!known && !settings.unvetted && network.size && !network.has(ev.pubkey)) return false;
        return toMedia(ev)?.kind === kind;
      });
      const ranked = rankFeed(candidates, { ...currentRecipe(), sources: { follows: true, trusted: true, everyone: true, topics: [] } }, {
        now: Math.floor(Date.now() / 1000), follows, trust: new Map([...network].map((pk) => [pk, 0.5])), muted: new Set(load<string[]>('muted', [])), engagement: new Map(),
      });
      setItems(ranked.map((r) => toMedia(r.event)!).slice(0, 120));
      setReady(true);
    })();
    return () => {
      cancelled = true;
      closers.forEach((c) => c());
    };
  }, [kind, recipeVersion]);

  return { items, ready };
}
