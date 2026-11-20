import assert from 'node:assert/strict';
import {test} from 'node:test';
import algosdk from 'algosdk';
import {generateSecretKey} from 'nostr-tools/pure';
import {decodeTxn,encodeTxn,assignGroup,applicationAddress} from '../src/algotx.ts';
import {walletKeys} from '../src/wallet.ts';
import {MAINNET_GENESIS_HASH,USDC_ASSET_ID} from '../src/rails/algorand.ts';
import {FOLKS_POOL_MANAGER,FOLKS_USDC_POOL,FUSDC_ASSET_ID,LEND_MIN_USDC,fusdcValue,lendingFeeProblem,lendingGroup,lendingProblem,
 oneGroupForSimulation,parsePoolManager,prepareLending,simulate} from '../src/fundLending.ts';
import {lendingStep} from '../src/fundTrader.ts';

const genesisHash=algosdk.base64ToBytes(MAINNET_GENESIS_HASH);
const params={firstValid:1000n,genesisID:'mainnet-v1.0',genesisHash};
const keys=walletKeys(generateSecretKey()),me=keys.address;
const state={address:me,algo:500_000n,minimum:300_000n,usdc:5_000_000n,active:true};

/** The same call built by algosdk's ABI composer, the way the Folks SDK builds it. */
function sdkCall(signature:string,args:algosdk.ABIArgument[],sendAsset?:algosdk.Transaction){
 const atc=new algosdk.AtomicTransactionComposer(),signer=algosdk.makeEmptyTransactionSigner();
 const sp={flatFee:true,fee:1000n,minFee:1000n,firstValid:1000n,lastValid:1020n,genesisID:'mainnet-v1.0',genesisHash};
 atc.addMethodCall({sender:me,signer,appID:Number(FOLKS_USDC_POOL),method:algosdk.ABIMethod.fromSignature(signature),
  methodArgs:sendAsset?[{txn:sendAsset,signer},...args]:args,suggestedParams:sp});
 return atc.buildGroup().map(t=>t.txn).at(-1)!;
}
const sameBytes=(a:readonly Uint8Array[],b:readonly Uint8Array[])=>a.length===b.length&&a.every((x,i)=>Buffer.from(x).equals(Buffer.from(b[i])));

test('deposit, withdraw and the budget call encode their arguments exactly as algosdk’s ABI composer does',()=>{
 const pool=algosdk.getApplicationAddress(Number(FOLKS_USDC_POOL)).toString();
 assert.equal(pool,applicationAddress(FOLKS_USDC_POOL));
 const sp={flatFee:true,fee:1000n,minFee:1000n,firstValid:1000n,lastValid:1020n,genesisID:'mainnet-v1.0',genesisHash};
 const send=(asset:number,amount:bigint)=>algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({sender:me,receiver:pool,amount,assetIndex:asset,suggestedParams:sp});
 const cases:[string,'deposit'|'withdraw',bigint,algosdk.Transaction][]=[
  ['deposit',  'deposit', 1_234_567n,sdkCall('deposit(txn,account,asset,asset,application)uint64',[me,USDC_ASSET_ID,FUSDC_ASSET_ID,Number(FOLKS_POOL_MANAGER)],send(USDC_ASSET_ID,1_234_567n))],
  ['withdraw','withdraw',981_000n,sdkCall('withdraw(axfer,uint64,account,asset,asset,application)uint64',[0,me,USDC_ASSET_ID,FUSDC_ASSET_ID,Number(FOLKS_POOL_MANAGER)],send(FUSDC_ASSET_ID,981_000n))]];
 const update=sdkCall('update_pool_interest_indexes(application)void',[Number(FOLKS_POOL_MANAGER)]);
 for(const [label,kind,amount,sdk] of cases){
  const ours=lendingGroup(kind,me,amount,params);
  const call=ours[1],sdkApp=sdk.applicationCall!;
  assert.ok(sameBytes(call.apaa as Uint8Array[],sdkApp.appArgs),`${label} arguments`);
  assert.deepEqual((call.apas as bigint[]).map(Number),sdkApp.foreignAssets.map(Number),`${label} assets`);
  assert.deepEqual((call.apfa as bigint[]).map(Number),sdkApp.foreignApps.map(Number),`${label} apps`);
  assert.equal(sdkApp.accounts.length,0,'the receiver is the sender, reference 0');assert.equal(call.apat,undefined);
  const first=ours[0];
  assert.equal(first.xaid,BigInt(kind==='deposit'?USDC_ASSET_ID:FUSDC_ASSET_ID));assert.equal(first.aamt,amount);
  assert.ok(sameBytes(ours[2].apaa as Uint8Array[],update.applicationCall!.appArgs),'budget call arguments');
  assert.deepEqual((ours[2].apfa as bigint[]).map(Number),update.applicationCall!.foreignApps.map(Number));
  // Our encoder's bytes decode in algosdk as the same call.
  const decoded=algosdk.decodeUnsignedTransaction(encodeTxn(call));
  assert.equal(Number(decoded.applicationCall!.appIndex),Number(FOLKS_USDC_POOL));
  assert.ok(sameBytes(decoded.applicationCall!.appArgs,sdkApp.appArgs));
 }
});

