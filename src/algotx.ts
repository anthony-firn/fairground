/**
 * The two Algorand transactions Fairground makes (an ALGO payment and an asset transfer), encoded exactly as the
 * network expects: canonical MessagePack with sorted keys and empty values left out. Signing, transaction ids and group
 * ids follow from that. It replaces the full Algorand SDK, which is too large to start inside an edge function's
 * time budget; tests check every byte against the SDK.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha512_256 } from '@noble/hashes/sha2.js';
import { base32nopad } from '@scure/base';

type Value = bigint | number | string | Uint8Array | Value[] | { [key: string]: Value | undefined };

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

function uint(n: bigint): Uint8Array {
  if (n < 0n) throw new Error('negative integers are never encoded here');
  if (n < 128n) return new Uint8Array([Number(n)]);
  const sized = (tag: number, bytes: number) => {
    const out = new Uint8Array(1 + bytes);
    out[0] = tag;
    for (let i = 0; i < bytes; i++) out[bytes - i] = Number((n >> BigInt(8 * i)) & 0xffn);
    return out;
  };
  if (n < 0x100n) return sized(0xcc, 1);
  if (n < 0x10000n) return sized(0xcd, 2);
  if (n < 0x100000000n) return sized(0xce, 4);
  return sized(0xcf, 8);
}

const empty = (v: Value | undefined) =>
  v === undefined || v === 0 || v === 0n || v === '' || (v instanceof Uint8Array && v.length === 0) || (Array.isArray(v) && v.length === 0);

function encode(v: Value): Uint8Array {
  if (typeof v === 'bigint' || typeof v === 'number') return uint(BigInt(v));
  if (typeof v === 'string') {
    const b = new TextEncoder().encode(v);
    if (b.length < 32) return concat(new Uint8Array([0xa0 | b.length]), b);
    if (b.length < 256) return concat(new Uint8Array([0xd9, b.length]), b);
    throw new Error('string too long');
  }
  if (v instanceof Uint8Array) {
    if (v.length < 256) return concat(new Uint8Array([0xc4, v.length]), v);
    if (v.length < 65536) return concat(new Uint8Array([0xc5, v.length >> 8, v.length & 0xff]), v);
    throw new Error('bytes too long');
  }
  if (Array.isArray(v)) {
    if (v.length >= 16) throw new Error('array too long');
    return concat(new Uint8Array([0x90 | v.length]), ...v.map(encode));
  }
  const keys = Object.keys(v).filter((k) => !empty(v[k])).sort();
  if (keys.length >= 16) throw new Error('map too large');
  return concat(new Uint8Array([0x80 | keys.length]), ...keys.flatMap((k) => [encode(k), encode(v[k]!)]));
}

/** An Algorand address from a 32-byte public key. */
export const encodeAddressKey = (key: Uint8Array): string => base32nopad.encode(concat(key, sha512_256(key).slice(-4)));

/** Decodes an Algorand address to its 32-byte public key, checking the checksum. */
export function addressKey(address: string): Uint8Array {
  const raw = base32nopad.decode(address);
  const key = raw.slice(0, 32);
  if (raw.length !== 36 || !sha512_256(key).slice(-4).every((b, i) => b === raw[32 + i])) throw new Error(`not an Algorand address: ${address}`);
  return key;
}

export interface TxnParams {
  /** Flat fee in micro-ALGO. */
  fee: bigint;
  firstValid: bigint;
  lastValid: bigint;
  genesisID: string;
  genesisHash: Uint8Array;
}

export type Txn = { [key: string]: Value | undefined };

const header = (sender: string, p: TxnParams, note?: Uint8Array): Txn => ({
  snd: addressKey(sender), fee: p.fee, fv: p.firstValid, lv: p.lastValid, gen: p.genesisID, gh: p.genesisHash, note,
});

export const payTxn = (sender: string, receiver: string, amount: bigint, p: TxnParams, note?: Uint8Array): Txn =>
  ({ ...header(sender, p, note), type: 'pay', rcv: addressKey(receiver), amt: amount });

export const assetTxn = (sender: string, receiver: string, assetId: number, amount: bigint, p: TxnParams, note?: Uint8Array): Txn =>
  ({ ...header(sender, p, note), type: 'axfer', arcv: addressKey(receiver), xaid: BigInt(assetId), aamt: amount });

export const encodeTxn = (t: Txn): Uint8Array => encode(t);
const tag = (s: string) => new TextEncoder().encode(s);
export const rawTxid = (t: Txn): Uint8Array => sha512_256(concat(tag('TX'), encodeTxn(t)));
export const txid = (t: Txn): string => base32nopad.encode(rawTxid(t));

/** Sets the same group id on every transaction, so they succeed or fail together. */
export function assignGroup(txns: Txn[]): void {
  for (const t of txns) delete t.grp;
  const grp = sha512_256(concat(tag('TG'), encode({ txlist: txns.map(rawTxid) })));
  for (const t of txns) t.grp = grp;
}

/** The bytes an account signs for a transaction. */
export const signingBytes = (t: Txn): Uint8Array => concat(tag('TX'), encodeTxn(t));

/** A signed transaction from a signature, ready to send. */
export const signedTxn = (t: Txn, sig: Uint8Array): Uint8Array => encode({ sig, txn: t });

/** Signs with a 32-byte Ed25519 seed. */
export const signTxn = (t: Txn, seed: Uint8Array): Uint8Array => signedTxn(t, ed25519.sign(signingBytes(t), seed));

export const verifyTxnSig = (t: Txn, sig: Uint8Array, address: string): boolean => {
  try {
    return ed25519.verify(sig, signingBytes(t), addressKey(address));
  } catch {
    return false;
  }
};
