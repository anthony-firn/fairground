import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Filter } from 'nostr-tools/filter';
import type { Event } from 'nostr-tools/pure';
import { query, subscribe } from './net.ts';

export interface Profile {
  name?: string;
  display_name?: string;
  about?: string;
  picture?: string;
  /** NIP-24: the account says it's automated. */
  bot?: boolean;
  created_at: number;
}

const profiles = new Map<string, Profile>();
const wanted = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function notify() {
  version++;
  listeners.forEach((l) => l());
}

export function rememberProfile(ev: Event): void {
  if (ev.kind !== 0) return;
  const known = profiles.get(ev.pubkey);
  if (known && known.created_at >= ev.created_at) return;
  try {
    const p = JSON.parse(ev.content) as Partial<Profile>;
    profiles.set(ev.pubkey, {
      name: typeof p.name === 'string' ? p.name.slice(0, 80) : undefined,
      display_name: typeof p.display_name === 'string' ? p.display_name.slice(0, 80) : undefined,
      about: typeof p.about === 'string' ? p.about.slice(0, 2000) : undefined,
      picture: typeof p.picture === 'string' && /^https:\/\//.test(p.picture) ? p.picture : undefined,
      bot: p.bot === true,
      created_at: ev.created_at,
    });
    notify();
  } catch {
    // Unreadable profiles are ignored.
  }
}

/** Fetches profiles in batches, so a screen full of posts makes one request rather than one per author. */
export function requestProfiles(pubkeys: Iterable<string>): void {
  for (const pk of pubkeys) if (!profiles.has(pk)) wanted.add(pk);
  if (timer || !wanted.size) return;
  timer = setTimeout(async () => {
    const batch = [...wanted].slice(0, 150);
    batch.forEach((pk) => wanted.delete(pk));
    timer = undefined;
    (await query({ kinds: [0], authors: batch })).forEach(rememberProfile);
    if (wanted.size) requestProfiles([]);
  }, 200);
}

export const getProfile = (pubkey: string): Profile | undefined => profiles.get(pubkey);

export function useProfile(pubkey: string | undefined): Profile | undefined {
  useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => version);
  useEffect(() => {
    if (pubkey) requestProfiles([pubkey]);
  }, [pubkey]);
  return pubkey ? profiles.get(pubkey) : undefined;
}

/** Events matching a filter, newest first, kept up to date while the component is mounted. */
export function useEvents(filter: Filter | null): { events: Event[]; loading: boolean } {
  const key = filter ? JSON.stringify(filter) : '';
  const [state, setState] = useState<{ key: string; events: Event[]; loading: boolean }>({ key, events: [], loading: !!filter });
  useEffect(() => {
    if (!filter) return;
    const seen = new Map<string, Event>();
    let flush: ReturnType<typeof setTimeout> | undefined;
    const update = (loading: boolean) => setState({ key, events: [...seen.values()].sort((a, b) => b.created_at - a.created_at), loading });
    setState({ key, events: [], loading: true });
    const close = subscribe(filter, (ev) => {
      seen.set(ev.id, ev);
      clearTimeout(flush);
      flush = setTimeout(() => update(false), 100);
    }, () => update(false));
    const giveUp = setTimeout(() => update(false), 5000);
    return () => {
      close();
      clearTimeout(flush);
      clearTimeout(giveUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state : { events: [], loading: !!filter };
}
