import assert from 'node:assert/strict';
import { test } from 'node:test';
import algosdk from 'algosdk';
import { assetTxn, assignGroup, encodeTxn, payTxn, signTxn, txid, verifyTxnSig, type TxnParams } from '../src/algotx.ts';
import { MAINNET_GENESIS_HASH, USDC_ASSET_ID } from '../src/rails/algorand.ts';

const params: TxnParams = { fee: 1000n, firstValid: 66_298_548n, lastValid: 66_299_548n, genesisID: 'mainnet-v1.0', genesisHash: algosdk.base64ToBytes(MAINNET_GENESIS_HASH) };
const sdkParams = { flatFee: true, fee: 1000n, minFee: 1000n, firstValid: params.firstValid, lastValid: params.lastValid, genesisID: params.genesisID, genesisHash: params.genesisHash };
const [a, b] = [algosdk.generateAccount(), algosdk.generateAccount()];
const A = a.addr.toString();
const B = b.addr.toString();
const memo = new TextEncoder().encode('fairground:deal:abc');
const bytes = (x: Uint8Array) => Buffer.from(x).toString('hex');

test('encodes payments and USDC transfers exactly as the Algorand SDK does', () => {
  const cases: [ReturnType<typeof payTxn>, algosdk.Transaction][] = [
    [assetTxn(A, B, USDC_ASSET_ID, 2_500_000n, params, memo), algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: A, receiver: B, amount: 2_500_000n, assetIndex: USDC_ASSET_ID, note: memo, suggestedParams: sdkParams })],
    [assetTxn(B, B, USDC_ASSET_ID, 0n, { ...params, fee: 0n }), algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: B, receiver: B, amount: 0, assetIndex: USDC_ASSET_ID, suggestedParams: { ...sdkParams, fee: 0n } })],
    [payTxn(A, B, 250_000n, { ...params, fee: 2000n }, memo), algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: A, receiver: B, amount: 250_000n, note: memo, suggestedParams: { ...sdkParams, fee: 2000n } })],
    [assetTxn(A, B, USDC_ASSET_ID, 123_456_789_012n, { ...params, firstValid: 5n, lastValid: 300n }), algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: A, receiver: B, amount: 123_456_789_012n, assetIndex: USDC_ASSET_ID, suggestedParams: { ...sdkParams, firstValid: 5n, lastValid: 300n } })],
  ];
  for (const [ours, sdk] of cases) {
    assert.equal(bytes(encodeTxn(ours)), bytes(algosdk.encodeUnsignedTransaction(sdk)));
    assert.equal(txid(ours), sdk.txID());
  }
});

test('group ids and signatures match the SDK', () => {
  const ours = [payTxn(A, B, 250_000n, { ...params, fee: 2000n }), assetTxn(B, B, USDC_ASSET_ID, 0n, { ...params, fee: 0n })];
  const sdk = [
    algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: A, receiver: B, amount: 250_000n, suggestedParams: { ...sdkParams, fee: 2000n } }),
    algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: B, receiver: B, amount: 0, assetIndex: USDC_ASSET_ID, suggestedParams: { ...sdkParams, fee: 0n } }),
  ];
  assignGroup(ours);
  algosdk.assignGroupID(sdk);
  ours.forEach((t, i) => assert.equal(bytes(encodeTxn(t)), bytes(algosdk.encodeUnsignedTransaction(sdk[i]))));
  const seed = a.sk.slice(0, 32);
  assert.equal(bytes(signTxn(ours[0], seed)), bytes(sdk[0].signTxn(a.sk)));
  const sig = algosdk.decodeSignedTransaction(sdk[0].signTxn(a.sk)).sig!;
  assert.equal(verifyTxnSig(ours[0], sig, A), true);
  assert.equal(verifyTxnSig(ours[0], sig, B), false);
});
