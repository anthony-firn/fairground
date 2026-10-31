/**
 * The wallet: a balance in dollars, money in and out of a bank through Meld, sending and receiving, and what came
 * and went. The money is USDC (digital dollars) on Algorand in an account only this device can sign for; Fairground
 * never holds it or funds it. A wallet is set up by its owner's first deposit. Until in-app buying and selling is
 * switched on, exchanges can send to and receive from it directly.
 */
import { useEffect, useState } from 'react';
import { DEVELOPMENT_ADDRESS } from '@core/defaults.ts';
import { algorandUsdc, isAlgorandAddress } from '@core/rails/algorand.ts';
import type { Transfer } from '@core/rails/rail.ts';
import { formatUsd, parseUsd } from '@core/pricing.ts';
import { feesLeft } from '@core/walletkey.ts';
import { CryptoFundingSheet } from '../components/CryptoFunding.tsx';
import { Field, Sheet, TopBar } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { payoutAddress } from '../lib/data.ts';
import { balance, nowSeconds, timeAgo, usd } from '../lib/format.ts';
import { getPaidHere, useSettle, useWallet, walletChanged, walletConfig, pendingRamp, pendingRamps } from '../lib/wallet.ts';
import { LOCAL_PILOT } from '../lib/pilot.ts';

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

/**
 * A new wallet is set up by its first deposit. Algorand accounts need a little ALGO (its own currency) before they can
 * hold dollars, so the first deposit arrives as ALGO: the wallet keeps about five cents' worth for its account minimum
 * and network fees, and converts the rest to dollars.
 */
export function FirstDeposit({ compact, active }: { compact?: boolean; active?: boolean }) {
  const [adding, setAdding] = useState(false);
  const [receiving, setReceiving] = useState(false);
  if (receiving) return <CryptoFundingSheet onClose={() => setReceiving(false)} />;
  if (adding) return <RampSheet side="BUY" onClose={() => setAdding(false)} />;
  if (active !== false) return null;
  return (
    <div className="card stack">
      <strong>Set up your wallet with a first deposit</strong>
      <span className="small">Already have crypto? Transfer ALGO from Coinbase, Kraken or another wallet. Fairground sets up your wallet when it arrives.</span>
      {!compact && <span className="tiny muted">Your first ALGO deposit covers setup and network fees; larger deposits are converted to USDC.</span>}
      <button type="button" className="btn primary" onClick={() => setReceiving(true)}>Transfer crypto I already own</button>
      <button type="button" className="btn ghost" onClick={() => setAdding(true)}>Add money</button>
    </div>
  );
}

/** What the wallet is doing with a deposit, while it's on screen. */
export function SettleStatus() {
  const { account } = useApp();
  const { state } = useWallet(account);
  const settle = useSettle(account, state);
  if (settle.status === 'working') return <p className="small center"><span className="dot warn" /> {state?.active ? 'Converting your deposit to dollars…' : 'Your deposit arrived. Setting up your wallet and converting it to dollars…'}</p>;
  if (settle.status === 'error') return <p className="small warn">Couldn’t finish converting your deposit: {settle.error} <button type="button" className="btn small" onClick={settle.retry}>Try again</button></p>;
  return null;
}

