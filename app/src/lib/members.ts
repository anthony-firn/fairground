/**
 * Who is on Fairground. The app shows only Fairground accounts, never the wider Nostr network: an account joins by
 * publishing its key binding, which every account here does on first start. The directory is cached for ten minutes,
 * outside the settings that sync to the account vault.
 */
import { useEffect, useState } from 'react';
import { KIND } from '@core/kinds.ts';
import { membersFrom } from '@core/network.ts';
import { query } from './net.ts';
import { load } from './storage.ts';

const CACHE = 'fg-cache.members';
const TTL = 10 * 60_000;
let members: Set<string> | undefined;
let pending: Promise<Set<string>> | undefined;

const self = (): string | undefined => load<{ binding?: { pubkey?: string } } | null>('account', null)?.binding?.pubkey;

function withSelf(set: Set<string>): Set<string> {
  const me = self();
  if (me) set.add(me);
  return set;
}

export function loadMembers(): Promise<Set<string>> {
  pending ??= (async () => {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE) ?? 'null') as { at: number; list: string[] } | null;
      if (cached && Date.now() - cached.at < TTL) return (members = withSelf(new Set(cached.list)));
    } catch {
      // Fetch it again.
    }
    const found = withSelf(membersFrom(await query({ kinds: [KIND.pqBinding], limit: 5000 }, 5000)));
    // A slow relay can return nothing; keep the last good list rather than emptying the app.
    if (found.size <= 1 && members && members.size > 1) return members;
    try {
      localStorage.setItem(CACHE, JSON.stringify({ at: Date.now(), list: [...found] }));
    } catch {
      // The cache is optional.
    }
    return (members = found);
  })().finally(() => setTimeout(() => (pending = undefined), TTL));
  return pending;
}

/**
 * Makes sure these accounts' membership is known, looking up any the cached directory doesn't have: someone who joined
 * a minute ago can already send an offer, comment or list something.
 */
export async function ensureMembers(pubkeys: string[]): Promise<Set<string>> {
  const known = await loadMembers().catch(() => withSelf(new Set<string>()));
  const unknown = [...new Set(pubkeys)].filter((pk) => /^[0-9a-f]{64}$/.test(pk) && !known.has(pk) && !checked.has(pk));
  if (unknown.length) {
    unknown.forEach((pk) => checked.add(pk));
    for (const pk of membersFrom(await query({ kinds: [KIND.pqBinding], authors: unknown.slice(0, 500) }, 4000).catch(() => []))) known.add(pk);
    members = known;
  }
  return known;
}
const checked = new Set<string>();

/** The directory, plus membership of these accounts, re-checked when the list changes. */
export function useMembership(pubkeys: string[]): Set<string> | null {
  const [set, setSet] = useState<Set<string> | null>(members ?? null);
  const key = [...new Set(pubkeys)].sort().join();
  useEffect(() => {
    ensureMembers(key ? key.split(',') : []).then((m) => setSet(new Set(m)), () => undefined);
  }, [key]);
  return set;
}

/** Whether an account is on Fairground, once the directory has loaded. */
export const isMember = (pubkey: string): boolean => pubkey === self() || !!members?.has(pubkey);

export function useMembers(): Set<string> | null {
  const [set, setSet] = useState<Set<string> | null>(members ?? null);
  useEffect(() => {
    loadMembers().then((m) => setSet(new Set(m)), () => setSet(withSelf(new Set())));
  }, []);
  return set;
}

/** Splits a member list into relay-sized `authors` filters. */
export const authorChunks = (list: Iterable<string>, size = 700): string[][] => {
  const all = [...list];
  return Array.from({ length: Math.ceil(all.length / size) }, (_, i) => all.slice(i * size, (i + 1) * size));
};
