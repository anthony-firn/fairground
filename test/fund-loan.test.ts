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

import {LEVERAGE,BORROW_HEALTH,loanStep,type LoanView} from '../src/fundTrader.ts';
test('a leveraged trade steps through setup, entry, holding, deleveraging and exit from the loan’s actual state',()=>{
 const idx=125_000_000_000_000n;// 1.25 ALGO per fALGO
 const base:LoanView={inTrade:false,levered:false,hasEscrow:false,collateralAdded:false,walletAlgo:0n,walletUsdc:0n,collateralF:0n,algoIndex:idx,debt:0n,price:0.08,tradeUsdc:0n,setupAffordable:false};
 assert.equal(loanStep(base),undefined,'no setup until it is affordable');
 assert.deepEqual(loanStep({...base,setupAffordable:true}),{step:'create'});
 assert.deepEqual(loanStep({...base,hasEscrow:true,setupAffordable:true}),{step:'addCollateral'});
 const ready={...base,hasEscrow:true,collateralAdded:true};
 assert.equal(loanStep(ready),undefined,'idle with a loan ready');
 // Entry: own 10 USDC bought 125 ALGO; it becomes collateral, then 2.5 USDC (0.25×) is borrowed and spent.
 const bought={...ready,inTrade:true,walletAlgo:125_000_000n,tradeUsdc:10_000_000n};
 assert.deepEqual(loanStep(bought),{step:'depositCollateral',algo:125_000_000n});
 const collateral={...bought,walletAlgo:0n,collateralF:100_000_000n};// 100 fALGO = 125 ALGO = $10
 assert.deepEqual(loanStep(collateral),{step:'borrow',usdc:2_500_000n});
 assert.equal(LEVERAGE,1.25);
 const borrowed={...collateral,levered:true,debt:2_500_000n,walletUsdc:2_500_000n};
 assert.deepEqual(loanStep(borrowed),{step:'leverBuy',usdc:2_500_000n});
 const holding={...borrowed,walletUsdc:0n,walletAlgo:31_000_000n};
 assert.equal(loanStep(holding),undefined,'holding: health 2.6');
 // ALGO falls 60%: health 125×0.032×0.65/2.5 = 1.04, so wallet ALGO is sold to bring health back to 1.6.
 const falling={...holding,price:0.032};
 const keep=BigInt(Math.floor(125*0.032*0.65/1.6*1e6)),cut=2_500_000n-keep;
 const d=loanStep(falling);
 assert.ok(d&&d.step==='sellAlgo'&&Math.abs(Number(d.algo)-Number(cut)/0.032*1.03)<2,`sells enough to repay the cut: ${JSON.stringify(d,(_,x)=>typeof x==='bigint'?String(x):x)}`);
 assert.deepEqual(loanStep({...falling,walletAlgo:0n,walletUsdc:1_000_000n}),{step:'repay',usdc:1_000_000n<cut+cut/50n?1_000_000n:cut+cut/50n});
 // Exit: wallet ALGO sold, then repay with a refunded margin, then release all collateral.
 const sold={...holding,inTrade:false,walletAlgo:0n,walletUsdc:3_000_000n};
 assert.deepEqual(loanStep(sold),{step:'repay',usdc:2_500_000n+2_500n+10n});
 assert.deepEqual(loanStep({...sold,debt:0n,walletUsdc:500_000n}),{step:'releaseCollateral',f:100_000_000n});
 assert.equal(loanStep({...sold,walletUsdc:0n,walletAlgo:5_000_000n}),undefined,'the sweep sells wallet ALGO before repaying');
 const r=loanStep({...sold,walletUsdc:0n});
 assert.ok(r&&r.step==='releaseCollateral'&&r.f<100_000_000n,'only enough collateral to cover the debt while it is owed');
 // Borrowing is capped at health 2.
 const thin={...collateral,collateralF:10_000_000n,tradeUsdc:10_000_000n};// $1 of collateral
 assert.equal(loanStep({...collateral,tradeUsdc:4_999_999n}),undefined,'no borrowing on a trade under $5');
 const capped=loanStep(thin);
 assert.ok(capped&&capped.step==='borrow'&&capped.usdc===BigInt(Math.floor(1*0.65/BORROW_HEALTH*1e6)));
 assert.equal(loanStep(collateral,1),undefined,'leverage 1 never borrows');
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
