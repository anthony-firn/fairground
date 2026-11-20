import assert from 'node:assert/strict';
import {test} from 'node:test';
import {generateSecretKey} from 'nostr-tools/pure';
import {walletKeys,walletState,submit,confirmed} from '../src/wallet.ts';
import {signSwap,minReceive,ROUTER_APP} from '../src/swap.ts';
import {applicationAddress} from '../src/algotx.ts';
import {USDC_ASSET_ID} from '../src/rails/algorand.ts';
import {buyProblem,conversionProblem,prepareWalletBuy,prepareWalletConversion,tradeProblem,BUY_FEE_FLOOR} from '../src/walletConversion.ts';
import {executeWalletConversion,resumeWalletConversion,type ConversionJournal,type ConversionStore} from '../src/conversionSession.ts';
import {DIP_RULE,decide,dipSignal,fittingPlan,quotePriceProblem,MIN_BUY_USDC,MIN_SWEEP_ALGO} from '../src/fundTrader.ts';
import {ALGOD,createFakeChain,createFakeRouter} from './fakechain.ts';

const flat=(n:number,v:number)=>Array.from({length:n},()=>v);

test('the dip rule buys 20% below the 20-day average and sells back at the average',()=>{
 const base=flat(DIP_RULE.hours,0.10);
 assert.equal(dipSignal([...base,0.0799],false).signal,'buy');
 assert.equal(dipSignal([...base,0.0801],false).signal,'wait');
 assert.equal(dipSignal([...base,0.0999],true).signal,'wait');
 assert.equal(dipSignal([...base,0.1001],true).signal,'sell');
 const s=dipSignal([0.5,...base,0.09],false);assert.ok(Math.abs(s.average-0.10)<1e-12,'only the last 480 hours count');assert.equal(s.price,0.09);
 assert.throws(()=>dipSignal(base,false),/480|481/);
 assert.throws(()=>dipSignal([...base.slice(1),NaN,0.1],false),/Invalid/);
});

test('decisions: buy dips with USDC, hold until recovery, otherwise sweep mined ALGO to USDC',()=>{
 assert.deepEqual(decide('buy',false,MIN_BUY_USDC,0n),{kind:'buy',usdc:MIN_BUY_USDC});
 assert.equal(decide('buy',false,MIN_BUY_USDC-1n,0n).kind,'wait');
 assert.deepEqual(decide('buy',false,0n,MIN_SWEEP_ALGO),{kind:'sell',reason:'sweep'});
 assert.deepEqual(decide('wait',false,5_000_000n,MIN_SWEEP_ALGO),{kind:'sell',reason:'sweep'});
 assert.equal(decide('wait',false,5_000_000n,MIN_SWEEP_ALGO-1n).kind,'wait');
 assert.equal(decide('wait',true,0n,50_000_000n).kind,'wait','mined ALGO joins an open position');
 assert.deepEqual(decide('sell',true,0n,1n),{kind:'sell',reason:'exit'});
 assert.deepEqual(decide('sell',true,0n,0n),{kind:'flat'});
});

test('router quotes far from the exchange price are refused',()=>{
 const sell={quote:{from:0,to:USDC_ASSET_ID,amount:10_000_000n,quote:1_000_000n,priceImpact:0,fees:0n,payload:''}};
 const buy={quote:{from:USDC_ASSET_ID,to:0,amount:1_000_000n,quote:10_000_000n,priceImpact:0,fees:0n,payload:''}};
 assert.equal(quotePriceProblem(sell,0.1),undefined);assert.equal(quotePriceProblem(buy,0.102),undefined);
 assert.match(quotePriceProblem(sell,0.11)??'',/more than 3%/);assert.match(quotePriceProblem(buy,0.09)??'',/more than 3%/);
 assert.match(quotePriceProblem(buy,NaN)??'',/No exchange price/);
});

async function buyFixture(algo=500000n,usdc=1_000_000n){
 const chain=createFakeChain(),router=createFakeRouter(),keys=walletKeys(generateSecretKey());
 chain.fund(keys.address,algo,usdc);
 chain.fund(applicationAddress(ROUTER_APP),1_000_000n,0n); // the router holds USDC, as on mainnet
 const state=await walletState(keys.address,ALGOD,chain.fetch);
 return {chain,router,keys,state};
}

