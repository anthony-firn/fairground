import assert from 'node:assert/strict';
import {test} from 'node:test';
import algosdk from 'algosdk';
import {generateSecretKey} from 'nostr-tools/pure';
import {applicationAddress,decodeTxn,encodeTxn} from '../src/algotx.ts';
import {walletKeys} from '../src/wallet.ts';
import {MAINNET_GENESIS_HASH,USDC_ASSET_ID} from '../src/rails/algorand.ts';
import {FOLKS_POOL_MANAGER,FOLKS_USDC_POOL} from '../src/fundLending.ts';
import {FALGO_ASSET_ID,FOLKS_ALGO_POOL,FOLKS_GENERAL_LOAN,FOLKS_OPUP_CALLER,FOLKS_ORACLE_ADAPTER,FOLKS_RESERVE,FRUSDC_ASSET_ID,SIG,addCollateralGroup,borrowGroup,
 borrowIndexAt,createLoanGroup,currentDebt,depositCollateralGroup,encodeGroup,loanHealth,loanProblem,newEscrow,parseLoanState,reduceCollateralGroup,refreshPrices,repayGroup} from '../src/fundLoan.ts';

const genesisHash=algosdk.base64ToBytes(MAINNET_GENESIS_HASH);
const params={firstValid:1000n,genesisID:'mainnet-v1.0',genesisHash};
const me=walletKeys(generateSecretKey()).address,escrow=newEscrow().address;
const sp={flatFee:true,fee:1000n,minFee:1000n,firstValid:1000n,lastValid:1020n,genesisID:'mainnet-v1.0',genesisHash};
const signer=algosdk.makeEmptyTransactionSigner();
const n=(x:bigint|number)=>Number(x);

/** The call algosdk's ABI composer builds for `signature` with `args` (transaction arguments first). */
function sdkCall(app:bigint,signature:string,args:algosdk.ABIArgument[],txnArg?:algosdk.Transaction,sender=me){
 const atc=new algosdk.AtomicTransactionComposer();
 atc.addMethodCall({sender,signer,appID:n(app),method:algosdk.ABIMethod.fromSignature(signature),methodArgs:txnArg?[{txn:txnArg,signer},...args]:args,suggestedParams:sp});
 return atc.buildGroup().map(t=>t.txn).at(-1)!.applicationCall!;
}
const sameArgs=(ours:unknown,sdk:readonly Uint8Array[])=>{const a=ours as Uint8Array[];return a.length===sdk.length&&a.every((x,i)=>Buffer.from(x).equals(Buffer.from(sdk[i])));};
function compare(label:string,ours:ReturnType<typeof decodeTxn>,sdk:algosdk.Transaction['applicationCall']){
 const s=sdk!;
 assert.equal(n(ours.apid as bigint),n(s.appIndex),`${label} app`);
 assert.ok(sameArgs(ours.apaa,s.appArgs),`${label} arguments`);
 assert.deepEqual(((ours.apas as bigint[]|undefined)??[]).map(n),s.foreignAssets.map(n),`${label} assets`);
 assert.deepEqual(((ours.apfa as bigint[]|undefined)??[]).map(n),s.foreignApps.map(n),`${label} apps`);
 assert.deepEqual(((ours.apat as Uint8Array[]|undefined)??[]).map(a=>algosdk.encodeAddress(a)),s.accounts.map((a:algosdk.Address)=>a.toString()),`${label} accounts`);
}
const pay=(to:string,amount:number|bigint)=>algosdk.makePaymentTxnWithSuggestedParamsFromObject({sender:me,receiver:to,amount,suggestedParams:sp});
const axfer=(to:string,asset:number,amount:bigint)=>algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({sender:me,receiver:to,amount,assetIndex:asset,suggestedParams:sp});

