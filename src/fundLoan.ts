/**
 * Borrowing USDC against the fund's ALGO in a Folks Finance V2 general loan, so a dip trade can hold 1.25× what the
 * fund's own USDC buys. The loan lives in an escrow account the loan app controls (it is rekeyed to the app when the
 * loan is created); the fund's ALGO is deposited to the ALGO pool with the escrow as receiver, which makes the escrow
 * hold fALGO as collateral, and borrowed USDC comes to the fund's wallet.
 *
 * Groups are built here from the Folks ABI (Folks-Finance/algorand-js-sdk 0.3.0; tests compare every argument with
 * algosdk's ABI composer) and each is checked before signing. IDs below were read from that SDK's mainnet constants
 * and the loan's terms from mainnet (2026-11-20): ALGO collateral factor 0.65, liquidation at debt > 0.65 × collateral,
 * 8% liquidation bonus, USDC variable borrow 5.93%.
 */
import {sha512_256} from '@noble/hashes/sha2.js';
import {ed25519} from '@noble/curves/ed25519.js';
import {base64} from '@scure/base';
import {addressKey, applicationAddress, assignGroup, decodeTxn, encodeAddressKey, encodeTxn, type Txn} from './algotx.ts';
import {MAINNET_GENESIS_HASH, USDC_ASSET_ID} from './rails/algorand.ts';
import {FOLKS_POOL_MANAGER, FOLKS_USDC_POOL} from './fundLending.ts';

export const FOLKS_GENERAL_LOAN = 971388781n;
export const FOLKS_ALGO_POOL = 971368268n;
export const FALGO_ASSET_ID = 971381860;
export const FRUSDC_ASSET_ID = 971384593;
export const FOLKS_ORACLE_ADAPTER = 971333964n;
const ORACLE_0 = 1040271396n, ORACLE_1 = 971323141n;
export const FOLKS_RESERVE = 'Q5Q5FC5PTYQIUX5PGNTEW22UJHJHVVUEMMWV2LSG6MGT33YQ54ST7FEIGA';
/** Folks' OpUp apps: one call to the caller app makes `n` inner calls to the base app, adding ~689 opcode budget each.
 * Loan calls need far more than a group's own 700 per call (measured in simulation: borrow 4,826). */
export const FOLKS_OPUP_CALLER = 1167143153n;
const OPUP_BASE = 971335616n;
/** The escrow's minimum balance: the loan's local state (728,500) plus its fALGO holding, measured in simulation. */
export const ESCROW_FUNDING = 828_500n;
/** The loan's ALGO collateral factor and the health below which the trader repays part of the debt itself. */
export const ALGO_COLLATERAL_FACTOR = 0.65;
/** Pool positions in the pool manager (poolManagerIndex). */
const ALGO_PM_INDEX = 0, USDC_PM_INDEX = 2;
/** A Folks loan type: its app, where the ALGO and USDC pools sit in its pool list (each loan type has its own order),
 * and the factor its ALGO collateral counts at. All types share the loan contract's methods. */
export interface LoanKind { name: string; app: bigint; algoLoanIndex: number; usdcLoanIndex: number; collateralFactor: number }
export const GENERAL_LOAN: LoanKind = {name: 'general', app: FOLKS_GENERAL_LOAN, algoLoanIndex: 0, usdcLoanIndex: 2, collateralFactor: ALGO_COLLATERAL_FACTOR};
/** Folks' leveraged-long loan (mainnet 2026-11-21): ALGO collateral at 0.825, USDC borrow only, and a liquidation takes
 * the whole debt with no bonus. Its pool list starts USDC (0), ALGO (1); its escrow needs the same local state. */
export const ULTRASWAP_UP_LOAN: LoanKind = {name: 'ultraswap up', app: 1202382736n, algoLoanIndex: 1, usdcLoanIndex: 0, collateralFactor: 0.825};
export const LOAN_KINDS = [GENERAL_LOAN, ULTRASWAP_UP_LOAN];
/** The loan type that owns an escrow's loan: the recorded app, else the general loan (escrows made before 2026-11-21). */
export const loanKindFor = (app: string | bigint | undefined): LoanKind => LOAN_KINDS.find((k) => app !== undefined && k.app === BigInt(app)) ?? GENERAL_LOAN;

