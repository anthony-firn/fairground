/**
 * Read-only view of Folks Finance V2 loans that can be liquidated: a liquidator repays up to liquidationMax of a
 * loan's debt and receives collateral worth the repayment plus the liquidation bonus. Health follows the SDK
 * (Folks-Finance/algorand-js-sdk 0.3.0, lend/utils.ts userLoanInfo): a loan is liquidatable when its debt valued at
 * oracle prices × borrow factors exceeds its collateral valued at oracle prices × collateral factors.
 *
 * Values are in the SDK's units: base-unit amount × oracle price (USD per base unit × 1e14) / 1e10, so 1e4 = $1.
 */
import {base64} from '@scure/base';
import {sha512_256} from '@noble/hashes/sha2.js';
import {addressKey, applicationAddress, assignGroup, type Txn} from './algotx.ts';
import {FOLKS_ORACLE_ADAPTER, FOLKS_RESERVE, opUp, refreshPrices, type LoanParams} from './fundLoan.ts';
import {FOLKS_POOL_MANAGER} from './fundLending.ts';

export const FOLKS_LOANS = {general: 971388781n, stablecoinEfficiency: 971388977n, algoEfficiency: 971389489n, ultraswapUp: 1202382736n, ultraswapDown: 1202382829n, ecosystem: 3184333108n};
export const FOLKS_ORACLE_0 = 1040271396n;
export const USD = 10_000n;
const ONE_4 = 10_000n, ONE_10 = 10n ** 10n, ONE_14 = 10n ** 14n, ONE_16 = 10n ** 16n, YEAR = 31_536_000n;

export type KV = {key: string; value: {bytes?: string; uint?: number}};
const bytes = (state: KV[], key: Uint8Array): Uint8Array | undefined => {
  const e = state.find((kv) => { const k = base64.decode(kv.key); return k.length === key.length && k.every((x, i) => x === key[i]); });
  return e?.value.bytes ? base64.decode(e.value.bytes) : undefined;
};
const num = (b: Uint8Array, a: number, c: number): bigint => b.slice(a, c).reduce((n, x) => (n << 8n) | BigInt(x), 0n);
const u64s = (b: Uint8Array | undefined): bigint[] => (b ? Array.from({length: Math.floor(b.length / 8)}, (_, i) => num(b, 8 * i, 8 * i + 8)) : []);
const mulScale = (a: bigint, b: bigint, s: bigint) => (a * b) / s;
const mulScaleUp = (a: bigint, b: bigint, s: bigint) => mulScale(a, b, s) + 1n;
const pow = (base: bigint, e: bigint, s: bigint) => { let acc = s; while (e > 0n) { if (e & 1n) acc = (acc * base) / s; base = (base * base) / s; e >>= 1n; } return acc; };
const compounded = (rate: bigint, old: bigint, since: bigint, now: bigint) => mulScale(old, pow(ONE_16 + rate / YEAR, now > since ? now - since : 0n, ONE_16), ONE_16);

export interface PoolTerms { pool: bigint; asset: bigint; collateralFactor: bigint; borrowFactor: bigint; liquidationMax: bigint; liquidationBonus: bigint; liquidationFee: bigint }
/** A loan app's per-pool terms (global state slots 0-62, three 42-byte entries each). */
export function parseLoanTerms(state: KV[]): Map<bigint, PoolTerms> {
  const out = new Map<bigint, PoolTerms>();
  for (let i = 0; i < 63; i++) {
    const v = bytes(state, new Uint8Array([i])); if (!v) continue;
    for (let j = 0; j < 3; j++) {
      const at = j * 42; if (v.length < at + 42) break;
      const pool = num(v, at, at + 8); if (pool === 0n) continue;
      out.set(pool, {pool, asset: num(v, at + 8, at + 16), collateralFactor: num(v, at + 32, at + 34), borrowFactor: num(v, at + 34, at + 36),
        liquidationMax: num(v, at + 36, at + 38), liquidationBonus: num(v, at + 38, at + 40), liquidationFee: num(v, at + 40, at + 42)});
    }
  }
  return out;
}

