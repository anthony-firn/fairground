/** Shared lookups: other accounts' post-quantum keys, the cost-of-living index, and prices in today's dollars. */
import { useEffect, useState } from 'react';
import { finalizeEvent, type Event } from 'nostr-tools/pure';
import { DEFAULT_INDEX_POLICY } from '@core/defaults.ts';
import { KIND } from '@core/kinds.ts';
import { keyLookup, type KeyLookup } from '@core/pq.ts';
import { FIXED_INDEX, indexedAmount, resolvedPeriods, resolveIndexValue, type IndexedPrice } from '@core/pricing.ts';
import type { Account } from './account.ts';
import { publish, query, relays } from './net.ts';
import { load, save } from './storage.ts';

const bindings = new Map<string, Event[]>();

/** Fetches the key bindings of these accounts (once each) and returns a lookup over everything seen so far. */
export async function pqKeys(pubkeys: string[]): Promise<KeyLookup> {
  const missing = [...new Set(pubkeys)].filter((pk) => !bindings.has(pk));
  if (missing.length) {
    const found = await query({ kinds: [KIND.pqBinding], authors: missing }, 3000);
    for (const pk of missing) bindings.set(pk, found.filter((e) => e.pubkey === pk));
  }
  return keyLookup([...bindings.values()].flat());
}

export function rememberBinding(binding: Event): void {
  bindings.set(binding.pubkey, [...(bindings.get(binding.pubkey) ?? []), binding]);
}

export interface IndexState {
  attestations: Event[];
  pqKeyOf: KeyLookup;
  /** The newest period trusted publishers agree on, if any. */
  latest?: string;
  value(period: string): bigint | undefined;
}

let indexCache: Promise<IndexState> | undefined;

export function loadIndex(): Promise<IndexState> {
  indexCache ??= (async () => {
    const policy = DEFAULT_INDEX_POLICY;
    const [attestations, pqKeyOf] = await Promise.all([
      query({ kinds: [KIND.indexValue], authors: policy.publishers }, 4000),
      pqKeys(policy.publishers),
    ]);
    const latest = resolvedPeriods(attestations, policy, pqKeyOf)[0];
    return { attestations, pqKeyOf, latest, value: (p) => resolveIndexValue(attestations, policy, p, pqKeyOf) };
  })();
  return indexCache;
}

export function useIndex(): IndexState | undefined {
  const [state, setState] = useState<IndexState>();
  useEffect(() => {
    loadIndex().then(setState, () => undefined);
  }, []);
  return state;
}

/** A new price in today's dollars: indexed when the index is available, fixed otherwise. */
export function newPrice(amount: bigint, index: IndexState | undefined): IndexedPrice {
  const month = new Date().toISOString().slice(0, 7);
  return index?.latest
    ? { amount, currency: 'USD', index: DEFAULT_INDEX_POLICY.index, basePeriod: index.latest }
    : { amount, currency: 'USD', index: FIXED_INDEX, basePeriod: month };
}

/** What a price is worth now, with the index period it was computed at (for receipts). */
export function priceNow(price: IndexedPrice, index: IndexState | undefined): { amount: bigint; period: string } {
  if (price.index === FIXED_INDEX || !index?.latest) return { amount: price.amount, period: price.basePeriod };
  const base = index.value(price.basePeriod);
  const current = index.value(index.latest);
  if (base === undefined || current === undefined) return { amount: price.amount, period: price.basePeriod };
  return { amount: indexedAmount(price, base, current), period: index.latest };
}

export const payoutAddress = (): string => load<string>('payTo', '');

/** Publishes the account's post-quantum key binding and relay list once per device. */
export async function announce(account: Account): Promise<void> {
  rememberBinding(account.binding);
  if (load<string>('announced', '') === account.binding.id) return;
  await publish(account.binding);
  const relayList = finalizeEvent({ kind: 10002, created_at: Math.floor(Date.now() / 1000), content: '', tags: relays().map((r) => ['r', r]) }, account.nostrKey);
  await publish(relayList).catch(() => undefined);
  save('announced', account.binding.id);
}
