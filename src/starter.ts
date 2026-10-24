/**
 * Starting a wallet. Algorand accounts need a little ALGO before they can hold USDC (a 0.1 ALGO minimum, 0.1 more per
 * asset) and to pay network fees. A sponsor run by the project covers that for new Fairground wallets, so nobody has to
 * buy a second currency first: one atomic group sends the ALGO, paying both fees, together with the wallet's USDC
 * opt-in, which the wallet signs on the device.
 *
 * It holds only its own small float, never anyone's money. Each Fairground member can be started once, and the number
 * per day is capped; both limits are read from the sponsor's own transactions on the chain, so no database is needed.
 */
import algosdk from 'algosdk';
import { base64 } from '@scure/base';
import { USDC_ASSET_ID } from './rails/algorand.ts';
import { confirmed, DEFAULT_ALGOD, STARTER_MEMO, STARTER_MICROALGOS, submit, suggestedParams, walletState } from './wallet.ts';

export const DEFAULT_INDEXER = 'https://mainnet-idx.4160.nodely.dev';

export interface StarterOptions {
  /** The sponsor account's 25-word mnemonic. Keep only a small float in it. */
  mnemonic: string;
  algod?: string;
  indexer?: string;
  /** Wallets started per day, across everyone. */
  dailyCap?: number;
  fetch?: typeof fetch;
}

export type StarterResult = { txid: string } | { status: number; error: string };

/** The note on a starter payment, naming the member it started. */
export const starterNote = (member: string) => `${STARTER_MEMO}:${member}`;

/** The sponsor payment and opt-in for one member's wallet, from the network parameters both sides agree on. */
export function starterTxns(sponsor: string, address: string, member: string, params: algosdk.SuggestedParams): [algosdk.Transaction, algosdk.Transaction] {
  const minFee = BigInt(params.minFee);
  const pay = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: sponsor, receiver: address, amount: STARTER_MICROALGOS, note: new TextEncoder().encode(starterNote(member)),
    suggestedParams: { ...params, flatFee: true, fee: minFee * 2n },
  });
  const optIn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: address, receiver: address, amount: 0, assetIndex: USDC_ASSET_ID, suggestedParams: { ...params, flatFee: true, fee: 0n },
  });
  algosdk.assignGroupID([pay, optIn]);
  return [pay, optIn];
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

export function createStarter(opts: StarterOptions) {
  const account = algosdk.mnemonicToSecretKey(opts.mnemonic);
  const sponsor = account.addr.toString();
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
    async start(member: string, signedOptIn: string): Promise<StarterResult> {
      let stxn: algosdk.SignedTransaction;
      try {
        stxn = algosdk.decodeSignedTransaction(base64.decode(signedOptIn));
      } catch {
        return { status: 400, error: 'not a signed transaction' };
      }
      const txn = stxn.txn;
      const address = txn.sender.toString();
      const { minFee } = await suggestedParams(algod, fetchImpl);
      const params: algosdk.SuggestedParams = {
        flatFee: true, fee: minFee, minFee, firstValid: txn.firstValid, lastValid: txn.lastValid, genesisID: txn.genesisID, genesisHash: txn.genesisHash,
      };
      if (txn.lastValid - txn.firstValid > 1000n) return { status: 400, error: 'validity window too long' };
      const [pay, expected] = starterTxns(sponsor, address, member, params);
      // The wallet must have signed exactly the opt-in we'd build: same fields, same group, nothing else.
      if (!same(algosdk.encodeUnsignedTransaction(expected), algosdk.encodeUnsignedTransaction(txn))) return { status: 400, error: 'that isn’t the starter opt-in for this wallet' };
      const state = await walletState(address, algod, fetchImpl);
      if (state.active) return { status: 409, error: 'this wallet is already started' };
      if (state.algo >= 200_000n) return { status: 409, error: 'this wallet already has enough ALGO to start itself' };
      if (await payments(starterNote(member), 0) > 0) return { status: 409, error: 'this account’s wallet was already started once' };
      if (await payments(STARTER_MEMO, Math.floor(Date.now() / 1000) - 86400) >= cap) return { status: 429, error: 'too many new wallets today; try again tomorrow' };
      const txid = await submit([pay.signTxn(account.sk), base64.decode(signedOptIn)], algod, fetchImpl);
      await confirmed(txid, algod, fetchImpl);
      return { txid };
    },
  };
}
