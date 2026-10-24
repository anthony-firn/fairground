/**
 * Fan support: paying a creator for their work rather than for ads.
 *
 * A creator publishes one support page with a suggested monthly amount, an optional monthly goal, and optionally an
 * ad-free pledge: after any month in which supporters meet the goal, the creator accepts no sponsorships the next month.
 * Supporters pay the creator's wallet directly with the memo `MEMO.support(creator)` and stay anonymous; nothing links
 * the payment to their Nostr account.
 * Anyone can total a month's support from the chain and check whether the pledge was kept.
 */
import { verifyEvent, type Event } from 'nostr-tools/pure';
import { KIND } from './kinds.ts';
import { signHybrid, verifyHybrid, type KeyLookup, type PqKeys } from './pq.ts';
import { isPeriod, type IndexedPrice } from './pricing.ts';
import { MEMO } from './memos.ts';
import type { Rail, Transfer } from './rails/rail.ts';
import { now, tag, tagValue } from './tags.ts';

export interface SupportPageInput {
  title: string;
  /** What support pays for, in the creator's words. */
  pitch: string;
  /** Suggested amount per month, indexed like sponsorship prices. */
  suggested: IndexedPrice;
  /** Monthly goal in the same base-period dollars as `suggested`. */
  goal?: bigint;
  rail: string;
  payTo: string;
  adFree: boolean;
  created_at?: number;
}

export interface SupportPage extends Omit<SupportPageInput, 'created_at'> {
  event: Event;
  creator: string;
}

/** Replaceable: a creator has one support page, and the newest version is the one in force. */
export function createSupportPage(nostrKey: Uint8Array, pq: PqKeys, p: SupportPageInput): Event {
  const { amount, currency, index, basePeriod } = p.suggested;
  const tags = [
    ['title', p.title],
    ['price', amount.toString(), currency, index, basePeriod],
    ['payto', p.rail, p.payTo],
  ];
  if (p.goal !== undefined) tags.push(['goal', p.goal.toString()]);
  if (p.adFree) tags.push(['adfree', 'after-goal']);
  return signHybrid({ kind: KIND.supportPage, created_at: p.created_at ?? now(), content: p.pitch, tags }, nostrKey, pq);
}

export function parseSupportPage(ev: Event, pqKeyOf: KeyLookup): SupportPage | undefined {
  const key = pqKeyOf(ev.pubkey);
  if (ev.kind !== KIND.supportPage || !key || !verifyHybrid(ev, key)) return undefined;
  const [, amount = '', currency, index, basePeriod = ''] = tag(ev, 'price') ?? [];
  const [, rail, payTo] = tag(ev, 'payto') ?? [];
  const title = tagValue(ev, 'title');
  const goal = tagValue(ev, 'goal');
  if (!title || !rail || !payTo || !index || currency !== 'USD' || !isPeriod(basePeriod)) return undefined;
  if (!/^[1-9]\d*$/.test(amount) || (goal !== undefined && !/^[1-9]\d*$/.test(goal))) return undefined;
  return {
    event: ev,
    creator: ev.pubkey,
    title,
    pitch: ev.content,
    suggested: { amount: BigInt(amount), currency, index, basePeriod },
    goal: goal === undefined ? undefined : BigInt(goal),
    rail,
    payTo,
    adFree: tagValue(ev, 'adfree') === 'after-goal',
  };
}

/** Unix-second bounds of a `YYYY-MM` period in UTC: [start, end). */
export function periodBounds(period: string): [number, number] {
  if (!isPeriod(period)) throw new Error(`not a period: ${period}`);
  const [y, m] = period.split('-').map(Number);
  return [Date.UTC(y, m - 1, 1) / 1000, Date.UTC(y, m, 1) / 1000];
}

export function nextPeriod(period: string): string {
  const [, end] = periodBounds(period);
  return new Date(end * 1000).toISOString().slice(0, 7);
}

export function previousPeriod(period: string): string {
  const [start] = periodBounds(period);
  return new Date((start - 1) * 1000).toISOString().slice(0, 7);
}

/** The `YYYY-MM` period, in UTC, containing a Unix time. */
export const periodOf = (unix: number): string => new Date(unix * 1000).toISOString().slice(0, 7);

export function fetchSupport(page: SupportPage, rail: Rail, period: string): Promise<Transfer[]> {
  const [from, to] = periodBounds(period);
  return rail.listTransfers({ address: page.payTo, role: 'receiver', notePrefix: MEMO.support(page.creator), from, to });
}

export interface MonthSupport {
  period: string;
  total: bigint;
  /** Distinct paying addresses. One person can use several, so this is an upper bound on people. */
  supporters: number;
  goalMet: boolean;
}

/** `goal` is the month's goal after indexing; omit it when the page has none. */
export function monthSupport(period: string, transfers: Transfer[], goal?: bigint): MonthSupport {
  const total = transfers.reduce((sum, t) => sum + t.amount, 0n);
  return { period, total, supporters: new Set(transfers.map((t) => t.sender)).size, goalMet: goal !== undefined && total >= goal };
}

/** Months in which the creator accepted a sponsorship although supporters met the goal the month before. */
export function brokenPledges(page: SupportPage, months: MonthSupport[], acceptances: Event[]): string[] {
  if (!page.adFree) return [];
  const pledged = new Set(months.filter((m) => m.goalMet).map((m) => nextPeriod(m.period)));
  const broken = new Set<string>();
  for (const acc of acceptances) {
    if (acc.kind !== KIND.acceptance || acc.pubkey !== page.creator || !verifyEvent(acc)) continue;
    const period = periodOf(acc.created_at);
    if (pledged.has(period)) broken.add(period);
  }
  return [...broken].sort();
}
