/**
 * The marketplace: things for sale, food, services (rides, errands, tasks) and requests for help, in one-off listings
 * or storefronts. Listings are NIP-99, so other Nostr marketplaces' listings appear here too. Buyers pay sellers'
 * wallets directly; orders travel as private messages.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Event } from 'nostr-tools/pure';
import {
  canBuy,
  createListing,
  createStore,
  credentialsFor,
  formatPrice,
  LISTING_TYPES,
  newOrderId,
  orderTotal,
  parseListing,
  parseStore,
  priceMicros,
  reliability,
  SERVICE_CATEGORIES,
  verifyReviews,
  CREDENTIAL_TYPES,
  type CredentialView,
  type Fulfillment,
  type Listing,
  type ListingType,
  type Order,
  type OrderLine,
  type Quote,
  type Reliability,
  type Store,
  type StoreKind,
} from '@core/commerce.ts';
import { KIND } from '@core/kinds.ts';
import { MEMO } from '@core/memos.ts';
import { formatUsd, parseUsd } from '@core/pricing.ts';
import { algorandUsdc, RAIL } from '@core/rails/algorand.ts';
import { PayDialog } from '../components/PayDialog.tsx';
import { PostMenu } from '../components/PostMenu.tsx';
import { Thread } from '../components/Thread.tsx';
import { Avatar, Field, Icon, Name, Segmented, Sheet, TopBar } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { payoutAddress, pqKeys } from '../lib/data.ts';
import { sendMessage } from '../lib/dm.ts';
import { nowSeconds, usd } from '../lib/format.ts';
import { currentArea } from '../lib/geo.ts';
import { useEvents } from '../lib/hooks.ts';
import { publish, query } from '../lib/net.ts';
import { allowed, safetySettings } from '../lib/safety.ts';
import { loadMembers, useMembership } from '../lib/members.ts';
import { load, save } from '../lib/storage.ts';
import { uploadPhoto } from '../lib/upload.ts';
import { PayoutSheet } from './Create.tsx';

const TYPE_LABELS: Record<ListingType | 'all', string> = { all: 'All', item: 'For sale', food: 'Food', service: 'Services', request: 'Requests', rental: 'Rentals' };
const FULFILLMENT_LABELS: Record<Fulfillment, string> = { pickup: 'Pickup', delivery: 'Delivery', shipping: 'Shipping', onsite: 'In person', remote: 'Online' };

export const listingPath = (address: string) => `/l/${encodeURIComponent(address)}`;
export const storePath = (address: string) => `/s/${encodeURIComponent(address)}`;

/** Safety rules apply to listings as to posts; the title counts as text. */
const safeListing = (l: Listing) => allowed({ ...l.event, content: `${l.title}\n${l.summary ?? ''}\n${l.description}` }, { ...safetySettings(), allLanguages: true }, true);

function ListingCard({ listing }: { listing: Listing }) {
  const { navigate } = useApp();
  return (
    <button type="button" className="listing-card" onClick={() => navigate(listingPath(listing.address))}>
      {listing.images[0] ? <img src={listing.images[0]} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="ph" aria-hidden="true">{listing.type === 'request' ? '🙋' : listing.type === 'service' ? '🛠' : listing.type === 'food' ? '🍲' : '🏷'}</span>}
      <strong className="small">{listing.title}</strong>
      <span className="small">{listing.type === 'request' ? `Budget: ${formatPrice(listing.price)}` : formatPrice(listing.price)}</span>
      <span className="tiny muted">{TYPE_LABELS[listing.type]}{listing.location ? ` · ${listing.location}` : ''}</span>
    </button>
  );
}

