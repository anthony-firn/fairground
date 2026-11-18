import assert from 'node:assert/strict';
import {test} from 'node:test';
import {policyReserve,policyLimit,policyBudget} from '../src/fundPolicy.ts';
import {walletState} from '../src/walletkey.ts';

test('Rust/Wasm budget agrees with unbounded arithmetic at boundaries and 64-bit edge cases',()=>{
 const max=(1n<<64n)-1n;
 const values=[0n,1n,200_000n,499_999n,500_000n,520_000n,1_101_016n,(1n<<53n)+1n,max-300_000n,max-1n,max];
 for(const b of values)for(const m of values)for(const a of values)for(const f of [0n,1n,20_000n,20_001n,max]){
  const reserve=m+300_000n>max?max:m+300_000n>500_000n?m+300_000n:500_000n;
  assert.equal(policyReserve(m),reserve);
  assert.equal(policyBudget(b,m,a,f,20_000n),a>0n&&f<=20_000n&&a+f+reserve<=b);
  const expected=b-reserve-20_000n;
  assert.equal(policyLimit(b,m,20_000n,true,true),expected>0n?expected:0n);
 }
 assert.equal(policyLimit(max,0n,0n,false,true),0n);
 assert.equal(policyLimit(max,0n,0n,true,false),0n);
 for(const n of [-1n,max+1n])assert.throws(()=>policyReserve(n),/64-bit/);
});

test('untrusted JSON balances reject unsafe integers and negative amounts before signing',async()=>{
 for(const amount of [Number.MAX_SAFE_INTEGER+1,-1,1.5,'1000']){
  const f=(async()=>Response.json({amount,'min-balance':100_000,assets:[]})) as typeof fetch;
  await assert.rejects(walletState('address','https://example.test',f),/invalid or imprecise/);
 }
});
