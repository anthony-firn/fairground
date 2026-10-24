import type { Event } from 'nostr-tools/pure';

export const tag = (ev: Pick<Event, 'tags'>, name: string): string[] | undefined => ev.tags.find((t) => t[0] === name);

export const tagValue = (ev: Pick<Event, 'tags'>, name: string): string | undefined => tag(ev, name)?.[1];

/** The id in an `e` tag carrying the given NIP-10-style marker. */
export const markedEvent = (ev: Pick<Event, 'tags'>, marker: string): string | undefined =>
  ev.tags.find((t) => t[0] === 'e' && t[3] === marker)?.[1];

export const now = (): number => Math.floor(Date.now() / 1000);

/** Oldest first, then by id, so every client picks the same event from a tie. */
export const byTime = (a: Event, b: Event): number => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
