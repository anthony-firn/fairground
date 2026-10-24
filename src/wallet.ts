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
import { ed25519 } from '@noble/curves/ed25519.js';
import { base64 } from '@scure/base';
import { assetTxn, encodeAddressKey, signTxn, type Txn, type TxnParams } from './algotx.ts';
import { USDC_ASSET_ID } from './rails/algorand.ts';
import type { PaymentRequest } from './rails/rail.ts';
import { DEFAULT_ALGOD, walletSeed } from './walletkey.ts';

export { DEFAULT_ALGOD, feesLeft, STARTER_MEMO, STARTER_MICROALGOS, walletAddress, walletState, type WalletState } from './walletkey.ts';

export interface WalletKeys {
  address: string;
  /** The 32-byte Ed25519 seed. */
  seed: Uint8Array;
}

/** The wallet key for a Fairground account. */
export function walletKeys(nostrKey: Uint8Array): WalletKeys {
  const seed = walletSeed(nostrKey);
  return { address: encodeAddressKey(ed25519.getPublicKey(seed)), seed };
}

type Fetch = typeof fetch;
const defaultFetch: Fetch = (...a) => fetch(...a);

async function json(res: Response, what: string): Promise<Record<string, unknown>> {
  if (!res.ok) throw new Error(`${what}: the Algorand node said ${res.status}${await res.text().then((t) => (t ? ` (${t.slice(0, 200)})` : ''), () => '')}`);
  return res.json() as Promise<Record<string, unknown>>;
}

/** Current network parameters, with the minimum fee as the flat fee. */
export async function suggestedParams(algod = DEFAULT_ALGOD, fetchImpl: Fetch = defaultFetch): Promise<TxnParams & { minFee: bigint }> {
  const p = await json(await fetchImpl(`${algod}/v2/transactions/params`), 'reading network parameters');
  const minFee = BigInt(Number(p['min-fee'] ?? 1000));
  const round = BigInt(Number(p['last-round']));
  return { fee: minFee, minFee, firstValid: round, lastValid: round + 1000n, genesisID: String(p['genesis-id']), genesisHash: base64.decode(String(p['genesis-hash'])) };
}

/** A USDC payment with its memo, as the payment link would have made it. */
export const usdcPayment = (sender: string, request: PaymentRequest, params: TxnParams): Txn =>
  assetTxn(sender, request.to, USDC_ASSET_ID, request.amount, params, new TextEncoder().encode(request.memo));

export const sign = (txn: Txn, seed: Uint8Array): Uint8Array => signTxn(txn, seed);

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
