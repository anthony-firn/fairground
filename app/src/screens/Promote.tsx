/**
 * Advertising, for anyone: a brand, a reader who loves a creator, or a creator cross-promoting with another. Offers go
 * to one creator or to anyone; the advertiser pays the creator's wallet directly once the post is up.
 */
import { useEffect, useState } from 'react';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { npubEncode } from 'nostr-tools/nip19';
import type { Event } from 'nostr-tools/pure';
import { KIND } from '@core/kinds.ts';
import { parseMediaKit, type MediaKit } from '@core/mediakit.ts';
import { MEMO } from '@core/memos.ts';
import { formatUsd, parseUsd } from '@core/pricing.ts';
import { RAIL } from '@core/rails/algorand.ts';
import { acceptedOffer, checkDeal, createOffer, createPaymentReceipt, parseOffer } from '@core/sponsorship.ts';
import { markedEvent, tag } from '@core/tags.ts';
import { DonationSheet } from '../components/DonationSheet.tsx';
import { PayDialog } from '../components/PayDialog.tsx';
import { PostCard } from '../components/PostCard.tsx';
import { Field, Name, Segmented, TopBar } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { newPrice, pqKeys, priceNow, useIndex } from '../lib/data.ts';
import { nowSeconds, usd } from '../lib/format.ts';
import { useEvents } from '../lib/hooks.ts';
import { publish } from '../lib/net.ts';

type Tab = 'new' | 'offers' | 'creators';

function NewOffer({ to, rate, onDone }: { to?: string; rate?: string; onDone: () => void }) {
  const { account, toast } = useApp();
  const index = useIndex();
  const [kind, setKind] = useState<'post' | 'cross'>('post');
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [price, setPrice] = useState(rate ?? '50');
  const [days, setDays] = useState('14');
  const [creator, setCreator] = useState(to);

  useEffect(() => {
    if (kind === 'cross') {
      setTitle('Cross-promo: tell your audience about my channel');
      setBrief(`Share what you like about my posts and link my profile: nostr:${npubEncode(account.pubkey)}`);
    }
  }, [kind, account.pubkey]);

  async function send() {
    try {
      const offer = createOffer(account.nostrKey, account.pq, {
        slug: bytesToHex(randomBytes(6)), title, brief, price: newPrice(parseUsd(price), index), rail: RAIL,
        deadline: nowSeconds() + Number(days) * 86400, creator,
      });
      await publish(offer);
      toast(creator ? 'Offer sent. They’ll see it in Find sponsors.' : 'Offer posted for any creator.');
      onDone();
    } catch (e) {
      toast((e as Error).message);
    }
  }

  return (
    <div className="stack">
      <Segmented value={kind} onChange={setKind} options={[['post', 'Sponsor a post'], ['cross', 'Cross-promo']]} />
      {creator ? (
        <p className="card small row between"><span>For <strong><Name pubkey={creator} /></strong> only</span>
          <button type="button" className="btn ghost small" onClick={() => setCreator(undefined)}>Open to anyone</button></p>
      ) : <p className="small muted">Open to any creator. To pick one, use Sponsor on their profile or Find creators.</p>}
      <Field label="Title"><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What you’re promoting" /></Field>
      <Field label="What you’d like them to post about" hint="Creators post in their own words, and every sponsored post is labelled #ad.">
        <textarea value={brief} onChange={(e) => setBrief(e.target.value)} />
      </Field>
      <Field label="You pay ($)" hint={index?.latest ? 'Kept in step with the cost of living until you pay, so the creator isn’t short-changed.' : undefined}>
        <input type="text" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
      </Field>
      <Field label="They have"><select value={days} onChange={(e) => setDays(e.target.value)}><option value="7">1 week</option><option value="14">2 weeks</option><option value="30">1 month</option></select></Field>
      <p className="small muted">You pay the creator directly from your own wallet after their post goes up. Your payment record is public, so paying promptly helps you find creators.</p>
      <button type="button" className="btn primary block" disabled={!title || !brief || !price} onClick={send}>Send offer</button>
    </div>
  );
}

