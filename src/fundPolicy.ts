/** Real signing checks run in dependency-free Rust/Wasm. See proofs/fund-policy for proof scope. */
import {fundPolicyWasm} from './generated/fundPolicyWasm.ts';
const instance = new WebAssembly.Instance(new WebAssembly.Module(fundPolicyWasm));
if (WebAssembly.Module.imports(new WebAssembly.Module(fundPolicyWasm)).length) throw Error('Unexpected fund-policy host imports.');
const wasm = instance.exports as {
  wallet_reserve(minimum:bigint):bigint;
  conversion_limit(balance:bigint,minimum:bigint,cap:bigint,active:number,authorized:number):bigint;
  budget_allowed(balance:bigint,minimum:bigint,amount:bigint,fees:bigint,cap:bigint):number;
};
const max = (1n<<64n)-1n;
function u64(n:bigint):bigint { if(typeof n!=='bigint'||n<0n||n>max)throw Error('Wallet amount is outside the unsigned 64-bit range.');return n; }
// WebAssembly's JS ABI returns i64 as signed BigInt; the Rust exports are u64.
export const policyReserve=(minimum:bigint):bigint=>BigInt.asUintN(64,wasm.wallet_reserve(u64(minimum)));
export const policyLimit=(balance:bigint,minimum:bigint,cap:bigint,active:boolean,authorized:boolean):bigint=>
  BigInt.asUintN(64,wasm.conversion_limit(u64(balance),u64(minimum),u64(cap),Number(active),Number(authorized)));
export const policyBudget=(balance:bigint,minimum:bigint,amount:bigint,fees:bigint,cap:bigint):boolean=>
  wasm.budget_allowed(u64(balance),u64(minimum),u64(amount),u64(fees),u64(cap))===1;
