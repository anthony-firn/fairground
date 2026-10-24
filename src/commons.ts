/**
 * The commons loop.
 *
 * Creators may share a little of what they earn with Fairground's development and with the relays that carry their
 * work. Anyone can run a relay and receive that share, and relay operators can pledge to pass part of it on to
 * creators, who may donate some of it back to relays. Every hop is a direct, public payment with its own memo.
 *
 * The loop is damped on purpose, so running relays only to collect donations never pays for the power they use:
 * - A relay is credited only for events it delivered first to a reader who actually saw them. A relay nobody reads
 *   from, or one that only copies what others already delivered, earns nothing.
 * - Credit is linear and grouped by operator, so running more relays or splitting into several identities gains
 *   nothing.
 * - Each hop passes on a small share. With the suggested settings a round trip carries about 0.2% of what went in: an
 *   undercurrent that can only shrink.
 */
import type { Event } from 'nostr-tools/pure';
import { KIND } from './kinds.ts';
import { MEMO, normalizeRelayUrl } from './memos.ts';
import { signHybrid, verifyHybrid, type KeyLookup, type PqKeys } from './pq.ts';
import type { Rail, Transfer } from './rails/rail.ts';
import { periodBounds, previousPeriod } from './support.ts';
import { byTime, now, tag, tagValue } from './tags.ts';

/** Suggested share of a donation for development; the rest goes to relays. */
export const DEFAULT_DEVELOPMENT_PERCENT = 50;
/** Suggested share of relay donations a relay passes on to creators. */
export const SUGGESTED_PASS_ON_PERCENT = 20;

export interface RelayPayoutInput {
  relays: string[];
  rail: string;
  payTo: string;
  /** Percent of the relay donations received each month that the operator pledges to pass on to creators. */
  passOn: number;
  message?: string;
  created_at?: number;
}

export interface RelayPayout extends Omit<RelayPayoutInput, 'created_at' | 'message'> {
  event: Event;
  operator: string;
  message: string;
}

const validPercent = (n: number) => Number.isInteger(n) && n >= 0 && n <= 100;

/** Replaceable: an operator has one payout for all their relays, and the newest one is in force. */
export function createRelayPayout(nostrKey: Uint8Array, pq: PqKeys, p: RelayPayoutInput): Event {
  if (!validPercent(p.passOn)) throw new Error('pass-on must be a whole percent from 0 to 100');
  const tags = [...p.relays.map((r) => ['r', normalizeRelayUrl(r)]), ['payto', p.rail, p.payTo], ['passon', String(p.passOn)]];
  return signHybrid({ kind: KIND.relayPayout, created_at: p.created_at ?? now(), content: p.message ?? '', tags }, nostrKey, pq);
}

export function parseRelayPayout(ev: Event, pqKeyOf: KeyLookup): RelayPayout | undefined {
  const key = pqKeyOf(ev.pubkey);
  if (ev.kind !== KIND.relayPayout || !key || !verifyHybrid(ev, key)) return undefined;
  const [, rail, payTo] = tag(ev, 'payto') ?? [];
  const passOn = Number(tagValue(ev, 'passon'));
  let relays: string[];
  try {
    relays = [...new Set(ev.tags.filter((t) => t[0] === 'r').map((t) => normalizeRelayUrl(t[1])))];
  } catch {
    return undefined;
  }
  if (!rail || !payTo || !relays.length || !validPercent(passOn)) return undefined;
  return { event: ev, operator: ev.pubkey, relays, rail, payTo, passOn, message: ev.content };
}

