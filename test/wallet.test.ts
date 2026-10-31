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
import { fakeMeld, MELD_TEST_OPTIONS } from './fakemeld.ts';

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

test('Meld sessions use private versioned API calls, exact Algorand currency IDs and explicit suppliers', async () => {
  const member = actor();
  const buyer = walletKeys(member.nostrKey).address;
  const t = fakeMeld(walletKeys(generateSecretKey()).address);
  const ramp = createRamp({ ...MELD_TEST_OPTIONS, environment: 'sandbox', fetch: t.fetch });
  const request = { side: 'BUY' as const, walletAddress: buyer, customer: member.pubkey, amount: 25, redirectURL: 'https://app.test/', userIp: '1.2.3.4', asset: 'ALGO' as const, countryCode: 'US', subdivision: 'US-CA' };
  const first = await ramp.session(request);
  assert.equal(first.url, 'https://meldcrypto.com/?token=session-1');
  assert.equal(first.environment, 'sandbox');
  await ramp.session({ ...request, asset: 'USDC' });
  const sell = await ramp.session({ ...request, side: 'SELL', asset: 'USDC', amount: 10 });
  const sessions = t.calls.filter((c) => c.url.endsWith('/crypto/session/widget'));
  const data = sessions.map((c) => c.body!.sessionData as Record<string, unknown>);
  assert.equal(data[0].destinationCurrencyCode, 'ALGO');
  assert.equal(data[1].destinationCurrencyCode, 'USDC_ALGORAND');
  assert.equal(data[2].sourceCurrencyCode, 'USDC_ALGORAND');
  assert.equal(data[2].destinationCurrencyCode, 'USD');
  assert.equal(data[2].redirectFlow, true);
  assert.equal(data[0].sourceAmount, '25');
  assert.equal(data[0].walletAddress, buyer);
  assert.equal(data[0].clientIpAddress, '1.2.3.4');
  assert.equal(data[0].paymentMethodType, 'CREDIT_DEBIT_CARD');
  assert.equal(data[2].paymentMethodType, 'ACH');
  assert.deepEqual(data[0].lockFields, ['walletAddress', 'sourceCurrencyCode', 'destinationCurrencyCode', 'sourceAmount', 'paymentMethodType']);
  assert.notEqual(first.externalSessionId, sell.externalSessionId);
  for (const c of t.calls) {
    assert.ok(c.url.startsWith('https://api-sb.meld.io/'));
    assert.equal(c.headers.get('Authorization'), 'BASIC test-key');
    assert.equal(c.headers.get('Meld-Version'), '2026-02-03');
  }
  const quote = t.calls.find((c) => c.url.endsWith('/payments/crypto/quote'))!;
  assert.deepEqual(quote.body!.serviceProviders, ['TEST_BUY']);
  assert.equal(quote.body!.subdivision, 'US-CA');
  const order = await ramp.order(sell.id);
  assert.equal(sellOrderProblem(order, member.pubkey), undefined);
  assert.equal(order.sourceWalletAddress, buyer);
  assert.equal(order.cryptoAmount, '10');
  for (const change of [
    { customer: '' }, { customer: actor().pubkey }, { externalSessionId: 'unrelated' },
    { network: 'ethereum' }, { cryptoCurrency: 'USDC_ETH' }, { side: 'UNKNOWN' as const },
    { status: 'SETTLING' }, { status: 'SETTLED' }, { status: 'FAILED' },
    { walletAddress: buyer }, { walletAddress: 'invalid' }, { cryptoAmount: 'NaN' },
    { cryptoAmount: '0.0000001' }, { fiatAmount: Infinity },
  ]) assert.ok(sellOrderProblem({ ...order, ...change }, member.pubkey), JSON.stringify(change));
});

