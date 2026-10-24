/**
 * The optional donation: offered after money changes hands (a creator's payout, an advertiser's payment, a seller's
 * paid order) and open to anyone at any time from You and About. It is never pre-selected: the person sees the total,
 * how it splits between development and relays, and exactly which relays (often run by their own audience) receive
 * it, and can change any of it or skip. The development fund is offered only once it can receive USDC.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Event } from 'nostr-tools/pure';
import {
  chooseRecipient,
  DEFAULT_DEVELOPMENT_PERCENT,
  fetchRelayOperator,
  operatorWeights,
  parseRelayPayout,
  splitByWeight,
  splitDonation,
  verifiedRelayPayouts,
  type RelayPayout,
} from '@core/commons.ts';
import { DEVELOPMENT_ADDRESS } from '@core/defaults.ts';
import { createDonationReceipt, suggestedDonation, type DonationTransfer } from '@core/donation.ts';
import { KIND } from '@core/kinds.ts';
import { MEMO } from '@core/memos.ts';
import { formatUsd, parseUsd } from '@core/pricing.ts';
import { algorandUsdc, RAIL } from '@core/rails/algorand.ts';
import type { PaymentRequest } from '@core/rails/rail.ts';
import { useApp } from '../context.ts';
import { pqKeys } from '../lib/data.ts';
import { usd } from '../lib/format.ts';
import { publish, query, recentCredits } from '../lib/net.ts';
import { load, save } from '../lib/storage.ts';
import { PayDialog } from './PayDialog.tsx';
import { Field, Name, Sheet } from './ui.tsx';

interface Props {
  /** What the person was paid or paid out, which the suggestion is 2% of. Without it, a plain donation. */
  amount?: bigint;
  /** The payment receipt the donation follows, for the public record. */
  payment?: Event;
  onClose: () => void;
}

/** Whether the development fund can receive USDC yet, checked once per session. */
let devReady: Promise<boolean> | undefined;
export const developmentReady = (): Promise<boolean> =>
  (devReady ??= DEVELOPMENT_ADDRESS ? algorandUsdc.canReceive(DEVELOPMENT_ADDRESS).catch(() => false) : Promise.resolve(false));

interface Recipient {
  payout: RelayPayout;
  weight: number;
  audience: boolean;
}

