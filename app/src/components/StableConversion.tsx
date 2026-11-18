import {useEffect,useState} from 'react';
import {formatUsd} from '@core/pricing.ts';
import {minReceive} from '@core/swap.ts';
import {convertibleOnRequest,walletReserve,walletSignerProblem,type WalletConversion} from '@core/walletConversion.ts';
import type {WalletState} from '@core/walletkey.ts';
import type {ConversionJournal} from '@core/conversionSession.ts';
import {useApp} from '../context.ts';
import {readConversion} from '../lib/stableConversion.ts';
import {LOCAL_PILOT} from '../lib/pilot.ts';
import {Sheet} from './ui.tsx';

export function StableConversion({state}:{state:WalletState}){
  const {account,toast}=useApp();
  const [journal,setJournal]=useState<ConversionJournal|null>(null),[error,setError]=useState('');
  const [plan,setPlan]=useState<WalletConversion>(),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[now,setNow]=useState(Date.now());
  useEffect(()=>{
    const read=()=>{try{setJournal(readConversion(state.address));}catch(e){setError((e as Error).message);}};
    read();const timer=setInterval(read,2000);window.addEventListener('storage',read);
    return()=>{clearInterval(timer);window.removeEventListener('storage',read);};
  },[state.address]);
  useEffect(()=>{if(!open)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[open]);
  const pending=journal?.phase==='prepared'||journal?.phase==='submitted';
  const signerProblem=walletSignerProblem(state);
  const review=async()=>{
    setOpen(true);setPlan(undefined);setError('');setBusy(true);
    try{const actions=await import('../lib/walletActions.ts');setPlan(await actions.previewStableConversion(account));setNow(Date.now());}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  const confirm=async()=>{
    if(!plan)return;setBusy(true);setError('');
    try{const actions=await import('../lib/walletActions.ts');const result=await actions.confirmStableConversion(account,plan);
      setJournal(result);setOpen(false);toast(result.phase==='confirmed'?'Converted to USDC.':'The quote expired without a confirmed conversion. Get a new quote.');}
    catch(e){let message=(e as Error).message;try{const saved=readConversion(state.address);setJournal(saved);if(saved&&(saved.phase==='prepared'||saved.phase==='submitted'))message='This conversion is saved and may be pending. Close this sheet and use Resume conversion. '+message;}catch{/* Keep the original storage error. */}setError(message);}
    finally{setBusy(false);}
  };
  const resume=async()=>{
    setBusy(true);setError('');
    try{const actions=await import('../lib/walletActions.ts');const result=await actions.resumeStableConversion(account);setJournal(result);toast(result.phase==='confirmed'?'Conversion confirmed.':'The quote expired. You can request a new quote.');}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  return <section className="card stack" aria-label="Assets and wallet security">
    <strong>{formatUsd(state.usdc)} USDC</strong>
    <span className="small">USDC is the USD-pegged token. ALGO is a separate asset with a changing price.</span>
    <span className="small">ALGO balance: {formatUsd(state.algo)} ALGO</span>
    <span className="tiny muted">Kept for account minimums and future network fees: {formatUsd(walletReserve(state))} ALGO. This reserve stays in ALGO.</span>
    <span className="small">Wallet signing: {signerProblem?'external authority required':'Ed25519 (standard signing)'}</span>
    <span className="tiny muted">The built-in signer is not post-quantum. Holding USDC does not upgrade its signing security. <a href="https://www.evolvetech.dev/wallet-setup/#security">Security and recovery</a></span>
    {signerProblem&&<p className="small warn">{signerProblem}</p>}
    {!LOCAL_PILOT&&pending?<button type="button" className="btn" disabled={busy} onClick={resume}>{busy?'Checking conversion…':'Resume conversion'}</button>:
      !LOCAL_PILOT&&state.active&&convertibleOnRequest(state)>0n&&<button type="button" className="btn" disabled={busy||!!signerProblem} onClick={review}>Convert ALGO to USDC</button>}
    {error&&!open&&<p className="small warn" role="alert">{error}</p>}
    {open&&<Sheet title="Convert ALGO to USDC" onClose={()=>setOpen(false)}>
      {busy&&!plan&&<p>Getting a conversion quote…</p>}
      {plan&&<div className="stack">
        <p>Convert {formatUsd(plan.quote.amount)} ALGO into approximately {formatUsd(plan.quote.quote)} USDC.</p>
        <p className="small">Minimum received: {formatUsd(minReceive(plan.quote))} USDC. Maximum slippage: 0.5%.</p>
        <p className="small">Prepared network fees: {formatUsd(plan.fees)} ALGO. Exchange costs are included in the quoted USDC amount.</p>
        <p className="small">At least {formatUsd(plan.reserve)} ALGO stays for account minimums and future fees.</p>
        <p className="tiny muted">{now>=plan.expiresAt?'Quote expired. Get a new quote.':`Quote expires in ${Math.ceil((plan.expiresAt-now)/1000)} seconds.`}</p>
        <button type="button" className="btn primary" disabled={busy||now>=plan.expiresAt||!!pending} onClick={confirm}>{busy?'Confirming conversion…':'Confirm conversion'}</button>
      </div>}
      {error&&<p className="small warn" role="alert">{error}</p>}
      {!busy&&!pending&&<button type="button" className="btn ghost" onClick={review}>Get a new quote</button>}
    </Sheet>}
  </section>;
}
