/**
 * Hybrid post-quantum signatures for Nostr events.
 *
 * Nostr signs every event with secp256k1 Schnorr, which a large quantum computer could forge. Fairground keeps that
 * signature, so every Nostr client still accepts the event, and adds an ML-DSA-65 (FIPS 204) signature in a `pq` tag.
 * The ML-DSA signature covers the NIP-01 serialization of the event without its `pq` tags; the Schnorr signature
 * covers everything, including the ML-DSA signature.
 *
 * An author's ML-DSA key is published in a key-binding event while Schnorr is still trustworthy. Rotations are signed
 * by the previous ML-DSA key, so the chain stays verifiable after Schnorr falls.
 */
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { finalizeEvent, getPublicKey, verifyEvent, type Event, type EventTemplate } from 'nostr-tools/pure';
import { KIND, PROTOCOL } from './kinds.ts';
import { byTime, markedEvent, now, tagValue } from './tags.ts';

export const PQ_ALG = 'ml-dsa-65';
const CONTEXT = utf8ToBytes(PROTOCOL);
const PQ_TAGS = new Set(['pq', 'pq-prev']);

export interface PqKeys {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** Returns an author's resolved ML-DSA public key, or undefined when they have none. */
export type KeyLookup = (pubkey: string) => Uint8Array | undefined;

/**
 * Never derive the seed from the Nostr key: a quantum attacker who recovers that key from its public half would
 * recover this one too.
 */
export function generatePqKeys(seed: Uint8Array = randomBytes(32)): PqKeys {
  return ml_dsa65.keygen(seed);
}

function message(pubkey: string, ev: EventTemplate): Uint8Array {
  const tags = ev.tags.filter((t) => !PQ_TAGS.has(t[0]));
  return sha256(utf8ToBytes(JSON.stringify([0, pubkey, ev.created_at, ev.kind, tags, ev.content])));
}

const pqSign = (pubkey: string, ev: EventTemplate, keys: PqKeys): string =>
  base64.encode(ml_dsa65.sign(message(pubkey, ev), keys.secretKey, { context: CONTEXT }));

/** Signs with both keys. `previous` adds a `pq-prev` signature, which a key rotation needs. */
export function signHybrid(template: EventTemplate, nostrKey: Uint8Array, pq: PqKeys, previous?: PqKeys): Event {
  const pubkey = getPublicKey(nostrKey);
  const base = { ...template, tags: template.tags.filter((t) => !PQ_TAGS.has(t[0])) };
  const tags = [...base.tags, ['pq', PQ_ALG, pqSign(pubkey, base, pq)]];
  if (previous) tags.push(['pq-prev', PQ_ALG, pqSign(pubkey, base, previous)]);
  return finalizeEvent({ ...base, tags }, nostrKey);
}

/** The signature in exactly one `name` tag for our algorithm; anything else is treated as unsigned. */
function pqSignature(ev: Event, name: string): Uint8Array | undefined {
  const found = ev.tags.filter((t) => t[0] === name);
  if (found.length !== 1 || found[0][1] !== PQ_ALG || !found[0][2]) return undefined;
  try {
    return base64.decode(found[0][2]);
  } catch {
    return undefined;
  }
}

export function verifyPq(ev: Event, publicKey: Uint8Array, tagName = 'pq'): boolean {
  const sig = pqSignature(ev, tagName);
  if (!sig) return false;
  try {
    return ml_dsa65.verify(sig, message(ev.pubkey, ev), publicKey, { context: CONTEXT });
  } catch {
    return false;
  }
}

export const verifyHybrid = (ev: Event, publicKey: Uint8Array): boolean => verifyEvent(ev) && verifyPq(ev, publicKey);

/** Publishes `pq` as the author's key. A rotation names the binding it replaces and is also signed by that key. */
export function createPqBinding(
  nostrKey: Uint8Array,
  pq: PqKeys,
  previous?: { binding: Event; keys: PqKeys },
  created_at = now(),
): Event {
  const tags = [['alg', PQ_ALG], ['key', base64.encode(pq.publicKey)]];
  if (previous) tags.push(['e', previous.binding.id, '', 'prev']);
  return signHybrid({ kind: KIND.pqBinding, created_at, content: '', tags }, nostrKey, pq, previous?.keys);
}

function bindingKey(ev: Event): Uint8Array | undefined {
  if (tagValue(ev, 'alg') !== PQ_ALG) return undefined;
  try {
    const key = base64.decode(tagValue(ev, 'key') ?? '');
    return key.length === ml_dsa65.lengths.publicKey ? key : undefined;
  } catch {
    return undefined;
  }
}

export interface PqKeyResolution {
  key: Uint8Array;
  binding: Event;
  /**
   * The author has competing bindings for different keys: more than one starting key, or a fork in the rotations.
   * Republishing the same key is not a conflict. The oldest wins here;
   * once Schnorr can be forged, only an anchored timestamp (NIP-03) on the first binding settles it.
   */
  conflict: boolean;
}

/** Follows an author's bindings from their oldest starting key through each rotation the previous key signed. */
export function resolvePqKey(events: Event[], author: string): PqKeyResolution | undefined {
  const valid = events.filter((e) => {
    if (e.kind !== KIND.pqBinding || e.pubkey !== author) return false;
    const key = bindingKey(e);
    return key !== undefined && verifyHybrid(e, key);
  });
  const starts = valid.filter((e) => !markedEvent(e, 'prev')).sort(byTime);
  if (!starts.length) return undefined;

  let binding = starts[0];
  let key = bindingKey(binding)!;
  const distinctKeys = (bindings: Event[]) => new Set(bindings.map((b) => tagValue(b, 'key'))).size;
  let conflict = distinctKeys(starts) > 1;
  const seen = new Set([binding.id]);
  for (;;) {
    const next = valid
      .filter((e) => markedEvent(e, 'prev') === binding.id && !seen.has(e.id) && verifyPq(e, key, 'pq-prev'))
      .sort(byTime);
    if (!next.length) break;
    conflict ||= distinctKeys(next) > 1;
    binding = next[0];
    key = bindingKey(binding)!;
    seen.add(binding.id);
  }
  return { key, binding, conflict };
}

/** A lookup over every binding a client has seen; rebuild it when new bindings arrive. */
export function keyLookup(bindings: Event[]): KeyLookup {
  const cache = new Map<string, Uint8Array | undefined>();
  return (pubkey) => {
    if (!cache.has(pubkey)) cache.set(pubkey, resolvePqKey(bindings, pubkey)?.key);
    return cache.get(pubkey);
  };
}