export function Market() {
  const { navigate, toast } = useApp();
  const [type, setType] = useState<ListingType | 'all'>('all');
  const [service, setService] = useState('');
  const [search, setSearch] = useState('');
  const [area, setArea] = useState<string | null>(() => load<string | null>('area', null));
  const filter = useMemo(() => {
    const f: { kinds: number[]; limit: number; '#g'?: string[] } = { kinds: [KIND.listing], limit: 300 };
    if (area) f['#g'] = [area.slice(0, 4)];
    return f;
  }, [area]);
  const { events, loading } = useEvents(filter);
  const stores = useEvents(area ? { kinds: [KIND.store], '#g': [area.slice(0, 4)], limit: 30 } : null);
  const members = useMembership([...events, ...stores.events].map((e) => e.pubkey));

  const listings = useMemo(() => {
    const q = search.trim().toLowerCase();
    const newest = new Map<string, Listing>();
    for (const ev of events) {
      const l = parseListing(ev);
      if (!l || l.status !== 'active' || !members?.has(l.event.pubkey) || !safeListing(l)) continue;
      const prev = newest.get(l.address);
      if (!prev || prev.event.created_at < ev.created_at) newest.set(l.address, l);
    }
    return [...newest.values()].filter((l) =>
      (type === 'all' || l.type === type) &&
      (!service || l.categories.includes(service)) &&
      (!q || `${l.title} ${l.summary ?? ''} ${l.description} ${l.categories.join(' ')} ${l.location ?? ''}`.toLowerCase().includes(q)),
    ).sort((a, b) => b.event.created_at - a.event.created_at);
  }, [events, type, service, search, members]);

  async function nearMe() {
    if (area) {
      setArea(null);
      save('area', null);
      return;
    }
    try {
      const hash = await currentArea(5);
      setArea(hash);
      save('area', hash);
    } catch (e) {
      toast((e as Error).message);
    }
  }

  return (
    <>
      <TopBar title="Market">
        <button type="button" className="icon-btn" onClick={() => navigate('/messages')} aria-label="Messages"><Icon name="comment" /></button>
        <button type="button" className="btn primary small" onClick={() => navigate('/market/new')}>Sell or ask</button>
      </TopBar>
      <div className="page">
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search bikes, tacos, rides, cleaning…" aria-label="Search the market" />
        <div className="chips">
          <button type="button" className="chip" aria-pressed={!!area} onClick={nearMe}>{area ? '📍 Near me' : '📍 Anywhere'}</button>
          {(['all', ...LISTING_TYPES] as const).map((t) => (
            <button key={t} type="button" className="chip" aria-pressed={type === t} onClick={() => (setType(t), setService(''))}>{TYPE_LABELS[t]}</button>
          ))}
        </div>
        {(type === 'service' || type === 'request') && (
          <div className="chips">
            {SERVICE_CATEGORIES.map((c) => (
              <button key={c.tag} type="button" className="chip" aria-pressed={service === c.tag} onClick={() => setService(service === c.tag ? '' : c.tag)}>{c.label}</button>
            ))}
          </div>
        )}
        {stores.events.some((ev) => members?.has(ev.pubkey)) && (
          <div className="stack">
            <h2>Shops and restaurants near you</h2>
            <div className="chips">
              {stores.events.filter((ev) => members?.has(ev.pubkey)).map((ev) => parseStore(ev, () => undefined)).filter((s): s is Store => !!s).map((s) => (
                <button key={s.address} type="button" className="chip" onClick={() => navigate(storePath(s.address))}>{s.kind === 'restaurant' ? '🍽' : s.kind === 'shop' ? '🛍' : '🛠'} {s.name}</button>
              ))}
            </div>
          </div>
        )}
        {loading && !listings.length && <div className="skeleton" />}
        {!loading && !listings.length && (
          <div className="center stack">
            <p className="muted">{area ? 'Nothing listed near you yet.' : 'Nothing here yet.'} Be the first: sell something, offer a service, or ask for help.</p>
            <button type="button" className="btn primary" onClick={() => navigate('/market/new')}>Post a listing</button>
          </div>
        )}
        <div className="market-grid">{listings.map((l) => <ListingCard key={l.address} listing={l} />)}</div>
      </div>
    </>
  );
}

/** How much to trust someone: 1 if the reader follows them, 0.5 for other Fairground accounts, else 0. */
async function trustFunction(): Promise<(pubkey: string) => number> {
  const follows = new Set(load<string[]>('follows', []));
  const network = await loadMembers().catch(() => new Set<string>());
  return (pk) => (follows.has(pk) ? 1 : network.has(pk) ? 0.5 : 0);
}

/** A seller's verified orders, rating and credentials, as the reader should see them. */
export function useSellerRecord(seller: string | undefined, addresses: string[]) {
  const [record, setRecord] = useState<{ reliability: Reliability; credentials: CredentialView[] }>();
  const key = addresses.join();
  useEffect(() => {
    if (!seller) return;
    (async () => {
      const [reviews, creds] = await Promise.all([
        query({ kinds: [KIND.review], '#p': [seller] }, 4000),
        query({ kinds: [KIND.credential], '#p': [seller] }, 4000),
      ]);
      const lookup = await pqKeys([...new Set([...reviews, ...creds].map((e) => e.pubkey).concat(seller))]);
      const verified = await verifyReviews(reviews, new Set(addresses), algorandUsdc, lookup);
      const trust = await trustFunction();
      setRecord({
        reliability: reliability(verified, trust),
        credentials: credentialsFor(seller, creds, { trustedIssuers: new Set(load<string[]>('trustedIssuers', [])), follows: new Set(load<string[]>('follows', [])), pqKeyOf: lookup }),
      });
    })().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seller, key]);
  return record;
}

