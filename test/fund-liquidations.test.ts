import assert from 'node:assert/strict';
import {test} from 'node:test';
import algosdk from 'algosdk';
import {generateSecretKey} from 'nostr-tools/pure';
import {addressKey,applicationAddress,assignGroup,type Txn} from '../src/algotx.ts';
import {walletKeys} from '../src/wallet.ts';
import {MAINNET_GENESIS_HASH} from '../src/rails/algorand.ts';
import {FALGO,FOLKS_LOANS,USDC,algoToKeep,assessLoan,blockedAssets,bestLiquidation,flashLiquidationGroup,flashLiquidationProblem,flashRepayment,liquidatorShare,
 parseLoanLocal,parseLoanTerms,parseOracle,parsePoolIndexes,type KV} from '../src/fundLiquidations.ts';

const me=walletKeys(generateSecretKey()).address,escrow=walletKeys(generateSecretKey()).address;
const params={firstValid:1000n,genesisID:'mainnet-v1.0',genesisHash:algosdk.base64ToBytes(MAINNET_GENESIS_HASH)};
const b64=(b:Uint8Array)=>Buffer.from(b).toString('base64');
const put=(buf:Uint8Array,at:number,v:bigint,len:number)=>{for(let i=0;i<len;i++)buf[at+len-1-i]=Number((v>>BigInt(8*i))&0xffn);};
const words=(ns:bigint[])=>{const out=new Uint8Array(8*ns.length);ns.forEach((v,i)=>put(out,8*i,v,8));return out;};

test('flash repayment and the liquidator’s share match what simulation showed on mainnet',()=>{
 assert.equal(flashRepayment(52_000n),52_053n,'0.052 USDC borrowed → 0.052053 repaid (0.1% + 1)');
 // Simulation: 651,568 µfALGO left the escrow; the contract counted the liquidator's part net of 10% of the 8% bonus.
 const net=liquidatorShare(651_568n,800n,1000n);
 assert.ok(net>=646_000n&&net<647_000n,`${net}`);
});

test('a synthetic loan is valued like the SDK and its best liquidation earns the bonus net of the protocol fee',()=>{
 const ALGO_POOL=971368268n,USDC_POOL=971372237n;
 const terms=new Uint8Array(84);
 put(terms,0,ALGO_POOL,8);put(terms,8,0n,8);put(terms,32,6500n,2);put(terms,34,10000n,2);put(terms,36,5000n,2);put(terms,38,800n,2);put(terms,40,1000n,2);
 put(terms,42,USDC_POOL,8);put(terms,50,BigInt(USDC),8);put(terms,74,8000n,2);put(terms,76,10000n,2);put(terms,78,5000n,2);put(terms,80,600n,2);put(terms,82,1000n,2);
 const loanTerms=parseLoanTerms([{key:b64(new Uint8Array([0])),value:{bytes:b64(terms)}}]);
 assert.equal(loanTerms.get(ALGO_POOL)!.collateralFactor,6500n);assert.equal(loanTerms.get(USDC_POOL)!.asset,BigInt(USDC));
 const pm=new Uint8Array(126),now=1_800_000_000n;
 for(const [j,pool] of [[0,ALGO_POOL],[2,USDC_POOL]] as const){const at=j*42;put(pm,at,pool,6);put(pm,at+14,10n**14n,8);put(pm,at+30,10n**14n,8);put(pm,at+38,now,4);}
 const pools=parsePoolIndexes([{key:b64(new Uint8Array([0])),value:{bytes:b64(pm)}}],now);
 const oracle:KV[]=[{key:b64(words([0n])),value:{bytes:b64(words([7_000_000n,now]))}},{key:b64(words([BigInt(USDC)])),value:{bytes:b64(words([100_000_000n,now]))}}];
 const prices=parseOracle(oracle);
 const slots=(at:number,v:bigint)=>{const a=Array(15).fill(0n);a[at]=v;return words(a);};
 const k=(s:string)=>b64(new TextEncoder().encode(s));
 // 100 ALGO collateral at $0.07 ($7, effective $4.55) against $5 of USDC debt: health 0.91.
 const local=parseLoanLocal([{key:k('c'),value:{bytes:b64(slots(0,ALGO_POOL))}},{key:k('cb'),value:{bytes:b64(slots(0,100_000_000n))}},
  {key:k('b'),value:{bytes:b64(slots(2,USDC_POOL))}},{key:k('ba'),value:{bytes:b64(slots(2,5_000_000n))}},{key:k('bb'),value:{bytes:b64(slots(2,5_000_000n))}},
  {key:k('l'),value:{bytes:b64(slots(2,10n**14n))}}]);
 const h=assessLoan(local,loanTerms,pools,prices,now);
 assert.ok(h.liquidatable);assert.ok(Math.abs(h.health-4.55/5)<1e-3,`${h.health}`);
 const best=bestLiquidation(h,loanTerms)!;
 assert.equal(best.borrowAsset,BigInt(USDC));assert.equal(best.collateralAsset,0n);
 assert.ok(Math.abs(Number(best.repayValue)/1e4-2.5)<0.01,'half the debt');
 assert.ok(Math.abs(Number(best.bonusValue)/1e4-2.5*0.08*0.9)<0.01,'8% bonus less the 10% protocol share');
});

