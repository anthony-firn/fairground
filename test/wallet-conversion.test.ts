import assert from 'node:assert/strict';
import {test} from 'node:test';
import {generateSecretKey} from 'nostr-tools/pure';
import {assignGroup,decodeTxn,encodeTxn,signTxn,assetTxn} from '../src/algotx.ts';
import {walletKeys,walletState,suggestedParams,submit,confirmed,convertibleAlgo} from '../src/wallet.ts';
import {signSwap,minReceive} from '../src/swap.ts';
import {USDC_ASSET_ID} from '../src/rails/algorand.ts';
import {convertibleOnRequest,conversionProblem,prepareWalletConversion,walletReserve} from '../src/walletConversion.ts';
import {ALGOD,createFakeChain,createFakeRouter} from './fakechain.ts';

test('a small funded wallet can explicitly convert to USDC while retaining its operating reserve',async()=>{
 const chain=createFakeChain(),router=createFakeRouter(),keys=walletKeys(generateSecretKey());
 chain.fund(keys.address,1102016n);
 await submit([signTxn(assetTxn(keys.address,keys.address,USDC_ASSET_ID,0n,await suggestedParams(ALGOD,chain.fetch)),keys.seed)],ALGOD,chain.fetch);
 const state=await walletState(keys.address,ALGOD,chain.fetch);
 assert.equal(convertibleAlgo(state),0n,'automatic threshold must not hide the manual conversion');
 const plan=await prepareWalletConversion(state,router.fetch,router.api,1000);
 assert.equal(plan.quote.amount,581016n);assert.equal(plan.fees,8000n);assert.equal(plan.reserve,500000n);
 assert.equal(conversionProblem(plan,state,1001),undefined);
 await confirmed(await submit(signSwap(plan.raw,keys.seed),ALGOD,chain.fetch),ALGOD,chain.fetch,1,0);
 const after=await walletState(keys.address,ALGOD,chain.fetch);
 assert.equal(after.usdc,minReceive(plan.quote));assert.ok(after.algo>=plan.reserve);
});

test('quote expiry, balance changes and a rekeyed account prevent signing',async()=>{
 const keys=walletKeys(generateSecretKey()),router=createFakeRouter();
 const state={address:keys.address,algo:1101016n,minimum:200000n,usdc:0n,active:true};
 const plan=await prepareWalletConversion(state,router.fetch,router.api,1000);
 assert.match(conversionProblem(plan,state,31000)??'',/expired/);
 assert.match(conversionProblem(plan,{...state,algo:600000n},1001)??'',/reserve/);
 assert.match(conversionProblem(plan,{...state,authAddress:walletKeys(generateSecretKey()).address},1001)??'',/external signing/);
 assert.equal(convertibleOnRequest({...state,active:false}),0n);
 assert.equal(walletReserve({...state,minimum:700000n}),1000000n);
 assert.equal(convertibleOnRequest({...state,minimum:700000n}),81016n);
});

test('conversion review checks mainnet, group integrity and actual prepared fees',async()=>{
 const keys=walletKeys(generateSecretKey()),router=createFakeRouter();
 const state={address:keys.address,algo:1101016n,minimum:200000n,usdc:0n,active:true};
 const plan=await prepareWalletConversion(state,router.fetch,router.api,1000);
 let txns=plan.raw.map(decodeTxn);txns[0].note=new Uint8Array([1]);
 assert.match(conversionProblem({...plan,raw:txns.map(encodeTxn)},state,1001)??'',/group/);
 txns=plan.raw.map(decodeTxn);for(const t of txns)t.gen='testnet-v1.0';assignGroup(txns);
 assert.match(conversionProblem({...plan,raw:txns.map(encodeTxn)},state,1001)??'',/mainnet/);
 txns=plan.raw.map(decodeTxn);txns[0].fee=2000n;assignGroup(txns);
 assert.match(conversionProblem({...plan,raw:txns.map(encodeTxn)},state,1001)??'',/fees/);
});

import {executeWalletConversion,resumeWalletConversion,type ConversionJournal,type ConversionStore} from '../src/conversionSession.ts';

