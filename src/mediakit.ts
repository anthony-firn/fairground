/**
 * Media kits and the sponsor directory: how creators and advertisers find each other without a marketplace operator.
 *
 * A creator who is open to sponsorships publishes a media kit: their rate per post (indexed like any price), their
 * topics, and optionally their audience survey. An advertiser's public record is built from the deals they have
 * already done, so creators can see who pays before they accept. Anyone can be either: a creator sponsoring another
 * creator is a cross-promo.
 */
import type { Event } from 'nostr-tools/pure';
import { KIND } from './kinds.ts';
import { signHybrid, verifyHybrid, type KeyLookup, type PqKeys } from './pq.ts';
import { isPeriod, type IndexedPrice } from './pricing.ts';
import { advertiserRecord, type AdvertiserRecord } from './reputation.ts';
import { markedEvent, now, tag, tagValue } from './tags.ts';

export const MEDIA_KIT_D = 'media-kit';

/** What a creator offers sponsors: written posts, host-read ads in their podcast, or in their videos. */
export type KitFormat = 'post' | 'podcast' | 'video';

export interface MediaKitInput {
  pitch: string;
  /** Rate per sponsored post. */
  rate: IndexedPrice;
  topics: string[];
  /** The creator's audience survey, if they have one. */
  survey?: string;
  formats?: KitFormat[];
  /** Typical listens or views per episode or post, as the creator reports it. */
  audience?: number;
  /** Price per thousand for host-read ads, micro-dollars. */
  cpm?: bigint;
  created_at?: number;
}

export interface MediaKit extends Omit<MediaKitInput, 'created_at'> {
  event: Event;
  creator: string;
}

export function createMediaKit(nostrKey: Uint8Array, pq: PqKeys, k: MediaKitInput): Event {
  const { amount, currency, index, basePeriod } = k.rate;
  const tags = [
    ['d', MEDIA_KIT_D],
    ['price', amount.toString(), currency, index, basePeriod],
    ...k.topics.map((t) => ['t', t.toLowerCase()]),
  ];
  if (k.survey) tags.push(['e', k.survey, '', 'survey']);
  for (const f of k.formats ?? []) tags.push(['format', f]);
  if (k.audience) tags.push(['audience', String(Math.round(k.audience))]);
  if (k.cpm) tags.push(['cpm', k.cpm.toString()]);
  return signHybrid({ kind: KIND.mediaKit, created_at: k.created_at ?? now(), content: k.pitch, tags }, nostrKey, pq);
}

export function parseMediaKit(ev: Event, pqKeyOf: KeyLookup): MediaKit | undefined {
  const key = pqKeyOf(ev.pubkey);
  if (ev.kind !== KIND.mediaKit || tagValue(ev, 'd') !== MEDIA_KIT_D || !key || !verifyHybrid(ev, key)) return undefined;
  const [, amount = '', currency, index, basePeriod = ''] = tag(ev, 'price') ?? [];
  if (!/^[1-9]\d*$/.test(amount) || currency !== 'USD' || !index || !isPeriod(basePeriod)) return undefined;
  return {
    event: ev,
    creator: ev.pubkey,
    pitch: ev.content,
    rate: { amount: BigInt(amount), currency, index, basePeriod },
    topics: ev.tags.filter((t) => t[0] === 't' && t[1]).map((t) => t[1]),
    survey: markedEvent(ev, 'survey'),
    formats: ev.tags.filter((t) => t[0] === 'format' && ['post', 'podcast', 'video'].includes(t[1])).map((t) => t[1] as KitFormat),
    audience: Number(tagValue(ev, 'audience')) > 0 ? Number(tagValue(ev, 'audience')) : undefined,
    cpm: /^[1-9]\d*$/.test(tagValue(ev, 'cpm') ?? '') ? BigInt(tagValue(ev, 'cpm')!) : undefined,
  };
}

/** What one insertion with this creator should cost at their CPM (or the advertiser's), from their reported audience. */
export function insertionPrice(kit: Pick<MediaKit, 'audience' | 'cpm'>, fallbackCpm: bigint): bigint | undefined {
  if (!kit.audience) return undefined;
  return (BigInt(kit.audience) * (kit.cpm ?? fallbackCpm)) / 1000n;
}

/**
 * Advertisers' records from public events: acceptances name the advertiser (`p`), sponsored posts name the acceptance,
 * and receipts name both. Receipts here are as reported; a client verifies a deal's payment on the chain before it
 * relies on it.
 */
export function advertiserRecords(events: Event[], at = now()): Map<string, AdvertiserRecord & { advertiser: string }> {
  const acceptances = new Map(events.filter((e) => e.kind === KIND.acceptance).map((e) => [e.id, e]));
  const delivered = new Map<string, { advertiser: string; at: number }>();
  for (const post of events.filter((e) => e.kind === KIND.note)) {
    const acc = acceptances.get(markedEvent(post, 'sponsorship') ?? '');
    const advertiser = acc && tagValue(acc, 'p');
    if (acc && advertiser && post.pubkey === acc.pubkey && !delivered.has(acc.id)) delivered.set(acc.id, { advertiser, at: post.created_at });
  }
  const paid = new Map<string, number>();
  for (const r of events.filter((e) => e.kind === KIND.payment)) {
    const accId = markedEvent(r, 'acceptance') ?? '';
    if (delivered.get(accId)?.advertiser === r.pubkey && !paid.has(accId)) paid.set(accId, r.created_at);
  }
  const byAdvertiser = new Map<string, { deliveredAt: number; paidAt?: number }[]>();
  for (const [accId, d] of delivered) {
    const list = byAdvertiser.get(d.advertiser) ?? [];
    list.push({ deliveredAt: d.at, paidAt: paid.get(accId) });
    byAdvertiser.set(d.advertiser, list);
  }
  return new Map([...byAdvertiser].map(([advertiser, deals]) => [advertiser, { advertiser, ...advertiserRecord(deals, at) }]));
}
