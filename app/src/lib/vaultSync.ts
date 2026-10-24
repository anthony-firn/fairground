/**
 * Username-and-password sign-in. Everything this device keeps (account keys, settings, AI interests, subscriptions,
 * payout details, survey keys, relay credits) is one encrypted snapshot in a vault on relays; signing in elsewhere
 * restores it. Changes are re-encrypted and republished a few seconds after they happen.
 */
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import {
  createVaultEvent,
  deriveCredentials,
  newRecoveryCode,
  normalizeUsername,
  openVault,
  parseVaultEvent,
  recoveryCodeBytes,
  sealVault,
  VAULT_D,
  VAULT_KIND,
  wrapDataKey,
  type Credentials,
  type Factor,
  type VaultFile,
  type WrapRecord,
} from '@core/vault.ts';
import { publish, query } from './net.ts';
import { createPasskey, passkeySecret } from './passkey.ts';

const PREFIX = 'fairground.';
const SESSION = `${PREFIX}session`;

interface Session {
  username: string;
  locator: string;
  locatorKey: string;
  dataKey: string;
  wraps: WrapRecord[];
}

export function session(): Session | null {
  try {
    return JSON.parse(localStorage.getItem(SESSION) ?? 'null') as Session | null;
  } catch {
    return null;
  }
}

function setSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(SESSION, JSON.stringify(s));
    else localStorage.removeItem(SESSION);
  } catch {
    // Without storage the session lasts until the page closes.
  }
}

function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (key.startsWith(PREFIX) && key !== SESSION) out[key] = localStorage.getItem(key)!;
  }
  return out;
}

function restore(contents: Record<string, string>) {
  for (const [key, value] of Object.entries(contents)) if (key.startsWith(PREFIX) && key !== SESSION) localStorage.setItem(key, value);
}

async function fetchVault(creds: Credentials): Promise<VaultFile | undefined> {
  const events = await query({ kinds: [VAULT_KIND], authors: [creds.locator], '#d': [VAULT_D] }, 5000);
  const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
  return newest && parseVaultEvent(newest, creds.locator);
}

async function push(s: Session) {
  const file = sealVault({ locator: s.locator }, hexToBytes(s.dataKey), snapshot(), s.wraps);
  await publish(createVaultEvent({ locatorKey: hexToBytes(s.locatorKey) }, file));
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** Queues a vault update; called after any local change. */
export function scheduleSync(): void {
  const s = session();
  if (!s) return;
  clearTimeout(timer);
  timer = setTimeout(() => push(s).catch(() => undefined), 4000);
}

export async function createAccountVault(username: string, password: string, onProgress?: (f: number) => void): Promise<void> {
  const creds = await deriveCredentials(username, password, undefined, onProgress);
  if (await fetchVault(creds)) throw new Error('That username and password are already in use. Choose a different username.');
  const dataKey = randomBytes(32);
  const s: Session = {
    username: normalizeUsername(username),
    locator: creds.locator,
    locatorKey: bytesToHex(creds.locatorKey),
    dataKey: bytesToHex(dataKey),
    wraps: wrapDataKey(creds, dataKey, [{ kind: 'password' }]),
  };
  await push(s);
  setSession(s);
}

export interface Found {
  creds: Credentials;
  file: VaultFile;
  username: string;
  /** What else is needed beyond the password. */
  needs: 'nothing' | 'passkey';
}

export async function findAccountVault(username: string, password: string, onProgress?: (f: number) => void): Promise<Found> {
  const creds = await deriveCredentials(username, password, undefined, onProgress);
  const file = await fetchVault(creds);
  if (!file) throw new Error('No account matches that username and password.');
  return { creds, file, username: normalizeUsername(username), needs: file.wraps.some((w) => w.kind === 'password') ? 'nothing' : 'passkey' };
}

/** Opens the vault with the password, the passkey, or a recovery code, and restores this device from it. */
export async function unlockAccountVault(found: Found, via: 'password' | 'passkey' | { recoveryCode: string }): Promise<void> {
  let factor: Factor;
  if (via === 'password') factor = { kind: 'password' };
  else if (via === 'passkey') {
    const wrap = found.file.wraps.find((w) => w.kind === 'passkey')!;
    factor = { kind: 'passkey', credentialId: wrap.credentialId!, prfSalt: wrap.prfSalt!, secret: await passkeySecret(wrap.credentialId!, wrap.prfSalt!) };
  } else factor = { kind: 'recovery', secret: recoveryCodeBytes(via.recoveryCode) };
  const { dataKey, contents } = openVault<Record<string, string>>(found.creds, found.file, factor);
  restore(contents);
  setSession({
    username: found.username,
    locator: found.creds.locator,
    locatorKey: bytesToHex(found.creds.locatorKey),
    dataKey: bytesToHex(dataKey),
    wraps: found.file.wraps,
  });
}

/**
 * Requires a passkey from now on, and returns a recovery code that also works in its place. The password is needed
 * again, because the factors are wrapped with it.
 */
export async function requirePasskey(password: string, onProgress?: (f: number) => void): Promise<string> {
  const s = session();
  if (!s) throw new Error('Set a username and password first.');
  const creds = await deriveCredentials(s.username, password, undefined, onProgress);
  if (creds.locator !== s.locator) throw new Error('That password isn’t right.');
  const passkey = await createPasskey(s.username);
  const code = newRecoveryCode();
  const wraps = wrapDataKey(creds, hexToBytes(s.dataKey), [
    { kind: 'passkey', ...passkey },
    { kind: 'recovery', secret: recoveryCodeBytes(code) },
  ]);
  const next = { ...s, wraps };
  await push(next);
  setSession(next);
  return code;
}

export function signOutEverywhereLocal(): void {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)!.startsWith(PREFIX)) keys.push(localStorage.key(i)!);
  keys.forEach((k) => localStorage.removeItem(k));
}
