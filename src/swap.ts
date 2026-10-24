/**
 * Converting between ALGO and USDC inside the wallet, through Folks Router, an aggregator that finds the best price
 * across Algorand's exchanges. A wallet's first deposit arrives as ALGO (it needs some before it can hold USDC), and the
 * wallet converts all but a small reserve to dollars; later it can turn a few cents of USDC back into ALGO for fees.
 *
 * The router builds the transactions; the wallet checks every one before signing: all from this wallet, nothing
 * rekeyed or closed, the input going to the router, only the router's own swap calls, and the minimum it must receive.
 */
import { applicationAddress, decodeTxn, signRaw, type Txn } from './algotx.ts';
import { base64 } from '@scure/base';
import { addressKey } from './algotx.ts';

export const ROUTER_APP = 3279848327n;
export const ROUTER_API = 'https://api.folksrouter.io/v2';
/** Folks Router's minimum fee, in basis points. Fairground adds none of its own. */
export const ROUTER_FEE_BPS = 10;
/** The most a conversion may come in under its quote. */
export const SLIPPAGE_BPS = 50;
const SELECTOR = { forward: 'f06714c8', fixedInputEnd: '7dde205e' };

export interface SwapQuote {
  from: number;
  to: number;
  amount: bigint;
  /** What the router expects to deliver. */
  quote: bigint;
  priceImpact: number;
  /** Network fees in micro-ALGO. */
  fees: bigint;
  payload: string;
}

type Fetch = typeof fetch;
const defaultFetch: Fetch = (...a) => fetch(...a);

async function call(url: string, fetchImpl: Fetch): Promise<unknown> {
  const res = await fetchImpl(url);
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; result?: unknown; errors?: unknown };
  if (!body.success) throw new Error(`The exchange router couldn’t price this: ${String(body.errors ?? res.status)}`);
  return body.result;
}

/** A price for converting `amount` of one asset (0 for ALGO) into another. */
export async function quoteSwap(from: number, to: number, amount: bigint, fetchImpl: Fetch = defaultFetch, api = ROUTER_API): Promise<SwapQuote> {
  const q = new URLSearchParams({ network: 'mainnet', fromAsset: String(from), toAsset: String(to), amount: amount.toString(), type: 'FIXED_INPUT', maxGroupSize: '16', feeBps: String(ROUTER_FEE_BPS) });
  const r = (await call(`${api}/fetch/quote?${q}`, fetchImpl)) as { quoteAmount: string; priceImpact: number; microalgoTxnsFee: number; txnPayload: string };
  return { from, to, amount, quote: BigInt(r.quoteAmount), priceImpact: r.priceImpact, fees: BigInt(r.microalgoTxnsFee), payload: r.txnPayload };
}

/** The router's unsigned transactions for a quote. */
export async function prepareSwap(user: string, q: SwapQuote, fetchImpl: Fetch = defaultFetch, api = ROUTER_API): Promise<Uint8Array[]> {
  const params = new URLSearchParams({ userAddress: user, slippageBps: String(SLIPPAGE_BPS), txnPayload: q.payload });
  const r = (await call(`${api}/prepare/swap?${params}`, fetchImpl)) as string[];
  return r.map((t) => base64.decode(t));
}

export const minReceive = (q: Pick<SwapQuote, 'quote'>, slippageBps = SLIPPAGE_BPS): bigint => q.quote - (q.quote * BigInt(slippageBps)) / 10_000n;

const hex = (b: unknown) => (b instanceof Uint8Array ? [...b].map((x) => x.toString(16).padStart(2, '0')).join('') : '');
const uint64 = (b: unknown) => (b instanceof Uint8Array && b.length === 8 ? b.reduce((v, x) => (v << 8n) | BigInt(x), 0n) : -1n);
const same = (a: unknown, b: Uint8Array) => a instanceof Uint8Array && a.length === b.length && a.every((x, i) => x === b[i]);

/** Why the router's transactions shouldn't be signed, or undefined if they do exactly what was asked. */
export function swapProblem(raw: Uint8Array[], user: string, q: SwapQuote): string | undefined {
  if (raw.length < 2 || raw.length > 16) return 'unexpected number of transactions';
  let txns: Txn[];
  try {
    txns = raw.map(decodeTxn);
  } catch {
    return 'unreadable transactions';
  }
  const me = addressKey(user);
  const router = addressKey(applicationAddress(ROUTER_APP));
  const group = txns[0].grp;
  let fees = 0n;
  for (const t of txns) {
    if (!same(t.snd, me)) return 'a transaction isn’t from this wallet';
    if (t.rekey !== undefined || t.close !== undefined || t.aclose !== undefined || t.asnd !== undefined) return 'a transaction would hand over or empty the wallet';
    if (!(group instanceof Uint8Array) || !same(t.grp, group)) return 'the transactions aren’t one group';
    fees += typeof t.fee === 'bigint' ? t.fee : 0n;
  }
  if (fees > 20_000n) return 'network fees are too high';
  const [first, ...rest] = txns;
  const last = rest.pop()!;
  const sends = q.from === 0
    ? first.type === 'pay' && same(first.rcv, router) && first.amt === q.amount
    : first.type === 'axfer' && same(first.arcv, router) && first.xaid === BigInt(q.from) && first.aamt === q.amount;
  if (!sends) return 'the first transaction doesn’t send the amount to the router';
  const routerCall = (t: Txn, selector: string) => t.type === 'appl' && t.apid === ROUTER_APP && t.apan === undefined && Array.isArray(t.apaa) && hex(t.apaa[0]) === selector;
  if (!rest.every((t) => routerCall(t, SELECTOR.forward))) return 'a transaction isn’t the router’s swap';
  if (!routerCall(last, SELECTOR.fixedInputEnd)) return 'the last transaction isn’t the router’s swap';
  const args = last.apaa as unknown[];
  if (uint64(args[1]) !== BigInt(q.to)) return 'it would deliver the wrong asset';
  if (uint64(args[2]) !== minReceive(q)) return 'its minimum doesn’t match the quote';
  return undefined;
}

export const signSwap = (raw: Uint8Array[], seed: Uint8Array): Uint8Array[] => raw.map((r) => signRaw(r, seed));
