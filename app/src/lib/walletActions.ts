/** Moving money with the built-in wallet: transactions signed on this device, and calls to the gateway. Loaded on demand. */
import { authHeader } from '@core/httpauth.ts';
import { algorandUsdc, USDC_ASSET_ID } from '@core/rails/algorand.ts';
import type { PaymentRequest, Transfer } from '@core/rails/rail.ts';
import { algoToBuy, convert, paidAlready, passThrough, type PassThrough } from '@core/passthrough.ts';
import { sellOrderProblem, type RampOrder, type RampSession } from '@core/ramp.ts';
import {
  confirmed, convertibleAlgo, needsFeeTopUp, sign, submit, suggestedParams, usdcOptIn, usdcPayment, walletKeys, walletState,
} from '@core/wallet.ts';
import type { Account } from './account.ts';
import {
  gatewayUrl, walletChanged, pendingRamp, rememberRamp, forgetRamp, pendingPassThrough, savePassThrough, type PendingPassThrough,
} from './wallet.ts';
import { LOCAL_PILOT, requireRealPayments } from './pilot.ts';
import { parseUsd } from '@core/pricing.ts';

async function call<T>(account: Account, path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
  const url = `${gatewayUrl()}${path}`;
  const text = body === undefined ? '' : JSON.stringify(body);
  const res = await fetch(url, {
    method, headers: { Authorization: authHeader(account.nostrKey, url, method, text), ...(text ? { 'Content-Type': 'application/json' } : {}) }, ...(text ? { body: text } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `The gateway said ${res.status}`);
  return json;
}

/** Converts ALGO or USDC through the exchange router, after checking exactly what the router asks the wallet to sign. */
const swap = (account: Account, from: number, to: number, amount: bigint): Promise<void> => convert(walletKeys(account.nostrKey), from, to, amount);

/**
 * Finishes a wallet's setup after its first deposit (ALGO): lets it hold USDC, then converts everything above the
 * reserve to dollars. Also converts ALGO that arrives later. Does nothing when there's nothing to do.
 */
export async function settleWallet(account: Account): Promise<'waiting' | 'converted' | 'idle'> {
  requireRealPayments();
  const keys = walletKeys(account.nostrKey);
  let state = await walletState(keys.address);
  if (!state.active) {
    if (state.algo < state.minimum + 101_000n) return 'waiting';
    await confirmed(await submit([sign(usdcOptIn(keys.address, await suggestedParams()), keys.seed)]));
    state = await walletState(keys.address);
    walletChanged();
  }
  const spare = convertibleAlgo(state);
  if (!spare) return 'idle';
  await swap(account, 0, USDC_ASSET_ID, spare);
  walletChanged();
  return 'converted';
}

/** Pays from the wallet: the same USDC transfer and memo a payment link would make, signed on this device. */
export async function payFromWallet(account: Account, request: PaymentRequest): Promise<Transfer> {
  requireRealPayments();
  const keys = walletKeys(account.nostrKey);
  // Keep a few cents of ALGO for network fees, bought with the wallet's own dollars, so payments never stall.
  const state = await walletState(keys.address);
  if (needsFeeTopUp(state) && state.usdc - request.amount >= 200_000n) await swap(account, USDC_ASSET_ID, 0, 100_000n).catch(() => undefined);
  const txid = await submit([sign(usdcPayment(keys.address, request, await suggestedParams()), keys.seed)]);
  await confirmed(txid);
  walletChanged();
  // The indexer catches up a moment after the block; until then, describe the transfer ourselves.
  for (let i = 0; i < 6; i++) {
    try {
      return await algorandUsdc.fetchTransfer(txid);
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return { id: txid, sender: keys.address, receiver: request.to, amount: request.amount, note: request.memo, time: Math.floor(Date.now() / 1000) };
}

/**
 * Create a Meld checkout on the gateway and save its correlation before navigating away. Purchases are ALGO; with
 * `receive` (micro-ALGO), the gateway sets the card amount so at least that much arrives.
 */
export async function rampSession(account: Account, side: 'BUY' | 'SELL', walletAddress: string, amount: number, subdivision: string, receive?: bigint): Promise<string> {
  const back = `${location.origin}${location.pathname}?ramp=${side.toLowerCase()}`;
  const session = await call<RampSession>(account, '/ramp/session', 'POST', {
    side, walletAddress, amount, asset: side === 'BUY' ? 'ALGO' : 'USDC', countryCode: 'US', subdivision, redirectURL: back,
    ...(receive === undefined ? {} : { receive: Number(receive) / 1e6 }),
  });
  if (session.environment === 'sandbox' && !LOCAL_PILOT) throw new Error('Sandbox checkout cannot be used with this mainnet wallet.');
  rememberRamp(account, { id: session.id, externalSessionId: session.externalSessionId, side, walletAddress, amount: session.amount ?? amount, environment: session.environment });
  return session.url;
}

export const rampOrder = (account: Account, id: string) => call<{ order: RampOrder; problem: string | null }>(account, `/ramp/order/${encodeURIComponent(id)}`, 'GET');

/** Bind a provider deposit instruction to the checkout this wallet actually opened. */
export function cashOutProblem(account: Account, order: RampOrder): string | undefined {
  const pending = pendingRamp(account, order.sessionId);
  if (!pending || pending.side !== 'SELL' || pending.id !== order.sessionId || pending.externalSessionId !== order.externalSessionId) return 'this wallet has no matching cash-out session';
  const problem = sellOrderProblem(order, account.pubkey);
  if (problem) return problem;
  const address = walletKeys(account.nostrKey).address;
  if (pending.walletAddress !== address || order.sourceWalletAddress !== address) return 'the cash-out source is a different wallet';
  if (parseUsd(order.cryptoAmount) !== parseUsd(String(pending.amount))) return 'the cash-out amount changed; open a new checkout';
  if (order.environment !== pending.environment || (order.environment === 'sandbox' && !LOCAL_PILOT)) return 'checkout and wallet environments do not match';
}

/** Recheck the provider just before signing, and find an earlier confirmed transfer before retrying. */
export async function payCashOut(account: Account, sessionId: string): Promise<void> {
  requireRealPayments();
  const { order, problem } = await rampOrder(account, sessionId);
  const invalid = problem ?? cashOutProblem(account, order);
  if (invalid) throw new Error(invalid);
  const memo = `fairground:cashout:${order.id}`;
  const existing = await algorandUsdc.listTransfers({ address: order.sourceWalletAddress, role: 'sender', notePrefix: memo, from: 0, to: Math.floor(Date.now() / 1000) + 600 });
  if (!existing.some((t) => t.note === memo && t.receiver === order.walletAddress && t.amount === parseUsd(order.cryptoAmount))) {
    await payFromWallet(account, { to: order.walletAddress, amount: parseUsd(order.cryptoAmount), memo });
  }
  forgetRamp(account, sessionId);
}

const requestsOf = (p: PendingPassThrough): PaymentRequest[] => p.requests.map((r) => ({ to: r.to, amount: BigInt(r.amount), memo: r.memo }));

/**
 * Starts a payment without a balance: checks every recipient can receive USDC, works out how much ALGO it takes, and
 * saves it so it finishes whenever that ALGO arrives, by card or from an exchange.
 */
export async function startPassThrough(account: Account, label: string, requests: PaymentRequest[], via: 'card' | 'transfer', flexible = false): Promise<PendingPassThrough> {
  requireRealPayments();
  const keys = walletKeys(account.nostrKey);
  if ((await walletState(keys.address)).active) throw new Error('Your wallet holds a balance, so pay from it instead.');
  for (const r of requests) {
    if (!(await algorandUsdc.canReceive(r.to))) throw new Error('A recipient’s wallet can’t receive payments yet, so nothing was charged.');
  }
  const total = requests.reduce((n, r) => n + r.amount, 0n);
  const pending: PendingPassThrough = {
    label, via, flexible, requests: requests.map((r) => ({ to: r.to, amount: r.amount.toString(), memo: r.memo })),
    need: (await algoToBuy(total)).toString(), created: Math.floor(Date.now() / 1000),
  };
  savePassThrough(account, pending);
  return pending;
}

/** Opens card checkout for the ALGO a pending payment still needs; `short` is what a first purchase came in under. */
export async function passThroughCheckout(account: Account, subdivision: string, short?: bigint): Promise<string> {
  const pending = pendingPassThrough(account);
  if (!pending) throw new Error('That payment was already finished or cancelled.');
  const owed = short ?? requestsOf(pending).reduce((n, r) => n + r.amount, 0n);
  const receive = short === undefined ? BigInt(pending.need) : await algoToBuy(short);
  // A first guess at the card amount; the gateway corrects it from Meld's quotes.
  return rampSession(account, 'BUY', walletKeys(account.nostrKey).address, Math.ceil(Number(owed) / 10_000 * 1.05 + 100) / 100, subdivision, receive);
}

/**
 * Takes the next step of the pending payment with whatever ALGO has arrived. One tab at a time does this, and a payment
 * that already went through (before a reload, or in the tab Meld returned to) is found rather than repeated.
 */
export async function finishPassThrough(account: Account, requests: PaymentRequest[]): Promise<PassThrough> {
  requireRealPayments();
  const run = async (): Promise<PassThrough> => {
    const pending = pendingPassThrough(account);
    const keys = walletKeys(account.nostrKey);
    if (!pending) {
      const elsewhere = await paidAlready(keys.address, requests, Math.floor(Date.now() / 1000) - 86_400, algorandUsdc);
      if (elsewhere) return { status: 'paid', transfers: elsewhere };
      throw new Error('That payment was cancelled.');
    }
    const earlier = await paidAlready(keys.address, requestsOf(pending), pending.created - 60, algorandUsdc).catch(() => undefined);
    const result = earlier ? { status: 'paid' as const, transfers: earlier } : await passThrough(keys, requestsOf(pending), {
      ownsHolding: !!pending.ownsHolding, flexible: pending.flexible,
      onSetUp: () => savePassThrough(account, { ...pending, ownsHolding: true }),
    });
    if (result.status === 'paid') savePassThrough(account, null);
    walletChanged();
    return result;
  };
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  return locks ? locks.request(`fairground-pass-through-${account.pubkey}`, run) : run();
}