async function conversionFixture(){
 const chain=createFakeChain(),router=createFakeRouter(),keys=walletKeys(generateSecretKey());
 chain.fund(keys.address,1102016n);
 await submit([signTxn(assetTxn(keys.address,keys.address,USDC_ASSET_ID,0n,await suggestedParams(ALGOD,chain.fetch)),keys.seed)],ALGOD,chain.fetch);
 const state=await walletState(keys.address,ALGOD,chain.fetch),plan=await prepareWalletConversion(state,router.fetch,router.api,1000);
 let saved:ConversionJournal|null=null,posts=0,timeout=false;
 const store:ConversionStore={read:async()=>saved,write:async j=>{saved=structuredClone(j);}};
 const f:typeof fetch=async(input,init)=>{
  const response=await chain.fetch(input,init);
  if(String(input).includes('/pending/')){
   const body=await response.clone().json() as Record<string,unknown>;
   if(body['pool-error']==='unknown transaction')return Response.json({}, {status:404});
  }
  if(init?.method==='POST'&&String(input).endsWith('/v2/transactions')){posts++;if(timeout)throw Error('timeout after acceptance');}
  return response;
 };
 return {keys,plan,store,chain,f,posts:()=>posts,saved:()=>saved,timeout:()=>{timeout=true;}};
}

test('a conversion accepted before timeout is resumed without another submission',async()=>{
 const t=await conversionFixture();t.timeout();
 await assert.rejects(executeWalletConversion(t.keys,t.plan,t.store,{algod:ALGOD,fetch:t.f,now:()=>1001}),/timeout/);
 assert.equal(t.saved()?.phase,'prepared');assert.equal(t.posts(),1);
 const result=await resumeWalletConversion(t.keys.address,t.store,{algod:ALGOD,fetch:t.f});
 assert.equal(result.phase,'confirmed');assert.equal(t.posts(),1);
 const repeat=await executeWalletConversion(t.keys,t.plan,t.store,{algod:ALGOD,fetch:t.f,now:()=>1002});
 assert.equal(repeat.phase,'confirmed');assert.equal(t.posts(),1);
});

test('storage failure prevents broadcasting and corrupted journals cannot be replayed',async()=>{
 const t=await conversionFixture();
 await assert.rejects(executeWalletConversion(t.keys,t.plan,{read:async()=>null,write:async()=>{throw Error('storage unavailable');}},{algod:ALGOD,fetch:t.f,now:()=>1001}),/storage unavailable/);
 assert.equal(t.posts(),0);
 t.timeout();await assert.rejects(executeWalletConversion(t.keys,t.plan,t.store,{algod:ALGOD,fetch:t.f,now:()=>1001}));
 const saved=t.saved()!;await t.store.write({...saved,lastValid:'0'});
 await assert.rejects(resumeWalletConversion(t.keys.address,t.store,{algod:ALGOD,fetch:t.f}),/signature|transaction ID/);
 assert.equal(t.posts(),1);
});

test('a pending conversion cannot be replaced and an expired one needs a synchronized indexer',async()=>{
 const t=await conversionFixture();
 let captured:ConversionJournal|null=null;
 await assert.rejects(executeWalletConversion(t.keys,t.plan,{read:async()=>null,write:async j=>{captured=structuredClone(j);throw Error('interrupted');}},{algod:ALGOD,fetch:t.f,now:()=>1001}),/interrupted/);
 await t.store.write(captured!);
 const other={...t.plan,raw:t.plan.raw.map(r=>r.slice())};
 const txns=other.raw.map(decodeTxn);txns[0].note=new Uint8Array([2]);assignGroup(txns);other.raw=txns.map(t=>Uint8Array.from(encodeTxn(t)));
 await assert.rejects(executeWalletConversion(t.keys,other,t.store,{algod:ALGOD,fetch:t.f,now:()=>1001}),/already pending/);
 let synchronized=false;
 const f:typeof fetch=async(input,init)=>{
  const url=String(input);
  if(url.endsWith('/v2/transactions/params'))return Response.json({'last-round':2000});
  if(url.includes('/pending/'))return Response.json({}, {status:404});
  if(url.endsWith('/health'))return Response.json({round:synchronized?2000:1000});
  if(url.includes('/v2/transactions/'))return Response.json({}, {status:404});
  return t.f(input,init);
 };
 await assert.rejects(resumeWalletConversion(t.keys.address,t.store,{algod:ALGOD,indexer:'https://indexer.test',fetch:f}),/caught up/);
 assert.equal(t.saved()?.phase,'prepared');assert.equal(t.posts(),0);
 synchronized=true;const result=await resumeWalletConversion(t.keys.address,t.store,{algod:ALGOD,indexer:'https://indexer.test',fetch:f});
 assert.equal(result.phase,'expired');assert.equal(t.posts(),0);
});
