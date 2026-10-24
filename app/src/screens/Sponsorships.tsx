import { useEffect, useMemo, useState } from 'react';
import type { Event } from 'nostr-tools/pure';
import { DEFAULT_INDEX_POLICY } from '@core/defaults.ts';
import { KIND } from '@core/kinds.ts';
import { advertiserRecords } from '@core/mediakit.ts';
import { FIXED_INDEX } from '@core/pricing.ts';
import type { AdvertiserRecord } from '@core/reputation.ts';
import {
  acceptedOffer,
  checkDeal,
  createAcceptance,
  createSponsoredPost,
  parseOffer,
  verifyPayment,
  type DealCheck,
  type Offer,
  type PaymentCheck,
} from '@core/sponsorship.ts';
import { markedEvent, tagValue } from '@core/tags.ts';
import { DonationSheet } from '../components/DonationSheet.tsx';
import { Name, Segmented, Sheet, TopBar } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { loadIndex, payoutAddress, pqKeys, priceNow, useIndex } from '../lib/data.ts';
import { nowSeconds, usd } from '../lib/format.ts';
import { useEvents } from '../lib/hooks.ts';
import { publish, query } from '../lib/net.ts';
import { load, save } from '../lib/storage.ts';
import { PayoutSheet } from './Create.tsx';

type Record = AdvertiserRecord & { advertiser: string };

export function recordText(r?: Record): string {
  if (!r || !r.delivered) return 'New advertiser';
  const wait = r.medianDaysToPay !== undefined ? ` · usually ${Math.max(1, Math.round(r.medianDaysToPay))} days` : '';
  return `Paid ${r.paid} of ${r.delivered}${wait}${r.overdue ? ` · ${r.overdue} overdue` : ''}`;
}

/** Advertisers' public records, from the deals on relays. */
export function useAdvertiserRecords(): Map<string, Record> {
  const [records, setRecords] = useState(new Map<string, Record>());
  useEffect(() => {
    Promise.all([
      query({ kinds: [KIND.acceptance], limit: 500 }, 4000),
      query({ kinds: [KIND.payment], limit: 500 }, 4000),
      query({ kinds: [1], '#t': ['ad'], limit: 500 }, 4000),
    ]).then((lists) => setRecords(advertiserRecords(lists.flat())), () => undefined);
  }, []);
  return records;
}

/** Writes the sponsored post for an accepted deal. */
export function DeliverSheet({ acceptance, onClose }: { acceptance: Event; onClose: () => void }) {
  const { account, toast } = useApp();
  const [text, setText] = useState('');
  async function post() {
    try {
      await publish(createSponsoredPost(account.nostrKey, acceptance, text, account.pq));
      toast('Posted. The advertiser pays your wallet directly.');
      onClose();
    } catch (e) {
      toast((e as Error).message);
    }
  }
  return (
    <Sheet title="Your sponsored post" onClose={onClose}>
      <p className="small muted">Write it your way. It will be labelled “#ad”, which the law requires and your audience deserves.</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      <button type="button" className="btn primary block" disabled={!text.trim()} onClick={post}>Post</button>
    </Sheet>
  );
}

