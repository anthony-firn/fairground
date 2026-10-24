/**
 * Paying someone directly: the payer's own wallet opens with the payment filled in (or scans the QR code), and the app
 * watches the public chain for the transfer carrying this payment's memo. No funds pass through Fairground.
 */
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { algorandUsdc } from '@core/rails/algorand.ts';
import type { PaymentRequest, Transfer } from '@core/rails/rail.ts';
import { nowSeconds, usd } from '../lib/format.ts';
import { Sheet } from './ui.tsx';

interface Props {
  title: string;
  description?: string;
  request: PaymentRequest;
  onPaid: (transfer: Transfer) => void;
  onClose: () => void;
}

export function PayDialog({ title, description, request, onPaid, onClose }: Props) {
  const link = algorandUsdc.paymentLink(request);
  const [qr, setQr] = useState('');
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
        if (match && !stopped) return onPaid(match);
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
      <a className="btn primary block" href={link}>Open my wallet</a>
      {qr && <img className="qr" src={qr} alt="QR code for this payment. Scan it with your wallet app." />}
      <p className="status center"><span className="dot warn" /> Waiting for the payment… it shows up a few seconds after you approve it.</p>
      {problem && <p className="small warn center">{problem}</p>}
      <details className="small muted">
        <summary>How do I pay?</summary>
        <p>Use Pera Wallet or any Algorand wallet holding USDC. On this phone, tap “Open my wallet”; on a computer, scan the code
          with your phone. The amount and the memo are filled in for you; the memo is how this app recognises the payment.</p>
        <p className="mono">{request.to}</p>
      </details>
    </Sheet>
  );
}