test('every loan call encodes its arguments and references exactly as algosdk’s ABI composer does',()=>{
 const refresh=(assets:number[])=>sdkCall(FOLKS_ORACLE_ADAPTER,SIG.refreshPrices,[[],assets,1040271396,971323141,0]);
 compare('refresh ALGO',decodeTxn(encodeTxn(refreshPrices(me,[0],params))),refresh([0]));
 compare('refresh loan',decodeTxn(encodeTxn(refreshPrices(me,[0,USDC_ASSET_ID],params))),refresh([0,USDC_ASSET_ID]));
 const refTxn=()=>algosdk.makeApplicationNoOpTxnFromObject({sender:me,appIndex:n(FOLKS_ORACLE_ADAPTER),suggestedParams:sp});
 const create=createLoanGroup(me,escrow,0n,params);
 compare('create loan',create[1],sdkCall(FOLKS_GENERAL_LOAN,SIG.createLoan,[],pay(applicationAddress(FOLKS_GENERAL_LOAN),0),escrow));
 assert.equal(create[1].apan,1n,'opt-in');assert.ok(Buffer.from(create[1].rekey as Uint8Array).equals(Buffer.from(algosdk.decodeAddress(applicationAddress(FOLKS_GENERAL_LOAN)).publicKey)));
 assert.equal(Buffer.from(create[0].note as Uint8Array).subarray(0,3).toString(),'la ');
 compare('add collateral',addCollateralGroup(me,escrow,params)[0],sdkCall(FOLKS_GENERAL_LOAN,SIG.addCollateral,[escrow,FALGO_ASSET_ID,n(FOLKS_ALGO_POOL),0,0,n(FOLKS_POOL_MANAGER)]));
 const dep=depositCollateralGroup(me,escrow,5_000_000n,params);
 compare('deposit to escrow',dep[2],sdkCall(FOLKS_ALGO_POOL,SIG.deposit,[escrow,0,FALGO_ASSET_ID,n(FOLKS_POOL_MANAGER)],pay(applicationAddress(FOLKS_ALGO_POOL),5_000_000)));
 compare('index update',dep[3],sdkCall(FOLKS_ALGO_POOL,SIG.updateIndexes,[n(FOLKS_POOL_MANAGER)]));
 compare('sync collateral',dep[5],sdkCall(FOLKS_GENERAL_LOAN,SIG.syncCollateral,[escrow,FALGO_ASSET_ID,n(FOLKS_ALGO_POOL),n(FOLKS_POOL_MANAGER),n(FOLKS_ORACLE_ADAPTER)],refTxn()));
 assert.equal(dep[1].amt,5_000_000n);
 const bor=borrowGroup(me,escrow,1_234_567n,params);
 compare('borrow',bor[2],sdkCall(FOLKS_GENERAL_LOAN,SIG.borrow,[escrow,me,USDC_ASSET_ID,1_234_567n,0n,2,2,n(FOLKS_USDC_POOL),n(FOLKS_POOL_MANAGER),n(FOLKS_ORACLE_ADAPTER)],refTxn()));
 const rep=repayGroup(me,escrow,777n,params);
 compare('repay',rep[2],sdkCall(FOLKS_GENERAL_LOAN,SIG.repay,[escrow,me,FOLKS_RESERVE,USDC_ASSET_ID,FRUSDC_ASSET_ID,false,n(FOLKS_USDC_POOL),n(FOLKS_POOL_MANAGER)],axfer(applicationAddress(FOLKS_USDC_POOL),USDC_ASSET_ID,777n)));
 const red=reduceCollateralGroup(me,escrow,4_000_000n,params);
 compare('reduce collateral',red[2],sdkCall(FOLKS_GENERAL_LOAN,SIG.reduceCollateral,[escrow,me,0,FALGO_ASSET_ID,4_000_000n,true,n(FOLKS_ALGO_POOL),n(FOLKS_POOL_MANAGER),n(FOLKS_ORACLE_ADAPTER)],refTxn()));
 // OpUp: the SDK's prefixWithOpUp builds a plain call with the count as its only argument and the base app as reference.
 for(const [g,count] of [[dep,2],[bor,6],[rep,3],[red,3]] as const){
  const sdkUp=algosdk.makeApplicationNoOpTxnFromObject({sender:me,appIndex:n(FOLKS_OPUP_CALLER),appArgs:[algosdk.encodeUint64(count)],foreignApps:[971335616],suggestedParams:sp}).applicationCall!;
  compare(`opup ${count}`,g[0],sdkUp);assert.equal(g[0].fee,BigInt(1000+1000*count));
 }
});

