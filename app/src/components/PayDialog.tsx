/**
 * Paying someone directly. With the built-in wallet it's one tap, signed on this device; with another wallet, that
 * wallet opens with the payment filled in (or scans the QR code). Either way the app watches the public chain for the
 * transfer carrying this payment's memo. No funds pass through Fairground.
 */
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { algorandUsdc } from '@core/rails/algorand.ts';
import type { PaymentRequest, Transfer } from '@core/rails/rail.ts';
import { formatUsd } from '@core/pricing.ts';
import { useApp } from '../context.ts';
import { nowSeconds, usd } from '../lib/format.ts';
import { useWallet } from '../lib/wallet.ts';
import { RampSheet, StartWallet } from '../screens/Wallet.tsx';
import { Sheet } from './ui.tsx';

interface Props {
  title: string;
  description?: string;
  request: PaymentRequest;
  onPaid: (transfer: Transfer) => void;
  onClose: () => void;
}

export function PayDialog({ title, description, request, onPaid, onClose }: Props) {
  const { account, toast } = useApp();
  const wallet = useWallet(account);
  const link = algorandUsdc.paymentLink(request);
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState(false);
  const [external, setExternal] = useState(false);
  const [adding, setAdding] = useState(false);
  const balance = wallet.state?.usdc ?? 0n;
  // Paying here and the chain watcher can both see the payment; finish once.
  const done = useRef(false);
  const finish = (t: Transfer) => {
    if (done.current) return;
    done.current = true;
    onPaid(t);
  };
  const canPay = !!wallet.state?.active && balance >= request.amount && request.to !== wallet.address;

  async function payNow() {
    setBusy(true);
    try {
      const { payFromWallet } = await import('../lib/walletActions.ts');
      finish(await payFromWallet(account, request));
    } catch (e) {
      toast((e as Error).message);
      setBusy(false);
    }
  }
  const [since] = useState(nowSeconds);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    QRCode.toDataURL(link, { margin: 1, width: 440 }).then(setQr, () => setQr(''));
  }, [link]);

  useEffect(() => {
    let stopped = false;
    const check = async () => {
      try {
        const found = await algorandUsdc.listTransfers({
          address: request.to, role: 'receiver', notePrefix: request.memo, from: since - 300, to: nowSeconds() + 600,
        });
        const match = found.find((t) => t.note === request.memo && t.amount >= request.amount);
        if (match && !stopped) return finish(match);
        setProblem('');
      } catch {
        setProblem('Can’t reach the payment network right now; still trying.');
      }
      if (!stopped) setTimeout(check, 5000);
    };
    const first = setTimeout(check, 4000);
    return () => {
      stopped = true;
      clearTimeout(first);
    };
  }, [request, since, onPaid]);

  return (
    <Sheet title={title} onClose={onClose}>
      {description && <p className="muted">{description}</p>}
      <div className="center">
        <div style={{ fontSize: 36, fontWeight: 800 }}>{usd(request.amount)}</div>
        <div className="muted small">USDC on Algorand, straight to their wallet</div>
      </div>
      {canPay && (
        <>
          <button type="button" className="btn primary block" disabled={busy} onClick={payNow}>{busy ? 'Paying…' : `Pay ${usd(request.amount)} from my wallet`}</button>
          <p className="tiny muted center">Wallet balance {usd(balance)}, {usd(balance - request.amount)} after.</p>
        </>
      )}
      {wallet.state?.active && !canPay && request.to !== wallet.address && (
        <div className="card stack">
          <span className="small">Your wallet has {usd(balance)}; this needs {usd(request.amount - balance)} more.</span>
          <button type="button" className="btn primary" onClick={() => setAdding(true)}>Add money</button>
        </div>
      )}
      {wallet.state && !wallet.state.active && <StartWallet />}
      {(external || (wallet.state && !canPay)) ? (
        <>
          <a className="btn block" href={link}>Open another wallet app</a>
          {qr && <img className="qr" src={qr} alt="QR code for this payment. Scan it with your wallet app." />}
          <p className="status center"><span className="dot warn" /> Waiting for the payment… it shows up a few seconds after you approve it.</p>
          {problem && <p className="small warn center">{problem}</p>}
          <details className="small muted">
            <summary>Paying from another wallet</summary>
            <p>Use Pera Wallet or any Algorand wallet holding USDC. On this phone, tap “Open another wallet app”; on a computer, scan the code
              with your phone. The amount and the memo are filled in for you; the memo is how this app recognises the payment.</p>
            <p className="mono">{request.to}</p>
          </details>
        </>
      ) : canPay && <button type="button" className="btn ghost block small" onClick={() => setExternal(true)}>Use another wallet</button>}
      {adding && <RampSheet side="BUY" initial={formatUsd(request.amount - balance + 1_000_000n)} onClose={() => setAdding(false)} />}
    </Sheet>
  );
}
