import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from '@noble/hashes/utils.js';
import { finalizeEvent, type Event } from 'nostr-tools/pure';
import { MEMO } from '../src/memos.ts';
import { keyLookup } from '../src/pq.ts';
import { createIndexAttestation, DEFAULT_INDEX, FIXED_INDEX, parseUsd } from '../src/pricing.ts';
import { createAlgorandUsdcRail, encodeAddress, RAIL } from '../src/rails/algorand.ts';
import type { Rail, Transfer } from '../src/rails/rail.ts';
import {
  acceptedOffer,
  checkDeal,
  createAcceptance,
  createOffer,
  createPaymentReceipt,
  createSponsoredPost,
  parseOffer,
  verifyPayment,
  type Deal,
  type OfferInput,
} from '../src/sponsorship.ts';
import { actor, DAY, fromRelay, type Actor } from './helpers.ts';

const T0 = 1_790_000_000;
const [advertiser, creator, other, p1, p2] = [actor(), actor(), actor(), actor(), actor()];
const pqKeyOf = keyLookup([advertiser, creator, other, p1, p2].map((a) => a.binding));
const indexPolicy = { index: DEFAULT_INDEX, publishers: [p1.pubkey, p2.pubkey], threshold: 2 };
const payTo = encodeAddress(randomBytes(32));

// Illustrative index readings: September is 0.5% above the August base, October 1%.
const readings: [string, string, number][] = [['2026-08', '330.000', T0 - 20 * DAY], ['2026-09', '331.650', T0 + 5 * DAY], ['2026-10', '333.300', T0 + 9 * DAY]];
const attestations = readings.flatMap(([period, value, at]) => [p1, p2].map((p) =>
  fromRelay(createIndexAttestation(p.nostrKey, p.pq, { index: DEFAULT_INDEX, period, value, source: 'https://www.bls.gov/cpi/' }, at))));

const offerInput: OfferInput = {
  slug: 'autumn-launch',
  title: 'Autumn launch',
  brief: 'One post about our new trail shoe.',
  price: { amount: parseUsd('500'), currency: 'USD', index: DEFAULT_INDEX, basePeriod: '2026-08' },
  rail: RAIL,
  deadline: T0 + 14 * DAY,
  created_at: T0,
};

function deal(over: { offer?: Partial<OfferInput>; acceptor?: Actor; postText?: string; postAt?: number } = {}) {
  const offer = fromRelay(createOffer(advertiser.nostrKey, advertiser.pq, { ...offerInput, ...over.offer }));
  const acceptor = over.acceptor ?? creator;
  const acceptance = fromRelay(createAcceptance(acceptor.nostrKey, acceptor.pq, parseOffer(offer)!, payTo, T0 + DAY));
  const delivery = fromRelay(createSponsoredPost(acceptor.nostrKey, acceptance, over.postText ?? 'Loving these trail shoes', acceptor.pq, over.postAt ?? T0 + 2 * DAY));
  return { offer, acceptance, delivery };
}

function receipt(d: Pick<Deal, 'acceptance' | 'delivery'>, amount: string, period: string): Event {
  return fromRelay(createPaymentReceipt(advertiser.nostrKey, advertiser.pq, {
    acceptance: d.acceptance!, delivery: d.delivery!, rail: RAIL, txid: 'T'.repeat(52), amount: parseUsd(amount), period, created_at: T0 + 12 * DAY,
  }));
}

/** A rail whose chain holds exactly one transfer. */
const railWith = (transfer: Partial<Transfer> & { acceptanceId: string }): Record<string, Rail> => {
  const real = createAlgorandUsdcRail();
  return {
    [RAIL]: {
      ...real,
      fetchTransfer: async (txid) => ({
        id: txid, sender: encodeAddress(new Uint8Array(32)), receiver: payTo, amount: parseUsd('505'), note: MEMO.deal(transfer.acceptanceId), time: T0 + 11 * DAY, ...transfer,
      }),
    },
  };
};

test('a deal advances through each stage with no problems', () => {
  const d = deal();
  assert.deepEqual(checkDeal({ offer: d.offer }, { pqKeyOf }).stage, 'offered');
  assert.deepEqual(checkDeal({ offer: d.offer, acceptance: d.acceptance }, { pqKeyOf }).stage, 'accepted');
  const delivered = checkDeal(d, { pqKeyOf });
  assert.deepEqual([delivered.stage, delivered.problems], ['delivered', []]);
  const receipted = checkDeal({ ...d, payment: receipt(d, '505', '2026-10') }, { pqKeyOf });
  assert.deepEqual([receipted.stage, receipted.problems], ['receipted', []]);
});

test('payment at the latest index is verified against the chain', async () => {
  const d = deal();
  const result = await verifyPayment({ ...d, payment: receipt(d, '505', '2026-10') }, {
    pqKeyOf, attestations, indexPolicy, rails: railWith({ acceptanceId: d.acceptance.id }),
  });
  assert.deepEqual(result, { ok: true, required: parseUsd('505'), paid: parseUsd('505'), problems: [] });
});

