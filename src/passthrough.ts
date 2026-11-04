/**
 * Paying without keeping a balance. Someone who only wants to pay or donate buys ALGO, by card through Meld or from an
 * exchange, into their own wallet. The wallet turns it into the exact USDC payment, memo included, and closes in the
 * same step, sending what's left (the buffer bought against price moves, and the account minimums Algorand would
 * otherwise hold back) to the recipient. Nothing stays behind, so only people who keep a balance, get paid or cash out
 * ever set a wallet up.
 *
 * Card suppliers deliver only to the buyer's own wallet. This is that wallet: its key never leaves the buyer's device.
 */
import { assetTxn, assignGroup, payTxn, txid, type Txn } from './algotx.ts';
import { USDC_ASSET_ID } from './rails/algorand.ts';
import type { PaymentRequest, Rail, Transfer } from './rails/rail.ts';
import { prepareSwap, quoteSwap, ROUTER_API, signSwap, swapProblem } from './swap.ts';
import { confirmed, sign, submit, suggestedParams, usdcOptIn, type WalletKeys } from './wallet.ts';
import { DEFAULT_ALGOD, walletState } from './walletkey.ts';

/** Held back from conversion: the minimums (0.1 ALGO for the account, 0.1 to hold USDC) and fees to convert, pay and close. */
export const PASS_THROUGH_RESERVE = 240_000n;
/** ALGO bought above the quote, because buying dollars back costs more than selling them and prices move during checkout. */
export const BUFFER_BPS = 300n;
/** Payments in one group, which also closes the account. */
export const MAX_RECIPIENTS = 14;

export interface Network {
  algod?: string;
  fetch?: typeof fetch;
  router?: string;
  routerFetch?: typeof fetch;
}

const globalFetch: typeof fetch = (...a) => fetch(...a);
const resolve = (n: Network) => ({ algod: n.algod ?? DEFAULT_ALGOD, fetch: n.fetch ?? globalFetch, router: n.router ?? ROUTER_API, routerFetch: n.routerFetch ?? globalFetch });

/** Converts through the exchange router after checking exactly what it asks the wallet to sign, and waits for it. */
export async function convert(keys: WalletKeys, from: number, to: number, amount: bigint, n: Network = {}): Promise<void> {
  const { algod, fetch: f, router, routerFetch } = resolve(n);
  const q = await quoteSwap(from, to, amount, routerFetch, router);
  const raw = await prepareSwap(keys.address, q, routerFetch, router);
  const problem = swapProblem(raw, keys.address, q);
  if (problem) throw new Error(`The conversion was refused: ${problem}.`);
  await confirmed(await submit(signSwap(raw, keys.seed), algod, f), algod, f);
}

/** Micro-ALGO to buy for payments totalling `total` micro-dollars, including the reserve and the opt-in's fee. */
export async function algoToBuy(total: bigint, n: Network = {}): Promise<bigint> {
  const { router, routerFetch } = resolve(n);
  const q = await quoteSwap(USDC_ASSET_ID, 0, total, routerFetch, router);
  return (q.quote * (10_000n + BUFFER_BPS)) / 10_000n + PASS_THROUGH_RESERVE + 1_000n;
}

export type PassThrough =
  /** Too little ALGO has arrived to start. */
  | { status: 'waiting'; algo: bigint }
  /** Converted, but short of the payments (prices moved); more ALGO finishes it. */
  | { status: 'short'; usdc: bigint; total: bigint }
  | { status: 'paid'; transfers: Transfer[] };

export interface PassThroughOptions extends Network {
  /** Whether this payment set up the wallet's USDC holding, so everything in it is the payer's money for this payment. */
  ownsHolding: boolean;
  /** Called once this payment has set the wallet up to hold USDC. */
  onSetUp?: () => void;
  /** Donations: if prices moved, pay what arrived, split in the same proportions. */
  flexible?: boolean;
}

/**
 * Takes the next step with whatever ALGO has arrived: set up, convert, then pay everyone and close the account in one
 * group. Safe to call again after any step; it never closes a wallet holding a balance this payment didn't put there.
 */
export async function passThrough(keys: WalletKeys, requests: PaymentRequest[], o: PassThroughOptions): Promise<PassThrough> {
  if (!requests.length || requests.length > MAX_RECIPIENTS) throw new Error(`Pay between 1 and ${MAX_RECIPIENTS} recipients at once.`);
  if (requests.some((r) => r.to === keys.address || r.amount <= 0n)) throw new Error('That isn’t a payment this wallet can make.');
  const { algod, fetch: f } = resolve(o);
  const total = requests.reduce((n, r) => n + r.amount, 0n);
  let state = await walletState(keys.address, algod, f);
  if (state.active && !o.ownsHolding) throw new Error('This wallet holds a balance, so pay from it instead.');
  if (!state.active) {
    if (state.algo < state.minimum + 101_000n) return { status: 'waiting', algo: state.algo };
    await confirmed(await submit([sign(usdcOptIn(keys.address, await suggestedParams(algod, f)), keys.seed)], algod, f), algod, f);
    o.onSetUp?.();
    state = await walletState(keys.address, algod, f);
  }
  const spare = state.algo - PASS_THROUGH_RESERVE;
  if (state.usdc < total && spare >= 100_000n) {
    await convert(keys, 0, USDC_ASSET_ID, spare, o);
    state = await walletState(keys.address, algod, f);
  }
  let pay = requests;
  if (state.usdc < total) {
    if (!o.flexible || !state.usdc) return { status: 'short', usdc: state.usdc, total };
    pay = requests.map((r) => ({ ...r, amount: (r.amount * state.usdc) / total })).filter((r) => r.amount > 0n);
    if (!pay.length) return { status: 'short', usdc: state.usdc, total };
  }
  // The first recipient also receives what's left, so pay the others first, then the first, closing into them.
  const [first, ...rest] = pay;
  const params = await suggestedParams(algod, f);
  const note = (r: PaymentRequest) => new TextEncoder().encode(r.memo);
  const txns: Txn[] = [
    ...rest.map((r) => assetTxn(keys.address, r.to, USDC_ASSET_ID, r.amount, params, note(r))),
    assetTxn(keys.address, first.to, USDC_ASSET_ID, first.amount, params, note(first), first.to),
    payTxn(keys.address, first.to, 0n, params, undefined, first.to),
  ];
  assignGroup(txns);
  await confirmed(await submit(txns.map((t) => sign(t, keys.seed)), algod, f), algod, f);
  const time = Math.floor(Date.now() / 1000);
  const transfer = (r: PaymentRequest, t: Txn): Transfer => ({ id: txid(t), sender: keys.address, receiver: r.to, amount: r.amount, note: r.memo, time });
  return { status: 'paid', transfers: [transfer(first, txns[rest.length]), ...rest.map((r, i) => transfer(r, txns[i]))] };
}

/** The transfers this wallet already made for every one of these payments since `since`, after an interrupted attempt. */
export async function paidAlready(sender: string, requests: PaymentRequest[], since: number, rail: Rail): Promise<Transfer[] | undefined> {
  const sent = await rail.listTransfers({ address: sender, role: 'sender', notePrefix: '', from: since, to: Math.floor(Date.now() / 1000) + 600 });
  const found = requests.map((r) => sent.find((t) => t.receiver === r.to && t.note === r.memo));
  return found.every((t) => t) ? (found as Transfer[]) : undefined;
}
