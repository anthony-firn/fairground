/**
 * Signed HTTP requests (NIP-98): a short-lived Nostr event naming the URL, method and body hash, sent in the
 * Authorization header. Gateways use it to know which Fairground account is asking, without accounts or passwords.
 */
import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64 } from '@scure/base';
import { finalizeEvent, verifyEvent, type Event } from 'nostr-tools/pure';

export const HTTP_AUTH_KIND = 27235;

const payloadHash = (body: string) => bytesToHex(sha256(new TextEncoder().encode(body)));

export function authHeader(nostrKey: Uint8Array, url: string, method: string, body = '', created_at = Math.floor(Date.now() / 1000)): string {
  const tags = [['u', url], ['method', method.toUpperCase()]];
  if (body) tags.push(['payload', payloadHash(body)]);
  const ev = finalizeEvent({ kind: HTTP_AUTH_KIND, created_at, content: '', tags }, nostrKey);
  return `Nostr ${base64.encode(new TextEncoder().encode(JSON.stringify(ev)))}`;
}

/** The pubkey that signed this request, or a reason it can't be trusted. */
export function verifyAuthHeader(header: string | null, url: string, method: string, body = '', now = Math.floor(Date.now() / 1000)): { pubkey: string } | { error: string } {
  if (!header?.startsWith('Nostr ')) return { error: 'missing Nostr authorization' };
  let ev: Event;
  try {
    ev = JSON.parse(new TextDecoder().decode(base64.decode(header.slice(6).trim())));
  } catch {
    return { error: 'malformed authorization' };
  }
  const tag = (name: string) => ev.tags?.find((t) => t[0] === name)?.[1];
  if (ev.kind !== HTTP_AUTH_KIND || !verifyEvent(ev)) return { error: 'authorization is not a valid signed request' };
  if (Math.abs(now - ev.created_at) > 60) return { error: 'authorization has expired' };
  if (tag('u') !== url || tag('method') !== method.toUpperCase()) return { error: 'authorization is for another request' };
  if (body && tag('payload') !== payloadHash(body)) return { error: 'authorization doesn’t match the request body' };
  return { pubkey: ev.pubkey };
}
