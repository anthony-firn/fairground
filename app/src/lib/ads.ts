/** Ad breaks for what's playing, and the deal data behind them, read from relays. */
import { useEffect, useState } from 'react';
import type { Event } from 'nostr-tools/pure';
import { breaksFor, parsePlacement, type AdBreak, type Placement } from '@core/ads.ts';
import { KIND } from '@core/kinds.ts';
import { parseBreaks } from '@core/podcast.ts';
import { tagValue } from '@core/tags.ts';
import { pqKeys } from './data.ts';
import { query } from './net.ts';

export interface PlacementData {
  placements: Placement[];
  acceptances: Event[];
  approvals: Event[];
}

/** A creator's placements (newest version of each), with the acceptances and approvals that decide if they play. */
export async function loadPlacements(filter: { authors?: string[]; '#p'?: string[]; '#e'?: string[] }): Promise<PlacementData> {
  const events = await query({ kinds: [KIND.placement], ...filter, limit: 500 }, 4000);
  const newest = new Map<string, Placement>();
  for (const ev of events) {
    const p = parsePlacement(ev);
    if (p && (!newest.get(p.address) || newest.get(p.address)!.event.created_at < ev.created_at)) newest.set(p.address, p);
  }
  const placements = [...newest.values()];
  if (!placements.length) return { placements, acceptances: [], approvals: [] };
  const [acceptances, approvals] = await Promise.all([
    query({ ids: [...new Set(placements.map((p) => p.acceptanceId))] }, 4000),
    query({ kinds: [KIND.approval], '#e': placements.map((p) => p.event.id) }, 4000),
  ]);
  return { placements, acceptances, approvals };
}

/** The breaks to play in an episode or video right now. */
export function useAdBreaks(ev: Event | undefined, kind: 'audio' | 'video' | undefined, duration?: number): AdBreak[] {
  const [breaks, setBreaks] = useState<AdBreak[]>([]);
  useEffect(() => {
    if (!ev || !kind) return;
    let cancelled = false;
    (async () => {
      const data = await loadPlacements({ authors: [ev.pubkey] });
      if (!data.placements.length) return;
      const pqKeyOf = await pqKeys(data.placements.map((p) => p.advertiser));
      const media = { creator: ev.pubkey, kind, show: ev.kind === 54 ? tagValue(ev, 'a') : undefined, duration, marks: parseBreaks(ev) };
      if (!cancelled) setBreaks(breaksFor(media, data.placements, { ...data, pqKeyOf }));
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ev, kind, duration]);
  return breaks;
}
