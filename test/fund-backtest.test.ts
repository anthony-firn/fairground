import assert from 'node:assert/strict';
import {test} from 'node:test';
import {policyLimit} from '../src/fundPolicy.ts';
import {DIP_RULE,FUND_FEE_CAP} from '../src/fundTrader.ts';
import {botStrategy,dip,holdUsdc,irr,kelly,measuredNetworkFee,rng,simulate,FOLKS_GENERAL,FOLKS_ULTRASWAP_UP,LIVE_LOAN,MEASURED_COSTS,MEASURED_MINING,NO_MINING,YEAR_S,
 type Series,type Strategy,type View} from '../src/fundBacktest.ts';

/** A random walk with occasional crashes and recoveries, so dip rules trade. */
function walk(hours:number,seed=1):Series{
 const r=rng(seed),c=new Float64Array(hours),o=new Float64Array(hours),t=new Float64Array(hours);
 let p=0.1;
 for(let k=0;k<hours;k++){
  const shock=r()<0.002?-0.25:0;
  p*=Math.exp((r()-0.5)*0.03+shock+(p<0.06?0.002:0));
  o[k]=k?c[k-1]:p;c[k]=p;t[k]=1.7e9+k*3600;
 }
 return {name:'walk',t,o,c};
}
const probe=(seen:View[],inner:Strategy=holdUsdc):Strategy=>({name:'probe',decide(v){seen.push({...v});return inner.decide(v);}});

test('the fast dip strategy trades exactly like the live bot’s own code',()=>{
 for(const seed of [1,2,3]){
  const s=walk(6000,seed),fast=simulate(s,dip(DIP_RULE)),live=simulate(s,botStrategy());
  assert.ok(live.roundTrips>0,'the fixture must produce trades');
  assert.equal(fast.pieces,live.pieces);assert.equal(fast.roundTrips,live.roundTrips);
  assert.ok(Math.abs(fast.value/live.value-1)<1e-6,`${fast.value} vs ${live.value}`);// the bot floors micro-unit amounts
 }
});

test('what the simulation may sell matches the reviewed reserve policy',()=>{
 const seen:View[]=[];const s=walk(400);
 simulate(s,probe(seen),{mining:{...MEASURED_MINING,nanoPerDay:200,uptime:1}});
 assert.ok(seen.length>300);
 for(const v of seen){
  const real=Number(policyLimit(BigInt(Math.floor(v.algo)),200_000n,FUND_FEE_CAP,true,true));
  assert.ok(Math.abs(v.convertible-real)<=1,`${v.algo}: ${v.convertible} vs ${real}`);
 }
});

test('decisions never see future prices',()=>{
 const a=walk(1500),b=walk(1500);b.c.set(b.c.subarray(1000).map(x=>x*3),1000);b.o.set(b.o.subarray(1001).map(x=>x*3),1001);
 const sa:View[]=[],sb:View[]=[];
 simulate(a,probe(sa,dip({hours:480,drop:0.1})));simulate(b,probe(sb,dip({hours:480,drop:0.1})));
 const upTo=(xs:View[])=>xs.filter(v=>v.i<999).map(v=>[v.i,v.algo,v.usdc,v.inTrade].join());
 assert.deepEqual(upTo(sa),upTo(sb));
});

test('under the app’s 20,000 µALGO limit a large sweep is split into router-sized pieces, at most 12 an hour',()=>{
 const n=40,s:Series={name:'flat',t:Float64Array.from({length:n},(_,k)=>k*3600),o:new Float64Array(n).fill(0.1),c:new Float64Array(n).fill(0.1)};
 const seen:View[]=[];
 const costs={...MEASURED_COSTS,feeCap:20_000};
 const r=simulate(s,probe(seen),{mining:NO_MINING,costs,wallet:{algo:200_520_000,usdc:0,minimum:200_000}});
 const firstHour=seen.filter(v=>v.i===0).length;
 assert.equal(firstHour,12,'twelve checks in the first hour');
 assert.ok(measuredNetworkFee(9)<=costs.feeCap&&measuredNetworkFee(10)>costs.feeCap);
 const fast=simulate(s,holdUsdc,{mining:NO_MINING,wallet:{algo:200_520_000,usdc:0,minimum:200_000}});
 assert.equal(fast.pieces,1,'under the fund’s limit it is one swap');
 assert.ok(r.pieces>=22&&r.pieces<=60,`pieces ${r.pieces}`);
 const end=seen[seen.length-1];assert.ok(end.convertible<1_000_000,'everything above 1 ALGO is eventually sold');
});

test('mined batches arrive at the configured rate and count as money put in',()=>{
 const n=101,s:Series={name:'flat',t:Float64Array.from({length:n},(_,k)=>k*3600),o:new Float64Array(n).fill(0.1),c:new Float64Array(n).fill(0.1)};
 const never:Strategy={name:'never',decide:()=>({kind:'wait'})};
 const r=simulate(s,never,{mining:{nanoPerDay:24,uptime:1,batchNano:5,keep:0.9,nanoUsd:()=>0.3}});
 assert.equal(Math.round((r.contributed-(0.05+0.045692))/(5*0.3*0.9)),20,'one 5 NANO batch every 5 hours');
});

test('IRR and Kelly match hand calculations',()=>{
 assert.ok(Math.abs(irr([[0,100]],YEAR_S,110)-0.10)<1e-6);
 assert.ok(Math.abs(irr([[0,100],[YEAR_S,100]],2*YEAR_S,231)-0.10)<1e-6);
 assert.equal(irr([[0,100]],YEAR_S,0),-1);
 assert.equal(kelly([0.2,-0.1]).fraction,2.5,'p=½, win 20%, lose 10%: f*=p/a−q/b=2.5');
 assert.equal(kelly([-0.1,-0.05]).fraction,0);
});

