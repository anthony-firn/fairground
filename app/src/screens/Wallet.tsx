/**
 * The wallet: a balance in dollars, money in and out of a bank through Transak, sending and receiving, and what came
 * and went. The money is USDC (digital dollars) on Algorand in an account only this device can sign for; Fairground
 * never holds it. Until in-app buying and selling is switched on, exchanges can send to and receive from it directly.
 */
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { algorandUsdc, isAlgorandAddress } from '@core/rails/algorand.ts';
import type { Transfer } from '@core/rails/rail.ts';
import { formatUsd, parseUsd } from '@core/pricing.ts';
import { feesLeft } from '@core/walletkey.ts';
import { Field, Sheet, TopBar } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { payoutAddress } from '../lib/data.ts';
import { nowSeconds, timeAgo, usd } from '../lib/format.ts';
import { getPaidHere, useWallet } from '../lib/wallet.ts';

const actions = () => import('../lib/walletActions.ts');

/** What a transfer was for, from its memo. */
function label(t: Transfer, mine: string): string {
  const out = t.sender === mine;
  const [, kind] = t.note.split(':');
  const what: Record<string, string> = {
    deal: 'Sponsorship', support: 'Fan support', order: 'Order', development: 'Donation to Fairground', relay: 'Donation to a relay', cashout: 'Cash out', send: 'Sent',
  };
  return what[kind ?? ''] ?? (out ? 'Sent' : 'Received');
}