function OfferSheet({ offer, record, onClose }: { offer: Offer; record?: Record; onClose: () => void }) {
  const { account, toast, navigate } = useApp();
  const index = useIndex();
  const [payout, setPayout] = useState(false);
  const [accepted, setAccepted] = useState<Event>();
  const price = priceNow(offer.price, index).amount;

  async function accept(payTo = payoutAddress()) {
    if (!payTo) return setPayout(true);
    try {
      const acc = createAcceptance(account.nostrKey, account.pq, offer, payTo);
      await publish(acc);
      setAccepted(acc);
    } catch (e) {
      toast((e as Error).message);
    }
  }

  if (accepted) return <DeliverSheet acceptance={accepted} onClose={() => (onClose(), navigate('/create/deals'))} />;
  return (
    <Sheet title={offer.title} onClose={onClose}>
      <p className="small muted">From <strong><Name pubkey={offer.advertiser} /></strong> · {recordText(record)}</p>
      <p style={{ whiteSpace: 'pre-wrap' }}>{offer.brief}</p>
      <div className="card small stack" style={{ gap: 4 }}>
        <div className="row between"><span>Pays</span><strong>{usd(price)}</strong></div>
        {offer.price.index !== FIXED_INDEX && <div className="muted">Kept in step with the cost of living until you’re paid.</div>}
        <div className="row between"><span>Post by</span><span>{new Date(offer.deadline * 1000).toLocaleDateString()}</span></div>
        <div className="row between"><span>Paid to</span><span>your own wallet, by the advertiser</span></div>
      </div>
      <button type="button" className="btn primary block" onClick={() => accept()}>Accept and write the post</button>
      {payout && <PayoutSheet onClose={() => setPayout(false)} onSaved={(a) => accept(a)} />}
    </Sheet>
  );
}

