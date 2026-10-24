import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { npubEncode } from 'nostr-tools/nip19';
import { randomBytes } from '@noble/hashes/utils.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  breaksFor,
  createApproval,
  createCampaign,
  createPlacement,
  parseCampaign,
  parsePlacement,
  planBudget,
  promoCodeFor,
  trackedUrl,
  type Spot,
} from '../src/ads.ts';
import { createGateway, parseRange, stitchPlan } from '../src/gateway.ts';
import { membersFrom } from '../src/network.ts';
import { mp3Layout, mp3OffsetAt } from '../src/mp3.ts';
import {
  createPodcastEpisode,
  createShow,
  currentEpisodes,
  feedProblems,
  feedUrl,
  parseEpisode,
  parseShow,
  podcastGuid,
  renderRss,
} from '../src/podcast.ts';
import { keyLookup } from '../src/pq.ts';
import { FIXED_INDEX, parseUsd } from '../src/pricing.ts';
import { encodeAddress, RAIL } from '../src/rails/algorand.ts';
import { checkDeal, createAcceptance, createOffer, parseOffer, type OfferTerms } from '../src/sponsorship.ts';
import { startDevRelay } from '../tools/dev-relay.ts';
import { actor, DAY, fromRelay } from './helpers.ts';

const T0 = 1_790_000_000;
const file = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const EPISODE = file('episode.mp3');
const SPOT = file('spot.mp3');
const OTHER = file('vbr-stereo.mp3');
const FILES: Record<string, Uint8Array> = { 'https://files.test/episode.mp3': EPISODE, 'https://files.test/spot.mp3': SPOT, 'https://files.test/other.mp3': OTHER };

/** A file host that honours Range, like Blossom servers do. */
const fileFetch: typeof fetch = async (input, init) => {
  const bytes = FILES[String(input)];
  if (!bytes) return new Response('missing', { status: 404 });
  const range = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('Range') ?? '');
  if (!range) return new Response(bytes.slice(), { status: 200 });
  return new Response(bytes.slice(Number(range[1]), Number(range[2]) + 1), { status: 206 });
};

const [creator, brand, stranger] = [actor(), actor(), actor()];
const pqKeyOf = keyLookup([creator, brand, stranger].map((a) => a.binding));
const payTo = encodeAddress(randomBytes(32));
const episodeLayout = mp3Layout(EPISODE)!;
const spotLayout = mp3Layout(SPOT)!;
const MID = mp3OffsetAt(EPISODE, episodeLayout, 5);
const spot: Spot = { url: 'https://files.test/spot.mp3', type: 'audio/mpeg', duration: spotLayout.duration, mp3: { ...spotLayout } };

const show = createShow(creator.nostrKey, {
  slug: 'test-show', title: 'Tests & <Things>', description: 'A show for tests.', image: 'https://files.test/art.jpg', author: 'Test Host',
  category: 'Technology', explicit: false, language: 'en', ownerEmail: 'host@example.com', guid: podcastGuid('https://gw.test/podcast/x/test-show.xml'), created_at: T0,
});
const showAddr = parseShow(show)!.address;
const episodeEvent = createPodcastEpisode(creator.nostrKey, {
  show: showAddr, guid: 'ep-1', title: 'Episode one', description: 'Pilot', episode: 1,
  audio: { url: 'https://files.test/episode.mp3', type: 'audio/mpeg', size: EPISODE.length, duration: episodeLayout.duration },
  breaks: [{ at: 5, byteOffset: MID }], mp3: episodeLayout, created_at: T0 + 10,
});

function deal(terms: Partial<OfferTerms> = {}) {
  const offer = createOffer(brand.nostrKey, brand.pq, {
    slug: `read-${Math.random()}`, title: 'Host read', brief: 'Read our ad.', rail: RAIL, deadline: T0 + 30 * DAY, creator: creator.pubkey,
    price: { amount: parseUsd('250'), currency: 'USD', index: FIXED_INDEX, basePeriod: '2026-10' }, created_at: T0,
    terms: { format: 'host-read', media: ['audio'], slots: ['pre', 'mid'], flight: { start: T0, end: T0 + 28 * DAY }, points: ['Say it’s fast'], avoid: [], approval: false, ...terms },
  });
  const acceptance = createAcceptance(creator.nostrKey, creator.pq, parseOffer(offer)!, payTo, T0 + 100);
  return { offer, acceptance };
}

