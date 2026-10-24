/**
 * The reader's account, created silently on first launch so nobody has to understand keys to start. The backup code
 * holds the Nostr secret key and the post-quantum seed; the key binding can always be made again from them.
 */
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { decode, nsecEncode } from 'nostr-tools/nip19';
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import { createPqBinding, generatePqKeys, type PqKeys } from '@core/pq.ts';
import { load, save } from './storage.ts';

export interface Account {
  nostrKey: Uint8Array;
  pubkey: string;
  pq: PqKeys;
  binding: Event;
}

interface Stored {
  nostrKey: string;
  pqSeed: string;
  binding: Event;
}

function build(stored: Stored): Account {
  const nostrKey = hexToBytes(stored.nostrKey);
  return { nostrKey, pubkey: getPublicKey(nostrKey), pq: generatePqKeys(hexToBytes(stored.pqSeed)), binding: stored.binding };
}

function create(nostrKey: Uint8Array, pqSeed = randomBytes(32)): Stored {
  return { nostrKey: bytesToHex(nostrKey), pqSeed: bytesToHex(pqSeed), binding: createPqBinding(nostrKey, generatePqKeys(pqSeed)) };
}

export function loadOrCreateAccount(): { account: Account; isNew: boolean } {
  const stored = load<Stored | null>('account', null);
  if (stored) return { account: build(stored), isNew: false };
  const fresh = create(generateSecretKey());
  save('account', fresh);
  return { account: build(fresh), isNew: true };
}

export function backupCode(account: Account): string {
  const stored = load<Stored | null>('account', null);
  return `fairground:${nsecEncode(account.nostrKey)}:${stored?.pqSeed ?? ''}`;
}

/** Accepts a Fairground backup code, or a bare `nsec` from another Nostr app (which gets a new post-quantum key). */
export function restoreAccount(code: string): Account {
  const [prefix, nsec, seed] = code.trim().split(':');
  const bech = prefix === 'fairground' ? nsec : prefix;
  const decoded = decode(bech);
  if (decoded.type !== 'nsec') throw new Error('That isn’t a backup code or an nsec key.');
  const stored = create(decoded.data, seed && /^[0-9a-f]{64}$/.test(seed) ? hexToBytes(seed) : undefined);
  save('account', stored);
  return build(stored);
}
