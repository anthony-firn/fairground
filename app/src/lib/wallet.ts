/**
 * The built-in wallet in the app: its address and balance, kept fresh after payments. Signing lives in
 * walletActions.ts, loaded only when someone pays, starts their wallet or moves money.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { DEFAULT_GATEWAY } from '@core/defaults.ts';
import { walletAddress, walletState, type WalletState } from '@core/walletkey.ts';
import type { Account } from './account.ts';
import { load, save } from './storage.ts';

export const gatewayUrl = (): string => load<string>('gateway', DEFAULT_GATEWAY);

const addresses = new WeakMap<Uint8Array, string>();
export function myWalletAddress(account: Account): string {
  if (!addresses.has(account.nostrKey)) addresses.set(account.nostrKey, walletAddress(account.nostrKey));
  return addresses.get(account.nostrKey)!;
}

export interface WalletConfig {
  /** The sponsor that starts new wallets, if this gateway runs one. */
  starter: string | null;
  /** Whether buying and selling through Transak is set up. */
  ramp: boolean;
}

let config: Promise<WalletConfig> | undefined;
export const walletConfig = (): Promise<WalletConfig> =>
  (config ??= fetch(`${gatewayUrl()}/wallet/config`).then((r) => (r.ok ? r.json() : { starter: null, ramp: false }), () => ({ starter: null, ramp: false })));

// Anything that moves money bumps this, so every balance on screen refreshes.
let version = 0;
const listeners = new Set<() => void>();
export function walletChanged(): void {
  version++;
  listeners.forEach((l) => l());
}

export function useWallet(account: Account): { address: string; state?: WalletState; error?: string; config?: WalletConfig; refresh: () => void } {
  const address = myWalletAddress(account);
  const v = useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => version);
  const [state, setState] = useState<WalletState>();
  const [error, setError] = useState<string>();
  const [cfg, setCfg] = useState<WalletConfig>();
  useEffect(() => {
    walletState(address).then((s) => (setState(s), setError(undefined)), (e: Error) => setError(e.message));
  }, [address, v]);
  useEffect(() => {
    walletConfig().then(setCfg, () => undefined);
  }, []);
  return { address, state, error, config: cfg, refresh: useCallback(() => walletChanged(), []) };
}

/** Use the built-in wallet for incoming payments. */
export const getPaidHere = (account: Account) => save('payTo', myWalletAddress(account));
