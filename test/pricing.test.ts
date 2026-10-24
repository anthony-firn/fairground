import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keyLookup } from '../src/pq.ts';
import {
  createIndexAttestation,
  DEFAULT_INDEX,
  formatUsd,
  indexedAmount,
  parseIndexValue,
  parseUsd,
  resolvedPeriods,
  resolveIndexValue,
  type IndexedPrice,
} from '../src/pricing.ts';
import { actor, fromRelay } from './helpers.ts';

// Index values here are illustrative, not real CPI readings.
const price = (usd: string): IndexedPrice => ({ amount: parseUsd(usd), currency: 'USD', index: DEFAULT_INDEX, basePeriod: '2026-08' });

test('dollar amounts parse to micro-dollars and format back', () => {
  assert.equal(parseUsd('500'), 500_000_000n);
  assert.equal(parseUsd('0.000001'), 1n);
  assert.equal(formatUsd(502_500_000n), '502.50');
  assert.equal(formatUsd(1n), '0.000001');
  assert.throws(() => parseUsd('5e2'));
  assert.throws(() => parseUsd('1.0000001'));
});

test('index values parse to thousandths and must be positive', () => {
  assert.equal(parseIndexValue('324.368'), 324_368n);
  assert.equal(parseIndexValue('300'), 300_000n);
  assert.throws(() => parseIndexValue('0'));
  assert.throws(() => parseIndexValue('-1'));
});

test('a price rises with the index, rounds up for the creator, and never drops below nominal', () => {
  assert.equal(indexedAmount(price('500'), 330_000n, 333_300n), parseUsd('505'));
  assert.equal(indexedAmount({ ...price('500'), amount: 1n }, 3n, 4n), 2n);
  assert.equal(indexedAmount(price('500'), 330_000n, 320_000n), parseUsd('500'));
});

const [p1, p2, stranger] = [actor(), actor(), actor()];
const lookup = keyLookup([p1.binding, p2.binding, stranger.binding]);
const policy = { index: DEFAULT_INDEX, publishers: [p1.pubkey, p2.pubkey], threshold: 2 };
const attest = (who: typeof p1, period: string, value: string, created_at = 1_790_000_000) =>
  fromRelay(createIndexAttestation(who.nostrKey, who.pq, { index: DEFAULT_INDEX, period, value, source: 'https://www.bls.gov/cpi/' }, created_at));

test('an index value counts when enough trusted publishers agree', () => {
  const agreed = [attest(p1, '2026-08', '330.0'), attest(p2, '2026-08', '330.000')];
  assert.equal(resolveIndexValue(agreed, policy, '2026-08', lookup), 330_000n);
  assert.equal(resolveIndexValue(agreed.slice(0, 1), policy, '2026-08', lookup), undefined, 'one is below threshold');
});

test('disagreement, untrusted publishers and late attestations do not count', () => {
  const split = [attest(p1, '2026-08', '330.000'), attest(p2, '2026-08', '331.000')];
  assert.equal(resolveIndexValue(split, policy, '2026-08', lookup), undefined);

  const outsider = [attest(p1, '2026-08', '330.000'), attest(stranger, '2026-08', '330.000')];
  assert.equal(resolveIndexValue(outsider, policy, '2026-08', lookup), undefined);

  const late = [attest(p1, '2026-08', '330.000', 100), attest(p2, '2026-08', '330.000', 200)];
  assert.equal(resolveIndexValue(late, policy, '2026-08', lookup, 150), undefined);
  assert.equal(resolveIndexValue(late, policy, '2026-08', lookup, 200), 330_000n);

  const flipFlop = [...late, attest(p1, '2026-08', '329.000', 300)];
  assert.equal(resolveIndexValue(flipFlop, policy, '2026-08', lookup), undefined);
});

test('resolved periods are listed newest first', () => {
  const all = ['2026-08', '2026-09', '2026-10'].flatMap((period) => [attest(p1, period, '330'), attest(p2, period, '330')]);
  all.push(attest(p1, '2026-11', '331'));
  assert.deepEqual(resolvedPeriods(all, policy, lookup), ['2026-10', '2026-09', '2026-08']);
});
