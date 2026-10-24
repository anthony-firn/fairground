import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { randomBytes } from '@noble/hashes/utils.js';
import { createAlgorandUsdcRail, encodeAddress, isAlgorandAddress, parseIndexerTransaction, paymentLink } from '../src/rails/algorand.ts';

/** A real mainnet USDC transfer, as returned by the public indexer. */
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/usdc-transfer.json', import.meta.url), 'utf8'));
const TXID = 'ETECK546NQE7WWEMKP4KRJ3HQNU3746L6EVCVIHEKFKPEGAVVZDA';

test('a real indexer response parses to a USDC transfer', () => {
  assert.deepEqual(parseIndexerTransaction(fixture()), {
    id: TXID,
    sender: '2UEQTE5QDNXPI7M3TU44G6SYKLFWLPQO7EBZM7K7MHMQQMFI4QJPLHQFHM',
    receiver: 'E2ROUACM6GEKXI4AL3N5TFKEKJZAQBH235XV57OXQRAQI5TOVGEVV7AG2I',
    amount: 109_600_000n,
    note: '',
    time: 1_600_106_672,
  });
});

test('the memo is decoded from base64', () => {
  const json = fixture();
  json.transaction.note = Buffer.from('fairground:abc').toString('base64');
  assert.equal(parseIndexerTransaction(json).note, 'fairground:abc');
});

test('other networks, assets and unconfirmed transactions are rejected', () => {
  const testnet = fixture();
  testnet.transaction['genesis-hash'] = 'SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=';
  assert.throws(() => parseIndexerTransaction(testnet), /mainnet/);

  const otherAsset = fixture();
  otherAsset.transaction['asset-transfer-transaction']['asset-id'] = 312769;
  assert.throws(() => parseIndexerTransaction(otherAsset), /USDC/);

  const pending = fixture();
  delete pending.transaction['confirmed-round'];
  assert.throws(() => parseIndexerTransaction(pending), /confirmed/);
});

test('addresses are checked for format and checksum', () => {
  assert.ok(isAlgorandAddress('E2ROUACM6GEKXI4AL3N5TFKEKJZAQBH235XV57OXQRAQI5TOVGEVV7AG2I'));
  assert.ok(isAlgorandAddress('2UEQTE5QDNXPI7M3TU44G6SYKLFWLPQO7EBZM7K7MHMQQMFI4QJPLHQFHM'));
  assert.equal(isAlgorandAddress('E2ROUACM6GEKXI4AL3N5TFKEKJZAQBH235XV57OXQRAQI5TOVGEVV7AG2J'), false);
  assert.equal(isAlgorandAddress('e2rouacm6gekxi4al3n5tfkekjzaqbh235xv57oxqraqi5tovgevv7ag2i'), false);
  const generated = encodeAddress(randomBytes(32));
  assert.ok(isAlgorandAddress(generated));
});

test('the rail fetches from the indexer and rejects a mismatched answer', async () => {
  const urls: string[] = [];
  const respond = (body: unknown): typeof fetch => async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body));
  };
  const rail = createAlgorandUsdcRail('https://indexer.example', respond(fixture()));
  assert.equal((await rail.fetchTransfer(TXID)).amount, 109_600_000n);
  assert.deepEqual(urls, [`https://indexer.example/v2/transactions/${TXID}`]);

  const other = createAlgorandUsdcRail('https://indexer.example', respond(fixture()));
  await assert.rejects(other.fetchTransfer('A'.repeat(52)), /different transaction/);
  await assert.rejects(other.fetchTransfer('not-a-txid'), /not an Algorand transaction id/);
});

test('payment links fill in the wallet with an uneditable memo', () => {
  const to = encodeAddress(randomBytes(32));
  assert.equal(paymentLink({ to, amount: 5_000_000n, memo: 'fairground:support:abc' }),
    `algorand://${to}?amount=5000000&asset=31566704&xnote=fairground%3Asupport%3Aabc&note=fairground%3Asupport%3Aabc`);
  assert.throws(() => paymentLink({ to: 'nope', amount: 1n, memo: '' }));
});

test('an address can receive USDC only once it has opted in and is not frozen', async () => {
  const holding = (assets: unknown[]) => createAlgorandUsdcRail('https://indexer.example', async () => new Response(JSON.stringify({ assets })));
  const to = encodeAddress(randomBytes(32));
  assert.equal(await holding([{ 'asset-id': 31566704, deleted: false, 'is-frozen': false }]).canReceive(to), true);
  assert.equal(await holding([]).canReceive(to), false);
  assert.equal(await holding([{ 'asset-id': 31566704, deleted: false, 'is-frozen': true }]).canReceive(to), false);
  assert.equal(await holding([]).canReceive('not-an-address'), false);
});

test('outgoing transfers are listed by sender', async () => {
  const from = encodeAddress(randomBytes(32));
  const tx = { ...fixture().transaction, sender: from, note: Buffer.from('fairground:support:x').toString('base64') };
  let role = '';
  const rail = createAlgorandUsdcRail('https://indexer.example', async (url) => {
    role = new URL(String(url)).searchParams.get('address-role')!;
    return new Response(JSON.stringify({ transactions: [tx] }));
  });
  const found = await rail.listTransfers({ address: from, role: 'sender', notePrefix: 'fairground:support:', from: 0, to: 2_000_000_000 });
  assert.equal(role, 'sender');
  assert.deepEqual(found.map((t) => t.sender), [from]);
});