function AcceptanceRow({ acceptance, delivery, receipt }: { acceptance: Event; delivery?: Event; receipt?: Event }) {
  const { account, toast } = useApp();
  const index = useIndex();
  const offerEvent = acceptedOffer(acceptance);
  const offer = offerEvent && parseOffer(offerEvent);
  const [valid, setValid] = useState<boolean>();
  const [paying, setPaying] = useState(false);
  const [paid, setPaid] = useState(false);
  const [donation, setDonation] = useState<{ amount: bigint; receipt: Event }>();

  useEffect(() => {
    if (!offerEvent) return;
    pqKeys([acceptance.pubkey, account.pubkey]).then((pqKeyOf) => {
      const c = checkDeal({ offer: offerEvent, acceptance, delivery }, { pqKeyOf });
      setValid(c.problems.length === 0);
    }, () => undefined);
  }, [offerEvent, acceptance, delivery, account.pubkey]);

  if (!offer || offerEvent.pubkey !== account.pubkey) return null;
  const due = priceNow(offer.price, index);
  const payTo = tag(acceptance, 'payto')?.[2] ?? '';
  return (
    <div className="card stack">
      <div className="row between">
        <span><strong><Name pubkey={acceptance.pubkey} /></strong> · <span className="muted">{offer.title}</span></span>
        {receipt || paid ? <span className="badge good">Paid</span> : delivery ? <span className="badge warn">Ready to pay</span> : <span className="badge">Writing</span>}
      </div>
      {valid === false && <p className="small bad">This acceptance doesn’t check out; don’t pay it.</p>}
      {delivery && <PostCard post={delivery} />}
      {delivery && valid && !receipt && !paid && <button type="button" className="btn primary" onClick={() => setPaying(true)}>Pay {usd(due.amount)}</button>}
      {paying && (
        <PayDialog
          title={`Pay ${offer.title}`}
          description="This goes straight to the creator’s wallet."
          request={{ to: payTo, amount: due.amount, memo: MEMO.deal(acceptance.id) }}
          onClose={() => setPaying(false)}
          onPaid={async (t) => {
            setPaying(false);
            const r = createPaymentReceipt(account.nostrKey, account.pq, { acceptance, delivery: delivery!, rail: RAIL, txid: t.id, amount: t.amount, period: due.period });
            await publish(r).catch((e: Error) => toast(e.message));
            setPaid(true);
            setDonation({ amount: t.amount, receipt: r });
          }}
        />
      )}
      {donation && <DonationSheet amount={donation.amount} payment={donation.receipt} onClose={() => setDonation(undefined)} />}
    </div>
  );
}

function MyOffers() {
  const { account } = useApp();
  const { events: acceptances, loading } = useEvents({ kinds: [KIND.acceptance], '#p': [account.pubkey], limit: 200 });
  const ids = acceptances.map((a) => a.id);
  const { events: posts } = useEvents(ids.length ? { kinds: [1], '#e': ids } : null);
  const { events: receipts } = useEvents(ids.length ? { kinds: [KIND.payment], authors: [account.pubkey], '#e': ids } : null);
  const { events: offers } = useEvents({ kinds: [KIND.offer], authors: [account.pubkey], limit: 50 });
  return (
    <div className="stack">
      {loading && !acceptances.length && <div className="skeleton" />}
      {!loading && !acceptances.length && <p className="muted center">{offers.length ? `${offers.length} open offers. Nobody has accepted yet.` : 'No offers yet.'}</p>}
      {acceptances.map((acc) => (
        <AcceptanceRow key={acc.id} acceptance={acc}
          delivery={posts.find((p) => p.pubkey === acc.pubkey && markedEvent(p, 'sponsorship') === acc.id)}
          receipt={receipts.find((r) => markedEvent(r, 'acceptance') === acc.id)} />
      ))}
    </div>
  );
}

function FindCreators({ onSponsor }: { onSponsor: (kit: MediaKit) => void }) {
  const index = useIndex();
  const { events, loading } = useEvents({ kinds: [KIND.mediaKit], limit: 100 });
  const [kits, setKits] = useState<MediaKit[]>([]);
  const [topic, setTopic] = useState('');
  useEffect(() => {
    pqKeys(events.map((e) => e.pubkey)).then((lookup) => setKits(events.map((e) => parseMediaKit(e, lookup)).filter((k): k is MediaKit => !!k)), () => undefined);
  }, [events]);
  const shown = kits.filter((k) => !topic || k.topics.includes(topic.toLowerCase().replace(/^#/, '')));
  return (
    <div className="stack">
      <input type="text" placeholder="Filter by topic, e.g. running" value={topic} onChange={(e) => setTopic(e.target.value)} />
      {loading && !kits.length && <div className="skeleton" />}
      {!loading && !shown.length && <p className="muted center">No creators listed{topic ? ' for that topic' : ''} yet.</p>}
      {shown.map((k) => (
        <div key={k.event.id} className="card stack">
          <div className="row between"><strong><Name pubkey={k.creator} /></strong><span>{usd(priceNow(k.rate, index).amount)} / post</span></div>
          <p className="small" style={{ margin: 0 }}>{k.pitch}</p>
          {k.topics.length > 0 && <p className="small muted" style={{ margin: 0 }}>{k.topics.map((t) => `#${t}`).join(' ')}</p>}
          {k.survey && <p className="tiny muted" style={{ margin: 0 }}>Has an anonymous audience survey</p>}
          <button type="button" className="btn primary small" onClick={() => onSponsor(k)}>Sponsor</button>
        </div>
      ))}
    </div>
  );
}

export function Promote({ query: q }: { query: URLSearchParams }) {
  const { navigate } = useApp();
  const index = useIndex();
  const to = q.get('to') ?? undefined;
  const [tab, setTab] = useState<Tab>(to ? 'new' : 'offers');
  const [target, setTarget] = useState<{ to?: string; rate?: string }>({ to });
  return (
    <>
      <TopBar title="Advertise" back={() => history.back()} />
      <div className="page">
        <Segmented value={tab} onChange={setTab} options={[['offers', 'Your offers'], ['new', 'New offer'], ['creators', 'Find creators']]} />
        {tab === 'new' && <NewOffer key={`${target.to}-${target.rate}`} to={target.to} rate={target.rate} onDone={() => (setTab('offers'), navigate('/promote'))} />}
        {tab === 'offers' && <MyOffers />}
        {tab === 'creators' && <FindCreators onSponsor={(k) => (setTarget({ to: k.creator, rate: formatUsd(priceNow(k.rate, index).amount) }), setTab('new'))} />}
      </div>
    </>
  );
}
