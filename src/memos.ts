/**
 * Payment memos. Each one says what a transfer is for, so anyone can total and check every flow from the public chain:
 * deals, fan support, donations to relays and to development, and relays passing support on to creators.
 */

/** `wss://Relay.Example.com/` and `wss://relay.example.com` are the same relay. */
export function normalizeRelayUrl(url: string): string {
  const u = new URL(url.trim());
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') throw new Error(`not a relay URL: ${url}`);
  return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
}

export const MEMO = {
  /** A sponsorship payment, naming the acceptance it settles. */
  deal: (acceptanceId: string) => `fairground:deal:${acceptanceId}`,
  /** Support for a creator, from a fan or passed on by a relay. */
  support: (creator: string) => `fairground:support:${creator}`,
  supportPrefix: 'fairground:support:',
  /** A donation to a relay operator for one of their relays. */
  relay: (url: string) => `fairground:relay:${normalizeRelayUrl(url)}`,
  relayPrefix: 'fairground:relay:',
  /** A purchase; the order id commits to the buyer, so only they can later review it (see commerce.ts). */
  order: (orderId: string) => `fairground:order:${orderId}`,
  /** A donation to Fairground's development. */
  development: 'fairground:development',
} as const;
