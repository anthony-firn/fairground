/**
 * Read-only watcher for Folks Finance V2 loans that can be liquidated (src/fundLiquidations.ts). It signs nothing.
 *
 *   node tools/watch-liquidations.ts [--once] [--every SECONDS]
 *
 * Each scan reads the general loan's terms, the pool indexes, the oracle prices and every loan escrow, then records
 * which loans are liquidatable, the best repay for each and the bonus it would earn. Opportunities are tracked from
 * when they appear until they end (liquidated by someone, or healthy again), to measure how quickly others take them.
 * Output: ~/.local/share/evolve-bootstrap/liquidations/status.json and events.jsonl.
 */
import {appendFile,mkdir,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {FOLKS_LOANS,FOLKS_ORACLE_0,USD,assessLoan,bestLiquidation,parseLoanLocal,parseLoanTerms,parseOracle,parsePoolIndexes,type KV} from '../src/fundLiquidations.ts';

const ALGOD='https://mainnet-api.4160.nodely.dev',IDX='https://mainnet-idx.4160.nodely.dev',PM=971350278n,LOAN=FOLKS_LOANS.general;
const dir=join(homedir(),'.local/share/evolve-bootstrap/liquidations');
await mkdir(dir,{recursive:true,mode:0o700});
const UA={'User-Agent':'fund-liquidation-watch/1'};
async function get(url:string):Promise<any>{
 for(let attempt=0;;attempt++){
  const r=await fetch(url,{headers:UA,signal:AbortSignal.timeout(60000)}).catch(()=>null);
  if(r?.ok)return r.json();
  if(attempt>=3)throw Error(`${new URL(url).hostname} failed (${r?.status??'network'})`);
  await new Promise(res=>setTimeout(res,2000*(attempt+1)));
 }
}
const globalState=async(app:bigint):Promise<KV[]>=>(await get(`${ALGOD}/v2/applications/${app}`)).params['global-state'];
const usd=(v:bigint)=>Number(v)/Number(USD);

interface Open {firstSeen:number;lastSeen:number;bestBonusUsd:number;repayUsd:number;health:number;borrowAsset:string;collateralAsset:string;borrowValue:bigint}
const open=new Map<string,Open>();
let terms=new Map(),termsAt=0;

async function scan(){
 const started=Date.now(),now=BigInt(Math.floor(started/1000));
 if(started-termsAt>600_000){terms=parseLoanTerms(await globalState(LOAN));termsAt=started;}
 const [pools,prices]=await Promise.all([globalState(PM).then(s=>parsePoolIndexes(s,now)),globalState(FOLKS_ORACLE_0).then(parseOracle)]);
 let next:string|undefined,scanned=0,unpriced=0,near=0;
 const seen=new Map<string,{health:number;bonus:number;repay:number;borrow:string;collateral:string;borrowValue:bigint}>();
 do{
  const page=await get(`${IDX}/v2/accounts?application-id=${LOAN}&limit=1000&exclude=assets,created-assets,created-apps${next?`&next=${next}`:''}`);
  for(const a of page.accounts??[]){
   const st=(a['apps-local-state']??[]).find((x:{id:number})=>BigInt(x.id)===LOAN)?.['key-value'] as KV[]|undefined;
   if(!st)continue;
   scanned++;
   const h=assessLoan(parseLoanLocal(st),terms,pools,prices,now);
   if(h.unpriced){unpriced++;continue;}
   if(h.health<1.02&&h.effectiveBorrow>0n)near++;
   if(!h.liquidatable)continue;
   const best=bestLiquidation(h,terms);if(!best)continue;
   seen.set(a.address,{health:h.health,bonus:usd(best.bonusValue),repay:usd(best.repayValue),borrow:String(best.borrowAsset),collateral:String(best.collateralAsset),
    borrowValue:h.borrows.reduce((n,b)=>n+b.value,0n)});
  }
  next=page['next-token'];
 }while(next);
 const t=Date.now();
 for(const [escrow,s] of seen){
  const o=open.get(escrow);
  if(o){o.lastSeen=t;o.bestBonusUsd=Math.max(o.bestBonusUsd,s.bonus);o.health=s.health;o.borrowValue=s.borrowValue;}
  else{open.set(escrow,{firstSeen:t,lastSeen:t,bestBonusUsd:s.bonus,repayUsd:s.repay,health:s.health,borrowAsset:s.borrow,collateralAsset:s.collateral,borrowValue:s.borrowValue});
   await appendFile(join(dir,'events.jsonl'),JSON.stringify({at:new Date(t).toISOString(),event:'liquidatable',escrow,health:s.health,repayUsd:s.repay,bonusUsd:s.bonus,borrowAsset:s.borrow,collateralAsset:s.collateral})+'\n',{mode:0o600});}
 }
 for(const [escrow,o] of open)if(!seen.has(escrow)){
  // Ended: debt reduced means someone liquidated (or repaid); otherwise prices recovered.
  const a=await get(`${ALGOD}/v2/accounts/${escrow}/applications/${LOAN}`).catch(()=>null);
  const st=a?.['app-local-state']?.['key-value'] as KV[]|undefined;
  const h=st?assessLoan(parseLoanLocal(st),terms,pools,prices,now):undefined;
  const borrowNow=h?h.borrows.reduce((n,b)=>n+b.value,0n):0n;
  const ending=!h||borrowNow<o.borrowValue*97n/100n?'debt reduced (liquidated or repaid)':'healthy again';
  await appendFile(join(dir,'events.jsonl'),JSON.stringify({at:new Date(t).toISOString(),event:'ended',escrow,ending,lastedSeconds:Math.round((o.lastSeen-o.firstSeen)/1000),
   seenBetween:`${new Date(o.firstSeen).toISOString()}..${new Date(o.lastSeen).toISOString()}`,bestBonusUsd:o.bestBonusUsd,repayUsd:o.repayUsd})+'\n',{mode:0o600});
  open.delete(escrow);
 }
 const top=[...seen].sort((a,b)=>b[1].bonus-a[1].bonus).slice(0,5).map(([e,s])=>({escrow:e,health:Number(s.health.toFixed(4)),repayUsd:Number(s.repay.toFixed(2)),bonusUsd:Number(s.bonus.toFixed(3)),borrowAsset:s.borrow,collateralAsset:s.collateral}));
 const algoPrice=prices.get(0n)?.price;
 const status={checkedAt:new Date().toISOString(),scanSeconds:(Date.now()-started)/1000,loans:scanned,unpriced,liquidatable:seen.size,nearLiquidation:near,
  totalBonusUsd:Number([...seen.values()].reduce((n,s)=>n+s.bonus,0).toFixed(3)),algoUsd:algoPrice?Number(algoPrice)/1e8:null,top};
 await writeFile(join(dir,'status.json'),JSON.stringify(status,null,1),{mode:0o600});
 console.log(`${status.checkedAt}: ${scanned} loans in ${status.scanSeconds.toFixed(0)}s, ${seen.size} liquidatable (bonus $${status.totalBonusUsd}), ${near} near, ${unpriced} unpriced`);
}

const once=process.argv.includes('--once'),every=Number(process.argv[process.argv.indexOf('--every')+1])||60;
do{
 try{await scan();}catch(error){console.error('Scan failed:',(error as Error).message);if(once)process.exitCode=1;}
 if(!once)await new Promise(r=>setTimeout(r,every*1000));
}while(!once);