export function DonationSheet({ amount, payment, onClose }: Props) {
  const { account, toast } = useApp();
  const [total, setTotal] = useState(amount ? formatUsd(suggestedDonation(amount)) : '5.00');
  const [devPercent, setDevPercent] = useState(DEFAULT_DEVELOPMENT_PERCENT);
  const [dev, setDev] = useState<string | undefined>();
  const [recipients, setRecipients] = useState<Recipient[] | undefined>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [makePublic, setMakePublic] = useState(true);
  const [queue, setQueue] = useState<(PaymentRequest & { recipient: string; label: string })[]>([]);
  const [done, setDone] = useState<DonationTransfer[]>([]);

  useEffect(() => {
    developmentReady().then((ok) => setDev(ok ? DEVELOPMENT_ADDRESS : undefined), () => undefined);
  }, []);

  // Relays with a verified payout: the ones that served this person, and the ones run by their followers.
  useEffect(() => {
    (async () => {
      const [payoutEvents, followers] = await Promise.all([
        query({ kinds: [KIND.relayPayout], limit: 200 }, 4000),
        query({ kinds: [3], '#p': [account.pubkey], limit: 500 }, 4000),
      ]);
      const lookup = await pqKeys(payoutEvents.map((e) => e.pubkey));
      const payouts = payoutEvents.map((e) => parseRelayPayout(e, lookup)).filter((p): p is RelayPayout => !!p);
      const verified = await verifiedRelayPayouts(payouts, (url) => fetchRelayOperator(url));
      const audience = new Set(followers.map((f) => f.pubkey));
      const credits = recentCredits();
      for (const [relay, payout] of verified) {
        if (audience.has(payout.operator)) credits.set(relay, (credits.get(relay) ?? 0) + 10);
      }
      const shares = operatorWeights(credits, verified);
      const list = [...shares.values()].map((s) => ({ ...s, audience: audience.has(s.payout.operator) })).sort((a, b) => b.weight - a.weight);
      setRecipients(list);
      const given = new Map(Object.entries(load<Record<string, string>>('given', {})).map(([k, v]) => [k, BigInt(v)]));
      const first = chooseRecipient(new Map(list.map((r) => [r.payout.operator, r.weight])), given, 1n);
      setSelected(new Set(first ? [first] : []));
    })().catch(() => setRecipients([]));
  }, [account.pubkey]);

  let totalMicros = 0n;
  try {
    totalMicros = parseUsd(total || '0');
  } catch {
    totalMicros = 0n;
  }
  const chosen = (recipients ?? []).filter((r) => selected.has(r.payout.operator));
  const { development, relays } = splitDonation(totalMicros, dev ? devPercent : 0, chosen.length > 0);
  const perRelay = useMemo(() => splitByWeight(relays, new Map(chosen.map((r) => [r.payout.operator, r.weight]))), [relays, chosen]);
  const payments = (dev && development > 0n ? 1 : 0) + [...perRelay.values()].filter((v) => v > 0n).length;
  const nobody = !dev && recipients !== undefined && !recipients.length;

  function start() {
    const list: typeof queue = [];
    if (dev && development > 0n) list.push({ to: dev, amount: development, memo: MEMO.development, recipient: 'development', label: 'Fairground development' });
    for (const r of chosen) {
      const share = perRelay.get(r.payout.operator) ?? 0n;
      if (share > 0n) list.push({ to: r.payout.payTo, amount: share, memo: MEMO.relay(r.payout.relays[0]), recipient: r.payout.relays[0], label: r.payout.relays[0].replace(/^wss?:\/\//, '') });
    }
    setQueue(list);
  }

  async function finished(all: DonationTransfer[]) {
    const given = load<Record<string, string>>('given', {});
    for (const r of chosen) {
      const t = all.find((d) => r.payout.relays.includes(d.recipient));
      if (t) given[r.payout.operator] = (BigInt(given[r.payout.operator] ?? '0') + t.amount).toString();
    }
    save('given', given);
    if (makePublic && all.length) await publish(createDonationReceipt(account.nostrKey, account.pq, { payment, rail: RAIL, transfers: all })).catch(() => undefined);
    toast('Thank you. Your donation went straight to them.');
    onClose();
  }

  if (queue.length) {
    const current = queue[0];
    return (
      <PayDialog
        title={`Donate to ${current.label}`}
        description={queue.length > 1 ? `Payment ${done.length + 1} of ${done.length + queue.length}` : undefined}
        request={current}
        onClose={onClose}
        onPaid={(t) => {
          const all = [...done, { txid: t.id, amount: t.amount, recipient: current.recipient }];
          setDone(all);
          if (queue.length === 1) finished(all);
          setQueue(queue.slice(1));
        }}
      />
    );
  }

  return (
    <Sheet title={amount ? 'Give a little back?' : 'Support Fairground'} onClose={onClose}>
      <p className="muted">Optional. Fairground takes nothing from payments. A small donation keeps it running: development builds the app,
        and relays (often run by your own audience) carry everyone’s posts.</p>
      {nobody ? (
        <p className="card small">Donations open as soon as Fairground’s development fund is ready to receive. Thank you for thinking of it.</p>
      ) : (
        <>
          <Field label="Total" hint={amount ? `Suggested: 2% of ${usd(amount)}` : undefined}>
            <input type="text" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value.replace(/[^\d.]/g, ''))} />
          </Field>
          <div className="stack">
            <div className="row between small"><strong>Development {usd(development)}</strong><strong>Relays {usd(relays)}</strong></div>
            <div className="split-bar" aria-hidden="true">
              <i style={{ width: `${totalMicros ? Number((development * 100n) / (totalMicros || 1n)) : 0}%` }} />
              <i style={{ flex: 1 }} />
            </div>
            <input type="range" min={0} max={100} step={5} value={dev ? devPercent : 0} disabled={!dev || !chosen.length}
              onChange={(e) => setDevPercent(Number(e.target.value))} aria-label="Share for development" />
            {!dev && <p className="tiny muted">The development fund isn’t accepting donations yet, so everything goes to relays.</p>}
            {dev && recipients?.length === 0 && <p className="tiny muted">No relays accept donations yet, so it all goes to development for now. Anyone can run one: Create → Become a relay.</p>}
          </div>
          <div className="stack">
            <strong>Relays that receive your share</strong>
            {recipients === undefined && <p className="muted small">Finding the relays that carried your posts…</p>}
            {recipients?.length === 0 && <p className="muted small">None of your relays accept donations yet.</p>}
            {recipients?.map((r) => (
              <label key={r.payout.operator} className="switch card">
                <span className="grow">
                  <strong>{r.payout.relays[0].replace(/^wss?:\/\//, '')}</strong>
                  <span className="small muted"> · run by <Name pubkey={r.payout.operator} />{r.audience ? ' (follows you)' : ''}</span>
                  {selected.has(r.payout.operator) && <span className="small"> · {usd(perRelay.get(r.payout.operator) ?? 0n)}</span>}
                </span>
                <input type="checkbox" checked={selected.has(r.payout.operator)} onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(r.payout.operator);
                  else next.delete(r.payout.operator);
                  setSelected(next);
                }} />
              </label>
            ))}
          </div>
          <label className="switch"><span>Show this donation publicly</span><input type="checkbox" checked={makePublic} onChange={(e) => setMakePublic(e.target.checked)} /></label>
          <button type="button" className="btn primary block" disabled={!payments || totalMicros <= 0n} onClick={start}>
            Donate {usd(totalMicros)}{payments > 1 ? ` · ${payments} payments` : ''}
          </button>
        </>
      )}
      <button type="button" className="btn ghost block" onClick={onClose}>Not now</button>
    </Sheet>
  );
}