/** The operator pubkey a relay names in its NIP-11 information document. */
export async function fetchRelayOperator(url: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<string | undefined> {
  const http = normalizeRelayUrl(url).replace(/^ws/, 'http');
  try {
    const res = await fetchImpl(http, { headers: { Accept: 'application/nostr+json' } });
    const info = (await res.json()) as { pubkey?: unknown };
    return typeof info.pubkey === 'string' && /^[0-9a-f]{64}$/.test(info.pubkey) ? info.pubkey : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The payout in force for each relay, kept only where the relay's own information document names the payout's
 * author, so nobody can claim donations for a relay they don't run.
 */
export async function verifiedRelayPayouts(
  payouts: RelayPayout[],
  operatorOf: (url: string) => Promise<string | undefined>,
): Promise<Map<string, RelayPayout>> {
  const newest = new Map<string, RelayPayout>();
  for (const p of [...payouts].sort((a, b) => byTime(a.event, b.event))) newest.set(p.operator, p);
  const result = new Map<string, RelayPayout>();
  for (const payout of newest.values()) {
    for (const relay of payout.relays) {
      if ((await operatorOf(relay)) === payout.operator) result.set(relay, payout);
    }
  }
  return result;
}

export interface Delivery {
  relay: string;
  eventId: string;
}

/** Credits each event the reader saw to the relay that delivered it first. `deliveries` must be in arrival order. */
export function creditRelays(deliveries: Delivery[], seen: Set<string>): Map<string, number> {
  const first = new Map<string, string>();
  for (const d of deliveries) if (!first.has(d.eventId)) first.set(d.eventId, normalizeRelayUrl(d.relay));
  const credits = new Map<string, number>();
  for (const id of seen) {
    const relay = first.get(id);
    if (relay) credits.set(relay, (credits.get(relay) ?? 0) + 1);
  }
  return credits;
}

export interface OperatorShare {
  payout: RelayPayout;
  weight: number;
}

/** Sums relay credits per operator, counting only relays with a verified payout. */
export function operatorWeights(credits: Map<string, number>, payouts: Map<string, RelayPayout>): Map<string, OperatorShare> {
  const shares = new Map<string, OperatorShare>();
  for (const [relay, weight] of credits) {
    const payout = payouts.get(relay);
    if (!payout || weight <= 0) continue;
    const share = shares.get(payout.operator) ?? { payout, weight: 0 };
    share.weight += weight;
    shares.set(payout.operator, share);
  }
  return shares;
}

/**
 * Which operator receives this donation's relay share: the one furthest below its fair share of everything this
 * donor has given to relays. Over many donations each operator receives in proportion to the service it gave.
 */
export function chooseRecipient(weights: Map<string, number>, given: Map<string, bigint>, amount: bigint): string | undefined {
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) return undefined;
  const pool = Number([...given.values()].reduce((a, b) => a + b, 0n) + amount);
  let best: string | undefined;
  let bestDeficit = -Infinity;
  for (const [key, weight] of [...weights].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const deficit = (weight / total) * pool - Number(given.get(key) ?? 0n);
    if (deficit > bestDeficit) [best, bestDeficit] = [key, deficit];
  }
  return best;
}

/** Splits a donation between development and relays; everything goes to development when no relay can receive. */
export function splitDonation(amount: bigint, developmentPercent: number, relaysCanReceive: boolean) {
  if (!validPercent(developmentPercent)) throw new Error('development share must be a whole percent from 0 to 100');
  const development = relaysCanReceive ? (amount * BigInt(developmentPercent)) / 100n : amount;
  return { development, relays: amount - development };
}

/** Splits an amount by weight in whole cents, giving leftover cents to the largest remainders. */
export function splitByWeight(amount: bigint, weights: Map<string, number>): Map<string, bigint> {
  const CENT = 10_000n;
  const entries = [...weights].filter(([, w]) => w > 0).sort(([a], [b]) => (a < b ? -1 : 1));
  const total = entries.reduce((s, [, w]) => s + w, 0);
  const cents = Number(amount / CENT);
  const result = new Map<string, bigint>();
  if (!entries.length || total <= 0) return result;
  const exact = entries.map(([key, w]) => ({ key, share: (cents * w) / total }));
  let left = cents - exact.reduce((s, e) => s + Math.floor(e.share), 0);
  for (const e of [...exact].sort((a, b) => (b.share % 1) - (a.share % 1))) {
    const extra = left-- > 0 ? 1 : 0;
    result.set(e.key, BigInt(Math.floor(e.share) + extra) * CENT);
  }
  return result;
}

export interface PassOnStatus {
  /** Relay donations received in the previous month. */
  received: bigint;
  /** The pledged share of them. */
  due: bigint;
  /** Support the operator sent to other creators this month. */
  paid: bigint;
  kept: boolean;
}

const sum = (transfers: Transfer[]) => transfers.reduce((total, t) => total + t.amount, 0n);

/**
 * Whether a relay operator passed on their pledged share this month of what their relays received last month.
 * Support sent to the operator's own creator account, or to their own address, doesn't count.
 */
export async function passOnStatus(payout: RelayPayout, rail: Rail, period: string): Promise<PassOnStatus> {
  const [lastFrom, lastTo] = periodBounds(previousPeriod(period));
  const [from, to] = periodBounds(period);
  const memos = new Set(payout.relays.map((r) => MEMO.relay(r)));
  const incoming = await rail.listTransfers({ address: payout.payTo, role: 'receiver', notePrefix: MEMO.relayPrefix, from: lastFrom, to: lastTo });
  const outgoing = await rail.listTransfers({ address: payout.payTo, role: 'sender', notePrefix: MEMO.supportPrefix, from, to });
  const received = sum(incoming.filter((t) => memos.has(t.note)));
  const due = (received * BigInt(payout.passOn)) / 100n;
  const paid = sum(outgoing.filter((t) => t.note !== MEMO.support(payout.operator) && t.receiver !== payout.payTo));
  return { received, due, paid, kept: paid >= due };
}
