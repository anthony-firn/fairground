/** Explicit, reviewed ALGO-to-USDC conversion, including deposits below the automatic conversion threshold, and the
 * reverse USDC-to-ALGO buy used by the development fund's trader. */
import {assignGroup, decodeTxn, encodeTxn} from './algotx.ts';
import {sha256} from '@noble/hashes/sha2.js';
import {MAINNET_GENESIS_HASH, USDC_ASSET_ID} from './rails/algorand.ts';
import {base64} from '@scure/base';
import {MAX_SWAP_FEES, minReceive, prepareSwap, quoteSwap, swapProblem, type SwapQuote} from './swap.ts';
import {type WalletState} from './walletkey.ts';
import {policyReserve,policyLimit,policyBudget} from './fundPolicy.ts';

export const CONVERSION_QUOTE_MS = 30_000;
/** The most any caller may allow a group's network fees to be (the app uses MAX_SWAP_FEES; the fund trader more). */
export const MAX_FEE_CAP = 200_000n;
/** ALGO a buy must leave above the account minimum after its network fees, so the position can always be sold back. */
export const BUY_FEE_FLOOR = 100_000n;
export const walletReserve = (state: Pick<WalletState,'minimum'>): bigint => policyReserve(state.minimum);

export function walletSignerProblem(state: WalletState): string | undefined {
  if (state.authAddress && state.authAddress !== state.address) return 'This account uses an external signing authority. Use its controlling wallet to spend; receiving still works.';
}

export function convertibleOnRequest(state: WalletState, feeCap = MAX_SWAP_FEES): bigint {
  return policyLimit(state.algo,state.minimum,feeCap,state.active,!walletSignerProblem(state));
}

export interface WalletConversion {
  address: string;
  quote: SwapQuote;
  raw: Uint8Array[];
  fees: bigint;
  reserve: bigint;
  expiresAt: number;
  /** The network fee limit this plan was checked against (default MAX_SWAP_FEES). */
  feeCap?: bigint;
}

const same = (a: unknown,b: Uint8Array) => a instanceof Uint8Array && a.length === b.length && a.every((v,i)=>v===b[i]);
const lease = (address: string) => sha256(new TextEncoder().encode('fairground:stable-conversion:v1:'+address));

/** Checks for either direction: signer, quote freshness, the router's group, mainnet, the shared lease and fees. */
function groupProblem(plan: WalletConversion, state: WalletState, now: number): string | undefined {
  const signer = walletSignerProblem(state); if (signer) return signer;
  const cap = plan.feeCap ?? MAX_SWAP_FEES; if (cap <= 0n || cap > MAX_FEE_CAP) return 'The network fee limit is out of range.';
  if (plan.address !== state.address || !state.active) return 'The wallet or its USDC holding changed. Get a new quote.';
  if (!Number.isFinite(plan.expiresAt) || now >= plan.expiresAt || plan.expiresAt > now + CONVERSION_QUOTE_MS) return 'This quote expired. Get a new quote.';
  if (plan.quote.amount <= 0n || minReceive(plan.quote) <= 0n) return 'The swap must deliver a positive amount.';
  const problem = swapProblem(plan.raw,state.address,plan.quote,cap); if (problem) return problem;
  const txns=plan.raw.map(decodeTxn);
  const genesis=base64.decode(MAINNET_GENESIS_HASH);
  if (txns.some(t=>t.gen !== 'mainnet-v1.0' || !same(t.gh,genesis))) return 'The conversion is not on Algorand mainnet.';
  if(!same(txns[0].lx,lease(state.address))||typeof txns[0].fv!=='bigint'||typeof txns[0].lv!=='bigint'||txns[0].lv<=txns[0].fv||txns[0].lv-txns[0].fv>20n||txns.some(t=>t.fv!==txns[0].fv||t.lv!==txns[0].lv)) return 'The conversion duplicate-protection lease or validity window changed.';
  const expectedGroup=txns[0].grp;
  assignGroup(txns);
  if (!(expectedGroup instanceof Uint8Array) || !same(txns[0].grp,expectedGroup)) return 'The conversion group does not match its transactions.';
  const fees=txns.reduce((n,t)=>n+(typeof t.fee==='bigint'?t.fee:0n),0n);
  if (fees!==plan.fees || fees>cap || plan.reserve!==walletReserve(state)) return 'The conversion fees or reserve changed. Get a new quote.';
}