function placementFor(acceptance: ReturnType<typeof deal>['acceptance'], over: Partial<Parameters<typeof createPlacement>[1]> = {}) {
  return createPlacement(creator.nostrKey, {
    acceptance, slots: ['pre', 'mid'], start: T0, end: T0 + 28 * DAY, shows: [], video: false, spots: [spot], label: 'Sponsored by Acme', code: 'ACMETEST', created_at: T0 + 200, ...over,
  }, creator.pq);
}

test('MP3 layout: frames, header frame and duration, and frame-aligned offsets', () => {
  assert.equal(episodeLayout.sampleRate, 44100);
  assert.equal(episodeLayout.channels, 1);
  assert.ok(episodeLayout.id3End > 0 && episodeLayout.audioStart > episodeLayout.id3End, 'the ID3 tag and Info frame come first');
  assert.ok(Math.abs(episodeLayout.duration - 10.03) < 0.01);
  assert.equal(EPISODE[MID], 0xff, 'mid-roll offset is a frame boundary');
  assert.equal(mp3Layout(new Uint8Array(500)), undefined, 'silence bytes are not an MP3');
});

test('podcast GUIDs follow the Podcasting 2.0 rule', () => {
  assert.equal(podcastGuid('https://mp3s.nashownotes.com/pc20rss.xml'), '917393e3-1b1e-5cef-ace4-edaa54e1f810');
});

test('shows and episodes round-trip, and the newest version of an episode wins', () => {
  const s = parseShow(show)!;
  assert.equal(s.title, 'Tests & <Things>');
  assert.equal(s.ownerEmail, 'host@example.com');
  const ep = parseEpisode(episodeEvent)!;
  assert.deepEqual(ep.breaks, [{ at: 5, byteOffset: MID }]);
  assert.equal(ep.mp3?.audioStart, episodeLayout.audioStart);
  const edited = createPodcastEpisode(creator.nostrKey, { ...ep, title: 'Episode one (fixed)', created_at: T0 + 20 });
  const list = currentEpisodes([episodeEvent, edited], showAddr);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Episode one (fixed)');
  const someoneElse = createPodcastEpisode(stranger.nostrKey, { ...ep, guid: 'x' });
  assert.equal(parseEpisode(someoneElse), undefined, 'only the show’s creator can add episodes to it');
});

test('RSS feeds are valid XML with what Apple Podcasts and Spotify require', () => {
  const s = parseShow(show)!;
  const xml = renderRss(s, [parseEpisode(episodeEvent)!], {
    feedUrl: 'https://gw.test/feed.xml', enclosureUrl: (e) => `https://gw.test/e/${e.guid}.mp3`, pageUrl: () => 'https://app.test/', generatedAt: T0,
  });
  assert.equal(XMLValidator.validate(xml), true);
  const rss = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(xml).rss;
  const ch = rss.channel;
  assert.equal(ch.title, 'Tests & <Things>');
  assert.equal(ch['itunes:image']['@_href'], 'https://files.test/art.jpg');
  assert.equal(ch['itunes:category']['@_text'], 'Technology');
  assert.equal(ch['itunes:explicit'], 'false');
  assert.equal(ch['itunes:owner']['itunes:email'], 'host@example.com');
  assert.equal(ch['podcast:guid'], s.guid);
  assert.equal(ch.item.enclosure['@_url'], 'https://gw.test/e/ep-1.mp3');
  assert.equal(Number(ch.item.enclosure['@_length']), EPISODE.length);
  assert.equal(ch.item.guid['#text'], 'ep-1');
  assert.equal(ch.item['itunes:duration'], '10');
  assert.deepEqual(feedProblems(s, [parseEpisode(episodeEvent)!]), []);
  assert.equal(feedProblems({ ...s, ownerEmail: undefined }, []).length, 2);
});

