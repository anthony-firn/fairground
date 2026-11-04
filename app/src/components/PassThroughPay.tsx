/**
 * Paying without a balance, by card through Meld or with ALGO from an exchange. The ALGO lands in the payer's own
 * wallet, which pays in USDC and closes, so nothing stays behind and no wallet is set up (see @core/passthrough.ts).
 * The payment is saved before checkout; if this sheet closes, PendingPayment finishes it in the background.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import QRCode from 'qrcode';
import type { PassThrough } from '@core/passthrough.ts';
import type { PaymentRequest, Transfer } from '@core/rails/rail.ts';
import { useApp } from '../context.ts';
import { usd } from '../lib/format.ts';
import { pendingPassThrough, savePassThrough, useWallet, type PendingPassThrough } from '../lib/wallet.ts';
import { Field, Sheet } from './ui.tsx';

const actions = () => import('../lib/walletActions.ts');

// While a payment sheet is open it finishes its own payment, so the background banner steps aside.
let sheets = 0;
const sheetListeners = new Set<() => void>();
const sheetsChanged = (by: number) => { sheets += by; sheetListeners.forEach((l) => l()); };

const matches = (p: PendingPassThrough | null, requests: PaymentRequest[]): p is PendingPassThrough =>
  !!p && p.requests.length === requests.length && p.requests.every((r, i) => r.to === requests[i].to && r.memo === requests[i].memo && r.amount === requests[i].amount.toString());
const totalOf = (p: PendingPassThrough) => p.requests.reduce((n, r) => n + BigInt(r.amount), 0n);
/** ALGO for people to send, rounded up so it's never too little. */
const algo = (micro: bigint) => (Math.ceil(Number(micro) / 10_000) / 100).toFixed(2);

/**
 * Finishes the pending payment as its ALGO arrives: once enough is there, and again whenever more comes. If another tab
 * finishes it first, the payment is found on the chain instead.
 */
function useFinish(pending: PendingPassThrough | null, requests: PaymentRequest[], onPaid: (transfers: Transfer[]) => void) {
  const { account } = useApp();
  const wallet = useWallet(account);
  const [result, setResult] = useState<PassThrough>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const tried = useRef('');
  const paid = useRef(onPaid);
  paid.current = onPaid;
  const finish = async () => {
    setWorking(true);
    setError('');
    try {
      const r = await (await actions()).finishPassThrough(account, requests);
      setResult(r);
      if (r.status === 'paid') paid.current(r.transfers);
    } catch (e) {
      setError((e as Error).message);
    } finally { setWorking(false); }
  };
  const s = wallet.state;
  const had = useRef(false);
  useEffect(() => {
    if (pending) had.current = true;
    else if (had.current && !working && result?.status !== 'paid') {
      had.current = false;
      void finish();
    }
  }, [!!pending]);
  useEffect(() => {
    if (!pending || !s || working) return;
    const ready = s.active ? !!pendingPassThrough(account)?.ownsHolding : s.algo >= BigInt(pending.need);
    const seen = `${s.algo}:${s.usdc}`;
    if (ready && tried.current !== seen) {
      tried.current = seen;
      void finish();
    }
  }, [pending?.created, pending?.need, s?.algo, s?.usdc, s?.active, working]);
  return { wallet, result, working, error, finish };
}

interface Props {
  title: string;
  requests: PaymentRequest[];
  /** Donations: if prices move during checkout, pay what arrived, split the same way. */
  flexible?: boolean;
  /** Pay from Pera or another Algorand wallet holding USDC instead. */
  onOtherWallet?: () => void;
  onPaid: (transfers: Transfer[]) => void;
  onClose: () => void;
}

