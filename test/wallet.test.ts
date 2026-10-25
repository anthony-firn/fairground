import assert from 'node:assert/strict';
import { test } from 'node:test';
import algosdk from 'algosdk';
import { generateSecretKey } from 'nostr-tools/pure';
import { applicationAddress, assetTxn, decodeTxn, encodeTxn, signRaw, signTxn } from '../src/algotx.ts';
import { createGateway } from '../src/gateway.ts';
import { authHeader, verifyAuthHeader } from '../src/httpauth.ts';
import { createAlgorandUsdcRail, USDC_ASSET_ID } from '../src/rails/algorand.ts';
import { createRamp, sellOrderProblem } from '../src/ramp.ts';
import { minReceive, prepareSwap, quoteSwap, ROUTER_APP, signSwap, swapProblem } from '../src/swap.ts';
import { confirmed, convertibleAlgo, feesLeft, needsFeeTopUp, RESERVE_MICROALGOS, sign, submit, suggestedParams, usdcPayment, walletKeys, walletState } from '../src/wallet.ts';
import { startDevRelay } from '../tools/dev-relay.ts';
import { ALGOD, createFakeChain, createFakeRouter, INDEXER } from './fakechain.ts';
import { actor } from './helpers.ts';

test('the wallet key comes from the account key, so the backup restores it', () => {
  const key = generateSecretKey();
  const a = walletKeys(key);
  assert.deepEqual(walletKeys(key), a);
  assert.ok(algosdk.isValidAddress(a.address));
  assert.notEqual(walletKeys(generateSecretKey()).address, a.address);
});

test('an unfunded account is shown as an empty wallet ready for its first deposit', async () => {
  const address = walletKeys(generateSecretKey()).address;
  const state = await walletState(address, ALGOD, async () => new Response(null, { status: 404 }));
  assert.deepEqual(state, { address, algo: 0n, minimum: 100_000n, usdc: 0n, active: false });
});

test('decoding, signing exact bytes and application addresses match the Algorand SDK', () => {
  const keys = walletKeys(generateSecretKey());
  const sdkAccount = { addr: keys.address, sk: new Uint8Array([...keys.seed, ...algosdk.decodeAddress(keys.address).publicKey]) };
  const t = algosdk.makeApplicationNoOpTxnFromObject({
    sender: keys.address, appIndex: ROUTER_APP, appArgs: [new Uint8Array([0xf0, 0x67, 0x14, 0xc8]), algosdk.encodeUint64(5)], foreignAssets: [0, USDC_ASSET_ID],
    suggestedParams: { flatFee: true, fee: 7000n, minFee: 1000n, firstValid: 1n, lastValid: 1001n, genesisID: 'mainnet-v1.0', genesisHash: new Uint8Array(32).fill(1) },
  });
  const raw = algosdk.encodeUnsignedTransaction(t);
  const decoded = decodeTxn(raw);
  assert.equal(decoded.type, 'appl');
  assert.equal(decoded.apid, ROUTER_APP);
  assert.equal(Buffer.from(encodeTxn(decoded)).toString('hex'), Buffer.from(raw).toString('hex'), 'decoding and re-encoding is lossless');
  assert.equal(Buffer.from(signRaw(raw, keys.seed)).toString('hex'), Buffer.from(t.signTxn(sdkAccount.sk)).toString('hex'));
  assert.equal(applicationAddress(ROUTER_APP), algosdk.getApplicationAddress(ROUTER_APP).toString());
});

test('a first deposit of ALGO sets the wallet up: it opts in, keeps a reserve and converts the rest to dollars', async () => {
  const chain = createFakeChain();
  const router = createFakeRouter(0.1);
  const keys = walletKeys(generateSecretKey());
  chain.fund(keys.address, 200_000_000n); // 200 ALGO bought with a card.
  const params = await suggestedParams(ALGOD, chain.fetch);
  // Opt in, signed on the device.
  await submit([signTxn(assetTxn(keys.address, keys.address, USDC_ASSET_ID, 0n, params), keys.seed)], ALGOD, chain.fetch);
  const before = await walletState(keys.address, ALGOD, chain.fetch);
  assert.equal(before.active, true);
  const amount = before.algo - RESERVE_MICROALGOS - 10_000n;
  const q = await quoteSwap(0, USDC_ASSET_ID, amount, router.fetch, router.api);
  const raw = await prepareSwap(keys.address, q, router.fetch, router.api);
  assert.equal(swapProblem(raw, keys.address, q), undefined);
  await confirmed(await submit(signSwap(raw, keys.seed), ALGOD, chain.fetch), ALGOD, chain.fetch, 1, 0);
  const after = await walletState(keys.address, ALGOD, chain.fetch);
  assert.equal(after.usdc, minReceive(q));
  assert.ok(Math.abs(Number(after.usdc) - 19_950_000) < 200_000, `about $19.95 from 200 ALGO at $0.10: ${after.usdc}`);
  assert.ok(after.algo >= after.minimum && feesLeft(after) > 250, 'a reserve stays for fees');
  assert.equal(convertibleAlgo(after), 0n, 'nothing left to convert');
  assert.equal(convertibleAlgo({ ...after, algo: after.algo + 5_000_000n }), after.algo + 5_000_000n - RESERVE_MICROALGOS - 10_000n, 'more ALGO arriving is converted');
  assert.equal(needsFeeTopUp(after), false);
  assert.equal(needsFeeTopUp({ ...after, algo: after.minimum + 20_000n }), true, 'low on fees, with dollars to spare');
  assert.equal(needsFeeTopUp({ ...after, algo: after.minimum + 20_000n, usdc: 0n }), false);
});