test('campaigns, per-creator promo codes, tracked links and budget plans', () => {
  const c = parseCampaign(createCampaign(brand.nostrKey, {
    slug: 'fall', name: 'Fall launch', objective: 'conversions', product: 'Trail shoe', offer: '20% off', url: 'https://shop.test/shoe', promo: 'trail',
    points: ['Light', 'Grippy'], avoid: ['Medical claims'], formats: ['host-read'], media: ['audio', 'video'], slots: ['pre', 'mid'],
    start: T0, end: T0 + 28 * DAY, budget: parseUsd('10000'), cpm: parseUsd('25'), topics: ['Running'], regions: ['US'], languages: ['en'], exclude: ['politics'], approval: true,
  }))!;
  assert.equal(c.name, 'Fall launch');
  assert.deepEqual(c.points, ['Light', 'Grippy']);
  assert.equal(c.cpm, parseUsd('25'));
  assert.equal(c.approval, true);
  assert.equal(promoCodeFor('trail-', 'Zoë Runs!'), 'TRAILZOERUNS');
  const link = new URL(trackedUrl('https://shop.test/shoe?x=1', 'fall', creator.pubkey));
  assert.equal(link.searchParams.get('utm_source'), 'fairground');
  assert.equal(link.searchParams.get('x'), '1');
  const plan = planBudget(parseUsd('10000'), parseUsd('25'), 4);
  assert.equal(plan.impressions, 400_000);
  assert.equal(plan.perCreator, parseUsd('2500'));
  assert.match(planBudget(parseUsd('1000'), parseUsd('25'), 2).warning ?? '', /three creators/);
});

test('a host-read deal is delivered by a placement, checked against the offer’s terms', () => {
  const { offer, acceptance } = deal();
  assert.equal(parseOffer(offer)!.terms?.format, 'host-read');
  const placement = placementFor(acceptance);
  assert.equal(checkDeal({ offer, acceptance, delivery: placement }, { pqKeyOf }).stage, 'delivered');
  const wrongSlot = placementFor(acceptance, { slots: ['post'] });
  assert.match(checkDeal({ offer, acceptance, delivery: wrongSlot }, { pqKeyOf }).problems[0], /slots/);
  const late = placementFor(acceptance, { end: T0 + 90 * DAY });
  assert.match(checkDeal({ offer, acceptance, delivery: late }, { pqKeyOf }).problems[0], /dates/);
  assert.throws(() => placementFor(acceptance, { label: 'Acme' }), /disclose/);
});

const media = { creator: creator.pubkey, kind: 'audio' as const, show: showAddr, duration: 10, marks: [{ at: 5, byteOffset: MID }] };

