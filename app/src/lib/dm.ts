/**
 * Private messages (NIP-17): each message is sealed and gift-wrapped separately for the recipient and for the sender,
 * so relays see neither the content nor who is talking to whom. Orders, quotes and status updates ride along as a
 * `fairground` tag, with readable text for other Nostr apps.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import * as nip59 from 'nostr-tools/nip59';
import { finalizeEvent, type Event } from 'nostr-tools/pure';
import type { Account } from './account.ts';
import { publishTo, query, relays, subscribe } from './net.ts';

export interface Message {
  id: string;
  from: string;
  to: string;
  text: string;
  at: number;
  /** Parsed `fairground` payload, if any: an order, quote or order update. */
  data?: unknown;
}

const messages = new Map<string, Message>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => {
  version++;
  listeners.forEach((l) => l());
};

/** Where to deliver messages for `pubkey`: their NIP-17 relays, else their relay list, else ours. */
async function inboxRelays(pubkey: string): Promise<string[]> {
  const [dm] = (await query({ kinds: [10050], authors: [pubkey], limit: 1 }, 3000)).sort((a, b) => b.created_at - a.created_at);
  const listed = dm?.tags.filter((t) => t[0] === 'relay' && /^wss?:\/\//.test(t[1] ?? '')).map((t) => t[1]) ?? [];
  if (listed.length) return listed.slice(0, 4);
  const [general] = (await query({ kinds: [10002], authors: [pubkey], limit: 1 }, 3000)).sort((a, b) => b.created_at - a.created_at);
  const read = general?.tags.filter((t) => t[0] === 'r' && t[1] && t[2] !== 'write').map((t) => t[1]) ?? [];
  return read.length ? read.slice(0, 4) : relays();
}

export async function sendMessage(account: Account, to: string, text: string, data?: unknown): Promise<void> {
  const tags = [['p', to]];
  if (data !== undefined) tags.push(['fairground', JSON.stringify(data)]);
  const rumor = { kind: 14, content: text, tags, created_at: Math.floor(Date.now() / 1000) };
  const forThem = nip59.wrapEvent(rumor, account.nostrKey, to);
  const forMe = nip59.wrapEvent(rumor, account.nostrKey, account.pubkey);
  await publishTo(await inboxRelays(to), forThem);
  await publishTo(relays(), forMe).catch(() => undefined);
  remember({ id: forMe.id, pubkey: account.pubkey, created_at: rumor.created_at, kind: 14, tags, content: text }, account.pubkey);
}

function remember(rumor: { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string }, me: string) {
  if (rumor.kind !== 14) return;
  const to = rumor.tags.find((t) => t[0] === 'p')?.[1] ?? me;
  const key = `${rumor.pubkey}:${rumor.created_at}:${rumor.content}`;
  if ([...messages.values()].some((m) => `${m.from}:${m.at}:${m.text}` === key)) return;
  let data: unknown;
  try {
    const raw = rumor.tags.find((t) => t[0] === 'fairground')?.[1];
    data = raw ? JSON.parse(raw) : undefined;
  } catch {
    data = undefined;
  }
  messages.set(rumor.id, { id: rumor.id, from: rumor.pubkey, to, text: rumor.content.slice(0, 5000), at: rumor.created_at, data });
  notify();
}

let started = false;

/** Starts receiving this account's messages; relays that require it get a NIP-42 sign-in. */
export function startInbox(account: Account): () => void {
  if (started) return () => undefined;
  started = true;
  const onauth = async (evt: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(evt, account.nostrKey);
  const stop = subscribe({ kinds: [1059], '#p': [account.pubkey] }, (wrap: Event) => {
    try {
      remember(nip59.unwrapEvent(wrap, account.nostrKey), account.pubkey);
    } catch {
      // Not for us, or tampered with.
    }
  }, undefined, { onauth });
  return () => {
    started = false;
    stop();
  };
}

export function useMessages(): Message[] {
  useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => version);
  const [list, setList] = useState<Message[]>([]);
  useEffect(() => {
    setList([...messages.values()].sort((a, b) => a.at - b.at));
  }, [version]);
  return list;
}
