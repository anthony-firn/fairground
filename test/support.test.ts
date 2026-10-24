import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { randomBytes } from '@noble/hashes/utils.js';
import { keyLookup } from '../src/pq.ts';
import { DEFAULT_INDEX, parseUsd } from '../src/pricing.ts';
import { createAlgorandUsdcRail, encodeAddress, RAIL } from '../src/rails/algorand.ts';
import type { Transfer } from '../src/rails/rail.ts';
import { createAcceptance, createOffer, parseOffer } from '../src/sponsorship.ts';
import {
  brokenPledges,
  createSupportPage,
  fetchSupport,
  monthSupport,
  nextPeriod,
  parseSupportPage,
  periodBounds,
  type SupportPageInput,
} from '../src/support.ts';
import { actor, DAY, fromRelay } from './helpers.ts';

const creator = actor();
const brand = actor();
const pqKeyOf = keyLookup([creator.binding, brand.binding]);
const payTo = encodeAddress(randomBytes(32));
const input: SupportPageInput = {
  title: 'Keep the channel ad-free',
  pitch: 'Support pays for editing time. If you fund the goal, next month has no sponsors.',
  suggested: { amount: parseUsd('5'), currency: 'USD', index: DEFAULT_INDEX, basePeriod: '2026-09' },
  goal: parseUsd('1500'),
  rail: RAIL,
  payTo,
  adFree: true,
};
const page = parseSupportPage(fromRelay(createSupportPage(creator.nostrKey, creator.pq, input)), pqKeyOf)!;

test('a support page round-trips and needs the creator’s post-quantum signature', () => {
  assert.equal(page.goal, parseUsd('1500'));
  assert.equal(page.adFree, true);
  assert.equal(page.payTo, payTo);
  assert.equal(parseSupportPage(page.event, () => undefined), undefined);
});

test('periods map to UTC month bounds', () => {
  assert.deepEqual(periodBounds('2026-12'), [Date.UTC(2026, 11, 1) / 1000, Date.UTC(2027, 0, 1) / 1000]);
  assert.equal(nextPeriod('2026-12'), '2027-01');
});

const transfer = (amount: string, sender: string): Transfer =>
  ({ id: 'x', sender, receiver: payTo, amount: parseUsd(amount), note: '', time: 0 });

test('a month’s support totals the transfers and counts paying addresses', () => {
  const month = monthSupport('2026-09', [transfer('1000', 'A'), transfer('400', 'B'), transfer('100', 'A')], parseUsd('1500'));
  assert.deepEqual(month, { period: '2026-09', total: parseUsd('1500'), supporters: 2, goalMet: true });
  assert.equal(monthSupport('2026-09', [transfer('10', 'A')], parseUsd('1500')).goalMet, false);
});

test('a sponsorship accepted the month after a funded month breaks the ad-free pledge', () => {
  const [octStart] = periodBounds('2026-10');
  const offer = parseOffer(createOffer(brand.nostrKey, brand.pq, {
    slug: 's', title: 'Spot', brief: '', rail: RAIL, deadline: octStart + 30 * DAY,
    price: { amount: parseUsd('500'), currency: 'USD', index: DEFAULT_INDEX, basePeriod: '2026-09' },
  }))!;
  const accept = (at: number) => fromRelay(createAcceptance(creator.nostrKey, creator.pq, offer, payTo, at));
  const months = [monthSupport('2026-09', [transfer('1500', 'A')], parseUsd('1500'))];

  assert.deepEqual(brokenPledges(page, months, [accept(octStart + DAY)]), ['2026-10']);
  assert.deepEqual(brokenPledges(page, months, [accept(octStart - DAY)]), [], 'September itself was not pledged');
  assert.deepEqual(brokenPledges({ ...page, adFree: false }, months, [accept(octStart + DAY)]), []);
});

test('support is listed from the indexer, page by page, keeping only matching memos inside the month', async () => {
  const base = JSON.parse(readFileSync(new URL('./fixtures/usdc-transfer.json', import.meta.url), 'utf8')).transaction;
  const [from, to] = periodBounds('2026-10');
  const tx = (id: string, note: string, time: number, amount = 5_000_000) => ({
    ...base, id, note: Buffer.from(note).toString('base64'), 'round-time': time,
    'asset-transfer-transaction': { ...base['asset-transfer-transaction'], receiver: payTo, amount },
  });
  const memo = `fairground:support:${creator.pubkey}`;
  const pages = [
    { transactions: [tx('1', memo, from), tx('2', 'fairground:support:someone-else', from + 5)], 'next-token': 'p2' },
    { transactions: [tx('3', memo, to - 1), tx('4', memo, to)] },
  ];
  const urls: URL[] = [];
  const rail = createAlgorandUsdcRail('https://indexer.example', async (url) => {
    urls.push(new URL(String(url)));
    return new Response(JSON.stringify(pages[urls.length - 1]));
  });

  const found = await fetchSupport(page, rail, '2026-10');
  assert.deepEqual(found.map((t) => t.id), ['1', '3']);
  assert.equal(urls[0].searchParams.get('address-role'), 'receiver');
  assert.equal(Buffer.from(urls[0].searchParams.get('note-prefix')!, 'base64').toString(), memo);
  assert.equal(urls[1].searchParams.get('next'), 'p2');
});