/** Turning the wallet on, which the project's sponsor pays for. */
export function StartWallet({ onStarted }: { onStarted?: () => void }) {
  const { account, toast } = useApp();
  const { config, address } = useWallet(account);
  const [busy, setBusy] = useState(false);
  if (config && !config.starter) {
    return (
      <div className="card stack">
        <strong>Turn on your wallet</strong>
        <span className="small">Send 0.25 ALGO to this address from an exchange or another wallet. That covers Algorand’s minimum balance and about 50 payments’ fees.</span>
        <code className="tiny" style={{ wordBreak: 'break-all' }}>{address}</code>
      </div>
    );
  }
  return (
    <div className="card stack">
      <strong>Turn on your wallet</strong>
      <span className="small">Pay and get paid in digital dollars, right here. It’s free: Fairground covers the setup. Only this account can move the money in it.</span>
      <button type="button" className="btn primary" disabled={busy || !config} onClick={async () => {
        setBusy(true);
        try {
          await (await actions()).startWallet(account, config!.starter!);
          toast('Your wallet is on.');
          onStarted?.();
        } catch (e) {
          toast((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}>{busy ? 'Turning it on…' : 'Turn on my wallet'}</button>
    </div>
  );
}

/** Buying or selling through Transak, or, where that isn't available, how to do it with an exchange. */
export function RampSheet({ side, initial, onClose }: { side: 'BUY' | 'SELL'; initial?: string; onClose: () => void }) {
  const { account, toast } = useApp();
  const { address, state, config } = useWallet(account);
  const [amount, setAmount] = useState(initial ?? (side === 'BUY' ? '25' : state ? formatUsd(state.usdc) : ''));
  const [opened, setOpened] = useState(false);
  const buy = side === 'BUY';
  async function open() {
    // Open the window first, in the click, so browsers don't block it; then point it at the session.
    const win = window.open('about:blank', '_blank');
    try {
      const url = await (await actions()).rampSession(account, side, address, Number(amount) || undefined);
      if (win) win.location.href = url;
      else location.href = url;
      setOpened(true);
    } catch (e) {
      win?.close();
      toast((e as Error).message);
    }
  }
  if (!config?.ramp) {
    return (
      <Sheet title={buy ? 'Add money' : 'Cash out'} onClose={onClose}>
        {buy ? (
          <ol className="small stack" style={{ paddingLeft: 20, margin: 0 }}>
            <li>Buy USDC at an exchange that supports USDC on Algorand, such as Kraken, paying from your bank.</li>
            <li>Withdraw it to this address, choosing the <strong>Algorand</strong> network:<br /><code className="tiny" style={{ wordBreak: 'break-all' }}>{address}</code></li>
            <li>It shows here within seconds of the exchange sending it.</li>
          </ol>
        ) : (
          <ol className="small stack" style={{ paddingLeft: 20, margin: 0 }}>
            <li>At an exchange that supports USDC on Algorand, such as Kraken, find your USDC deposit address for the <strong>Algorand</strong> network.</li>
            <li>Use <strong>Send</strong> here to send your USDC to that address.</li>
            <li>Sell it for dollars at the exchange and withdraw to your bank.</li>
          </ol>
        )}
        <p className="tiny muted">Paying and cashing out inside Fairground, with a card or bank transfer, is coming soon.</p>
      </Sheet>
    );
  }
  return (
    <Sheet title={buy ? 'Add money' : 'Cash out'} onClose={onClose}>
      {opened ? (
        <p className="small">{buy ? 'Finish in the Transak window. The money arrives here as soon as they send it, usually within minutes for a card and a few days for a bank transfer.'
          : 'Finish in the Transak window. When it asks you to send the USDC, you’ll come back here to confirm.'}</p>
      ) : (
        <>
          <Field label={buy ? 'Amount ($)' : 'Amount to cash out ($)'}><input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
          <p className="small muted">{buy ? 'Pay by card or bank transfer through Transak, a licensed payments company; they verify your identity the first time. Fairground never sees your card or bank details and takes no fee.'
            : 'Transak pays your bank account; they verify your identity the first time. Fairground never sees your bank details and takes no fee.'}</p>
          <button type="button" className="btn primary block" disabled={!(Number(amount) > 0)} onClick={open}>Continue with Transak</button>
        </>
      )}
    </Sheet>
  );
}

function SendSheet({ onClose }: { onClose: () => void }) {
  const { account, toast } = useApp();
  const { state } = useWallet(account);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  let micros = 0n;
  try {
    micros = parseUsd(amount || '0');
  } catch {
    micros = 0n;
  }
  const valid = isAlgorandAddress(to.trim()) && micros > 0n && !!state && micros <= state.usdc;
  return (
    <Sheet title="Send" onClose={onClose}>
      <Field label="To (Algorand address)" hint="For an exchange, use its USDC deposit address on the Algorand network.">
        <input type="text" value={to} onChange={(e) => setTo(e.target.value.toUpperCase())} spellCheck={false} autoCapitalize="characters" />
      </Field>
      <Field label="Amount ($)" hint={state ? `You have ${usd(state.usdc)}` : undefined}><input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
      <button type="button" className="btn primary block" disabled={!valid || busy} onClick={async () => {
        setBusy(true);
        try {
          if (!(await algorandUsdc.canReceive(to.trim()))) throw new Error('That address can’t receive USDC yet. Check it’s an Algorand USDC address.');
          await (await actions()).payFromWallet(account, { to: to.trim(), amount: micros, memo: 'fairground:send' });
          toast(`Sent ${usd(micros)}`);
          onClose();
        } catch (e) {
          toast((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}>{busy ? 'Sending…' : `Send ${usd(micros)}`}</button>
    </Sheet>
  );
}

function ReceiveSheet({ onClose }: { onClose: () => void }) {
  const { account, toast } = useApp();
  const { address } = useWallet(account);
  const [qr, setQr] = useState('');
  useEffect(() => {
    QRCode.toDataURL(address, { margin: 1, width: 360 }).then(setQr, () => undefined);
  }, [address]);
  return (
    <Sheet title="Receive" onClose={onClose}>
      <p className="small">Your wallet’s address on Algorand. Send only USDC or ALGO to it.</p>
      {qr && <img className="qr" src={qr} alt="QR code of your wallet address" />}
      <code className="tiny" style={{ wordBreak: 'break-all' }}>{address}</code>
      <button type="button" className="btn" onClick={() => navigator.clipboard.writeText(address).then(() => toast('Address copied'), () => undefined)}>Copy address</button>
    </Sheet>
  );
}

/** Coming back from Transak to send the USDC for a sale. The order is checked with Transak before anything moves. */
function CashOutReturn({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const { account, toast } = useApp();
  const [check, setCheck] = useState<{ amount: bigint; to: string; fiat: string } | { problem: string }>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    actions().then((a) => a.rampOrder(account, orderId)).then(({ order, problem }) => {
      if (problem) return setCheck({ problem });
      setCheck({ amount: parseUsd(order.cryptoAmount.toFixed(6)), to: order.walletAddress, fiat: `${order.fiatAmount.toFixed(2)} ${order.fiatCurrency}` });
    }, (e: Error) => setCheck({ problem: e.message }));
  }, [account, orderId]);
  return (
    <Sheet title="Finish cashing out" onClose={onClose}>
      {!check && <div className="skeleton" />}
      {check && 'problem' in check && <p className="small bad">This can’t be paid: {check.problem}.</p>}
      {check && 'amount' in check && (
        <>
          <p>Send <strong>{usd(check.amount)}</strong> to Transak, and they’ll pay about <strong>{check.fiat}</strong> to your bank.</p>
          <p className="tiny muted">Checked with Transak: this order is yours and waiting for this payment.</p>
          <button type="button" className="btn primary block" disabled={busy} onClick={async () => {
            setBusy(true);
            try {
              await (await actions()).payFromWallet(account, { to: check.to, amount: check.amount, memo: `fairground:cashout:${orderId}` });
              toast('Sent. Transak will pay your bank.');
              onClose();
            } catch (e) {
              toast((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}>{busy ? 'Sending…' : `Send ${usd(check.amount)}`}</button>
        </>
      )}
    </Sheet>
  );
}

export function WalletScreen({ query }: { query: URLSearchParams }) {
  const { account, navigate } = useApp();
  const { address, state, error } = useWallet(account);
  const [sheet, setSheet] = useState<'buy' | 'sell' | 'send' | 'receive'>();
  const [returning, setReturning] = useState(query.get('orderId'));
  const [activity, setActivity] = useState<Transfer[]>();
  const [, rerender] = useState(0);
  const paidHere = payoutAddress() === address;
  useEffect(() => {
    if (!state?.active) return;
    const from = nowSeconds() - 180 * 86400;
    Promise.all(['receiver', 'sender'].map((role) => algorandUsdc.listTransfers({ address, role: role as 'receiver' | 'sender', notePrefix: '', from, to: nowSeconds() + 60 })))
      .then((lists) => {
        // Leave out the wallet's own USDC opt-in, and count a transfer once.
        const seen = new Map(lists.flat().filter((t) => !(t.sender === t.receiver && t.amount === 0n)).map((t) => [t.id, t]));
        setActivity([...seen.values()].sort((a, b) => b.time - a.time).slice(0, 50));
      }, () => setActivity([]));
  }, [address, state?.active, state?.usdc]);

  return (
    <>
      <TopBar title="Wallet" back={() => navigate('/you')} />
      <div className="page">
        <div className="card stack center wallet-balance">
          <span className="small muted">Balance</span>
          <strong style={{ fontSize: 40 }}>{state ? usd(state.usdc) : '…'}</strong>
          <span className="tiny muted">Digital dollars (USDC). Only this account can move them.</span>
        </div>
        {error && <p className="small warn">{error}</p>}
        {state && !state.active && <StartWallet />}
        {state?.active && (
          <>
            <div className="wallet-actions">
              <button type="button" className="btn primary" onClick={() => setSheet('buy')}>Add money</button>
              <button type="button" className="btn" onClick={() => setSheet('sell')}>Cash out</button>
              <button type="button" className="btn" onClick={() => setSheet('send')}>Send</button>
              <button type="button" className="btn" onClick={() => setSheet('receive')}>Receive</button>
            </div>
            {!paidHere && (
              <div className="card row between">
                <span className="small">Get paid into this wallet: sponsorships, fan support and sales.</span>
                <button type="button" className="btn small" onClick={() => (getPaidHere(account), rerender((n) => n + 1))}>Use it</button>
              </div>
            )}
            {paidHere && <p className="tiny muted center">Sponsorships, fan support and sales are paid into this wallet.</p>}
            {feesLeft(state) < 5 && <p className="small warn">The wallet is low on ALGO for network fees. Add a little ALGO to its address, or a few cents’ worth when you add money.</p>}
            <h2>Activity</h2>
            {activity === undefined && <div className="skeleton" />}
            {activity?.length === 0 && <p className="small muted">Nothing yet.</p>}
            {activity && activity.length > 0 && (
              <div className="card list">
                {activity.map((t) => {
                  const out = t.sender === address;
                  return (
                    <div key={t.id} className="row between activity">
                      <span>{label(t, address)}<br /><span className="tiny muted">{timeAgo(t.time)}</span></span>
                      <strong className={out ? '' : 'good'}>{out ? '−' : '+'}{usd(t.amount)}</strong>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
        <details className="small muted">
          <summary>How this wallet works</summary>
          <p>It’s an Algorand account whose key is part of your Fairground account, so saving your account (a username and password, or the backup code)
            saves the wallet too. Payments are signed on this device and nobody else, Fairground included, can move the money. It uses Algorand’s standard keys;
            for large amounts, a quantum-safe Falcon account in a wallet like Pera is safer, and you can choose to be paid there instead.</p>
        </details>
      </div>
      {(sheet === 'buy' || sheet === 'sell') && <RampSheet side={sheet === 'buy' ? 'BUY' : 'SELL'} onClose={() => setSheet(undefined)} />}
      {sheet === 'send' && <SendSheet onClose={() => setSheet(undefined)} />}
      {sheet === 'receive' && <ReceiveSheet onClose={() => setSheet(undefined)} />}
      {returning && <CashOutReturn orderId={returning} onClose={() => setReturning(null)} />}
    </>
  );
}