test('the previous index period is still accepted, but an older one is not', async () => {
  const d = deal();
  const previous = await verifyPayment({ ...d, payment: receipt(d, '502.5', '2026-09') }, {
    pqKeyOf, attestations, indexPolicy, rails: railWith({ acceptanceId: d.acceptance.id, amount: parseUsd('502.5') }),
  });
  assert.equal(previous.ok, true);

  const stale = await verifyPayment({ ...d, payment: receipt(d, '500', '2026-08') }, {
    pqKeyOf, attestations, indexPolicy, rails: railWith({ acceptanceId: d.acceptance.id, amount: parseUsd('500') }),
  });
  assert.equal(stale.ok, false);
  assert.match(stale.problems[0], /two latest index values/);
});

test('underpayment, the wrong address and the wrong memo are caught', async () => {
  const d = deal();
  const payment = receipt(d, '500', '2026-10');
  const check = (transfer: Partial<Transfer>) =>
    verifyPayment({ ...d, payment }, { pqKeyOf, attestations, indexPolicy, rails: railWith({ acceptanceId: d.acceptance.id, amount: parseUsd('500'), ...transfer }) });

  assert.deepEqual((await check({})).problems, ['underpaid: 500.00 of 505.00']);
  assert.ok((await check({ receiver: encodeAddress(randomBytes(32)) })).problems.includes('payment went to a different address'));
  assert.ok((await check({ note: 'fairground:someone-else' })).problems.includes('payment memo doesn’t name this deal'));
});

test('the advertiser cannot change the terms after acceptance', () => {
  const d = deal();
  const revised = fromRelay(createOffer(advertiser.nostrKey, advertiser.pq, { ...offerInput, price: { ...offerInput.price, amount: parseUsd('50') }, created_at: T0 + 3 * DAY }));
  const result = checkDeal({ ...d, offer: revised }, { pqKeyOf });
  assert.deepEqual(result.problems, ['acceptance is for a different version of the offer']);

  const original = acceptedOffer(d.acceptance)!;
  assert.equal(original.id, d.offer.id, 'the acceptance carries the version that was agreed');
  assert.deepEqual(checkDeal({ ...d, offer: original }, { pqKeyOf }).problems, []);
});

test('a sponsored post must disclose the ad', () => {
  const d = deal({ postText: 'Loving these trail shoes' });
  assert.match(d.delivery.content, /#ad$/, 'disclosure is appended automatically');

  const hidden = fromRelay(finalizeEvent({
    kind: 1, created_at: T0 + 2 * DAY, content: 'Loving these trail shoes', tags: [['e', d.acceptance.id, '', 'sponsorship'], ['p', advertiser.pubkey], ['t', 'ad']],
  }, creator.nostrKey));
  assert.deepEqual(checkDeal({ ...d, delivery: hidden }, { pqKeyOf }).problems, ['sponsored post isn’t disclosed as an ad']);
});

test('roles, targeting and the deadline are enforced', () => {
  const targeted = deal({ offer: { creator: creator.pubkey }, acceptor: other });
  assert.deepEqual(checkDeal(targeted, { pqKeyOf }).problems, ['offer was made to a different creator']);

  const selfDeal = deal({ acceptor: advertiser });
  assert.deepEqual(checkDeal(selfDeal, { pqKeyOf }).problems, ['advertisers can’t sponsor themselves']);

  const late = deal({ postAt: T0 + 15 * DAY });
  assert.deepEqual(checkDeal(late, { pqKeyOf }).problems, ['posted outside the agreed window']);
});

test('an offer without the advertiser’s post-quantum key is invalid', () => {
  const d = deal();
  const noBindings = checkDeal(d, { pqKeyOf: () => undefined });
  assert.deepEqual([noBindings.stage, noBindings.problems], ['invalid', ['offer lacks the advertiser’s post-quantum signature']]);
});

test('a client tracking a different index refuses to judge the payment', async () => {
  const d = deal();
  const result = await verifyPayment({ ...d, payment: receipt(d, '505', '2026-10') }, {
    pqKeyOf, attestations, indexPolicy: { ...indexPolicy, index: 'uk-cpih' }, rails: railWith({ acceptanceId: d.acceptance.id }),
  });
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /doesn’t track/);
});

test('a fixed price needs no index values and is owed in full', async () => {
  const d = deal({ offer: { price: { ...offerInput.price, index: FIXED_INDEX } } });
  const paid = (amount: string) => verifyPayment({ ...d, payment: receipt(d, amount, '2026-08') }, {
    pqKeyOf, attestations: [], indexPolicy, rails: railWith({ acceptanceId: d.acceptance.id, amount: parseUsd(amount) }),
  });
  assert.deepEqual(await paid('500'), { ok: true, required: parseUsd('500'), paid: parseUsd('500'), problems: [] });
  assert.deepEqual((await paid('499')).problems, ['underpaid: 499.00 of 500.00']);
});