const enc = new TextEncoder();
const selector = (signature: string) => sha512_256(enc.encode(signature)).slice(0, 4);
export const SIG = {
  createLoan: 'create_loan(pay)void',
  addCollateral: 'add_collateral(account,asset,application,uint8,uint8,application)void',
  syncCollateral: 'sync_collateral(appl,account,asset,application,application,application)void',
  reduceCollateral: 'reduce_collateral(appl,account,account,asset,asset,uint64,bool,application,application,application)void',
  borrow: 'borrow(appl,account,account,asset,uint64,uint64,uint8,uint8,application,application,application)void',
  repay: 'repay_with_txn(txn,account,account,account,asset,asset,bool,application,application)void',
  refreshPrices: 'refresh_prices(uint64[],uint64[],application,application,application)void',
  deposit: 'deposit(txn,account,asset,asset,application)uint64',
  updateIndexes: 'update_pool_interest_indexes(application)void',
} as const;
const u8 = (n: number) => new Uint8Array([n]);
const u64 = (n: bigint) => { const b = new Uint8Array(8); for (let i = 0; i < 8; i++) b[7 - i] = Number((n >> BigInt(8 * i)) & 0xffn); return b; };
const bool = (b: boolean) => new Uint8Array([b ? 0x80 : 0]);
const u64s = (ns: bigint[]) => { const out = new Uint8Array(2 + 8 * ns.length); out[0] = ns.length >> 8; out[1] = ns.length & 0xff; ns.forEach((n, i) => out.set(u64(n), 2 + 8 * i)); return out; };

export interface LoanParams { firstValid: bigint; genesisID: string; genesisHash: Uint8Array }
const head = (sender: string, fee: bigint, p: LoanParams): Txn => ({snd: addressKey(sender), fee, fv: p.firstValid, lv: p.firstValid + 20n, gen: p.genesisID, gh: p.genesisHash});
const call = (sender: string, fee: bigint, p: LoanParams, app: bigint, args: Uint8Array[], refs: {accounts?: string[]; assets?: number[]; apps?: bigint[]} = {}): Txn =>
  ({...head(sender, fee, p), type: 'appl', apid: app, apaa: args, apat: refs.accounts?.map(addressKey), apas: refs.assets?.map(BigInt), apfa: refs.apps});
/** Budget for the rest of the group: `n` inner calls, each paid by this transaction's fee. */
export const opUp = (user: string, n: number, p: LoanParams): Txn => call(user, BigInt(1000 + 1000 * n), p, FOLKS_OPUP_CALLER, [u64(BigInt(n))], {apps: [OPUP_BASE]});

/** The oracle refresh that loan calls read prices from: no LP assets, the loan's base assets. */
export function refreshPrices(user: string, assets: number[], p: LoanParams): Txn {
  return call(user, 1000n, p, FOLKS_ORACLE_ADAPTER, [selector(SIG.refreshPrices), u64s([]), u64s(assets.map(BigInt)), u8(1), u8(2), u8(3)], {apps: [ORACLE_0, ORACLE_1, 0n]});
}

export interface Escrow { address: string; seed: Uint8Array }
export function newEscrow(): Escrow {
  const seed = ed25519.utils.randomSecretKey();
  return {address: encodeAddressKey(ed25519.getPublicKey(seed)), seed};
}

/** Creates the loan: a zero payment noting the escrow, then the escrow opts in to the loan app and is rekeyed to it.
 * `fund` µALGO are first paid to the escrow for its minimum balance. */
export function createLoanGroup(user: string, escrow: string, fund: bigint, p: LoanParams, kind: LoanKind = GENERAL_LOAN): Txn[] {
  const loanAddr = addressKey(applicationAddress(kind.app));
  const pay: Txn = {...head(user, 1000n, p), type: 'pay', rcv: addressKey(escrow), amt: fund};
  const note: Txn = {...head(user, 2000n, p), type: 'pay', rcv: loanAddr, note: new Uint8Array([...enc.encode('la '), ...addressKey(escrow)])};
  const optIn: Txn = {...head(escrow, 0n, p), type: 'appl', apid: kind.app, apan: 1n, apaa: [selector(SIG.createLoan)], rekey: loanAddr};
  const txns = fund > 0n ? [pay, note, optIn] : [note, optIn];
  assignGroup(txns);
  return txns;
}

/** Lets the escrow hold fALGO as collateral (the loan app opts it in). */
export function addCollateralGroup(user: string, escrow: string, p: LoanParams, kind: LoanKind = GENERAL_LOAN): Txn[] {
  return [call(user, 2000n, p, kind.app, [selector(SIG.addCollateral), u8(1), u8(0), u8(1), u8(ALGO_PM_INDEX), u8(kind.algoLoanIndex), u8(2)],
    {accounts: [escrow], assets: [FALGO_ASSET_ID], apps: [FOLKS_ALGO_POOL, FOLKS_POOL_MANAGER]})];
}

