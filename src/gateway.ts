/**
 * A podcast gateway: standard RSS feeds for Fairground shows, and downloads with host-read ads stitched in.
 *
 * It is one stateless request handler (a web `Request` in, a `Response` out) that reads signed events from relays,
 * so it runs on any edge or serverless platform, or next to a relay. It never stores audio. A download with no ads
 * redirects to the creator's own file; one with ads streams byte ranges of the episode and the reads in order, with
 * the HEAD and Range support Apple Podcasts requires. Feeds are a view of signed events, so a show can move to another
 * gateway, and a listener's app can always check what it was given against the creator's signatures.
 */
import { decode, npubEncode } from 'nostr-tools/nip19';
import type { Filter } from 'nostr-tools/filter';
import { verifyEvent, type Event } from 'nostr-tools/pure';
import type { AdBreak, Placement } from './ads.ts';
import { KIND } from './kinds.ts';
import { canJoin } from './mp3.ts';
import { currentEpisodes, parseShow, renderRss, showAddress, type Episode, type Show } from './podcast.ts';
import { verifyAuthHeader } from './httpauth.ts';
import { membersFrom } from './network.ts';
import { createRamp, sellOrderProblem, type RampOptions } from './ramp.ts';

// Loaded on first use: an edge function must start within a few tens of milliseconds, and most requests are feeds.
const ads = () => import('./ads.ts');
const pq = () => import('./pq.ts');
import { assess } from './safety.ts';

export interface GatewayOptions {
  relays: string[];
  /** The path the gateway is served under, e.g. `/fairground`. */
  base: string;
  /** The Fairground app, for show and episode links in feeds. */
  appUrl: string;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  now?: () => number;
  /** How long relay answers are reused, in seconds. */
  cacheSeconds?: number;
  /** Extra headers on feeds, e.g. a CDN's cache instructions. */
  feedHeaders?: Record<string, string>;
  /** Accounts this gateway won't serve, e.g. after a takedown notice. */
  blocked?: string[];
  /** Buying and selling through Meld (ramp.ts). Off unless approved routes and credentials are configured. */
  ramp?: RampOptions;
  /** Browser origins permitted to use wallet services; defaults to the app's origin. */
  walletOrigins?: string[];
}

/** What the platform knows about a request that the Request itself doesn't carry. */
export interface RequestInfo {
  ip?: string;
}

/** Queries relays over WebSocket and returns the validly signed events, until each relay finishes or time runs out. */
export async function queryRelays(relays: string[], filter: Filter, WS: typeof WebSocket = WebSocket, timeout = 4000): Promise<Event[]> {
  const found = new Map<string, Event>();
  await Promise.all(relays.map((url) => new Promise<void>((resolve) => {
    let ws: WebSocket;
    const sub = Math.random().toString(36).slice(2, 10);
    const finish = () => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Already closed.
      }
      resolve();
    };
    const timer = setTimeout(finish, timeout);
    try {
      ws = new WS(url);
    } catch {
      clearTimeout(timer);
      resolve();
      return;
    }
    ws.onopen = () => ws.send(JSON.stringify(['REQ', sub, filter]));
    ws.onerror = finish;
    ws.onclose = finish;
    ws.onmessage = (msg) => {
      let data: unknown;
      try {
        data = JSON.parse(String(msg.data));
      } catch {
        return;
      }
      if (!Array.isArray(data) || data[1] !== sub) return;
      if (data[0] === 'EOSE' || data[0] === 'CLOSED') finish();
      else if (data[0] === 'EVENT' && !found.has(data[2]?.id) && verifyEvent(data[2])) found.set(data[2].id, data[2]);
    };
  })));
  return [...found.values()];
}

interface ShowData {
  show: Show;
  episodes: Episode[];
  placements: Placement[];
  acceptances: Event[];
  approvals: Event[];
  bindings: Event[];
}

/** A byte range of one file: [start, end). */
export interface Segment {
  url: string;
  start: number;
  end: number;
}

