/**
 * Backtests for the development fund's trading, modeled on what the live trader (tools/trade-development-fund.ts)
 * actually does rather than on idealized fills:
 *
 * - decisions use completed hourly closes; trades fill at the next hour's open (no look-ahead);
 * - each swap loses a proportional cost (pool + router fees and the pool's gap to exchange prices) and pays the
 *   router's network fee in ALGO, measured by trade size;
 * - a group may carry at most 20,000 µALGO of fees, so larger trades are halved into pieces, at most one per
 *   5-minute check (12 an hour), each re-decided the way the bot re-decides;
 * - the 0.5 ALGO reserve policy limits what can be sold, and buys keep 0.1 ALGO above the minimum for fees;
 * - mined ALGO arrives in 5 NANO batches at the measured hash rate and uptime, converted at 92% of market.
 *
 * Results are money-weighted: the annual return (IRR) on everything that went in, mined batches included.
 */
import {DIP_RULE, decide, dipSignal, FUND_FEE_CAP, MIN_BUY_USDC, MIN_SWEEP_ALGO, type DipRule} from './fundTrader.ts';
import {policyReserve} from './fundPolicy.ts';
import {BUY_FEE_FLOOR} from './walletConversion.ts';

export interface Series { name: string; t: Float64Array; o: Float64Array; c: Float64Array }
export const YEAR_S = 365.25 * 86400;

/** Router network fee (µALGO, including the 3,000 on the first transaction) by trade size in ALGO, measured 2026-11-19/20;
 * larger trades were quoted 26,000-53,000. */
export const measuredNetworkFee = (algo: number): number => (algo <= 9 ? 17_000 : algo <= 40 ? 23_000 : 56_000);
/** Extra loss on larger trades, against Coinbase: 0.25-0.3% at $10 rising to 0.5-0.65% at $1,000 (2026-11-20). */
export const measuredImpact = (usd: number): number => (usd > 10 ? 0.0013 * Math.log10(usd / 10) : 0);

export interface Costs {
  /** Proportional loss per swap at small sizes: pool and router fees and the pool's gap to exchange prices. */
  swap: number;
  /** Additional proportional loss by trade size in USD. */
  impact: (usd: number) => number;
  networkFee: (algo: number) => number;
  /** Fee limit per group; larger trades are split. */
  feeCap: number;
  piecesPerHour: number;
  /** Annual yield on idle USDC (the live trader does not lend: 0). */
  lendApy: number;
}
export const MEASURED_COSTS: Costs = {swap: 0.0035, impact: measuredImpact, networkFee: measuredNetworkFee, feeCap: Number(FUND_FEE_CAP), piecesPerHour: 12, lendApy: 0};

export interface Mining { nanoPerDay: number; uptime: number; batchNano: number; keep: number; nanoUsd: (t: number) => number }
/** 1.5 NANO/day measured 2026-11-18/19; 70% uptime allows for the laptop being used or off. */
export const MEASURED_MINING: Mining = {nanoPerDay: 1.5, uptime: 0.7, batchNano: 5, keep: 0.92, nanoUsd: () => 0.31};
export const NO_MINING: Mining = {...MEASURED_MINING, nanoPerDay: 0};

export interface Wallet { algo: number; usdc: number; minimum: number }
/** The fund on 2026-11-20, in micro-units. */
export const LIVE_WALLET: Wallet = {algo: 500_000, usdc: 45_692, minimum: 200_000};

/** What a strategy sees at a completed hour `i`. Amounts are micro-units. */
export interface View {
  s: Series; ind: Indicators; i: number; price: number;
  algo: number; usdc: number; convertible: number; inTrade: boolean; entryPrice: number; entryAt: number;
}
export type Move =
  | {kind: 'buy'; usdc: number}
  | {kind: 'sell'; reason: 'exit' | 'sweep' | 'rebalance'; algo?: number}
  | {kind: 'flat'}
  | {kind: 'wait'};
export interface Strategy { name: string; decide(v: View): Move }

