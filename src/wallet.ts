/**
 * The built-in wallet: an Algorand account derived from the Fairground account's key, so the backup code and the
 * sign-in vault restore it along with everything else. Its key stays on the device and signs payments there; nobody
 * else, Fairground included, can move its money. People who prefer their own wallet (Pera, a hardware wallet, a
 * quantum-safe Falcon account) can still pay and be paid there instead.
 *
 * The key is Ed25519, like most Algorand accounts. Algorand's native Falcon-1024 accounts (v5.0.0) use a
 * deterministic Falcon signature that general-purpose JavaScript libraries don't produce yet; once one does, the
 * account can be rekeyed to a Falcon key without its address changing.
 */
import algosdk from 'algosdk';
import { ed25519 } from '@noble/curves/ed25519.js';
import { USDC_ASSET_ID } from './rails/algorand.ts';
import type { PaymentRequest } from './rails/rail.ts';
import { DEFAULT_ALGOD, walletSeed } from './walletkey.ts';

export { DEFAULT_ALGOD, feesLeft, STARTER_MEMO, STARTER_MICROALGOS, walletAddress, walletState, type WalletState } from './walletkey.ts';

export interface WalletKeys {
  address: string;
  /** algosdk's 64-byte form: the Ed25519 seed followed by the public key. */
  secretKey: Uint8Array;
}

/** The wallet key for a Fairground account. */
export function walletKeys(nostrKey: Uint8Array): WalletKeys {
  const seed = walletSeed(nostrKey);
  const publicKey = ed25519.getPublicKey(seed);
  const secretKey = new Uint8Array(64);
  secretKey.set(seed);
  secretKey.set(publicKey, 32);
  return { address: algosdk.encodeAddress(publicKey), secretKey };
}

type Fetch = typeof fetch;
const defaultFetch: Fetch = (...a) => fetch(...a);

async function json(res: Response, what: string): Promise<Record<string, unknown>> {
  if (!res.ok) throw new Error(`${what}: the Algorand node said ${res.status}${await res.text().then((t) => (t ? ` (${t.slice(0, 200)})` : ''), () => '')}`);
  return res.json() as Promise<Record<string, unknown>>;
}
export async function suggestedParams(algod = DEFAULT_ALGOD, fetchImpl: Fetch = defaultFetch): Promise<algosdk.SuggestedParams> {
  const p = await json(await fetchImpl(`${algod}/v2/transactions/params`), 'reading network parameters');
  return {
    flatFee: true,
    fee: BigInt(Number(p['min-fee'] ?? 1000)),
    minFee: BigInt(Number(p['min-fee'] ?? 1000)),
    firstValid: BigInt(Number(p['last-round'])),
    lastValid: BigInt(Number(p['last-round']) + 1000),
    genesisID: String(p['genesis-id']),
    genesisHash: algosdk.base64ToBytes(String(p['genesis-hash'])),
  };
}

const note = (memo: string) => new TextEncoder().encode(memo);

/** A USDC payment with its memo, as the payment link would have made it. */
export function usdcPayment(sender: string, request: PaymentRequest, params: algosdk.SuggestedParams): algosdk.Transaction {
  return algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender, receiver: request.to, amount: request.amount, assetIndex: USDC_ASSET_ID, note: note(request.memo), suggestedParams: params,
  });
}

export const sign = (txn: algosdk.Transaction, secretKey: Uint8Array): Uint8Array => txn.signTxn(secretKey);

/** Sends signed transactions (one group) and returns the first one's id. */
export async function submit(signed: Uint8Array[], algod = DEFAULT_ALGOD, fetchImpl: Fetch = defaultFetch): Promise<string> {
  const bytes = new Uint8Array(signed.reduce((n, s) => n + s.length, 0));
  let at = 0;
  for (const s of signed) {
    bytes.set(s, at);
    at += s.length;
  }
  const body = await json(await fetchImpl(`${algod}/v2/transactions`, { method: 'POST', headers: { 'Content-Type': 'application/x-binary' }, body: bytes }), 'sending the payment');
  return String(body.txId);
}

/** Waits until a transaction is in a block, a few seconds on Algorand. */
export async function confirmed(txid: string, algod = DEFAULT_ALGOD, fetchImpl: Fetch = defaultFetch, tries = 20, wait = 1000): Promise<number> {
  for (let i = 0; i < tries; i++) {
    const body = await json(await fetchImpl(`${algod}/v2/transactions/pending/${txid}`), 'checking the payment');
    if (Number(body['confirmed-round']) > 0) return Number(body['confirmed-round']);
    if (body['pool-error']) throw new Error(`The network rejected the payment: ${String(body['pool-error'])}`);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error('The payment wasn’t confirmed in time; check the wallet before trying again.');
}