test('the loan check passes our groups and refuses anything that could move funds elsewhere',()=>{
 const ok=(t:ReturnType<typeof createLoanGroup>,max=10_000_000n)=>loanProblem(encodeGroup(t),me,escrow,max);
 for(const g of [createLoanGroup(me,escrow,500_000n,params),addCollateralGroup(me,escrow,params),depositCollateralGroup(me,escrow,5_000_000n,params),
  borrowGroup(me,escrow,1_000_000n,params),repayGroup(me,escrow,1_000_000n,params),reduceCollateralGroup(me,escrow,1n,params)])assert.equal(ok(g),undefined);
 const other=walletKeys(generateSecretKey()).address;
 assert.match(loanProblem(encodeGroup(createLoanGroup(me,escrow,500_000n,params)),me,other,10_000_000n)??'',/someone else|unexpected/);
 const mutate=(g:ReturnType<typeof createLoanGroup>,i:number,f:(t:ReturnType<typeof decodeTxn>)=>void)=>{const t=g.map(x=>({...x}));f(t[i]);return encodeGroup(t);};
 const dep=depositCollateralGroup(me,escrow,5_000_000n,params);
 assert.match(loanProblem(mutate(dep,1,t=>{t.rcv=algosdk.decodeAddress(other).publicKey;}),me,escrow,10_000_000n)??'',/payment/);
 assert.match(loanProblem(mutate(dep,1,t=>{t.close=t.rcv;}),me,escrow,10_000_000n)??'',/empty/);
 assert.match(loanProblem(mutate(dep,2,t=>{t.rekey=t.snd;}),me,escrow,10_000_000n)??'',/rekeyed/);
 assert.match(loanProblem(mutate(dep,2,t=>{t.apid=12345n;}),me,escrow,10_000_000n)??'',/unexpected app/);
 assert.match(loanProblem(mutate(dep,2,t=>{t.apan=4n;}),me,escrow,10_000_000n)??'',/change or leave/);
 assert.match(loanProblem(mutate(dep,2,t=>{t.fee=50_000n;}),me,escrow,10_000_000n)??'',/fees/);
 assert.match(loanProblem(encodeGroup(dep),me,escrow,4_999_999n)??'',/payment/,'amounts are bounded');
 const create=createLoanGroup(me,escrow,500_000n,params);
 assert.match(loanProblem(mutate(create,2,t=>{t.rekey=algosdk.decodeAddress(other).publicKey;}),me,escrow,10_000_000n)??'',/hand itself/);
 assert.match(loanProblem(mutate(dep,3,t=>{t.note=new Uint8Array([1]);}),me,escrow,10_000_000n)??'',/one group/);
 const rep=repayGroup(me,escrow,1_000_000n,params);
 assert.match(loanProblem(mutate(rep,1,t=>{t.xaid=BigInt(FALGO_ASSET_ID);}),me,escrow,10_000_000n)??'',/asset transfer/);
});

const b64=(b:Uint8Array)=>Buffer.from(b).toString('base64'),key=(s:string)=>b64(new TextEncoder().encode(s));
const words=(ns:bigint[])=>{const out=new Uint8Array(8*ns.length);ns.forEach((v,i)=>{for(let j=0;j<8;j++)out[8*i+7-j]=Number((v>>BigInt(8*j))&0xffn);});return out;};

