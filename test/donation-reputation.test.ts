import assert from 'node:assert/strict';
import { test } from 'node:test';
import { suggestedDonation } from '../src/donation.ts';
import { parseUsd } from '../src/pricing.ts';
import { advertiserRecord } from '../src/reputation.ts';
import { DAY } from './helpers.ts';

test('the suggested donation is 2%, to the nearest cent and at least a cent', () => {
  assert.equal(suggestedDonation(parseUsd('505')), parseUsd('10.10'));
  assert.equal(suggestedDonation(parseUsd('0.10')), parseUsd('0.01'));
  assert.equal(suggestedDonation(parseUsd('12.34')), parseUsd('0.25'));
});

test('an advertiser’s record counts payments, overdue deals and the median wait', () => {
  const t = 1_790_000_000;
  const record = advertiserRecord([
    { deliveredAt: t, paidAt: t + 2 * DAY },
    { deliveredAt: t, paidAt: t + 4 * DAY },
    { deliveredAt: t - 30 * DAY },
    { deliveredAt: t - DAY },
  ], t);
  assert.deepEqual(record, { delivered: 4, paid: 2, overdue: 1, medianDaysToPay: 3 });
  assert.equal(advertiserRecord([], t).medianDaysToPay, undefined);
});
