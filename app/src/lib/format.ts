import { npubEncode } from 'nostr-tools/nip19';
import { formatUsd } from '@core/pricing.ts';
import type { Profile } from './hooks.ts';

export const shortKey = (pubkey: string): string => {
  const npub = npubEncode(pubkey);
  return `${npub.slice(0, 10)}…${npub.slice(-4)}`;
};

export const displayName = (pubkey: string, p?: Profile): string => p?.display_name || p?.name || shortKey(pubkey);

export function timeAgo(unix: number, now = Date.now() / 1000): string {
  const s = Math.max(0, now - unix);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(unix * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** `$505.00`, keeping sub-cent digits only when they exist. */
export const usd = (micros: bigint): string => `$${formatUsd(micros)}`;

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