test('loan state gives collateral and debt; debt grows with the borrow index; health compares with the collateral factor',()=>{
 const slots=(at:number,v:bigint)=>{const a=Array(15).fill(0n);a[at]=v;return a;};
 const state=[{key:key('c'),value:{bytes:b64(words(slots(3,FOLKS_ALGO_POOL)))}},{key:key('cb'),value:{bytes:b64(words(slots(3,40_000_000n)))}},
  {key:key('b'),value:{bytes:b64(words(slots(5,FOLKS_USDC_POOL)))}},{key:key('bb'),value:{bytes:b64(words(slots(5,1_000_000n)))}},{key:key('l'),value:{bytes:b64(words(slots(5,1_000_000_000_000_000n)))}}];
 const s=parseLoanState(state);
 assert.deepEqual(s,{collateralF:40_000_000n,borrowBalance:1_000_000n,borrowIndex:1_000_000_000_000_000n});
 assert.equal(currentDebt(s,1_010_000_000_000_000n),1_010_000n);assert.equal(currentDebt({...s,borrowBalance:0n},2n),0n);
 assert.deepEqual(parseLoanState([]),{collateralF:0n,borrowBalance:0n,borrowIndex:0n});
 // Pool manager slot for the USDC pool (index 2): rate 5.93%, index 1.0, updated at t0; one year later ≈ e^0.0593.
 const slot=new Uint8Array(126),put=(at:number,v:bigint,len:number)=>{for(let i=0;i<len;i++)slot[at+len-1-i]=Number((v>>BigInt(8*i))&0xffn);};
 put(84,FOLKS_USDC_POOL,6);put(84+6,593_000_000_000_000n,8);put(84+14,10n**16n,8);put(84+38,1_790_000_000n,4);
 const pm=[{key:b64(new Uint8Array([0])),value:{bytes:b64(slot)}}];
 assert.equal(borrowIndexAt(pm,2,FOLKS_USDC_POOL,1_790_000_000),10n**16n);
 const year=Number(borrowIndexAt(pm,2,FOLKS_USDC_POOL,1_790_000_000+31_536_000))/1e16;
 assert.ok(Math.abs(year-Math.exp(0.0593))<1e-6,`${year}`);
 assert.throws(()=>borrowIndexAt(pm,2,FOLKS_ALGO_POOL,0),/expected pool/);
 assert.equal(loanHealth(100,0.1,5),1.3);assert.equal(loanHealth(100,0.1,0),Infinity);
});

