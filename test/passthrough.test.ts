import assert from 'node:assert/strict';
import { test } from 'node:test';
import algosdk from 'algosdk';
import { generateSecretKey } from 'nostr-tools/pure';
import { algoToBuy, BUFFER_BPS, MAX_RECIPIENTS, paidAlready, PASS_THROUGH_RESERVE, passThrough, type PassThrough } from '../src/passthrough.ts';
import { createAlgorandUsdcRail } from '../src/rails/algorand.ts';
import { transferProblem, type PaymentRequest } from '../src/rails/rail.ts';
import { walletKeys } from '../src/wallet.ts';
import { ALGOD, createFakeChain, createFakeRouter, INDEXER } from './fakechain.ts';

/** A fake chain and router where ALGO is worth $0.10, a payer with an empty wallet, and recipients set up for USDC. */
function setup() {
  const chain = createFakeChain();
  const router = createFakeRouter(0.1);
  const net = { algod: ALGOD, fetch: chain.fetch, router: router.api, routerFetch: router.fetch };
  const payer = walletKeys(generateSecretKey());
  const recipient = () => {
    const address = algosdk.generateAccount().addr.toString();
    chain.fund(address, 200_000n, 0n);
    return address;
  };
  return { chain, net, payer, recipient, rail: createAlgorandUsdcRail(INDEXER, chain.fetch) };
}
const paid = (r: PassThrough) => {
  assert.equal(r.status, 'paid');
  return (r as Extract<PassThrough, { status: 'paid' }>).transfers;
};

test('paying without a balance: the ALGO bought becomes the exact USDC payment, and the wallet closes empty', async () => {
  const { chain, net, payer, recipient, rail } = setup();
  const creator = recipient();
  const request = { to: creator, amount: 5_000_000n, memo: 'fairground:support:abc' };
  let setUp = false;
  const opts = { ...net, ownsHolding: false, onSetUp: () => { setUp = true; } };
  assert.deepEqual(await passThrough(payer, [request], opts), { status: 'waiting', algo: 0n });
  const need = await algoToBuy(request.amount, net);
  assert.equal(need, (50_000_000n * (10_000n + BUFFER_BPS)) / 10_000n + PASS_THROUGH_RESERVE + 1_000n, 'the quote, the buffer and the reserve');
  chain.fund(payer.address, need); // What the card purchase delivers.
  const [t] = paid(await passThrough(payer, [request], opts));
  assert.ok(setUp);
  assert.equal(transferProblem(request, await rail.fetchTransfer(t.id)), undefined, 'the usual payment check accepts it');
  assert.deepEqual(chain.accounts.get(payer.address), { algo: 0n, usdc: null }, 'nothing left in the wallet, nothing locked');
  const got = chain.accounts.get(creator)!;
  assert.ok(got.usdc! > 5_000_000n && got.usdc! < 5_200_000n, `the payment and a few cents of buffer: ${got.usdc}`);
  assert.ok(got.algo > 400_000n, `and the minimums the payer's wallet released: ${got.algo}`);
  assert.deepEqual((await paidAlready(payer.address, [request], 0, rail))?.map((x) => x.id), [t.id], 'found again after a reload');
});

test('one purchase pays several recipients in one step; the first also receives what is left', async () => {
  const { chain, net, payer, recipient, rail } = setup();
  const [dev, relay] = [recipient(), recipient()];
  const requests = [{ to: dev, amount: 2_500_000n, memo: 'fairground:development' }, { to: relay, amount: 2_500_000n, memo: 'fairground:relay:wss://r.test' }];
  chain.fund(payer.address, await algoToBuy(5_000_000n, net));
  const transfers = paid(await passThrough(payer, requests, { ...net, ownsHolding: false }));
  assert.deepEqual(transfers.map((t) => [t.receiver, t.amount, t.note]), requests.map((r) => [r.to, r.amount, r.memo]));
  for (const [i, t] of transfers.entries()) assert.equal(transferProblem(requests[i], await rail.fetchTransfer(t.id)), undefined);
  assert.equal(chain.accounts.get(relay)!.usdc, 2_500_000n, 'exactly their share');
  assert.ok(chain.accounts.get(dev)!.usdc! > 2_500_000n, 'the first recipient also gets the buffer');
  assert.deepEqual(chain.accounts.get(payer.address), { algo: 0n, usdc: null });
});