/**
 * The parts of a stitched download: the episode's ID3 tag, pre-rolls, the episode split at its mid-roll marks with
 * the reads between, and post-rolls. The episode's Xing/Info frame is left out, so players measure the real length.
 * Reads whose frames can't be joined to the episode's (another sample rate, say) are skipped. Undefined when nothing
 * would be inserted.
 */
export function stitchPlan(episode: Episode, breaks: AdBreak[]): Segment[] | undefined {
  const m = episode.mp3;
  if (!m) return undefined;
  const url = episode.audio.url;
  const reads = (b: AdBreak) => b.ads.map((a) => a.spot.mp3 && canJoin(a.spot.mp3, m) ? { url: a.spot.url, start: a.spot.mp3.audioStart, end: a.spot.mp3.audioEnd } : undefined)
    .filter((s): s is Segment => !!s);
  const segments: Segment[] = [];
  let inserted = 0;
  const add = (s: Segment[]) => {
    segments.push(...s);
    inserted += s.length;
  };
  if (m.id3End > 0) segments.push({ url, start: 0, end: m.id3End });
  for (const b of breaks.filter((b) => b.slot === 'pre')) add(reads(b));
  let cursor = m.audioStart;
  for (const b of breaks.filter((b) => b.slot === 'mid').sort((x, y) => x.at - y.at)) {
    if (b.byteOffset === undefined || b.byteOffset <= cursor || b.byteOffset >= m.audioEnd) continue;
    const s = reads(b);
    if (!s.length) continue;
    segments.push({ url, start: cursor, end: b.byteOffset });
    add(s);
    cursor = b.byteOffset;
  }
  segments.push({ url, start: cursor, end: m.audioEnd });
  for (const b of breaks.filter((b) => b.slot === 'post')) add(reads(b));
  return inserted ? segments : undefined;
}

/** A single `Range: bytes=…` request against a file of `size` bytes, as an inclusive [first, last]. */
export function parseRange(header: string | null, size: number): [number, number] | 'unsatisfiable' | undefined {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').split(',')[0].trim());
  if (!m || (!m[1] && !m[2])) return undefined;
  let first: number;
  let last: number;
  if (!m[1]) {
    first = Math.max(0, size - Number(m[2]));
    last = size - 1;
  } else {
    first = Number(m[1]);
    last = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  return first > last || first >= size ? 'unsatisfiable' : [first, last];
}

/** Streams bytes [first, last] of the segments joined end to end, fetching only the ranges needed. */
export function streamSegments(segments: Segment[], first: number, last: number, fetchImpl: typeof fetch): ReadableStream<Uint8Array> {
  const parts: Segment[] = [];
  let offset = 0;
  for (const s of segments) {
    const len = s.end - s.start;
    const from = Math.max(first, offset);
    const to = Math.min(last + 1, offset + len);
    if (from < to) parts.push({ url: s.url, start: s.start + (from - offset), end: s.start + (to - offset) });
    offset += len;
  }
  let i = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let skip = 0;
  let remaining = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        if (!reader) {
          if (i >= parts.length) return controller.close();
          const p = parts[i++];
          const res = await fetchImpl(p.url, { headers: { Range: `bytes=${p.start}-${p.end - 1}` } });
          if (res.status !== 206 && res.status !== 200) return controller.error(new Error(`upstream returned ${res.status}`));
          // A server that ignores Range sends the whole file; skip to the part needed.
          skip = res.status === 200 ? p.start : 0;
          remaining = p.end - p.start;
          reader = res.body!.getReader();
        }
        const { done, value } = await reader.read();
        if (done) {
          reader = undefined;
          if (remaining > 0) return controller.error(new Error('upstream file ended early'));
          continue;
        }
        let chunk = value;
        if (skip) {
          const n = Math.min(skip, chunk.length);
          chunk = chunk.subarray(n);
          skip -= n;
        }
        if (chunk.length > remaining) chunk = chunk.subarray(0, remaining);
        remaining -= chunk.length;
        if (remaining === 0) {
          await reader.cancel().catch(() => undefined);
          reader = undefined;
        }
        if (chunk.length) return controller.enqueue(chunk);
      }
    },
    async cancel() {
      await reader?.cancel().catch(() => undefined);
    },
  });
}