import {LEVERAGE,LOAN_KIND,BORROW_HEALTH,DELEVER_HEALTH,DELEVER_TO,loanStep,nextDelevering,viewHealth,type LoanView} from '../src/fundTrader.ts';
test('a 2x trade levers up in rounds, sells down itself in a fall, and exits without breaching health',()=>{
 const idx=125_000_000_000_000n,ALGO_PER_F=1.25;// 1.25 ALGO per fALGO
 const fOf=(algo:number)=>BigInt(Math.round(algo/ALGO_PER_F*1e6));
 const cf=LOAN_KIND.collateralFactor,show=(x:unknown)=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v);
 assert.equal(LEVERAGE,2);assert.equal(LOAN_KIND.name,'general');assert.equal(cf,0.65);
 const base:LoanView={inTrade:false,levered:false,hasEscrow:false,collateralAdded:false,walletAlgo:0n,walletUsdc:0n,collateralF:0n,algoIndex:idx,debt:0n,price:0.08,tradeUsdc:0n,setupAffordable:false};
 assert.equal(loanStep(base),undefined,'no setup until it is affordable');
 assert.deepEqual(loanStep({...base,setupAffordable:true}),{step:'create'});
 assert.deepEqual(loanStep({...base,hasEscrow:true,setupAffordable:true}),{step:'addCollateral'});
 const ready={...base,hasEscrow:true,collateralAdded:true};
 assert.equal(loanStep(ready),undefined,'idle with a loan ready');
 // Entry: own 10 USDC bought 125 ALGO ($10), which becomes collateral.
 let v:LoanView={...ready,inTrade:true,walletAlgo:125_000_000n,tradeUsdc:10_000_000n};
 assert.deepEqual(loanStep(v),{step:'depositCollateral',algo:125_000_000n});
 v={...v,walletAlgo:0n,collateralF:fOf(125)};
 const first=loanStep(v);
 assert.ok(first&&first.step==='borrow'&&Math.abs(Number(first.usdc)-10*cf/BORROW_HEALTH*1e6)<2,`the first borrow is capped by health ${BORROW_HEALTH}: ${show(first)}`);
 // Play the loop: borrow → buy → deposit, until the debt reaches the $10 target (2x of the own $10).
 let rounds=0,deposits=0;
 for(let step=loanStep(v);step;step=loanStep(v)){
  assert.ok(++rounds<40,'the loop ends');
  if(step.step==='borrow'){assert.ok(viewHealth({...v,debt:v.debt+step.usdc})>=BORROW_HEALTH-1e-3,`a borrow never goes below ${BORROW_HEALTH}`);v={...v,levered:true,debt:v.debt+step.usdc,walletUsdc:v.walletUsdc+step.usdc};}
  else if(step.step==='leverBuy'){v={...v,walletUsdc:0n,walletAlgo:v.walletAlgo+BigInt(Math.floor(Number(step.usdc)/v.price))};}
  else if(step.step==='depositCollateral'){deposits++;v={...v,walletAlgo:0n,collateralF:v.collateralF+fOf(Number(step.algo)/1e6)};}
  else assert.fail(`unexpected step while levering up: ${show(step)}`);
 }
 assert.equal(v.debt,10_000_000n,'debt reaches exactly the target');
 assert.ok(deposits>=2&&v.walletAlgo>0n,`several rounds, the last buy kept as a ready-to-sell buffer (${deposits} deposits)`);
 const holding=v,h0=viewHealth(holding);
 assert.ok(h0>=BORROW_HEALTH-0.01&&h0<BORROW_HEALTH+0.1,`holding at 2x: health ${h0.toFixed(3)}`);
 // ALGO falls until health is under DELEVER_HEALTH: the buffer is sold first, then the USDC repaid …
 const falling={...holding,price:holding.price*(DELEVER_HEALTH-0.01)/h0};
 assert.ok(viewHealth(falling)<DELEVER_HEALTH&&nextDelevering(viewHealth(falling),false));
 assert.deepEqual(loanStep(falling),{step:'sellAlgo',algo:holding.walletAlgo});
 const sold={...falling,walletAlgo:0n,walletUsdc:300_000n};
 const collateralUsd=Number((sold.collateralF*idx)/10n**14n)/1e6*sold.price,keep=BigInt(Math.floor(collateralUsd*cf/DELEVER_TO*1e6)),cut=10_000_000n-keep;
 assert.deepEqual(loanStep(sold),{step:'repay',usdc:300_000n<cut+cut/50n?300_000n:cut+cut/50n});
 // … then, with nothing loose, collateral is released only down to health 1.02, and the sell-down continues to DELEVER_TO.
 const repaid={...sold,walletUsdc:0n,debt:9_700_000n,delevering:true};
 const rel=loanStep(repaid);assert.ok(rel&&rel.step==='releaseCollateral',show(rel));
 const after={...repaid,collateralF:repaid.collateralF-(rel as {f:bigint}).f};
 assert.ok(Math.abs(viewHealth(after)-1.02)<0.002,`release leaves health at 1.02: ${viewHealth(after)}`);
 assert.equal(loanStep({...repaid,delevering:false,price:repaid.price*1.04}),undefined,'recovered above the trigger and not mid sell-down: hold');
 assert.ok(nextDelevering(DELEVER_TO-0.01,true)&&!nextDelevering(DELEVER_TO+0.01,true)&&!nextDelevering(DELEVER_HEALTH+0.01,false),'a sell-down runs from the trigger to DELEVER_TO');
 // Exit: repay what the wallet holds, then release collateral in healthy steps.
 const exit={...holding,inTrade:false,walletAlgo:0n,walletUsdc:3_000_000n};
 assert.deepEqual(loanStep(exit),{step:'repay',usdc:3_000_000n});
 const ex2={...exit,walletUsdc:0n};
 const e2=loanStep(ex2);assert.ok(e2&&e2.step==='releaseCollateral');
 assert.ok(viewHealth({...ex2,collateralF:ex2.collateralF-(e2 as {f:bigint}).f})>=1.0199,'an exit release never takes health below 1.02');
 assert.deepEqual(loanStep({...exit,debt:0n,walletUsdc:500_000n}),{step:'releaseCollateral',f:exit.collateralF});
 assert.equal(loanStep({...ex2,walletAlgo:5_000_000n}),undefined,'the sweep sells wallet ALGO before repaying');
 // Small trades and leverage 1 never borrow; another loan type uses its own factor.
 const r1={...ready,inTrade:true,tradeUsdc:10_000_000n,collateralF:fOf(125)};
 assert.equal(loanStep({...r1,tradeUsdc:4_999_999n}),undefined,'no borrowing on a trade under $5');
 assert.equal(loanStep(r1,1),undefined,'leverage 1 never borrows');
 const us=loanStep(r1,2,0.825);assert.ok(us&&us.step==='borrow'&&Math.abs(Number(us.usdc)-10*0.825/BORROW_HEALTH*1e6)<2,'collateral factor is per loan type');
});

