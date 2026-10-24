/**
 * Passkeys as a second factor without a server. WebAuthn's PRF extension gives a secret that only the passkey can
 * produce; it's mixed into the vault's key, so the password alone opens nothing. The passkey belongs to the site's
 * domain, and the iOS and Android apps need that domain verified for them.
 */
import { randomBytes } from '@noble/hashes/utils.js';
import { base64, base64urlnopad } from '@scure/base';

interface PrfOutputs {
  enabled?: boolean;
  results?: { first?: ArrayBuffer };
}

export const passkeysSupported = (): boolean => typeof PublicKeyCredential !== 'undefined' && window.isSecureContext;

const prfOf = (cred: Credential | null): PrfOutputs | undefined =>
  (cred as PublicKeyCredential | null)?.getClientExtensionResults()?.prf as PrfOutputs | undefined;

export async function passkeySecret(credentialId: string, prfSalt: string): Promise<Uint8Array> {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      allowCredentials: [{ type: 'public-key', id: new Uint8Array(base64urlnopad.decode(credentialId)) }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: new Uint8Array(base64.decode(prfSalt)) } } } as AuthenticationExtensionsClientInputs,
    },
  });
  const first = prfOf(cred)?.results?.first;
  if (!first) throw new Error('This passkey can’t unlock accounts on this device.');
  return new Uint8Array(first);
}

export async function createPasskey(username: string): Promise<{ credentialId: string; prfSalt: string; secret: Uint8Array }> {
  const salt = randomBytes(32);
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Fairground' },
      user: { id: randomBytes(16), name: username, displayName: username },
      challenge: randomBytes(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was created.');
  const prf = prfOf(cred);
  if (!prf?.enabled && !prf?.results?.first) throw new Error('This device’s passkeys can’t protect an account (no PRF support).');
  const credentialId = base64urlnopad.encode(new Uint8Array(cred.rawId));
  const prfSalt = base64.encode(salt);
  // Some platforms only return the PRF result when the passkey is used, not when it's created.
  const secret = prf.results?.first ? new Uint8Array(prf.results.first) : await passkeySecret(credentialId, prfSalt);
  return { credentialId, prfSalt, secret };
}