test('the wallet refuses router transactions that do anything but the quoted swap', async () => {
  const router = createFakeRouter(0.1);
  const keys = walletKeys(generateSecretKey());
  const q = await quoteSwap(0, USDC_ASSET_ID, 10_000_000n, router.fetch, router.api);
  const raw = await prepareSwap(keys.address, q, router.fetch, router.api);
  const tamper = (i: number, change: (t: ReturnType<typeof decodeTxn>) => void) => {
    const copy: Uint8Array[] = raw.map((r) => r.slice());
    const t = decodeTxn(copy[i]);
    change(t);
    copy[i] = encodeTxn(t);
    return swapProblem(copy, keys.address, q);
  };
  const thief = algosdk.decodeAddress(walletKeys(generateSecretKey()).address).publicKey;
  assert.match(tamper(0, (t) => (t.rcv = thief)) ?? '', /router/);
  assert.match(tamper(0, (t) => (t.amt = 99_000_000n)) ?? '', /router/);
  assert.match(tamper(1, (t) => (t.rekey = thief)) ?? '', /hand over/);
  assert.match(tamper(0, (t) => (t.close = thief)) ?? '', /hand over/);
  assert.match(tamper(1, (t) => (t.apid = 123n)) ?? '', /router’s swap/);
  assert.match(tamper(2, (t) => ((t.apaa as Uint8Array[])[2] = algosdk.encodeUint64(1))) ?? '', /minimum/);
  assert.match(tamper(2, (t) => ((t.apaa as Uint8Array[])[1] = algosdk.encodeUint64(0))) ?? '', /wrong asset/);
  assert.match(tamper(1, (t) => (t.fee = 1_000_000n)) ?? '', /fees/);
  assert.match(swapProblem(raw, walletKeys(generateSecretKey()).address, q) ?? '', /isn’t from this wallet/);
});

test('paying from the wallet sends USDC with the memo, and the existing payment checks find it', async () => {
  const chain = createFakeChain();
  const payer = walletKeys(generateSecretKey());
  const payee = walletKeys(generateSecretKey());
  chain.fund(payer.address, RESERVE_MICROALGOS, 5_000_000n);
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
});

