/**
 * The built-in wallet in the app: its address and balance, kept fresh after payments. Signing lives in
 * walletActions.ts, loaded only when someone pays, starts their wallet or moves money.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { DEFAULT_GATEWAY } from '@core/defaults.ts';
import { convertibleAlgo, walletAddress, walletState, type WalletState } from '@core/walletkey.ts';
import type { Account } from './account.ts';
import { load, save } from './storage.ts';
import { LOCAL_PILOT } from './pilot.ts';

export const gatewayUrl = (): string => LOCAL_PILOT ? `${location.origin}/fairground` : load<string>('gateway', DEFAULT_GATEWAY);

const addresses = new WeakMap<Uint8Array, string>();
export function myWalletAddress(account: Account): string {
  if (!addresses.has(account.nostrKey)) addresses.set(account.nostrKey, walletAddress(account.nostrKey));
  return addresses.get(account.nostrKey)!;
}

export interface WalletConfig {
  /** Whether the gateway has configured Meld routes. */
  ramp: boolean;
  provider?: 'meld';
  environment?: 'sandbox' | 'production';
}

let config: Promise<WalletConfig> | undefined;
export function walletConfig(refresh = false): Promise<WalletConfig> {
  if (refresh) config = undefined;
  return (config ??= fetch(`${gatewayUrl()}/wallet/config`)
    .then(async (r) => {
      if (!r.ok) return { ramp: false };
      const value = await r.json();
      return { ramp: value.ramp === true && value.provider === 'meld', provider: value.provider, environment: value.environment };
    })
    .catch(() => ({ ramp: false })));
}

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
    if (LOCAL_PILOT) {
      setState({ address, algo: 500_000n, minimum: 200_000n, usdc: 25_000_000n, active: true });
      return;
    }
    let stopped = false;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const next = await walletState(address);
        if (!stopped) { setState(next); setError(undefined); }
      } catch (e) { if (!stopped) setError((e as Error).message); }
      finally { reading = false; }
    };
    void read();
    // Detect the first purchase while checkout is in another tab, without a manual refresh.
    const timer = setInterval(read, 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, [address, v]);
  useEffect(() => {
    walletConfig().then(setCfg, () => undefined);
  }, [v]);
  return { address, state, error, config: cfg, refresh: useCallback(() => walletChanged(), []) };
}

/** Use the built-in wallet for incoming payments. */
export const getPaidHere = (account: Account) => save('payTo', myWalletAddress(account));

/**
 * Finishes setting up the wallet once its first deposit arrives, and converts later ALGO deposits to dollars, while
 * the wallet is on screen. Returns what it's doing, for the screen to say.
 */
export function useSettle(account: Account, state: WalletState | undefined): { status: 'idle' | 'working' | 'error'; error?: string; retry: () => void } {
  const [status, setStatus] = useState<'idle' | 'working' | 'error'>('idle');
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const due = !LOCAL_PILOT && !!state && ((!state.active && state.algo >= state.minimum + 101_000n) || convertibleAlgo(state) > 0n);
  useEffect(() => {
    if (!due || settling.has(account.pubkey)) return;
    settling.add(account.pubkey);
    setStatus('working');
    import('./walletActions.ts')
      .then((a) => a.settleWallet(account))
      .then(() => setStatus('idle'), (e: Error) => (setStatus('error'), setError(e.message)))
      .finally(() => settling.delete(account.pubkey));
  }, [due, account, attempt]);
  return { status, error, retry: () => setAttempt((n) => n + 1) };
}
const settling = new Set<string>();

/** Persist the session before opening checkout: Meld returns to our URL without adding an order ID. */
export interface PendingRamp {
  id: string;
  externalSessionId: string;
  side: 'BUY' | 'SELL';
  walletAddress: string;
  amount: number;
  environment: 'sandbox' | 'production';
}
export const pendingRamps = (account: Account) => load<PendingRamp[]>(`meld-sessions-${account.pubkey}`, []);
export function pendingRamp(account: Account, id?: string): PendingRamp | undefined {
  const sessions = pendingRamps(account);
  return id ? sessions.find((s) => s.id === id) : sessions.findLast((s) => s.side === 'SELL') ?? sessions.at(-1);
}
export function rememberRamp(account: Account, session: PendingRamp): void {
  const sessions = pendingRamps(account);
  save(`meld-sessions-${account.pubkey}`, [...sessions.filter((s) => s.id !== session.id && s.side === 'SELL'), session]);
}
export function forgetRamp(account: Account, id: string): void {
  save(`meld-sessions-${account.pubkey}`, pendingRamps(account).filter((s) => s.id !== id));
}
