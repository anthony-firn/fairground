/**
 * Becoming a relay: one button that connects the person's relay, verifies they run it, and publishes where donations
 * go. The dashboard shows what came in, the pass-on pledge, and one tap to send the pledged share on to creators.
 * Phones and browser tabs can't be public relays (they can't accept connections and get suspended), so the relay
 * itself runs somewhere always on: a free cloud tier, a home server, or a paid host.
 */
import { useEffect, useState } from 'react';
import { finalizeEvent } from 'nostr-tools/pure';
import {
  createRelayPayout,
  fetchRelayOperator,
  parseRelayPayout,
  passOnStatus,
  splitByWeight,
  SUGGESTED_PASS_ON_PERCENT,
  type PassOnStatus,
  type RelayPayout,
} from '@core/commons.ts';
import { KIND } from '@core/kinds.ts';
import { MEMO, normalizeRelayUrl } from '@core/memos.ts';
import { algorandUsdc, RAIL } from '@core/rails/algorand.ts';
import { parseSupportPage, periodOf, type SupportPage } from '@core/support.ts';
import { PayDialog } from '../components/PayDialog.tsx';
import { Field, Name, Sheet, TopBar } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { payoutAddress, pqKeys } from '../lib/data.ts';
import { nowSeconds, usd } from '../lib/format.ts';
import { publish, query, relays, setRelays } from '../lib/net.ts';
import { load } from '../lib/storage.ts';
import { PayoutSheet } from './Create.tsx';

const GUIDE = 'https://www.evolvetech.dev/projects/fairground/#run-a-relay';

function PassOnSheet({ due, onClose }: { due: bigint; onClose: () => void }) {
  const { toast } = useApp();
  const [pages, setPages] = useState<SupportPage[]>();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [queue, setQueue] = useState<{ page: SupportPage; amount: bigint }[]>([]);

  useEffect(() => {
    (async () => {
      const follows = load<string[]>('follows', []);
      const events = follows.length ? await query({ kinds: [KIND.supportPage], authors: follows.slice(0, 300) }, 4000) : [];
      const lookup = await pqKeys(events.map((e) => e.pubkey));
      const list = events.map((e) => parseSupportPage(e, lookup)).filter((p): p is SupportPage => !!p);
      setPages(list);
      setChosen(new Set(list.slice(0, 3).map((p) => p.creator)));
    })().catch(() => setPages([]));
  }, []);

  const shares = splitByWeight(due, new Map([...chosen].map((c) => [c, 1])));
  if (queue.length) {
    const { page, amount } = queue[0];
    return (
      <PayDialog title="Pass it on" description={`To ${page.title}`} request={{ to: page.payTo, amount, memo: MEMO.support(page.creator) }}
        onClose={onClose} onPaid={() => {
          if (queue.length === 1) {
            toast('Passed on. Thank you for keeping the loop going.');
            onClose();
          }
          setQueue(queue.slice(1));
        }} />
    );
  }
  return (
    <Sheet title="Send to creators" onClose={onClose}>
      <p className="muted small">Your pledge this month is {usd(due)}. It goes to creators you follow who have fan support turned on; each is a separate payment from your wallet.</p>
      {pages === undefined && <p className="muted small">Finding creators…</p>}
      {pages?.length === 0 && <p className="small">None of the creators you follow have fan support turned on yet.</p>}
      {pages?.map((p) => (
        <label key={p.creator} className="switch card">
          <span><strong><Name pubkey={p.creator} /></strong>{chosen.has(p.creator) && <span className="small muted"> · {usd(shares.get(p.creator) ?? 0n)}</span>}</span>
          <input type="checkbox" checked={chosen.has(p.creator)} onChange={(e) => {
            const next = new Set(chosen);
            if (e.target.checked) next.add(p.creator);
            else next.delete(p.creator);
            setChosen(next);
          }} />
        </label>
      ))}
      <button type="button" className="btn primary block" disabled={!chosen.size || due <= 0n}
        onClick={() => setQueue((pages ?? []).filter((p) => chosen.has(p.creator)).map((page) => ({ page, amount: shares.get(page.creator) ?? 0n })).filter((q) => q.amount > 0n))}>
        Send {usd(due)}
      </button>
    </Sheet>
  );
}

