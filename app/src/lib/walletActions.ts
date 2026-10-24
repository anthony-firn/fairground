/** Moving money with the built-in wallet. Loaded on demand: it carries the Algorand transaction library. */
import { authHeader } from '@core/httpauth.ts';
import { algorandUsdc } from '@core/rails/algorand.ts';
import type { PaymentRequest, Transfer } from '@core/rails/rail.ts';
import type { RampOrder } from '@core/ramp.ts';
import { starterTxns } from '@core/starter.ts';
import { confirmed, submit, suggestedParams, usdcPayment, walletKeys } from '@core/wallet.ts';
import { bytesToBase64 } from 'algosdk';
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

/** Turns the wallet on: the project's sponsor sends the ALGO it needs and pays for the USDC opt-in signed here. */
export async function startWallet(account: Account, sponsor: string): Promise<void> {
  const keys = walletKeys(account.nostrKey);
  const [, optIn] = starterTxns(sponsor, keys.address, account.pubkey, await suggestedParams());
  await call(account, '/wallet/start', 'POST', { optIn: bytesToBase64(optIn.signTxn(keys.secretKey)) });
  walletChanged();
}

/** Pays from the wallet: the same USDC transfer and memo a payment link would make, signed on this device. */
export async function payFromWallet(account: Account, request: PaymentRequest): Promise<Transfer> {
  const keys = walletKeys(account.nostrKey);
  const txid = await submit([usdcPayment(keys.address, request, await suggestedParams()).signTxn(keys.secretKey)]);
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

/** Opens Transak to buy USDC into this wallet, or to sell from it to a bank account. Returns the single-use link. */
export async function rampSession(account: Account, side: 'BUY' | 'SELL', walletAddress: string, amount?: number): Promise<string> {
  const back = `${location.origin}${location.pathname}?ramp=${side.toLowerCase()}`;
  return (await call<{ url: string }>(account, '/ramp/session', 'POST', { side, walletAddress, amount, redirectURL: back })).url;
}

export const rampOrder = (account: Account, id: string) => call<{ order: RampOrder; problem: string | null }>(account, `/ramp/order/${encodeURIComponent(id)}`, 'GET');
