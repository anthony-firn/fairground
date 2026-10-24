/**
 * Buying and selling between people: goods, food, services and requests for help, in shops, restaurants or as
 * one-off listings.
 *
 * Listings are NIP-99 classified listings (kind 30402), so other Nostr marketplaces show Fairground's and Fairground
 * shows theirs. A storefront groups a seller's listings. Orders travel as encrypted direct messages, and the buyer pays
 * the seller's wallet directly. The payment memo carries an order id that commits to the buyer, so later only that
 * buyer can attach a review to the payment. Reliability is built from those verified reviews, and credentials from
 * attestations by issuers the reader trusts and vouches from people they follow.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Event } from 'nostr-tools/pure';
import { addressOf } from './comments.ts';
import { geohashTags, isGeohash } from './geohash.ts';
import { KIND } from './kinds.ts';
import { MEMO } from './memos.ts';
import { signHybrid, verifyHybrid, type KeyLookup, type PqKeys } from './pq.ts';
import { formatUsd, parseUsd } from './pricing.ts';
import type { Rail } from './rails/rail.ts';
import { now, tag, tagValue } from './tags.ts';

export type ListingType = 'item' | 'food' | 'service' | 'request' | 'rental';
export const LISTING_TYPES: ListingType[] = ['item', 'food', 'service', 'request', 'rental'];
export type Fulfillment = 'pickup' | 'delivery' | 'shipping' | 'onsite' | 'remote';

/** Service categories with plain names; the hashtag is what listings carry. */
export const SERVICE_CATEGORIES = [
  { tag: 'rides', label: 'Rides' },
  { tag: 'delivery', label: 'Delivery' },
  { tag: 'groceries', label: 'Grocery shopping' },
  { tag: 'mealpickup', label: 'Meal pickup' },
  { tag: 'tasks', label: 'Tasks and odd jobs' },
  { tag: 'handyman', label: 'Handyman' },
  { tag: 'cleaning', label: 'Cleaning' },
  { tag: 'moving', label: 'Moving' },
  { tag: 'petcare', label: 'Pet care' },
  { tag: 'tutoring', label: 'Tutoring' },
];

export interface Price {
  /** Decimal string, e.g. "12.50". */
  amount: string;
  /** ISO 4217-style code; Fairground can take payment for USD prices. */
  currency: string;
  /** For recurring or hourly prices: hour, day, week, month… */
  frequency?: string;
}

export interface ListingInput {
  slug?: string;
  type: ListingType;
  title: string;
  summary?: string;
  description: string;
  price?: Price;
  images: string[];
  categories: string[];
  location?: string;
  geohash?: string;
  /** Where buyers pay. Required to take payment in the app; a request for help has none. */
  payTo?: { rail: string; address: string };
  fulfillment: Fulfillment[];
  /** The storefront this belongs to, as `33477:<pubkey>:<slug>`. */
  store?: string;
  status?: 'active' | 'sold';
  published_at?: number;
  created_at?: number;
}

