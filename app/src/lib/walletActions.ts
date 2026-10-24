/** Moving money with the built-in wallet: transactions signed on this device, and calls to the gateway. Loaded on demand. */
import { authHeader } from '@core/httpauth.ts';
import { algorandUsdc, USDC_ASSET_ID } from '@core/rails/algorand.ts';
import type { PaymentRequest, Transfer } from '@core/rails/rail.ts';
import type { RampOrder } from '@core/ramp.ts';
import { prepareSwap, quoteSwap, signSwap, swapProblem } from '@core/swap.ts';
import {
  confirmed, convertibleAlgo, needsFeeTopUp, SETUP_MICROALGOS, sign, submit, suggestedParams, usdcOptIn, usdcPayment, walletKeys, walletState,
} from '@core/wallet.ts';
import type { Account } from './account.ts';
import { gatewayUrl, walletChanged } from './wallet.ts';

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
  const keys = walletKeys(account.nostrKey);
  let state = await walletState(keys.address);
  if (!state.active) {
    if (state.algo < SETUP_MICROALGOS) return 'waiting';
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
 * Opens Transak to buy into this wallet (ALGO for a wallet's first deposit, which it needs before it can hold dollars;
 * USDC after that), or to sell from it to a bank account. Returns the single-use link.
 */
export async function rampSession(account: Account, side: 'BUY' | 'SELL', walletAddress: string, amount?: number, asset: 'USDC' | 'ALGO' = 'USDC'): Promise<string> {
  const back = `${location.origin}${location.pathname}?ramp=${side.toLowerCase()}`;
  return (await call<{ url: string }>(account, '/ramp/session', 'POST', { side, walletAddress, amount, asset, redirectURL: back })).url;
}

export const rampOrder = (account: Account, id: string) => call<{ order: RampOrder; problem: string | null }>(account, `/ramp/order/${encodeURIComponent(id)}`, 'GET');
