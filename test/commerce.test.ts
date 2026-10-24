import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from '@noble/hashes/utils.js';
import { finalizeEvent } from 'nostr-tools/pure';
import {
  canBuy,
  createCredential,
  createListing,
  createReview,
  createStore,
  credentialsFor,
  formatPrice,
  newOrderId,
  orderIdFor,
  orderPayment,
  orderTotal,
  parseListing,
  parseOrder,
  parseOrderUpdate,
  parseStore,
  priceMicros,
  reliability,
  verifyReviews,
  type Order,
} from '../src/commerce.ts';
import { encodeGeohash, geohashTags } from '../src/geohash.ts';
import { KIND } from '../src/kinds.ts';
import { MEMO } from '../src/memos.ts';
import { keyLookup } from '../src/pq.ts';
import { parseUsd } from '../src/pricing.ts';
import { encodeAddress, RAIL } from '../src/rails/algorand.ts';
import type { Rail, Transfer } from '../src/rails/rail.ts';
import { actor, fromRelay } from './helpers.ts';

const [seller, buyer, friend, stranger, issuer] = [actor(), actor(), actor(), actor(), actor()];
const pqKeyOf = keyLookup([seller, buyer, friend, stranger, issuer].map((a) => a.binding));
const payTo = { rail: RAIL, address: encodeAddress(randomBytes(32)) };

test('geohashes encode known places and expand into area tags', () => {
  assert.equal(encodeGeohash(57.64911, 10.40744, 11), 'u4pruydqqvj');
  assert.deepEqual(geohashTags('9q8yy'), [['g', '9q'], ['g', '9q8'], ['g', '9q8y'], ['g', '9q8yy']]);
  assert.deepEqual(geohashTags('not a hash!'), []);
});

test('a listing round-trips as NIP-99 and can be bought only with signed USD payment details', () => {
  const ev = fromRelay(createListing(seller.nostrKey, seller.pq, {
    type: 'food', title: 'Bean burrito', description: 'With salsa verde.', price: { amount: '12.50', currency: 'USD' },
    images: ['https://example.com/b.jpg'], categories: ['Mexican'], location: 'Mission, SF', geohash: '9q8yy',
    payTo, fulfillment: ['pickup', 'delivery'], store: `33477:${seller.pubkey}:taqueria`,
  }));
  assert.equal(ev.kind, 30402);
  const l = parseListing(ev, pqKeyOf)!;
  assert.equal(l.type, 'food');
  assert.deepEqual(l.categories, ['food', 'mexican']);
  assert.equal(l.geohash, '9q8yy');
  assert.equal(l.store, `33477:${seller.pubkey}:taqueria`);
  assert.equal(priceMicros(l.price!), parseUsd('12.5'));
  assert.equal(formatPrice(l.price), '$12.50');
  assert.ok(canBuy(l));
  assert.equal(canBuy(parseListing(ev, () => undefined)!), false, 'unverifiable payment details');
  assert.equal(formatPrice({ amount: '20', currency: 'USD', frequency: 'hour' }), '$20.00 / hour');
  assert.equal(formatPrice({ amount: '0', currency: 'USD' }), 'Free');
});

test('listings from other NIP-99 apps are readable but not bought in-app', () => {
  const foreign = finalizeEvent({
    kind: 30402, created_at: 1_790_000_000, content: 'Vintage lamp',
    tags: [['d', 'lamp'], ['title', 'Lamp'], ['price', '21000', 'SATS'], ['t', 'electronics'], ['image', 'https://x.example/l.png']],
  }, stranger.nostrKey);
  const l = parseListing(foreign, pqKeyOf)!;
  assert.equal(l.type, 'item');
  assert.equal(formatPrice(l.price), '21000 SATS');
  assert.equal(canBuy(l), false);
});

test('a storefront round-trips', () => {
  const s = parseStore(fromRelay(createStore(seller.nostrKey, seller.pq, {
    slug: 'taqueria', kind: 'restaurant', name: 'La Taqueria', about: 'Burritos since 1973', hours: 'Daily 11–9',
    fulfillment: ['pickup'], payTo, open: true,
  })), pqKeyOf)!;
  assert.equal(s.kind, 'restaurant');
  assert.equal(s.address, `33477:${seller.pubkey}:taqueria`);
  assert.equal(s.open, true);
  assert.ok(s.pqVerified);
});

test('order messages are validated, including that the total adds up', () => {
  const { orderId, nonce } = newOrderId(buyer.pubkey);
  assert.equal(orderIdFor(buyer.pubkey, nonce), orderId);
  const lines = [{ listing: 'a', title: 'Burrito', quantity: 2, unitPrice: parseUsd('12.5').toString() }];
  const order: Order = { type: 'fairground/order', orderId, lines, total: orderTotal(lines).toString(), fulfillment: 'pickup', note: '6pm', payTo };
  assert.deepEqual(parseOrder(JSON.parse(JSON.stringify(order))), order);
  assert.equal(parseOrder({ ...order, total: '1' }), undefined, 'a tampered total is rejected');
  assert.equal(parseOrder({ ...order, fulfillment: 'teleport' }), undefined);
  assert.deepEqual(parseOrderUpdate({ type: 'fairground/order-status', orderId, status: 'ready' }), { type: 'fairground/order-status', orderId, status: 'ready', note: undefined });
  assert.equal(parseOrderUpdate({ type: 'fairground/order-status', orderId, status: 'teleported' }), undefined);
});