export interface PoolIndexes { depositIndex: bigint; borrowIndex: bigint }
/** Every pool's deposit and variable-borrow interest index at `now` (seconds) from the pool manager. */
export function parsePoolIndexes(state: KV[], now: bigint): Map<bigint, PoolIndexes> {
  const out = new Map<bigint, PoolIndexes>();
  for (let i = 0; i < 63; i++) {
    const v = bytes(state, new Uint8Array([i])); if (!v) continue;
    for (let j = 0; j < 3; j++) {
      const at = j * 42; if (v.length < at + 42) break;
      const pool = num(v, at, at + 6); if (pool === 0n) continue;
      const vbir = num(v, at + 6, at + 14), vbii = num(v, at + 14, at + 22), dir = num(v, at + 22, at + 30), dii = num(v, at + 30, at + 38), lu = num(v, at + 38, at + 42);
      out.set(pool, {borrowIndex: compounded(vbir, vbii, lu, now), depositIndex: mulScale(dii, ONE_16 + (dir * (now > lu ? now - lu : 0n)) / YEAR, ONE_16)});
    }
  }
  return out;
}

/** Oracle prices (USD per base unit × 1e14) and their update times, keyed by asset id. */
export function parseOracle(state: KV[]): Map<bigint, {price: bigint; updated: bigint}> {
  const out = new Map<bigint, {price: bigint; updated: bigint}>();
  for (const kv of state) {
    const k = base64.decode(kv.key); if (k.length !== 8 || !kv.value.bytes) continue;
    const v = base64.decode(kv.value.bytes); if (v.length < 16) continue;
    out.set(num(k, 0, 8), {price: num(v, 0, 8), updated: num(v, 8, 16)});
  }
  return out;
}

export interface LoanLocal { collaterals: {pool: bigint; f: bigint}[]; borrows: {pool: bigint; borrowed: bigint; balance: bigint; index: bigint; stableRate: bigint; stableSince: bigint}[] }
export function parseLoanLocal(state: KV[]): LoanLocal {
  const k = (s: string) => new TextEncoder().encode(s);
  const c = u64s(bytes(state, k('c'))), cb = u64s(bytes(state, k('cb'))), b = u64s(bytes(state, k('b'))), ba = u64s(bytes(state, k('ba'))), bb = u64s(bytes(state, k('bb')));
  const l = u64s(bytes(state, k('l'))), r = u64s(bytes(state, k('r'))), t = u64s(bytes(state, k('t')));
  return {collaterals: c.map((pool, i) => ({pool, f: cb[i] ?? 0n})).filter((x) => x.pool > 0n && x.f > 0n),
    borrows: b.map((pool, i) => ({pool, borrowed: ba[i] ?? 0n, balance: bb[i] ?? 0n, index: l[i] ?? 0n, stableRate: r[i] ?? 0n, stableSince: t[i] ?? 0n})).filter((x) => x.pool > 0n && x.balance > 0n)};
}

export interface Position { pool: bigint; asset: bigint; amount: bigint; value: bigint; effective: bigint }
export interface LoanHealth { collateral: Position[]; borrows: Position[]; effectiveCollateral: bigint; effectiveBorrow: bigint; health: number; liquidatable: boolean; unpriced: boolean }
/** The SDK's userLoanInfo: collateral and debt at oracle prices and the loan's factors. */
export function assessLoan(local: LoanLocal, terms: Map<bigint, PoolTerms>, pools: Map<bigint, PoolIndexes>, prices: Map<bigint, {price: bigint}>, now: bigint): LoanHealth {
  let unpriced = false;
  const collateral = local.collaterals.flatMap(({pool, f}) => {
    const t = terms.get(pool), ix = pools.get(pool), p = t && prices.get(t.asset);
    if (!t || !ix || !p) { unpriced = true; return []; }
    const amount = mulScale(f, ix.depositIndex, ONE_14), value = mulScale(amount, p.price, ONE_10);
    return [{pool, asset: t.asset, amount, value, effective: mulScale(value, t.collateralFactor, ONE_4)}];
  });
  const borrows = local.borrows.flatMap((b) => {
    const t = terms.get(b.pool), ix = pools.get(b.pool), p = t && prices.get(t.asset);
    if (!t || !ix || !p || b.index === 0n) { unpriced = true; return []; }
    const bii = b.stableSince > 0n ? compounded(b.stableRate, b.index, b.stableSince, now) : ix.borrowIndex;
    const amount = mulScaleUp(b.balance, (bii * ONE_14) / b.index + 1n, ONE_14), value = mulScaleUp(amount, p.price, ONE_10);
    return [{pool: b.pool, asset: t.asset, amount, value, effective: mulScaleUp(value, t.borrowFactor, ONE_4)}];
  });
  const effectiveCollateral = collateral.reduce((n, x) => n + x.effective, 0n), effectiveBorrow = borrows.reduce((n, x) => n + x.effective, 0n);
  const health = effectiveBorrow === 0n ? Infinity : Number(effectiveCollateral) / Number(effectiveBorrow);
  return {collateral, borrows, effectiveCollateral, effectiveBorrow, health, liquidatable: !unpriced && effectiveBorrow > effectiveCollateral, unpriced};
}

