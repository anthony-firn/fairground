/**
 * Settlement in USDC on Algorand.
 *
 * Since the v5.0.0 upgrade (August 2026) Algorand accounts can authorize transactions with Falcon-1024 post-quantum
 * signatures, and Pera Wallet supports them; creators should receive into such an account. Algorand's consensus and
 * USDC's issuer keys are still classical, so this protects the creator's own account, not the whole stack.
 *
 * Payments are made in the payer's own wallet through an ARC-26 link, and found again on the chain by their memo.
 */
import { sha512_256 } from '@noble/hashes/sha2.js';
import { base32nopad, base64 } from '@scure/base';
import type { PaymentRequest, Rail, Transfer, TransferQuery } from './rail.ts';

export const RAIL = 'algorand:usdc';
export const USDC_ASSET_ID = 31566704;
export const MAINNET_GENESIS_HASH = 'wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
/** Nodely's free public indexer. Any Algorand indexer works; the genesis hash check rejects other networks. */
export const DEFAULT_INDEXER = 'https://mainnet-idx.4160.nodely.dev';

const checksum = (publicKey: Uint8Array): Uint8Array => sha512_256(publicKey).slice(-4);

export function encodeAddress(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('an Algorand public key is 32 bytes');
  const raw = new Uint8Array(36);
  raw.set(publicKey);
  raw.set(checksum(publicKey), 32);
  return base32nopad.encode(raw);
}

/** Checks the format and the checksum, so a mistyped address is caught before anyone pays it. */
export function isAlgorandAddress(address: string): boolean {
  if (!/^[A-Z2-7]{58}$/.test(address)) return false;
  try {
    const raw = base32nopad.decode(address);
    const sum = checksum(raw.slice(0, 32));
    return raw.length === 36 && sum.every((b, i) => b === raw[32 + i]);
  } catch {
    return false;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** A USDC transfer from an indexer's `GET /v2/transactions/{id}` response. */
export function parseIndexerTransaction(json: unknown): Transfer {
  const tx = isRecord(json) ? json.transaction : undefined;
  if (!isRecord(tx)) throw new Error('indexer response has no transaction');
  if (tx['genesis-hash'] !== MAINNET_GENESIS_HASH) throw new Error('transaction is not on Algorand mainnet');
  const axfer = tx['asset-transfer-transaction'];
  if (tx['tx-type'] !== 'axfer' || !isRecord(axfer)) throw new Error('transaction is not an asset transfer');
  if (axfer['asset-id'] !== USDC_ASSET_ID) throw new Error('transaction does not transfer USDC');
  if (typeof tx['confirmed-round'] !== 'number' || typeof tx['round-time'] !== 'number') {
    throw new Error('transaction is not confirmed');
  }
  if (typeof tx.id !== 'string' || typeof tx.sender !== 'string' || typeof axfer.receiver !== 'string' || typeof axfer.amount !== 'number') {
    throw new Error('transaction is missing its id, sender, receiver or amount');
  }
  const note = typeof tx.note === 'string' ? new TextDecoder().decode(base64.decode(tx.note)) : '';
  return { id: tx.id, sender: tx.sender, receiver: axfer.receiver, amount: BigInt(axfer.amount), note, time: tx['round-time'] };
}

const isoTime = (unix: number) => new Date(unix * 1000).toISOString();

/** An ARC-26 link. The memo goes in `xnote`, which wallets must not let the payer edit, and in `note` for older wallets. */
export function paymentLink({ to, amount, memo }: PaymentRequest): string {
  if (!isAlgorandAddress(to)) throw new Error('not an Algorand address');
  const memoParam = encodeURIComponent(memo);
  return `algorand://${to}?amount=${amount}&asset=${USDC_ASSET_ID}&xnote=${memoParam}&note=${memoParam}`;
}

export function createAlgorandUsdcRail(indexer = DEFAULT_INDEXER, fetchImpl: typeof fetch = (...a) => fetch(...a)): Rail {
  const get = async (path: string, what: string): Promise<unknown> => {
    const res = await fetchImpl(`${indexer}${path}`);
    if (!res.ok) throw new Error(`indexer returned ${res.status} for ${what}`);
    return res.json();
  };
  return {
    id: RAIL,
    label: 'USDC on Algorand',
    isAddress: isAlgorandAddress,
    paymentLink,
    /** Algorand accounts must opt in to USDC before they can receive it, and a frozen holding can't receive. */
    async canReceive(address) {
      if (!isAlgorandAddress(address)) return false;
      const body = (await get(`/v2/accounts/${address}/assets?asset-id=${USDC_ASSET_ID}`, address)) as { assets?: Record<string, unknown>[] };
      return (body.assets ?? []).some((a) => a['asset-id'] === USDC_ASSET_ID && !a.deleted && !a['is-frozen']);
    },
    async fetchTransfer(txid) {
      if (!/^[A-Z2-7]{52}$/.test(txid)) throw new Error('not an Algorand transaction id');
      const transfer = parseIndexerTransaction(await get(`/v2/transactions/${txid}`, txid));
      if (transfer.id !== txid) throw new Error('indexer returned a different transaction');
      return transfer;
    },
    async listTransfers({ address, role, notePrefix, from, to }: TransferQuery) {
      if (!isAlgorandAddress(address)) throw new Error('not an Algorand address');
      const query = new URLSearchParams({
        address,
        'address-role': role,
        'asset-id': String(USDC_ASSET_ID),
        'tx-type': 'axfer',
        'after-time': isoTime(from - 1),
        'before-time': isoTime(to),
        limit: '1000',
      });
      const transfers: Transfer[] = [];
      if (notePrefix) query.set('note-prefix', base64.encode(new TextEncoder().encode(notePrefix)));
      for (let page = 0; page < 100; page++) {
        const body = (await get(`/v2/transactions?${query}`, `transfers of ${address}`)) as { transactions?: unknown[]; 'next-token'?: string };
        for (const transaction of body.transactions ?? []) {
          const t = parseIndexerTransaction({ transaction });
          const party = role === 'receiver' ? t.receiver : t.sender;
          // The indexer's time bounds are exclusive and second-granular; re-check so a boundary is never counted twice.
          if (party === address && t.note.startsWith(notePrefix) && t.time >= from && t.time < to) transfers.push(t);
        }
        if (!body['next-token'] || !body.transactions?.length) return transfers;
        query.set('next', body['next-token']);
      }
      throw new Error('too many transfers to list');
    },
  };
}

export const algorandUsdc = createAlgorandUsdcRail();