test('signed HTTP requests (NIP-98) name the URL, method and body, and expire', () => {
  const key = generateSecretKey();
  const url = 'https://gw.test/fairground/ramp/session';
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

test('Transak sessions are made on the server; a first deposit buys ALGO; sales are checked before the wallet pays', async () => {
  const member = actor();
  const deposit = walletKeys(generateSecretKey()).address;
  const t = fakeTransak(member.pubkey, deposit);
  const ramp = createRamp({ apiKey: 'key', apiSecret: 'secret', environment: 'staging', referrerDomain: 'www.evolvetech.dev', fetch: t.fetch });
  const buyer = walletKeys(member.nostrKey).address;
  assert.equal(await ramp.session({ side: 'BUY', walletAddress: buyer, customer: member.pubkey, fiatAmount: 25, redirectURL: 'https://app.test/', userIp: '1.2.3.4', asset: 'ALGO' }), 'https://global-stg.transak.com/?sessionId=s1');
  await ramp.session({ side: 'BUY', walletAddress: buyer, customer: member.pubkey, fiatAmount: 25, redirectURL: 'https://app.test/', userIp: '1.2.3.4' });
  await ramp.session({ side: 'SELL', walletAddress: buyer, customer: member.pubkey, cryptoAmount: 10, redirectURL: 'https://app.test/', userIp: '1.2.3.4' });
  assert.equal(t.calls.filter((c) => c.url.endsWith('refresh-token')).length, 1, 'the partner token is reused');
  const [first, later, sell] = t.calls.filter((c) => c.url.endsWith('/auth/session'));
  const wp = (c: typeof first) => c.body!.widgetParams as Record<string, unknown>;
  assert.equal(wp(first).cryptoCurrencyCode, 'ALGO', 'the first deposit buys ALGO');
  assert.equal(wp(later).cryptoCurrencyCode, 'USDC');
  assert.equal(wp(first).walletAddress, buyer);
  assert.equal(wp(first).disableWalletAddressForm, true);
  assert.equal(wp(first).network, 'mainnet', 'Transak identifies native ALGO with mainnet, not algorand');
  assert.equal(wp(later).network, 'algorand');
  assert.equal(first.headers.get('access-token'), 'token-1');
  assert.equal(first.headers.get('api-secret'), null, 'the secret goes only to the token endpoint');
  assert.equal(wp(sell).walletRedirection, true);
  assert.equal(wp(sell).cryptoCurrencyCode, 'USDC');

  const order = await ramp.order('order-123');
  assert.equal(sellOrderProblem(order, member.pubkey), undefined);
  assert.match(sellOrderProblem(order, actor().pubkey) ?? '', /someone else/);
  assert.match(sellOrderProblem({ ...order, status: 'COMPLETED' }, member.pubkey) ?? '', /isn’t waiting/);
  assert.match(sellOrderProblem({ ...order, network: 'ethereum' }, member.pubkey) ?? '', /USDC on Algorand/);
});

test('the gateway opens Transak only for signed requests from Fairground members', async () => {
  const relay = await startDevRelay(7796);
  try {
    const member = actor();
    const stranger = actor();
    relay.events.push(member.binding);
    const t = fakeTransak(member.pubkey, walletKeys(generateSecretKey()).address);
    const gw = createGateway({ relays: [relay.url], base: '/fg', appUrl: 'https://app.test/', fetch: t.fetch, ramp: { apiKey: 'key', apiSecret: 'secret', environment: 'staging', referrerDomain: 'app.test' } });
    const post = (who: typeof member, path: string, body: object) => {
      const url = `https://gw.test/fg${path}`;
      const text = JSON.stringify(body);
      return gw(new Request(url, { method: 'POST', body: text, headers: { Authorization: authHeader(who.nostrKey, url, 'POST', text), 'Content-Type': 'application/json' } }), { ip: '5.6.7.8' });
    };
    assert.deepEqual(await (await gw(new Request('https://gw.test/fg/wallet/config'))).json(), { ramp: true });
    const address = walletKeys(member.nostrKey).address;
    const session = await post(member, '/ramp/session', { side: 'BUY', walletAddress: address, amount: 20, asset: 'ALGO', redirectURL: 'https://app.test/' });
    assert.equal((await session.json()).url, 'https://global-stg.transak.com/?sessionId=s1');
    const sent = t.calls.find((c) => c.url.endsWith('/auth/session'))!;
    assert.equal(sent.headers.get('x-user-ip'), '5.6.7.8');
    assert.equal((sent.body!.widgetParams as Record<string, unknown>).partnerCustomerId, member.pubkey);
    assert.equal((sent.body!.widgetParams as Record<string, unknown>).cryptoCurrencyCode, 'ALGO');
    const preflight = await gw(new Request('https://gw.test/fg/ramp/session', { method: 'OPTIONS', headers: { Origin: 'https://app.test' } }));
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://app.test');
    const before = t.calls.length;
    assert.equal((await gw(new Request('https://gw.test/fg/ramp/session', { method: 'OPTIONS', headers: { Origin: 'https://other.test' } }))).status, 403);
    const badOrigin = await gw(new Request('https://gw.test/fg/ramp/session', { method: 'POST', headers: { Origin: 'https://other.test' }, body: '{}' }));
    assert.equal(badOrigin.status, 403);
    assert.equal(badOrigin.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(t.calls.length, before, 'rejected origins never reach Transak');
    assert.equal((await post(member, '/ramp/session', { side: 'BUY', walletAddress: address, redirectURL: 'https://other.test/' })).status, 400);
    const noIpUrl = 'https://gw.test/fg/ramp/session';
    const noIpBody = JSON.stringify({ side: 'BUY', walletAddress: address, redirectURL: 'https://app.test/' });
    const noIp = await gw(new Request(noIpUrl, { method: 'POST', body: noIpBody, headers: { Authorization: authHeader(member.nostrKey, noIpUrl, 'POST', noIpBody) } }));
    assert.equal(noIp.status, 503, 'never invent a visitor IP for Transak');
    assert.equal((await post(stranger, '/ramp/session', { side: 'BUY', walletAddress: address, redirectURL: 'https://app.test/' })).status, 403, 'members only');
    assert.equal((await gw(new Request('https://gw.test/fg/ramp/session', { method: 'POST', body: '{}' }))).status, 401);

    const orderUrl = 'https://gw.test/fg/ramp/order/order-123';
    const body = await (await gw(new Request(orderUrl, { headers: { Authorization: authHeader(member.nostrKey, orderUrl, 'GET') } }))).json();
    assert.equal(body.problem, null);
    assert.equal(body.order.cryptoAmount, 10);
    assert.equal((await gw(new Request('https://gw.test/fg/wallet/start', { method: 'POST', body: '{}' }))).status, 404, 'the gateway funds no one’s wallet');

    const off = createGateway({ relays: [relay.url], base: '/fg', appUrl: 'https://app.test/', fetch: t.fetch });
    assert.deepEqual(await (await off(new Request('https://gw.test/fg/wallet/config'))).json(), { ramp: false });
  } finally {
    await relay.close();
  }
});