/** Buying or selling through Meld, or, where that isn't available, how to do it with an exchange. */
export function RampSheet({ side, initial, onClose }: { side: 'BUY' | 'SELL'; initial?: string; onClose: () => void }) {
  const { account, toast } = useApp();
  const { address, state, config } = useWallet(account);
  const [amount, setAmount] = useState(initial ?? (side === 'BUY' ? '25' : state ? formatUsd(state.usdc) : ''));
  const [opened, setOpened] = useState(false);
  const [checking, setChecking] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [subdivision, setSubdivision] = useState('');
  const [starting, setStarting] = useState(false);
  const buy = side === 'BUY';
  // Until the wallet is set up, deposits arrive as ALGO, which it needs before it can hold dollars.
  const asset = buy && !state?.active ? 'ALGO' : 'USDC';
  async function open() {
    setStarting(true);
    // Open the window first, in the click, so browsers don't block it; then point it at the session.
    const win = window.open('about:blank', '_blank');
    try {
      const url = await (await actions()).rampSession(account, side, address, Number(amount), asset, `US-${subdivision}`);
      if (win) win.location.href = url;
      else location.href = url;
      setOpened(true);
    } catch (e) {
      win?.close();
      toast((e as Error).message);
    } finally { setStarting(false); }
  }
  if (receiving) return <CryptoFundingSheet onClose={() => setReceiving(false)} />;
  if (buy && !config?.ramp) {
    return (
      <Sheet title="Add money" onClose={onClose}>
        <p className="small">{config ? 'Card payments are not available yet. You can transfer crypto from an exchange or wallet right now.' : 'Checking card checkout… You can also transfer crypto you already own.'}</p>
        <button type="button" className="btn primary block" onClick={() => setReceiving(true)}>Transfer crypto I already own</button>
        <button type="button" className="btn ghost block" disabled={!config || checking} onClick={async () => {
          setChecking(true);
          try { await walletConfig(true); walletChanged(); }
          finally { setChecking(false); }
        }}>{checking ? 'Checking…' : 'Try again'}</button>
      </Sheet>
    );
  }
  if (!config?.ramp) {
    return (
      <Sheet title="Cash out" onClose={onClose}>
        <ol className="small stack" style={{ paddingLeft: 20, margin: 0 }}>
          <li>At an exchange that supports USDC on Algorand, such as Kraken, find your USDC deposit address for the <strong>Algorand</strong> network.</li>
          <li>Use <strong>Send</strong> here to send your USDC to that address.</li>
          <li>Sell it for dollars at the exchange and withdraw to your bank.</li>
        </ol>
        <p className="tiny muted">Paying and cashing out inside Fairground, with a card or bank transfer, is coming soon.</p>
      </Sheet>
    );
  }
  return (
    <Sheet title={buy ? 'Add money' : 'Cash out'} onClose={onClose}>
      {buy && !opened && <div className="card stack"><strong>Already have crypto?</strong><span className="small">Transfer from an exchange or Algorand wallet.</span><button type="button" className="btn block" onClick={() => setReceiving(true)}>Transfer crypto I already own</button></div>}
      {opened ? (
        <>
        <p className="small">{LOCAL_PILOT ? 'The Meld sandbox is open. Use its test details only; this preview does not move real funds.' : buy ? `Finish in the Meld window. Your deposit appears after Meld completes the purchase and delivers it.${asset === 'ALGO' ? ' Keep this page open, or come back: the wallet sets itself up and converts it to dollars.' : ''}`
          : 'Finish in the Meld window. When it asks you to send the USDC, you’ll come back here to confirm.'}</p>
        {!buy && <button type="button" className="btn primary block" onClick={() => { location.hash = '/wallet'; location.reload(); }}>Check cash-out</button>}
        </>
      ) : (
        <>
          <Field label={buy ? 'Amount ($)' : 'Amount to cash out ($)'}><input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
          <Field label="US state" hint="Enter your two-letter state abbreviation, for example CA. Availability depends on your location."><input type="text" value={subdivision} maxLength={2} autoComplete="address-level1" onChange={(e) => setSubdivision(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} /></Field>
          {asset === 'ALGO' && <p className="small">This first deposit also sets up your wallet automatically. A small reserve stays for setup and future network fees.</p>}
          <p className="small muted">{buy ? 'Meld connects you to a payment provider for card payments and identity checks. The provider shows its fees before you pay. Fairground never sees your card details or takes a fee.'
            : 'Meld connects you to a provider for your bank payout and identity checks. The provider shows its fees before you confirm. Fairground never sees your bank details or takes a fee.'}</p>
          {LOCAL_PILOT && <p className="small warn">Test checkout only. Use sandbox payment details; real transfers are disabled in this preview.</p>}
          <button type="button" className="btn primary block" disabled={starting || !state || !(Number(amount) > 0) || subdivision.length !== 2 || (!buy && Number(amount) > Number(state?.usdc ?? 0n) / 1_000_000)} onClick={open}>{starting ? 'Opening checkout…' : LOCAL_PILOT ? 'Open Meld sandbox' : 'Continue with Meld'}</button>
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
  return <CryptoFundingSheet onClose={onClose} />;
}

/** Coming back from Meld to send the USDC for a sale. The order is checked with Meld before anything moves. */
function CashOutReturn({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const { account, toast } = useApp();
  const [check, setCheck] = useState<{ amount: bigint; to: string; fiat: string } | { problem: string }>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    actions().then((a) => a.rampOrder(account, orderId).then((result) => ({ ...result, problem: result.problem ?? a.cashOutProblem(account, result.order) }))).then(({ order, problem }) => {
      if (problem) return setCheck({ problem });
      setCheck({ amount: parseUsd(order.cryptoAmount), to: order.walletAddress, fiat: `${order.fiatAmount.toFixed(2)} ${order.fiatCurrency}` });
    }, (e: Error) => setCheck({ problem: e.message }));
  }, [account, orderId]);
  return (
    <Sheet title="Finish cashing out" onClose={onClose}>
      {!check && <div className="skeleton" />}
      {check && 'problem' in check && <p className="small bad">This can’t be paid: {check.problem}.</p>}
      {check && 'amount' in check && (
        <>
          <p>Send <strong>{usd(check.amount)}</strong> to the provider, and they’ll pay about <strong>{check.fiat}</strong> to your bank.</p>
          <p className="tiny muted">Checked with Meld: this order is yours and waiting for this payment.</p>
          <button type="button" className="btn primary block" disabled={busy} onClick={async () => {
            setBusy(true);
            try {
              await (await actions()).payCashOut(account, orderId);
              toast('Sent. The payment provider will process your bank payout.');
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

export function WalletScreen(_props: { query: URLSearchParams }) {
  const { account, navigate } = useApp();
  const { address, state, error } = useWallet(account);
  const [sheet, setSheet] = useState<'buy' | 'sell' | 'send' | 'receive'>();
  const [returning, setReturning] = useState(() => { const pending = pendingRamp(account); return pending?.side === 'SELL' ? pending.id : null; });
  const [activity, setActivity] = useState<Transfer[]>();
  const [, rerender] = useState(0);
  const paidHere = payoutAddress() === address;
  useEffect(() => {
    if (LOCAL_PILOT) { setActivity([]); return; }
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
          <strong style={{ fontSize: 40 }}>{state ? balance(state.usdc) : '…'}</strong>
          <span className="tiny muted">Digital dollars (USDC). Only this account can move them.</span>
        </div>
        {address === DEVELOPMENT_ADDRESS && (
          <p className="card small">This wallet receives Fairground’s development donations.{state && !state.active ? ' Your first deposit also enables it to receive donations.' : ''}</p>
        )}
        {error && <p className="small warn">{error}</p>}
        <FirstDeposit active={state?.active} />
        <SettleStatus />
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
            {feesLeft(state) < 9 && <p className="small warn">The wallet is out of ALGO for network fees. Send it 1 ALGO from an exchange, and it carries on.</p>}
            {!returning && pendingRamps(account).filter((s) => s.side === 'SELL').map((s) => <button key={s.id} type="button" className="btn block" onClick={() => setReturning(s.id)}>Resume cash-out · {usd(parseUsd(String(s.amount)))}</button>)}
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
