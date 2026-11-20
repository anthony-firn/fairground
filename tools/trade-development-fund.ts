/**
 * Local operator utility: trade the development fund between USDC and ALGO with the dip rule in src/fundTrader.ts,
 * and sweep mined ALGO to USDC while waiting (replacing settle-development-fund.ts, which shares its lock and journal).
 *
 *   node tools/trade-development-fund.ts [--live] [--once]
 *
 * USDC that is only waiting for a dip is lent in the Folks Finance USDC pool (src/fundLending.ts) and withdrawn when
 * the rule buys. Dip trades borrow LEVERAGE - 1 times their size in USDC against the bought ALGO in a Folks general
 * loan (src/fundLoan.ts), repaid at the exit; the trader repays part itself if the loan's health falls toward liquidation.
 *
 * Without --live it only reports what it would do. Create ~/.local/share/evolve-bootstrap/treasury/PAUSE to stop new
 * trades and lending; a trade already signed is still confirmed. status.json, equity.jsonl and trades.jsonl in the
 * same folder record what it sees and does. --check-lending simulates the next deposit and withdrawal on mainnet
 * without signing.
 */
import {appendFile,lstat,mkdir,open,readFile,rename,access,unlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {DEVELOPMENT_ADDRESS} from '../src/defaults.ts';
import {confirmed,DEFAULT_ALGOD,submit,suggestedParams,walletKeys,walletState,type WalletKeys,type WalletState} from '../src/wallet.ts';
import {decodeTxn,encodeAddressKey,signRaw,txid} from '../src/algotx.ts';
import {ESCROW_FUNDING,FOLKS_ALGO_POOL,FOLKS_GENERAL_LOAN,addCollateralGroup,borrowGroup,borrowIndexAt,createLoanGroup,currentDebt,depositCollateralGroup,depositIndexAt,
 encodeGroup,loanHealth,loanProblem,newEscrow,parseLoanState,reduceCollateralGroup,repayGroup,type Escrow} from '../src/fundLoan.ts';
import {FOLKS_POOL_MANAGER,FOLKS_USDC_POOL,fusdcHolding,fusdcValue,lendingFeeProblem,oneGroupForSimulation,poolRate,prepareLending,simulateGroups,type LendingKind} from '../src/fundLending.ts';
import {convertibleOnRequest,prepareWalletBuy,prepareWalletConversion,walletSignerProblem,type WalletConversion} from '../src/walletConversion.ts';
import {executeWalletConversion,resumeWalletConversion,type ConversionJournal,type ConversionStore} from '../src/conversionSession.ts';
import {DIP_RULE,LEVERAGE,LOAN_SETUP_ALGO,decide,dipSignal,fittingPlan,lendingStep,loanStep,nextMove,quotePriceProblem,FUND_FEE_CAP,MIN_BUY_USDC,MIN_SWEEP_ALGO,type Action,type LoanAction,type Move} from '../src/fundTrader.ts';

const uid=process.getuid?.();if(uid===undefined)throw Error('The local operator utility requires a Unix user ID');
const dir=join(homedir(),'.local/share/evolve-bootstrap/treasury');
await mkdir(dir,{recursive:true,mode:0o700});
const info=await lstat(dir);if(info.isSymbolicLink()||info.uid!==uid||(info.mode&0o077))throw Error('Treasury state directory must be private and owned by this user');
// --check-lending only simulates, so it may run beside the live trader without its lock.
if(process.env.FAIRGROUND_TREASURY_LOCKED!=='1'&&!process.argv.includes('--check-lending')){
 const lock=await open(join(dir,'run.lock'),'a',0o600);await lock.close();
 try{execFileSync('/usr/bin/flock',['-n',join(dir,'run.lock'),process.execPath,fileURLToPath(import.meta.url),...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,FAIRGROUND_TREASURY_LOCKED:'1'}});process.exit(0);}
 catch(error){process.exit((error as {status?:number}).status??1);}
}
async function privateJson(path:string):Promise<unknown>{
 const s=await lstat(path);if(s.isSymbolicLink()||s.uid!==uid||(s.mode&0o077))throw Error('Private wallet/state file permissions are invalid');
 try{return JSON.parse(await readFile(path,'utf8'));}catch{throw Error('Private wallet/state file could not be parsed');}
}
async function write(path:string,value:unknown){
 const temp=path+'.'+randomBytes(8).toString('hex')+'.tmp',f=await open(temp,'wx',0o600);
 try{await f.writeFile(JSON.stringify(value,null,2)+'\n');await f.sync();}finally{await f.close();}
 await rename(temp,path);
}
const log=(path:string,value:unknown)=>appendFile(join(dir,path),JSON.stringify(value)+'\n',{mode:0o600});
const store:ConversionStore={read:async()=>{
 try{return await privateJson(join(dir,'current.json')) as ConversionJournal;}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
},write:async value=>{
 if(value.phase==='confirmed'){
  if(!/^[A-Z2-7]{52}$/.test(value.txids[0]))throw Error('Invalid receipt transaction ID');
  await mkdir(join(dir,'receipts'),{mode:0o700,recursive:true});await write(join(dir,'receipts',value.txids[0]+'.json'),value);
 }
 await write(join(dir,'current.json'),value);
}};

