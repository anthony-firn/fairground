import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { encodeAddressKey, signingBytes } from '../src/algotx.ts';
import { generateSecretKey } from 'nostr-tools/pure';
import { createGateway } from '../src/gateway.ts';
import { authHeader, verifyAuthHeader } from '../src/httpauth.ts';
import { createAlgorandUsdcRail } from '../src/rails/algorand.ts';
import { createRamp, sellOrderProblem } from '../src/ramp.ts';
import { createStarter, starterTxns, type StartRequest } from '../src/starter.ts';
import { confirmed, feesLeft, sign, STARTER_MICROALGOS, submit, suggestedParams, usdcPayment, walletKeys, walletState } from '../src/wallet.ts';
import { startDevRelay } from '../tools/dev-relay.ts';
import { ALGOD, createFakeChain, INDEXER } from './fakechain.ts';
import { actor } from './helpers.ts';

const sponsorSeed = randomBytes(32);
const SPONSOR_KEY = bytesToHex(sponsorSeed);
const SPONSOR = encodeAddressKey(ed25519.getPublicKey(sponsorSeed));

/** Builds and signs a wallet's half of the starter group, as the app does. */
async function startRequest(chain: ReturnType<typeof createFakeChain>, nostrKey: Uint8Array, member: string): Promise<{ keys: ReturnType<typeof walletKeys>; signed: StartRequest }> {
  const keys = walletKeys(nostrKey);
  const params = await suggestedParams(ALGOD, chain.fetch);
  const [, optIn] = starterTxns(SPONSOR, keys.address, member, params);
  const signed = { address: keys.address, firstValid: String(params.firstValid), lastValid: String(params.lastValid), sig: base64.encode(ed25519.sign(signingBytes(optIn), keys.seed)) };
  return { keys, signed };
}

test('the wallet key comes from the account key, so the backup restores it', () => {
  const key = generateSecretKey();
  const a = walletKeys(key);
  assert.deepEqual(walletKeys(key), a);
  assert.match(a.address, /^[A-Z2-7]{58}$/);
  assert.notEqual(walletKeys(generateSecretKey()).address, a.address);
});

test('a sponsor starts a new wallet in one group: ALGO for the minimum and fees, plus the USDC opt-in', async () => {
  const chain = createFakeChain();
  chain.fund(SPONSOR, 10_000_000n);
  const starter = createStarter({ key: SPONSOR_KEY, algod: ALGOD, indexer: INDEXER, fetch: chain.fetch, dailyCap: 2 });
  const [m1, m2, m3] = [actor(), actor(), actor()];
  const r1 = await startRequest(chain, m1.nostrKey, m1.pubkey);
  assert.equal((await walletState(r1.keys.address, ALGOD, chain.fetch)).active, false);
  assert.ok('txid' in (await starter.start(m1.pubkey, r1.signed)));
  const state = await walletState(r1.keys.address, ALGOD, chain.fetch);
  assert.equal(state.active, true);
  assert.equal(state.algo, STARTER_MICROALGOS, 'the opt-in fee was pooled into the sponsor’s payment');
  assert.equal(feesLeft(state), 50);

  assert.equal((await starter.start(m1.pubkey, (await startRequest(chain, m1.nostrKey, m1.pubkey)).signed) as { status: number }).status, 409, 'once per wallet');
  const again = await startRequest(chain, generateSecretKey(), m1.pubkey);
  assert.equal((await starter.start(m1.pubkey, again.signed) as { status: number }).status, 409, 'once per member');
  const forged = await startRequest(chain, m2.nostrKey, m3.pubkey);
  assert.equal((await starter.start(m2.pubkey, forged.signed) as { status: number }).status, 400, 'the opt-in must be for the member asking');
  assert.equal((await starter.start(m2.pubkey, { address: 'nope', firstValid: '1', lastValid: '2', sig: 'AA' }) as { status: number }).status, 400);
  assert.ok('txid' in (await starter.start(m2.pubkey, (await startRequest(chain, m2.nostrKey, m2.pubkey)).signed)));
  assert.equal((await starter.start(m3.pubkey, (await startRequest(chain, m3.nostrKey, m3.pubkey)).signed) as { status: number }).status, 429, 'a daily cap');
});