test('only the expected Folks calls from this wallet pass the pre-signing check',()=>{
 const good=lendingGroup('deposit',me,1_000_000n,params);
 const raw=good.map(encodeTxn);
 assert.equal(lendingProblem(raw,me,'deposit',1_000_000n),undefined);
 assert.equal(lendingProblem(lendingGroup('withdraw',me,5n,params).map(encodeTxn),me,'withdraw',5n),undefined);
 assert.equal(lendingProblem(lendingGroup('optin',me,0n,params).map(encodeTxn),me,'optin',0n),undefined);
 assert.match(lendingProblem(raw,me,'deposit',999_999n)??'',/amount/);
 assert.match(lendingProblem(raw,me,'withdraw',1_000_000n)??'',/fee|amount|asset|method/,'a deposit never passes as a withdrawal');
 assert.match(lendingProblem(raw,walletKeys(generateSecretKey()).address,'deposit',1_000_000n)??'',/this wallet/);
 const tamper=(i:number,change:(t:ReturnType<typeof decodeTxn>)=>void,regroup=true)=>{const t=raw.map(decodeTxn);change(t[i]);if(regroup)assignGroup(t);return t.map(encodeTxn);};
 assert.match(lendingProblem(tamper(0,t=>{t.rekey=t.snd;}),me,'deposit',1_000_000n)??'',/hand over/);
 assert.match(lendingProblem(tamper(0,t=>{t.aclose=t.snd;}),me,'deposit',1_000_000n)??'',/hand over/);
 assert.match(lendingProblem(tamper(1,t=>{t.apid=123n;}),me,'deposit',1_000_000n)??'',/Folks USDC pool/);
 assert.match(lendingProblem(tamper(1,t=>{t.apan=1n;}),me,'deposit',1_000_000n)??'',/plain call/);
 assert.match(lendingProblem(tamper(1,t=>{t.apas=[31566704n,999n];}),me,'deposit',1_000_000n)??'',/asset references/);
 assert.match(lendingProblem(tamper(1,t=>{(t.apaa as Uint8Array[])[1]=new Uint8Array([1]);}),me,'deposit',1_000_000n)??'',/method or arguments/);
 assert.match(lendingProblem(tamper(2,t=>{t.apid=1n;}),me,'deposit',1_000_000n)??'',/index update/);
 assert.match(lendingProblem(tamper(1,t=>{t.fee=50_000n;}),me,'deposit',1_000_000n)??'',/fee/);
 assert.match(lendingProblem(tamper(0,t=>{t.gen='testnet-v1.0';}),me,'deposit',1_000_000n)??'',/mainnet/);
 assert.match(lendingProblem(tamper(0,t=>{t.note=new Uint8Array([1]);},false),me,'deposit',1_000_000n)??'',/one group/);
 assert.match(lendingProblem(tamper(0,t=>{delete t.lx;}),me,'deposit',1_000_000n)??'',/lease/);
 assert.match(lendingProblem(tamper(0,t=>{t.lv=2000n;}),me,'deposit',1_000_000n)??'',/validity/);
 const optin=lendingGroup('optin',me,0n,params);optin[0].aamt=5n;
 assert.match(lendingProblem(optin.map(encodeTxn),me,'optin',0n)??'',/opt-in/);
});

