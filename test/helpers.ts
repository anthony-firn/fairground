import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import { createPqBinding, generatePqKeys, type PqKeys } from '../src/pq.ts';

export interface Actor {
  nostrKey: Uint8Array;
  pubkey: string;
  pq: PqKeys;
  binding: Event;
}

export function actor(created_at = 1_780_000_000): Actor {
  const nostrKey = generateSecretKey();
  const pq = generatePqKeys();
  return { nostrKey, pubkey: getPublicKey(nostrKey), pq, binding: createPqBinding(nostrKey, pq, undefined, created_at) };
}

/** A copy as it would arrive from a relay: plain JSON, without nostr-tools' cached verification flag. */
export const fromRelay = <T>(ev: T): T => JSON.parse(JSON.stringify(ev));

export const DAY = 86_400;
