/**
 * Publishes US CPI-U attestations (BLS series CUUR0000SA0, not seasonally adjusted) to Nostr relays, signed with the
 * publisher's Nostr and post-quantum keys. GitHub Actions runs it daily mid-month, when BLS releases new values;
 * values already published are skipped.
 *
 *   node tools/publish-index.ts --keygen > publisher.json      # once; store it as the FAIRGROUND_INDEX_KEY secret
 *   FAIRGROUND_INDEX_KEY="$(cat publisher.json)" node tools/publish-index.ts [--dry-run] [--relay wss://…]
 */
import { fileURLToPath } from 'node:url';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import { DEFAULT_RELAYS } from '../src/defaults.ts';
import { KIND } from '../src/kinds.ts';
import { createPqBinding, generatePqKeys } from '../src/pq.ts';
import { createIndexAttestation, DEFAULT_INDEX } from '../src/pricing.ts';
import { tagValue } from '../src/tags.ts';
import WebSocket from 'ws';

// Node's built-in WebSocket recurses endlessly in nostr-tools' error handling when a relay is unreachable.
useWebSocketImplementation(WebSocket);

const SERIES = 'CUUR0000SA0';
const SOURCE = `https://data.bls.gov/timeseries/${SERIES}`;

interface KeyFile {
  nostrKey: string;
  pqSeed: string;
  /** Made once at key generation so every run republishes the same binding. */
  binding: Event;
}

interface Reading {
  period: string;
  value: string;
}

/** The latest monthly values from the BLS public API, newest first. Missing months (published as "-") are skipped. */
export async function fetchCpi(fetchImpl: typeof fetch = fetch, months = 3): Promise<Reading[]> {
  const res = await fetchImpl(`https://api.bls.gov/publicAPI/v1/timeseries/data/${SERIES}`);
  const body = (await res.json()) as { status?: string; Results?: { series?: { data?: { year: string; period: string; value: string }[] }[] } };
  if (body.status !== 'REQUEST_SUCCEEDED') throw new Error(`BLS API: ${body.status}`);
  return (body.Results?.series?.[0]?.data ?? [])
    .filter((d) => /^M(0[1-9]|1[0-2])$/.test(d.period) && /^\d+(\.\d{1,3})?$/.test(d.value))
    .map((d) => ({ period: `${d.year}-${d.period.slice(1)}`, value: d.value }))
    .sort((a, b) => (a.period < b.period ? 1 : -1))
    .slice(0, months);
}

function keygen(): KeyFile {
  const nostrKey = generateSecretKey();
  const pqSeed = randomBytes(32);
  return { nostrKey: bytesToHex(nostrKey), pqSeed: bytesToHex(pqSeed), binding: createPqBinding(nostrKey, generatePqKeys(pqSeed)) };
}

async function main(args: string[]) {
  if (args.includes('--keygen')) {
    const key = keygen();
    process.stderr.write(`Publisher pubkey: ${getPublicKey(hexToBytes(key.nostrKey))}\n`);
    process.stdout.write(`${JSON.stringify(key)}\n`);
    return;
  }
  const raw = process.env.FAIRGROUND_INDEX_KEY;
  if (!raw) throw new Error('set FAIRGROUND_INDEX_KEY to the key file contents');
  const key = JSON.parse(raw) as KeyFile;
  const nostrKey = hexToBytes(key.nostrKey);
  const pq = generatePqKeys(hexToBytes(key.pqSeed));
  const pubkey = getPublicKey(nostrKey);
  const relays = args.flatMap((a, i) => (args[i - 1] === '--relay' ? [a] : []));
  const targets = relays.length ? relays : DEFAULT_RELAYS;

  const readings = await fetchCpi();
  const pool = new SimplePool();
  try {
    // Relays index only single-letter tags, so filter by index id here rather than in the query.
    const existing = await pool.querySync(targets, { kinds: [KIND.indexValue], authors: [pubkey] }, { maxWait: 5000 });
    const published = new Set(existing
      .filter((e) => tagValue(e, 'index') === DEFAULT_INDEX)
      .map((e) => `${tagValue(e, 'period')}=${tagValue(e, 'value')}`));
    const fresh = readings
      .filter((r) => !published.has(`${r.period}=${r.value}`))
      .map((r) => createIndexAttestation(nostrKey, pq, { index: DEFAULT_INDEX, period: r.period, value: r.value, source: SOURCE }));
    console.log(`Publisher ${pubkey}`);
    for (const r of readings) console.log(`  ${r.period} ${r.value}${published.has(`${r.period}=${r.value}`) ? ' (already published)' : ''}`);
    if (args.includes('--dry-run')) return;
    for (const ev of [key.binding, ...fresh]) {
      const results = await Promise.allSettled(pool.publish(targets, ev));
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      console.log(`  kind ${ev.kind} ${ev.id.slice(0, 12)}… accepted by ${ok}/${targets.length} relays`);
      if (!ok) throw new Error('no relay accepted the event');
    }
  } finally {
    pool.close(targets);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
