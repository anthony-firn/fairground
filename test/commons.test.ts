import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from '@noble/hashes/utils.js';
import {
  chooseRecipient,
  createRelayPayout,
  creditRelays,
  fetchRelayOperator,
  operatorWeights,
  parseRelayPayout,
  passOnStatus,
  splitByWeight,
  splitDonation,
  verifiedRelayPayouts,
  type RelayPayout,
} from '../src/commons.ts';
import { MEMO, normalizeRelayUrl } from '../src/memos.ts';
import { keyLookup } from '../src/pq.ts';
import { parseUsd } from '../src/pricing.ts';
import { encodeAddress, RAIL } from '../src/rails/algorand.ts';
import type { Rail, Transfer, TransferQuery } from '../src/rails/rail.ts';
import { periodBounds } from '../src/support.ts';
import { actor, fromRelay } from './helpers.ts';

const [alice, bob, mallory] = [actor(), actor(), actor()];
const pqKeyOf = keyLookup([alice, bob, mallory].map((a) => a.binding));
const addr = () => encodeAddress(randomBytes(32));

const payout = (who: typeof alice, relays: string[], passOn = 20, payTo = addr()): RelayPayout =>
  parseRelayPayout(fromRelay(createRelayPayout(who.nostrKey, who.pq, { relays, rail: RAIL, payTo, passOn })), pqKeyOf)!;

test('relay URLs are normalized so one relay has one name', () => {
  assert.equal(normalizeRelayUrl('wss://Relay.Example.com/'), 'wss://relay.example.com');
  assert.equal(MEMO.relay('wss://relay.example.com/'), 'fairground:relay:wss://relay.example.com');
  assert.throws(() => normalizeRelayUrl('https://relay.example.com'));
});

test('a payout round-trips and needs the operator’s post-quantum signature', () => {
  const p = payout(alice, ['wss://A.example/', 'wss://a.example']);
  assert.deepEqual(p.relays, ['wss://a.example']);
  assert.equal(p.passOn, 20);
  assert.equal(parseRelayPayout(p.event, () => undefined), undefined);
  assert.throws(() => createRelayPayout(alice.nostrKey, alice.pq, { relays: ['wss://a.example'], rail: RAIL, payTo: addr(), passOn: 150 }));
});

test('a payout counts only for relays whose information document names its author', async () => {
  const honest = payout(alice, ['wss://a.example']);
  const impostor = payout(mallory, ['wss://a.example', 'wss://m.example']);
  const operators: Record<string, string> = { 'wss://a.example': alice.pubkey, 'wss://m.example': mallory.pubkey };
  const verified = await verifiedRelayPayouts([honest, impostor], async (url) => operators[url]);
  assert.equal(verified.get('wss://a.example')?.operator, alice.pubkey);
  assert.equal(verified.get('wss://m.example')?.operator, mallory.pubkey);
});

test('the relay operator is read from NIP-11 over HTTPS', async () => {
  let asked = '';
  const operator = await fetchRelayOperator('wss://relay.example.com/', async (url, init) => {
    asked = `${url} ${(init?.headers as Record<string, string>).Accept}`;
    return new Response(JSON.stringify({ name: 'Example', pubkey: alice.pubkey }));
  });
  assert.equal(operator, alice.pubkey);
  assert.equal(asked, 'https://relay.example.com application/nostr+json');
  assert.equal(await fetchRelayOperator('wss://x.example', async () => new Response('not json')), undefined);
});

test('relays earn only for events they delivered first to a reader who saw them', () => {
  const deliveries = [
    { relay: 'wss://a.example', eventId: 'e1' },
    { relay: 'wss://farm.example', eventId: 'e1' },
    { relay: 'wss://b.example', eventId: 'e2' },
    { relay: 'wss://a.example', eventId: 'e3' },
    { relay: 'wss://farm.example', eventId: 'unread' },
  ];
  const credits = creditRelays(deliveries, new Set(['e1', 'e2', 'e3']));
  assert.deepEqual(Object.fromEntries(credits), { 'wss://a.example': 2, 'wss://b.example': 1 });
});