test('breaks: dates, approval of the exact read, scope and pod size', () => {
  const { acceptance } = deal();
  const p = parsePlacement(fromRelay(placementFor(acceptance)))!;
  const ctx = { now: T0 + DAY, acceptances: [acceptance], approvals: [], pqKeyOf };
  const breaks = breaksFor(media, [p], ctx);
  assert.deepEqual(breaks.map((b) => [b.slot, b.at]), [['pre', 0], ['mid', 5]]);
  assert.equal(breaksFor(media, [p], { ...ctx, now: T0 - 1 }).length, 0, 'not before the flight');
  assert.equal(breaksFor(media, [p], { ...ctx, now: T0 + 28 * DAY }).length, 0, 'not after it');
  assert.equal(breaksFor(media, [p], { ...ctx, acceptances: [] }).length, 0, 'not without a deal');
  assert.equal(breaksFor({ ...media, marks: [] }, [p], ctx).length, 1, 'mid-rolls need a mark');
  assert.equal(breaksFor({ ...media, kind: 'video' }, [p], ctx).length, 0, 'videos only when the placement includes them');
  assert.equal(breaksFor({ ...media, show: 'other' }, [parsePlacement(placementFor(acceptance, { shows: [showAddr] }))!], ctx).length, 0, 'only on the shows it names');

  const approved = deal({ approval: true });
  const q = parsePlacement(placementFor(approved.acceptance))!;
  const ctx2 = { ...ctx, acceptances: [approved.acceptance] };
  assert.equal(breaksFor(media, [q], ctx2).length, 0, 'waits for approval');
  const yes = createApproval(brand.nostrKey, brand.pq, q.event, 'approved', '', T0 + 300);
  assert.equal(breaksFor(media, [q], { ...ctx2, approvals: [yes] }).length, 2);
  const rerecorded = parsePlacement(placementFor(approved.acceptance, { created_at: T0 + 300, script: 'new words' }))!;
  assert.equal(breaksFor(media, [rerecorded], { ...ctx2, approvals: [yes] }).length, 0, 'an approval covers only the version approved');
  const forged = createApproval(stranger.nostrKey, stranger.pq, q.event, 'approved');
  assert.equal(breaksFor(media, [q], { ...ctx2, approvals: [forged] }).length, 0, 'only the advertiser can approve');
  const no = createApproval(brand.nostrKey, brand.pq, q.event, 'changes', 'Mention the discount', T0 + 400);
  assert.equal(breaksFor(media, [q], { ...ctx2, approvals: [yes, no] }).length, 0, 'the newest verdict counts');

  const deals = Array.from({ length: 5 }, () => deal());
  const pod = breaksFor(media, deals.map((d) => parsePlacement(placementFor(d.acceptance))!), { ...ctx, acceptances: deals.map((d) => d.acceptance) });
  assert.deepEqual(pod.map((b) => b.ads.length), [3, 3], 'at most three ads per break');
});

test('stitching: the ID3 tag, then reads spliced at frame boundaries, and the Info frame left out', () => {
  const { acceptance } = deal();
  const p = parsePlacement(placementFor(acceptance))!;
  const breaks = breaksFor(media, [p], { now: T0 + DAY, acceptances: [acceptance], approvals: [], pqKeyOf });
  const plan = stitchPlan(parseEpisode(episodeEvent)!, breaks)!;
  const e = 'https://files.test/episode.mp3';
  const s = 'https://files.test/spot.mp3';
  assert.deepEqual(plan, [
    { url: e, start: 0, end: episodeLayout.id3End },
    { url: s, start: spotLayout.audioStart, end: spotLayout.audioEnd },
    { url: e, start: episodeLayout.audioStart, end: MID },
    { url: s, start: spotLayout.audioStart, end: spotLayout.audioEnd },
    { url: e, start: MID, end: episodeLayout.audioEnd },
  ]);
  const incompatible = parsePlacement(placementFor(acceptance, { spots: [{ url: 'https://files.test/other.mp3', type: 'audio/mpeg', mp3: { ...mp3Layout(OTHER)! } }] }))!;
  const b2 = breaksFor(media, [incompatible], { now: T0 + DAY, acceptances: [acceptance], approvals: [], pqKeyOf });
  assert.equal(stitchPlan(parseEpisode(episodeEvent)!, b2), undefined, 'a read at another sample rate is not spliced in');
});

test('byte ranges', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), [0, 99]);
  assert.deepEqual(parseRange('bytes=900-', 1000), [900, 999]);
  assert.deepEqual(parseRange('bytes=-100', 1000), [900, 999]);
  assert.deepEqual(parseRange('bytes=0-5000', 1000), [0, 999]);
  assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(parseRange(null, 1000), undefined);
});

test('membership: only Fairground key bindings make an account part of the network', () => {
  const note = { ...creator.binding, kind: 1 };
  assert.deepEqual([...membersFrom([creator.binding, brand.binding, note as never])].sort(), [creator.pubkey, brand.pubkey].sort());
});

