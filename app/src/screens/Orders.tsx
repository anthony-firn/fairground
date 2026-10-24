/**
 * Orders, both ways. Buyers follow status updates from the seller and review once an order is paid and complete;
 * sellers see incoming orders, check payment on the chain, and send status updates. All of it travels as private
 * messages; payments go wallet to wallet.
 */
import { useEffect, useState } from 'react';
import {
  createReview,
  orderPayment,
  parseOrder,
  parseOrderUpdate,
  type Order,
  type OrderStatus,
} from '@core/commerce.ts';
import { algorandUsdc, RAIL } from '@core/rails/algorand.ts';
import { Field, Name, Segmented, Sheet, TopBar } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { sendMessage, useMessages, type Message } from '../lib/dm.ts';
import { timeAgo, usd } from '../lib/format.ts';
import { publish } from '../lib/net.ts';
import { load, save } from '../lib/storage.ts';
import type { StoredOrder } from './Market.tsx';

const STATUS_LABELS: Record<OrderStatus | 'placed', string> = {
  placed: 'Sent to seller', accepted: 'Accepted', declined: 'Declined', ready: 'Ready', 'on-the-way': 'On the way', completed: 'Completed', cancelled: 'Cancelled',
};

/** The latest status update for an order, from whoever is allowed to send it. */
function latestStatus(messages: Message[], orderId: string, from: string): OrderStatus | undefined {
  return messages.filter((m) => m.from === from).map((m) => parseOrderUpdate(m.data)).filter((u) => u?.orderId === orderId).at(-1)?.status;
}

function ReviewSheet({ stored, onClose }: { stored: StoredOrder; onClose: () => void }) {
  const { account, toast } = useApp();
  const [rating, setRating] = useState<1 | 2 | 3 | 4 | 5>(5);
  const [text, setText] = useState('');
  async function submit() {
    try {
      await publish(createReview(account.nostrKey, account.pq, {
        seller: stored.seller, subject: stored.order.lines[0]?.listing, rating, text, rail: RAIL, txid: stored.txid!, orderId: stored.order.orderId, nonce: stored.nonce,
      }));
      save('orders', load<StoredOrder[]>('orders', []).map((s) => (s.order.orderId === stored.order.orderId ? { ...s, reviewed: true } : s)));
      toast('Thanks. Your review is tied to your payment, so others can trust it.');
      onClose();
    } catch (e) {
      toast((e as Error).message);
    }
  }
  return (
    <Sheet title="Leave a review" onClose={onClose}>
      <div className="stars" role="radiogroup" aria-label="Rating">
        {([1, 2, 3, 4, 5] as const).map((n) => (
          <button key={n} type="button" className={n <= rating ? 'on' : ''} role="radio" aria-checked={rating === n} aria-label={`${n} stars`} onClick={() => setRating(n)}>★</button>
        ))}
      </div>
      <Field label="What was it like?"><textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} /></Field>
      <button type="button" className="btn primary block" onClick={submit}>Post review</button>
      <p className="tiny muted">Public, and linked to your payment so it counts as a verified order. Your payment stays anonymous until you post this.</p>
    </Sheet>
  );
}

function Buying() {
  const messages = useMessages();
  const [orders, setOrders] = useState(() => load<StoredOrder[]>('orders', []).slice().reverse());
  const [reviewing, setReviewing] = useState<StoredOrder>();
  if (!orders.length) return <p className="muted center">Nothing ordered yet. Find something in the Market.</p>;
  return (
    <>
      {orders.map((o) => {
        const status = latestStatus(messages, o.order.orderId, o.seller) ?? 'placed';
        return (
          <div key={o.order.orderId} className="card stack">
            <div className="row between"><strong><Name pubkey={o.seller} /></strong><span className={`badge${status === 'completed' ? ' good' : status === 'declined' || status === 'cancelled' ? ' bad' : ' warn'}`}>{STATUS_LABELS[status]}</span></div>
            <span className="small">{o.order.lines.map((l) => `${l.quantity}× ${l.title}`).join(', ')}</span>
            <span className="small muted">{usd(BigInt(o.order.total))} · {o.txid ? 'paid' : 'not paid yet'} · {timeAgo(o.at)}</span>
            {status === 'completed' && o.txid && !o.reviewed && <button type="button" className="btn small" onClick={() => setReviewing(o)}>Leave a review</button>}
          </div>
        );
      })}
      {reviewing && <ReviewSheet stored={reviewing} onClose={() => (setReviewing(undefined), setOrders(load<StoredOrder[]>('orders', []).slice().reverse()))} />}
    </>
  );
}

