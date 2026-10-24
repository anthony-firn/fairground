/**
 * Optional donations. Clients offer one after money changes hands (a creator's verified payout, an advertiser's
 * payment, a seller's paid order) and let anyone give at any time. It is never pre-selected and never taken out of a
 * payment: the person sends it from their own wallet if they choose. It is split between development and the relays
 * the person uses; see commons.ts.
 */
import type { Event } from 'nostr-tools/pure';
import { KIND } from './kinds.ts';
import { signHybrid, type PqKeys } from './pq.ts';
import { now } from './tags.ts';

export const SUGGESTED_PERCENT = 2n;
const CENT = 10_000n;

/** The suggested share of a payment, rounded to the nearest cent and at least one cent. */
export function suggestedDonation(paid: bigint): bigint {
  const cents = (paid * SUGGESTED_PERCENT + 50n * CENT) / (100n * CENT);
  return cents > 0n ? cents * CENT : CENT;
}

export interface DonationTransfer {
  txid: string;
  amount: bigint;
  /** `development`, or the relay URL whose operator received it. */
  recipient: string;
}

/** Optional public record of a donation, so the project's and relays' funding is as transparent as the deals. */
export function createDonationReceipt(
  nostrKey: Uint8Array,
  pq: PqKeys,
  d: { payment?: Event; rail: string; transfers: DonationTransfer[]; created_at?: number },
): Event {
  const tags = [
    ...(d.payment ? [['e', d.payment.id, '', 'payment']] : []),
    ...d.transfers.map((t) => ['tx', d.rail, t.txid, t.amount.toString(), t.recipient]),
  ];
  return signHybrid({ kind: KIND.donation, created_at: d.created_at ?? now(), content: '', tags }, nostrKey, pq);
}
