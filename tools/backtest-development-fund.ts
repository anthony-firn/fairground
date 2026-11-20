/**
 * Research for the development fund's trader: refreshes hourly price history, then backtests the live rule and other
 * strategy families with src/fundBacktest.ts.
 *
 *   node tools/backtest-development-fund.ts [--no-fetch] [--paths N] [--leverage]
 *
 * --leverage studies borrowing against the bought ALGO instead of the usual report.
 *
 * Only out-of-sample sections (unseen years, walk-forward, other coins, simulated years) should change the live rule.
 * Prices are cached in ~/.local/share/evolve-bootstrap/backtest/, with a dated JSON report next to them.
 */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {DIP_RULE} from '../src/fundTrader.ts';
import {band,bootstrapSeries,dip,dipInUptrend,holdAlgo,holdUsdc,kelly,rebalance,rng,rsi,simulate,trend,walkForward,
 FOLKS_GENERAL,FOLKS_ULTRASWAP_UP,MEASURED_COSTS,MEASURED_MINING,type LoanTerms,type Mining,type Result,type Series,type SimOptions,type Strategy} from '../src/fundBacktest.ts';

const dir=join(homedir(),'.local/share/evolve-bootstrap/backtest');
await mkdir(dir,{recursive:true,mode:0o700});
const UA={'User-Agent':'fairground-fund-backtest/1'};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function getJson(url:string):Promise<unknown>{
 for(let attempt=0;;attempt++){
  try{const r=await fetch(url,{headers:UA,signal:AbortSignal.timeout(30000)});if(r.ok)return r.json();if(r.status!==429&&r.status<500)throw Error(`HTTP ${r.status}`);}
  catch(error){if(attempt>=4)throw error;}
  await sleep(2000*(attempt+1));
 }
}