export interface Liquidation { borrowPool: bigint; borrowAsset: bigint; collateralPool: bigint; collateralAsset: bigint; repay: bigint; repayValue: bigint; seizedValue: bigint; bonusValue: bigint }
/** The largest single liquidation: repay up to liquidationMax of one debt, capped by what one collateral can cover. */
export function bestLiquidation(h: LoanHealth, terms: Map<bigint, PoolTerms>): Liquidation | undefined {
  let best: Liquidation | undefined;
  for (const b of h.borrows) for (const c of h.collateral) {
    const tb = terms.get(b.pool)!, tc = terms.get(c.pool)!;
    let repayValue = mulScale(b.value, tb.liquidationMax, ONE_4);
    const coverable = mulScale(c.value, ONE_4, ONE_4 + tc.liquidationBonus);
    if (repayValue > coverable) repayValue = coverable;
    const repay = b.value === 0n ? 0n : mulScale(b.amount, repayValue, b.value);
    const seizedValue = mulScale(repayValue, ONE_4 + tc.liquidationBonus, ONE_4);
    // The protocol keeps liquidationFee of the bonus (simulation 2026-11-20: 7.2% to the liquidator at 8% and 10%).
    const bonusValue = mulScale(seizedValue - repayValue, ONE_4 - tc.liquidationFee, ONE_4);
    if (!best || bonusValue > best.bonusValue) best = {borrowPool: b.pool, borrowAsset: b.asset, collateralPool: c.pool, collateralAsset: c.asset, repay, repayValue, seizedValue, bonusValue};
  }
  return best;
}

const LIQUIDATE = sha512_256(new TextEncoder().encode('liquidate(appl,txn,account,account,asset,asset,uint64,bool,application,application,application,application)void')).slice(0, 4);
const u8 = (n: number) => new Uint8Array([n]);
const u64 = (n: bigint) => { const b = new Uint8Array(8); for (let i = 0; i < 8; i++) b[7 - i] = Number((n >> BigInt(8 * i)) & 0xffn); return b; };
export interface LiquidateArgs { liquidator: string; escrow: string; loanApp: bigint; borrowPool: bigint; borrowAsset: number; collateralPool: bigint; collateralFAsset: number;
  repay: bigint; minCollateral: bigint; loanAssets: number[]; budget: number }
/** The SDK's prepareLiquidateLoan, prefixed with OpUp budget: refresh the loan's prices, send the repayment to the
 * borrow pool, and call liquidate, which pays the liquidator collateral fAssets worth the repayment plus the bonus. */
export function liquidateGroup(a: LiquidateArgs, p: LoanParams): Txn[] {
  const head = (fee: bigint): Txn => ({snd: addressKey(a.liquidator), fee, fv: p.firstValid, lv: p.firstValid + 20n, gen: p.genesisID, gh: p.genesisHash});
  const pool = addressKey(applicationAddress(a.borrowPool));
  const send: Txn = a.borrowAsset === 0 ? {...head(1000n), type: 'pay', rcv: pool, amt: a.repay} : {...head(1000n), type: 'axfer', arcv: pool, xaid: BigInt(a.borrowAsset), aamt: a.repay};
  const liquidate: Txn = {...head(9000n), type: 'appl', apid: a.loanApp,
    apaa: [LIQUIDATE, u8(1), u8(2), u8(0), u8(1), u64(a.minCollateral), u8(0), u8(1), u8(2), u8(3), u8(4)],
    apat: [addressKey(a.escrow), addressKey(FOLKS_RESERVE)], apas: [BigInt(a.borrowAsset), BigInt(a.collateralFAsset)],
    apfa: [a.collateralPool, a.borrowPool, FOLKS_POOL_MANAGER, FOLKS_ORACLE_ADAPTER]};
  const txns = [opUp(a.liquidator, a.budget, p), refreshPrices(a.liquidator, a.loanAssets, p), send, liquidate];
  assignGroup(txns);
  return txns;
}