/** Rolling sums for fast indicators. Averages cover the `n` closes before `i`, like dipSignal. */
export class Indicators {
  readonly c: Float64Array; readonly sum: Float64Array; readonly sq: Float64Array; private rsiCache = new Map<number, Float64Array>();
  constructor(c: Float64Array) {
    this.c = c;
    this.sum = new Float64Array(c.length + 1); this.sq = new Float64Array(c.length + 1);
    for (let k = 0; k < c.length; k++) { this.sum[k + 1] = this.sum[k] + c[k]; this.sq[k + 1] = this.sq[k] + c[k] * c[k]; }
  }
  sma(i: number, n: number): number { return (this.sum[i] - this.sum[i - n]) / n; }
  sd(i: number, n: number): number { const m = this.sma(i, n); return Math.sqrt(Math.max(0, (this.sq[i] - this.sq[i - n]) / n - m * m)); }
  /** Wilder RSI of the closes up to and including `i`. */
  rsi(i: number, n: number): number {
    let r = this.rsiCache.get(n);
    if (!r) {
      r = new Float64Array(this.c.length).fill(NaN); let up = 0, down = 0;
      for (let k = 1; k < this.c.length; k++) {
        const d = this.c[k] - this.c[k - 1], u = Math.max(d, 0), w = Math.max(-d, 0);
        if (k <= n) { up += u / n; down += w / n; if (k < n) continue; } else { up = (up * (n - 1) + u) / n; down = (down * (n - 1) + w) / n; }
        r[k] = down === 0 ? 100 : 100 - 100 / (1 + up / down);
      }
      this.rsiCache.set(n, r);
    }
    return r[i];
  }
}

const WAIT: Move = {kind: 'wait'};

/** The live trader's own rule, through its own code (src/fundTrader.ts). Slow; use dip() for parameter searches. */
export function botStrategy(rule: DipRule = DIP_RULE): Strategy {
  return {name: `live bot ${rule.hours}h ${rule.drop * 100}%`, decide(v) {
    // Live, the bot always has 481 hourly closes; before that here, it only sweeps, like ruleStrategy.
    if (v.i < rule.hours) return v.convertible >= Number(MIN_SWEEP_ALGO) && !v.inTrade ? {kind: 'sell', reason: 'sweep'} : WAIT;
    const s = dipSignal(Array.from(v.s.c.subarray(v.i - rule.hours, v.i + 1)), v.inTrade, rule);
    const a = decide(s.signal, v.inTrade, BigInt(Math.floor(v.usdc)), BigInt(Math.floor(v.convertible)), s.below);
    return a.kind === 'buy' ? {kind: 'buy', usdc: Number(a.usdc)} : a.kind === 'sell' ? {kind: 'sell', reason: a.reason} : a.kind === 'flat' ? {kind: 'flat'} : WAIT;
  }};
}

/** The bot's decision shape for any entry/exit pair: buy on entry (topping up while it holds), exit when told,
 * otherwise sweep mined ALGO to USDC. */
export function ruleStrategy(name: string, warm: number, enter: (v: View) => boolean, exit: (v: View) => boolean): Strategy {
  return {name, decide(v) {
    if (v.i < warm) return v.convertible >= Number(MIN_SWEEP_ALGO) && !v.inTrade ? {kind: 'sell', reason: 'sweep'} : WAIT;
    if (v.inTrade) {
      if (exit(v)) return v.convertible > 0 ? {kind: 'sell', reason: 'exit'} : {kind: 'flat'};
      return enter(v) && v.usdc >= Number(MIN_BUY_USDC) ? {kind: 'buy', usdc: v.usdc} : WAIT;
    }
    if (enter(v) && v.usdc >= Number(MIN_BUY_USDC)) return {kind: 'buy', usdc: v.usdc};
    return v.convertible >= Number(MIN_SWEEP_ALGO) ? {kind: 'sell', reason: 'sweep'} : WAIT;
  }};
}