export function Sponsors() {
  const { account, navigate } = useApp();
  const index = useIndex();
  const [tab, setTab] = useState<'offers' | 'advertisers'>('offers');
  const { events, loading } = useEvents({ kinds: [KIND.offer], limit: 150 });
  const [offers, setOffers] = useState<Offer[]>([]);
  const [open, setOpen] = useState<Offer>();
  const records = useAdvertiserRecords();

  useEffect(() => {
    (async () => {
      const parsed = events.map(parseOffer).filter((o): o is Offer => !!o && o.deadline > nowSeconds() && o.advertiser !== account.pubkey && (!o.creator || o.creator === account.pubkey));
      const lookup = await pqKeys(parsed.map((o) => o.advertiser));
      setOffers(parsed.filter((o) => checkDeal({ offer: o.event }, { pqKeyOf: lookup }).stage === 'offered'));
    })().catch(() => undefined);
  }, [events, account.pubkey]);

  const advertisers = useMemo(() => [...records.values()].sort((a, b) => b.paid - a.paid || a.overdue - b.overdue), [records]);
  return (
    <>
      <TopBar title="Find sponsors" back={() => navigate('/create')} />
      <div className="page">
        <Segmented value={tab} onChange={setTab} options={[['offers', 'Open offers'], ['advertisers', 'Advertisers']]} />
        {tab === 'offers' && (
          <>
            {loading && !offers.length && <div className="skeleton" />}
            {!loading && !offers.length && <p className="muted center">No open offers right now. Publish a media kit so advertisers can find you.</p>}
            {offers.map((o) => (
              <button key={o.event.id} type="button" className="card" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setOpen(o)}>
                <div className="row between"><h3>{o.title}</h3><strong>{usd(priceNow(o.price, index).amount)}</strong></div>
                <p className="small muted"><Name pubkey={o.advertiser} /> · {recordText(records.get(o.advertiser))}{o.creator ? ' · offered to you' : ''}</p>
                <p className="small" style={{ margin: 0 }}>{o.brief.slice(0, 140)}{o.brief.length > 140 ? '…' : ''}</p>
              </button>
            ))}
          </>
        )}
        {tab === 'advertisers' && (
          <div className="card list">
            {!advertisers.length && <p className="muted small">No completed deals on your relays yet.</p>}
            {advertisers.map((r) => (
              <button key={r.advertiser} type="button" onClick={() => navigate(`/p/${r.advertiser}`)}>
                <span><Name pubkey={r.advertiser} /><br /><span className="small muted" style={{ fontWeight: 400 }}>{recordText(r)}</span></span>
                <span className={`badge${r.overdue ? ' bad' : r.paid ? ' good' : ''}`}>{r.overdue ? 'Overdue' : r.paid ? 'Pays' : 'New'}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {open && <OfferSheet offer={open} record={records.get(open.advertiser)} onClose={() => setOpen(undefined)} />}
    </>
  );
}

function DealRow({ acceptance, delivery, receipt }: { acceptance: Event; delivery?: Event; receipt?: Event }) {
  const offerEvent = acceptedOffer(acceptance);
  const offer = offerEvent && parseOffer(offerEvent);
  const [check, setCheck] = useState<DealCheck>();
  const [payment, setPayment] = useState<PaymentCheck>();
  const [writing, setWriting] = useState(false);
  const [donating, setDonating] = useState(false);

  useEffect(() => {
    if (!offerEvent) return;
    (async () => {
      const deal = { offer: offerEvent, acceptance, delivery, payment: receipt };
      const index = await loadIndex();
      const pqKeyOf = await pqKeys([offerEvent.pubkey, acceptance.pubkey]);
      const c = checkDeal(deal, { pqKeyOf });
      setCheck(c);
      if (c.stage !== 'receipted') return;
      const verified = await verifyPayment(deal, { pqKeyOf, attestations: index.attestations, indexPolicy: DEFAULT_INDEX_POLICY });
      setPayment(verified);
      const offered = new Set(load<string[]>('donationOffered', []));
      if (verified.ok && !offered.has(acceptance.id)) {
        save('donationOffered', [...offered, acceptance.id]);
        setDonating(true);
      }
    })().catch(() => undefined);
  }, [offerEvent, acceptance, delivery, receipt]);

  if (!offer) return null;
  let status = <span className="badge">Checking…</span>;
  if (payment?.ok) status = <span className="badge good">Paid {usd(payment.paid!)}</span>;
  else if (payment) status = <span className="badge bad" title={payment.problems.join('; ')}>Payment problem</span>;
  else if (check?.stage === 'accepted') status = <span className="badge warn">Write your post</span>;
  else if (check?.stage === 'delivered') status = <span className="badge">Waiting for payment</span>;
  else if (check?.problems.length) status = <span className="badge bad" title={check.problems.join('; ')}>Problem</span>;

  return (
    <div className="card stack">
      <div className="row between"><h3>{offer.title}</h3>{status}</div>
      <p className="small muted" style={{ margin: 0 }}>From <Name pubkey={offer.advertiser} /></p>
      {payment && !payment.ok && <p className="small bad">{payment.problems[0]}</p>}
      {check?.stage === 'accepted' && <button type="button" className="btn primary" onClick={() => setWriting(true)}>Write the sponsored post</button>}
      {payment?.ok && <button type="button" className="btn" onClick={() => setDonating(true)}>Give a little back</button>}
      {writing && <DeliverSheet acceptance={acceptance} onClose={() => setWriting(false)} />}
      {donating && receipt && payment?.paid && <DonationSheet amount={payment.paid} payment={receipt} onClose={() => setDonating(false)} />}
    </div>
  );
}

export function Deals() {
  const { account, navigate } = useApp();
  const { events: acceptances, loading } = useEvents({ kinds: [KIND.acceptance], authors: [account.pubkey], limit: 100 });
  const ids = acceptances.map((a) => a.id);
  const { events: posts } = useEvents(ids.length ? { kinds: [1], authors: [account.pubkey], '#e': ids } : null);
  const { events: receipts } = useEvents(ids.length ? { kinds: [KIND.payment], '#e': ids } : null);
  const find = (list: Event[], marker: string, id: string) => list.filter((e) => markedEvent(e, marker) === id).sort((a, b) => a.created_at - b.created_at)[0];
  return (
    <>
      <TopBar title="Your sponsorships" back={() => navigate('/create')} />
      <div className="page">
        {loading && !acceptances.length && <div className="skeleton" />}
        {!loading && !acceptances.length && (
          <div className="center stack">
            <p className="muted">No sponsorships yet.</p>
            <button type="button" className="btn primary" onClick={() => navigate('/create/sponsors')}>Find sponsors</button>
          </div>
        )}
        {acceptances.map((acc) => (
          <DealRow key={acc.id} acceptance={acc} delivery={find(posts, 'sponsorship', acc.id)}
            receipt={find(receipts.filter((r) => r.pubkey === tagValue(acc, 'p')), 'acceptance', acc.id)} />
        ))}
      </div>
    </>
  );
}
