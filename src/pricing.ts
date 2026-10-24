/**
 * Prices that hold their purchasing power.
 *
 * An offer states its price in dollars of a base month and names a cost-of-living index. At payment the amount is
 * scaled by index(payment month) / index(base month), so a long-running or late-paid deal still buys the creator what
 * it would have when it was agreed. Payment never falls below the nominal amount, so deflation doesn't cost creators.
 *
 * Index values reach clients as signed attestations from publishers the client trusts; a value counts only when enough
 * of them agree and none disagree.
 *
 * Amounts are integers in micro-dollars, which is also one USDC base unit. Index values are integers in thousandths.
 */
import type { Event } from 'nostr-tools/pure';
import { KIND } from './kinds.ts';
import { signHybrid, verifyHybrid, type KeyLookup, type PqKeys } from './pq.ts';
import { now, tagValue } from './tags.ts';

/** US CPI-U, not seasonally adjusted (BLS series CUUR0000SA0). That series is never revised once published. */
export const DEFAULT_INDEX = 'us-cpi-u';
/** No indexing: the nominal amount is owed. For when no trusted index values are available yet. */
export const FIXED_INDEX = 'fixed';
export const MICROS_PER_USD = 1_000_000n;

export interface IndexedPrice {
  /** Micro-dollars in `basePeriod` money. */
  amount: bigint;
  currency: 'USD';
  index: string;
  /** `YYYY-MM`. */
  basePeriod: string;
}

export const isPeriod = (s: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

/** `"500"` or `"500.25"` to micro-dollars. */
export function parseUsd(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s.trim());
  if (!m) throw new Error(`not a dollar amount: ${s}`);
  return BigInt(m[1]) * MICROS_PER_USD + BigInt((m[2] ?? '').padEnd(6, '0'));
}

/** Micro-dollars to `"500.00"`, keeping any sub-cent digits rather than hiding them. */
export function formatUsd(micros: bigint): string {
  const whole = micros / MICROS_PER_USD;
  const frac = (micros % MICROS_PER_USD).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${whole}.${frac}`;
}

export function parseIndexValue(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) throw new Error(`not an index value: ${s}`);
  const value = BigInt(m[1]) * 1000n + BigInt((m[2] ?? '').padEnd(3, '0'));
  if (value === 0n) throw new Error('index value must be positive');
  return value;
}

/** The amount owed when the index stands at `current`, rounded up in the creator's favour and never below nominal. */
export function indexedAmount(price: IndexedPrice, base: bigint, current: bigint): bigint {
  const scaled = (price.amount * current + base - 1n) / base;
  return scaled > price.amount ? scaled : price.amount;
}

export interface IndexReading {
  index: string;
  period: string;
  /** Decimal string as published, e.g. `"324.368"`. */
  value: string;
  /** Where the publisher read it. */
  source: string;
}

export function createIndexAttestation(nostrKey: Uint8Array, pq: PqKeys, reading: IndexReading, created_at = now()): Event {
  if (!isPeriod(reading.period)) throw new Error(`not a period: ${reading.period}`);
  parseIndexValue(reading.value);
  const tags = [['index', reading.index], ['period', reading.period], ['value', reading.value], ['r', reading.source]];
  return signHybrid({ kind: KIND.indexValue, created_at, content: '', tags }, nostrKey, pq);
}

export interface IndexPolicy {
  index: string;
  /** Nostr pubkeys of the publishers this client trusts. */
  publishers: string[];
  /** How many of them must agree. */
  threshold: number;
}

/** Each trusted publisher's value for `period`, published no later than `before`; a self-contradicting publisher is dropped. */
function readings(attestations: Event[], policy: IndexPolicy, period: string, pqKeyOf: KeyLookup, before: number) {
  const values = new Map<string, bigint | null>();
  for (const ev of attestations) {
    if (ev.kind !== KIND.indexValue || ev.created_at > before || !policy.publishers.includes(ev.pubkey)) continue;
    if (tagValue(ev, 'index') !== policy.index || tagValue(ev, 'period') !== period) continue;
    const key = pqKeyOf(ev.pubkey);
    if (!key || !verifyHybrid(ev, key)) continue;
    let value: bigint;
    try {
      value = parseIndexValue(tagValue(ev, 'value') ?? '');
    } catch {
      continue;
    }
    const prior = values.get(ev.pubkey);
    values.set(ev.pubkey, prior === undefined || prior === value ? value : null);
  }
  return values;
}

/** The value at least `threshold` trusted publishers attest for `period`, or undefined if too few agree or any disagree. */
export function resolveIndexValue(
  attestations: Event[],
  policy: IndexPolicy,
  period: string,
  pqKeyOf: KeyLookup,
  before = Number.MAX_SAFE_INTEGER,
): bigint | undefined {
  const values = [...readings(attestations, policy, period, pqKeyOf, before).values()];
  if (values.includes(null)) return undefined;
  const distinct = new Set(values);
  if (distinct.size !== 1 || values.length < policy.threshold) return undefined;
  return values[0] ?? undefined;
}

/** Resolved periods, newest first, counting only attestations published no later than `before`. */
export function resolvedPeriods(
  attestations: Event[],
  policy: IndexPolicy,
  pqKeyOf: KeyLookup,
  before = Number.MAX_SAFE_INTEGER,
): string[] {
  const periods = new Set<string>();
  for (const ev of attestations) {
    const period = tagValue(ev, 'period');
    if (ev.kind === KIND.indexValue && period && isPeriod(period)) periods.add(period);
  }
  return [...periods]
    .filter((p) => resolveIndexValue(attestations, policy, p, pqKeyOf, before) !== undefined)
    .sort()
    .reverse();
}