export interface DipParams { hours: number; drop: number; exit?: number; stop?: number; maxHold?: number }
/** The live rule, fast: buy below (1-drop)×average; sell at exit×average, below (1-stop)×entry, or after maxHold hours. */
export function dip({hours, drop, exit = 1, stop = 0, maxHold = 0}: DipParams): Strategy {
  const name = `dip ${hours}h ${Math.round(drop * 100)}%` + (exit !== 1 ? ` exit ${exit}` : '') + (stop ? ` stop ${stop * 100}%` : '') + (maxHold ? ` max ${maxHold}h` : '');
  return ruleStrategy(name, hours, (v) => v.price < v.ind.sma(v.i, hours) * (1 - drop),
    (v) => v.price >= v.ind.sma(v.i, hours) * exit || (stop > 0 && v.price < v.entryPrice * (1 - stop)) || (maxHold > 0 && v.i - v.entryAt >= maxHold));
}
export const band = (hours: number, k: number): Strategy =>
  ruleStrategy(`band ${hours}h ${k}σ`, hours, (v) => v.price < v.ind.sma(v.i, hours) - k * v.ind.sd(v.i, hours), (v) => v.price >= v.ind.sma(v.i, hours));
export const rsi = (n: number, lo: number, hi: number): Strategy =>
  ruleStrategy(`rsi ${n}h <${lo} >${hi}`, n + 1, (v) => v.ind.rsi(v.i, n) < lo, (v) => v.ind.rsi(v.i, n) > hi);
/** Hold ALGO while it is above its `hours` average. */
export const trend = (hours: number): Strategy =>
  ruleStrategy(`trend ${hours / 24}d`, hours, (v) => v.price > v.ind.sma(v.i, hours), (v) => v.price < v.ind.sma(v.i, hours));
/** Buy dips only while the 50-day average is above the 200-day average. */
export const dipInUptrend = (hours: number, drop: number): Strategy =>
  ruleStrategy(`dip ${hours}h ${drop * 100}% in uptrend`, 4800, (v) => v.ind.sma(v.i, 1200) > v.ind.sma(v.i, 4800) && v.price < v.ind.sma(v.i, hours) * (1 - drop),
    (v) => v.price >= v.ind.sma(v.i, hours));
export const holdAlgo: Strategy = ruleStrategy('hold ALGO', 0, () => true, () => false);
export const holdUsdc: Strategy = ruleStrategy('hold USDC', 0, () => false, () => true);

/** Keep `weight` of the tradable value in ALGO, trading when it drifts more than `drift`. */
export function rebalance(weight: number, drift: number): Strategy {
  return {name: `rebalance ${weight * 100}% ±${drift * 100}%`, decide(v) {
    const algoUsd = v.convertible * v.price, total = algoUsd + v.usdc;
    if (total <= 0) return WAIT;
    const w = algoUsd / total;
    if (w < weight - drift && v.usdc >= Number(MIN_BUY_USDC)) return {kind: 'buy', usdc: Math.min(v.usdc, (weight - w) * total)};
    if (w > weight + drift && (w - weight) * total / v.price >= Number(MIN_SWEEP_ALGO)) return {kind: 'sell', reason: 'rebalance', algo: (w - weight) * total / v.price};
    return WAIT;
  }};
}

export interface Result {
  strategy: string; series: string; from: number; to: number;
  value: number; contributed: number; irr: number; pieces: number; roundTrips: number; feesUsd: number; inMarket: number;
  /** Lowest value / money put in so far. */
  worst: number;
  /** Each round trip's return on the USDC put in, after costs. */
  tradeReturns: number[];
}

