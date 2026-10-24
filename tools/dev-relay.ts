/**
 * A minimal in-memory Nostr relay (NIP-01, NIP-11) for local development and end-to-end tests, so nothing test-made
 * reaches public relays. Not for production.
 *
 *   node tools/dev-relay.ts [port]          # ws://localhost:7777 by default
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { matchFilter, matchFilters, type Filter } from 'nostr-tools/filter';
import { verifyEvent, type Event } from 'nostr-tools/pure';
import { WebSocketServer, type WebSocket } from 'ws';

const isReplaceable = (k: number) => k === 0 || k === 3 || (k >= 10000 && k < 20000);
const isAddressable = (k: number) => k >= 30000 && k < 40000;
const isEphemeral = (k: number) => k >= 20000 && k < 30000;
const dTag = (e: Event) => e.tags.find((t) => t[0] === 'd')?.[1] ?? '';

export interface DevRelay {
  url: string;
  events: Event[];
  close(): Promise<void>;
}

export function startDevRelay(port = 7777, info: { pubkey?: string } = {}): Promise<DevRelay> {
  const events: Event[] = [];
  const subscriptions = new Map<WebSocket, Map<string, Filter[]>>();

  const http = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/nostr+json');
    res.end(JSON.stringify({ name: 'Fairground dev relay', pubkey: info.pubkey, supported_nips: [1, 11] }));
  });
  const wss = new WebSocketServer({ server: http });

  /** Stores an event, keeping only the newest replaceable or addressable version. Returns false if it's outdated. */
  function store(ev: Event): boolean {
    if (isEphemeral(ev.kind)) return true;
    if (isReplaceable(ev.kind) || isAddressable(ev.kind)) {
      const same = (e: Event) => e.kind === ev.kind && e.pubkey === ev.pubkey && (!isAddressable(ev.kind) || dTag(e) === dTag(ev));
      const existing = events.findIndex(same);
      if (existing >= 0) {
        if (events[existing].created_at > ev.created_at) return false;
        events.splice(existing, 1);
      }
    }
    events.push(ev);
    return true;
  }

  wss.on('connection', (ws) => {
    const subs = new Map<string, Filter[]>();
    subscriptions.set(ws, subs);
    const send = (msg: unknown[]) => ws.send(JSON.stringify(msg));
    ws.on('message', (raw) => {
      let msg: unknown[];
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return send(['NOTICE', 'invalid JSON']);
      }
      if (msg[0] === 'EVENT') {
        const ev = msg[1] as Event;
        if (!verifyEvent(ev)) return send(['OK', ev?.id ?? '', false, 'invalid: bad signature']);
        if (events.some((e) => e.id === ev.id)) return send(['OK', ev.id, true, 'duplicate: already have it']);
        if (!store(ev)) return send(['OK', ev.id, false, 'invalid: a newer version exists']);
        send(['OK', ev.id, true, '']);
        for (const [client, clientSubs] of subscriptions) {
          for (const [id, filters] of clientSubs) if (matchFilters(filters, ev)) client.send(JSON.stringify(['EVENT', id, ev]));
        }
      } else if (msg[0] === 'REQ') {
        const [, id, ...filters] = msg as [string, string, ...Filter[]];
        subs.set(id, filters);
        const sent = new Set<string>();
        for (const f of filters) {
          const matched = events.filter((e) => matchFilter(f, e)).sort((a, b) => b.created_at - a.created_at);
          for (const e of f.limit === undefined ? matched : matched.slice(0, f.limit)) {
            if (!sent.has(e.id)) sent.add(e.id) && send(['EVENT', id, e]);
          }
        }
        send(['EOSE', id]);
      } else if (msg[0] === 'CLOSE') {
        subs.delete(msg[1] as string);
      }
    });
    ws.on('close', () => subscriptions.delete(ws));
  });

  return new Promise((resolve) => {
    http.listen(port, () => resolve({
      url: `ws://localhost:${port}`,
      events,
      close: () => new Promise<void>((done) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => http.close(() => done()));
      }),
    }));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const relay = await startDevRelay(Number(process.argv[2] ?? 7777), { pubkey: process.env.RELAY_OPERATOR });
  console.log(`Dev relay listening on ${relay.url}`);
}