interface Trader {version:1; inTrade:boolean; intent?:{kind:'buy'|'exit'|'sweep';at:number}; entryPrice?:number; entryAt?:string; equityHour?:number;
 /** The Folks loan: its escrow (address only; its key is discarded once the loan app controls it), whether it is set up,
  * whether this trade has borrowed, and the own µUSDC this trade spent. */
 loan?:{escrow?:string;created?:boolean;collateralAdded?:boolean;levered?:boolean;tradeUsdc?:string}}
const traderPath=join(dir,'trader.json');
async function readTrader():Promise<Trader>{
 try{const t=await privateJson(traderPath) as Trader;if(t.version!==1||typeof t.inTrade!=='boolean')throw Error('Invalid trader state');return t;}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {version:1,inTrade:false};throw error;}
}

const UA={'User-Agent':'fairground-fund-trader/1'};
async function getJson(url:string):Promise<unknown>{
 const r=await fetch(url,{headers:UA,redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!r.ok)throw Error(`${new URL(url).hostname} returned HTTP ${r.status}`);
 return r.json();
}
/** Completed hourly ALGO/USD closes, oldest first: Coinbase, or Kraken if Coinbase fails. */
async function hourlyCloses(now=Date.now()):Promise<number[]>{
 const hour=Math.floor(now/3600000)*3600,need=DIP_RULE.hours+1;
 const fromCoinbase=async()=>{
  const byTime=new Map<number,number>();
  for(const back of [520,260]){
   const start=new Date((hour-back*3600)*1000).toISOString(),end=new Date((hour-(back-260)*3600)*1000).toISOString();
   const rows=await getJson(`https://api.exchange.coinbase.com/products/ALGO-USD/candles?granularity=3600&start=${start}&end=${end}`) as number[][];
   if(!Array.isArray(rows))throw Error('Unexpected Coinbase candles');
   for(const r of rows)if(r[0]<hour)byTime.set(r[0],Number(r[4]));
  }
  return [...byTime].sort((a,b)=>a[0]-b[0]);
 };
 const fromKraken=async()=>{
  const body=await getJson('https://api.kraken.com/0/public/OHLC?pair=ALGOUSD&interval=60') as {result?:Record<string,unknown>};
  const rows=Object.entries(body.result??{}).find(([k])=>k!=='last')?.[1] as unknown[][]|undefined;
  if(!Array.isArray(rows))throw Error('Unexpected Kraken candles');
  return rows.map(r=>[Number(r[0]),Number(r[4])] as [number,number]).filter(([t])=>t<hour);
 };
 let series:[number,number][];
 try{series=await fromCoinbase();}catch(error){console.error('Coinbase prices unavailable, using Kraken:',(error as Error).message);series=await fromKraken();}
 if(series.length<need)throw Error(`Only ${series.length} hourly prices`);
 if(series[series.length-1][0]<hour-3*3600)throw Error('Hourly prices are stale');
 return series.slice(-need).map(([,c])=>c);
}
async function spotPrice():Promise<number>{
 try{const t=await getJson('https://api.exchange.coinbase.com/products/ALGO-USD/ticker') as {bid:string;ask:string};return (Number(t.bid)+Number(t.ask))/2;}
 catch{const k=await getJson('https://api.kraken.com/0/public/Ticker?pair=ALGOUSD') as {result:Record<string,{b:string[];a:string[]}>};const v=Object.values(k.result)[0];return (Number(v.b[0])+Number(v.a[0]))/2;}
}

/** A trade signed before a crash or timeout updates the position once its journal confirms. */
function settleIntent(trader:Trader,journal:ConversionJournal|null,price?:number):boolean{
 if(!trader.intent)return false;
 if(journal&&journal.createdAt>=trader.intent.at&&journal.phase==='confirmed'){
  if(trader.intent.kind==='buy'){trader.inTrade=true;trader.entryPrice=price;trader.entryAt=new Date(journal.createdAt).toISOString();}
  if(trader.intent.kind==='exit'){trader.inTrade=false;delete trader.entryPrice;delete trader.entryAt;}
  delete trader.intent;return true;
 }
 if(!journal||journal.phase==='expired'||journal.createdAt<trader.intent.at){delete trader.intent;return true;}
 return false;
}

const lendingPath=join(dir,'lending.json');
/** True while a signed lending group may still confirm; nothing new is signed until it settles. */
async function lendingPending():Promise<boolean>{
 let rec:{txid:string;lastValid:string};
 try{rec=await privateJson(lendingPath) as {txid:string;lastValid:string};}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
 const r=await fetch(`${DEFAULT_ALGOD}/v2/transactions/pending/${rec.txid}`,{signal:AbortSignal.timeout(20000)});
 if(r.ok){const b=await r.json() as Record<string,unknown>;if(Number(b['confirmed-round'])>0||b['pool-error']){await unlink(lendingPath);return false;}return true;}
 if(r.status===404){const p=await suggestedParams(DEFAULT_ALGOD);if(p.firstValid>BigInt(rec.lastValid)){await unlink(lendingPath);return false;}return true;}
 throw Error('Could not check a pending lending transaction');
}
async function lendingOp(kind:LendingKind,state:WalletState,amount:bigint,keys:WalletKeys){
 const plan=prepareLending(kind,state,amount,await suggestedParams(DEFAULT_ALGOD));
 const signed=plan.raw.map(r=>signRaw(r,keys.seed)),id=txid(decodeTxn(plan.raw[0]));
 // Recorded before anything leaves this machine, so a crash never leads to signing a second group blindly.
 await write(lendingPath,{kind,txid:id,lastValid:String(plan.lastValid),at:Date.now()});
 await submit(signed,DEFAULT_ALGOD);const round=await confirmed(id,DEFAULT_ALGOD);
 await unlink(lendingPath);
 await log('trades.jsonl',{at:new Date().toISOString(),kind:`lending ${kind}`,txid:id,amount:String(amount),fees:String(plan.fees),round});
 console.log('Lending:',kind,kind==='optin'?'fUSDC':`${Number(amount)/1e6} ${kind==='deposit'?'USDC':'fUSDC'}`,'confirmed in round',round,id);
}
async function ownerKeys():Promise<WalletKeys>{
 const owner=await privateJson(join(homedir(),'.config/fairground/anthony-firn.json')) as {nostrKey?:string};
 if(!/^[a-fA-F0-9]{64}$/.test(owner.nostrKey??''))throw Error('Local owner account has an unsupported key format');
 const secret=Uint8Array.from(Buffer.from(owner.nostrKey!,'hex')),keys=walletKeys(secret);secret.fill(0);
 if(keys.address!==DEVELOPMENT_ADDRESS){keys.seed.fill(0);throw Error('Local owner account does not control the configured development wallet');}
 return keys;
}

async function readLoan(trader:Trader):Promise<{collateralF:bigint;algoIndex:bigint;debt:bigint;exists:boolean}>{
 const now=Date.now()/1000;
 const pm=await getJson(`${DEFAULT_ALGOD}/v2/applications/${FOLKS_POOL_MANAGER}`) as {params:{'global-state':{key:string;value:{bytes?:string}}[]}};
 const gs=pm.params['global-state'],algoIndex=depositIndexAt(gs,0,FOLKS_ALGO_POOL,now);
 const escrow=trader.loan?.escrow;
 if(!escrow)return {collateralF:0n,algoIndex,debt:0n,exists:false};
 const r=await fetch(`${DEFAULT_ALGOD}/v2/accounts/${escrow}/applications/${FOLKS_GENERAL_LOAN}`,{signal:AbortSignal.timeout(20000)});
 if(r.status===404)return {collateralF:0n,algoIndex,debt:0n,exists:false};
 if(!r.ok)throw Error(`Could not read the loan (HTTP ${r.status})`);
 const local=((await r.json()) as {'app-local-state'?:{'key-value'?:{key:string;value:{bytes?:string}}[]}})['app-local-state']?.['key-value']??[];
 const s=parseLoanState(local);
 return {collateralF:s.collateralF,algoIndex,debt:currentDebt(s,borrowIndexAt(gs,2,FOLKS_USDC_POOL,now)),exists:true};
}

interface Observed {state:WalletState;signal:ReturnType<typeof dipSignal>;fusdc:bigint|null;lent:bigint;lendRate:bigint;rawConvertible:bigint;convertible:bigint;
 action:Action;lend?:LendingKind;lendingBlocked?:string;loan:Awaited<ReturnType<typeof readLoan>>;loanAct?:LoanAction;spot:number}
/** Everything one decision needs, read fresh from the chain. */
async function observe(trader:Trader,closes:number[]):Promise<Observed>{
 const state=await walletState(DEVELOPMENT_ADDRESS!);
 if(!state.active)throw Error('Development wallet must already be opted into native USDC');
 const signer=walletSignerProblem(state);if(signer)throw Error(signer);
 const signal=dipSignal(closes,trader.inTrade);
 const [fusdc,pool,loan,spot]=await Promise.all([fusdcHolding(DEVELOPMENT_ADDRESS!,DEFAULT_ALGOD),poolRate(DEFAULT_ALGOD),readLoan(trader),spotPrice()]);
 if(trader.loan?.escrow&&!trader.loan.created){
  // A creation that was sent but not seen confirmed: the escrow either holds the loan now or never will.
  if(loan.exists)trader.loan.created=true;else delete trader.loan;
  await write(traderPath,trader);
 }
 if(trader.loan?.levered&&!trader.inTrade&&loan.debt===0n&&loan.collateralF===0n){trader.loan.levered=false;delete trader.loan.tradeUsdc;await write(traderPath,trader);}
 const lent=fusdc?fusdcValue(fusdc,pool.index):0n,rawConvertible=convertibleOnRequest(state,FUND_FEE_CAP);
 const setupPending=LEVERAGE>1&&!(trader.loan?.created&&trader.loan.collateralAdded);
 const convertible=setupPending?(rawConvertible>LOAN_SETUP_ALGO?rawConvertible-LOAN_SETUP_ALGO:0n):rawConvertible;
 const action=decide(signal.signal,trader.inTrade,state.usdc+lent,convertible,signal.below);
 let lend=lendingStep(action,trader.inTrade,state.usdc,fusdc);
 if(loan.debt>0n&&lend!=='withdraw')lend=undefined;   // repay before lending again
 const lendingBlocked=lend?lendingFeeProblem(lend,state):undefined;if(lendingBlocked&&lend!=='withdraw')lend=undefined;
 const floor=state.minimum+100_000n;
 const setupAffordable=!trader.loan?.created?state.algo>=floor+ESCROW_FUNDING+10_000n:state.algo>=floor+5_000n;
 const loanAct=loanStep({inTrade:trader.inTrade,levered:!!trader.loan?.levered,hasEscrow:!!trader.loan?.created,collateralAdded:!!trader.loan?.collateralAdded,
  walletAlgo:rawConvertible,walletUsdc:state.usdc,collateralF:loan.collateralF,algoIndex:loan.algoIndex,debt:loan.debt,price:spot,
  tradeUsdc:BigInt(trader.loan?.tradeUsdc??'0'),setupAffordable});
 return {state,signal,fusdc,lent,lendRate:pool.rate,rawConvertible,convertible,action,lend,lendingBlocked,loan,loanAct,spot};
}

type Next=Move;
/** The single most urgent thing to do (src/fundTrader.ts nextMove). */
const plan=(o:Observed,trader:Trader):Next|undefined=>nextMove({inTrade:trader.inTrade,action:o.action,lend:o.lend,loanAct:o.loanAct,walletUsdc:o.state.usdc,convertible:o.convertible});
const describe=(n:Next):string=>n.kind==='swap'?(n.buy!==undefined?`buy ALGO with up to ${Number(n.buy)/1e6} USDC`:`sell up to ${Number(n.sell!.algo)/1e6} ALGO (${n.sell!.reason})`)
 :n.kind==='lending'?`lending ${n.step}`:`loan ${n.act.step} ${JSON.stringify(n.act,(_,v)=>typeof v==='bigint'?String(v):v)}`;

async function swap(n:Extract<Next,{kind:'swap'}>,o:Observed,trader:Trader,keys:WalletKeys){
 const buying=n.buy!==undefined;
 const plan:WalletConversion=buying
  ?await fittingPlan(amount=>prepareWalletBuy(o.state,amount,undefined,undefined,undefined,FUND_FEE_CAP),n.buy!,MIN_BUY_USDC)
  :await fittingPlan(amount=>prepareWalletConversion(o.state,undefined,undefined,undefined,amount,FUND_FEE_CAP),n.sell!.algo,n.sell!.reason==='sweep'?MIN_SWEEP_ALGO:1n);
 const gap=quotePriceProblem(plan,o.spot);if(gap)throw Error(gap);
 const kind=buying?'buy':n.sell!.reason==='delever'?'sweep':n.sell!.reason;
 const entry=buying&&!trader.inTrade,own=buying&&!trader.loan?.levered;
 trader.intent={kind,at:Date.now()};await write(traderPath,trader);
 const receipt=await executeWalletConversion(keys,plan,store);
 settleIntent(trader,receipt,o.spot);
 if(own&&receipt.phase==='confirmed'){trader.loan??={};trader.loan.tradeUsdc=String((entry?0n:BigInt(trader.loan.tradeUsdc??'0'))+plan.quote.amount);}
 await write(traderPath,trader);
 await log('trades.jsonl',{at:new Date().toISOString(),kind:n.sell?.reason==='delever'?'delever sell':kind,phase:receipt.phase,txid:receipt.txids[0],
  from:plan.quote.from,input:String(plan.quote.amount),expected:String(plan.quote.quote),fees:String(plan.fees),spot:o.spot,average:o.signal.average});
 console.log('Trade:',kind,Number(plan.quote.amount)/1e6,buying?'USDC':'ALGO',receipt.phase,receipt.txids[0]);
}

async function loanOp(act:LoanAction,o:Observed,trader:Trader,keys:WalletKeys){
 const p=await suggestedParams(DEFAULT_ALGOD),user=DEVELOPMENT_ADDRESS!;
 let escrow=trader.loan?.escrow,fresh:Escrow|undefined;
 if(act.step==='create'){fresh=newEscrow();escrow=fresh.address;}
 if(!escrow)throw Error('No loan escrow');
 try{
  const [txns,maxPay,amount]=
   act.step==='create'?[createLoanGroup(user,escrow,ESCROW_FUNDING,p),ESCROW_FUNDING,ESCROW_FUNDING]
   :act.step==='addCollateral'?[addCollateralGroup(user,escrow,p),0n,0n]
   :act.step==='depositCollateral'?[depositCollateralGroup(user,escrow,act.algo,p),act.algo,act.algo]
   :act.step==='borrow'?[borrowGroup(user,escrow,act.usdc,p),0n,act.usdc]
   :act.step==='repay'?[repayGroup(user,escrow,act.usdc,p),act.usdc,act.usdc]
   :act.step==='releaseCollateral'?[reduceCollateralGroup(user,escrow,act.f,p),0n,act.f]
   :(()=>{throw Error(`not a loan group: ${act.step}`);})();
  const raw=encodeGroup(txns),problem=loanProblem(raw,user,escrow,maxPay);if(problem)throw Error(`Loan ${act.step} refused before signing: ${problem}`);
  const fees=txns.reduce((n,t)=>n+(typeof t.fee==='bigint'?t.fee:0n),0n);
  if(o.state.algo<o.state.minimum+100_000n+fees+(act.step==='create'?ESCROW_FUNDING:0n)+(act.step==='depositCollateral'?act.algo:0n))throw Error(`Not enough ALGO for loan ${act.step} and its fees`);
  const signed=raw.map((r,i)=>signRaw(r,fresh&&decodeTxn(r).snd instanceof Uint8Array&&encodeAddressKey(decodeTxn(r).snd as Uint8Array)===fresh.address?fresh.seed:keys.seed));
  const id=txid(decodeTxn(raw[0]));
  if(act.step==='create'){trader.loan={escrow,created:false};await write(traderPath,trader);}
  await write(lendingPath,{kind:`loan ${act.step}`,txid:id,lastValid:String(decodeTxn(raw[0]).lv),at:Date.now()});
  await submit(signed,DEFAULT_ALGOD);const round=await confirmed(id,DEFAULT_ALGOD);
  await unlink(lendingPath);
  trader.loan??={};
  if(act.step==='create')trader.loan.created=true;
  if(act.step==='addCollateral')trader.loan.collateralAdded=true;
  if(act.step==='borrow')trader.loan.levered=true;
  await write(traderPath,trader);
  await log('trades.jsonl',{at:new Date().toISOString(),kind:`loan ${act.step}`,txid:id,amount:String(amount),fees:String(fees),round,escrow});
  console.log('Loan:',act.step,String(amount),'confirmed in round',round,id);
 }finally{fresh?.seed.fill(0);}
}

async function tick(live:boolean){
 if(!DEVELOPMENT_ADDRESS)throw Error('No development recipient is configured');
 const trader=await readTrader();
 const pending=await store.read();
 if(pending&&pending.phase!=='confirmed'&&pending.phase!=='expired'){
  if(!live){console.log('A signed trade is pending; run with --live to finish it.');return;}
  const result=await resumeWalletConversion(DEVELOPMENT_ADDRESS,store);console.log('Existing trade:',result.phase,result.txids[0]);
  if(settleIntent(trader,result))await write(traderPath,trader);
  return;
 }
 if(settleIntent(trader,pending))await write(traderPath,trader);
 if(await lendingPending()){console.log('A Folks transaction is still settling.');return;}
 const closes=await hourlyCloses();
 const paused=await access(join(dir,'PAUSE')).then(()=>true,()=>false);
 let keys:WalletKeys|undefined;
 try{
  // Up to six steps a check, each decided on fresh chain state: a leveraged entry or exit is several groups.
  for(let n=0;n<6;n++){
   const o=await observe(trader,closes),next=plan(o,trader);
   if(n===0){
    const collateralAlgo=(o.loan.collateralF*o.loan.algoIndex)/10n**14n;
    const valueUsd=Number(o.state.usdc+o.lent)/1e6+Number(o.state.algo+collateralAlgo)/1e6*o.signal.price-Number(o.loan.debt)/1e6;
    await write(join(dir,'status.json'),{checkedAt:new Date().toISOString(),live,paused,inTrade:trader.inTrade,entryPrice:trader.entryPrice,
     price:o.signal.price,spot:o.spot,average:o.signal.average,buyBelow:o.signal.average*(1-DIP_RULE.drop),signal:o.signal.signal,action:o.action,next:next?describe(next):null,
     lendingStep:o.lend??null,lendingBlocked:o.lendingBlocked??null,algo:String(o.state.algo),usdc:String(o.state.usdc),fusdc:o.fusdc===null?null:String(o.fusdc),lentUsdc:String(o.lent),
     lendRate:Number(o.lendRate)/1e16,convertibleAlgo:String(o.convertible),
     loan:{leverage:LEVERAGE,escrow:trader.loan?.escrow??null,ready:!!(trader.loan?.created&&trader.loan.collateralAdded),levered:!!trader.loan?.levered,
      collateralAlgo:String(collateralAlgo),debtUsdc:String(o.loan.debt),health:o.loan.debt>0n?loanHealth(Number(collateralAlgo)/1e6,o.spot,Number(o.loan.debt)/1e6):null},
     valueUsd:Number(valueUsd.toFixed(6))});
    const hour=Math.floor(Date.now()/3600000);
    if(trader.equityHour!==hour){
     await log('equity.jsonl',{t:new Date().toISOString(),price:o.signal.price,average:o.signal.average,algo:String(o.state.algo),usdc:String(o.state.usdc),lentUsdc:String(o.lent),
      collateralAlgo:String(collateralAlgo),debtUsdc:String(o.loan.debt),valueUsd,inTrade:trader.inTrade});
     trader.equityHour=hour;await write(traderPath,trader);
    }
   }
   if(o.action.kind==='flat'&&!next){trader.inTrade=false;delete trader.entryPrice;delete trader.entryAt;await write(traderPath,trader);console.log('Position closed: nothing above the reserve to sell.');return;}
   if(!next)return;
   if(paused){console.log('Paused; would',describe(next));return;}
   if(!live){console.log('Dry run; would',describe(next),`at $${o.spot} (average $${o.signal.average.toFixed(5)})`);return;}
   keys??=await ownerKeys();
   if(next.kind==='swap')await swap(next,o,trader,keys);
   else if(next.kind==='lending')await lendingOp(next.step,o.state,next.step==='deposit'?o.state.usdc:next.step==='withdraw'?o.fusdc!:0n,keys);
   else await loanOp(next.act,o,trader,keys);
  }
 }finally{keys?.seed.fill(0);}
}

/** Read-only: simulates the next deposit and a withdrawal of everything on current mainnet state. */
async function checkLending(){
 if(!DEVELOPMENT_ADDRESS)throw Error('No development recipient is configured');
 const state=await walletState(DEVELOPMENT_ADDRESS),p=await suggestedParams(DEFAULT_ALGOD);
 const [fusdc,pool]=await Promise.all([fusdcHolding(DEVELOPMENT_ADDRESS,DEFAULT_ALGOD),poolRate(DEFAULT_ALGOD)]);
 console.log(`Folks USDC pool ${(Number(pool.rate)/1e14).toFixed(3)}%/yr; wallet ${Number(state.usdc)/1e6} USDC, ${fusdc===null?'not opted in':`${Number(fusdc)/1e6} fUSDC (${Number(fusdcValue(fusdc,pool.index))/1e6} USDC)`}`);
 const plans=[];let s=state;
 if(fusdc===null){plans.push(prepareLending('optin',s,0n,p));s={...s,minimum:s.minimum+100_000n,algo:s.algo-1000n};}
 const usdc=state.usdc>0n?state.usdc:0n;
 if(usdc>0n){const d=prepareLending('deposit',s,usdc,p);plans.push(d);s={...s,algo:s.algo-d.fees,usdc:0n};}
 const minted=usdc>0n?(usdc*10n**14n)/pool.index-2n:0n,f=(fusdc??0n)+minted;
 if(f>0n)plans.push(prepareLending('withdraw',s,f,p));
 if(!plans.length){console.log('Nothing to simulate: no USDC or fUSDC.');return;}
 const failure=await simulateGroups([oneGroupForSimulation(plans)],DEFAULT_ALGOD);
 console.log(`Simulated ${plans.map(x=>x.kind).join(' + ')}: ${failure??'succeeds'}`);
 if(failure)process.exitCode=1;
}
if(process.argv.includes('--check-lending')){await checkLending();process.exit();}

const live=process.argv.includes('--live'),once=process.argv.includes('--once');
console.log(`Fund trader ${live?'LIVE':'dry run'}: buy below ${(1-DIP_RULE.drop)*100}% of the ${DIP_RULE.hours}-hour average, sell at the average; network fees up to ${FUND_FEE_CAP} µALGO; idle USDC lent on Folks; dip trades at ${LEVERAGE}x with a Folks loan.`);
do{
 try{await tick(live);}catch(error){console.error('Trader deferred:',(error as Error).message);if(once)process.exitCode=1;}
 if(!once)await new Promise(resolve=>setTimeout(resolve,300000));
}while(!once);