/** Annualized money-weighted return: contributions are negative flows at their times, the final value positive. */
export function irr(flows: [number, number][], end: number, value: number): number {
  const f = (r: number) => flows.reduce((n, [t, a]) => n - a * Math.pow(1 + r, (end - t) / YEAR_S), value);
  let lo = -0.9999, hi = 1000;
  if (f(lo) < 0) return -1; if (f(hi) > 0) return hi;
  for (let k = 0; k < 200; k++) { const m = (lo + hi) / 2; if (f(m) > 0) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

export interface SimOptions { from?: number; to?: number; costs?: Costs; mining?: Mining; wallet?: Wallet }

export function simulate(s: Series, strategy: Strategy, opts: SimOptions = {}, ind = new Indicators(s.c)): Result {
  const costs = opts.costs ?? MEASURED_COSTS, mining = opts.mining ?? MEASURED_MINING, w0 = opts.wallet ?? LIVE_WALLET;
  const from = opts.from ?? 0, to = Math.min(opts.to ?? s.c.length, s.c.length);
  const reserve = Number(policyReserve(BigInt(w0.minimum)));
  let algo = w0.algo, usdc = w0.usdc, inTrade = false, entryPrice = 0, entryAt = 0, spentUsd = 0, boughtAlgo = 0;
  let pieces = 0, feesUsd = 0, hoursIn = 0, nano = 0, contributed = w0.algo / 1e6 * s.c[from] + w0.usdc / 1e6;
  const flows: [number, number][] = [[s.t[from], contributed]], tradeReturns: number[] = [];
  let worst = 1;
  const lendHour = costs.lendApy / 8760, nanoHour = mining.nanoPerDay * mining.uptime / 24;
  const convertible = () => Math.max(0, algo - reserve - costs.feeCap);
  // A round trip's return: the exit price after costs against the average price paid for the ALGO bought.
  const closeTrip = (exitPrice?: number) => { if (exitPrice && boughtAlgo > 0) tradeReturns.push(exitPrice * (1 - costs.swap - costs.impact(boughtAlgo * exitPrice)) / (spentUsd / boughtAlgo) - 1); spentUsd = 0; boughtAlgo = 0; };
  for (let i = from; i < to - 1; i++) {
    const close = s.c[i];
    if (nanoHour > 0) {
      nano += nanoHour;
      if (nano >= mining.batchNano) {
        nano -= mining.batchNano;
        const usd = mining.batchNano * mining.nanoUsd(s.t[i]) * mining.keep;
        algo += usd / close * 1e6; contributed += usd; flows.push([s.t[i], usd]);
      }
    }
    if (lendHour > 0) usdc *= 1 + lendHour;
    const price = s.o[i + 1];
    for (let k = 0; k < costs.piecesPerHour; k++) {
      const conv = convertible();
      const m = strategy.decide({s, ind, i, price: close, algo, usdc, convertible: conv, inTrade, entryPrice, entryAt});
      if (m.kind === 'wait') break;
      if (m.kind === 'flat') { inTrade = false; closeTrip(); break; }
      if (m.kind === 'buy') {
        let amount = Math.min(m.usdc, usdc), fee = costs.networkFee(amount / 1e6 / price);
        while (fee > costs.feeCap && amount / 2 >= Number(MIN_BUY_USDC)) { amount /= 2; fee = costs.networkFee(amount / 1e6 / price); }
        if (fee > costs.feeCap || amount < Number(MIN_BUY_USDC) || algo < w0.minimum + fee + Number(BUY_FEE_FLOOR)) break;
        const cost = costs.swap + costs.impact(amount / 1e6);
        usdc -= amount; algo += amount / price * (1 - cost) - fee;
        feesUsd += amount / 1e6 * cost + fee / 1e6 * price; pieces++;
        if (!inTrade) { inTrade = true; entryPrice = price; entryAt = i; }
        spentUsd += amount / 1e6; boughtAlgo += amount / 1e6 / price * (1 - cost);
      } else {
        const min = m.reason === 'sweep' ? Number(MIN_SWEEP_ALGO) : 1;
        let amount = Math.min(m.algo ?? conv, conv), fee = costs.networkFee(amount / 1e6);
        while (fee > costs.feeCap && amount / 2 >= min) { amount /= 2; fee = costs.networkFee(amount / 1e6); }
        if (fee > costs.feeCap || amount < min || amount <= 0) break;
        const cost = costs.swap + costs.impact(amount / 1e6 * price);
        algo -= amount + fee; const got = amount / 1e6 * price * (1 - cost); usdc += got * 1e6;
        feesUsd += amount / 1e6 * price * cost + fee / 1e6 * price; pieces++;
        if (m.reason === 'exit') { inTrade = false; closeTrip(price); }
        else if (m.reason === 'rebalance') inTrade = convertible() > 0;
      }
    }
    if (inTrade) hoursIn++;
    worst = Math.min(worst, (algo / 1e6 * close + usdc / 1e6) / contributed);
  }
  const last = to - 1, value = algo / 1e6 * s.c[last] + usdc / 1e6;
  return {strategy: strategy.name, series: s.name, from: s.t[from], to: s.t[last], value, contributed, irr: irr(flows, s.t[last], value),
    pieces, roundTrips: tradeReturns.length, feesUsd, inMarket: hoursIn / Math.max(1, last - from), worst, tradeReturns};
}

/** Growth-optimal fraction of the stake per trade (Kelly), from a sample of trade returns: argmax mean(log(1+f·r)). */
export function kelly(returns: number[]): {fraction: number; growthPerTrade: number} {
  if (!returns.length) return {fraction: 0, growthPerTrade: 0};
  const g = (f: number) => returns.reduce((n, r) => n + Math.log(Math.max(1e-9, 1 + f * r)), 0) / returns.length;
  let best = 0, bestG = 0;
  for (let f = 0; f <= 5.0001; f += 0.05) { const v = g(f); if (v > bestG) { bestG = v; best = f; } }
  return {fraction: Math.round(best * 100) / 100, growthPerTrade: bestG};
}

export interface WalkForward { result: Result; chosen: {from: number; strategy: string}[] }
/** Every `step` hours, pick the candidate with the best IRR over the previous `train` hours (from a fresh wallet), then
 * trade the next `step` hours with it. One continuous out-of-sample run: the position carries across switches. */
export function walkForward(s: Series, candidates: Strategy[], train: number, step: number, opts: SimOptions = {}): WalkForward {
  const ind = new Indicators(s.c), chosen: {from: number; strategy: string}[] = [], picks: {at: number; strategy: Strategy}[] = [];
  for (let b = train; b < s.c.length - 1; b += step) {
    let best = candidates[0], bestIrr = -Infinity;
    for (const c of candidates) { const r = simulate(s, c, {...opts, from: b - train, to: b}, ind); if (r.irr > bestIrr) { bestIrr = r.irr; best = c; } }
    picks.push({at: b, strategy: best}); chosen.push({from: s.t[b], strategy: best.name});
  }
  const switching: Strategy = {name: 'walk-forward', decide(v) {
    let p = picks[0]; for (const q of picks) if (q.at <= v.i) p = q; else break;
    return p.strategy.decide(v);
  }};
  return {result: simulate(s, switching, {...opts, from: train}, ind), chosen};
}

/** A synthetic series: `warm` real hours from a random start, then `block`-hour runs of real hourly returns, optionally
 * with the drift removed. Opens equal the previous close. */
export function bootstrapSeries(s: Series, hours: number, warm: number, rand: () => number, flat = false, block = 720): Series {
  const n = s.c.length, logs = new Float64Array(n - 1);
  for (let k = 1; k < n; k++) logs[k - 1] = Math.log(s.c[k] / s.c[k - 1]);
  const mean = flat ? logs.reduce((a, b) => a + b, 0) / logs.length : 0;
  const len = warm + hours, c = new Float64Array(len), o = new Float64Array(len), t = new Float64Array(len);
  const start = Math.floor(rand() * (n - warm - 1));
  for (let k = 0; k < warm; k++) c[k] = s.c[start + k];
  for (let k = warm; k < len;) {
    const j = Math.floor(rand() * (logs.length - block));
    for (let b = 0; b < block && k < len; b++, k++) c[k] = c[k - 1] * Math.exp(logs[j + b] - mean);
  }
  for (let k = 0; k < len; k++) { o[k] = k ? c[k - 1] : c[0]; t[k] = s.t[0] + k * 3600; }
  return {name: `${s.name} bootstrap`, t, o, c};
}

/** Deterministic random numbers for repeatable simulations. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}