export function PassThroughPay({ title, requests, flexible, onOtherWallet, onPaid, onClose }: Props) {
  const { account, toast } = useApp();
  // Read from storage each render: the wallet re-renders this whenever the saved payment changes.
  const saved = pendingPassThrough(account);
  const pending = matches(saved, requests) ? saved : null;
  const other = pending ? null : saved;
  const [subdivision, setSubdivision] = useState('');
  const [starting, setStarting] = useState(false);
  const [showAddress, setShowAddress] = useState(false);
  const [qr, setQr] = useState('');
  const done = useRef(false);
  const { wallet, result, working, error, finish } = useFinish(pending, requests, (transfers) => {
    if (done.current) return;
    done.current = true;
    onPaid(transfers);
  });
  const total = requests.reduce((n, r) => n + r.amount, 0n);
  const card = !!wallet.config?.ramp;
  const arrived = wallet.state?.algo ?? 0n;
  const need = pending ? BigInt(pending.need) : 0n;
  const link = `algorand://${wallet.address}?amount=${need}`;

  useEffect(() => {
    sheetsChanged(1);
    return () => sheetsChanged(-1);
  }, []);
  useEffect(() => {
    if (!pending || !(showAddress || pending.via === 'transfer')) return;
    let stopped = false;
    QRCode.toDataURL(link, { margin: 2, width: 360 }).then((value) => { if (!stopped) setQr(value); }, () => undefined);
    return () => { stopped = true; };
  }, [pending?.via, showAddress, link]);

  async function start(via: 'card' | 'transfer') {
    setStarting(true);
    // Open the checkout window in the click, so browsers don't block it; then point it at the session.
    const win = via === 'card' ? window.open('about:blank', '_blank') : null;
    let started: PendingPassThrough | undefined;
    try {
      const a = await actions();
      started = await a.startPassThrough(account, title, requests, via, flexible);
      if (via === 'card') {
        const url = await a.passThroughCheckout(account, `US-${subdivision}`);
        if (win) win.location.href = url;
        else location.href = url;
      }
    } catch (e) {
      win?.close();
      if (started) savePassThrough(account, null);
      toast((e as Error).message);
    } finally { setStarting(false); }
  }
  async function topUp(short: bigint) {
    const win = window.open('about:blank', '_blank');
    try {
      const url = await (await actions()).passThroughCheckout(account, `US-${subdivision}`, short);
      if (win) win.location.href = url;
      else location.href = url;
    } catch (e) {
      win?.close();
      toast((e as Error).message);
    }
  }
  function stop(keep: boolean) {
    savePassThrough(account, null);
    if (keep) toast('It’s your wallet balance now. Fairground sets the wallet up to hold it.');
    onClose();
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(wallet.address); toast('Address copied'); }
    catch { toast('Select the address and copy it.'); }
  };
  const stateField = (
    <Field label="US state" hint="Your two-letter state, for example CA. Availability depends on your location.">
      <input type="text" value={subdivision} maxLength={2} autoComplete="address-level1" onChange={(e) => setSubdivision(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} />
    </Field>
  );
  const address = (
    <div className="card stack" style={{ gap: 6 }}>
      <span className="small">Send at least <strong>{algo(need - arrived > 0n ? need - arrived : 0n)} ALGO</strong> on the <strong>Algorand</strong> network, after your exchange’s fees, to:</span>
      <input type="text" readOnly value={wallet.address} className="mono" aria-label="Your Fairground address" onFocus={(e) => e.currentTarget.select()} />
      <button type="button" className="btn small" onClick={copy}>Copy address</button>
      {qr && <img className="qr" src={qr} alt="QR code to send ALGO to your Fairground address" />}
      <span className="tiny muted">Anything above what the payment needs goes to them with it.</span>
    </div>
  );

  if (other) {
    return (
      <Sheet title={title} onClose={onClose}>
        <p className="small">Your payment “{other.label}” is still waiting for its ALGO. Finish it or cancel it before starting another.</p>
        {arrived === 0n && !other.ownsHolding && <button type="button" className="btn block" onClick={() => { savePassThrough(account, null); onClose(); }}>Cancel that payment</button>}
        <button type="button" className="btn ghost block" onClick={onClose}>Close</button>
      </Sheet>
    );
  }
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="center">
        <div style={{ fontSize: 36, fontWeight: 800 }}>{usd(total)}</div>
        <div className="muted small">{requests.length > 1 ? `${requests.length} payments, made together` : 'Straight to their wallet'}</div>
      </div>
      {!pending ? <>
        <p className="small">No balance needed. You buy just enough ALGO, Fairground turns it into this payment and closes your wallet, so nothing is left behind and there’s no wallet to set up.</p>
        {card && <>
          {stateField}
          <button type="button" className="btn primary block" disabled={starting || subdivision.length !== 2} onClick={() => start('card')}>{starting ? 'Opening checkout…' : 'Pay by card with Meld'}</button>
          <p className="tiny muted">Meld connects you to a payment provider for the card payment and identity check. It shows its fees before you pay. Any cents left over go to them with the payment.</p>
        </>}
        <button type="button" className={`btn ${card ? 'ghost' : 'primary'} block`} disabled={starting} onClick={() => start('transfer')}>Send ALGO from an exchange</button>
        {!card && wallet.config && <p className="tiny muted">Card payments aren’t available yet.</p>}
        {onOtherWallet && <button type="button" className="btn ghost block" disabled={starting} onClick={onOtherWallet}>Pay from another Algorand wallet</button>}
      </> : <>
        {(working || result?.status === 'paid') && <p className="small center"><span className="dot warn" /> Paying…</p>}
        {!working && result?.status === 'short' && <div className="card stack">
          <span className="small">Prices moved while you were checking out: {usd(result.usdc)} of {usd(result.total)} arrived. Add the rest, or keep it as your balance.</span>
          {card && <>{stateField}<button type="button" className="btn primary" disabled={subdivision.length !== 2} onClick={() => topUp(result.total - result.usdc)}>Add {usd(result.total - result.usdc)} by card</button></>}
          <button type="button" className="btn" onClick={() => setShowAddress(true)}>Send more ALGO from an exchange</button>
        </div>}
        {!working && result?.status !== 'short' && result?.status !== 'paid' && <>
          {pending.via === 'card'
            ? <p className="small">Finish in the Meld window. As soon as the ALGO arrives, the payment goes through. Keep this open, or come back later: it finishes when you next open Fairground.</p>
            : address}
          {arrived > 0n && arrived < need && <p className="small">{algo(arrived)} of {algo(need)} ALGO has arrived.</p>}
          {arrived > 0n && arrived < need && flexible && <button type="button" className="btn block" onClick={finish}>Donate what has arrived</button>}
          {pending.via === 'card' && !showAddress && <button type="button" className="btn ghost small" onClick={() => setShowAddress(true)}>Send ALGO from an exchange instead</button>}
        </>}
        {showAddress && pending.via === 'card' && address}
        {error && <p className="small warn">{error} <button type="button" className="btn small" onClick={finish}>Try again</button></p>}
        {!working && (arrived === 0n && !pending.ownsHolding
          ? <button type="button" className="btn ghost block" onClick={() => stop(false)}>Cancel payment</button>
          : result?.status === 'short' || (arrived > 0n && arrived < need)
            ? <button type="button" className="btn ghost block" onClick={() => stop(true)}>Keep it as my balance instead</button>
            : null)}
      </>}
    </Sheet>
  );
}