/** Hourly candles [t, open, close] from Coinbase, cached and extended incrementally. */
async function hourly(product:string,since:string):Promise<Series>{
 const path=join(dir,`${product}-3600.json`);
 let rows:[number,number,number][]=[];
 try{rows=JSON.parse(await readFile(path,'utf8'));}catch{}
 if(!process.argv.includes('--no-fetch')){
  const now=Math.floor(Date.now()/3600000)*3600;
  let start=rows.length?rows[rows.length-1][0]+3600:Date.parse(since)/1000;
  const got=new Map(rows.map(r=>[r[0],r]));
  while(start<now){
   const end=Math.min(start+299*3600,now);
   const data=await getJson(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=3600&start=${new Date(start*1000).toISOString()}&end=${new Date(end*1000).toISOString()}`) as number[][];
   for(const c of data)if(c[0]<now)got.set(c[0],[c[0],c[3],c[4]]);
   start=end+3600;await sleep(150);
  }
  rows=[...got.values()].sort((a,b)=>a[0]-b[0]);
  await writeFile(path,JSON.stringify(rows),{mode:0o600});
 }
 if(!rows.length)throw Error(`No ${product} prices cached`);
 // Hours without trades carry the last close forward, so index = hour.
 const first=rows[0][0],last=rows[rows.length-1][0],n=(last-first)/3600+1;
 const t=new Float64Array(n),o=new Float64Array(n),c=new Float64Array(n);
 let k=0,prev=rows[0][2];
 for(const [ts,op,cl] of rows){const at=(ts-first)/3600;for(;k<at;k++){t[k]=first+k*3600;o[k]=prev;c[k]=prev;}t[k]=ts;o[k]=op;c[k]=cl;prev=cl;k++;}
 return {name:product.replace('-USD',''),t,o,c};
}
/** NANO's daily USD close (Kraken keeps about two years), for valuing mined batches; earlier days use the first close. */
async function nanoPrices():Promise<(t:number)=>number>{
 const path=join(dir,'NANO-USD-86400.json');
 let days=new Map<number,number>();
 try{days=new Map(JSON.parse(await readFile(path,'utf8')));}catch{}
 if(!process.argv.includes('--no-fetch')){
  const body=await getJson('https://api.kraken.com/0/public/OHLC?pair=NANOUSD&interval=1440') as {result:Record<string,unknown>};
  const rows=Object.entries(body.result).find(([k])=>k!=='last')![1] as unknown[][];
  for(const r of rows)days.set(Math.floor(Number(r[0])/86400),Number(r[4]));
  await writeFile(path,JSON.stringify([...days]),{mode:0o600});
 }
 const sorted=[...days].sort((a,b)=>a[0]-b[0]),firstDay=sorted[0][0],lastDay=sorted[sorted.length-1][0];
 return t=>{const d=Math.min(Math.max(Math.floor(t/86400),firstDay),lastDay);for(let x=d;x>=firstDay;x--){const v=days.get(x);if(v)return v;}return sorted[0][1];};
}

const pct=(x:number)=>(x>=0?'+':'')+(x*100).toFixed(1)+'%';
const usd=(x:number)=>'$'+x.toFixed(2);
const date=(t:number)=>new Date(t*1000).toISOString().slice(0,10);
const report:Record<string,unknown>={generatedAt:new Date().toISOString()};
const line=(r:Result,base?:Result)=>`${r.strategy.padEnd(30)} IRR ${pct(r.irr).padStart(7)}${base?`  edge ${pct(r.irr-base.irr).padStart(7)}`:''}  ${usd(r.value).padStart(8)} of ${usd(r.contributed).padStart(7)}  trips ${String(r.roundTrips).padStart(3)}  in ALGO ${(r.inMarket*100).toFixed(0).padStart(3)}%  worst ${(r.worst*100).toFixed(0)}%`;

const algo=await hourly('ALGO-USD','2019-06-01');
const nanoUsd=await nanoPrices();
const mining:Mining={...MEASURED_MINING,nanoUsd};
const opts:SimOptions={mining};
console.log(`ALGO hourly ${date(algo.t[0])}..${date(algo.t[algo.t.length-1])} (${algo.c.length} h), $${algo.c[0].toFixed(4)} -> $${algo.c[algo.c.length-1].toFixed(4)}\n`);

const families:Record<string,Strategy[]>={
 dip:[72,168,336,480,720,1080].flatMap(h=>[0.08,0.12,0.16,0.2,0.25,0.3].map(d=>dip({hours:h,drop:d}))),
 'dip exits':[{exit:0.95},{exit:1.05},{exit:1.1},{stop:0.2},{stop:0.3},{maxHold:336},{maxHold:720},{exit:1.05,stop:0.3}].map(x=>dip({hours:480,drop:0.2,...x})),
 band:[168,336,480,720].flatMap(h=>[2,2.5,3].map(k=>band(h,k))),
 rsi:[14,48,168].flatMap(n=>[[20,50],[25,55],[30,60]].map(([lo,hi])=>rsi(n,lo,hi))),
 trend:[10,20,50,100,200].map(d=>trend(d*24)),
 'dip in uptrend':[[480,0.1],[480,0.15],[480,0.2],[336,0.15]].map(([h,d])=>dipInUptrend(h,d)),
 rebalance:[0.25,0.5,0.75].flatMap(w=>[0.1,0.2].map(x=>rebalance(w,x))),
};
// The live settings (src/fundTrader.ts: DIP_RULE, FUND_FEE_CAP via MEASURED_COSTS) and the ones they replaced.
const live=dip(DIP_RULE),previous=dip({hours:480,drop:0.2});
const prevOpts:SimOptions={...opts,costs:{...MEASURED_COSTS,feeCap:20_000}};
const nameOf=(s:Strategy,o:SimOptions)=>s===live&&o===opts?'live':s===previous&&o===prevOpts?'previous (Nov 18-20)':s.name;
const coins=await Promise.all(['BTC-USD','ETH-USD','SOL-USD','DOGE-USD'].map(async p=>{
 // Rescaled to ALGO's price level: only returns matter, but the reserve and network fees are counted in coin units.
 const raw=await hourly(p,'2021-06-01'),k=0.1/raw.c[0];return {...raw,o:raw.o.map(x=>x*k),c:raw.c.map(x=>x*k)};}));

// --leverage: would borrowing against the bought ALGO (Folks loans) have grown the fund faster?
if(process.argv.includes('--leverage')){
 const levels:[string,LoanTerms|undefined][]=[['no borrowing',undefined],
  ...[1.25,1.5,2].map(l=>[`general ${l}x`,{...FOLKS_GENERAL,leverage:l}] as [string,LoanTerms]),
  ...[1.5,2,3,4].map(l=>[`ultraswap ${l}x`,{...FOLKS_ULTRASWAP_UP,leverage:l}] as [string,LoanTerms])];
 const out:Record<string,unknown>={};
 const cut=Math.round((Date.parse('2024-11-18')/1000-algo.t[0])/3600),train=2*8760;
 console.log('A. Live rule with borrowing, ALGO 2019-2026 (IRR on money put in):');
 console.log(`   ${'setup'.padEnd(18)} ${'all'.padStart(7)} ${'2019-24'.padStart(7)} ${'2021-26'.padStart(7)}  liquidations  worst  ${'BTC'.padStart(6)} ${'ETH'.padStart(6)} ${'SOL'.padStart(6)} ${'DOGE'.padStart(6)}`);
 for(const [label,loan] of levels){
  const o={...opts,loan},all=simulate(algo,live,o);
  const row={all:all.irr,early:simulate(algo,live,{...o,from:0,to:cut}).irr,late:simulate(algo,live,{...o,from:train}).irr,
   liquidations:all.liquidations,worst:all.worst,coins:coins.map(s=>simulate(s,live,o).irr)};
  out[label]=row;
  console.log(`   ${label.padEnd(18)} ${pct(row.all).padStart(7)} ${pct(row.early).padStart(7)} ${pct(row.late).padStart(7)}  ${String(row.liquidations).padStart(12)}  ${(row.worst*100).toFixed(0).padStart(4)}%  ${row.coins.map(x=>pct(x).padStart(6)).join(' ')}`);
 }
 console.log('\n   by year (IRR): '+levels.map(([l])=>l).join(' / '));
 for(let y=new Date(algo.t[0]*1000).getUTCFullYear();y<=new Date().getUTCFullYear();y++){
  const a=Math.max(0,Math.round((Date.UTC(y,0,1)/1000-algo.t[0])/3600)),b=Math.min(algo.c.length,Math.round((Date.UTC(y+1,0,1)/1000-algo.t[0])/3600));
  if(b-a<24*60)continue;
  console.log(`   ${y}: `+levels.map(([,loan])=>{const r=simulate(algo,live,{...opts,loan,from:a,to:b});return pct(r.irr)+(r.liquidations?'*':'');}).join(' / '));
 }
 console.log('   (* = at least one liquidation that year)');
 console.log('\n   stress, all history: borrowing at 12% and a 10% liquidation penalty');
 for(const [label,loan] of levels.slice(1)){const r=simulate(algo,live,{...opts,loan:{...loan!,borrowApy:0.12,liquidationBonus:0.10}});console.log(`   ${label.padEnd(18)} IRR ${pct(r.irr).padStart(7)}  liquidations ${r.liquidations}`);}
 const paths=Number(process.argv[process.argv.indexOf('--paths')+1])||400;
 console.log(`\nB. ${paths} simulated years (30-day runs of real ALGO history, $124 of mining):`);
 for(const flat of [false,true]){
  const r=rng(11),res=levels.map(()=>[] as {g:number;liq:number}[]);
  for(let p=0;p<paths;p++){
   const s=bootstrapSeries(algo,8760,1100,r,flat);
   levels.forEach(([,loan],j)=>{const x=simulate(s,live,{...opts,loan,from:1100,mining:{...mining,nanoUsd:()=>0.31}});res[j].push({g:x.value/x.contributed,liq:x.liquidations});});
  }
  console.log(`   ${flat?'downtrend removed':'as ALGO actually moved'}:`);
  levels.forEach(([label],j)=>{
   const g=res[j].map(x=>x.g).sort((a,b)=>a-b),med=g[Math.floor(g.length/2)],logg=g.reduce((a,b)=>a+Math.log(Math.max(b,1e-6)),0)/g.length;
   const liq=res[j].filter(x=>x.liq>0).length/paths,half=g.filter(x=>x<0.5).length/paths,dbl=g.filter(x=>x>=2).length/paths,mean=g.reduce((a,b)=>a+b,0)/g.length;
   (out[`${flat?'flat':'real'} ${label}`]={median:med,mean,meanLog:logg,liquidated:liq,loseHalf:half,double:dbl});
   console.log(`     ${label.padEnd(18)} median ${med.toFixed(3)}x  mean ${mean.toFixed(3)}x  mean log growth ${logg>=0?'+':''}${logg.toFixed(3)}  liquidated ${(liq*100).toFixed(1).padStart(5)}%  loses half ${(half*100).toFixed(1)}%  doubles ${(dbl*100).toFixed(1)}%`);
  });
 }
 await writeFile(join(dir,`leverage-${new Date().toISOString().slice(0,10)}.json`),JSON.stringify(out,null,1),{mode:0o600});
 process.exit();
}

// 1. The only truly unseen data: prices since the live settings were adopted, and the bot's own record.
const ADOPTED=Date.parse('2026-11-20T16:00:00Z')/1000,since=Math.round((ADOPTED-algo.t[0])/3600);
console.log(`1. Since the live settings were adopted (${date(ADOPTED)}), on prices nobody had seen:`);
if(algo.c.length-since<48)console.log(`   only ${Math.max(0,algo.c.length-since)} hours so far; this section fills in over the coming weeks.`);
else{
 const o={...opts,from:since},b=simulate(algo,holdUsdc,o);
 for(const [s,x] of [[live,o],[previous,{...prevOpts,from:since}],[holdAlgo,o]] as const)console.log('  '+line({...simulate(algo,s,x),strategy:nameOf(s,s===previous?prevOpts:opts)},b));
}
try{
 const rows=(await readFile(join(homedir(),'.local/share/evolve-bootstrap/treasury/equity.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l) as {t:string;valueUsd:number;inTrade:boolean});
 const trades=(await readFile(join(homedir(),'.local/share/evolve-bootstrap/treasury/trades.jsonl'),'utf8').catch(()=>'')).trim().split('\n').filter(Boolean);
 console.log(`   The bot's own record: ${rows.length} hourly values, ${usd(rows[0].valueUsd)} on ${rows[0].t.slice(0,10)} -> ${usd(rows[rows.length-1].valueUsd)} now; ${trades.length} trades; ${rows[rows.length-1].inTrade?'holding ALGO':'in USDC'}.`);
 report.bot={first:rows[0],last:rows[rows.length-1],trades:trades.length};
}catch{console.log('   (no bot record readable yet)');}

// 2. Year by year, live settings against the previous ones and the two do-nothing choices.
console.log('\n2. By year (IRR): live / previous / hold USDC / hold ALGO');
const years:Record<string,number[]>={};
for(let y=new Date(algo.t[0]*1000).getUTCFullYear();y<=new Date().getUTCFullYear();y++){
 const a=Math.max(0,Math.round((Date.UTC(y,0,1)/1000-algo.t[0])/3600)),b=Math.min(algo.c.length,Math.round((Date.UTC(y+1,0,1)/1000-algo.t[0])/3600));
 if(b-a<24*60)continue;
 const r=[simulate(algo,live,{...opts,from:a,to:b}),simulate(algo,previous,{...prevOpts,from:a,to:b}),simulate(algo,holdUsdc,{...opts,from:a,to:b}),simulate(algo,holdAlgo,{...opts,from:a,to:b})].map(x=>x.irr);
 years[y]=r;console.log(`   ${y}: ${r.map(pct).join(' / ')}`);
}
report.byYear=years;

// 3. In-sample ranking over all history (for orientation only: picking the top row here is overfitting).
console.log('\n3. Best of each family over all history (in-sample, orientation only):');
const all=simulate(algo,holdUsdc,opts);
const inSample:Record<string,string>={};
for(const [f,list] of Object.entries(families)){
 const best=list.map(s=>simulate(algo,s,opts)).sort((a,b)=>b.irr-a.irr)[0];
 inSample[f]=best.strategy;console.log(`  ${f.padEnd(15)} ${line(best,all)}`);
}
report.inSample=inSample;

// 4. Walk-forward: re-pick each family's parameters every 6 months from the previous 2 years, trade the next 6 months.
console.log('\n4. Walk-forward, re-tuned every 6 months on the previous 2 years (out-of-sample):');
const train=2*8760,step=8760/2,oos={...opts,from:train},baseOos=simulate(algo,holdUsdc,oos);
console.log(`   ${date(algo.t[train])}..${date(algo.t[algo.t.length-1])}`);
console.log('  '+line(baseOos));
console.log('  '+line({...simulate(algo,live,oos),strategy:'live (fixed)'},baseOos));
console.log('  '+line({...simulate(algo,previous,{...prevOpts,from:train}),strategy:'previous (fixed)'},baseOos));
const wf:Record<string,unknown>={};
const pools={...families,'all families':Object.values(families).flat()};
for(const [f,list] of Object.entries(pools)){
 const w=walkForward(algo,list,train,step,opts);
 wf[f]={irr:w.result.irr,edge:w.result.irr-baseOos.irr,chosen:w.chosen};
 console.log('  '+line({...w.result,strategy:`re-tuned ${f}`},baseOos));
}
report.walkForward=wf;

// 5. Other coins: the rules were never tuned on these.
console.log('\n5. Other coins, edge over holding USDC (never tuned on these):');
const others:Record<string,unknown>={};
for(const s of coins){
 const base=simulate(s,holdUsdc,opts),rows:[string,number][]=[[ 'live',simulate(s,live,opts).irr],['previous',simulate(s,previous,prevOpts).irr],['trend 100d',simulate(s,trend(2400),opts).irr],['hold coin',simulate(s,holdAlgo,opts).irr]];
 others[s.name]=Object.fromEntries(rows.map(([n,v])=>[n,v-base.irr]));
 console.log(`  ${s.name.padEnd(5)} `+rows.map(([n,v])=>`${n} ${pct(v-base.irr)}`).join(' | '));
}
report.otherCoins=others;

// 6. How much the result depends on the cost and income assumptions.
console.log('\n6. Live rule over all history under other assumptions (edge vs hold USDC under the same assumptions):');
const sens:[string,SimOptions][]=[['measured costs',opts],['swap cost 0.2%',{...opts,costs:{...MEASURED_COSTS,swap:0.002}}],['swap cost 0.8%',{...opts,costs:{...MEASURED_COSTS,swap:0.008}}],
 ['price impact doubled',{...opts,costs:{...MEASURED_COSTS,impact:(u:number)=>2*MEASURED_COSTS.impact(u)}}],['app fee limit (20,000)',prevOpts],
 ['no lending',{...opts,costs:{...MEASURED_COSTS,lendApy:0}}],['lending at 2%',{...opts,costs:{...MEASURED_COSTS,lendApy:0.02}}],['lending at 8%',{...opts,costs:{...MEASURED_COSTS,lendApy:0.08}}],
 ['mining 40% of the time',{mining:{...mining,uptime:0.4}}],['mining 100% of the time',{mining:{...mining,uptime:1}}],['10x the mining income',{mining:{...mining,nanoPerDay:15}}]];
for(const [label,o] of sens){const b=simulate(algo,holdUsdc,o),r=simulate(algo,live,o);console.log(`  ${label.padEnd(26)} IRR ${pct(r.irr).padStart(7)}  edge ${pct(r.irr-b.irr).padStart(7)}  fees ${usd(r.feesUsd)}`);}

// 7. Bet size: would a larger stake per trade (leverage) have grown the fund faster?
const trips=simulate(algo,live,opts).tradeReturns,k=kelly(trips);
const wins=trips.filter(r=>r>0).length;
console.log(`\n7. Live rule's ${trips.length} round trips: ${wins} won, mean ${pct(trips.reduce((a,b)=>a+b,0)/Math.max(1,trips.length))}, worst ${pct(Math.min(...trips))}, best ${pct(Math.max(...trips))}.`);
console.log(`   Growth-optimal stake (Kelly): ${k.fraction}x the USDC on hand per trade${k.fraction>1?' (more than 1x would mean borrowing)':''}.`);
report.kelly={trips,...k};

// 8. Simulated years: 30-day runs of real ALGO hours, as it moved and with its downtrend removed.
const paths=Number(process.argv[process.argv.indexOf('--paths')+1])||600;
console.log(`\n8. ${paths} simulated years from 30-day runs of real ALGO history ($124 of mining in a typical year):`);
const mc:Record<string,unknown>={};
const pick:[string,Strategy,SimOptions][]=[['live',live,opts],['previous',previous,prevOpts],['hold USDC',holdUsdc,opts],['hold ALGO',holdAlgo,opts]];
for(const flat of [false,true]){
 const r=rng(7),out=pick.map(()=>[] as number[]);
 for(let p=0;p<paths;p++){
  const s=bootstrapSeries(algo,8760,1100,r,flat);
  pick.forEach(([,st,o],j)=>{const x=simulate(s,st,{...o,from:1100,mining:{...mining,nanoUsd:()=>0.31}});out[j].push(x.value/x.contributed);});
 }
 console.log(`   ${flat?'downtrend removed':'as ALGO actually moved'}:`);
 pick.forEach(([label],j)=>{
  const g=[...out[j]].sort((a,b)=>a-b),med=g[Math.floor(g.length/2)];
  const beat=out[j].filter((x,p)=>x>out[2][p]+1e-9).length/paths,half=g.filter(x=>x<0.5).length/paths,dbl=g.filter(x=>x>=2).length/paths;
  const logg=g.reduce((a,b)=>a+Math.log(b),0)/g.length;
  mc[`${flat?'flat':'real'} ${label}`]={median:med,beatUsdc:beat,loseHalf:half,double:dbl,meanLog:logg};
  console.log(`     ${label.padEnd(12)} median ${med.toFixed(3)}x put in  beats USDC ${(beat*100).toFixed(0).padStart(3)}%  loses half ${(half*100).toFixed(1)}%  doubles ${(dbl*100).toFixed(1)}%  mean log growth ${logg>=0?'+':''}${logg.toFixed(3)}`);
 });
}
report.simulated=mc;

// 9. Watch list: the live rule's neighbours and add-ons. A change needs to win on new data, not just here.
console.log('\n9. Watch list (edge over USDC that is not lent): 2019-2024 | 2021-2026 | BTC ETH SOL DOGE');
const cut=Math.round((Date.parse('2024-11-18')/1000-algo.t[0])/3600);
const cand:[string,Strategy,SimOptions][]=[['live',live,opts],['previous',previous,prevOpts],['dip 480h 20%',previous,opts],
 ['dip 240h 20%',dip({hours:240,drop:0.2}),opts],['dip 336h 16%',dip({hours:336,drop:0.16}),opts],['dip 336h 25%',dip({hours:336,drop:0.25}),opts],
 ['dip 336h 20% max 14 days',dip({hours:336,drop:0.2,maxHold:336}),opts],['live without lending',live,{...opts,costs:{...MEASURED_COSTS,lendApy:0}}]];
const cands:Record<string,number[]>={};
for(const [label,st,o] of cand){
 const edge=(s:Series,x:SimOptions)=>simulate(s,st,x).irr-simulate(s,holdUsdc,{...x,costs:{...(x.costs??MEASURED_COSTS),lendApy:0}}).irr;
 const row=[edge(algo,{...o,from:0,to:cut}),edge(algo,{...o,from:train}),...coins.map(s=>edge(s,o))];
 cands[label]=row;console.log(`  ${label.padEnd(26)} ${row.map(pct).map(x=>x.padStart(7)).join(' ')}`);
}
report.watchList=cands;
await writeFile(join(dir,`report-${new Date().toISOString().slice(0,10)}.json`),JSON.stringify(report,null,1),{mode:0o600});
console.log(`\nReport: ${join(dir,`report-${new Date().toISOString().slice(0,10)}.json`)}`);
