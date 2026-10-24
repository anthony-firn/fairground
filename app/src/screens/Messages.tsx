/**
 * Private conversations (NIP-17). Orders, offers and status updates show as cards; an offer can be accepted and paid
 * in one step.
 */
import { useEffect, useRef, useState } from 'react';
import { parseOrder, parseOrderUpdate, parseQuote } from '@core/commerce.ts';
import { Avatar, Name, TopBar } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { sendMessage, useMessages, type Message } from '../lib/dm.ts';
import { timeAgo, usd } from '../lib/format.ts';
import { isBlocked } from '../lib/safety.ts';
import { load } from '../lib/storage.ts';
import { useAcceptQuote } from './Market.tsx';

export function Conversations() {
  const { account, navigate } = useApp();
  const messages = useMessages();
  const muted = new Set(load<string[]>('muted', []));
  const latest = new Map<string, Message>();
  for (const m of messages) {
    const other = m.from === account.pubkey ? m.to : m.from;
    if (muted.has(other) || isBlocked(other)) continue;
    latest.set(other, m);
  }
  const list = [...latest].sort((a, b) => b[1].at - a[1].at);
  return (
    <>
      <TopBar title="Messages" back={() => history.back()} />
      <div className="page">
        {!list.length && <p className="muted center">No messages yet. Message a seller from a listing, or anyone from their profile.</p>}
        <div className="card list">
          {list.map(([other, m]) => (
            <button key={other} type="button" onClick={() => navigate(`/messages/${other}`)}>
              <span className="row grow"><Avatar pubkey={other} /><span className="grow"><Name pubkey={other} /><br /><span className="small muted" style={{ fontWeight: 400 }}>{m.text.split('\n')[0].slice(0, 60)}</span></span></span>
              <span className="tiny muted">{timeAgo(m.at)}</span>
            </button>
          ))}
        </div>
        <p className="tiny muted">Messages are end-to-end encrypted and wrapped so relays can’t see who you’re talking to.</p>
      </div>
    </>
  );
}

function Card({ m, mine, onAccept }: { m: Message; mine: boolean; onAccept: () => void }) {
  const order = parseOrder(m.data);
  const quote = parseQuote(m.data);
  const update = parseOrderUpdate(m.data);
  if (order) return <div className="card small"><strong>Order</strong> · {order.lines.map((l) => `${l.quantity}× ${l.title}`).join(', ')} · {usd(BigInt(order.total))}</div>;
  if (update) return <div className="card small"><strong>Order update:</strong> {update.status.replace('-', ' ')}</div>;
  if (quote) {
    return (
      <div className="card small stack">
        <span><strong>Offer</strong> · {quote.title} · {usd(BigInt(quote.amount))}</span>
        {quote.note && <span>{quote.note}</span>}
        {!mine && <button type="button" className="btn primary small" onClick={onAccept}>Accept and pay {usd(BigInt(quote.amount))}</button>}
      </div>
    );
  }
  return null;
}

export function ConversationThread({ pubkey }: { pubkey: string }) {
  const { account, toast } = useApp();
  const messages = useMessages().filter((m) => (m.from === pubkey && m.to === account.pubkey) || (m.from === account.pubkey && m.to === pubkey));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const { accept, dialog } = useAcceptQuote();
  // scrollIntoView returns a Promise in current browsers; an effect must not return it.
  useEffect(() => {
    end.current?.scrollIntoView();
  }, [messages.length]);
  return (
    <>
      <TopBar title={<Name pubkey={pubkey} />} back={() => history.back()} />
      <div className="page" style={{ gap: 8 }}>
        {!messages.length && <p className="muted center small">Start the conversation. Only the two of you can read it.</p>}
        {messages.map((m) => {
          const mine = m.from === account.pubkey;
          const quote = parseQuote(m.data);
          return (
            <div key={m.id} className="stack" style={{ gap: 4 }}>
              <div className={`bubble${mine ? ' mine' : ''}`}>{m.text}</div>
              <Card m={m} mine={mine} onAccept={() => quote && accept(quote, m.from)} />
              <span className={`tiny muted${mine ? '' : ''}`} style={{ textAlign: mine ? 'right' : 'left' }}>{timeAgo(m.at)}</span>
            </div>
          );
        })}
        <div ref={end} />
        <form className="row" style={{ position: 'sticky', bottom: 'calc(var(--tabbar) + 8px)', background: 'var(--bg)', paddingTop: 8 }} onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await sendMessage(account, pubkey, text.trim());
            setText('');
          } catch (err) {
            toast((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}>
          <input type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Message" aria-label="Message" />
          <button type="submit" className="btn primary" disabled={!text.trim() || busy}>Send</button>
        </form>
      </div>
      {dialog}
    </>
  );
}