export function RelayScreen() {
  const { account, navigate, toast } = useApp();
  const [payout, setPayout] = useState<RelayPayout | null>();
  const [status, setStatus] = useState<PassOnStatus>();
  const [askPayout, setAskPayout] = useState(false);
  const [url, setUrl] = useState('');
  const [passOn, setPassOn] = useState(SUGGESTED_PASS_ON_PERCENT);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [passing, setPassing] = useState(false);

  useEffect(() => {
    (async () => {
      const events = (await query({ kinds: [KIND.relayPayout], authors: [account.pubkey], limit: 1 }, 3000)).sort((a, b) => b.created_at - a.created_at);
      const p = events[0] ? parseRelayPayout(events[0], await pqKeys([account.pubkey])) ?? null : null;
      setPayout(p);
      if (p) {
        setPassOn(p.passOn);
        setStatus(await passOnStatus(p, algorandUsdc, periodOf(nowSeconds())));
      }
    })().catch(() => setPayout(null));
  }, [account.pubkey]);

  async function become(payTo = payoutAddress()) {
    setProblem('');
    if (!payTo) return setAskPayout(true);
    let relay: string;
    try {
      relay = normalizeRelayUrl(url);
    } catch {
      return setProblem('Enter your relay’s address, starting with wss://');
    }
    setBusy(true);
    try {
      const operator = await fetchRelayOperator(relay);
      if (operator !== account.pubkey) {
        return setProblem(`Your relay doesn’t name you as its operator yet. In its settings, set the operator pubkey to ${account.pubkey}, then try again.`);
      }
      const ev = createRelayPayout(account.nostrKey, account.pq, { relays: [relay], rail: RAIL, payTo, passOn });
      await publish(ev);
      setRelays([...relays(), relay]);
      await publish(finalizeEvent({ kind: 10002, created_at: nowSeconds(), content: '', tags: relays().map((r) => ['r', r]) }, account.nostrKey)).catch(() => undefined);
      setPayout(parseRelayPayout(ev, await pqKeys([account.pubkey])) ?? null);
      toast('You’re a relay. Donations from the people it serves now reach your wallet.');
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar title="Become a relay" back={() => navigate('/create')} />
      <div className="page">
        <p className="muted">Relays store and deliver everyone’s posts. Run one and you receive a share of the donations from the people it actually
          serves, which you can pass on to creators or cash out. Payment follows real use, so extra relays nobody reads from earn nothing.</p>
        {payout === undefined && <div className="skeleton" />}
        {payout === null && (
          <div className="card stack">
            <Field label="Your relay’s address" hint={<>Don’t have one? <a href={GUIDE} target="_blank" rel="noopener noreferrer">Here’s how to run one</a>; then come back.</>}>
              <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="wss://relay.example.com" autoCapitalize="none" />
            </Field>
            <Field label={`Pass on ${passOn}% to creators`} hint="Your public pledge: the share of each month’s donations you send on to creators the next month.">
              <input type="range" min={0} max={100} step={5} value={passOn} onChange={(e) => setPassOn(Number(e.target.value))} />
            </Field>
            {problem && <p className="small warn mono" style={{ fontFamily: 'inherit' }}>{problem}</p>}
            <button type="button" className="btn primary block" disabled={busy} onClick={() => become()}>{busy ? 'Checking your relay…' : 'Become a relay'}</button>
          </div>
        )}
        {payout && (
          <>
            <div className="card stack">
              <div className="row between"><h3>{payout.relays[0].replace(/^wss?:\/\//, '')}</h3><span className="badge good">Receiving</span></div>
              {status ? (
                <>
                  <div className="row between small"><span>Donations last month</span><strong>{usd(status.received)}</strong></div>
                  <div className="row between small"><span>Your pledge ({payout.passOn}%) this month</span><strong>{usd(status.due)}</strong></div>
                  <div className="row between small"><span>Passed on so far</span><strong className={status.kept ? 'good' : ''}>{usd(status.paid)}</strong></div>
                </>
              ) : <p className="small muted">Reading your payments…</p>}
              <div className="row wrap">
                <button type="button" className="btn primary" disabled={!status || status.due <= status.paid} onClick={() => setPassing(true)}>Send to creators</button>
                <a className="btn" href={`https://explorer.perawallet.app/address/${payout.payTo}/`} target="_blank" rel="noopener noreferrer">Cash out</a>
              </div>
              <p className="tiny muted">Cash out from your own wallet: in Pera, sell USDC or send it to an exchange. Fairground never holds your earnings.</p>
            </div>
          </>
        )}
      </div>
      {askPayout && <PayoutSheet onClose={() => setAskPayout(false)} onSaved={(a) => become(a)} />}
      {passing && status && <PassOnSheet due={status.due - status.paid} onClose={() => setPassing(false)} />}
    </>
  );
}
