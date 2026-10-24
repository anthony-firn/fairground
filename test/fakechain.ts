/**
 * A stand-in for Algorand mainnet's algod and indexer, for tests: it checks signatures, fees (pooled across a group),
 * minimum balances and USDC opt-ins the way the network does, and answers the queries the wallet, the starter and the
 * payment checks make. Nothing here touches a real network.
 */
import algosdk from 'algosdk';
import { Decoder } from 'algorand-msgpack';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base64 } from '@scure/base';
import { MAINNET_GENESIS_HASH, USDC_ASSET_ID } from '../src/rails/algorand.ts';

export const ALGOD = 'https://algod.test';
export const INDEXER = 'https://indexer.test';

interface Account {
  algo: bigint;
  usdc: bigint | null;
}

interface Recorded {
  id: string;
  type: 'pay' | 'axfer';
  sender: string;
  receiver: string;
  amount: bigint;
  asset?: number;
  note: Uint8Array;
  round: number;
  time: number;
}

const MIN = 100_000n;
const minimum = (a: Account) => MIN + (a.usdc === null ? 0n : MIN);

export function createFakeChain(origins: { algod: string; indexer: string } = { algod: ALGOD, indexer: INDEXER }) {
  const accounts = new Map<string, Account>();
  const txns: Recorded[] = [];
  let round = 1000;
  const account = (addr: string) => {
    if (!accounts.has(addr)) accounts.set(addr, { algo: 0n, usdc: null });
    return accounts.get(addr)!;
  };

  function apply(bytes: Uint8Array): string {
    const parts: Uint8Array[] = [];
    const dec = new Decoder();
    const pos = () => (dec as unknown as { pos: number }).pos;
    let start = 0;
    for (const _ of dec.decodeMulti(bytes)) {
      parts.push(bytes.subarray(start, pos()));
      start = pos();
    }
    const signed = parts.map((p) => algosdk.decodeSignedTransaction(p));
    if (signed.length > 1) {
      // The group id is the hash of the transactions without their group field.
      const bare = signed.map((s) => {
        const copy = algosdk.decodeUnsignedTransaction(algosdk.encodeUnsignedTransaction(s.txn));
        (copy as unknown as { group?: Uint8Array }).group = undefined;
        return copy;
      });
      const ids = algosdk.computeGroupID(bare);
      if (signed.some((s) => !s.txn.group || !s.txn.group.every((b, i) => b === ids[i]))) throw new Error('group id mismatch');
    }
    const fees = signed.reduce((n, s) => n + s.txn.fee, 0n);
    if (fees < 1000n * BigInt(signed.length)) throw new Error('fee too small');
    // Work on copies, so a failing group changes nothing.
    const draft = new Map([...accounts].map(([k, v]) => [k, { ...v }]));
    const get = (a: string) => draft.get(a) ?? (draft.set(a, { algo: 0n, usdc: null }), draft.get(a)!);
    const recorded: Recorded[] = [];
    for (const { txn, sig } of signed) {
      const sender = txn.sender.toString();
      if (!sig || !ed25519.verify(sig, txn.bytesToSign(), txn.sender.publicKey)) throw new Error('invalid signature');
      if (txn.genesisHash && base64.encode(txn.genesisHash) !== MAINNET_GENESIS_HASH) throw new Error('wrong network');
      const from = get(sender);
      from.algo -= txn.fee;
      if (txn.type === 'pay') {
        const to = txn.payment!.receiver.toString();
        from.algo -= txn.payment!.amount;
        get(to).algo += txn.payment!.amount;
        recorded.push({ id: txn.txID(), type: 'pay', sender, receiver: to, amount: txn.payment!.amount, note: txn.note, round, time: Math.floor(Date.now() / 1000) });
      } else if (txn.type === 'axfer') {
        const x = txn.assetTransfer!;
        if (Number(x.assetIndex) !== USDC_ASSET_ID) throw new Error('only USDC here');
        const to = x.receiver.toString();
        if (to === sender && x.amount === 0n) {
          if (from.usdc === null) from.usdc = 0n;
        } else {
          if (from.usdc === null || from.usdc < x.amount) throw new Error('underflow on USDC');
          if (get(to).usdc === null) throw new Error('receiver not opted in to USDC');
          from.usdc -= x.amount;
          get(to).usdc! += x.amount;
        }
        recorded.push({ id: txn.txID(), type: 'axfer', sender, receiver: to, amount: x.amount, asset: USDC_ASSET_ID, note: txn.note, round, time: Math.floor(Date.now() / 1000) });
      } else throw new Error(`unsupported type ${txn.type}`);
    }
    for (const [addr, a] of draft) if (a.algo < minimum(a) && (a.algo !== 0n || a.usdc !== null)) throw new Error(`balance ${a.algo} below min ${minimum(a)} for ${addr}`);
    for (const [k, v] of draft) accounts.set(k, v);
    txns.push(...recorded);
    round++;
    return recorded[0].id;
  }

  const indexerTxn = (t: Recorded) => ({
    id: t.id, sender: t.sender, 'tx-type': t.type, 'genesis-hash': MAINNET_GENESIS_HASH, 'confirmed-round': t.round, 'round-time': t.time,
    note: base64.encode(t.note),
    ...(t.type === 'axfer' ? { 'asset-transfer-transaction': { 'asset-id': t.asset, amount: Number(t.amount), receiver: t.receiver } } : { 'payment-transaction': { amount: Number(t.amount), receiver: t.receiver } }),
  });
  const ok = (body: unknown) => Response.json(body);
  const fail = (status: number, message: string) => Response.json({ message }, { status });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (url.origin === origins.algod) {
      if (path === '/v2/transactions/params') return ok({ 'min-fee': 1000, fee: 0, 'last-round': round, 'genesis-id': 'mainnet-v1.0', 'genesis-hash': MAINNET_GENESIS_HASH, 'consensus-version': 'test' });
      const acct = /^\/v2\/accounts\/([A-Z2-7]{58})$/.exec(path);
      // Like algod: `exclude` accepts only "all" or "none".
      if (acct && url.searchParams.has('exclude') && !['all', 'none'].includes(url.searchParams.get('exclude')!)) return fail(400, 'invalid exclude');
      if (acct) {
        const a = accounts.get(acct[1]) ?? { algo: 0n, usdc: null };
        return ok({ address: acct[1], amount: Number(a.algo), 'min-balance': Number(minimum(a)), assets: a.usdc === null ? [] : [{ 'asset-id': USDC_ASSET_ID, amount: Number(a.usdc), 'is-frozen': false }] });
      }
      if (path === '/v2/transactions' && init?.method === 'POST') {
        try {
          return ok({ txId: apply(new Uint8Array(init.body as Uint8Array)) });
        } catch (e) {
          return fail(400, (e as Error).message);
        }
      }
      const pending = /^\/v2\/transactions\/pending\/([A-Z2-7]{52})$/.exec(path);
      if (pending) return ok(txns.some((t) => t.id === pending[1]) ? { 'confirmed-round': round } : { 'pool-error': 'unknown transaction' });
    }
    if (url.origin === origins.indexer) {
      const q = url.searchParams;
      const prefix = q.get('note-prefix') ? base64.decode(q.get('note-prefix')!) : new Uint8Array();
      const hasPrefix = (t: Recorded) => prefix.every((b, i) => t.note[i] === b);
      const after = q.get('after-time') ? Date.parse(q.get('after-time')!) / 1000 : 0;
      const before = q.get('before-time') ? Date.parse(q.get('before-time')!) / 1000 : Infinity;
      const assets = /^\/v2\/accounts\/([A-Z2-7]{58})\/assets$/.exec(path);
      if (assets) {
        const a = accounts.get(assets[1]);
        return ok({ assets: a?.usdc === null || !a ? [] : [{ 'asset-id': USDC_ASSET_ID, amount: Number(a.usdc), 'is-frozen': false, deleted: false }] });
      }
      const byAccount = /^\/v2\/accounts\/([A-Z2-7]{58})\/transactions$/.exec(path);
      if (byAccount) {
        const role = q.get('address-role');
        const list = txns.filter((t) => (role === 'receiver' ? t.receiver : t.sender) === byAccount[1] && (!q.get('tx-type') || t.type === q.get('tx-type')) && hasPrefix(t) && t.time > after && t.time < before);
        return ok({ transactions: list.map(indexerTxn) });
      }
      const one = /^\/v2\/transactions\/([A-Z2-7]{52})$/.exec(path);
      if (one) {
        const t = txns.find((x) => x.id === one[1]);
        return t ? ok({ transaction: indexerTxn(t) }) : fail(404, 'no transaction');
      }
      if (path === '/v2/transactions') {
        const addr = q.get('address');
        const role = q.get('address-role');
        const list = txns.filter((t) => t.type === 'axfer' && (!addr || (role === 'receiver' ? t.receiver : t.sender) === addr) && hasPrefix(t) && t.time > after && t.time < before);
        return ok({ transactions: list.map(indexerTxn) });
      }
    }
    return fail(404, `fake chain: no route for ${url}`);
  };

  return {
    fetch: fetchImpl,
    accounts,
    txns,
    /** Gives an account ALGO and, if `usdc` is set, a USDC holding. */
    fund(addr: string, algo: bigint, usdc?: bigint) {
      const a = account(addr);
      a.algo += algo;
      if (usdc !== undefined) a.usdc = (a.usdc ?? 0n) + usdc;
    },
  };
}