test('the gateway serves feeds, redirects plain downloads, and stitches reads into downloads with Range support', async () => {
  const relay = await startDevRelay(7795);
  try {
    const { offer, acceptance } = deal();
    const placement = placementFor(acceptance);
    relay.events.push(show, episodeEvent, offer, acceptance, placement, brand.binding, creator.binding);
    let clock = T0 + DAY;
    const gw = createGateway({ relays: [relay.url], base: '/fg', appUrl: 'https://app.test/', fetch: fileFetch, now: () => clock, cacheSeconds: 0 });
    const npub = npubEncode(creator.pubkey);
    const feed = await gw(new Request(`https://gw.test/fg/podcast/${npub}/test-show.xml`));
    assert.equal(feed.status, 200);
    const xml = await feed.text();
    assert.equal(XMLValidator.validate(xml), true);
    assert.equal(feedUrl('https://gw.test/fg', creator.pubkey, 'test-show'), `https://gw.test/fg/podcast/${npub}/test-show.xml`);
    const enclosure = new XMLParser({ ignoreAttributes: false }).parse(xml).rss.channel.item.enclosure['@_url'];
    assert.equal(enclosure, `https://gw.test/fg/podcast/${npub}/test-show/ep-1.mp3`);

    const expected = new Uint8Array([
      ...EPISODE.slice(0, episodeLayout.id3End), ...SPOT.slice(spotLayout.audioStart, spotLayout.audioEnd),
      ...EPISODE.slice(episodeLayout.audioStart, MID), ...SPOT.slice(spotLayout.audioStart, spotLayout.audioEnd), ...EPISODE.slice(MID, episodeLayout.audioEnd),
    ]);
    const head = await gw(new Request(enclosure, { method: 'HEAD' }));
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('Accept-Ranges'), 'bytes');
    assert.equal(Number(head.headers.get('Content-Length')), expected.length);
    const full = new Uint8Array(await (await gw(new Request(enclosure))).arrayBuffer());
    assert.deepEqual(full, expected);
    const stitched = mp3Layout(full)!;
    assert.equal(stitched.frames, episodeLayout.frames + 2 * spotLayout.frames, 'every frame decodes in sequence');
    assert.ok(Math.abs(stitched.duration - (episodeLayout.duration + 2 * spotLayout.duration)) < 0.01);

    const part = await gw(new Request(enclosure, { headers: { Range: 'bytes=100-20099' } }));
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('Content-Range'), `bytes 100-20099/${expected.length}`);
    assert.deepEqual(new Uint8Array(await part.arrayBuffer()), expected.slice(100, 20100));
    const etag = head.headers.get('ETag')!;
    const stale = await gw(new Request(enclosure, { headers: { Range: 'bytes=0-9', 'If-Range': '"old"' } }));
    assert.equal(stale.status, 200, 'a resumed download of a different stitch starts over');
    await stale.body?.cancel();
    assert.equal((await gw(new Request(enclosure, { headers: { Range: 'bytes=0-9', 'If-Range': etag } }))).status, 206);
    assert.equal((await gw(new Request(enclosure, { headers: { Range: `bytes=${expected.length}-` } }))).status, 416);

    clock = T0 + 60 * DAY;
    const after = await gw(new Request(enclosure));
    assert.equal(after.status, 302, 'after the flight, downloads go straight to the creator’s file');
    assert.equal(after.headers.get('Location'), 'https://files.test/episode.mp3');
    assert.equal((await gw(new Request(`https://gw.test/fg/podcast/${npub}/nope.xml`))).status, 404);
    const health = await gw(new Request('https://gw.test/fg/health'));
    assert.equal(health.status, 200);
    assert.equal((await health.json()).relays[0].ok, true);
    const blockedGw = createGateway({ relays: [relay.url], base: '/fg', appUrl: 'https://app.test/', fetch: fileFetch, blocked: [creator.pubkey] });
    assert.equal((await blockedGw(new Request(`https://gw.test/fg/podcast/${npub}/test-show.xml`))).status, 404, 'operators can take a show down');

    // Not a Fairground account: no key binding.
    const outsider = generateSecretKey();
    relay.events.push(createShow(outsider, { ...parseShow(show)!, slug: 'outside' }));
    assert.equal((await gw(new Request(`https://gw.test/fg/podcast/${npubEncode(getPublicKey(outsider))}/outside.xml`))).status, 404, 'only Fairground accounts');
  } finally {
    await relay.close();
  }
});