async function etagOf(segments: Segment[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(segments)));
  return `"${[...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('')}"`;
}

const extensionOf = (type: string) => (/mpeg|mp3/.test(type) ? 'mp3' : /mp4|m4a|aac/.test(type) ? 'm4a' : 'audio');

export function createGateway(opts: GatewayOptions): (req: Request, info?: RequestInfo) => Promise<Response> {
  const base = opts.base.replace(/\/+$/, '');
  const fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const WS = opts.WebSocket ?? WebSocket;
  const clock = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const ttl = (opts.cacheSeconds ?? 120) * 1000;
  const cache = new Map<string, { at: number; data: Promise<ShowData | undefined> }>();
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag' };
  const q = (filter: Filter) => queryRelays(opts.relays, filter, WS);

  async function load(creator: string, slug: string): Promise<ShowData | undefined> {
    const address = showAddress(creator, slug);
    const [shows, episodeEvents, placementEvents, binding] = await Promise.all([
      q({ kinds: [KIND.show], authors: [creator], '#d': [slug] }),
      q({ kinds: [54], authors: [creator], '#a': [address], limit: 1000 }),
      q({ kinds: [KIND.placement], authors: [creator], limit: 500 }),
      q({ kinds: [KIND.pqBinding], authors: [creator] }),
    ]);
    // Only Fairground accounts, and never anything the app would block outright.
    if (!membersFrom(binding).has(creator)) return undefined;
    const show = shows.map(parseShow).filter((s): s is Show => !!s).sort((a, b) => b.event.created_at - a.event.created_at)[0];
    if (!show || assess(show.event).block) return undefined;
    const episodes = currentEpisodes(episodeEvents.filter((e) => !assess(e).block), address);
    // Podcast apps require an accurate explicit flag.
    if (!show.explicit && [show.event, ...episodes.map((e) => e.event)].some((e) => { const v = assess(e); return !v.block && v.hide === 'sexual'; })) show.explicit = true;
    const placements = placementEvents.length ? placementEvents.map((await ads()).parsePlacement).filter((p): p is Placement => !!p) : [];
    const [acceptances, approvals, bindings] = placements.length
      ? await Promise.all([
        q({ ids: [...new Set(placements.map((p) => p.acceptanceId))] }),
        q({ kinds: [KIND.approval], '#e': placements.map((p) => p.event.id) }),
        q({ kinds: [KIND.pqBinding], authors: [...new Set(placements.map((p) => p.advertiser))] }),
      ])
      : [[], [], []];
    return { show, episodes, placements, acceptances, approvals, bindings };
  }

  function cached(creator: string, slug: string): Promise<ShowData | undefined> {
    const key = `${creator}:${slug}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.data;
    const data = load(creator, slug).catch(() => undefined);
    cache.set(key, { at: Date.now(), data });
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
    return data;
  }

  const notFound = (what: string) => new Response(`${what} not found\n`, { status: 404, headers: { ...cors, 'Content-Type': 'text/plain' } });
  const ramp = opts.ramp && createRamp({ fetch: fetchImpl, ...opts.ramp });
  const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { ...cors, 'Cache-Control': 'no-store' } });

  /** The Fairground member who signed this request, or an error response. */
  async function member(req: Request, body = ''): Promise<string | Response> {
    const auth = verifyAuthHeader(req.headers.get('Authorization'), req.url, req.method, body);
    if ('error' in auth) return reply({ error: auth.error }, 401);
    if (!membersFrom(await q({ kinds: [KIND.pqBinding], authors: [auth.pubkey] })).has(auth.pubkey)) return reply({ error: 'not a Fairground account' }, 403);
    if (opts.blocked?.includes(auth.pubkey)) return reply({ error: 'this account can’t use this gateway' }, 403);
    return auth.pubkey;
  }

  /** The built-in wallet's services: buying and selling through Meld. */
  async function money(req: Request, path: string, info: RequestInfo): Promise<Response | undefined> {
    if (path === '/wallet/config' && req.method === 'GET') return reply({ ramp: !!ramp, ...(opts.ramp ? { provider: 'meld', environment: opts.ramp.environment } : {}) });
    if (path === '/ramp/session' && req.method === 'POST') {
      if (!ramp) return reply({ error: 'buying and selling aren’t set up on this gateway yet' }, 503);
      const body = await req.text();
      const who = await member(req, body);
      if (who instanceof Response) return who;
      let p: { side?: string; walletAddress?: string; amount?: number; redirectURL?: string; asset?: string; countryCode?: string; subdivision?: string };
      try { p = JSON.parse(body || '{}'); } catch { return reply({ error: 'bad request' }, 400); }
      if (!p || typeof p !== 'object') return reply({ error: 'bad request' }, 400);
      if ((p.asset !== undefined && p.asset !== 'ALGO' && p.asset !== 'USDC') || !/^[A-Z]{2}$/.test(p.countryCode ?? '') || (p.subdivision !== undefined && !/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(p.subdivision)) || (p.side !== 'BUY' && p.side !== 'SELL') || !/^[A-Z2-7]{58}$/.test(p.walletAddress ?? '') || !/^(https:\/\/|http:\/\/localhost[:/])/.test(p.redirectURL ?? '')) return reply({ error: 'bad request' }, 400);
      let redirect: URL;
      try { redirect = new URL(p.redirectURL!); } catch { return reply({ error: 'bad return URL' }, 400); }
      const app = new URL(opts.appUrl);
      if (redirect.origin !== app.origin || redirect.pathname !== app.pathname) return reply({ error: 'return to this app only' }, 400);
      if (!info.ip || info.ip === '0.0.0.0') return reply({ error: 'the gateway could not determine your IP address' }, 503);
      if (typeof p.amount !== 'number' || !Number.isFinite(p.amount) || p.amount <= 0 || p.amount > 1_000_000) return reply({ error: 'enter a valid amount' }, 400);
      const amount = p.amount;
      try {
        const session = await ramp.session({
          side: p.side, walletAddress: p.walletAddress!, customer: who, redirectURL: p.redirectURL!, userIp: info.ip, asset: p.asset === 'ALGO' ? 'ALGO' : 'USDC',
          amount, countryCode: p.countryCode!, subdivision: p.subdivision,
        });
        return reply(session);
      } catch (e) {
        return reply({ error: (e as Error).message }, 502);
      }
    }
    const order = /^\/ramp\/order\/([A-Za-z0-9_-]{6,128})$/.exec(path);
    if (order && req.method === 'GET') {
      if (!ramp) return reply({ error: 'buying and selling aren’t set up on this gateway yet' }, 503);
      const who = await member(req);
      if (who instanceof Response) return who;
      try {
        const o = await ramp.order(order[1]);
        if (o.customer !== who) return reply({ error: 'that order belongs to someone else' }, 403);
        if (o.side === 'SELL' && o.provider !== ramp.sellProvider) return reply({ error: 'cash-out supplier changed' }, 409);
        return reply({ order: o, problem: o.side === 'SELL' ? sellOrderProblem(o, who) ?? null : null });
      } catch (e) {
        return reply({ error: (e as Error).message }, 502);
      }
    }
    return undefined;
  }

  return async function handle(req: Request, info: RequestInfo = {}): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
    if (path.startsWith('/wallet/') || path.startsWith('/ramp/')) {
      const allowed = opts.walletOrigins ?? [new URL(opts.appUrl).origin];
      const origin = req.headers.get('Origin');
      // Native/server clients can omit Origin; signed member authentication still applies.
      if (origin && !allowed.includes(origin)) return Response.json({ error: 'origin not allowed' }, { status: 403, headers: { 'Cache-Control': 'no-store', Vary: 'Origin' } });
      const response = req.method === 'OPTIONS'
        ? new Response(null, { status: 204, headers: { 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST' } })
        : (await money(req, path, info)) ?? notFound('page');
      response.headers.set('Access-Control-Allow-Origin', origin ?? allowed[0]);
      response.headers.set('Vary', 'Origin');
      response.headers.set('Cache-Control', 'no-store');
      return response;
    }
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Headers': 'Range, Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, HEAD, POST' } });
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method not allowed\n', { status: 405, headers: cors });
    if (path === '/health') {
      const relays = await Promise.all(opts.relays.map(async (relay) => {
        const started = Date.now();
        const found = await queryRelays([relay], { kinds: [KIND.pqBinding], limit: 1 }, WS, 3000);
        return { relay, ok: found.length > 0, ms: Date.now() - started };
      }));
      return Response.json({ gateway: 'fairground', relays }, { status: relays.some((r) => r.ok) ? 200 : 503, headers: { ...cors, 'Cache-Control': 'no-store' } });
    }
    const route = /^\/podcast\/(npub1[02-9ac-hj-np-z]+)\/([A-Za-z0-9_-]{1,64})(?:\.xml|\/([^/]{1,200})\.(mp3|m4a|audio))$/.exec(path);
    if (!route) return notFound('page');
    let creator: string;
    try {
      const decoded = decode(route[1]);
      if (decoded.type !== 'npub') return notFound('show');
      creator = decoded.data;
    } catch {
      return notFound('show');
    }
    const slug = route[2];
    if (opts.blocked?.includes(creator)) return notFound('show');
    const data = await cached(creator, slug);
    if (!data) return notFound('show');
    const origin = `${url.protocol}//${url.host}`;
    const showPath = `${origin}${base}/podcast/${npubEncode(creator)}/${slug}`;

    if (!route[3]) {
      const xml = renderRss(data.show, data.episodes, {
        feedUrl: `${showPath}.xml`,
        enclosureUrl: (e) => `${showPath}/${encodeURIComponent(e.guid)}.${extensionOf(e.audio.type)}`,
        pageUrl: (e) => (e ? `${opts.appUrl}#/media/${e.event.id}` : `${opts.appUrl}#/show/${npubEncode(creator)}/${slug}`),
        generatedAt: clock(),
      });
      return new Response(req.method === 'HEAD' ? null : xml, {
        headers: { ...cors, 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...opts.feedHeaders },
      });
    }

    const guid = decodeURIComponent(route[3]);
    const episode = data.episodes.find((e) => e.guid === guid);
    if (!episode) return notFound('episode');
    const breaks = !data.placements.length ? [] : (await ads()).breaksFor(
      { creator, kind: 'audio', show: data.show.address, duration: episode.audio.duration, marks: episode.breaks ?? [] },
      data.placements,
      { now: clock(), acceptances: data.acceptances, approvals: data.approvals, pqKeyOf: (await pq()).keyLookup(data.bindings) },
    );
    const segments = stitchPlan(episode, breaks);
    if (!segments) {
      return new Response(null, { status: 302, headers: { ...cors, Location: episode.audio.url, 'Cache-Control': 'public, max-age=300' } });
    }
    const size = segments.reduce((n, s) => n + s.end - s.start, 0);
    const etag = await etagOf(segments);
    const headers: Record<string, string> = {
      ...cors,
      'Content-Type': 'audio/mpeg',
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Cache-Control': 'private, max-age=0',
      'X-Fairground-Ads': String(breaks.reduce((n, b) => n + b.ads.length, 0)),
    };
    const ifRange = req.headers.get('If-Range');
    const range = ifRange && ifRange !== etag ? undefined : parseRange(req.headers.get('Range'), size);
    if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
    const [first, last] = range ?? [0, size - 1];
    const status = range ? 206 : 200;
    if (range) headers['Content-Range'] = `bytes ${first}-${last}/${size}`;
    headers['Content-Length'] = String(last - first + 1);
    if (req.method === 'HEAD') return new Response(null, { status, headers });
    return new Response(streamSegments(segments, first, last, fetchImpl), { status, headers });
  };
}
