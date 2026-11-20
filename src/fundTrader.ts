/**
 * The development fund's trading rule. The fund waits in USDC. When ALGO's latest hourly close falls 20% below its
 * 14-day average it buys ALGO with all of its USDC, and sells everything above the ALGO reserve once the price is back
 * at the average. Mined ALGO that arrives while the fund is waiting is converted to USDC, as before.
 *
 * Evidence (tools/backtest-development-fund.ts, 2026-11-20, hourly ALGO since 2019 with measured costs and price impact):
 * dip-buying beat holding USDC across unseen years, walk-forward periods, BTC/ETH/SOL/DOGE and simulated years; trend
 * following, RSI, rebalancing and re-picking whatever worked lately all lost. The 14-day average did better than the
 * 20-day one first used (Nov 2026) in most of those checks. Round trips win often but the worst lost 46%; the
 * growth-optimal stake was about all of the USDC, so the trader never borrows. Past prices do not guarantee results.
 */
import {USDC_ASSET_ID} from './rails/algorand.ts';
import type {WalletConversion} from './walletConversion.ts';

export interface DipRule { hours: number; drop: number }
export const DIP_RULE: DipRule = {hours: 336, drop: 0.2};
/** Network fee limit for the fund's swaps. The app's 20,000 µALGO split larger trades into ~9 ALGO pieces, at most one
 * per 5-minute check, which in backtests lost most of the rule's edge once the fund held a few hundred ALGO. The
 * router has quoted up to ~56,000 for large trades; 100,000 µALGO is under $0.01 at today's price. */
export const FUND_FEE_CAP = 100_000n;
/** Smallest buy: below this the ~0.013 ALGO network fee is over 5% of the trade. */
export const MIN_BUY_USDC = 20_000n;
/** Mined ALGO is swept to USDC from 1 ALGO, the conversion service's existing threshold. */
export const MIN_SWEEP_ALGO = 1_000_000n;
/** How far a router quote may sit from the exchange price (router and pool fees are about 0.55%). */
export const MAX_QUOTE_GAP = 0.03;

export type Signal = 'buy' | 'sell' | 'wait';

/** `closes`: completed hourly USD closes, oldest first. The latest is compared with the average of the hours before it. */
export function dipSignal(closes: number[], inTrade: boolean, rule: DipRule = DIP_RULE): {signal: Signal; price: number; average: number; below: boolean} {
  if (closes.length < rule.hours + 1) throw Error(`Need ${rule.hours + 1} hourly closes, got ${closes.length}`);
  if (closes.some((c) => !Number.isFinite(c) || c <= 0)) throw Error('Invalid price history');
  const price = closes[closes.length - 1];
  const window = closes.slice(-rule.hours - 1, -1);
  const average = window.reduce((a, b) => a + b, 0) / window.length;
  const below = price < average * (1 - rule.drop);
  const signal: Signal = inTrade ? (price >= average ? 'sell' : 'wait') : below ? 'buy' : 'wait';
  return {signal, price, average, below};
}

export type Action =
  | {kind: 'buy'; usdc: bigint}
  | {kind: 'sell'; reason: 'exit' | 'sweep'}
  | {kind: 'flat'}
  | {kind: 'wait'; reason: string};

/** What to do now. `convertible` is the ALGO the reviewed conversion policy allows selling (above reserve and fees).
 * `below`: the price is still in the buy zone, so USDC left over from a buy split into pieces is spent too. */
export function decide(signal: Signal, inTrade: boolean, usdc: bigint, convertible: bigint, below = false): Action {
  if (inTrade) {
    if (signal !== 'sell') return below && usdc >= MIN_BUY_USDC ? {kind: 'buy', usdc}
      : {kind: 'wait', reason: 'holding ALGO until the price is back at its average'};
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

/** The router prices larger trades over more pools; when its network fees exceed the reviewed limit, try half as much.
 * The rest is traded on the next checks. Only preparing is retried here; nothing is signed. */
export async function fittingPlan(build: (amount: bigint) => Promise<WalletConversion>, full: bigint, min: bigint): Promise<WalletConversion> {
  for (let amount = full; amount >= min && amount > 0n; amount /= 2n) {
    try {
      return await build(amount);
    } catch (error) {
      if (!/network fees are too high/.test((error as Error).message)) throw error;
    }
  }
  throw Error('Router network fees exceed the limit even for the smallest trade.');
}