/** Deposits `amount` µALGO to the ALGO pool for the escrow (fALGO collateral), then records it in the loan. */
export function depositCollateralGroup(user: string, escrow: string, amount: bigint, p: LoanParams, kind: LoanKind = GENERAL_LOAN): Txn[] {
  const send: Txn = {...head(user, 1000n, p), type: 'pay', rcv: addressKey(applicationAddress(FOLKS_ALGO_POOL)), amt: amount};
  const deposit = call(user, 3000n, p, FOLKS_ALGO_POOL, [selector(SIG.deposit), u8(1), u8(0), u8(1), u8(1)],
    {accounts: [escrow], assets: [0, FALGO_ASSET_ID], apps: [FOLKS_POOL_MANAGER]});
  const update = call(user, 2000n, p, FOLKS_ALGO_POOL, [selector(SIG.updateIndexes), u8(1)], {apps: [FOLKS_POOL_MANAGER]});
  const refresh = refreshPrices(user, [0], p);
  const sync = call(user, 1000n, p, kind.app, [selector(SIG.syncCollateral), u8(1), u8(0), u8(1), u8(2), u8(3)],
    {accounts: [escrow], assets: [FALGO_ASSET_ID], apps: [FOLKS_ALGO_POOL, FOLKS_POOL_MANAGER, FOLKS_ORACLE_ADAPTER]});
  const txns = [opUp(user, 2, p), send, deposit, update, refresh, sync];
  assignGroup(txns);
  return txns;
}

const LOAN_ASSETS = [0, USDC_ASSET_ID];
/** Borrows `amount` µUSDC at the variable rate, paid to the fund's wallet. */
export function borrowGroup(user: string, escrow: string, amount: bigint, p: LoanParams, kind: LoanKind = GENERAL_LOAN): Txn[] {
  const refresh = refreshPrices(user, LOAN_ASSETS, p);
  const borrow = call(user, 8000n, p, kind.app, [selector(SIG.borrow), u8(1), u8(0), u8(0), u64(amount), u64(0n), u8(USDC_PM_INDEX), u8(kind.usdcLoanIndex), u8(1), u8(2), u8(3)],
    {accounts: [escrow], assets: [USDC_ASSET_ID], apps: [FOLKS_USDC_POOL, FOLKS_POOL_MANAGER, FOLKS_ORACLE_ADAPTER]});
  const txns = [opUp(user, 6, p), refresh, borrow];
  assignGroup(txns);
  return txns;
}

/** Repays `amount` µUSDC of the variable borrow from the fund's wallet. */
export function repayGroup(user: string, escrow: string, amount: bigint, p: LoanParams, kind: LoanKind = GENERAL_LOAN): Txn[] {
  const send: Txn = {...head(user, 1000n, p), type: 'axfer', arcv: addressKey(applicationAddress(FOLKS_USDC_POOL)), xaid: BigInt(USDC_ASSET_ID), aamt: amount};
  const repay = call(user, 9000n, p, kind.app, [selector(SIG.repay), u8(1), u8(0), u8(2), u8(0), u8(1), bool(false), u8(1), u8(2)],
    {accounts: [escrow, FOLKS_RESERVE], assets: [USDC_ASSET_ID, FRUSDC_ASSET_ID], apps: [FOLKS_USDC_POOL, FOLKS_POOL_MANAGER]});
  const txns = [opUp(user, 3, p), send, repay];
  assignGroup(txns);
  return txns;
}

/** Takes `fAmount` µfALGO of collateral out of the loan as ALGO to the fund's wallet. */
export function reduceCollateralGroup(user: string, escrow: string, fAmount: bigint, p: LoanParams, kind: LoanKind = GENERAL_LOAN): Txn[] {
  const refresh = refreshPrices(user, LOAN_ASSETS, p);
  const reduce = call(user, 6000n, p, kind.app, [selector(SIG.reduceCollateral), u8(1), u8(0), u8(0), u8(1), u64(fAmount), bool(true), u8(1), u8(2), u8(3)],
    {accounts: [escrow], assets: [0, FALGO_ASSET_ID], apps: [FOLKS_ALGO_POOL, FOLKS_POOL_MANAGER, FOLKS_ORACLE_ADAPTER]});
  const txns = [opUp(user, 3, p), refresh, reduce];
  assignGroup(txns);
  return txns;
}