function group(optIn=false){
 const router=addressKey(applicationAddress(3279848327n));
 const head=(fee:bigint):Txn=>({snd:addressKey(me),fee,fv:1000n,lv:1020n,gen:'mainnet-v1.0',gh:params.genesisHash});
 const u64=(n:bigint)=>words([n]);
 const routerTxns:Txn[]=[{...head(3000n),type:'pay',rcv:router,amt:750_000n},
  {...head(14000n),type:'appl',apid:3279848327n,apaa:[Buffer.from('f06714c8','hex'),u64(0n)]},
  {...head(0n),type:'appl',apid:3279848327n,apaa:[Buffer.from('7dde205e','hex'),u64(BigInt(USDC)),u64(54_000n),u64(0n),addressKey(me)]}];
 const args={liquidator:me,escrow,loanApp:FOLKS_LOANS.general,loanAssets:[0,USDC],repay:52_000n,fWithdraw:643_000n,minCollateral:643_000n,budget:8,optIn};
 return {args,txns:flashLiquidationGroup(args,routerTxns,params),algoIn:750_000n,minOut:54_000n};
}

test('the flash liquidation check passes our group and refuses anything that leaks value or skips the repayment',()=>{
 const {args,txns,algoIn,minOut}=group();
 assert.equal(txns.length,12);assert.equal(flashLiquidationProblem(txns,args,algoIn,minOut),undefined);
 const tamper=(i:number,f:(t:Txn)=>void)=>{const t=txns.map(x=>structuredClone(x));f(t[i]);assignGroup(t);return t;};// deep: argument arrays are shared
 const other=addressKey(walletKeys(generateSecretKey()).address);
 assert.match(flashLiquidationProblem(tamper(3,t=>{t.arcv=other;}),args,algoIn,minOut)??'',/asset transfer/);
 assert.match(flashLiquidationProblem(tamper(5,t=>{t.aamt=999_999n;}),args,algoIn,minOut)??'',/asset transfer/);
 assert.match(flashLiquidationProblem(tamper(7,t=>{t.rcv=other;}),args,algoIn,minOut)??'',/ALGO payment/);
 assert.match(flashLiquidationProblem(tamper(6,t=>{t.rekey=other;}),args,algoIn,minOut)??'',/hand over/);
 assert.match(flashLiquidationProblem(tamper(4,t=>{t.apid=123n;}),args,algoIn,minOut)??'',/unexpected app/);
 assert.match(flashLiquidationProblem(tamper(0,t=>{(t.apaa as Uint8Array[])[1]=words([99n]);}),args,algoIn,minOut)??'',/flash loan/);
 assert.match(flashLiquidationProblem(txns,args,algoIn,flashRepayment(args.repay)-1n)??'',/would not repay/);
 assert.match(flashLiquidationProblem(txns,args,algoIn,60_000n)??'',/enough USDC/,'the router minimum must be what we checked');
 const t2=txns.map(x=>structuredClone(x));t2[3].note=new Uint8Array([1]);
 assert.match(flashLiquidationProblem(t2,args,algoIn,minOut)??'',/one group/);
 assert.equal(FALGO,971381860);
});

