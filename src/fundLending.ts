/**
 * Lending the development fund's idle USDC in the Folks Finance V2 USDC pool, which pays interest by raising the USDC
 * value of its fUSDC receipt token. Depositing sends USDC to the pool and calls its `deposit` method, which mints
 * fUSDC to this wallet; withdrawing sends fUSDC back with `withdraw` and returns USDC with the interest earned.
 * No escrow account is involved: the wallet holds the fUSDC itself.
 *
 * The groups are built here from the pool's published ABI (Folks-Finance/algorand-js-sdk 0.3.0) and checked before
 * signing: all from this wallet, nothing rekeyed or closed, only the pool's own methods with the expected assets.
 * IDs were confirmed on mainnet on 2026-11-20: fUSDC (971384592) was created by the pool app (971372237) and has no
 * clawback or freeze address, and the pool names pool manager 971350278.
 */
import {sha512_256} from '@noble/hashes/sha2.js';
import {base64} from '@scure/base';
import {addressKey, applicationAddress, assignGroup, decodeTxn, encodeTxn, type Txn} from './algotx.ts';
import {MAINNET_GENESIS_HASH, USDC_ASSET_ID} from './rails/algorand.ts';
import {BUY_FEE_FLOOR} from './walletConversion.ts';
import type {WalletState} from './walletkey.ts';

export const FOLKS_USDC_POOL = 971372237n;
export const FOLKS_POOL_MANAGER = 971350278n;
export const FUSDC_ASSET_ID = 971384592;
/** The pool's position in the pool manager's state (`poolManagerIndex` in the SDK). */
const POOL_MANAGER_INDEX = 2;
/** Deposits below this stay in the wallet: each deposit or withdrawal costs ~0.005 ALGO. */
export const LEND_MIN_USDC = 1_000_000n;
/** Per-transaction fees: the pool's calls pay for their inner transactions (2 for deposit, 3 for withdraw, 1 for the
 * index update). The update call is there for its opcode budget: one pool call gets 700, and a deposit needs more. */
const FEES = {optin: [1000n], deposit: [1000n, 3000n, 2000n], withdraw: [1000n, 4000n, 2000n]} as const;
const ASSET_BALANCE_MINIMUM = 100_000n;

export type LendingKind = keyof typeof FEES;
const selector = (signature: string) => sha512_256(new TextEncoder().encode(signature)).slice(0, 4);
export const DEPOSIT = selector('deposit(txn,account,asset,asset,application)uint64');
export const WITHDRAW = selector('withdraw(axfer,uint64,account,asset,asset,application)uint64');
export const UPDATE = selector('update_pool_interest_indexes(application)void');
const u8 = (n: number) => new Uint8Array([n]);
const u64 = (n: bigint) => { const b = new Uint8Array(8); for (let i = 0; i < 8; i++) b[7 - i] = Number((n >> BigInt(8 * i)) & 0xffn); return b; };
const lease = (address: string) => sha512_256(new TextEncoder().encode('fairground:fund-lending:v1:' + address));
const same = (a: unknown, b: Uint8Array) => a instanceof Uint8Array && a.length === b.length && a.every((v, i) => v === b[i]);
const hex = (b: unknown) => (b instanceof Uint8Array ? [...b].map((x) => x.toString(16).padStart(2, '0')).join('') : '');

export interface LendingParams { firstValid: bigint; genesisID: string; genesisHash: Uint8Array }
export interface LendingPlan { kind: LendingKind; address: string; amount: bigint; raw: Uint8Array[]; fees: bigint; lastValid: bigint }

