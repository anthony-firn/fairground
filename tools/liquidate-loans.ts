/**
 * Capital-free liquidations of Folks Finance V2 loans of every type (src/fundLiquidations.ts ROUTES: USDC or ALGO
 * debt, ALGO, xALGO or USDC collateral): flash-borrow the debt asset, repay part of an underwater loan, receive its
 * collateral at the liquidation bonus, swap it back and repay the flash loan, all in one atomic group; the profit stays
 * in the fund's wallet (where the trader lends it).
 *
 *   node tools/liquidate-loans.ts [--live] [--every SECONDS]
 *
 * It wakes on every new block (or every SECONDS), re-values the cached loans when oracle prices change, and acts on
 * those that guarantee at least $0.01 beyond fees. Every group is checked (flashLiquidationProblem) before signing; in
 * live mode it is sent without simulating first, since a group that fails or loses a race costs nothing. Without --live
 * it simulates and reports what it would do. Create ~/.local/share/evolve-bootstrap/treasury/PAUSE to stop. Logs:
 * ~/.local/share/evolve-bootstrap/liquidations/.
 */
import {access,appendFile,mkdir,readFile,lstat,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {DEVELOPMENT_ADDRESS} from '../src/defaults.ts';
import {confirmed,DEFAULT_ALGOD,submit,suggestedParams,walletKeys,walletState,type WalletKeys} from '../src/wallet.ts';
import {decodeTxn,encodeTxn,signTxn,txid} from '../src/algotx.ts';
import {simulate} from '../src/fundLending.ts';
import {minReceive,prepareSwap,quoteSwap} from '../src/swap.ts';
import {ROUTES,algoToKeep,blockedAssets,FOLKS_LOANS,FOLKS_ORACLE_0,assessLoan,bestLiquidation,flashLiquidationGroup,flashLiquidationProblem,flashRepayment,
 liquidatorShare,parseLoanLocal,parseLoanTerms,parseOracle,parsePoolIndexes,type FlashRoute,type KV,type LoanLocal,type PoolTerms} from '../src/fundLiquidations.ts';

const IDX='https://mainnet-idx.4160.nodely.dev',PM=971350278n;
/** Net profit a liquidation must guarantee beyond its network fees, in USD. */
const MIN_PROFIT_USD=0.01;
/** OpUp inner calls: the whole group used 8,448 of 19,600 in simulation; 8 leaves ~1,700 to spare. */
const BUDGET=8;
/** Spare ALGO (above the minimum) the liquidator tops the wallet back up to from its winnings, for both bots' fees.
 * It stays under the trader's 1 ALGO sweep threshold (MIN_SWEEP_ALGO), so the trader leaves it alone. */
const TARGET_SPARE=400_000n;
/** A group's fees for sizing (about 0.05 ALGO; the opt-in adds 0.001), and the least spare ALGO left after paying them. */
const FEE_ESTIMATE=60_000n,FEE_RESERVE=20_000n;
let lastSaid='';
const say=(m:string)=>{if(m!==lastSaid)console.log(m);lastSaid=m;};
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

const LOAN_APPS=Object.values(FOLKS_LOANS);
interface Loan {app:bigint;local:LoanLocal}
let loans=new Map<string,Loan>(),loansAt=0,termsByApp=new Map<bigint,Map<bigint,PoolTerms>>(),termsAt=0,lastOracle='',lastFull=0;
/** Loans within 25% of liquidation at the last full pass: between full passes (every 5 minutes) only these are re-valued. */
let watch=new Set<string>();
const failedAt=new Map<string,number>();
async function refreshLoans(){
 const next=new Map<string,Loan>();
 for(const app of LOAN_APPS){
  let token:string|undefined;
  do{
   const page=await get(`${IDX}/v2/accounts?application-id=${app}&limit=1000&exclude=assets,created-assets,created-apps${token?`&next=${token}`:''}`);
   for(const a of page.accounts??[]){const st=(a['apps-local-state']??[]).find((x:{id:number})=>BigInt(x.id)===app)?.['key-value'];if(st)next.set(a.address,{app,local:parseLoanLocal(st)});}
   token=page['next-token'];
  }while(token);
 }
 loans=next;loansAt=Date.now();
}
/** USD value of `amount` base units at an oracle price (USD per base unit × 1e14). */
const usd=(amount:bigint,price:bigint)=>Number(amount*price/10n**8n)/1e6;

interface Candidate {escrow:string;app:bigint;route:FlashRoute;repay:bigint;fWithdraw:bigint;colOut:bigint;expectedProfitUsd:number;loanAssets:number[]}
async function tick(live:boolean){
 const now=BigInt(Math.floor(Date.now()/1000));
 if(Date.now()-termsAt>600_000){for(const app of LOAN_APPS)termsByApp.set(app,parseLoanTerms(await gs(app)));termsAt=Date.now();}
 const refreshed=Date.now()-loansAt>300_000;
 if(refreshed)await refreshLoans();
 const [pmState,oracleState]=await Promise.all([gs(PM),gs(FOLKS_ORACLE_0)]);
 // Health only moves when oracle prices change (or, slowly, with interest). Every block with new prices re-values the
 // loans near the line; all loans are re-valued with each cache refresh (every 5 minutes).
 const oracleKey=JSON.stringify(oracleState),full=refreshed||Date.now()-lastFull>300_000;
 if(oracleKey===lastOracle&&!full)return;
 lastOracle=oracleKey;if(full)lastFull=Date.now();
 const nextWatch=new Set<string>();
 const pools=parsePoolIndexes(pmState,now),prices=parseOracle(oracleState),algoPrice=prices.get(0n)!.price;
 const cands:Candidate[]=[];let blocked=0,liquidatable=0;
 for(const [escrow,{app,local}] of loans){
  if(!full&&!watch.has(escrow))continue;
  if((failedAt.get(escrow)??0)>Date.now()-300_000){nextWatch.add(escrow);continue;}
  const terms=termsByApp.get(app);if(!terms)continue;
  let h;try{h=assessLoan(local,terms,pools,prices,now);}catch{continue;}
  if(h.health<1.25)nextWatch.add(escrow);
  if(!h.liquidatable)continue;
  liquidatable++;
  if(blockedAssets(prices,[...h.collateral.map(c=>c.asset),...h.borrows.map(b=>b.asset)],now).length){blocked++;continue;}
  const loanAssets=[...new Set([...h.collateral.map(c=>Number(c.asset)),...h.borrows.map(b=>Number(b.asset))])].sort((a,b)=>a-b);
  for(const route of Object.values(ROUTES)){
   const debt=h.borrows.find(b=>b.asset===BigInt(route.debtAsset)),col=h.collateral.find(c=>c.asset===BigInt(route.colAsset));if(!debt||!col)continue;
   const best=bestLiquidation({...h,borrows:[debt],collateral:[col]},terms);if(!best||best.repay<=0n)continue;
   const ct=terms.get(route.colPool),pd=prices.get(BigInt(route.debtAsset))?.price,pc=prices.get(BigInt(route.colAsset))?.price,dii=pools.get(route.colPool)?.depositIndex;
   if(!ct||!pd||!pc||!dii)continue;
   // Just under the largest allowed repayment (the contract rounds its maximum down), capped at $1,000 a group.
   const cap=1000n*10n**14n/pd,repay=[best.repay*99n/100n,cap].reduce((a,b)=>a<b?a:b);
   const seized4=(repay*pd/10n**10n)*(10_000n+ct.liquidationBonus)/10_000n;
   const f=liquidatorShare((seized4*10n**10n/pc)*10n**14n/dii,ct.liquidationBonus,ct.liquidationFee);
   const fWithdraw=f*995n/1000n,colOut=fWithdraw*dii/10n**14n;
   const expectedProfitUsd=usd(colOut,pc)*0.9945-usd(flashRepayment(repay),pd);
   cands.push({escrow,app,route,repay,fWithdraw,colOut,expectedProfitUsd,loanAssets});
  }
 }
 if(full)watch=nextWatch;
 cands.sort((a,b)=>b.expectedProfitUsd-a.expectedProfitUsd);
 const feeUsd=usd(FEE_ESTIMATE,algoPrice);
 const worth=cands.filter(c=>c.expectedProfitUsd-feeUsd>=MIN_PROFIT_USD);
 const byRoute=Object.fromEntries(Object.values(ROUTES).map(r=>[r.name,cands.filter(c=>c.route===r).length]));
 await writeFile(join(dir,live?'executor-status.json':'executor-status-dry.json'),JSON.stringify({checkedAt:new Date().toISOString(),live,loans:loans.size,watched:watch.size,fullPass:full,liquidatable,candidates:cands.length,candidatesByRoute:byRoute,blockedByStalePrices:blocked,worth:worth.length,
  top:worth.slice(0,5).map(c=>({route:c.route.name,escrow:c.escrow,repay:Number(c.repay)/1e6,expectedProfitUsd:Number(c.expectedProfitUsd.toFixed(4))}))},null,1),{mode:0o600});
 if(!worth.length)return;
 const paused=await access(join(treasury,'PAUSE')).then(()=>true,()=>false);
 const me=DEVELOPMENT_ADDRESS!,acct=await get(`${DEFAULT_ALGOD}/v2/accounts/${me}`);
 const heldAssets=new Set<number>((acct.assets??[]).map((x:{'asset-id':number})=>x['asset-id']));
 const state=await walletState(me),spare=state.algo-state.minimum;
 for(const c of worth.slice(0,2)){
  const r=c.route;
  if(r.debtAsset&&!heldAssets.has(r.debtAsset))continue;  // the flash loan pays the debt asset to this wallet
  // A route's first liquidation also opts the wallet in to its fAsset (and xALGO): 0.1 ALGO more minimum each, paid only when it earns.
  const optIns=[r.colFAsset,...(r.colAsset?[r.colAsset]:[])].filter(a=>!heldAssets.has(a)),mbr=100_000n*BigInt(optIns.length);
  // The flash loan, liquidation, withdrawal, repayment and opt-ins take 10 + opt-ins transactions: the swap gets the rest of 16.
  const need=flashRepayment(c.repay),routerMax=16-(10+optIns.length);
  let swapIn=c.colOut,quote=await quoteSwap(r.colAsset,r.debtAsset,swapIn,undefined,undefined,routerMax),minOut=minReceive(quote);
  if(minOut<need){failedAt.set(c.escrow,Date.now());continue;}
  if(r.colAsset===0){
   // ALGO collateral: keep enough to top the fee float back up and swap the rest (re-quoted: it must still cover the repayment).
   const keep=algoToKeep(c.colOut,minOut,need,spare-mbr-FEE_ESTIMATE,TARGET_SPARE);
   if(keep>0n){const q=await quoteSwap(0,r.debtAsset,c.colOut-keep,undefined,undefined,routerMax),m=minReceive(q);if(m>=need){swapIn=c.colOut-keep;quote=q;minOut=m;}}
  }
  const p=await suggestedParams(DEFAULT_ALGOD);
  const args={liquidator:me,escrow:c.escrow,loanApp:c.app,loanAssets:c.loanAssets,repay:c.repay,fWithdraw:c.fWithdraw,minCollateral:c.fWithdraw,budget:BUDGET,route:r,optIns};
  const txns=flashLiquidationGroup(args,(await prepareSwap(me,quote)).map(decodeTxn),p);
  const fees=txns.reduce((n,t)=>n+(typeof t.fee==='bigint'?t.fee:0n),0n),kept=r.colAsset===0?c.colOut-swapIn:0n;
  const pd=prices.get(BigInt(r.debtAsset))!.price;
  const profitUsd=usd(minOut-need,pd)+usd(kept,algoPrice)-usd(fees,algoPrice);
  if(profitUsd<MIN_PROFIT_USD){failedAt.set(c.escrow,Date.now());continue;}
  const problem=flashLiquidationProblem(txns,args,swapIn,minOut);
  if(problem){await log('skipped.jsonl',{escrow:c.escrow,route:r.name,problem});failedAt.set(c.escrow,Date.now());continue;}
  const summary=`${r.name}, loan ${c.escrow.slice(0,8)}…: repay ${Number(c.repay)/1e6}, ≥$${profitUsd.toFixed(4)} net${kept?` (keeps ${Number(kept)/1e6} ALGO)`:''}${optIns.length?` with ${optIns.length} opt-in${optIns.length>1?'s':''}`:''}`;
  if(paused||!live){
   const sim=await simulate([txns.map(encodeTxn)],DEFAULT_ALGOD),g=sim['txn-groups']?.[0];
   const verdict=!sim.ok||g?.['failure-message']?`simulation fails: ${String(sim.message??g?.['failure-message']).slice(0,120)}`:'simulation succeeds';
   say(`${paused?'Paused':'Dry run'}: would liquidate ${summary}; ${verdict}`);
   await log('dry-run.jsonl',{escrow:c.escrow,route:r.name,repay:String(c.repay),kept:String(kept),profitUsd,verdict});continue;
  }
  if(spare<mbr+fees+FEE_RESERVE){say(`Not enough spare ALGO for a liquidation: ${Number(spare)/1e6} spare, needs ${Number(mbr+fees+FEE_RESERVE)/1e6}`);return;}
  // Live: no simulation first (it costs a second, and a failed group pays nothing); the check above bounds every transfer.
  const keys=await ownerKeys();
  try{
   const signed=txns.map(t=>signTxn(t,keys.seed)),id=txid(txns[0]);
   const round=await submit(signed,DEFAULT_ALGOD).then(()=>confirmed(id,DEFAULT_ALGOD)).catch(async error=>{
    await log('lost.jsonl',{escrow:c.escrow,route:r.name,error:String((error as Error).message).slice(0,200)});failedAt.set(c.escrow,Date.now());return undefined;});
   if(round===undefined)continue;
   await log('trades.jsonl',{escrow:c.escrow,route:r.name,txid:id,round,repay:String(c.repay),keptAlgo:String(kept),minOut:String(minOut),fees:String(fees),optIns,profitUsdAtLeast:profitUsd});
   console.log(`Liquidated ${summary}, round ${round} ${id}`);
   return; // balances and opt-ins changed: the next block starts fresh
  }finally{keys.seed.fill(0);}
 }
}

const live=process.argv.includes('--live'),every=Number(process.argv[process.argv.indexOf('--every')+1])||0;
console.log(`Folks liquidator ${live?'LIVE':'dry run'}: ${Object.values(ROUTES).map(r=>r.name).join('; ')}, across ${LOAN_APPS.length} loan types, ≥$${MIN_PROFIT_USD} net, ${every?`every ${every}s`:'every block'}`);
let round=0n;
for(;;){
 if(every)await new Promise(r=>setTimeout(r,every*1000));
 else{
  // Wake on each new block (~2.8 s), when fresh oracle prices can first be acted on.
  try{
   if(!round)round=BigInt((await get(`${DEFAULT_ALGOD}/v2/status`))['last-round']);
   round=BigInt((await get(`${DEFAULT_ALGOD}/v2/status/wait-for-block-after/${round}`))['last-round']);
  }catch{round=0n;await new Promise(r=>setTimeout(r,3000));}
 }
 try{await tick(live);}catch(error){console.error('Liquidator deferred:',(error as Error).message);}
}