export interface Listing extends Required<Pick<ListingInput, 'type' | 'title' | 'description' | 'images' | 'categories' | 'fulfillment'>> {
  event: Event;
  seller: string;
  address: string;
  slug: string;
  summary?: string;
  price?: Price;
  location?: string;
  geohash?: string;
  payTo?: { rail: string; address: string };
  store?: string;
  status: 'active' | 'sold';
  /** Signed with the seller's post-quantum key as well. Payment details are only trusted when it is. */
  pqVerified: boolean;
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'listing';

export function createListing(nostrKey: Uint8Array, pq: PqKeys, l: ListingInput): Event {
  const created_at = l.created_at ?? now();
  const slug = l.slug ?? `${slugify(l.title)}-${bytesToHex(randomBytes(3))}`;
  const tags = [
    ['d', slug],
    ['title', l.title],
    ['published_at', String(l.published_at ?? created_at)],
    ['type', l.type],
    ['t', l.type],
    ...[...new Set(l.categories.map((c) => c.toLowerCase()))].map((c) => ['t', c]),
    ...l.images.map((url) => ['image', url]),
    ['status', l.status ?? 'active'],
  ];
  if (l.summary) tags.push(['summary', l.summary]);
  if (l.location) tags.push(['location', l.location]);
  if (l.geohash) tags.push(...geohashTags(l.geohash));
  if (l.price) tags.push(['price', l.price.amount, l.price.currency, ...(l.price.frequency ? [l.price.frequency] : [])]);
  if (l.payTo) tags.push(['payto', l.payTo.rail, l.payTo.address]);
  if (l.fulfillment.length) tags.push(['fulfillment', ...l.fulfillment]);
  if (l.store) tags.push(['a', l.store]);
  return signHybrid({ kind: KIND.listing, created_at, content: l.description, tags }, nostrKey, pq);
}

/** Reads any NIP-99 listing, including ones from other apps. */
export function parseListing(ev: Event, pqKeyOf: KeyLookup = () => undefined): Listing | undefined {
  if (ev.kind !== KIND.listing) return undefined;
  const title = tagValue(ev, 'title');
  const slug = tagValue(ev, 'd');
  if (!title || slug === undefined) return undefined;
  const [, amount, currency, frequency] = tag(ev, 'price') ?? [];
  const type = tagValue(ev, 'type') as ListingType | undefined;
  const geohashes = ev.tags.filter((t) => t[0] === 'g' && isGeohash(t[1] ?? '')).map((t) => t[1]);
  const [, rail, address] = tag(ev, 'payto') ?? [];
  const key = pqKeyOf(ev.pubkey);
  return {
    event: ev,
    seller: ev.pubkey,
    address: addressOf(ev),
    slug,
    type: type && LISTING_TYPES.includes(type) ? type : 'item',
    title: title.slice(0, 200),
    summary: tagValue(ev, 'summary')?.slice(0, 300),
    description: ev.content.slice(0, 20_000),
    price: amount && currency && /^\d+(\.\d+)?$/.test(amount) ? { amount, currency: currency.toUpperCase(), frequency } : undefined,
    images: ev.tags.filter((t) => t[0] === 'image' && /^https:\/\//.test(t[1] ?? '')).map((t) => t[1]).slice(0, 10),
    categories: ev.tags.filter((t) => t[0] === 't' && t[1]).map((t) => t[1].toLowerCase()),
    location: tagValue(ev, 'location')?.slice(0, 120),
    geohash: geohashes.sort((a, b) => b.length - a.length)[0],
    payTo: rail && address ? { rail, address } : undefined,
    fulfillment: (tag(ev, 'fulfillment')?.slice(1) ?? []) as Fulfillment[],
    store: ev.tags.find((t) => t[0] === 'a' && t[1]?.startsWith(`${KIND.store}:`))?.[1],
    status: tagValue(ev, 'status') === 'sold' ? 'sold' : 'active',
    pqVerified: !!key && verifyHybrid(ev, key),
  };
}

/** A listing can be bought in the app when it has a USD price and post-quantum-signed payment details. */
export const canBuy = (l: Listing): boolean =>
  l.status === 'active' && l.type !== 'request' && !!l.payTo && l.pqVerified && l.price?.currency === 'USD';

export const priceMicros = (p: Price): bigint => parseUsd(Number(p.amount).toFixed(6).replace(/\.?0+$/, '') || '0');

export const formatPrice = (p?: Price): string => {
  if (!p) return 'No price';
  if (Number(p.amount) === 0) return 'Free';
  const value = p.currency === 'USD' ? `$${formatUsd(priceMicros(p))}` : `${p.amount} ${p.currency}`;
  return p.frequency ? `${value} / ${p.frequency}` : value;
};

export type StoreKind = 'shop' | 'restaurant' | 'services';

export interface StoreInput {
  slug: string;
  kind: StoreKind;
  name: string;
  about: string;
  image?: string;
  location?: string;
  geohash?: string;
  /** Free text, e.g. "Mon–Fri 11–9, Sat 12–10". */
  hours?: string;
  fulfillment: Fulfillment[];
  payTo: { rail: string; address: string };
  /** Taking orders right now. */
  open: boolean;
  created_at?: number;
}

export interface Store extends Omit<StoreInput, 'created_at'> {
  event: Event;
  owner: string;
  address: string;
  pqVerified: boolean;
}

export function createStore(nostrKey: Uint8Array, pq: PqKeys, s: StoreInput): Event {
  const tags = [
    ['d', s.slug],
    ['name', s.name],
    ['type', s.kind],
    ['payto', s.payTo.rail, s.payTo.address],
    ['status', s.open ? 'open' : 'closed'],
  ];
  if (s.image) tags.push(['image', s.image]);
  if (s.location) tags.push(['location', s.location]);
  if (s.geohash) tags.push(...geohashTags(s.geohash));
  if (s.hours) tags.push(['hours', s.hours]);
  if (s.fulfillment.length) tags.push(['fulfillment', ...s.fulfillment]);
  return signHybrid({ kind: KIND.store, created_at: s.created_at ?? now(), content: s.about, tags }, nostrKey, pq);
}

export function parseStore(ev: Event, pqKeyOf: KeyLookup): Store | undefined {
  if (ev.kind !== KIND.store) return undefined;
  const name = tagValue(ev, 'name');
  const slug = tagValue(ev, 'd');
  const kind = tagValue(ev, 'type') as StoreKind;
  const [, rail, address] = tag(ev, 'payto') ?? [];
  if (!name || slug === undefined || !['shop', 'restaurant', 'services'].includes(kind) || !rail || !address) return undefined;
  const key = pqKeyOf(ev.pubkey);
  const geohash = ev.tags.filter((t) => t[0] === 'g' && isGeohash(t[1] ?? '')).map((t) => t[1]).sort((a, b) => b.length - a.length)[0];
  return {
    event: ev,
    owner: ev.pubkey,
    address: addressOf(ev),
    slug,
    kind,
    name,
    about: ev.content,
    image: tagValue(ev, 'image'),
    location: tagValue(ev, 'location'),
    geohash,
    hours: tagValue(ev, 'hours'),
    fulfillment: (tag(ev, 'fulfillment')?.slice(1) ?? []) as Fulfillment[],
    payTo: { rail, address },
    open: tagValue(ev, 'status') !== 'closed',
    pqVerified: !!key && verifyHybrid(ev, key),
  };
}

/**
 * An order id that commits to the buyer: sha256(buyer pubkey || nonce). It goes in the public payment memo, which
 * reveals nothing about who paid; showing the nonce later proves the payment was theirs.
 */
export function newOrderId(buyer: string): { orderId: string; nonce: string } {
  const nonce = bytesToHex(randomBytes(16));
  return { orderId: orderIdFor(buyer, nonce), nonce };
}

export const orderIdFor = (buyer: string, nonce: string): string => bytesToHex(sha256(utf8ToBytes(`${buyer}:${nonce}`)));

export interface OrderLine {
  /** The listing's address. */
  listing: string;
  title: string;
  quantity: number;
  /** Micro-dollars per unit, as a decimal string. */
  unitPrice: string;
}

/** The order a buyer sends the seller privately. It carries everything needed to fulfil and to check payment. */
export interface Order {
  type: 'fairground/order';
  orderId: string;
  lines: OrderLine[];
  /** Micro-dollars, as a decimal string. */
  total: string;
  fulfillment: Fulfillment;
  /** Address, time, phone: whatever the seller needs. Only the seller can read it. */
  note: string;
  payTo: { rail: string; address: string };
}

export type OrderStatus = 'accepted' | 'declined' | 'ready' | 'on-the-way' | 'completed' | 'cancelled';
export const ORDER_STATUSES: OrderStatus[] = ['accepted', 'declined', 'ready', 'on-the-way', 'completed', 'cancelled'];

export interface OrderUpdate {
  type: 'fairground/order-status';
  orderId: string;
  status: OrderStatus;
  note?: string;
}

export function orderTotal(lines: OrderLine[]): bigint {
  return lines.reduce((sum, l) => sum + BigInt(l.unitPrice) * BigInt(l.quantity), 0n);
}

/** Validates an order received in a message; returns undefined for anything malformed. */
export function parseOrder(json: unknown): Order | undefined {
  const o = json as Partial<Order> | null;
  if (!o || o.type !== 'fairground/order' || !/^[0-9a-f]{64}$/.test(o.orderId ?? '')) return undefined;
  if (!Array.isArray(o.lines) || !o.lines.length || o.lines.length > 50) return undefined;
  const lines = o.lines.filter((l) => l && typeof l.title === 'string' && Number.isInteger(l.quantity) && l.quantity > 0 && /^\d+$/.test(l.unitPrice));
  if (lines.length !== o.lines.length || !/^\d+$/.test(o.total ?? '') || BigInt(o.total!) !== orderTotal(lines)) return undefined;
  if (!o.payTo?.rail || !o.payTo.address || !['pickup', 'delivery', 'shipping', 'onsite', 'remote'].includes(o.fulfillment as string)) return undefined;
  return { type: o.type, orderId: o.orderId!, lines, total: o.total!, fulfillment: o.fulfillment!, note: String(o.note ?? '').slice(0, 2000), payTo: o.payTo };
}

export function parseOrderUpdate(json: unknown): OrderUpdate | undefined {
  const u = json as Partial<OrderUpdate> | null;
  if (!u || u.type !== 'fairground/order-status' || !/^[0-9a-f]{64}$/.test(u.orderId ?? '')) return undefined;
  if (!ORDER_STATUSES.includes(u.status as OrderStatus)) return undefined;
  return { type: u.type, orderId: u.orderId!, status: u.status!, note: u.note ? String(u.note).slice(0, 500) : undefined };
}

/** Whether the seller has been paid for an order: a transfer to their address with the order's memo, for the total. */
export async function orderPayment(order: Order, rail: Rail, since: number) {
  const transfers = await rail.listTransfers({
    address: order.payTo.address, role: 'receiver', notePrefix: MEMO.order(order.orderId), from: since - 86400, to: now() + 600,
  });
  const paid = transfers.filter((t) => t.note === MEMO.order(order.orderId)).reduce((s, t) => s + t.amount, 0n);
  return { paid, complete: paid >= BigInt(order.total), transfers };
}

export interface ReviewInput {
  seller: string;
  /** The listing or store reviewed. */
  subject?: string;
  rating: 1 | 2 | 3 | 4 | 5;
  text: string;
  rail: string;
  txid: string;
  orderId: string;
  nonce: string;
  created_at?: number;
}

export function createReview(nostrKey: Uint8Array, pq: PqKeys, r: ReviewInput): Event {
  const tags = [['p', r.seller], ['rating', String(r.rating)], ['tx', r.rail, r.txid], ['order', r.orderId, r.nonce]];
  if (r.subject) tags.push(['a', r.subject]);
  return signHybrid({ kind: KIND.review, created_at: r.created_at ?? now(), content: r.text.slice(0, 2000), tags }, nostrKey, pq);
}

export interface VerifiedReview {
  event: Event;
  reviewer: string;
  rating: number;
  text: string;
  /** What the reviewer paid. */
  amount: bigint;
  paidAt: number;
}

/**
 * Checks a review: the reviewer's signatures, that the order id commits to the reviewer, and that a transfer with the
 * order's memo reached one of the seller's payment addresses. Each transfer backs one review.
 */
export async function verifyReviews(
  reviews: Event[],
  sellerAddresses: Set<string>,
  rail: Rail,
  pqKeyOf: KeyLookup,
): Promise<VerifiedReview[]> {
  const out: VerifiedReview[] = [];
  const used = new Set<string>();
  for (const ev of [...reviews].sort((a, b) => a.created_at - b.created_at)) {
    const [, txRail, txid] = tag(ev, 'tx') ?? [];
    const [, orderId, nonce] = tag(ev, 'order') ?? [];
    const rating = Number(tagValue(ev, 'rating'));
    const key = pqKeyOf(ev.pubkey);
    if (ev.kind !== KIND.review || txRail !== rail.id || !txid || used.has(txid) || !orderId || !nonce) continue;
    if (!Number.isInteger(rating) || rating < 1 || rating > 5 || !key || !verifyHybrid(ev, key)) continue;
    if (orderIdFor(ev.pubkey, nonce) !== orderId) continue;
    try {
      const transfer = await rail.fetchTransfer(txid);
      if (transfer.note !== MEMO.order(orderId) || !sellerAddresses.has(transfer.receiver)) continue;
      used.add(txid);
      out.push({ event: ev, reviewer: ev.pubkey, rating, text: ev.content, amount: transfer.amount, paidAt: transfer.time });
    } catch {
      // Not found or not a transfer on this rail.
    }
  }
  return out;
}

export interface Reliability {
  verifiedOrders: number;
  /** Average rating, weighting each review by how much the reader trusts the reviewer (0–1, at least 0.2). */
  rating?: number;
  /** Reviews from people the reader trusts. */
  fromTrusted: number;
  repeatCustomers: number;
}

/**
 * A seller could pay themselves from another wallet to fake a verified review, at the cost of a transaction fee, so
 * reviews from strangers count for less than reviews from people the reader trusts.
 */
export function reliability(reviews: VerifiedReview[], trustOf: (pubkey: string) => number): Reliability {
  let weighted = 0;
  let weights = 0;
  const buyers = new Map<string, number>();
  for (const r of reviews) {
    const w = Math.max(0.2, Math.min(1, trustOf(r.reviewer)));
    weighted += w * r.rating;
    weights += w;
    buyers.set(r.reviewer, (buyers.get(r.reviewer) ?? 0) + 1);
  }
  return {
    verifiedOrders: reviews.length,
    rating: weights ? Math.round((weighted / weights) * 10) / 10 : undefined,
    fromTrusted: reviews.filter((r) => trustOf(r.reviewer) >= 0.5).length,
    repeatCustomers: [...buyers.values()].filter((n) => n > 1).length,
  };
}

export const CREDENTIAL_TYPES = [
  { type: 'drivers-license', label: "Driver's licence" },
  { type: 'vehicle-insurance', label: 'Vehicle insurance' },
  { type: 'commercial-insurance', label: 'Commercial or rideshare insurance' },
  { type: 'food-handler', label: 'Food handler card' },
  { type: 'business-license', label: 'Business licence' },
  { type: 'background-check', label: 'Background check' },
  { type: 'id-verified', label: 'Identity verified' },
  { type: 'vouch', label: 'Vouched for' },
] as const;

export type CredentialType = (typeof CREDENTIAL_TYPES)[number]['type'];

/** A claim about someone: issued by an organisation, vouched by an acquaintance, or declared by themselves. */
export function createCredential(
  nostrKey: Uint8Array,
  pq: PqKeys,
  c: { subject: string; type: CredentialType; note?: string; expires?: number; evidence?: string; created_at?: number },
): Event {
  const tags = [['p', c.subject], ['credential', c.type]];
  if (c.expires) tags.push(['expires', String(c.expires)]);
  if (c.evidence) tags.push(['r', c.evidence]);
  return signHybrid({ kind: KIND.credential, created_at: c.created_at ?? now(), content: c.note ?? '', tags }, nostrKey, pq);
}

export type CredentialStatus = 'verified' | 'vouched' | 'self-declared';

export interface CredentialView {
  type: string;
  issuer: string;
  status: CredentialStatus;
  note: string;
  expires?: number;
}

/**
 * The credentials a reader should see for `subject`, strongest first. "Verified" needs an issuer the reader trusts
 * (for example a background-check company); "vouched" needs someone the reader follows; anything else the subject
 * says about themselves is shown as self-declared. Expired or unsigned claims are dropped.
 */
export function credentialsFor(
  subject: string,
  events: Event[],
  opts: { trustedIssuers: Set<string>; follows: Set<string>; pqKeyOf: KeyLookup; at?: number },
): CredentialView[] {
  const at = opts.at ?? now();
  const best = new Map<string, CredentialView>();
  const strength: Record<CredentialStatus, number> = { verified: 3, vouched: 2, 'self-declared': 1 };
  for (const ev of events) {
    if (ev.kind !== KIND.credential || tagValue(ev, 'p') !== subject) continue;
    const type = tagValue(ev, 'credential');
    const expires = Number(tagValue(ev, 'expires')) || undefined;
    const key = opts.pqKeyOf(ev.pubkey);
    if (!type || (expires && expires < at) || !key || !verifyHybrid(ev, key)) continue;
    const status: CredentialStatus | undefined = opts.trustedIssuers.has(ev.pubkey)
      ? 'verified'
      : ev.pubkey === subject
        ? 'self-declared'
        : opts.follows.has(ev.pubkey) ? 'vouched' : undefined;
    if (!status) continue;
    const key2 = `${type}`;
    const prev = best.get(key2);
    if (!prev || strength[status] > strength[prev.status]) best.set(key2, { type, issuer: ev.pubkey, status, note: ev.content, expires });
  }
  return [...best.values()].sort((a, b) => strength[b.status] - strength[a.status]);
}

export type ReportReason = 'illegal' | 'spam' | 'impersonation' | 'nudity' | 'malware' | 'profanity' | 'other';

/** A NIP-56 report, so other readers' clients can take it into account. */
export function reportTemplate(target: Event, reason: ReportReason, note = '') {
  return { kind: KIND.report, created_at: now(), content: note, tags: [['e', target.id, reason], ['p', target.pubkey, reason]] };
}

/** A helper's price for someone's request (a ride, an errand), sent privately. Accepting it turns it into an order. */
export interface Quote {
  type: 'fairground/quote';
  /** The request listing's address. */
  listing: string;
  title: string;
  /** Micro-dollars, as a decimal string. */
  amount: string;
  payTo: { rail: string; address: string };
  note?: string;
}

export function parseQuote(json: unknown): Quote | undefined {
  const q = json as Partial<Quote> | null;
  if (!q || q.type !== 'fairground/quote' || typeof q.listing !== 'string' || typeof q.title !== 'string') return undefined;
  if (!/^[1-9]\d*$/.test(q.amount ?? '') || !q.payTo?.rail || !q.payTo.address) return undefined;
  return { type: q.type, listing: q.listing, title: q.title.slice(0, 200), amount: q.amount!, payTo: q.payTo, note: q.note ? String(q.note).slice(0, 1000) : undefined };
}