test('the first liquidation carries the fALGO opt-in, and only an exact zero opt-in to the wallet itself is accepted',()=>{
 const {args,txns,algoIn,minOut}=group(true);
 assert.equal(txns.length,13);assert.equal(txns[0].type,'axfer');assert.equal(txns[0].xaid,BigInt(FALGO));
 assert.equal(flashLiquidationProblem(txns,args,algoIn,minOut),undefined);
 const end=Number(BigInt('0x'+Buffer.from((txns[1].apaa as Uint8Array[])[2]).toString('hex')));
 assert.equal(end,txns.length-1,'the flash loan still points at its end');
 const tamper=(f:(t:Txn)=>void)=>{const t=txns.map(x=>structuredClone(x));f(t[0]);assignGroup(t);return t;};
 assert.match(flashLiquidationProblem(tamper(t=>{t.aamt=5n;}),args,algoIn,minOut)??'',/asset transfer/);
 assert.match(flashLiquidationProblem(tamper(t=>{t.xaid=123n;}),args,algoIn,minOut)??'',/asset transfer/);
 assert.match(flashLiquidationProblem(txns,{...args,optIn:false},algoIn,minOut)??'',/asset transfer|flash loan/,'an opt-in that was not asked for is refused');
});

test('liquidation winnings top the fee float up without leaving the swap short of the flash repayment',()=>{
 // 1 ALGO of proceeds quoted at 0.07 USDC, 0.05 USDC to repay: at most ~0.27 ALGO can be kept.
 assert.equal(algoToKeep(1_000_000n,70_000n,50_000n,400_000n,400_000n),0n,'float already full');
 assert.equal(algoToKeep(1_000_000n,70_000n,50_000n,350_000n,400_000n),50_000n,'tops up exactly');
 const k=algoToKeep(1_000_000n,70_000n,50_000n,0n,400_000n);
 assert.ok(k>0n&&k<1_000_000n-714_285n,`${k}`);
 assert.ok((1_000_000n-k)*70_000n/1_000_000n>=50_000n*102n/100n,'the rest still swaps for the repayment with 2% to spare');
 assert.equal(algoToKeep(1_000_000n,50_500n,50_000n,0n,400_000n),0n,'no room when the swap barely covers it');
});

test('loans touching an asset with a zero or stale oracle price are recognised as unliquidatable',()=>{
 const now=1_795_217_348n,prices=new Map([[0n,{price:7_350_336n,updated:now-10n}],[287867876n,{price:0n,updated:now-18_170_000n}],[227855942n,{price:109_577_679n,updated:now-7200n}]]);
 assert.deepEqual(blockedAssets(prices,[0n],now),[]);
 assert.deepEqual(blockedAssets(prices,[0n,287867876n,227855942n,999n],now),[287867876n,227855942n,999n]);
});

test('a group over Algorand’s 16-transaction limit is refused, and a full 16 still encodes',async()=>{
 const {encodeTxn}=await import('../src/algotx.ts');
 const {args,txns,algoIn,minOut}=group(true);
 const pad=(n:number)=>{const t=txns.map(x=>structuredClone(x));const extra=t[8];for(let i=0;i<n;i++)t.splice(8,0,structuredClone(extra));
  (t[1].apaa as Uint8Array[])[2]=words([BigInt(t.length-1)]);assignGroup(t);return t;};
 assert.equal(pad(3).length,16);assert.equal(flashLiquidationProblem(pad(3),args,algoIn,minOut),undefined);
 assert.match(flashLiquidationProblem(pad(4),args,algoIn,minOut)??'',/number of transactions/);
 assert.equal(pad(3).map(encodeTxn).length,16);
});