const OTHER_APPS = [FOLKS_ALGO_POOL, FOLKS_USDC_POOL, FOLKS_ORACLE_ADAPTER, FOLKS_OPUP_CALLER];
const POOL_ADDRESSES = () => new Set([applicationAddress(FOLKS_ALGO_POOL), applicationAddress(FOLKS_USDC_POOL)]);
const same = (a: unknown, b: Uint8Array) => a instanceof Uint8Array && a.length === b.length && a.every((v, i) => v === b[i]);

/** Why a loan group shouldn't be signed. Every transaction must come from the fund (or, only when creating the loan,
 * the new escrow handing itself to the loan app); payments may go only to the escrow (its minimum balance), the loan
 * app (the zero note) or a Folks pool; app calls only to the loan, pools and oracle adapter; nothing may close an
 * account, and only the escrow may be rekeyed, only to the loan app; fees are bounded. */
export function loanProblem(raw: Uint8Array[], user: string, escrow: string, maxPay: bigint, kind: LoanKind = GENERAL_LOAN): string | undefined {
  const allowedApps = new Set([kind.app, ...OTHER_APPS]);
  let txns: Txn[];
  try { txns = raw.map(decodeTxn); } catch { return 'unreadable transactions'; }
  if (txns.length < 1 || txns.length > 6) return 'unexpected number of transactions';
  const me = addressKey(user), esc = addressKey(escrow), genesis = base64.decode(MAINNET_GENESIS_HASH);
  const loanAddr = addressKey(applicationAddress(kind.app)), pools = [...POOL_ADDRESSES()].map(addressKey);
  let fees = 0n;
  for (const t of txns) {
    if (t.gen !== 'mainnet-v1.0' || !same(t.gh, genesis)) return 'not on Algorand mainnet';
    if (typeof t.fv !== 'bigint' || typeof t.lv !== 'bigint' || t.lv - t.fv > 20n || t.fv !== txns[0].fv) return 'validity window changed';
    if (t.close !== undefined || t.aclose !== undefined || t.asnd !== undefined) return 'a transaction would empty an account';
    const fromMe = same(t.snd, me), fromEscrow = same(t.snd, esc);
    if (!fromMe && !fromEscrow) return 'a transaction is from someone else';
    if (fromEscrow && !(t.type === 'appl' && t.apid === kind.app && t.apan === 1n && same(t.rekey, loanAddr) && t.fee === undefined)) return 'the escrow may only hand itself to the loan app';
    if (fromMe && t.rekey !== undefined) return 'the wallet would be rekeyed';
    if (t.type === 'pay') {
      const toEscrow = same(t.rcv, esc), toLoan = same(t.rcv, loanAddr), toPool = pools.some((p) => same(t.rcv, p));
      if (!(toEscrow && typeof t.amt === 'bigint' && t.amt <= maxPay) && !(toLoan && t.amt === undefined) && !(toPool && typeof t.amt === 'bigint' && t.amt <= maxPay)) return 'a payment goes somewhere unexpected';
    } else if (t.type === 'axfer') {
      if (!pools.some((p) => same(t.arcv, p)) || t.xaid !== BigInt(USDC_ASSET_ID) || typeof t.aamt !== 'bigint' || t.aamt > maxPay) return 'an asset transfer goes somewhere unexpected';
    } else if (t.type === 'appl') {
      if (!allowedApps.has(t.apid as bigint)) return 'a call to an unexpected app';
      if (t.apap !== undefined || t.apsu !== undefined || (t.apan !== undefined && !fromEscrow)) return 'a call would change or leave an app';
    } else return 'unexpected transaction type';
    fees += typeof t.fee === 'bigint' ? t.fee : 0n;
  }
  if (fees > 25_000n) return 'network fees are too high';
  if (txns.length > 1) {
    const grp = txns[0].grp, copy = txns.map((t) => ({...t}));
    assignGroup(copy);
    if (!(grp instanceof Uint8Array) || !txns.every((t) => same(t.grp, grp)) || !same(copy[0].grp, grp)) return 'the transactions aren’t one group';
  }
}
export const encodeGroup = (txns: Txn[]): Uint8Array[] => txns.map(encodeTxn);

export interface LoanState { collateralF: bigint; borrowBalance: bigint; borrowIndex: bigint }
/** The escrow's collateral (µfALGO) and variable USDC borrow from its loan local state (keys as in the SDK's
 * loanLocalState: c/cb collateral pools and balances, b/bb/l borrow pools, balances and interest index at borrow). */