/** Deposits can't start while a payment without a balance waits for ALGO: whatever arrives goes to that payment. */
export function PaymentWaiting({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <Sheet title="Add money" onClose={onClose}>
      <p className="small">Your payment “{label}” is waiting for ALGO, and anything that arrives in your wallet now goes to it.
        Finish or cancel that payment (the banner at the top) before adding money.</p>
      <button type="button" className="btn block" onClick={onClose}>OK</button>
    </Sheet>
  );
}

/**
 * A payment without a balance that's still in progress, as a banner that finishes it in the background whenever no
 * payment sheet is open (after a reload, or in the tab Meld returns to).
 */
export function PendingPayment() {
  const { account, toast } = useApp();
  const open = useSyncExternalStore((l) => (sheetListeners.add(l), () => sheetListeners.delete(l)), () => sheets);
  const [pending, setPending] = useState(() => pendingPassThrough(account));
  const [sheet, setSheet] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setPending((p) => { const next = pendingPassThrough(account); return JSON.stringify(next) === JSON.stringify(p) ? p : next; }), 2000);
    return () => clearInterval(timer);
  }, [account]);
  if (!pending) return null;
  if (sheet) {
    const requests = pending.requests.map((r) => ({ to: r.to, amount: BigInt(r.amount), memo: r.memo }));
    return <PassThroughPay title={pending.label} requests={requests} flexible={pending.flexible} onPaid={() => (toast(`Paid: ${pending.label}.`), setSheet(false))} onClose={() => setSheet(false)} />;
  }
  if (open) return null;
  return <Banner key={pending.created} pending={pending} onOpen={() => setSheet(true)} />;
}

function Banner({ pending, onOpen }: { pending: PendingPassThrough; onOpen: () => void }) {
  const { toast } = useApp();
  const requests = pending.requests.map((r) => ({ to: r.to, amount: BigInt(r.amount), memo: r.memo }));
  const { result, working, error } = useFinish(pending, requests, () => toast(`Paid: ${pending.label}.`));
  const status = working ? 'paying now' : result?.status === 'short' ? 'needs a little more' : error ? 'needs another try' : 'waiting for your ALGO';
  return (
    <div role="status" className="row between" style={{ padding: '10px 16px', gap: 8 }}>
      <span className="small">{pending.label}: {status} · {usd(totalOf(pending))}</span>
      <button type="button" className="btn small" onClick={onOpen}>Open</button>
    </div>
  );
}