/** A rail whose chain holds exactly these transfers. */
const chain = (transfers: Transfer[]): Rail => ({
  id: RAIL, label: 't', isAddress: () => true, canReceive: async () => true, paymentLink: () => '',
  fetchTransfer: async (id) => {
    const t = transfers.find((x) => x.id === id);
    if (!t) throw new Error('not found');
    return t;
  },
  listTransfers: async ({ address, notePrefix }) => transfers.filter((t) => t.receiver === address && t.note.startsWith(notePrefix)),
});

test('an order is paid when transfers with its memo reach the total', async () => {
  const { orderId } = newOrderId(buyer.pubkey);
  const lines = [{ listing: 'a', title: 'Burrito', quantity: 1, unitPrice: parseUsd('12.5').toString() }];
  const order: Order = { type: 'fairground/order', orderId, lines, total: orderTotal(lines).toString(), fulfillment: 'pickup', note: '', payTo };
  const t = (amount: string): Transfer => ({ id: 'T1', sender: 'S', receiver: payTo.address, amount: parseUsd(amount), note: MEMO.order(orderId), time: 1 });
  assert.equal((await orderPayment(order, chain([t('5')]), 0)).complete, false);
  assert.equal((await orderPayment(order, chain([t('12.5')]), 0)).complete, true);
});

test('only the paying buyer can attach a review to a payment, once', async () => {
  const { orderId, nonce } = newOrderId(buyer.pubkey);
  const transfer: Transfer = { id: 'TX'.padEnd(52, 'A'), sender: 'S', receiver: payTo.address, amount: parseUsd('25'), note: MEMO.order(orderId), time: 100 };
  const review = (who: typeof buyer, n = nonce, rating: 1 | 5 = 5) => fromRelay(createReview(who.nostrKey, who.pq, {
    seller: seller.pubkey, rating, text: 'Great', rail: RAIL, txid: transfer.id, orderId, nonce: n,
  }));
  const honest = review(buyer);
  const thief = review(stranger);
  const duplicate = review(buyer, nonce, 1);
  const verified = await verifyReviews([honest, thief, duplicate], new Set([payTo.address]), chain([transfer]), pqKeyOf);
  assert.deepEqual(verified.map((v) => [v.reviewer, v.rating, v.amount]), [[buyer.pubkey, 5, parseUsd('25')]]);
  const elsewhere = await verifyReviews([honest], new Set([encodeAddress(randomBytes(32))]), chain([transfer]), pqKeyOf);
  assert.equal(elsewhere.length, 0, 'the payment went to someone else');
});

test('reliability weights trusted reviewers above strangers', () => {
  const r = (reviewer: string, rating: number) => ({ event: {} as never, reviewer, rating, text: '', amount: 1n, paidAt: 0 });
  const reviews = [r(friend.pubkey, 2), r(friend.pubkey, 2), ...Array.from({ length: 4 }, () => r(stranger.pubkey, 5))];
  const trust = (pk: string) => (pk === friend.pubkey ? 1 : 0);
  const result = reliability(reviews, trust);
  assert.equal(result.verifiedOrders, 6);
  assert.equal(result.fromTrusted, 2);
  assert.equal(result.repeatCustomers, 2);
  assert.ok(result.rating! < 4, `strangers' 5 stars don't drown out a trusted 2 (got ${result.rating})`);
});

test('credentials show the strongest trusted claim, and drop expired or unknown ones', () => {
  const now = 1_790_000_000;
  const events = [
    createCredential(seller.nostrKey, seller.pq, { subject: seller.pubkey, type: 'drivers-license', note: 'Class C' }),
    createCredential(friend.nostrKey, friend.pq, { subject: seller.pubkey, type: 'drivers-license' }),
    createCredential(issuer.nostrKey, issuer.pq, { subject: seller.pubkey, type: 'background-check', expires: now + 1000 }),
    createCredential(issuer.nostrKey, issuer.pq, { subject: seller.pubkey, type: 'food-handler', expires: now - 1 }),
    createCredential(stranger.nostrKey, stranger.pq, { subject: seller.pubkey, type: 'commercial-insurance' }),
  ].map(fromRelay);
  const views = credentialsFor(seller.pubkey, events, { trustedIssuers: new Set([issuer.pubkey]), follows: new Set([friend.pubkey]), pqKeyOf, at: now });
  assert.deepEqual(views.map((v) => [v.type, v.status]), [['background-check', 'verified'], ['drivers-license', 'vouched']]);
  assert.equal(events[0].kind, KIND.credential);
});

test('quotes for requests are validated', async () => {
  const { parseQuote } = await import('../src/commerce.ts');
  const quote = { type: 'fairground/quote', listing: '30402:x:ride', title: 'Airport ride', amount: parseUsd('30').toString(), payTo };
  assert.deepEqual(parseQuote(quote), { ...quote, note: undefined });
  assert.equal(parseQuote({ ...quote, amount: '0' }), undefined);
  assert.equal(parseQuote({ ...quote, payTo: undefined }), undefined);
});
