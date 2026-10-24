import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from '@noble/hashes/utils.js';
import { advertiserRecords, createMediaKit, parseMediaKit } from '../src/mediakit.ts';
import { keyLookup } from '../src/pq.ts';
import { DEFAULT_INDEX, parseUsd } from '../src/pricing.ts';
import { encodeAddress, RAIL } from '../src/rails/algorand.ts';
import { createAcceptance, createOffer, createPaymentReceipt, createSponsoredPost, parseOffer } from '../src/sponsorship.ts';
import { actor, DAY, fromRelay } from './helpers.ts';

const [creator, other, brand] = [actor(), actor(), actor()];
const pqKeyOf = keyLookup([creator, other, brand].map((a) => a.binding));
const rate = { amount: parseUsd('250'), currency: 'USD' as const, index: DEFAULT_INDEX, basePeriod: '2026-09' };

test('a media kit round-trips with its rate, topics and survey', () => {
  const kit = parseMediaKit(fromRelay(createMediaKit(creator.nostrKey, creator.pq, { pitch: 'Trail running and gear reviews', rate, topics: ['Running', 'outdoors'], survey: 'abc' })), pqKeyOf)!;
  assert.equal(kit.rate.amount, parseUsd('250'));
  assert.deepEqual(kit.topics, ['running', 'outdoors']);
  assert.equal(kit.survey, 'abc');
  assert.equal(parseMediaKit(kit.event, () => undefined), undefined);
});

test('advertiser records come from public deals: delivered, paid and overdue', () => {
  const T = 1_790_000_000;
  const payTo = encodeAddress(randomBytes(32));
  const deal = (who: typeof creator, slug: string, pay: boolean) => {
    const offer = parseOffer(createOffer(brand.nostrKey, brand.pq, { slug, title: slug, brief: '', price: rate, rail: RAIL, deadline: T + 30 * DAY, created_at: T }))!;
    const acc = createAcceptance(who.nostrKey, who.pq, offer, payTo, T + DAY);
    const post = createSponsoredPost(who.nostrKey, acc, 'Great gear', undefined, T + 2 * DAY);
    const receipt = pay ? [createPaymentReceipt(brand.nostrKey, brand.pq, { acceptance: acc, delivery: post, rail: RAIL, txid: 'T'.repeat(52), amount: rate.amount, period: '2026-09', created_at: T + 4 * DAY })] : [];
    return [acc, post, ...receipt];
  };
  const events = [...deal(creator, 'a', true), ...deal(other, 'b', false)].map(fromRelay);
  const record = advertiserRecords(events, T + 30 * DAY).get(brand.pubkey)!;
  assert.deepEqual(record, { advertiser: brand.pubkey, delivered: 2, paid: 1, overdue: 1, medianDaysToPay: 2 });
});