/** The unsigned group: opt in to fUSDC, deposit `amount` µUSDC, or withdraw `amount` µfUSDC for all the USDC it is worth. */
export function lendingGroup(kind: LendingKind, address: string, amount: bigint, p: LendingParams): Txn[] {
  const me = addressKey(address), pool = addressKey(applicationAddress(FOLKS_USDC_POOL));
  const head = (fee: bigint): Txn => ({snd: me, fee, fv: p.firstValid, lv: p.firstValid + 20n, gen: p.genesisID, gh: p.genesisHash});
  // Asset references count from 0; application reference 1 is the first foreign app (0 is the pool itself);
  // account reference 0 is the sender, which also receives.
  const call = (fee: bigint, args: Uint8Array[]): Txn => ({...head(fee), type: 'appl', apid: FOLKS_USDC_POOL, apaa: args,
    apas: [BigInt(USDC_ASSET_ID), BigInt(FUSDC_ASSET_ID)], apfa: [FOLKS_POOL_MANAGER]});
  const update = (fee: bigint): Txn => ({...head(fee), type: 'appl', apid: FOLKS_USDC_POOL, apaa: [UPDATE, u8(1)], apfa: [FOLKS_POOL_MANAGER]});
  let txns: Txn[];
  if (kind === 'optin') txns = [{...head(FEES.optin[0]), type: 'axfer', arcv: me, xaid: BigInt(FUSDC_ASSET_ID)}];
  else if (kind === 'deposit') txns = [{...head(FEES.deposit[0]), type: 'axfer', arcv: pool, xaid: BigInt(USDC_ASSET_ID), aamt: amount},
    call(FEES.deposit[1], [DEPOSIT, u8(0), u8(0), u8(1), u8(1)]), update(FEES.deposit[2])];
  else txns = [{...head(FEES.withdraw[0]), type: 'axfer', arcv: pool, xaid: BigInt(FUSDC_ASSET_ID), aamt: amount},
    call(FEES.withdraw[1], [WITHDRAW, u64(0n), u8(0), u8(0), u8(1), u8(1)]), update(FEES.withdraw[2])];
  txns[0].lx = lease(address);
  if (txns.length > 1) assignGroup(txns);
  return txns;
}

/** Why a lending group shouldn't be signed, or undefined if it does exactly `kind` for `amount`. */
export function lendingProblem(raw: Uint8Array[], address: string, kind: LendingKind, amount: bigint): string | undefined {
  let txns: Txn[];
  try { txns = raw.map(decodeTxn); } catch { return 'unreadable transactions'; }
  const expected = FEES[kind];
  if (txns.length !== expected.length) return 'unexpected number of transactions';
  const me = addressKey(address), pool = addressKey(applicationAddress(FOLKS_USDC_POOL)), genesis = base64.decode(MAINNET_GENESIS_HASH);
  for (const [i, t] of txns.entries()) {
    if (!same(t.snd, me)) return 'a transaction isn’t from this wallet';
    if (t.rekey !== undefined || t.close !== undefined || t.aclose !== undefined || t.asnd !== undefined) return 'a transaction would hand over or empty the wallet';
    if (t.gen !== 'mainnet-v1.0' || !same(t.gh, genesis)) return 'not on Algorand mainnet';
    if (t.fee !== expected[i]) return 'unexpected network fee';
    if (typeof t.fv !== 'bigint' || typeof t.lv !== 'bigint' || t.lv - t.fv > 20n || t.fv !== txns[0].fv || t.lv !== txns[0].lv) return 'validity window changed';
  }
  if (!same(txns[0].lx, lease(address))) return 'duplicate-protection lease missing';
  if (txns.length > 1) {
    const grp = txns[0].grp, copy = txns.map((t) => ({...t}));
    assignGroup(copy);
    if (!(grp instanceof Uint8Array) || !txns.every((t) => same(t.grp, grp)) || !same(copy[0].grp, grp)) return 'the transactions aren’t one group';
  } else if (txns[0].grp !== undefined) return 'unexpected group';
  const [first, second, third] = txns;
  if (kind === 'optin') return first.type === 'axfer' && same(first.arcv, me) && first.xaid === BigInt(FUSDC_ASSET_ID) && first.aamt === undefined
    ? undefined : 'not a zero-amount fUSDC opt-in to this wallet';
  const asset = kind === 'deposit' ? USDC_ASSET_ID : FUSDC_ASSET_ID;
  if (amount <= 0n || first.type !== 'axfer' || !same(first.arcv, pool) || first.xaid !== BigInt(asset) || first.aamt !== amount) return 'the first transaction doesn’t send the amount to the pool';
  const args = second.apaa as unknown[] | undefined, assets = second.apas as unknown[] | undefined, apps = second.apfa as unknown[] | undefined;
  if (second.type !== 'appl' || second.apid !== FOLKS_USDC_POOL || second.apan !== undefined || second.apat !== undefined || second.apap !== undefined || second.apsu !== undefined) return 'not a plain call to the Folks USDC pool';
  if (!Array.isArray(assets) || assets.length !== 2 || assets[0] !== BigInt(USDC_ASSET_ID) || assets[1] !== BigInt(FUSDC_ASSET_ID)) return 'unexpected asset references';
  if (!Array.isArray(apps) || apps.length !== 1 || apps[0] !== FOLKS_POOL_MANAGER) return 'unexpected application reference';
  const want = kind === 'deposit' ? [hex(DEPOSIT), '00', '00', '01', '01'] : [hex(WITHDRAW), hex(u64(0n)), '00', '00', '01', '01'];
  if (!Array.isArray(args) || args.length !== want.length || args.some((a, i) => hex(a) !== want[i])) return 'unexpected pool method or arguments';
  const up = third.apaa as unknown[] | undefined, upApps = third.apfa as unknown[] | undefined;
  if (third.type !== 'appl' || third.apid !== FOLKS_USDC_POOL || third.apan !== undefined || third.apat !== undefined || third.apas !== undefined || third.apap !== undefined || third.apsu !== undefined
    || !Array.isArray(up) || up.length !== 2 || hex(up[0]) !== hex(UPDATE) || hex(up[1]) !== '01' || !Array.isArray(upApps) || upApps.length !== 1 || upApps[0] !== FOLKS_POOL_MANAGER) return 'the budget call isn’t the pool’s index update';
  return undefined;
}

