/**
 * An advertiser's public payment record, computed by each client from the deals it has verified. Creators see who
 * pays on time before they accept, without trusting a rating service.
 */

/** Days after delivery before an unpaid deal counts against the advertiser. */
export const PAYMENT_GRACE_DAYS = 14;
const DAY = 86_400;

export interface DeliveredDeal {
  /** Unix seconds the sponsored post was published. */
  deliveredAt: number;
  /** Unix seconds a verified payment confirmed, if one has. */
  paidAt?: number;
}

export interface AdvertiserRecord {
  delivered: number;
  paid: number;
  /** Delivered, unpaid and past the grace period. */
  overdue: number;
  medianDaysToPay?: number;
}

export function advertiserRecord(deals: DeliveredDeal[], at: number): AdvertiserRecord {
  const waits = deals
    .filter((d) => d.paidAt !== undefined)
    .map((d) => Math.max(0, d.paidAt! - d.deliveredAt) / DAY)
    .sort((a, b) => a - b);
  const overdue = deals.filter((d) => d.paidAt === undefined && at - d.deliveredAt > PAYMENT_GRACE_DAYS * DAY).length;
  const mid = waits.length >> 1;
  const median = waits.length % 2 ? waits[mid] : (waits[mid - 1] + waits[mid]) / 2;
  return { delivered: deals.length, paid: waits.length, overdue, medianDaysToPay: waits.length ? median : undefined };
}
