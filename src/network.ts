/**
 * The Fairground network.
 *
 * Fairground signs and stores events the way Nostr does, but it is its own network: readers see only Fairground
 * accounts, never the wider Nostr network. An account joins by publishing its post-quantum key binding (kind 3470),
 * which every Fairground account does on its first start, so the bindings on the relays are the member directory.
 */
import type { Event } from 'nostr-tools/pure';
import { KIND, PQ_ALG } from './kinds.ts';
import { tagValue } from './tags.ts';

/** Base64 length of an ML-DSA-65 public key (1952 bytes). */
const PQ_KEY_LENGTH = 2604;

/** A key binding with the shape Fairground publishes. The post-quantum signature is checked where it matters (deals). */
export const isMembership = (ev: Event): boolean =>
  ev.kind === KIND.pqBinding && tagValue(ev, 'alg') === PQ_ALG && tagValue(ev, 'key')?.length === PQ_KEY_LENGTH;

export function membersFrom(bindings: Event[]): Set<string> {
  return new Set(bindings.filter(isMembership).map((ev) => ev.pubkey));
}