test('if prices moved during checkout it waits for more ALGO, losing nothing; donations pay what arrived', async () => {
  const { chain, net, payer, recipient } = setup();
  const creator = recipient();
  const request = { to: creator, amount: 5_000_000n, memo: 'fairground:order:1' };
  let owns = false;
  const opts = () => ({ ...net, ownsHolding: owns, onSetUp: () => { owns = true; } });
  chain.fund(payer.address, 30_000_000n + PASS_THROUGH_RESERVE + 1_000n); // About $3 of a $5 payment.
  const short = await passThrough(payer, [request], opts());
  assert.equal(short.status, 'short');
  assert.ok(owns, 'the payment set the holding up, so it may still close it');
  assert.equal(chain.accounts.get(creator)!.usdc, 0n, 'nothing paid yet');
  chain.fund(payer.address, 25_000_000n); // The rest arrives.
  paid(await passThrough(payer, [request], opts()));
  assert.ok(chain.accounts.get(creator)!.usdc! >= 5_000_000n);
  assert.deepEqual(chain.accounts.get(payer.address), { algo: 0n, usdc: null });

  const donor = walletKeys(generateSecretKey());
  const [dev, relay] = [recipient(), recipient()];
  chain.fund(donor.address, 30_000_000n + PASS_THROUGH_RESERVE + 1_000n);
  const split = [{ to: dev, amount: 2_500_000n, memo: 'fairground:development' }, { to: relay, amount: 2_500_000n, memo: 'fairground:relay:wss://r.test' }];
  const transfers = paid(await passThrough(donor, split, { ...net, ownsHolding: false, flexible: true }));
  assert.equal(transfers[0].amount, transfers[1].amount, 'split the same way');
  assert.ok(transfers[1].amount > 1_400_000n && transfers[1].amount < 2_500_000n, `what arrived: ${transfers[1].amount}`);
  assert.equal(chain.accounts.get(relay)!.usdc, transfers[1].amount);
  assert.deepEqual(chain.accounts.get(donor.address), { algo: 0n, usdc: null });
});

test('it never closes a wallet holding its owner’s balance, and a recipient who can’t receive stops it safely', async () => {
  const { chain, net, payer, recipient } = setup();
  const creator = recipient();
  const request: PaymentRequest = { to: creator, amount: 5_000_000n, memo: 'fairground:support:abc' };
  const saver = walletKeys(generateSecretKey());
  chain.fund(saver.address, 1_000_000n, 20_000_000n); // An ordinary wallet with $20 in it.
  await assert.rejects(passThrough(saver, [request], { ...net, ownsHolding: false }), /holds a balance/);
  assert.equal(chain.accounts.get(saver.address)!.usdc, 20_000_000n);
  await assert.rejects(passThrough(payer, [{ ...request, to: payer.address }], { ...net, ownsHolding: false }), /isn’t a payment/);
  await assert.rejects(passThrough(payer, Array.from({ length: MAX_RECIPIENTS + 1 }, () => request), { ...net, ownsHolding: false }), /recipients at once/);

  const stranger = algosdk.generateAccount().addr.toString(); // Never set up to hold USDC.
  chain.fund(payer.address, await algoToBuy(request.amount, net));
  await assert.rejects(passThrough(payer, [{ ...request, to: stranger }], { ...net, ownsHolding: false }));
  assert.ok(chain.accounts.get(payer.address)!.usdc! > 5_000_000n, 'the converted dollars are still the payer’s');
});