export function conversionProblem(plan: WalletConversion, state: WalletState, now = Date.now()): string | undefined {
  if (plan.quote.from !== 0 || plan.quote.to !== USDC_ASSET_ID) return 'The conversion must deliver native USDC.';
  const problem = groupProblem(plan,state,now); if (problem) return problem;
  if (!policyBudget(state.algo,state.minimum,plan.quote.amount,plan.fees,plan.feeCap ?? MAX_SWAP_FEES)) return 'The balance changed; this conversion would spend the ALGO reserve.';
}

/** A USDC-to-ALGO buy: it may spend only USDC the wallet holds, and its network fees must leave ALGO to sell back. */
export function buyProblem(plan: WalletConversion, state: WalletState, now = Date.now()): string | undefined {
  if (plan.quote.from !== USDC_ASSET_ID || plan.quote.to !== 0) return 'The buy must spend native USDC for ALGO.';
  const problem = groupProblem(plan,state,now); if (problem) return problem;
  if (plan.quote.amount > state.usdc) return 'The USDC balance changed. Get a new quote.';
  if (state.algo < state.minimum + plan.fees + BUY_FEE_FLOOR) return 'Network fees would use the ALGO needed to sell back.';
}

export const tradeProblem = (plan: WalletConversion, state: WalletState, now = Date.now()): string | undefined =>
  plan.quote.from === 0 ? conversionProblem(plan,state,now) : buyProblem(plan,state,now);

async function preparePlan(state: WalletState, from: number, to: number, amount: bigint, fetchImpl: typeof fetch, api: string | undefined, now: number, feeCap: bigint): Promise<WalletConversion> {
  const quote=await quoteSwap(from,to,amount,fetchImpl,api);
  const prepared=await prepareSwap(state.address,quote,fetchImpl,api);
  // A shared sender lease prevents overlapping conversions from this app on
  // different tabs/devices. Keep it short rather than locking funds for 1000 rounds.
  const txns=prepared.map(decodeTxn);
  const firstValid=txns[0].fv;
  if (typeof firstValid!=='bigint' || txns.some(t=>typeof t.lv!=='bigint' || (t.lv as bigint)<firstValid)) throw Error('Invalid conversion validity window');
  const lastValid=txns.reduce((n,t)=>(t.lv as bigint)<n?(t.lv as bigint):n,firstValid+20n);
  if(lastValid<=firstValid)throw Error('Conversion validity window is too short');
  for(const txn of txns){txn.fv=firstValid;txn.lv=lastValid;}
  txns[0].lx=lease(state.address);
  assignGroup(txns);
  const raw=txns.map(encodeTxn);
  const fees=raw.map(decodeTxn).reduce((n,t)=>n+(typeof t.fee==='bigint'?t.fee:0n),0n);
  const plan:WalletConversion={address:state.address,quote,raw,fees,reserve:walletReserve(state),expiresAt:now+CONVERSION_QUOTE_MS,...(feeCap!==MAX_SWAP_FEES?{feeCap}:{})};
  const problem=tradeProblem(plan,state,now);if(problem)throw Error(problem);
  return plan;
}

/** Converts `amount` micro-ALGO (by default all that the reserve policy allows) to USDC, with network fees up to `feeCap`. */
export async function prepareWalletConversion(state: WalletState, fetchImpl: typeof fetch = (...args)=>fetch(...args), api?: string, now = Date.now(), amount?: bigint, feeCap = MAX_SWAP_FEES): Promise<WalletConversion> {
  const signer=walletSignerProblem(state);if(signer)throw Error(signer);
  const limit=convertibleOnRequest(state,feeCap),value=amount??limit;
  if (value<=0n) throw Error('No ALGO is available above the account minimum and fee reserve.');
  if (value>limit) throw Error('That is more ALGO than the reserve policy allows converting.');
  return preparePlan(state,0,USDC_ASSET_ID,value,fetchImpl,api,now,feeCap);
}

/** Spends `amount` micro-USDC on ALGO. */
export async function prepareWalletBuy(state: WalletState, amount: bigint, fetchImpl: typeof fetch = (...args)=>fetch(...args), api?: string, now = Date.now(), feeCap = MAX_SWAP_FEES): Promise<WalletConversion> {
  const signer=walletSignerProblem(state);if(signer)throw Error(signer);
  if (amount<=0n || amount>state.usdc) throw Error('The wallet does not hold that much USDC.');
  return preparePlan(state,USDC_ASSET_ID,0,amount,fetchImpl,api,now,feeCap);
}
