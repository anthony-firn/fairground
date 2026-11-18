/** Durable conversion submission: reloads/timeouts resume the same signed group, never a new trade. */
import {base64} from '@scure/base';
import {decodeMsgpack,decodeTxn,encodeTxn,encodeAddressKey,txid,verifyTxnSig,type Txn} from './algotx.ts';
import {conversionProblem,type WalletConversion} from './walletConversion.ts';
import {signSwap,minReceive} from './swap.ts';
import {MAINNET_GENESIS_HASH} from './rails/algorand.ts';
import {confirmed,DEFAULT_ALGOD,submit,walletState,type WalletKeys} from './wallet.ts';

export interface ConversionJournal {
  version: 1; address: string; phase: 'prepared'|'submitted'|'confirmed'|'expired';
  txids: string[]; signed: string[]; createdAt: number; lastValid: string;
  input: string; expected: string; minimum: string; fees: string; reserve: string; round?: number;
}
export interface ConversionStore {
  read(): Promise<ConversionJournal|null>;
  write(value: ConversionJournal): Promise<void>;
}
export interface ConversionNetwork {algod?:string;indexer?:string;fetch?:typeof fetch;now?:()=>number}
const resolve=(n:ConversionNetwork)=>({algod:n.algod??DEFAULT_ALGOD,indexer:n.indexer??'https://mainnet-idx.4160.nodely.dev',fetch:n.fetch??((...a)=>fetch(...a)),now:n.now??Date.now});

async function pending(id:string,algod:string,f:typeof fetch):Promise<Record<string,unknown>|null>{
  const r=await f(`${algod}/v2/transactions/pending/${id}`);
  if(r.status===404)return null;
  if(!r.ok)throw Error('Could not check the existing conversion; no replacement was submitted.');
  return r.json() as Promise<Record<string,unknown>>;
}

function checkedSigned(j:ConversionJournal,address:string):Uint8Array[]{
  if(j.version!==1||j.address!==address||!Array.isArray(j.signed)||j.signed.length<2||j.signed.length>16||j.txids.length!==j.signed.length)throw Error('Invalid saved conversion.');
  const raw:Uint8Array[]=[];
  const signed=j.signed.map((encoded,i)=>{
    if(typeof encoded!=='string'||encoded.length>30000)throw Error('Invalid signed conversion.');
    const bytes=base64.decode(encoded),envelope=decodeMsgpack(bytes) as {txn:Txn;sig:Uint8Array};
    if(!envelope.txn||!(envelope.sig instanceof Uint8Array)||!(envelope.txn.snd instanceof Uint8Array)||encodeAddressKey(envelope.txn.snd)!==address||String(envelope.txn.lv)!==j.lastValid||txid(envelope.txn)!==j.txids[i]||!verifyTxnSig(envelope.txn,envelope.sig,address))throw Error('Saved conversion signature or transaction ID changed.');
    raw.push(encodeTxn(envelope.txn));
    return bytes;
  });
  const reserve=BigInt(j.reserve),fees=BigInt(j.fees),amount=BigInt(j.input),now=Date.now();
  const plan:WalletConversion={address,raw,fees,reserve,expiresAt:now+30000,quote:{from:0,to:31566704,amount,quote:BigInt(j.expected),fees,priceImpact:0,payload:''}};
  const problem=conversionProblem(plan,{address,active:true,algo:amount+fees+reserve,minimum:reserve-300000n,usdc:0n},now);
  if(problem)throw Error('Saved conversion is invalid: '+problem);
  return signed;
}

export async function resumeWalletConversion(address:string,store:ConversionStore,network:ConversionNetwork={}):Promise<ConversionJournal>{
  const n=resolve(network),j=await store.read();if(!j)throw Error('No conversion is waiting.');
  const signed=checkedSigned(j,address);
  if(j.phase==='confirmed'||j.phase==='expired')return j;
  let known=await pending(j.txids[0],n.algod,n.fetch);
  if(!Number(known?.['confirmed-round'])){
    const params=await n.fetch(`${n.algod}/v2/transactions/params`);if(!params.ok)throw Error('Could not read the current network round.');
    const p=await params.json() as Record<string,unknown>;
    if(BigInt(String(p['last-round']))>BigInt(j.lastValid)){
      const r=await n.fetch(`${n.indexer}/v2/transactions/${j.txids[0]}`);
      if(r.ok){
        const body=await r.json() as {transaction?:{id?:string;'genesis-hash'?:string;'confirmed-round'?:number}};
        if(body.transaction?.id!==j.txids[0]||body.transaction['genesis-hash']!==MAINNET_GENESIS_HASH)throw Error('Indexer returned a different conversion transaction.');
        known={'confirmed-round':body.transaction['confirmed-round']};
      }
      else if(r.status===404){
        const h=await n.fetch(`${n.indexer}/health`);if(!h.ok)throw Error('Could not check indexer synchronization.');
        const health=await h.json() as {round?:number};
        if(!Number.isSafeInteger(health.round)||BigInt(health.round!)<BigInt(j.lastValid))throw Error('The indexer has not caught up; keep the pending conversion.');
        j.phase='expired';await store.write(j);return j;
      }
      else throw Error('Could not reconcile the expired conversion; no replacement was submitted.');
    }else{
      if(known?.['pool-error'])throw Error('The existing conversion was rejected. Check its transaction before replacing it.');
      // Re-publishing identical bytes has the same group and transaction IDs.
      const id=await submit(signed,n.algod,n.fetch);if(id!==j.txids[0])throw Error('The node returned a different conversion transaction.');
      j.phase='submitted';await store.write(j);
    }
  }
  const round=Number(known?.['confirmed-round'])||await confirmed(j.txids[0],n.algod,n.fetch);
  if(!Number.isSafeInteger(round)||round<=0)throw Error('Conversion confirmation is unavailable.');
  j.phase='confirmed';j.round=round;await store.write(j);return j;
}

export async function executeWalletConversion(keys:WalletKeys,plan:WalletConversion,store:ConversionStore,network:ConversionNetwork={}):Promise<ConversionJournal>{
  const n=resolve(network),previous=await store.read();
  const ids=plan.raw.map(raw=>txid(decodeTxn(raw)));
  if(previous&&previous.phase!=='expired'){
    if(previous.txids[0]===ids[0])return resumeWalletConversion(keys.address,store,network);
    if(previous.phase!=='confirmed')throw Error('A conversion is already pending. Resume it before making another.');
  }
  const state=await walletState(keys.address,n.algod,n.fetch);
  const problem=conversionProblem(plan,state,n.now());if(problem)throw Error(problem);
  const signed=signSwap(plan.raw,keys.seed);
  const lastValid=String(decodeTxn(plan.raw[0]).lv);
  const journal:ConversionJournal={version:1,address:keys.address,phase:'prepared',txids:ids,signed:signed.map(s=>base64.encode(s)),createdAt:n.now(),lastValid,
    input:String(plan.quote.amount),expected:String(plan.quote.quote),minimum:String(minReceive(plan.quote)),fees:String(plan.fees),reserve:String(plan.reserve)};
  // A storage/quota failure must happen before any signed bytes leave this device.
  await store.write(journal);
  return resumeWalletConversion(keys.address,store,network);
}