test('Meld does not fall back to unapproved suppliers, chains, swap routes or untrusted checkout URLs', async () => {
  const member = actor();
  const t = fakeMeld(walletKeys(generateSecretKey()).address);
  const ramp = createRamp({ ...MELD_TEST_OPTIONS, fetch: t.fetch });
  const request = { side: 'BUY' as const, walletAddress: walletKeys(member.nostrKey).address, customer: member.pubkey, amount: 25, redirectURL: 'https://app.test/', userIp: '1.2.3.4', asset: 'ALGO' as const, countryCode: 'US' };
  for (const patch of [{ serviceProvider: 'OTHER' }, { destinationCurrencyCode: 'USDC_ETH' }, { transactionType: 'CRYPTO_PURCHASE_SWAP' }, { paymentMethodType: 'ACH' }]) {
    t.quotePatch = patch;
    await assert.rejects(ramp.session(request), /No eligible Meld quote/);
  }
  t.quotePatch = {};
  t.emptyQuotes = true;
  await assert.rejects(ramp.session(request), /No eligible Meld quote/);
  t.emptyQuotes = false;
  t.responsePatch = { widgetUrl: 'https://attacker.test/checkout' };
  await assert.rejects(ramp.session(request), /unexpected checkout origin/);
  t.responsePatch = { externalCustomerId: actor().pubkey };
  await assert.rejects(ramp.session(request), /different checkout session/);
  for (const amount of [NaN, Infinity, -1, 0]) await assert.rejects(ramp.session({ ...request, amount }), /invalid checkout/);
  const count = t.calls.length;
  await assert.rejects(ramp.order('../secret'), /not a Meld session/);
  assert.equal(t.calls.length, count);
  for (const patch of [{ chainCode: 'ETH' }, { contract: 'wrong-asset' }]) {
    t.currencyPatch = patch;
    await assert.rejects(createRamp({ ...MELD_TEST_OPTIONS, fetch: t.fetch }).session({ ...request, asset: 'USDC' }), /does not uniquely identify/);
  }
  const failed = createRamp({ ...MELD_TEST_OPTIONS, fetch: async () => Response.json({ code: 'INVALID_AMOUNT_TOO_LOW', requestId: 'safe-ref', message: 'private provider information' }, { status: 400 }) });
  await assert.rejects(failed.session(request), (e: Error) => /INVALID_AMOUNT_TOO_LOW/.test(e.message) && /safe-ref/.test(e.message) && !/private provider/.test(e.message));
});

test('the gateway opens Meld only for signed member requests and never returns another owner’s order', async () => {
  const relay = await startDevRelay(7796);
  try {
    const member = actor();
    const stranger = actor();
    relay.events.push(member.binding);
    const t = fakeMeld(walletKeys(generateSecretKey()).address);
    const gw = createGateway({ relays: [relay.url], base: '/fg', appUrl: 'https://app.test/', fetch: t.fetch, ramp: MELD_TEST_OPTIONS });
    const post = (who: typeof member, body: object, withIp = true) => {
      const url = 'https://gw.test/fg/ramp/session';
      const text = JSON.stringify(body);
      return gw(new Request(url, { method: 'POST', body: text, headers: { Authorization: authHeader(who.nostrKey, url, 'POST', text), 'Content-Type': 'application/json' } }), withIp ? { ip: '5.6.7.8' } : {});
    };
    assert.deepEqual(await (await gw(new Request('https://gw.test/fg/wallet/config'))).json(), { ramp: true, provider: 'meld', environment: 'production' });
    const address = walletKeys(member.nostrKey).address;
    const request = { side: 'BUY', walletAddress: address, amount: 20, asset: 'ALGO', countryCode: 'US', subdivision: 'US-CA', redirectURL: 'https://app.test/' };
    const session = await post(member, request);
    assert.equal(session.status, 200);
    assert.equal((await session.json()).id, 'session-1');
    const sent = t.calls.find((c) => c.url.endsWith('/crypto/session/widget'))!;
    assert.equal((sent.body!.sessionData as Record<string, unknown>).clientIpAddress, '5.6.7.8');
    assert.equal(sent.body!.externalCustomerId, member.pubkey);
    const preflight = await gw(new Request('https://gw.test/fg/ramp/session', { method: 'OPTIONS', headers: { Origin: 'https://app.test' } }));
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://app.test');
    const before = t.calls.length;
    const bad = await gw(new Request('https://gw.test/fg/ramp/session', { method: 'POST', headers: { Origin: 'https://other.test' }, body: '{}' }));
    assert.equal(bad.status, 403);
    assert.equal(t.calls.length, before);
    assert.equal((await post(member, { ...request, redirectURL: 'https://other.test/' })).status, 400);
    assert.equal((await post(member, { ...request, amount: -1 })).status, 400);
    assert.equal((await post(member, { ...request, countryCode: '' })).status, 400);
    assert.equal((await post(member, request, false)).status, 503);
    assert.equal((await post(stranger, request)).status, 403);
    const sell = await post(member, { ...request, side: 'SELL', asset: 'USDC' });
    const id = (await sell.json()).id;
    const orderUrl = `https://gw.test/fg/ramp/order/${id}`;
    const read = () => gw(new Request(orderUrl, { headers: { Authorization: authHeader(member.nostrKey, orderUrl, 'GET') } }));
    assert.equal((await (await read()).json()).problem, null);
    t.transactionPatch = { externalCustomerId: stranger.pubkey };
    assert.equal((await read()).status, 403);
    t.transactionPatch = { externalCustomerId: undefined };
    assert.equal((await read()).status, 403, 'missing owner fails closed');
    t.transactionPatch = { serviceProvider: 'OTHER' };
    assert.equal((await read()).status, 409);
    const off = createGateway({ relays: [relay.url], base: '/fg', appUrl: 'https://app.test/', fetch: t.fetch });
    assert.deepEqual(await (await off(new Request('https://gw.test/fg/wallet/config'))).json(), { ramp: false });
  } finally { await relay.close(); }
});
