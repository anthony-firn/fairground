import assert from 'node:assert/strict';
import {test} from 'node:test';
import algosdk from 'algosdk';
import {generateSecretKey} from 'nostr-tools/pure';
import {addressKey,applicationAddress,assignGroup,type Txn} from '../src/algotx.ts';
import {walletKeys} from '../src/wallet.ts';
import {MAINNET_GENESIS_HASH} from '../src/rails/algorand.ts';
import {FALGO,FOLKS_LOANS,USDC,assessLoan,bestLiquidation,flashLiquidationGroup,flashLiquidationProblem,flashRepayment,liquidatorShare,
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

function group(){
 const router=addressKey(applicationAddress(3279848327n));
 const head=(fee:bigint):Txn=>({snd:addressKey(me),fee,fv:1000n,lv:1020n,gen:'mainnet-v1.0',gh:params.genesisHash});
 const u64=(n:bigint)=>words([n]);
 const routerTxns:Txn[]=[{...head(3000n),type:'pay',rcv:router,amt:750_000n},
  {...head(14000n),type:'appl',apid:3279848327n,apaa:[Buffer.from('f06714c8','hex'),u64(0n)]},
  {...head(0n),type:'appl',apid:3279848327n,apaa:[Buffer.from('7dde205e','hex'),u64(BigInt(USDC)),u64(54_000n),u64(0n),addressKey(me)]}];
 const args={liquidator:me,escrow,loanApp:FOLKS_LOANS.general,loanAssets:[0,USDC],repay:52_000n,fWithdraw:643_000n,minCollateral:643_000n,budget:8};
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
