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
import {LEND_MIN_USDC, type LendingKind} from './fundLending.ts';
import {ALGO_COLLATERAL_FACTOR, loanHealth} from './fundLoan.ts';

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

/** What to do with the Folks USDC pool before `action`: withdraw everything when buying, otherwise lend USDC that is
 * only waiting (opting in to fUSDC the first time). `fusdc` is null when the wallet is not opted in. */
export function lendingStep(action: Action, inTrade: boolean, walletUsdc: bigint, fusdc: bigint | null): LendingKind | undefined {
  if (action.kind === 'buy') return fusdc && fusdc > 0n ? 'withdraw' : undefined;
  if (action.kind === 'wait' && !inTrade && walletUsdc >= LEND_MIN_USDC) return fusdc === null ? 'optin' : 'deposit';
}

/** Leverage for dip trades: own USDC buys ALGO, which becomes collateral for borrowing (LEVERAGE - 1) times as much.
 * The backtests (tools/backtest-development-fund.ts --leverage) put the growth-optimal amount near 1.25×. */
export const LEVERAGE = 1.25;
/** Below this health (collateral × 0.65 / debt) the trader repays part of the debt itself, back to DELEVER_TO, rather
 * than let a liquidator take collateral at an 8% bonus. Borrowing never starts below BORROW_HEALTH. */
export const DELEVER_HEALTH = 1.15, DELEVER_TO = 1.6, BORROW_HEALTH = 2;
/** Smallest own stake worth leveraging: a leveraged trade takes about six Folks groups (~0.06 ALGO of fees in all). */
export const MIN_LEVER_USDC = 5_000_000n;
/** ALGO kept back from sweeps until the loan exists: the escrow's funding plus the setup fees. */
export const LOAN_SETUP_ALGO = 950_000n;

export interface LoanView {
  inTrade: boolean; levered: boolean; hasEscrow: boolean; collateralAdded: boolean;
  /** µALGO the wallet could sell or deposit, µUSDC in the wallet. */
  walletAlgo: bigint; walletUsdc: bigint;
  /** µfALGO collateral, the ALGO pool's deposit index (1e14 scale), µUSDC owed now, USD per ALGO. */
  collateralF: bigint; algoIndex: bigint; debt: bigint; price: number;
  /** Own µUSDC spent on this trade (what leverage multiplies), and whether setup fees and funding are covered. */
  tradeUsdc: bigint; setupAffordable: boolean;
}
export type LoanAction =
  | {step: 'create'} | {step: 'addCollateral'} | {step: 'depositCollateral'; algo: bigint} | {step: 'borrow'; usdc: bigint}
  | {step: 'leverBuy'; usdc: bigint} | {step: 'repay'; usdc: bigint} | {step: 'sellAlgo'; algo: bigint} | {step: 'releaseCollateral'; f: bigint};

const minOf = (a: bigint, b: bigint) => (a < b ? a : b);
/** The next loan step, from the loan's actual state. One step per call; the trader calls it again after each one. */
export function loanStep(v: LoanView, leverage = LEVERAGE): LoanAction | undefined {
  if (leverage <= 1) return undefined;
  const collateralAlgo = (v.collateralF * v.algoIndex) / 10n ** 14n, collateralUsd = Number(collateralAlgo) / 1e6 * v.price;
  const debtUsd = Number(v.debt) / 1e6, health = loanHealth(Number(collateralAlgo) / 1e6, v.price, debtUsd);
  if (v.debt > 0n) {
    if (v.inTrade && health < DELEVER_HEALTH) {
      const keep = BigInt(Math.floor((collateralUsd * ALGO_COLLATERAL_FACTOR) / DELEVER_TO * 1e6)), cut = v.debt > keep ? v.debt - keep : 0n;
      if (cut <= 0n) return undefined;
      if (v.walletUsdc >= MIN_BUY_USDC) return {step: 'repay', usdc: minOf(v.walletUsdc, cut + cut / 50n)};
      if (v.walletAlgo > 0n) return {step: 'sellAlgo', algo: minOf(v.walletAlgo, BigInt(Math.ceil((Number(cut) / v.price) * 1.03)))};
      return undefined;
    }
    if (v.inTrade) return v.levered && v.walletUsdc >= MIN_BUY_USDC ? {step: 'leverBuy', usdc: v.walletUsdc} : undefined;
    // Trade over: pay the loan back. Overpaying is refunded by the pool, so a margin covers interest to the second.
    if (v.walletUsdc > 0n) return {step: 'repay', usdc: minOf(v.walletUsdc, v.debt + v.debt / 1000n + 10n)};
    if (v.walletAlgo > 0n) return undefined;                       // the sweep sells it to USDC first
    if (v.collateralF > 0n) {
      const algo = BigInt(Math.ceil((debtUsd * 1.05) / v.price * 1e6)), f = (algo * 10n ** 14n) / v.algoIndex + 1n;
      return {step: 'releaseCollateral', f: minOf(f, v.collateralF)};
    }
    return undefined;
  }
  if (!v.inTrade) {
    if (v.collateralF > 0n) return {step: 'releaseCollateral', f: v.collateralF};
    if (!v.hasEscrow) return v.setupAffordable ? {step: 'create'} : undefined;
    if (!v.collateralAdded) return v.setupAffordable ? {step: 'addCollateral'} : undefined;
    return undefined;
  }
  if (!v.hasEscrow || !v.collateralAdded || v.levered || v.tradeUsdc < MIN_LEVER_USDC) return undefined;
  if (v.collateralF === 0n) return v.walletAlgo >= MIN_SWEEP_ALGO ? {step: 'depositCollateral', algo: v.walletAlgo} : undefined;
  const want = (v.tradeUsdc * BigInt(Math.round((leverage - 1) * 1000))) / 1000n;
  const cap = BigInt(Math.floor((collateralUsd * ALGO_COLLATERAL_FACTOR) / BORROW_HEALTH * 1e6)), usdc = minOf(want, cap);
  return usdc >= MIN_BUY_USDC ? {step: 'borrow', usdc} : undefined;
}

export type Move =
  | {kind: 'swap'; buy?: bigint; sell?: {algo: bigint; reason: 'exit' | 'sweep' | 'delever'}}
  | {kind: 'lending'; step: LendingKind}
  | {kind: 'loan'; act: LoanAction};
/** The single most urgent step: protect a loan near liquidation, free lent USDC for a buy, trade, then loan upkeep, then
 * lend what is idle (never while debt is owed; the caller drops lending deposits then). */
export function nextMove(o: {inTrade: boolean; action: Action; lend?: LendingKind; loanAct?: LoanAction; walletUsdc: bigint; convertible: bigint}): Move | undefined {
  const a = o.loanAct;
  if (o.inTrade && a?.step === 'repay') return {kind: 'loan', act: a};
  if (o.inTrade && a?.step === 'sellAlgo') return {kind: 'swap', sell: {algo: a.algo, reason: 'delever'}};
  if (o.lend === 'withdraw') return {kind: 'lending', step: 'withdraw'};
  if (o.action.kind === 'buy') return {kind: 'swap', buy: o.action.usdc < o.walletUsdc ? o.action.usdc : o.walletUsdc};
  if (o.action.kind === 'sell') return {kind: 'swap', sell: {algo: o.convertible, reason: o.action.reason === 'exit' ? 'exit' : 'sweep'}};
  if (a?.step === 'leverBuy') return {kind: 'swap', buy: a.usdc};
  if (a) return {kind: 'loan', act: a};
  if (o.lend) return {kind: 'lending', step: o.lend};
}