import {nextMove} from '../src/fundTrader.ts';
test('the trader protects a loan first, frees lent USDC before buying, trades, then tends the loan, then lends',()=>{
 const wait={kind:'wait' as const,reason:''},base={inTrade:false,action:wait,walletUsdc:0n,convertible:0n};
 const repay={step:'repay' as const,usdc:5n},sell={step:'sellAlgo' as const,algo:9n};
 assert.deepEqual(nextMove({...base,inTrade:true,action:{kind:'buy',usdc:5n},loanAct:repay}),{kind:'loan',act:repay},'deleveraging beats a top-up buy');
 assert.deepEqual(nextMove({...base,inTrade:true,loanAct:sell}),{kind:'swap',sell:{algo:9n,reason:'delever'}});
 assert.deepEqual(nextMove({...base,action:{kind:'buy',usdc:9n},lend:'withdraw',walletUsdc:0n}),{kind:'lending',step:'withdraw'});
 assert.deepEqual(nextMove({...base,action:{kind:'buy',usdc:9n},walletUsdc:7n}),{kind:'swap',buy:7n},'buys only what the wallet holds');
 assert.deepEqual(nextMove({...base,action:{kind:'sell',reason:'sweep'},loanAct:repay,convertible:3n}),{kind:'swap',sell:{algo:3n,reason:'sweep'}},'sell before repaying');
 assert.deepEqual(nextMove({...base,loanAct:repay,lend:'deposit'}),{kind:'loan',act:repay},'repay before lending');
 assert.deepEqual(nextMove({...base,inTrade:true,loanAct:{step:'leverBuy',usdc:4n}}),{kind:'swap',buy:4n});
 assert.deepEqual(nextMove({...base,lend:'deposit'}),{kind:'lending',step:'deposit'});
 assert.equal(nextMove(base),undefined);
});

import {GENERAL_LOAN,ULTRASWAP_UP_LOAN,loanKindFor} from '../src/fundLoan.ts';
test('Ultraswap loan groups call its own app with its own pool slots, and the check holds each group to its loan type',()=>{
 const me=walletKeys(generateSecretKey()).address,escrow=walletKeys(generateSecretKey()).address;
 const p={firstValid:1000n,genesisID:'mainnet-v1.0',genesisHash:algosdk.base64ToBytes(MAINNET_GENESIS_HASH)};
 const bor=borrowGroup(me,escrow,1_000_000n,p,ULTRASWAP_UP_LOAN),call=bor[2];
 assert.equal(call.apid,1202382736n);assert.equal((call.apaa as Uint8Array[])[7][0],0,'USDC is slot 0 in the Ultraswap loan');
 const add=addCollateralGroup(me,escrow,p,ULTRASWAP_UP_LOAN)[0];
 assert.equal(add.apid,1202382736n);assert.equal((add.apaa as Uint8Array[])[5][0],1,'ALGO is slot 1 in the Ultraswap loan');
 assert.equal((addCollateralGroup(me,escrow,p)[0].apaa as Uint8Array[])[5][0],0,'ALGO is slot 0 in the general loan');
 const create=createLoanGroup(me,escrow,828_500n,p,ULTRASWAP_UP_LOAN);
 assert.ok(Buffer.from(create[2].rekey as Uint8Array).equals(Buffer.from(algosdk.decodeAddress(applicationAddress(1202382736n)).publicKey)),'the escrow is handed to the Ultraswap loan app');
 assert.equal(loanProblem(encodeGroup(bor),me,escrow,1_000_000n,ULTRASWAP_UP_LOAN),undefined);
 assert.equal(loanProblem(encodeGroup(create),me,escrow,828_500n,ULTRASWAP_UP_LOAN),undefined);
 assert.match(loanProblem(encodeGroup(bor),me,escrow,1_000_000n,GENERAL_LOAN)??'',/unexpected app/,'a group for one loan type fails the other type’s check');
 assert.match(loanProblem(encodeGroup(create),me,escrow,828_500n,GENERAL_LOAN)??'',/unexpected|hand itself/,'and the creation is refused too');
 assert.equal(loanKindFor(undefined),GENERAL_LOAN,'escrows from before the switch are general loans');
 assert.equal(loanKindFor('1202382736'),ULTRASWAP_UP_LOAN);
});