function IncomingOrder({ order, buyer, at, messages }: { order: Order; buyer: string; at: number; messages: Message[] }) {
  const { account, toast } = useApp();
  const [paid, setPaid] = useState<bigint>();
  const status = latestStatus(messages, order.orderId, account.pubkey);
  useEffect(() => {
    orderPayment(order, algorandUsdc, at).then((p) => setPaid(p.paid), () => undefined);
  }, [order, at]);
  async function update(next: OrderStatus) {
    try {
      await sendMessage(account, buyer, `Your order is ${STATUS_LABELS[next].toLowerCase()}.`, { type: 'fairground/order-status', orderId: order.orderId, status: next });
      toast(`Marked ${STATUS_LABELS[next].toLowerCase()}`);
    } catch (e) {
      toast((e as Error).message);
    }
  }
  const nextSteps: OrderStatus[] = !status ? ['accepted', 'declined'] : status === 'accepted' ? ['ready', 'on-the-way', 'completed'] : status === 'ready' || status === 'on-the-way' ? ['completed'] : [];
  return (
    <div className="card stack">
      <div className="row between"><strong><Name pubkey={buyer} /></strong><span className="badge">{status ? STATUS_LABELS[status] : 'New'}</span></div>
      {order.lines.map((l) => <span key={l.listing} className="small">{l.quantity}× {l.title}</span>)}
      <span className="small">{usd(BigInt(order.total))} · {order.fulfillment} · {timeAgo(at)}</span>
      {order.note && <p className="small" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{order.note}</p>}
      <span className={`small ${paid !== undefined && paid >= BigInt(order.total) ? 'good' : 'warn'}`}>
        {paid === undefined ? 'Checking payment…' : paid >= BigInt(order.total) ? `Paid ${usd(paid)}, confirmed on the chain` : paid > 0n ? `Partly paid: ${usd(paid)}` : 'Not paid yet'}
      </span>
      <div className="row wrap">{nextSteps.map((s) => <button key={s} type="button" className={`btn small${s === 'declined' ? '' : ' primary'}`} onClick={() => update(s)}>{STATUS_LABELS[s]}</button>)}</div>
    </div>
  );
}

function Selling() {
  const { account } = useApp();
  const messages = useMessages();
  const incoming = messages.filter((m) => m.to === account.pubkey && m.from !== account.pubkey)
    .map((m) => ({ m, order: parseOrder(m.data) }))
    .filter((x): x is { m: Message; order: Order } => !!x.order && x.order.payTo.rail === RAIL)
    .reverse();
  if (!incoming.length) return <p className="muted center">No orders yet. Keep the app open to see new ones as they arrive.</p>;
  return <>{incoming.map(({ m, order }) => <IncomingOrder key={order.orderId} order={order} buyer={m.from} at={m.at} messages={messages} />)}</>;
}

export function Orders() {
  const [tab, setTab] = useState<'buying' | 'selling'>('buying');
  return (
    <>
      <TopBar title="Orders" back={() => history.back()} />
      <div className="page">
        <Segmented value={tab} onChange={setTab} options={[['buying', 'Buying'], ['selling', 'Selling']]} />
        {tab === 'buying' ? <Buying /> : <Selling />}
        <p className="tiny muted center">Totals are in USDC. Payments go wallet to wallet and Fairground holds nothing; orders are private messages between you and the other person.</p>
      </div>
    </>
  );
}