test('paying from the wallet sends USDC with the memo, and the existing payment checks find it', async () => {
  const chain = createFakeChain();
  const payer = walletKeys(generateSecretKey());
  const payee = walletKeys(generateSecretKey());
  chain.fund(payer.address, STARTER_MICROALGOS, 5_000_000n);
  const params = await suggestedParams(ALGOD, chain.fetch);
  const send = (to: string, amount: bigint) => submit([sign(usdcPayment(payer.address, { to, amount, memo: 'fairground:deal:abc' }, params), payer.seed)], ALGOD, chain.fetch);
  await assert.rejects(send(payee.address, 1_000_000n), /not opted in/, 'the payee must be able to receive USDC');
  chain.fund(payee.address, 200_000n, 0n);
  const txid = await send(payee.address, 2_000_000n);
  await confirmed(txid, ALGOD, chain.fetch, 1, 0);
  const transfer = await createAlgorandUsdcRail(INDEXER, chain.fetch).fetchTransfer(txid);
  assert.equal(transfer.note, 'fairground:deal:abc');
  assert.equal(transfer.amount, 2_000_000n);
  assert.equal(transfer.receiver, payee.address);
  assert.equal((await walletState(payer.address, ALGOD, chain.fetch)).usdc, 3_000_000n);
  assert.equal((await walletState(payer.address, ALGOD, chain.fetch)).algo, STARTER_MICROALGOS - 1000n, 'only the network fee in ALGO');
});

test('signed HTTP requests (NIP-98) name the URL, method and body, and expire', () => {
  const key = generateSecretKey();
  const url = 'https://gw.test/fairground/wallet/start';
  const header = authHeader(key, url, 'POST', '{"a":1}');
  assert.ok('pubkey' in verifyAuthHeader(header, url, 'POST', '{"a":1}'));
  assert.match((verifyAuthHeader(header, url, 'POST', '{"a":2}') as { error: string }).error, /body/);
  assert.match((verifyAuthHeader(header, 'https://gw.test/other', 'POST', '{"a":1}') as { error: string }).error, /another request/);
  assert.match((verifyAuthHeader(header, url, 'POST', '{"a":1}', Math.floor(Date.now() / 1000) + 120) as { error: string }).error, /expired/);
  assert.match((verifyAuthHeader(null, url, 'POST') as { error: string }).error, /missing/);
});

/** Transak's partner API, as far as the gateway uses it. */
function fakeTransak(customer: string, wallet: string) {
  const calls: { url: string; headers: Headers; body?: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/partners/api/v2/refresh-token')) return Response.json({ data: { accessToken: 'token-1', expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400 } });
    if (url.endsWith('/api/v2/auth/session')) return Response.json({ data: { widgetUrl: 'https://global-stg.transak.com/?sessionId=s1' } });
    if (url.includes('/partners/api/v2/order/')) {
      return Response.json({ data: { status: 'AWAITING_PAYMENT_FROM_USER', isBuyOrSell: 'SELL', cryptoCurrency: 'USDC', network: 'algorand', cryptoAmount: 10, fiatAmount: 9.8, fiatCurrency: 'USD', walletAddress: wallet, partnerCustomerId: customer } });
    }
    return new Response('no', { status: 404 });
  };
  return { fetch: fetchImpl, calls };
}

test('Transak sessions are made on the server, and sales are checked before the wallet pays into them', async () => {
  const member = actor();
  const deposit = walletKeys(generateSecretKey()).address;
  const t = fakeTransak(member.pubkey, deposit);
  const ramp = createRamp({ apiKey: 'key', apiSecret: 'secret', environment: 'staging', referrerDomain: 'www.evolvetech.dev', fetch: t.fetch });
  const buyer = walletKeys(member.nostrKey).address;
  assert.equal(await ramp.session({ side: 'BUY', walletAddress: buyer, customer: member.pubkey, fiatAmount: 25, redirectURL: 'https://app.test/', userIp: '1.2.3.4' }), 'https://global-stg.transak.com/?sessionId=s1');
  await ramp.session({ side: 'SELL', walletAddress: buyer, customer: member.pubkey, cryptoAmount: 10, redirectURL: 'https://app.test/', userIp: '1.2.3.4' });
  assert.equal(t.calls.filter((c) => c.url.endsWith('refresh-token')).length, 1, 'the partner token is reused');
  const [buy, sell] = t.calls.filter((c) => c.url.endsWith('/auth/session'));
  assert.equal(buy.headers.get('access-token'), 'token-1');
  assert.equal(buy.headers.get('x-user-ip'), '1.2.3.4');
  const wp = buy.body!.widgetParams as Record<string, unknown>;
  assert.equal(wp.walletAddress, buyer);
  assert.equal(wp.disableWalletAddressForm, true);
  assert.equal(wp.network, 'algorand');
  assert.equal(wp.cryptoCurrencyCode, 'USDC');
  assert.equal((sell.body!.widgetParams as Record<string, unknown>).walletRedirection, true);
  assert.equal(buy.headers.get('api-secret'), null, 'the secret goes only to the token endpoint');

  const order = await ramp.order('order-123');
  assert.equal(sellOrderProblem(order, member.pubkey), undefined);
  assert.match(sellOrderProblem(order, actor().pubkey) ?? '', /someone else/);
  assert.match(sellOrderProblem({ ...order, status: 'COMPLETED' }, member.pubkey) ?? '', /isn’t waiting/);
  assert.match(sellOrderProblem({ ...order, network: 'ethereum' }, member.pubkey) ?? '', /USDC on Algorand/);
});