test('lending fees always leave ALGO to sell positions back, including the opt-in’s extra minimum',()=>{
 assert.equal(lendingFeeProblem('deposit',state),undefined);
 assert.match(lendingFeeProblem('deposit',{...state,algo:300_000n+6000n+99_999n})??'',/sell back/);
 assert.equal(lendingFeeProblem('optin',{...state,minimum:200_000n,algo:401_000n}),undefined);
 assert.match(lendingFeeProblem('optin',{...state,minimum:200_000n,algo:400_999n})??'',/sell back/);
 assert.throws(()=>prepareLending('deposit',state,state.usdc+1n,params),/that much USDC/);
 assert.throws(()=>prepareLending('withdraw',state,0n,params),/Nothing/);
 assert.throws(()=>prepareLending('deposit',state,1n,{...params,genesisID:'testnet-v1.0'}),/mainnet/);
 const plan=prepareLending('deposit',state,state.usdc,params);
 assert.equal(plan.fees,6000n);assert.equal(plan.lastValid,1020n);
});

test('the pool manager’s state gives the rate and an index that grows with time',()=>{
 const slot=new Uint8Array(126);
 const put=(at:number,n:bigint,len:number)=>{for(let i=0;i<len;i++)slot[at+len-1-i]=Number((n>>BigInt(8*i))&0xffn);};
 const base=84;put(base,FOLKS_USDC_POOL,6);put(base+22,422_600_000_000_000n,8);put(base+30,125_000_000_000_000n,8);put(base+38,1_790_000_000n,4);
 const state=[{key:Buffer.from([0]).toString('base64'),value:{bytes:Buffer.from(slot).toString('base64')}}];
 const now=parsePoolManager(state,1_790_000_000),later=parsePoolManager(state,1_790_000_000+31_536_000);
 assert.equal(now.rate,422_600_000_000_000n);assert.equal(now.index,125_000_000_000_000n);
 assert.ok(Math.abs(Number(later.index)/Number(now.index)-1.04226)<1e-9,'one year at 4.226% (simple, as the SDK computes)');
 assert.equal(fusdcValue(1_000_000n,now.index),1_250_000n);
 put(base,123n,6);
 assert.throws(()=>parsePoolManager([{key:state[0].key,value:{bytes:Buffer.from(slot).toString('base64')}}],0),/USDC pool/);
});

test('the bot withdraws before buying and lends only USDC that is waiting',()=>{
 assert.equal(lendingStep({kind:'buy',usdc:5_000_000n},false,0n,4_000_000n),'withdraw');
 assert.equal(lendingStep({kind:'buy',usdc:5_000_000n},false,5_000_000n,0n),undefined);
 assert.equal(lendingStep({kind:'buy',usdc:5_000_000n},true,5_000_000n,null),undefined);
 assert.equal(lendingStep({kind:'wait',reason:''},false,LEND_MIN_USDC,null),'optin');
 assert.equal(lendingStep({kind:'wait',reason:''},false,LEND_MIN_USDC,0n),'deposit');
 assert.equal(lendingStep({kind:'wait',reason:''},false,LEND_MIN_USDC-1n,0n),undefined);
 assert.equal(lendingStep({kind:'wait',reason:''},true,LEND_MIN_USDC,0n),undefined,'not while holding ALGO');
 assert.equal(lendingStep({kind:'sell',reason:'sweep'},false,LEND_MIN_USDC,0n),undefined,'sweep first; lend next check');
});

test('simulation requests are MessagePack with the unsigned transactions as signed-transaction maps',async()=>{
 const plans=[prepareLending('deposit',state,state.usdc,params),prepareLending('withdraw',state,1n,params)];
 const group=oneGroupForSimulation(plans);
 assert.equal(group.length,6);
 const txns=group.map(decodeTxn);
 assert.ok(txns[0].lx instanceof Uint8Array&&txns.slice(1).every(t=>t.lx===undefined),'one lease');
 assert.equal(new Set(group.map(g=>Buffer.from(g).toString('hex'))).size,6,'no duplicate transactions');
 let body:Uint8Array|undefined;
 const fetchImpl:typeof fetch=async(_url,init)=>{body=init!.body as Uint8Array;return Response.json({'txn-groups':[{}]});};
 const out=await simulate([group],'https://algod.test',fetchImpl);
 assert.equal(out.ok,true);
 const req=algosdk.msgpackRawDecode(body!) as Map<string,unknown>|Record<string,unknown>;
 const get=(o:unknown,k:string)=>o instanceof Map?o.get(k):(o as Record<string,unknown>)[k];
 assert.equal(get(req,'allow-empty-signatures'),true);
 const sent=get(get((get(req,'txn-groups') as unknown[])[0],'txns') as unknown,'length');
 assert.equal(sent,6);
});