const selector = (s: string) => sha512_256(new TextEncoder().encode(s)).slice(0, 4);
const FLASH_BEGIN = selector('flash_loan_begin(uint64,uint64,account,asset)void');
const FLASH_END = selector('flash_loan_end(txn,account,asset)void');
const POOL_WITHDRAW = selector('withdraw(axfer,uint64,account,asset,asset,application)uint64');
export const FOLKS_ALGO_POOL_APP = 971368268n, FOLKS_USDC_POOL_APP = 971372237n, FALGO = 971381860, USDC = 31566704;
/** The USDC pool's flash-loan fee, 0.1% (pool interest parameter 1e13 / 1e16, mainnet 2026-11-20). */
export const flashRepayment = (amount: bigint): bigint => amount + (amount * 10n ** 13n) / 10n ** 16n + 1n;

export interface FlashLiquidationArgs {
  liquidator: string; escrow: string; loanApp: bigint; loanAssets: number[];
  /** µUSDC flash-borrowed and repaid on the loan; µfALGO withdrawn as ALGO (also the liquidation's minimum). */
  repay: bigint; fWithdraw: bigint; budget: number;
  /** The liquidate call's minimum fALGO to the liquidator (at most fWithdraw). */
  minCollateral: bigint;
}
/** One atomic group that needs no capital: flash-borrow USDC, liquidate an ALGO-collateral loan, withdraw the fALGO as
 * ALGO, swap it to USDC through the router (`router`: its prepared transactions for that ALGO, minimum output covering
 * the repayment), and repay the flash loan. If any step comes up short the whole group fails and costs nothing. */
export function flashLiquidationGroup(a: FlashLiquidationArgs, router: Txn[], p: LoanParams): Txn[] {
  const fv = router[0]?.fv as bigint ?? p.firstValid, lv = fv + 20n;
  const head = (fee: bigint): Txn => ({snd: addressKey(a.liquidator), fee, fv, lv, gen: p.genesisID, gh: p.genesisHash});
  const usdcPool = addressKey(applicationAddress(FOLKS_USDC_POOL_APP)), algoPool = addressKey(applicationAddress(FOLKS_ALGO_POOL_APP));
  const q = {...p, firstValid: fv};
  const middle: Txn[] = [
    opUp(a.liquidator, a.budget, q),
    refreshPrices(a.liquidator, a.loanAssets, q),
    {...head(1000n), type: 'axfer', arcv: usdcPool, xaid: BigInt(USDC), aamt: a.repay},
    {...head(9000n), type: 'appl', apid: a.loanApp, apaa: [LIQUIDATE, u8(1), u8(2), u8(0), u8(1), u64(a.minCollateral), u8(0), u8(1), u8(2), u8(3), u8(4)],
      apat: [addressKey(a.escrow), addressKey(FOLKS_RESERVE)], apas: [BigInt(USDC), BigInt(FALGO)], apfa: [FOLKS_ALGO_POOL_APP, FOLKS_USDC_POOL_APP, FOLKS_POOL_MANAGER, FOLKS_ORACLE_ADAPTER]},
    {...head(1000n), type: 'axfer', arcv: algoPool, xaid: BigInt(FALGO), aamt: a.fWithdraw},
    {...head(4000n), type: 'appl', apid: FOLKS_ALGO_POOL_APP, apaa: [POOL_WITHDRAW, u64(0n), u8(0), u8(0), u8(1), u8(1)], apas: [0n, BigInt(FALGO)], apfa: [FOLKS_POOL_MANAGER]},
    ...router.map((t) => ({...t, fv, lv, grp: undefined, lx: undefined})),
    {...head(1000n), type: 'axfer', arcv: usdcPool, xaid: BigInt(USDC), aamt: flashRepayment(a.repay)},
  ];
  const endIndex = BigInt(middle.length + 1);
  const begin: Txn = {...head(2000n), type: 'appl', apid: FOLKS_USDC_POOL_APP, apaa: [FLASH_BEGIN, u64(a.repay), u64(endIndex), u8(0), u8(0)], apas: [BigInt(USDC)]};
  const end: Txn = {...head(2000n), type: 'appl', apid: FOLKS_USDC_POOL_APP, apaa: [FLASH_END, u8(1), u8(0)], apat: [addressKey(FOLKS_RESERVE)], apas: [BigInt(USDC)]};
  const txns = [begin, ...middle, end];
  assignGroup(txns);
  return txns;
}

