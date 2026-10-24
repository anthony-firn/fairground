/**
 * Sign-in without a server: an encrypted vault on relays, found and opened with a username and password.
 *
 * Argon2id turns the username and password into a master secret. From it come a Nostr key that publishes and finds the
 * vault, unlinkable to the account's public identity, and a key that unwraps the vault's data key. The vault is a
 * NIP-78 app-data event (kind 30078), which ordinary relays store.
 *
 * A second factor is a secret that never leaves the user's hardware, mixed into the wrapping key: a passkey's PRF output
 * (WebAuthn), with a printed recovery code as the fallback. Once a second factor is on, the password alone opens
 * nothing. Authenticator-app codes can't work this way: with no server to check them, anyone holding a copy of the vault
 * could skip the check.
 *
 * Argon2id and XChaCha20-Poly1305 are symmetric primitives, so a quantum computer gains little against them.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base32nopad, base64 } from '@scure/base';
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure';
import { PROTOCOL } from './kinds.ts';
import { now } from './tags.ts';

export const VAULT_KIND = 30078;
export const VAULT_D = 'fairground/vault';

/**
 * Argon2id at 64 MiB, two passes: well above OWASP's minimum, because anyone can copy a vault from a relay and guess
 * offline. About a second on a desktop. Fixed per vault version, because the vault can't be found without them.
 */
export const KDF = { m: 65_536, t: 2, p: 1 };
export type KdfParams = typeof KDF;

export function normalizeUsername(username: string): string {
  const u = username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(u)) throw new Error('Usernames are 3–32 letters, numbers, dots, dashes or underscores.');
  return u;
}

/** Why a password is too weak to protect a vault anyone can copy, or undefined if it's fine. */
export function passwordProblem(password: string): string | undefined {
  if (password.length < 10) return 'Use at least 10 characters.';
  if (/^(.)\1+$/.test(password)) return 'Avoid repeating one character.';
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].filter((r) => r.test(password)).length;
  if (password.length < 14 && kinds < 2) return 'Make it longer, or mix in numbers or symbols.';
}

export interface Credentials {
  /** Secret key that publishes the vault event. */
  locatorKey: Uint8Array;
  /** Its public key, which finds the vault. */
  locator: string;
  passwordKey: Uint8Array;
}

const info = (s: string) => utf8ToBytes(`${PROTOCOL}/vault/${s}`);

export async function deriveCredentials(
  username: string,
  password: string,
  kdf: KdfParams = KDF,
  onProgress?: (fraction: number) => void,
): Promise<Credentials> {
  const salt = sha256(info(`user:${normalizeUsername(username)}`));
  const master = await argon2idAsync(utf8ToBytes(password.normalize('NFKC')), salt, { ...kdf, dkLen: 32, onProgress });
  for (let i = 0; ; i++) {
    const locatorKey = hkdf(sha256, master, undefined, info(`locator:${i}`), 32);
    try {
      return { locatorKey, locator: getPublicKey(locatorKey), passwordKey: hkdf(sha256, master, undefined, info('wrap'), 32) };
    } catch {
      // Not a valid secp256k1 scalar (probability about 2^-128); derive the next one.
    }
  }
}

export type Factor =
  | { kind: 'password' }
  | { kind: 'passkey'; secret: Uint8Array; credentialId: string; prfSalt: string }
  | { kind: 'recovery'; secret: Uint8Array };

interface Sealed {
  nonce: string;
  ct: string;
}

export interface WrapRecord extends Sealed {
  kind: Factor['kind'];
  credentialId?: string;
  prfSalt?: string;
}

export interface VaultFile {
  v: 1;
  wraps: WrapRecord[];
  body: Sealed;
}

function wrapKey(creds: Credentials, factor: Factor): Uint8Array {
  const ikm = factor.kind === 'password' ? creds.passwordKey : concatBytes(creds.passwordKey, factor.secret);
  return hkdf(sha256, ikm, undefined, info(`factor:${factor.kind}`), 32);
}

function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): Sealed {
  const nonce = randomBytes(24);
  return { nonce: base64.encode(nonce), ct: base64.encode(xchacha20poly1305(key, nonce, utf8ToBytes(aad)).encrypt(plaintext)) };
}

const unseal = (key: Uint8Array, s: Sealed, aad: string): Uint8Array =>
  xchacha20poly1305(key, base64.decode(s.nonce), utf8ToBytes(aad)).decrypt(base64.decode(s.ct));

/** Wraps a vault's data key for each way of opening it. */
export function wrapDataKey(creds: Credentials, dataKey: Uint8Array, factors: Factor[]): WrapRecord[] {
  return factors.map((f) => ({
    kind: f.kind,
    ...seal(wrapKey(creds, f), dataKey, `${creds.locator}:${f.kind}`),
    ...(f.kind === 'passkey' ? { credentialId: f.credentialId, prfSalt: f.prfSalt } : {}),
  }));
}

/** Encrypts the contents under the data key, keeping the existing wraps. */
export function sealVault(creds: Pick<Credentials, 'locator'>, dataKey: Uint8Array, contents: unknown, wraps: WrapRecord[]): VaultFile {
  return { v: 1, wraps, body: seal(dataKey, utf8ToBytes(JSON.stringify(contents)), creds.locator) };
}

export function createVaultEvent(creds: Pick<Credentials, 'locatorKey'>, file: VaultFile, created_at = now()): Event {
  return finalizeEvent({ kind: VAULT_KIND, created_at, content: JSON.stringify(file), tags: [['d', VAULT_D]] }, creds.locatorKey);
}

export function parseVaultEvent(ev: Event, locator: string): VaultFile | undefined {
  if (ev.kind !== VAULT_KIND || ev.pubkey !== locator || !ev.tags.some((t) => t[0] === 'd' && t[1] === VAULT_D)) return undefined;
  try {
    const file = JSON.parse(ev.content) as VaultFile;
    return file.v === 1 && Array.isArray(file.wraps) && file.body?.nonce && file.body?.ct ? file : undefined;
  } catch {
    return undefined;
  }
}

/** Opens a vault with one factor. Throws if the factor is wrong or the vault doesn't accept it. */
export function openVault<T = unknown>(creds: Credentials, file: VaultFile, factor: Factor): { dataKey: Uint8Array; contents: T } {
  const wrap = file.wraps.find((w) => w.kind === factor.kind && (factor.kind !== 'passkey' || w.credentialId === factor.credentialId));
  if (!wrap) throw new Error(`This account can't be opened with a ${factor.kind}.`);
  const dataKey = unseal(wrapKey(creds, factor), wrap, `${creds.locator}:${factor.kind}`);
  const contents = JSON.parse(new TextDecoder().decode(unseal(dataKey, file.body, creds.locator))) as T;
  return { dataKey, contents };
}

/** A recovery code: 20 random bytes, shown as eight groups of four characters. */
export function newRecoveryCode(): string {
  return base32nopad.encode(randomBytes(20)).match(/.{4}/g)!.join('-');
}

export function recoveryCodeBytes(code: string): Uint8Array {
  const clean = code.toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (clean.length !== 32) throw new Error('A recovery code has 32 letters and digits.');
  return base32nopad.decode(clean);
}