const credentialLabel = (type: string) => CREDENTIAL_TYPES.find((c) => c.type === type)?.label ?? type;

export function SellerRecord({ record }: { record?: { reliability: Reliability; credentials: CredentialView[] } }) {
  if (!record) return <p className="tiny muted" style={{ margin: 0 }}>Checking their record…</p>;
  const r = record.reliability;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <p className="small" style={{ margin: 0 }}>
        {r.verifiedOrders ? <>★ {r.rating} · {r.verifiedOrders} verified {r.verifiedOrders === 1 ? 'order' : 'orders'}{r.fromTrusted ? ` · ${r.fromTrusted} from people you trust` : ''}{r.repeatCustomers ? ` · ${r.repeatCustomers} repeat customers` : ''}</> : 'New: no verified orders yet'}
      </p>
      {record.credentials.length > 0 && (
        <div className="chips">
          {record.credentials.map((c) => (
            <span key={c.type} className={`badge${c.status === 'verified' ? ' good' : c.status === 'vouched' ? '' : ' warn'}`} title={c.note}>
              {credentialLabel(c.type)} · {c.status === 'verified' ? 'verified' : c.status === 'vouched' ? 'vouched by someone you follow' : 'self-declared'}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function useListing(address: string) {
  const [listing, setListing] = useState<Listing | null>();
  useEffect(() => {
    const [kind, pubkey, ...rest] = address.split(':');
    const d = rest.join(':');
    if (Number(kind) !== KIND.listing || !/^[0-9a-f]{64}$/.test(pubkey ?? '')) return setListing(null);
    (async () => {
      const [ev] = (await query({ kinds: [KIND.listing], authors: [pubkey], '#d': [d] }, 4000)).sort((a, b) => b.created_at - a.created_at);
      const l = ev && parseListing(ev, await pqKeys([pubkey]));
      setListing(l && safeListing(l) ? l : null);
    })().catch(() => setListing(null));
  }, [address]);
  return listing;
}

/** Turns a cart into a private order and a direct payment. */
function OrderSheet({ seller, payTo, lines, options, title, onClose }: {
  seller: string;
  payTo: { rail: string; address: string };
  lines: OrderLine[];
  options: Fulfillment[];
  title: string;
  onClose: () => void;
}) {
  const { account, toast, navigate } = useApp();
  const [fulfillment, setFulfillment] = useState<Fulfillment>(options[0] ?? 'pickup');
  const [note, setNote] = useState('');
  const [order, setOrder] = useState<Order>();
  const total = orderTotal(lines);

  async function place() {
    const { orderId, nonce } = newOrderId(account.pubkey);
    const o: Order = { type: 'fairground/order', orderId, lines, total: total.toString(), fulfillment, note, payTo };
    try {
      await sendMessage(account, seller, `New order: ${lines.map((l) => `${l.quantity}× ${l.title}`).join(', ')} · $${formatUsd(total)} · ${FULFILLMENT_LABELS[fulfillment]}${note ? `\n${note}` : ''}`, o);
      save('orders', [...load<StoredOrder[]>('orders', []), { order: o, nonce, seller, at: nowSeconds() }]);
      setOrder(o);
    } catch (e) {
      toast((e as Error).message);
    }
  }

  if (order) {
    return (
      <PayDialog title={`Pay for ${title}`} description="Straight to the seller’s wallet. The order is already with them." request={{ to: payTo.address, amount: total, memo: MEMO.order(order.orderId) }}
        onClose={() => (onClose(), navigate('/orders'))}
        onPaid={async (t) => {
          save('orders', load<StoredOrder[]>('orders', []).map((s) => (s.order.orderId === order.orderId ? { ...s, txid: t.id } : s)));
          await sendMessage(account, seller, `Paid $${formatUsd(t.amount)} for order ${order.orderId.slice(0, 8)}`, { type: 'fairground/order-paid', orderId: order.orderId, txid: t.id }).catch(() => undefined);
          toast('Paid. Track it in Orders.');
          onClose();
          navigate('/orders');
        }} />
    );
  }
  return (
    <Sheet title="Your order" onClose={onClose}>
      {lines.map((l) => <div key={l.listing} className="row between small"><span>{l.quantity}× {l.title}</span><span>{usd(BigInt(l.unitPrice) * BigInt(l.quantity))}</span></div>)}
      <div className="row between"><strong>Total</strong><strong>{usd(total)}</strong></div>
      {options.length > 1 && <Segmented value={fulfillment} onChange={setFulfillment} options={options.map((o) => [o, FULFILLMENT_LABELS[o]])} />}
      <Field label="Details for the seller" hint="Address, time, phone: whatever they need. Only the seller can read this.">
        <textarea value={note} onChange={(e) => setNote(e.target.value)} style={{ minHeight: 80 }} />
      </Field>
      <button type="button" className="btn primary block" onClick={place}>Send order and pay {usd(total)}</button>
      <p className="tiny muted">Payment goes from your wallet to theirs. There’s no escrow, so check their record first.</p>
    </Sheet>
  );
}

export interface StoredOrder {
  order: Order;
  nonce: string;
  seller: string;
  at: number;
  txid?: string;
  reviewed?: boolean;
}

/** A helper's offer to do a request, sent privately with their price. */
function QuoteSheet({ listing, onClose }: { listing: Listing; onClose: () => void }) {
  const { account, toast } = useApp();
  const [amount, setAmount] = useState(listing.price?.currency === 'USD' ? listing.price.amount : '');
  const [note, setNote] = useState('');
  const [payout, setPayout] = useState(false);

  async function send(payTo = payoutAddress()) {
    if (!payTo) return setPayout(true);
    try {
      const quote: Quote = { type: 'fairground/quote', listing: listing.address, title: listing.title, amount: parseUsd(amount).toString(), payTo: { rail: RAIL, address: payTo }, note };
      await sendMessage(account, listing.seller, `I can help with “${listing.title}” for $${formatUsd(parseUsd(amount))}.${note ? `\n${note}` : ''}`, quote);
      toast('Offer sent. They can accept it in Messages.');
      onClose();
    } catch (e) {
      toast((e as Error).message);
    }
  }
  return (
    <Sheet title="Offer to help" onClose={onClose}>
      <Field label="Your price ($)"><input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <Field label="Message"><textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="When you can do it, what's included…" /></Field>
      <button type="button" className="btn primary block" disabled={!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0} onClick={() => send()}>Send offer</button>
      {payout && <PayoutSheet onClose={() => setPayout(false)} onSaved={(a) => send(a)} />}
    </Sheet>
  );
}

function SafetyNote({ listing }: { listing: Listing }) {
  if (listing.categories.includes('rides')) {
    return <p className="card small">Riding with someone: check their reviews and credentials (licence, insurance), share your trip with a friend, and meet somewhere public. Drivers are responsible for the licensing and insurance their area requires.</p>;
  }
  if (listing.type === 'food' || listing.categories.some((c) => ['mealpickup', 'groceries'].includes(c))) {
    return <p className="card small">Food sellers are responsible for the permits and safe handling their area requires. Check reviews and credentials such as a food handler card.</p>;
  }
  return null;
}

export function ListingDetail({ address }: { address: string }) {
  const { account, navigate } = useApp();
  const listing = useListing(address);
  const [buying, setBuying] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [menu, setMenu] = useState<Event>();
  const [quantity, setQuantity] = useState(1);
  const record = useSellerRecord(listing?.seller, listing?.payTo ? [listing.payTo.address] : []);
  if (listing === undefined) return <><TopBar title="Listing" back={() => history.back()} /><div className="skeleton" /></>;
  if (listing === null) return <><TopBar title="Listing" back={() => history.back()} /><p className="page muted">This listing isn’t available.</p></>;
  const mine = listing.seller === account.pubkey;
  return (
    <>
      <TopBar title={TYPE_LABELS[listing.type]} back={() => history.back()}>
        <button type="button" className="icon-btn" onClick={() => setMenu(listing.event)} aria-label="More options"><Icon name="more" /></button>
      </TopBar>
      <div className="page">
        {listing.images.length > 0 && <div className="photos">{listing.images.map((src) => <img key={src} src={src} alt="" referrerPolicy="no-referrer" />)}</div>}
        <div className="stack" style={{ gap: 4 }}>
          <h2 style={{ margin: 0, fontSize: 22, textTransform: 'none', letterSpacing: 0, color: 'var(--text)' }}>{listing.title}</h2>
          <strong style={{ fontSize: 20 }}>{listing.type === 'request' ? `Budget: ${formatPrice(listing.price)}` : formatPrice(listing.price)}</strong>
          <span className="small muted">{[listing.location, listing.fulfillment.map((f) => FULFILLMENT_LABELS[f]).join(' · ')].filter(Boolean).join(' · ')}</span>
        </div>
        <button type="button" className="card row" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => navigate(listing.store ? storePath(listing.store) : `/p/${listing.seller}`)}>
          <Avatar pubkey={listing.seller} />
          <span className="grow"><strong><Name pubkey={listing.seller} /></strong>{listing.store && <span className="small muted"> · see their store</span>}<SellerRecord record={record} /></span>
        </button>
        <SafetyNote listing={listing} />
        <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{listing.description}</p>
        {!mine && listing.type === 'request' && <button type="button" className="btn primary block" onClick={() => setQuoting(true)}>Offer to help</button>}
        {!mine && listing.type !== 'request' && canBuy(listing) && (
          <div className="row">
            <div className="row" style={{ gap: 4 }}>
              <button type="button" className="btn small" onClick={() => setQuantity(Math.max(1, quantity - 1))} aria-label="One fewer">−</button>
              <span aria-live="polite">{quantity}</span>
              <button type="button" className="btn small" onClick={() => setQuantity(quantity + 1)} aria-label="One more">+</button>
            </div>
            <button type="button" className="btn primary grow" onClick={() => setBuying(true)}>{listing.type === 'service' ? 'Book' : 'Buy'} · {usd(priceMicros(listing.price!) * BigInt(quantity))}</button>
          </div>
        )}
        {!mine && <button type="button" className="btn block" onClick={() => navigate(`/messages/${listing.seller}`)}>Message {listing.type === 'request' ? 'them' : 'the seller'}</button>}
        {!mine && listing.type !== 'request' && !canBuy(listing) && <p className="tiny muted">This listing can’t be paid for in Fairground (it has no verified USD payment details), so arrange it by message.</p>}
      </div>
      <Thread root={listing.event} />
      {buying && listing.payTo && (
        <OrderSheet seller={listing.seller} payTo={listing.payTo} title={listing.title} options={listing.fulfillment.length ? listing.fulfillment : ['pickup']} onClose={() => setBuying(false)}
          lines={[{ listing: listing.address, title: listing.title, quantity, unitPrice: priceMicros(listing.price!).toString() }]} />
      )}
      {quoting && <QuoteSheet listing={listing} onClose={() => setQuoting(false)} />}
      {menu && <PostMenu post={menu} onClose={() => setMenu(undefined)} onHidden={() => history.back()} />}
    </>
  );
}

export function NewListing({ query: q }: { query: URLSearchParams }) {
  const { account, navigate, toast } = useApp();
  const [type, setType] = useState<ListingType>((q.get('type') as ListingType) ?? 'item');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [frequency, setFrequency] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [location, setLocation] = useState('');
  const [geohash, setGeohash] = useState<string>();
  const [fulfillment, setFulfillment] = useState<Fulfillment[]>(['pickup']);
  const [uploading, setUploading] = useState(false);
  const [payout, setPayout] = useState(false);
  const [store, setStore] = useState<Store>();

  useEffect(() => {
    query({ kinds: [KIND.store], authors: [account.pubkey], limit: 1 }, 3000).then(async ([ev]) => ev && setStore(parseStore(ev, await pqKeys([account.pubkey]))), () => undefined);
  }, [account.pubkey]);

  async function addPhotos(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const f of [...files].slice(0, 6)) {
        const url = await uploadPhoto(account, f);
        setImages((list) => [...list, url]);
      }
    } catch (e) {
      toast(`Photo upload failed: ${(e as Error).message}`);
    } finally {
      setUploading(false);
    }
  }

  async function publishListing(payTo = payoutAddress()) {
    if (type !== 'request' && !payTo) return setPayout(true);
    try {
      const ev = createListing(account.nostrKey, account.pq, {
        type, title: title.trim(), description: description.trim(), images, categories, location: location.trim() || undefined, geohash,
        price: price ? { amount: Number(price).toFixed(2), currency: 'USD', frequency: frequency || undefined } : undefined,
        payTo: type !== 'request' && payTo ? { rail: RAIL, address: payTo } : undefined,
        fulfillment, store: store?.address,
      });
      await publish(ev);
      toast('Listed.');
      navigate(listingPath(`${KIND.listing}:${account.pubkey}:${ev.tags.find((t) => t[0] === 'd')![1]}`));
    } catch (e) {
      toast((e as Error).message);
    }
  }

  const isService = type === 'service' || type === 'request';
  return (
    <>
      <TopBar title="New listing" back={() => history.back()} />
      <div className="page">
        <Segmented value={type} onChange={setType} options={[['item', 'Sell'], ['food', 'Food'], ['service', 'Offer a service'], ['request', 'Ask for help']]} />
        <Field label={type === 'request' ? 'What do you need?' : 'Title'}>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120}
            placeholder={type === 'request' ? 'Ride to the airport Friday 6am' : type === 'service' ? 'Grocery runs and errands' : type === 'food' ? 'Homemade tamales, dozen' : 'Road bike, 54 cm'} />
        </Field>
        <Field label="Details"><textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} /></Field>
        <div className="row">
          <Field label={type === 'request' ? 'Budget ($, optional)' : 'Price ($)'}><input type="text" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0 for free" /></Field>
          {isService && (
            <Field label="Per"><select value={frequency} onChange={(e) => setFrequency(e.target.value)}><option value="">job</option><option value="hour">hour</option><option value="day">day</option></select></Field>
          )}
        </div>
        {isService && (
          <div className="stack">
            <strong className="small">Category</strong>
            <div className="chips">
              {SERVICE_CATEGORIES.map((c) => (
                <button key={c.tag} type="button" className="chip" aria-pressed={categories.includes(c.tag)} onClick={() => setCategories(categories.includes(c.tag) ? categories.filter((x) => x !== c.tag) : [...categories, c.tag])}>{c.label}</button>
              ))}
            </div>
          </div>
        )}
        <div className="stack">
          <strong className="small">Photos</strong>
          <div className="row wrap">
            {images.map((src) => (
              <span key={src} style={{ position: 'relative' }}>
                <img src={src} alt="" width={72} height={72} style={{ objectFit: 'cover', borderRadius: 8 }} />
                <button type="button" className="btn small" style={{ position: 'absolute', top: -8, right: -8, minHeight: 24, padding: '0 6px' }} onClick={() => setImages(images.filter((x) => x !== src))} aria-label="Remove photo">×</button>
              </span>
            ))}
            <label className="btn small">{uploading ? 'Uploading…' : 'Add photos'}<input type="file" accept="image/*" multiple hidden disabled={uploading} onChange={(e) => addPhotos(e.target.files)} /></label>
          </div>
          <span className="tiny muted">Photos are shrunk and stripped of location data on your phone, then stored on a public media server.</span>
        </div>
        <div className="row">
          <Field label="Area"><input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Neighbourhood or city" /></Field>
          <button type="button" className="btn small" style={{ alignSelf: 'end' }} onClick={() => currentArea(5).then((g) => (setGeohash(g), toast('Area set (to about 5 km).')), (e: Error) => toast(e.message))}>{geohash ? '📍 Set' : 'Use my area'}</button>
        </div>
        <div className="stack">
          <strong className="small">How it changes hands</strong>
          <div className="chips">
            {(Object.keys(FULFILLMENT_LABELS) as Fulfillment[]).map((f) => (
              <button key={f} type="button" className="chip" aria-pressed={fulfillment.includes(f)} onClick={() => setFulfillment(fulfillment.includes(f) ? fulfillment.filter((x) => x !== f) : [...fulfillment, f])}>{FULFILLMENT_LABELS[f]}</button>
            ))}
          </div>
        </div>
        {store && <p className="small muted">This will appear in your store, {store.name}.</p>}
        <button type="button" className="btn primary block" disabled={!title.trim() || !description.trim() || uploading || (type !== 'request' && !/^\d+(\.\d{1,2})?$/.test(price))} onClick={() => publishListing()}>
          {type === 'request' ? 'Post request' : 'Publish listing'}
        </button>
        <p className="tiny muted">Listings are public on Nostr. Don’t list anything illegal; reports and filters apply to the market too.</p>
      </div>
      {payout && <PayoutSheet onClose={() => setPayout(false)} onSaved={(a) => publishListing(a)} />}
    </>
  );
}

export function StoreEditor() {
  const { account, navigate, toast } = useApp();
  const [kind, setKind] = useState<StoreKind>('shop');
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const [hours, setHours] = useState('');
  const [location, setLocation] = useState('');
  const [geohash, setGeohash] = useState<string>();
  const [fulfillment, setFulfillment] = useState<Fulfillment[]>(['pickup']);
  const [open, setOpen] = useState(true);
  const [payout, setPayout] = useState(false);

  useEffect(() => {
    query({ kinds: [KIND.store], authors: [account.pubkey], limit: 1 }, 3000).then(async ([ev]) => {
      const s = ev && parseStore(ev, await pqKeys([account.pubkey]));
      if (!s) return;
      setKind(s.kind); setName(s.name); setAbout(s.about); setHours(s.hours ?? ''); setLocation(s.location ?? ''); setGeohash(s.geohash); setFulfillment(s.fulfillment); setOpen(s.open);
    }, () => undefined);
  }, [account.pubkey]);

  async function save_(payTo = payoutAddress()) {
    if (!payTo) return setPayout(true);
    try {
      await publish(createStore(account.nostrKey, account.pq, { slug: 'store', kind, name, about, hours: hours || undefined, location: location || undefined, geohash, fulfillment, payTo: { rail: RAIL, address: payTo }, open }));
      toast('Your store is live. Listings you add now appear in it.');
      navigate(storePath(`${KIND.store}:${account.pubkey}:store`));
    } catch (e) {
      toast((e as Error).message);
    }
  }

  return (
    <>
      <TopBar title="Your store" back={() => navigate('/create')} />
      <div className="page">
        <Segmented value={kind} onChange={setKind} options={[['shop', 'Shop'], ['restaurant', 'Restaurant'], ['services', 'Services']]} />
        <Field label="Name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
        <Field label="About"><textarea value={about} onChange={(e) => setAbout(e.target.value)} /></Field>
        <Field label="Hours" hint="For example: Mon–Fri 11–9, Sat 12–10"><input type="text" value={hours} onChange={(e) => setHours(e.target.value)} /></Field>
        <div className="row">
          <Field label="Area"><input type="text" value={location} onChange={(e) => setLocation(e.target.value)} /></Field>
          <button type="button" className="btn small" style={{ alignSelf: 'end' }} onClick={() => currentArea(5).then(setGeohash, (e: Error) => toast(e.message))}>{geohash ? '📍 Set' : 'Use my area'}</button>
        </div>
        <div className="chips">
          {(Object.keys(FULFILLMENT_LABELS) as Fulfillment[]).map((f) => (
            <button key={f} type="button" className="chip" aria-pressed={fulfillment.includes(f)} onClick={() => setFulfillment(fulfillment.includes(f) ? fulfillment.filter((x) => x !== f) : [...fulfillment, f])}>{FULFILLMENT_LABELS[f]}</button>
          ))}
        </div>
        <label className="switch card"><span><strong>Taking orders now</strong></span><input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /></label>
        {kind === 'restaurant' && <p className="small muted">Add menu items as Food listings. Keep Fairground open on a phone or tablet at the counter to see orders as they come in.</p>}
        <button type="button" className="btn primary block" disabled={!name.trim()} onClick={() => save_()}>Publish store</button>
      </div>
      {payout && <PayoutSheet onClose={() => setPayout(false)} onSaved={(a) => save_(a)} />}
    </>
  );
}

export function StorePage({ address }: { address: string }) {
  const { account, navigate } = useApp();
  const [owner] = address.split(':').slice(1, 2);
  const [store, setStore] = useState<Store | null>();
  const { events } = useEvents(/^[0-9a-f]{64}$/.test(owner ?? '') ? { kinds: [KIND.listing], authors: [owner], limit: 200 } : null);
  const [cart, setCart] = useState<Map<string, number>>(new Map());
  const [checkout, setCheckout] = useState(false);
  const record = useSellerRecord(owner, store ? [store.payTo.address] : []);

  useEffect(() => {
    const [, pubkey, ...rest] = address.split(':');
    query({ kinds: [KIND.store], authors: [pubkey], '#d': [rest.join(':')] }, 4000).then(async (list) => {
      const ev = list.sort((a, b) => b.created_at - a.created_at)[0];
      setStore(ev ? parseStore(ev, await pqKeys([pubkey])) ?? null : null);
    }, () => setStore(null));
  }, [address]);

  const listings = useMemo(() => {
    const newest = new Map<string, Listing>();
    for (const ev of events) {
      const l = parseListing(ev, () => undefined);
      if (l && l.status === 'active' && safeListing(l) && (!l.store || l.store === address)) {
        const prev = newest.get(l.address);
        if (!prev || prev.event.created_at < ev.created_at) newest.set(l.address, l);
      }
    }
    return [...newest.values()];
  }, [events, address]);

  const groups = useMemo(() => {
    const byGroup = new Map<string, Listing[]>();
    for (const l of listings) {
      const group = l.categories.find((c) => !LISTING_TYPES.includes(c as ListingType)) ?? TYPE_LABELS[l.type];
      byGroup.set(group, [...(byGroup.get(group) ?? []), l]);
    }
    return [...byGroup];
  }, [listings]);

  if (store === undefined) return <><TopBar title="Store" back={() => history.back()} /><div className="skeleton" /></>;
  if (store === null) return <><TopBar title="Store" back={() => history.back()} /><p className="page muted">This store isn’t available.</p></>;
  const lines: OrderLine[] = [...cart].map(([addr, quantity]) => {
    const l = listings.find((x) => x.address === addr)!;
    return { listing: addr, title: l.title, quantity, unitPrice: priceMicros(l.price!).toString() };
  });
  const buyable = (l: Listing) => l.price?.currency === 'USD' && l.type !== 'request' && store.pqVerified;
  return (
    <>
      <TopBar title={store.name} back={() => history.back()} />
      <div className="page">
        <div className="card stack">
          <div className="row between"><strong>{store.kind === 'restaurant' ? 'Restaurant' : store.kind === 'shop' ? 'Shop' : 'Services'}</strong><span className={`badge${store.open ? ' good' : ''}`}>{store.open ? 'Open for orders' : 'Closed'}</span></div>
          {store.about && <p style={{ margin: 0 }}>{store.about}</p>}
          <p className="small muted" style={{ margin: 0 }}>{[store.hours, store.location, store.fulfillment.map((f) => FULFILLMENT_LABELS[f]).join(' · ')].filter(Boolean).join(' · ')}</p>
          <button type="button" className="btn small" onClick={() => navigate(`/p/${store.owner}`)}>Run by <Name pubkey={store.owner} /></button>
          <SellerRecord record={record} />
        </div>
        {store.owner === account.pubkey && <button type="button" className="btn" onClick={() => navigate(`/market/new?type=${store.kind === 'restaurant' ? 'food' : store.kind === 'services' ? 'service' : 'item'}`)}>Add {store.kind === 'restaurant' ? 'a menu item' : 'a listing'}</button>}
        {groups.map(([group, items]) => (
          <div key={group} className="stack">
            <h2>{group}</h2>
            {items.map((l) => (
              <div key={l.address} className="card row">
                {l.images[0] && <img src={l.images[0]} alt="" width={64} height={64} style={{ objectFit: 'cover', borderRadius: 8 }} referrerPolicy="no-referrer" />}
                <button type="button" className="grow" style={{ textAlign: 'left', background: 'none', border: 0, cursor: 'pointer', color: 'inherit' }} onClick={() => navigate(listingPath(l.address))}>
                  <strong>{l.title}</strong><br /><span className="small muted">{formatPrice(l.price)}</span>
                </button>
                {store.open && buyable(l) && (
                  <span className="row" style={{ gap: 4 }}>
                    {cart.get(l.address) ? <button type="button" className="btn small" onClick={() => setCart(new Map(cart).set(l.address, cart.get(l.address)! - 1))} aria-label={`One fewer ${l.title}`}>−</button> : null}
                    {cart.get(l.address) ? <span>{cart.get(l.address)}</span> : null}
                    <button type="button" className="btn small" onClick={() => setCart(new Map(cart).set(l.address, (cart.get(l.address) ?? 0) + 1))} aria-label={`Add ${l.title}`}>+</button>
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
        {!listings.length && <p className="muted center">Nothing listed yet.</p>}
        {lines.some((l) => l.quantity > 0) && (
          <button type="button" className="btn primary block" style={{ position: 'sticky', bottom: 'calc(var(--tabbar) + 12px)' }} onClick={() => setCheckout(true)}>
            Order · {usd(orderTotal(lines.filter((l) => l.quantity > 0)))}
          </button>
        )}
      </div>
      {checkout && <OrderSheet seller={store.owner} payTo={store.payTo} title={store.name} options={store.fulfillment.length ? store.fulfillment : ['pickup']} lines={lines.filter((l) => l.quantity > 0)} onClose={() => (setCheckout(false), setCart(new Map()))} />}
    </>
  );
}

/** Pays for an accepted quote: it becomes an order like any other. */
export function useAcceptQuote() {
  const { account, toast, navigate } = useApp();
  const [paying, setPaying] = useState<{ quote: Quote; helper: string; order: Order } | null>(null);
  async function accept(quote: Quote, helper: string) {
    const { orderId, nonce } = newOrderId(account.pubkey);
    const lines = [{ listing: quote.listing, title: quote.title, quantity: 1, unitPrice: quote.amount }];
    const order: Order = { type: 'fairground/order', orderId, lines, total: quote.amount, fulfillment: 'onsite', note: 'Accepted your offer', payTo: quote.payTo };
    try {
      await sendMessage(account, helper, `Accepted your offer for “${quote.title}” ($${formatUsd(BigInt(quote.amount))}).`, order);
      save('orders', [...load<StoredOrder[]>('orders', []), { order, nonce, seller: helper, at: nowSeconds() }]);
      setPaying({ quote, helper, order });
    } catch (e) {
      toast((e as Error).message);
    }
  }
  const dialog = paying && (
    <PayDialog title={`Pay for ${paying.quote.title}`} request={{ to: paying.quote.payTo.address, amount: BigInt(paying.quote.amount), memo: MEMO.order(paying.order.orderId) }}
      onClose={() => setPaying(null)}
      onPaid={async (t) => {
        save('orders', load<StoredOrder[]>('orders', []).map((s) => (s.order.orderId === paying.order.orderId ? { ...s, txid: t.id } : s)));
        await sendMessage(account, paying.helper, `Paid $${formatUsd(t.amount)}`, { type: 'fairground/order-paid', orderId: paying.order.orderId, txid: t.id }).catch(() => undefined);
        setPaying(null);
        toast('Paid. Track it in Orders.');
        navigate('/orders');
      }} />
  );
  return { accept, dialog };
}
