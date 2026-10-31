/** Direct payment from Fairground or another Algorand wallet, independent of the card/bank provider. */
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { algorandUsdc } from '@core/rails/algorand.ts';
import { transferProblem, type PaymentRequest, type Transfer } from '@core/rails/rail.ts';
import { formatUsd } from '@core/pricing.ts';
import { useApp } from '../context.ts';
import { balance as shown, nowSeconds, usd } from '../lib/format.ts';
import { useWallet } from '../lib/wallet.ts';
import { FirstDeposit, RampSheet, SettleStatus } from '../screens/Wallet.tsx';
import { CryptoFundingSheet } from './CryptoFunding.tsx';
import { Field, Sheet } from './ui.tsx';

interface Props {
  title: string;
  description?: string;
  request: PaymentRequest;
  onPaid: (transfer: Transfer) => void;
  onClose: () => void;
}

export function PayDialog(props: Props) {
  // Each recipient in a split donation needs fresh completion state, timers and button state.
  return <Payment key={`${props.request.to}:${props.request.memo}:${props.request.amount}`} {...props} />;
}

function Payment({ title, description, request, onPaid, onClose }: Props) {
  const { account, toast } = useApp();
  const wallet = useWallet(account);
  const link = algorandUsdc.paymentLink(request);
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState(false);
  const [external, setExternal] = useState(false);
  const [adding, setAdding] = useState(false);
  const [funding, setFunding] = useState(false);
  const [txid, setTxid] = useState('');
  const [problem, setProblem] = useState('');
  const [since] = useState(nowSeconds);
  const done = useRef(false);
  const paid = useRef(onPaid);
  paid.current = onPaid;
  const finish = (transfer: Transfer) => {
    if (done.current) return;
    done.current = true;
    paid.current(transfer);
  };
  const balance = wallet.state?.usdc ?? 0n;
  const canPay = !!wallet.state?.active && balance >= request.amount && request.to !== wallet.address;
  // Orders/deals have unique notes. Fan support and donation notes are shared, so require a specific transaction
  // for an external payment rather than automatically claiming some other donor's recent transfer.
  const uniqueNote = /^fairground:(order|deal):/.test(request.memo);

  useEffect(() => {
    if (!external) return;
    let stopped = false;
    QRCode.toDataURL(link, { margin: 2, width: 440 }).then((value) => { if (!stopped) setQr(value); }, () => undefined);
    return () => { stopped = true; };
  }, [external, link]);

  useEffect(() => {
    if (!uniqueNote) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const found = await algorandUsdc.listTransfers({ address: request.to, role: 'receiver', notePrefix: request.memo, from: since - 300, to: nowSeconds() + 600 });
        if (stopped) return;
        const match = found.find((t) => !transferProblem(request, t));
        if (match) return finish(match);
      } catch {
        if (!stopped) setProblem('Can’t reach the payment network right now. Try confirming the transaction again shortly.');
      }
      if (!stopped && !done.current) timer = setTimeout(check, 5000);
    };
    timer = setTimeout(check, 4000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [request.to, request.memo, request.amount, since, uniqueNote]);

  async function payNow() {
    setBusy(true);
    try {
      const { payFromWallet } = await import('../lib/walletActions.ts');
      finish(await payFromWallet(account, request));
    } catch (error) {
      toast((error as Error).message);
      setBusy(false);
    }
  }
  async function confirm() {
    setBusy(true);
    setProblem('');
    try {
      const transfer = await algorandUsdc.fetchTransfer(txid.trim().toUpperCase());
      const mismatch = transferProblem(request, transfer, since - 60);
      if (mismatch) setProblem(mismatch);
      else finish(transfer);
    } catch {
      setProblem('Couldn’t find a confirmed USDC transfer on Algorand with that transaction ID. Check the ID and try again after the network confirms it.');
    } finally { setBusy(false); }
  }
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast('Copied'); }
    catch { toast('Select the value and copy it.'); }
  };

  if (funding) return <CryptoFundingSheet onClose={() => setFunding(false)} />;
  if (adding) return <RampSheet side="BUY" initial={formatUsd(request.amount - balance + 1_000_000n)} onClose={() => setAdding(false)} />;
  return (
    <Sheet title={title} onClose={onClose}>
      {description && <p className="muted">{description}</p>}
      <div className="center">
        <div style={{ fontSize: 36, fontWeight: 800 }}>{usd(request.amount)}</div>
        <div className="muted small">USDC on Algorand, straight to their wallet</div>
      </div>
      {!external && canPay && <>
        <button type="button" className="btn primary block" disabled={busy} onClick={payNow}>{busy ? 'Paying…' : `Pay ${usd(request.amount)} from my wallet`}</button>
        <p className="tiny muted center">Wallet balance {shown(balance)}, {shown(balance - request.amount)} after.</p>
      </>}
      <button type="button" className={`btn ${!canPay && !external ? 'primary' : 'ghost'} block`} onClick={() => setExternal(!external)}>
        {external ? 'Use my Fairground wallet' : 'Pay with another Algorand wallet'}
      </button>
      {external ? <>
        <p className="small">Already hold USDC in Pera or another Algorand wallet? Open the payment below on this phone, or scan its QR code with your wallet.</p>
        <a className="btn primary block" href={link}>Open payment in my wallet</a>
        {qr && <img className="qr" src={qr} alt="QR code for this USDC payment on Algorand, including amount and payment note" />}
        <Field label="Recipient address"><input type="text" readOnly value={request.to} className="mono" onFocus={(e) => e.currentTarget.select()} /></Field>
        <button type="button" className="btn small" onClick={() => copy(request.to)}>Copy recipient address</button>
        <div className="row wrap">
          <button type="button" className="btn small" onClick={() => copy(formatUsd(request.amount))}>Copy amount · {formatUsd(request.amount)} USDC</button>
          <button type="button" className="btn small" onClick={() => copy(request.memo)}>Copy payment note</button>
        </div>
        <Field label="Payment note (required)"><input type="text" readOnly value={request.memo} className="mono" onFocus={(e) => e.currentTarget.select()} /></Field>
        <p className="tiny warn">Send native USDC on Algorand and include this payment note exactly. If your exchange cannot include it, fund your Fairground wallet first and pay from here.</p>
        <button type="button" className="btn block" onClick={() => setFunding(true)}>Transfer crypto to Fairground first</button>
        {uniqueNote && <p className="small muted">We’re watching for this payment. You can also confirm it with its transaction ID.</p>}
        <Field label="Transaction ID" hint="After sending, copy the transaction ID from your wallet or exchange to confirm your payment.">
          <input type="text" value={txid} onChange={(e) => setTxid(e.target.value.trim())} autoCapitalize="characters" spellCheck={false} />
        </Field>
        <button type="button" className="btn primary block" disabled={busy || !/^[A-Z2-7]{52}$/i.test(txid)} onClick={confirm}>{busy ? 'Checking payment…' : 'Confirm my payment'}</button>
        {problem && <p className="small warn" role="status">{problem}</p>}
      </> : <>
        {wallet.state?.active && !canPay && request.to !== wallet.address && <div className="card stack">
          <span className="small">Your wallet has {shown(balance)}; this needs {usd(request.amount - balance)} more.</span>
          <button type="button" className="btn primary" onClick={() => setFunding(true)}>Transfer crypto I already own</button>
          <button type="button" className="btn" onClick={() => setAdding(true)}>Add money</button>
        </div>}
        <FirstDeposit compact active={wallet.state?.active} />
        {!wallet.state && <p className="small muted">Checking your Fairground wallet… You can pay with another wallet right away.</p>}
        <SettleStatus />
      </>}
    </Sheet>
  );
}