test('a round trip’s return compares the exit price after costs with the average price paid',()=>{
 const n=1200,c=new Float64Array(n).fill(0.10);c.fill(0.07,700,705);
 const s:Series={name:'dip',t:Float64Array.from({length:n},(_,k)=>k*3600),o:Float64Array.from(c,(x,k)=>k?c[k-1]:x),c};
 const r=simulate(s,dip({hours:480,drop:0.2}),{mining:NO_MINING,wallet:{algo:500_000,usdc:5_000_000,minimum:200_000}});
 assert.equal(r.roundTrips,1);
 const k=1-MEASURED_COSTS.swap,expected=0.10*k*k/0.07-1;// $5: no size impact
 assert.ok(Math.abs(r.tradeReturns[0]-expected)<1e-9,`${r.tradeReturns[0]} vs ${expected}`);
});

test('waiting USDC earns the pool rate after deposit fees, and a buy withdraws it first',()=>{
 const n=8761,flatSeries:Series={name:'flat',t:Float64Array.from({length:n},(_,k)=>k*3600),o:new Float64Array(n).fill(0.1),c:new Float64Array(n).fill(0.1)};
 const lent=simulate(flatSeries,holdUsdc,{mining:NO_MINING,wallet:{algo:600_000,usdc:10_000_000,minimum:200_000}});
 const none=simulate(flatSeries,holdUsdc,{mining:NO_MINING,costs:{...MEASURED_COSTS,lendApy:0},wallet:{algo:600_000,usdc:10_000_000,minimum:200_000}});
 const year=Math.pow(1+MEASURED_COSTS.lendApy/8760,8759)-1;
 assert.ok(Math.abs((lent.value-none.value)-(10*year-MEASURED_COSTS.lendOpFee/1e6*0.1))<1e-6,`${lent.value-none.value}`);
 const c=new Float64Array(1200).fill(0.10);c.fill(0.07,700,705);
 const dipSeries:Series={name:'dip',t:Float64Array.from({length:1200},(_,k)=>k*3600),o:Float64Array.from(c,(x,k)=>k?c[k-1]:x),c};
 const r=simulate(dipSeries,dip({hours:480,drop:0.2}),{mining:NO_MINING,wallet:{algo:600_000,usdc:5_000_000,minimum:200_000}});
 assert.equal(r.roundTrips,1,'the lent USDC was withdrawn and spent on the dip');
});

/** 1,200 hours at $0.10, a drop to `low` for five hours, then `after` for the rest. */
function dipThen(low:number,after:number):Series{
 const c=new Float64Array(1200).fill(0.10);c.fill(low,700,705);c.fill(after,705);
 return {name:'dip',t:Float64Array.from({length:1200},(_,k)=>k*3600),o:Float64Array.from(c,(x,k)=>k?c[k-1]:x),c};
}
const loanWallet={mining:NO_MINING,wallet:{algo:600_000,usdc:5_000_000,minimum:200_000},costs:{...MEASURED_COSTS,lendApy:0}};

test('borrowing multiplies a recovered dip’s gain, net of interest and fees, and is repaid on exit',()=>{
 const s=dipThen(0.07,0.10),plain=simulate(s,dip({hours:480,drop:0.2}),loanWallet);
 const one=simulate(s,dip({hours:480,drop:0.2}),{...loanWallet,loan:{...FOLKS_GENERAL,leverage:1}});
 assert.ok(Math.abs(one.value-plain.value)<1e-9,'leverage 1 is no loan');
 const two=simulate(s,dip({hours:480,drop:0.2}),{...loanWallet,loan:{...FOLKS_ULTRASWAP_UP,leverage:2}});
 assert.equal(two.liquidations,0);assert.ok(two.maxDebtUsd>4.9&&two.maxDebtUsd<5.1,`debt ${two.maxDebtUsd}`);
 const gain1=plain.value-plain.contributed,gain2=two.value-two.contributed;
 assert.ok(gain2>1.95*gain1&&gain2<2.01*gain1,`${gain2} vs ${gain1}`);// fixed swap fees spread over a bigger trade
});

test('a dip that keeps falling liquidates a leveraged position at a penalty',()=>{
 const s=dipThen(0.07,0.045),plain=simulate(s,dip({hours:480,drop:0.2}),loanWallet);
 const lev=simulate(s,dip({hours:480,drop:0.2}),{...loanWallet,loan:{...FOLKS_GENERAL,leverage:2.4}});
 assert.ok(lev.liquidations>0,'liquidated');
 assert.ok(lev.value<plain.value,`${lev.value} vs ${plain.value}`);
 const capped=simulate(s,dip({hours:480,drop:0.2}),{...loanWallet,loan:{...FOLKS_GENERAL,leverage:5}});
 assert.ok(capped.maxDebtUsd<5*1.9,'borrowing is capped by the loan’s entry health');
});

test('the live loan repays part of its debt before a liquidator would, keeping more of a falling position',()=>{
 const s=dipThen(0.07,0.03);
 const raw=simulate(s,dip({hours:480,drop:0.2}),{...loanWallet,loan:{...FOLKS_GENERAL,leverage:2.4,entryHealth:1.05}});
 const live=simulate(s,dip({hours:480,drop:0.2}),{...loanWallet,loan:{...LIVE_LOAN,leverage:2.4,entryHealth:1.05}});
 assert.ok(raw.liquidations>0,'without deleveraging the crash liquidates');
 assert.equal(live.liquidations,0,'deleveraging avoids liquidation');
 assert.ok(live.value>raw.value,`${live.value} vs ${raw.value}`);
});