/** The wallet's fUSDC holding, from the algod account endpoint (null when not opted in). */
export async function fusdcHolding(address: string, algod: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<bigint | null> {
  const r = await fetchImpl(`${algod}/v2/accounts/${address}`);
  if (!r.ok) throw Error(`reading the wallet: the Algorand node said ${r.status}`);
  const assets = ((await r.json()) as {assets?: {'asset-id': number; amount: number}[]}).assets ?? [];
  const h = assets.find((a) => a['asset-id'] === FUSDC_ASSET_ID);
  return h ? BigInt(h.amount) : null;
}

/** The pool's deposit rate (1e16 = 100%/year) and current interest index (1e14 = 1 USDC per fUSDC), from the pool
 * manager's global state at `now` (seconds), as the SDK's retrievePoolManagerInfo computes them. */
export function parsePoolManager(state: {key: string; value: {bytes?: string}}[], now: number): {rate: bigint; index: bigint} {
  const slot = Math.floor(POOL_MANAGER_INDEX / 3), at = (POOL_MANAGER_INDEX % 3) * 42;
  const entry = state.find((kv) => same(base64.decode(kv.key), new Uint8Array([slot])));
  if (!entry?.value.bytes) throw Error('Pool manager state is missing the USDC pool');
  const v = base64.decode(entry.value.bytes), num = (a: number, b: number) => v.slice(a, b).reduce((n, x) => (n << 8n) | BigInt(x), 0n);
  if (v.length < at + 42 || num(at, at + 6) !== FOLKS_USDC_POOL) throw Error('Pool manager slot does not hold the USDC pool');
  const rate = num(at + 22, at + 30), old = num(at + 30, at + 38), updated = num(at + 38, at + 42);
  const dt = BigInt(Math.max(0, Math.floor(now))) - updated;
  return {rate, index: (old * (10n ** 16n + (rate * (dt > 0n ? dt : 0n)) / 31_536_000n)) / 10n ** 16n};
}

export async function poolRate(algod: string, fetchImpl: typeof fetch = (...a) => fetch(...a), now = Date.now() / 1000): Promise<{rate: bigint; index: bigint}> {
  const r = await fetchImpl(`${algod}/v2/applications/${FOLKS_POOL_MANAGER}`);
  if (!r.ok) throw Error(`reading the pool manager: the Algorand node said ${r.status}`);
  return parsePoolManager(((await r.json()) as {params: {'global-state': {key: string; value: {bytes?: string}}[]}}).params['global-state'], now);
}

/** µUSDC that `f` µfUSDC withdraws for at `index`. */
export const fusdcValue = (f: bigint, index: bigint): bigint => (f * index) / 10n ** 14n;

/** The wallet's minimum balance after this group, and whether its fees still leave ALGO to sell positions back. */
export function lendingFeeProblem(kind: LendingKind, state: Pick<WalletState, 'algo' | 'minimum'>): string | undefined {
  const fees = FEES[kind].reduce((a, b) => a + b, 0n), minimum = state.minimum + (kind === 'optin' ? ASSET_BALANCE_MINIMUM : 0n);
  if (state.algo < minimum + fees + BUY_FEE_FLOOR) return 'Network fees would use the ALGO needed to sell back.';
}

export function prepareLending(kind: LendingKind, state: WalletState, amount: bigint, p: LendingParams): LendingPlan {
  if (p.genesisID !== 'mainnet-v1.0' || base64.encode(p.genesisHash) !== MAINNET_GENESIS_HASH) throw Error('Not Algorand mainnet');
  if (kind === 'deposit' && (amount <= 0n || amount > state.usdc)) throw Error('The wallet does not hold that much USDC.');
  if (kind !== 'optin' && amount <= 0n) throw Error('Nothing to withdraw.');
  const fee = lendingFeeProblem(kind, state); if (fee) throw Error(fee);
  const txns = lendingGroup(kind, state.address, kind === 'optin' ? 0n : amount, p), raw = txns.map(encodeTxn);
  const problem = lendingProblem(raw, state.address, kind, kind === 'optin' ? 0n : amount); if (problem) throw Error(problem);
  return {kind, address: state.address, amount, raw, fees: FEES[kind].reduce((a, b) => a + b, 0n), lastValid: txns[0].lv as bigint};
}

/** Runs unsigned groups against current mainnet state (algod simulate), in order: algod's JSON result.
 * The request is MessagePack, so each unsigned transaction goes in as the exact bytes that would be signed. */
export async function simulate(groups: Uint8Array[][], algod: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<{ok: boolean; message?: string; 'txn-groups'?: {'failure-message'?: string; 'failed-at'?: number[]; 'app-budget-consumed'?: number; 'app-budget-added'?: number; 'txn-results'?: {'app-budget-consumed'?: number; 'txn-result'?: {txn?: {txn?: {fee?: number}}}}[]}[]}> {
  const str = (s: string) => { const b = new TextEncoder().encode(s); if (b.length > 31) throw Error('key too long'); return [0xa0 | b.length, ...b]; };
  const arr = (n: number) => (n < 16 ? [0x90 | n] : n < 65536 ? [0xdc, n >> 8, n & 0xff] : (() => { throw Error('too many entries'); })());
  const parts: number[][] = [[0x82], str('allow-empty-signatures'), [0xc3], str('txn-groups'), arr(groups.length)];
  for (const g of groups) {
    parts.push([0x81], str('txns'), arr(g.length));
    for (const raw of g) parts.push([0x81], str('txn'), [...raw]);
  }
  const r = await fetchImpl(`${algod}/v2/transactions/simulate?format=json`, {method: 'POST', headers: {'Content-Type': 'application/msgpack'}, body: Uint8Array.from(parts.flat())});
  return {ok: r.ok, ...((await r.json().catch(() => ({}))) as object)};
}

/** The first failure simulating `groups`, if any. */
export async function simulateGroups(groups: Uint8Array[][], algod: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<string | undefined> {
  const out = await simulate(groups, algod, fetchImpl);
  if (!out.ok) return `simulate refused: ${out.message ?? 'error'}`;
  const failed = out['txn-groups']?.find((g) => g['failure-message']);
  return failed ? `${failed['failure-message']} (at ${JSON.stringify(failed['failed-at'])})` : undefined;
}

/** For simulation only: plans run back to back as one group (simulate takes one group per request). Later
 * transactions drop the lease and get a distinguishing note so repeated calls are not duplicates. */
export function oneGroupForSimulation(plans: {raw: Uint8Array[]}[]): Uint8Array[] {
  const txns = plans.flatMap((x) => x.raw.map(decodeTxn)).map((t, i) => { delete t.grp; if (i) { delete t.lx; t.note = new Uint8Array([i]); } return t; });
  assignGroup(txns);
  return txns.map(encodeTxn);
}
