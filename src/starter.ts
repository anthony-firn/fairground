/**
 * Starting a wallet. Algorand accounts need a little ALGO before they can hold USDC (a 0.1 ALGO minimum, 0.1 more per
 * asset) and to pay network fees. A sponsor run by the project covers that for new Fairground wallets, so nobody has to
 * buy a second currency first: one atomic group sends the ALGO, paying both fees, together with the wallet's USDC
 * opt-in, which the wallet signs on the device.
 *
 * It holds only its own small float, never anyone's money. Each Fairground member can be started once, and the number
 * per day is capped; both limits are read from the sponsor's own transactions on the chain, so no database is needed.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { addressKey, assetTxn, assignGroup, encodeAddressKey, payTxn, signedTxn, signTxn, verifyTxnSig, type Txn, type TxnParams } from './algotx.ts';
import { USDC_ASSET_ID } from './rails/algorand.ts';
import { confirmed, DEFAULT_ALGOD, STARTER_MEMO, STARTER_MICROALGOS, submit, suggestedParams, walletState } from './wallet.ts';

export const DEFAULT_INDEXER = 'https://mainnet-idx.4160.nodely.dev';

export interface StarterOptions {
  /** The sponsor account's 32-byte Ed25519 seed, in hex. Keep only a small float in it. */
  key: string;
  algod?: string;
  indexer?: string;
  /** Wallets started per day, across everyone. */
  dailyCap?: number;
  fetch?: typeof fetch;
}

/** What the wallet sends: its signature over the opt-in, and the validity window it signed. */
export interface StartRequest {
  address: string;
  firstValid: string;
  lastValid: string;
  /** Base64 Ed25519 signature. */
  sig: string;
}

export type StarterResult = { txid: string } | { status: number; error: string };

/** The note on a starter payment, naming the member it started. */
export const starterNote = (member: string) => `${STARTER_MEMO}:${member}`;

/** The sponsor payment and opt-in for one member's wallet, from the network parameters both sides agree on. */
export function starterTxns(sponsor: string, address: string, member: string, params: TxnParams & { minFee: bigint }): [Txn, Txn] {
  const pay = payTxn(sponsor, address, STARTER_MICROALGOS, { ...params, fee: params.minFee * 2n }, new TextEncoder().encode(starterNote(member)));
  const optIn = assetTxn(address, address, USDC_ASSET_ID, 0n, { ...params, fee: 0n });
  assignGroup([pay, optIn]);
  return [pay, optIn];
}

export function createStarter(opts: StarterOptions) {
  const seed = hexToBytes(opts.key);
  if (seed.length !== 32) throw new Error('the starter key must be a 32-byte seed');
  const sponsor = encodeAddressKey(ed25519.getPublicKey(seed));
  const algod = opts.algod ?? DEFAULT_ALGOD;
  const indexer = opts.indexer ?? DEFAULT_INDEXER;
  const fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const cap = opts.dailyCap ?? 100;

  /** The sponsor's starter payments with this note prefix since a time. */
  async function payments(prefix: string, since: number): Promise<number> {
    const q = new URLSearchParams({
      'tx-type': 'pay', 'address-role': 'sender', 'note-prefix': base64.encode(new TextEncoder().encode(prefix)),
      'after-time': new Date(since * 1000).toISOString(), limit: String(cap + 1),
    });
    const res = await fetchImpl(`${indexer}/v2/accounts/${sponsor}/transactions?${q}`);
    if (!res.ok) throw new Error(`indexer returned ${res.status}`);
    return (((await res.json()) as { transactions?: unknown[] }).transactions ?? []).length;
  }

  return {
    sponsor,
    async start(member: string, req: StartRequest): Promise<StarterResult> {
      let firstValid: bigint;
      let lastValid: bigint;
      let sig: Uint8Array;
      try {
        addressKey(req.address);
        firstValid = BigInt(req.firstValid);
        lastValid = BigInt(req.lastValid);
        sig = base64.decode(req.sig);
      } catch {
        return { status: 400, error: 'malformed request' };
      }
      if (lastValid <= firstValid || lastValid - firstValid > 1000n || sig.length !== 64) return { status: 400, error: 'malformed request' };
      const net = await suggestedParams(algod, fetchImpl);
      const [pay, optIn] = starterTxns(sponsor, req.address, member, { ...net, firstValid, lastValid });
      // The wallet must have signed exactly the opt-in we built, for this member.
      if (!verifyTxnSig(optIn, sig, req.address)) return { status: 400, error: 'that isn’t the starter opt-in for this wallet' };
      const state = await walletState(req.address, algod, fetchImpl);
      if (state.active) return { status: 409, error: 'this wallet is already started' };
      if (state.algo >= 200_000n) return { status: 409, error: 'this wallet already has enough ALGO to start itself' };
      if (await payments(starterNote(member), 0) > 0) return { status: 409, error: 'this account’s wallet was already started once' };
      if (await payments(STARTER_MEMO, Math.floor(Date.now() / 1000) - 86400) >= cap) return { status: 429, error: 'too many new wallets today; try again tomorrow' };
      const txid = await submit([signTxn(pay, seed), signedTxn(optIn, sig)], algod, fetchImpl);
      await confirmed(txid, algod, fetchImpl);
      return { txid };
    },
  };
}