const ROUTER_APP_ID = 3279848327n;
const same = (x: unknown, y: Uint8Array) => x instanceof Uint8Array && x.length === y.length && x.every((v, i) => v === y[i]);
const hex = (b: unknown) => (b instanceof Uint8Array ? [...b].map((x) => x.toString(16).padStart(2, '0')).join('') : '');
/** Why a flash liquidation group shouldn't be signed. `minOut` is the least USDC the router step may deliver. */
export function flashLiquidationProblem(txns: Txn[], a: FlashLiquidationArgs, algoIn: bigint, minOut: bigint): string | undefined {
  const me = addressKey(a.liquidator), genesis = base64.decode('wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=');
  const allowedApps = new Set([FOLKS_USDC_POOL_APP, FOLKS_ALGO_POOL_APP, a.loanApp, FOLKS_ORACLE_ADAPTER, ROUTER_APP_ID, 1167143153n]);
  const usdcPool = addressKey(applicationAddress(FOLKS_USDC_POOL_APP)), algoPool = addressKey(applicationAddress(FOLKS_ALGO_POOL_APP)), router = addressKey(applicationAddress(ROUTER_APP_ID));
  if (txns.length < 10 || txns.length > 16) return 'unexpected number of transactions';
  let fees = 0n;
  for (const t of txns) {
    if (!same(t.snd, me)) return 'a transaction isn’t from this wallet';
    if (t.rekey !== undefined || t.close !== undefined || t.aclose !== undefined || t.asnd !== undefined) return 'a transaction would hand over or empty the wallet';
    if (t.gen !== 'mainnet-v1.0' || !same(t.gh, genesis)) return 'not on Algorand mainnet';
    if (!same(t.grp, txns[0].grp as Uint8Array)) return 'the transactions aren’t one group';
    if (t.type === 'appl' && (!allowedApps.has(t.apid as bigint) || t.apan !== undefined || t.apap !== undefined || t.apsu !== undefined)) return 'a call to an unexpected app';
    if (t.type === 'pay' && !(same(t.rcv, router) && t.amt === algoIn)) return 'an ALGO payment goes somewhere unexpected';
    if (t.type === 'axfer') {
      const ok = (same(t.arcv, usdcPool) && t.xaid === BigInt(USDC) && (t.aamt === a.repay || t.aamt === flashRepayment(a.repay)))
        || (same(t.arcv, algoPool) && t.xaid === BigInt(FALGO) && t.aamt === a.fWithdraw);
      if (!ok) return 'an asset transfer goes somewhere unexpected';
    }
    if (!['appl', 'pay', 'axfer'].includes(String(t.type))) return 'unexpected transaction type';
    fees += typeof t.fee === 'bigint' ? t.fee : 0n;
  }
  if (fees > 100_000n) return 'network fees are too high';
  const copy = txns.map((x) => ({...x}));
  assignGroup(copy);
  if (!same(copy[0].grp, txns[0].grp as Uint8Array)) return 'the transactions aren’t one group';
  const [begin, end] = [txns[0], txns[txns.length - 1]];
  if (begin.apid !== FOLKS_USDC_POOL_APP || hex((begin.apaa as Uint8Array[])[0]) !== hex(FLASH_BEGIN) || hex((begin.apaa as Uint8Array[])[1]) !== hex(u64(a.repay))
    || hex((begin.apaa as Uint8Array[])[2]) !== hex(u64(BigInt(txns.length - 1)))) return 'the flash loan doesn’t borrow the repayment or point at its end';
  if (end.apid !== FOLKS_USDC_POOL_APP || hex((end.apaa as Uint8Array[])[0]) !== hex(FLASH_END)) return 'the group doesn’t end by repaying the flash loan';
  const routerCalls = txns.filter((t) => t.apid === ROUTER_APP_ID);
  const last = routerCalls[routerCalls.length - 1];
  const args = (last?.apaa ?? []) as Uint8Array[];
  if (!last || hex(args[0]) !== '7dde205e' || num(args[1], 0, 8) !== BigInt(USDC) || num(args[2], 0, 8) < minOut) return 'the swap doesn’t guarantee enough USDC back';
  if (minOut < flashRepayment(a.repay)) return 'the swap’s minimum would not repay the flash loan';
  return undefined;
}

/** The liquidator's part of `gross` seized collateral: the protocol keeps liquidationFee of the bonus part
 * (0.74% of the total at an 8% bonus and 10% fee; measured in simulation 2026-11-20). */
export const liquidatorShare = (gross: bigint, bonus: bigint, fee: bigint): bigint =>
  (gross * (10_000n * (10_000n + bonus) - fee * bonus)) / (10_000n * (10_000n + bonus));
