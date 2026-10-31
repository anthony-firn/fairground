/** Moving money with the built-in wallet: transactions signed on this device, and calls to the gateway. Loaded on demand. */
import { authHeader } from '@core/httpauth.ts';
import { algorandUsdc, USDC_ASSET_ID } from '@core/rails/algorand.ts';
import type { PaymentRequest, Transfer } from '@core/rails/rail.ts';
import { sellOrderProblem, type RampOrder, type RampSession } from '@core/ramp.ts';
import { prepareSwap, quoteSwap, signSwap, swapProblem } from '@core/swap.ts';
import {
  confirmed, convertibleAlgo, needsFeeTopUp, sign, submit, suggestedParams, usdcOptIn, usdcPayment, walletKeys, walletState,
} from '@core/wallet.ts';
import type { Account } from './account.ts';
import { gatewayUrl, walletChanged, pendingRamp, rememberRamp, forgetRamp } from './wallet.ts';
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
async function swap(account: Account, from: number, to: number, amount: bigint): Promise<void> {
  const keys = walletKeys(account.nostrKey);
  const q = await quoteSwap(from, to, amount);
  const raw = await prepareSwap(keys.address, q);
  const problem = swapProblem(raw, keys.address, q);
  if (problem) throw new Error(`The conversion was refused: ${problem}.`);
  await confirmed(await submit(signSwap(raw, keys.seed)));
}

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

/** Create a Meld checkout on the gateway and save its correlation before navigating away. */
export async function rampSession(account: Account, side: 'BUY' | 'SELL', walletAddress: string, amount: number, asset: 'USDC' | 'ALGO', subdivision: string): Promise<string> {
  const back = `${location.origin}${location.pathname}?ramp=${side.toLowerCase()}`;
  const session = await call<RampSession>(account, '/ramp/session', 'POST', { side, walletAddress, amount, asset, countryCode: 'US', subdivision, redirectURL: back });
  if (session.environment === 'sandbox' && !LOCAL_PILOT) throw new Error('Sandbox checkout cannot be used with this mainnet wallet.');
  rememberRamp(account, { id: session.id, externalSessionId: session.externalSessionId, side, walletAddress, amount, environment: session.environment });
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
