/**
 * Capital-free liquidations of Folks Finance V2 general loans (src/fundLiquidations.ts): flash-borrow USDC, repay part
 * of an underwater loan's USDC debt, receive its ALGO collateral at the liquidation bonus, swap it back to USDC and
 * repay the flash loan, all in one atomic group; the profit stays in the fund's wallet (where the trader lends it).
 *
 *   node tools/liquidate-loans.ts [--live] [--every SECONDS]
 *
 * Each candidate is built, checked (flashLiquidationProblem) and simulated on mainnet before anything is signed; a
 * group that loses a race simply fails and costs nothing. Without --live it only reports what it would do. Create
 * ~/.local/share/evolve-bootstrap/treasury/PAUSE to stop. Logs: ~/.local/share/evolve-bootstrap/liquidations/.
 */
import {access,appendFile,mkdir,readFile,lstat,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {DEVELOPMENT_ADDRESS} from '../src/defaults.ts';
import {confirmed,DEFAULT_ALGOD,submit,suggestedParams,walletKeys,walletState,type WalletKeys} from '../src/wallet.ts';
import {decodeTxn,encodeTxn,signTxn,txid,addressKey,type Txn} from '../src/algotx.ts';
import {simulate} from '../src/fundLending.ts';
import {minReceive,prepareSwap,quoteSwap} from '../src/swap.ts';
import {FALGO,FOLKS_ALGO_POOL_APP,FOLKS_LOANS,FOLKS_ORACLE_0,USD,USDC,assessLoan,bestLiquidation,flashLiquidationGroup,flashLiquidationProblem,flashRepayment,
 liquidatorShare,parseLoanLocal,parseLoanTerms,parseOracle,parsePoolIndexes,type KV,type LoanLocal,type PoolTerms} from '../src/fundLiquidations.ts';

const IDX='https://mainnet-idx.4160.nodely.dev',PM=971350278n,LOAN=FOLKS_LOANS.general;
/** Net profit a liquidation must guarantee beyond its network fees, in USD. */
const MIN_PROFIT_USD=0.01;
/** OpUp inner calls: the whole group used 8,448 of 19,600 in simulation; 8 leaves ~1,700 to spare. */
const BUDGET=8;
/** ALGO the wallet keeps above its minimum for the trader's own fees (src/walletConversion.ts BUY_FEE_FLOOR). */
const KEEP_ALGO=100_000n;
const dir=join(homedir(),'.local/share/evolve-bootstrap/liquidations'),treasury=join(homedir(),'.local/share/evolve-bootstrap/treasury');
await mkdir(dir,{recursive:true,mode:0o700});
const UA={'User-Agent':'fund-liquidator/1'};
async function get(url:string):Promise<any>{
 for(let attempt=0;;attempt++){
  const r=await fetch(url,{headers:UA,signal:AbortSignal.timeout(30000)}).catch(()=>null);
  if(r?.ok)return r.json();
  if(attempt>=2)throw Error(`${new URL(url).hostname} failed (${r?.status??'network'})`);
  await new Promise(res=>setTimeout(res,1500*(attempt+1)));
 }
}
const gs=async(app:bigint):Promise<KV[]>=>(await get(`${DEFAULT_ALGOD}/v2/applications/${app}`)).params['global-state'];
const log=(name:string,value:unknown)=>appendFile(join(dir,name),JSON.stringify({at:new Date().toISOString(),...value as object})+'\n',{mode:0o600});
async function ownerKeys():Promise<WalletKeys>{
 const path=join(homedir(),'.config/fairground/anthony-firn.json'),info=await lstat(path);
 if(info.isSymbolicLink()||info.uid!==process.getuid!()||(info.mode&0o077))throw Error('Owner key file permissions are invalid');
 const owner=JSON.parse(await readFile(path,'utf8')) as {nostrKey?:string};
 if(!/^[a-fA-F0-9]{64}$/.test(owner.nostrKey??''))throw Error('Owner key format');
 const secret=Uint8Array.from(Buffer.from(owner.nostrKey!,'hex')),keys=walletKeys(secret);secret.fill(0);
 if(keys.address!==DEVELOPMENT_ADDRESS){keys.seed.fill(0);throw Error('Owner key does not control the fund');}
 return keys;
}

let loans=new Map<string,LoanLocal>(),loansAt=0,terms=new Map<bigint,PoolTerms>(),termsAt=0;
const failedAt=new Map<string,number>();
async function refreshLoans(){
 const next=new Map<string,LoanLocal>();let token:string|undefined;
 do{
  const page=await get(`${IDX}/v2/accounts?application-id=${LOAN}&limit=1000&exclude=assets,created-assets,created-apps${token?`&next=${token}`:''}`);
  for(const a of page.accounts??[]){const st=(a['apps-local-state']??[]).find((x:{id:number})=>BigInt(x.id)===LOAN)?.['key-value'];if(st)next.set(a.address,parseLoanLocal(st));}
  token=page['next-token'];
 }while(token);
 loans=next;loansAt=Date.now();
}

interface Candidate {escrow:string;repay:bigint;f:bigint;fWithdraw:bigint;algoIn:bigint;expectedProfitUsd:number;loanAssets:number[]}
async function tick(live:boolean){
 const now=BigInt(Math.floor(Date.now()/1000));
 if(Date.now()-termsAt>600_000){terms=parseLoanTerms(await gs(LOAN));termsAt=Date.now();}
 if(Date.now()-loansAt>60_000)await refreshLoans();
 const [pools,prices]=await Promise.all([gs(PM).then(s=>parsePoolIndexes(s,now)),gs(FOLKS_ORACLE_0).then(parseOracle)]);
 const algoPrice=prices.get(0n)!.price,dii=pools.get(FOLKS_ALGO_POOL_APP)!.depositIndex,algoTerms=terms.get(FOLKS_ALGO_POOL_APP)!;
 const cands:Candidate[]=[];
 for(const [escrow,local] of loans){
  if((failedAt.get(escrow)??0)>Date.now()-300_000)continue;
  const h=assessLoan(local,terms,pools,prices,now);if(!h.liquidatable)continue;
  const usdcDebt=h.borrows.find(b=>b.asset===BigInt(USDC)),algoCol=h.collateral.find(c=>c.asset===0n);if(!usdcDebt||!algoCol)continue;
  const best=bestLiquidation({...h,borrows:[usdcDebt],collateral:[algoCol]},terms);if(!best||best.repay<=0n)continue;
  // Just under the largest allowed repayment (the contract rounds its maximum down), capped at $1,000 a group.
  const repay=[best.repay*99n/100n,1_000_000_000n].reduce((a,b)=>a<b?a:b);
  const seizedValue=(repay*USD/1_000_000n)*(10_000n+algoTerms.liquidationBonus)/10_000n;
  const f=liquidatorShare(seizedValue*10n**10n/algoPrice*10n**14n/dii,algoTerms.liquidationBonus,algoTerms.liquidationFee);
  const fWithdraw=f*995n/1000n,algoIn=fWithdraw*dii/10n**14n;
  const expectedProfitUsd=Number(algoIn)/1e6*Number(algoPrice)/1e8*0.9945-Number(flashRepayment(repay))/1e6;
  cands.push({escrow,repay,f,fWithdraw,algoIn,expectedProfitUsd,loanAssets:[...new Set([...h.collateral.map(c=>Number(c.asset)),...h.borrows.map(b=>Number(b.asset))])].sort((a,b)=>a-b)});
 }
 cands.sort((a,b)=>b.expectedProfitUsd-a.expectedProfitUsd);
 const feeUsd=0.047*Number(algoPrice)/1e8;
 const worth=cands.filter(c=>c.expectedProfitUsd-feeUsd>=MIN_PROFIT_USD);
 await writeFile(join(dir,'executor-status.json'),JSON.stringify({checkedAt:new Date().toISOString(),live,loans:loans.size,candidates:cands.length,worth:worth.length,
  top:worth.slice(0,5).map(c=>({escrow:c.escrow,repayUsdc:Number(c.repay)/1e6,expectedProfitUsd:Number(c.expectedProfitUsd.toFixed(4))}))},null,1),{mode:0o600});
 const paused=await access(join(treasury,'PAUSE')).then(()=>true,()=>false);
 for(const c of worth.slice(0,2)){
  const me=DEVELOPMENT_ADDRESS!,quote=await quoteSwap(0,USDC,c.algoIn),minOut=minReceive(quote);
  if(minOut<flashRepayment(c.repay)+BigInt(Math.ceil((feeUsd+MIN_PROFIT_USD)*1e6))){failedAt.set(c.escrow,Date.now());continue;}
  const p=await suggestedParams(DEFAULT_ALGOD);
  const args={liquidator:me,escrow:c.escrow,loanApp:LOAN,loanAssets:c.loanAssets,repay:c.repay,fWithdraw:c.fWithdraw,minCollateral:c.fWithdraw,budget:BUDGET};
  const txns=flashLiquidationGroup(args,(await prepareSwap(me,quote)).map(decodeTxn),p);
  const problem=flashLiquidationProblem(txns,args,c.algoIn,minOut);
  if(problem){await log('skipped.jsonl',{escrow:c.escrow,problem});failedAt.set(c.escrow,Date.now());continue;}
  const raw=txns.map(encodeTxn),sim=await simulate([raw],DEFAULT_ALGOD),g=sim['txn-groups']?.[0];
  const profitUsd=Number(minOut-flashRepayment(c.repay))/1e6-feeUsd;
  if(!sim.ok||g?.['failure-message']){await log('skipped.jsonl',{escrow:c.escrow,simulation:String(sim.message??g?.['failure-message']).slice(0,200)});failedAt.set(c.escrow,Date.now());continue;}
  if(paused||!live){console.log(`${paused?'Paused':'Dry run'}: would liquidate ${c.escrow.slice(0,8)}… repaying ${Number(c.repay)/1e6} USDC for ≥$${profitUsd.toFixed(4)} net`);await log('dry-run.jsonl',{escrow:c.escrow,repay:String(c.repay),profitUsd});continue;}
  const state=await walletState(me);
  const fees=txns.reduce((n,t)=>n+(typeof t.fee==='bigint'?t.fee:0n),0n);
  if(state.algo<state.minimum+KEEP_ALGO+fees){console.log('Not enough spare ALGO for liquidation fees');return;}
  const keys=await ownerKeys();
  try{
   const signed=txns.map(t=>signTxn(t,keys.seed)),id=txid(txns[0]);
   await submit(signed,DEFAULT_ALGOD).then(()=>confirmed(id,DEFAULT_ALGOD)).then(async round=>{
    await log('trades.jsonl',{escrow:c.escrow,txid:id,round,repay:String(c.repay),minOut:String(minOut),profitUsdAtLeast:profitUsd});
    console.log(`Liquidated ${c.escrow.slice(0,8)}…: repaid ${Number(c.repay)/1e6} USDC, ≥$${profitUsd.toFixed(4)} net, round ${round} ${id}`);
   }).catch(async error=>{await log('lost.jsonl',{escrow:c.escrow,error:String((error as Error).message).slice(0,200)});failedAt.set(c.escrow,Date.now());});
  }finally{keys.seed.fill(0);}
 }
}

/** The fund must hold fALGO to receive liquidated collateral: a one-time zero-amount opt-in. */
async function ensureOptIn(live:boolean){
 const me=DEVELOPMENT_ADDRESS!,acct=await get(`${DEFAULT_ALGOD}/v2/accounts/${me}`);
 if((acct.assets??[]).some((x:{'asset-id':number})=>x['asset-id']===FALGO))return;
 const state=await walletState(me);
 if(state.algo<state.minimum+100_000n+KEEP_ALGO+1000n){console.log('Waiting for ALGO to opt in to fALGO (adds 0.1 ALGO to the minimum)');return;}
 if(!live){console.log('Dry run: would opt in to fALGO');return;}
 const p=await suggestedParams(DEFAULT_ALGOD),keys=await ownerKeys();
 try{
  const t:Txn={snd:addressKey(me),fee:1000n,fv:p.firstValid,lv:p.firstValid+20n,gen:p.genesisID,gh:p.genesisHash,type:'axfer',arcv:addressKey(me),xaid:BigInt(FALGO)};
  const id=txid(t);await submit([signTxn(t,keys.seed)],DEFAULT_ALGOD);await confirmed(id,DEFAULT_ALGOD);
  await log('trades.jsonl',{kind:'fALGO opt-in',txid:id});console.log('Opted in to fALGO',id);
 }finally{keys.seed.fill(0);}
}

const live=process.argv.includes('--live'),every=Number(process.argv[process.argv.indexOf('--every')+1])||5;
console.log(`Folks liquidator ${live?'LIVE':'dry run'}: USDC debt / ALGO collateral, ≥$${MIN_PROFIT_USD} net, checked every ${every}s`);
for(;;){
 try{await ensureOptIn(live);await tick(live);}catch(error){console.error('Liquidator deferred:',(error as Error).message);}
 await new Promise(r=>setTimeout(r,every*1000));
}
