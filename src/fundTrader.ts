/**
 * The development fund's trading rule. The fund waits in USDC. When ALGO's latest hourly close falls 20% below its
 * 20-day average it buys ALGO with all of its USDC, and sells everything above the ALGO reserve once the price is back
 * at the average. Mined ALGO that arrives while the fund is waiting is converted to USDC, as before.
 *
 * Why this rule: on two years of hourly ALGO prices with measured Folks Router costs (about 0.55% per swap plus
 * ~0.013 ALGO network fees), parameters were ranked on the first year and checked on the second. Faster rules
 * (shorter averages, shallower dips, moving-average trend following) won the first year and lost the second; this one
 * beat holding USDC in both. On daily prices since 2021 the same rule beat USDC lending in about 80% of one-year windows.
 * Its edge is small and it trades a few times a year. Past prices do not guarantee it keeps working.
 */
import {USDC_ASSET_ID} from './rails/algorand.ts';
import type {WalletConversion} from './walletConversion.ts';

export interface DipRule { hours: number; drop: number }
export const DIP_RULE: DipRule = {hours: 480, drop: 0.2};
/** Smallest buy: below this the ~0.013 ALGO network fee is over 5% of the trade. */
export const MIN_BUY_USDC = 20_000n;
/** Mined ALGO is swept to USDC from 1 ALGO, the conversion service's existing threshold. */
export const MIN_SWEEP_ALGO = 1_000_000n;
/** How far a router quote may sit from the exchange price (router and pool fees are about 0.55%). */
export const MAX_QUOTE_GAP = 0.03;

export type Signal = 'buy' | 'sell' | 'wait';

/** `closes`: completed hourly USD closes, oldest first. The latest is compared with the average of the hours before it. */
export function dipSignal(closes: number[], inTrade: boolean, rule: DipRule = DIP_RULE): {signal: Signal; price: number; average: number} {
  if (closes.length < rule.hours + 1) throw Error(`Need ${rule.hours + 1} hourly closes, got ${closes.length}`);
  if (closes.some((c) => !Number.isFinite(c) || c <= 0)) throw Error('Invalid price history');
  const price = closes[closes.length - 1];
  const window = closes.slice(-rule.hours - 1, -1);
  const average = window.reduce((a, b) => a + b, 0) / window.length;
  const signal: Signal = inTrade ? (price >= average ? 'sell' : 'wait') : price < average * (1 - rule.drop) ? 'buy' : 'wait';
  return {signal, price, average};
}

export type Action =
  | {kind: 'buy'; usdc: bigint}
  | {kind: 'sell'; reason: 'exit' | 'sweep'}
  | {kind: 'flat'}
  | {kind: 'wait'; reason: string};

/** What to do now. `convertible` is the ALGO the reviewed conversion policy allows selling (above reserve and fees). */
export function decide(signal: Signal, inTrade: boolean, usdc: bigint, convertible: bigint): Action {
  if (inTrade) {
    if (signal !== 'sell') return {kind: 'wait', reason: 'holding ALGO until the price is back at its average'};
    return convertible > 0n ? {kind: 'sell', reason: 'exit'} : {kind: 'flat'};
  }
  if (signal === 'buy' && usdc >= MIN_BUY_USDC) return {kind: 'buy', usdc};
  if (convertible >= MIN_SWEEP_ALGO) return {kind: 'sell', reason: 'sweep'};
  return {kind: 'wait', reason: signal === 'buy' ? 'a dip, but too little USDC to buy' : 'waiting in USDC for a dip'};
}

/** USD per ALGO implied by a prepared swap, checked against an exchange price before signing. */
export function quotePriceProblem(plan: Pick<WalletConversion, 'quote'>, reference: number): string | undefined {
  const {from, to, amount, quote} = plan.quote;
  if (!Number.isFinite(reference) || reference <= 0) return 'No exchange price to compare the quote with.';
  const implied = from === 0 && to === USDC_ASSET_ID ? Number(quote) / Number(amount)
    : from === USDC_ASSET_ID && to === 0 ? Number(amount) / Number(quote) : NaN;
  if (!Number.isFinite(implied) || implied <= 0) return 'The quote does not price ALGO against USDC.';
  if (Math.abs(implied / reference - 1) > MAX_QUOTE_GAP) return `The router price $${implied.toFixed(5)} is more than ${MAX_QUOTE_GAP * 100}% from the exchange price $${reference.toFixed(5)}.`;
}