test('an operator with many relays is one recipient, weighted by total service', () => {
  const a = payout(alice, ['wss://a1.example', 'wss://a2.example', 'wss://a3.example']);
  const b = payout(bob, ['wss://b.example']);
  const payouts = new Map([...a.relays.map((r) => [r, a] as const), ['wss://b.example', b]]);
  const credits = new Map([['wss://a1.example', 1], ['wss://a2.example', 1], ['wss://a3.example', 1], ['wss://b.example', 3], ['wss://unpaid.example', 9]]);
  const shares = operatorWeights(credits, payouts);
  assert.deepEqual([...shares].map(([k, s]) => [k, s.weight]), [[alice.pubkey, 3], [bob.pubkey, 3]]);
});

test('the relay share rotates so each operator receives its fair share over time', () => {
  const weights = new Map([['a', 3], ['b', 1]]);
  const given = new Map<string, bigint>();
  for (let i = 0; i < 8; i++) {
    const to = chooseRecipient(weights, given, 100n)!;
    given.set(to, (given.get(to) ?? 0n) + 100n);
  }
  assert.deepEqual(Object.fromEntries(given), { a: 600n, b: 200n });
  assert.equal(chooseRecipient(new Map(), new Map(), 100n), undefined);
});

test('donations split between development and relays, or all to development when no relay can receive', () => {
  assert.deepEqual(splitDonation(parseUsd('10.10'), 50, true), { development: parseUsd('5.05'), relays: parseUsd('5.05') });
  assert.deepEqual(splitDonation(parseUsd('10.10'), 50, false), { development: parseUsd('10.10'), relays: 0n });
  assert.throws(() => splitDonation(1n, 101, true));
});

test('splitting by weight is exact to the cent', () => {
  const split = splitByWeight(parseUsd('1.00'), new Map([['x', 1], ['y', 1], ['z', 1]]));
  assert.deepEqual([...split.values()].reduce((a, b) => a + b, 0n), parseUsd('1.00'));
  assert.deepEqual([...split.values()].sort(), [parseUsd('0.33'), parseUsd('0.33'), parseUsd('0.34')].sort());
});

/** A rail whose chain holds the given transfers. */
function chainWith(transfers: Transfer[]): Rail {
  return {
    id: RAIL, label: 'test', isAddress: () => true, canReceive: async () => true, paymentLink: () => '',
    fetchTransfer: async () => { throw new Error('unused'); },
    listTransfers: async ({ address, role, notePrefix, from, to }: TransferQuery) => transfers.filter((t) =>
      (role === 'receiver' ? t.receiver : t.sender) === address && t.note.startsWith(notePrefix) && t.time >= from && t.time < to),
  };
}

test('a relay’s pass-on pledge is checked from the chain, ignoring payments to itself', async () => {
  const p = payout(alice, ['wss://a.example'], 20);
  const [sept] = periodBounds('2026-09');
  const [oct] = periodBounds('2026-10');
  const t = (over: Partial<Transfer>): Transfer => ({ id: 'x', sender: addr(), receiver: p.payTo, amount: 0n, note: '', time: sept + 10, ...over });
  const chain = [
    t({ amount: parseUsd('100'), note: MEMO.relay('wss://a.example') }),
    t({ amount: parseUsd('900'), note: MEMO.relay('wss://someone-else.example') }),
    t({ sender: p.payTo, receiver: addr(), amount: parseUsd('15'), note: MEMO.support(bob.pubkey), time: oct + 10 }),
    t({ sender: p.payTo, receiver: addr(), amount: parseUsd('50'), note: MEMO.support(alice.pubkey), time: oct + 20 }),
  ];
  assert.deepEqual(await passOnStatus(p, chainWith(chain), '2026-10'),
    { received: parseUsd('100'), due: parseUsd('20'), paid: parseUsd('15'), kept: false });

  chain.push(t({ sender: p.payTo, receiver: addr(), amount: parseUsd('5'), note: MEMO.support(bob.pubkey), time: oct + 30 }));
  assert.equal((await passOnStatus(p, chainWith(chain), '2026-10')).kept, true);
});
