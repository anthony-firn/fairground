/**
 * Local operator utility: trade the development fund between USDC and ALGO with the dip rule in src/fundTrader.ts,
 * and sweep mined ALGO to USDC while waiting (replacing settle-development-fund.ts, which shares its lock and journal).
 *
 *   node tools/trade-development-fund.ts [--live] [--once]
 *
 * Without --live it only reports what it would do. Create ~/.local/share/evolve-bootstrap/treasury/PAUSE to stop new
 * trades; a trade already signed is still confirmed. status.json, equity.jsonl and trades.jsonl in the same folder
 * record what it sees and does.
 */
import {appendFile,lstat,mkdir,open,readFile,rename,access} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {DEVELOPMENT_ADDRESS} from '../src/defaults.ts';
import {walletKeys,walletState} from '../src/wallet.ts';
import {convertibleOnRequest,prepareWalletBuy,prepareWalletConversion,walletSignerProblem,type WalletConversion} from '../src/walletConversion.ts';
import {executeWalletConversion,resumeWalletConversion,type ConversionJournal,type ConversionStore} from '../src/conversionSession.ts';
import {DIP_RULE,decide,dipSignal,fittingPlan,quotePriceProblem,MIN_BUY_USDC,MIN_SWEEP_ALGO,type Action} from '../src/fundTrader.ts';

const uid=process.getuid?.();if(uid===undefined)throw Error('The local operator utility requires a Unix user ID');
const dir=join(homedir(),'.local/share/evolve-bootstrap/treasury');
await mkdir(dir,{recursive:true,mode:0o700});
const info=await lstat(dir);if(info.isSymbolicLink()||info.uid!==uid||(info.mode&0o077))throw Error('Treasury state directory must be private and owned by this user');
if(process.env.FAIRGROUND_TREASURY_LOCKED!=='1'){
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

interface Trader {version:1; inTrade:boolean; intent?:{kind:'buy'|'exit'|'sweep';at:number}; entryPrice?:number; entryAt?:string; equityHour?:number}
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
 const state=await walletState(DEVELOPMENT_ADDRESS);
 if(!state.active)throw Error('Development wallet must already be opted into native USDC');
 const signer=walletSignerProblem(state);if(signer)throw Error(signer);
 const closes=await hourlyCloses();
 const signal=dipSignal(closes,trader.inTrade);
 const convertible=convertibleOnRequest(state);
 const action:Action=decide(signal.signal,trader.inTrade,state.usdc,convertible,signal.below);
 const paused=await access(join(dir,'PAUSE')).then(()=>true,()=>false);
 const valueUsd=Number(state.usdc)/1e6+Number(state.algo)/1e6*signal.price;
 await write(join(dir,'status.json'),{checkedAt:new Date().toISOString(),live,paused,inTrade:trader.inTrade,entryPrice:trader.entryPrice,
  price:signal.price,average:signal.average,buyBelow:signal.average*(1-DIP_RULE.drop),signal:signal.signal,action,
  algo:String(state.algo),usdc:String(state.usdc),convertibleAlgo:String(convertible),valueUsd:Number(valueUsd.toFixed(6))},);
 const hour=Math.floor(Date.now()/3600000);
 if(trader.equityHour!==hour){
  await log('equity.jsonl',{t:new Date().toISOString(),price:signal.price,average:signal.average,algo:String(state.algo),usdc:String(state.usdc),valueUsd,inTrade:trader.inTrade});
  trader.equityHour=hour;await write(traderPath,trader);
 }
 if(action.kind==='flat'){trader.inTrade=false;delete trader.entryPrice;delete trader.entryAt;await write(traderPath,trader);console.log('Position closed: nothing above the reserve to sell.');return;}
 if(action.kind==='wait')return;
 const what=action.kind==='buy'?`buy ALGO with up to ${Number(action.usdc)/1e6} USDC`:`sell up to ${Number(convertible)/1e6} ALGO (${action.reason})`;
 if(paused){console.log('Paused; would',what);return;}
 if(!live){console.log('Dry run; would',what,`at $${signal.price} (average $${signal.average.toFixed(5)})`);return;}
 const spot=await spotPrice();
 const plan:WalletConversion=action.kind==='buy'
  ?await fittingPlan(amount=>prepareWalletBuy(state,amount),action.usdc,MIN_BUY_USDC)
  :await fittingPlan(amount=>prepareWalletConversion(state,undefined,undefined,undefined,amount),convertible,action.reason==='exit'?1n:MIN_SWEEP_ALGO);
 const gap=quotePriceProblem(plan,spot);if(gap)throw Error(gap);
 const owner=await privateJson(join(homedir(),'.config/fairground/anthony-firn.json')) as {nostrKey?:string};
 if(!/^[a-fA-F0-9]{64}$/.test(owner.nostrKey??''))throw Error('Local owner account has an unsupported key format');
 const secret=Uint8Array.from(Buffer.from(owner.nostrKey!,'hex')),keys=walletKeys(secret);secret.fill(0);
 try{
  if(keys.address!==DEVELOPMENT_ADDRESS)throw Error('Local owner account does not control the configured development wallet');
  trader.intent={kind:action.kind==='buy'?'buy':action.reason,at:Date.now()};await write(traderPath,trader);
  const receipt=await executeWalletConversion(keys,plan,store);
  if(settleIntent(trader,receipt,spot))await write(traderPath,trader);
  await log('trades.jsonl',{at:new Date().toISOString(),kind:action.kind==='buy'?'buy':action.reason,phase:receipt.phase,txid:receipt.txids[0],
   from:plan.quote.from,input:String(plan.quote.amount),expected:String(plan.quote.quote),fees:String(plan.fees),spot,average:signal.average});
  console.log('Trade:',action.kind==='buy'?'buy':action.reason,Number(plan.quote.amount)/1e6,action.kind==='buy'?'USDC':'ALGO',receipt.phase,receipt.txids[0]);
 }finally{keys.seed.fill(0);}
}

const live=process.argv.includes('--live'),once=process.argv.includes('--once');
console.log(`Fund trader ${live?'LIVE':'dry run'}: buy below ${(1-DIP_RULE.drop)*100}% of the ${DIP_RULE.hours}-hour average, sell at the average.`);
do{
 try{await tick(live);}catch(error){console.error('Trader deferred:',(error as Error).message);if(once)process.exitCode=1;}
 if(!once)await new Promise(resolve=>setTimeout(resolve,300000));
}while(!once);