test('the gateway starts wallets and opens Transak only for signed requests from Fairground members', async () => {
  const relay = await startDevRelay(7796);
  try {
    const chain = createFakeChain();
    chain.fund(SPONSOR, 10_000_000n);
    const member = actor();
    const stranger = actor();
    relay.events.push(member.binding);
    const t = fakeTransak(member.pubkey, walletKeys(generateSecretKey()).address);
    const both: typeof fetch = (input, init) => (String(input).includes('transak') ? t.fetch(input, init) : chain.fetch(input, init));
    const gw = createGateway({
      relays: [relay.url], base: '/fg', appUrl: 'https://app.test/', fetch: both,
      starter: { key: SPONSOR_KEY, algod: ALGOD, indexer: INDEXER },
      ramp: { apiKey: 'key', apiSecret: 'secret', environment: 'staging', referrerDomain: 'app.test' },
    });
    const post = (who: typeof member, path: string, body: object) => {
      const url = `https://gw.test/fg${path}`;
      const text = JSON.stringify(body);
      return gw(new Request(url, { method: 'POST', body: text, headers: { Authorization: authHeader(who.nostrKey, url, 'POST', text), 'Content-Type': 'application/json' } }), { ip: '5.6.7.8' });
    };
    assert.deepEqual(await (await gw(new Request('https://gw.test/fg/wallet/config'))).json(), { starter: SPONSOR, ramp: true });

    const { keys, signed } = await startRequest(chain, member.nostrKey, member.pubkey);
    const started = await post(member, '/wallet/start', signed);
    assert.equal(started.status, 200, await started.clone().text());
    assert.equal((await walletState(keys.address, ALGOD, chain.fetch)).active, true);
    assert.equal((await post(stranger, '/wallet/start', (await startRequest(chain, stranger.nostrKey, stranger.pubkey)).signed)).status, 403, 'members only');
    const unsigned = await gw(new Request('https://gw.test/fg/wallet/start', { method: 'POST', body: '{}' }));
    assert.equal(unsigned.status, 401);

    const session = await post(member, '/ramp/session', { side: 'BUY', walletAddress: keys.address, amount: 20, redirectURL: 'https://app.test/' });
    assert.equal((await session.json()).url, 'https://global-stg.transak.com/?sessionId=s1');
    assert.equal(t.calls.find((c) => c.url.endsWith('/auth/session'))!.headers.get('x-user-ip'), '5.6.7.8');
    assert.equal((t.calls.find((c) => c.url.endsWith('/auth/session'))!.body!.widgetParams as Record<string, unknown>).partnerCustomerId, member.pubkey);

    const orderUrl = 'https://gw.test/fg/ramp/order/order-123';
    const order = await gw(new Request(orderUrl, { headers: { Authorization: authHeader(member.nostrKey, orderUrl, 'GET') } }));
    const body = await order.json();
    assert.equal(body.problem, null);
    assert.equal(body.order.cryptoAmount, 10);

    const off = createGateway({ relays: [relay.url], base: '/fg', appUrl: 'https://app.test/', fetch: both });
    assert.deepEqual(await (await off(new Request('https://gw.test/fg/wallet/config'))).json(), { starter: null, ramp: false });
  } finally {
    await relay.close();
  }
});
