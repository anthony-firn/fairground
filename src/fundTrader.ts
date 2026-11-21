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
import {GENERAL_LOAN, loanHealth, type LoanKind} from './fundLoan.ts';

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

/** Leverage for dip trades, from LOAN_KIND: own USDC buys ALGO, which becomes collateral; the trader borrows USDC
 * against it, buys more ALGO, deposits that too, and repeats until the debt is (LEVERAGE - 1) times its own stake.
 * Anthony chose 2x for its higher mean ("easy come easy go"; mining keeps refilling the fund). Folks' Ultraswap loan
 * (ALGO at 0.825) was the first choice, but its ALGO collateral cap is 0 (simulation 2026-11-21: sync_collateral
 * fails the cap check), so this is the general loan (0.65, 8% liquidation bonus) with self-deleveraging.
 * tools/backtest-development-fund.ts --leverage (2026-11-21), general 2x entering at health ≥ 1.25 and selling down
 * below 1.05 back to 1.15: median / mean simulated year 1.130x / 1.210x (1.25x: 1.121x / 1.151x), 2019-2026 IRR +65.1%
 * (+47.9%), no liquidations even under stress, but it loses half in 6.5% of simulated years (1.25x: 2%). */
export const LOAN_KIND: LoanKind = GENERAL_LOAN;
export const LEVERAGE = 2;
/** Health is collateral × the loan's factor / debt (below 1 the loan can be liquidated). Below DELEVER_HEALTH the trader
 * sells down itself until health is back to DELEVER_TO; borrowing never takes health below BORROW_HEALTH; collateral
 * only leaves the loan while health stays at least RELEASE_HEALTH (the loan refuses a release below 1). */
export const DELEVER_HEALTH = 1.05, DELEVER_TO = 1.15, BORROW_HEALTH = 1.25, RELEASE_HEALTH = 1.02;
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
  /** A sell-down is under way (health fell below DELEVER_HEALTH and has not yet recovered to DELEVER_TO). */
  delevering?: boolean;
}
/** The loan's health from the view (Infinity without debt). */
export function viewHealth(v: Pick<LoanView, 'collateralF' | 'algoIndex' | 'debt' | 'price'>, collateralFactor = LOAN_KIND.collateralFactor): number {
  const collateralAlgo = Number((v.collateralF * v.algoIndex) / 10n ** 14n) / 1e6;
  return loanHealth(collateralAlgo, v.price, Number(v.debt) / 1e6, collateralFactor);
}
/** Whether a sell-down should continue: it starts below DELEVER_HEALTH and runs until DELEVER_TO. */
export const nextDelevering = (health: number, was: boolean): boolean => health < DELEVER_HEALTH || (was && health < DELEVER_TO);
export type LoanAction =
  | {step: 'create'} | {step: 'addCollateral'} | {step: 'depositCollateral'; algo: bigint} | {step: 'borrow'; usdc: bigint}
  | {step: 'leverBuy'; usdc: bigint} | {step: 'repay'; usdc: bigint} | {step: 'sellAlgo'; algo: bigint} | {step: 'releaseCollateral'; f: bigint};

const minOf = (a: bigint, b: bigint) => (a < b ? a : b);
/** The next loan step, from the loan's actual state. One step per call; the trader calls it again after each one. */
export function loanStep(v: LoanView, leverage = LEVERAGE, collateralFactor = LOAN_KIND.collateralFactor): LoanAction | undefined {
  if (leverage <= 1) return undefined;
  const cf = collateralFactor;
  const collateralAlgo = (v.collateralF * v.algoIndex) / 10n ** 14n, collateralUsd = Number(collateralAlgo) / 1e6 * v.price;
  const debtUsd = Number(v.debt) / 1e6, health = viewHealth(v, cf);
  // fALGO that may leave the loan while its health stays at least RELEASE_HEALTH.
  const releasable = (): bigint => {
    const spareAlgo = (collateralUsd - (debtUsd * RELEASE_HEALTH) / cf) / v.price;
    return spareAlgo <= 0 ? 0n : minOf(v.collateralF, (BigInt(Math.floor(spareAlgo * 1e6)) * 10n ** 14n) / v.algoIndex);
  };
  if (v.debt > 0n) {
    if (v.inTrade && nextDelevering(health, !!v.delevering)) {
      const keep = BigInt(Math.floor((collateralUsd * cf) / DELEVER_TO * 1e6)), cut = v.debt > keep ? v.debt - keep : 0n;
      if (cut <= 0n) return undefined;
      if (v.walletUsdc >= MIN_BUY_USDC) return {step: 'repay', usdc: minOf(v.walletUsdc, cut + cut / 50n)};
      if (v.walletAlgo > 0n) return {step: 'sellAlgo', algo: minOf(v.walletAlgo, BigInt(Math.ceil((Number(cut) / v.price) * 1.03)))};
      // All the ALGO is collateral: take out what the loan allows, to sell next.
      const f = releasable();
      return f > 0n ? {step: 'releaseCollateral', f} : undefined;
    }
    if (v.inTrade) {
      if (v.levered && v.walletUsdc >= MIN_BUY_USDC) return {step: 'leverBuy', usdc: v.walletUsdc};
      // Levering up: deposit what the last borrow bought, then borrow again, until the debt reaches the target.
      const want = (v.tradeUsdc * BigInt(Math.round((leverage - 1) * 1000))) / 1000n;
      if (v.levered && v.debt < want) {
        if (v.walletAlgo >= MIN_SWEEP_ALGO) return {step: 'depositCollateral', algo: v.walletAlgo};
        const cap = BigInt(Math.floor((collateralUsd * cf) / BORROW_HEALTH * 1e6)), room = cap > v.debt ? cap - v.debt : 0n, usdc = minOf(want - v.debt, room);
        if (usdc >= MIN_BUY_USDC) return {step: 'borrow', usdc};
      }
      return undefined;
    }
    // Trade over: pay the loan back. Overpaying is refunded by the pool, so a margin covers interest to the second.
    if (v.walletUsdc > 0n) return {step: 'repay', usdc: minOf(v.walletUsdc, v.debt + v.debt / 1000n + 10n)};
    if (v.walletAlgo > 0n) return undefined;                       // the sweep sells it to USDC first
    if (v.collateralF > 0n) {
      // Release enough to repay with a margin, but no more than keeps the loan healthy; repeat after each repayment.
      const algo = BigInt(Math.ceil((debtUsd * 1.05) / v.price * 1e6)), f = minOf((algo * 10n ** 14n) / v.algoIndex + 1n, minOf(v.collateralF, releasable()));
      return f > 0n ? {step: 'releaseCollateral', f} : undefined;
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
  const cap = BigInt(Math.floor((collateralUsd * cf) / BORROW_HEALTH * 1e6)), usdc = minOf(want, cap);
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
  if (o.inTrade && a?.step === 'releaseCollateral') return {kind: 'loan', act: a};   // selling down: free collateral to sell
  if (o.lend === 'withdraw') return {kind: 'lending', step: 'withdraw'};
  if (o.action.kind === 'buy') return {kind: 'swap', buy: o.action.usdc < o.walletUsdc ? o.action.usdc : o.walletUsdc};
  if (o.action.kind === 'sell') return {kind: 'swap', sell: {algo: o.convertible, reason: o.action.reason === 'exit' ? 'exit' : 'sweep'}};
  if (a?.step === 'leverBuy') return {kind: 'swap', buy: a.usdc};
  if (a) return {kind: 'loan', act: a};
  if (o.lend) return {kind: 'lending', step: o.lend};
}