export function parseLoanState(state: {key: string; value: {bytes?: string}}[]): LoanState {
  const get = (k: string) => { const e = state.find((kv) => new TextDecoder().decode(base64.decode(kv.key)) === k); return e?.value.bytes ? base64.decode(e.value.bytes) : new Uint8Array(); };
  const u64sAt = (b: Uint8Array) => Array.from({length: Math.floor(b.length / 8)}, (_, i) => b.slice(8 * i, 8 * i + 8).reduce((n, x) => (n << 8n) | BigInt(x), 0n));
  const colPools = u64sAt(get('c')), colBals = u64sAt(get('cb')), borPools = u64sAt(get('b')), borBals = u64sAt(get('bb')), idx = u64sAt(get('l'));
  const ci = colPools.indexOf(FOLKS_ALGO_POOL), bi = borPools.indexOf(FOLKS_USDC_POOL);
  return {collateralF: ci >= 0 ? colBals[ci] ?? 0n : 0n, borrowBalance: bi >= 0 ? borBals[bi] ?? 0n : 0n, borrowIndex: bi >= 0 ? idx[bi] ?? 0n : 0n};
}

/** µUSDC owed now: the recorded balance grown by the pool's borrow index since the last update. */
export const currentDebt = (s: LoanState, borrowIndexNow: bigint): bigint =>
  s.borrowBalance === 0n || s.borrowIndex === 0n ? 0n : (s.borrowBalance * borrowIndexNow + s.borrowIndex - 1n) / s.borrowIndex;

/** The pool manager's variable borrow index for a pool slot at `now` (seconds), compounding per second like the SDK. */
export function borrowIndexAt(state: {key: string; value: {bytes?: string}}[], poolManagerIndex: number, pool: bigint, now: number): bigint {
  const slot = Math.floor(poolManagerIndex / 3), at = (poolManagerIndex % 3) * 42;
  const entry = state.find((kv) => { const k = base64.decode(kv.key); return k.length === 1 && k[0] === slot; });
  if (!entry?.value.bytes) throw Error('Pool manager state is missing the pool');
  const v = base64.decode(entry.value.bytes), num = (a: number, b: number) => v.slice(a, b).reduce((n, x) => (n << 8n) | BigInt(x), 0n);
  if (num(at, at + 6) !== pool) throw Error('Pool manager slot does not hold the expected pool');
  const rate = num(at + 6, at + 14), old = num(at + 14, at + 22), updated = num(at + 38, at + 42);
  let dt = BigInt(Math.max(0, Math.floor(now))) - updated; if (dt < 0n) dt = 0n;
  const one = 10n ** 16n; let base = one + rate / 31_536_000n, acc = one;
  while (dt > 0n) { if (dt & 1n) acc = (acc * base) / one; base = (base * base) / one; dt >>= 1n; }
  return (old * acc) / one;
}

/** Collateral value × factor over debt: below 1 the loan can be liquidated. Infinity without debt. */
export const loanHealth = (collateralAlgo: number, price: number, debtUsd: number, collateralFactor = ALGO_COLLATERAL_FACTOR): number =>
  (debtUsd <= 0 ? Infinity : collateralAlgo * price * collateralFactor / debtUsd);


/** The pool manager's deposit index (1e14 = 1 ALGO per fALGO for the ALGO pool) at `now`, simple interest like the SDK. */
export function depositIndexAt(state: {key: string; value: {bytes?: string}}[], poolManagerIndex: number, pool: bigint, now: number): bigint {
  const slot = Math.floor(poolManagerIndex / 3), at = (poolManagerIndex % 3) * 42;
  const entry = state.find((kv) => { const k = base64.decode(kv.key); return k.length === 1 && k[0] === slot; });
  if (!entry?.value.bytes) throw Error('Pool manager state is missing the pool');
  const v = base64.decode(entry.value.bytes), num = (a: number, b: number) => v.slice(a, b).reduce((n, x) => (n << 8n) | BigInt(x), 0n);
  if (num(at, at + 6) !== pool) throw Error('Pool manager slot does not hold the expected pool');
  const rate = num(at + 22, at + 30), old = num(at + 30, at + 38), updated = num(at + 38, at + 42);
  const dt = BigInt(Math.max(0, Math.floor(now))) - updated;
  return (old * (10n ** 16n + (rate * (dt > 0n ? dt : 0n)) / 31_536_000n)) / 10n ** 16n;
}
