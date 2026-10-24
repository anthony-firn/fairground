/**
 * The built-in wallet's address and balance, without the transaction library, so the app can show them cheaply.
 * See wallet.ts for signing.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { encodeAddress, USDC_ASSET_ID } from './rails/algorand.ts';

/** Nodely's free public algod. Any Algorand mainnet node works. */
export const DEFAULT_ALGOD = 'https://mainnet-api.4160.nodely.dev';

/** What a new wallet is given to start: Algorand's 0.1 ALGO account minimum, 0.1 to hold USDC, and fees for ~50 payments. */
export const STARTER_MICROALGOS = 250_000n;
export const STARTER_MEMO = 'fairground:starter';

/** The wallet's Ed25519 seed, derived from the Fairground account's Nostr key with HKDF-SHA256. */
export const walletSeed = (nostrKey: Uint8Array): Uint8Array =>
  hkdf(sha256, nostrKey, new TextEncoder().encode('fairground'), new TextEncoder().encode('algorand-wallet/v1'), 32);

export const walletAddress = (nostrKey: Uint8Array): string => encodeAddress(ed25519.getPublicKey(walletSeed(nostrKey)));

export interface WalletState {
  address: string;
  /** Micro-ALGO held, and how much of it must stay in the account. */
  algo: bigint;
  minimum: bigint;
  /** Micro-dollars of USDC. */
  usdc: bigint;
  /** Whether the account can hold USDC. */
  active: boolean;
}

export async function walletState(address: string, algod = DEFAULT_ALGOD, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<WalletState> {
  const res = await fetchImpl(`${algod}/v2/accounts/${address}?exclude=created-assets,created-apps,apps-local-state`);
  if (!res.ok) throw new Error(`reading the wallet: the Algorand node said ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  const assets = (body.assets ?? []) as { 'asset-id': number; amount: number; 'is-frozen'?: boolean }[];
  const usdc = assets.find((a) => a['asset-id'] === USDC_ASSET_ID);
  return {
    address,
    algo: BigInt(Number(body.amount ?? 0)),
    minimum: BigInt(Number(body['min-balance'] ?? 100_000)),
    usdc: BigInt(usdc?.amount ?? 0),
    active: !!usdc && !usdc['is-frozen'],
  };
}

/** Network fees still covered by the wallet's ALGO above its minimum. */
export const feesLeft = (s: Pick<WalletState, 'algo' | 'minimum'>, fee = 1000n): number => Number(s.algo > s.minimum ? (s.algo - s.minimum) / fee : 0n);