test('a buy spends only held USDC, keeps ALGO to sell back, and lands ALGO in the wallet',async()=>{
 const {chain,router,keys,state}=await buyFixture();
 const plan=await prepareWalletBuy(state,state.usdc,router.fetch,router.api,1000);
 assert.equal(plan.quote.from,USDC_ASSET_ID);assert.equal(plan.quote.to,0);assert.equal(plan.quote.quote,10_000_000n);
 assert.equal(buyProblem(plan,state,1001),undefined);assert.equal(tradeProblem(plan,state,1001),undefined);
 assert.match(conversionProblem(plan,state,1001)??'',/native USDC/,'a buy never passes as a sell');
 assert.match(buyProblem(plan,{...state,usdc:999_999n},1001)??'',/USDC balance/);
 assert.match(buyProblem(plan,{...state,algo:state.minimum+plan.fees+BUY_FEE_FLOOR-1n},1001)??'',/sell back/);
 assert.match(buyProblem(plan,state,31000)??'',/expired/);
 await assert.rejects(prepareWalletBuy(state,state.usdc+1n,router.fetch,router.api,1000),/hold that much/);
 await confirmed(await submit(signSwap(plan.raw,keys.seed),ALGOD,chain.fetch),ALGOD,chain.fetch,1,0);
 const after=await walletState(keys.address,ALGOD,chain.fetch);
 assert.equal(after.usdc,0n);assert.equal(after.algo,state.algo-plan.fees+minReceive(plan.quote));
 const sell=await prepareWalletConversion(after,router.fetch,router.api,2000);
 assert.equal(conversionProblem(sell,after,2001),undefined,'the bought ALGO can be sold back');
});

test('buys use the same durable journal: resume never submits a second trade',async()=>{
 const {chain,router,keys,state}=await buyFixture();
 const plan=await prepareWalletBuy(state,state.usdc,router.fetch,router.api,1000);
 let saved:ConversionJournal|null=null,posts=0;
 const store:ConversionStore={read:async()=>saved,write:async j=>{saved=structuredClone(j);}};
 const f:typeof fetch=async(input,init)=>{if(init?.method==='POST')posts++;return chain.fetch(input,init);};
 const journal=await executeWalletConversion(keys,plan,store,{algod:ALGOD,fetch:f,now:()=>1001});
 assert.equal(journal.phase,'confirmed');assert.equal(journal.from,USDC_ASSET_ID);assert.equal(posts,1);
 assert.equal((await resumeWalletConversion(keys.address,store,{algod:ALGOD,fetch:f})).phase,'confirmed');assert.equal(posts,1);
 await assert.rejects(resumeWalletConversion(keys.address,{read:async()=>({...saved!,from:5}),write:async()=>{}},{algod:ALGOD,fetch:f}),/Invalid saved/);
 await assert.rejects(resumeWalletConversion(keys.address,{read:async()=>({...saved!,from:undefined}),write:async()=>{}},{algod:ALGOD,fetch:f}),/invalid|Invalid/,'a buy cannot be replayed as a sell');
});

test('an open position spends USDC left over from a split buy while the price stays in the buy zone',()=>{
 assert.deepEqual(decide('wait',true,MIN_BUY_USDC,0n,true),{kind:'buy',usdc:MIN_BUY_USDC});
 assert.equal(decide('wait',true,MIN_BUY_USDC,0n,false).kind,'wait');
 assert.equal(decide('wait',true,MIN_BUY_USDC-1n,0n,true).kind,'wait');
 const base=flat(DIP_RULE.hours,0.10);
 assert.equal(dipSignal([...base,0.07],true).below,true);assert.equal(dipSignal([...base,0.09],true).below,false);
});

test('trades too large for the router fee limit are prepared in halves; other errors are not retried',async()=>{
 const tried:bigint[]=[];
 const build=async(amount:bigint)=>{tried.push(amount);if(amount>9_000_000n)throw Error('network fees are too high');return {amount} as never;};
 assert.deepEqual(await fittingPlan(build,19_980_000n,1_000_000n),{amount:4_995_000n});
 assert.deepEqual(tried,[19_980_000n,9_990_000n,4_995_000n]);
 await assert.rejects(fittingPlan(build,19_980_000n,12_000_000n),/smallest trade/);
 let calls=0;
 await assert.rejects(fittingPlan(async()=>{calls++;throw Error('the wallet changed');},20_000_000n,1n),/wallet changed/);
 assert.equal(calls,1);
});

test('a partial conversion sells only the requested ALGO and never more than the reserve policy allows',async()=>{
 const router=createFakeRouter(),keys=walletKeys(generateSecretKey());
 const state={address:keys.address,algo:20_520_000n,minimum:200000n,usdc:0n,active:true};
 const part=await prepareWalletConversion(state,router.fetch,router.api,1000,5_000_000n);
 assert.equal(part.quote.amount,5_000_000n);assert.equal(conversionProblem(part,state,1001),undefined);
 await assert.rejects(prepareWalletConversion(state,router.fetch,router.api,1000,20_000_001n),/reserve policy/);
 await assert.rejects(prepareWalletConversion(state,router.fetch,router.api,1000,0n),/No ALGO/);
});
