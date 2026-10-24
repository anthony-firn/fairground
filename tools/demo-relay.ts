/**
 * A dev relay preloaded with sample creators, posts, an advertiser's offer, a media kit and a fan-support page, for
 * trying the app and for end-to-end tests without touching public relays. Everything in it is invented demo data.
 *
 *   node tools/demo-relay.ts [port]       # then open the app with ?relay=ws://localhost:7777
 */
import { fileURLToPath } from 'node:url';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import { createMediaKit } from '../src/mediakit.ts';
import { createPqBinding, generatePqKeys } from '../src/pq.ts';
import { FIXED_INDEX, parseUsd } from '../src/pricing.ts';
import { encodeAddress, RAIL } from '../src/rails/algorand.ts';
import { createOffer } from '../src/sponsorship.ts';
import { createSupportPage } from '../src/support.ts';
import { startDevRelay, type DevRelay } from './dev-relay.ts';

const PEOPLE = [
  { name: 'Mara Trails', about: 'Trail running, mountains and honest gear reviews.', tags: ['running', 'outdoors'] },
  { name: 'Kenji Cooks', about: 'Weeknight recipes in 20 minutes.', tags: ['cooking', 'food'] },
  { name: 'Pixel Pilot', about: 'Indie games and the people who make them.', tags: ['gaming', 'games'] },
  { name: 'Ada Builds', about: 'Electronics, 3D printing and small tools.', tags: ['tech', 'technology'] },
  { name: 'Sol Sketches', about: 'Daily ink drawings.', tags: ['art'] },
  { name: 'Riverside Records', about: 'New folk and bluegrass every week.', tags: ['music'] },
];

const POSTS: Record<string, string[]> = {
  running: ['Ran the ridge loop before sunrise. Fog in the valley, clear on top. #running', 'Three things I check before any long trail run: water, light, and someone who knows my route. #outdoors'],
  cooking: ['Miso butter noodles: 15 minutes, five ingredients, zero regrets. #cooking', 'Sunday batch: roasted chickpeas, pickled onions, a big pot of rice. The week is sorted. #food'],
  gaming: ['Played a tiny puzzle game made by two people in a garage. Best thing I tried this month. #gaming', 'Speedrunners are the best kind of engineers. #games'],
  tech: ['Printed a replacement hinge for the dishwasher. 40 minutes, 12 cents of plastic. #tech', 'If a tool needs an account to turn on, it isn’t your tool. #technology'],
  art: ['Today’s sketch: the old water tower at dusk. #art', 'Ink, one brush, no erasing. That’s the whole rule. #art'],
  music: ['New session recorded on the porch, rain included. #music', 'Banjo strings changed, neighbours warned. #music'],
};

const now = () => Math.floor(Date.now() / 1000);

export async function startDemoRelay(port = 7777): Promise<DevRelay & { advertiser: string; creators: string[] }> {
  const relay = await startDevRelay(port);
  const store = (ev: Event) => relay.events.push(ev);
  const creators: string[] = [];
  const t = now();
  PEOPLE.forEach((p, i) => {
    const key = generateSecretKey();
    const pq = generatePqKeys();
    const pubkey = getPublicKey(key);
    creators.push(pubkey);
    store(createPqBinding(key, pq, undefined, t - 86400 * 30));
    store(finalizeEvent({ kind: 0, created_at: t - 86400 * 20, tags: [], content: JSON.stringify({ name: p.name, about: p.about }) }, key));
    POSTS[p.tags[0]].forEach((text, j) => store(finalizeEvent({
      kind: 1, created_at: t - 3600 * (i * 2 + j + 1), content: text, tags: [...text.matchAll(/#(\w+)/g)].map((m) => ['t', m[1]]),
    }, key)));
    if (i === 0) {
      const payTo = encodeAddress(new Uint8Array(32).fill(7));
      store(createSupportPage(key, pq, {
        title: 'Keep the trail videos coming', pitch: 'Support pays for editing time and gas money to the trailheads.',
        suggested: { amount: parseUsd('5'), currency: 'USD', index: FIXED_INDEX, basePeriod: new Date().toISOString().slice(0, 7) },
        goal: parseUsd('500'), rail: RAIL, payTo, adFree: true, created_at: t - 86400,
      }));
      store(createMediaKit(key, pq, {
        pitch: 'Weekly trail-running videos and honest gear reviews.', topics: ['running', 'outdoors'], created_at: t - 86400,
        rate: { amount: parseUsd('250'), currency: 'USD', index: FIXED_INDEX, basePeriod: new Date().toISOString().slice(0, 7) },
      }));
    }
  });
  // Reactions, so engagement has something to rank by.
  const fans = Array.from({ length: 5 }, () => generateSecretKey());
  const popular = relay.events.filter((e) => e.kind === 1).slice(0, 4);
  for (const fan of fans) for (const post of popular) store(finalizeEvent({ kind: 7, created_at: t - 60, content: '+', tags: [['e', post.id], ['p', post.pubkey]] }, fan));

  const brandKey = generateSecretKey();
  const brandPq = generatePqKeys();
  store(createPqBinding(brandKey, brandPq, undefined, t - 86400 * 30));
  store(finalizeEvent({ kind: 0, created_at: t - 86400 * 20, tags: [], content: JSON.stringify({ name: 'Northpeak Gear', about: 'Shoes for rough ground.' }) }, brandKey));
  store(createOffer(brandKey, brandPq, {
    slug: 'autumn-trail-shoe', title: 'Our autumn trail shoe', brief: 'Take the Ridgeline 3 on a run and tell your audience what you honestly think.',
    price: { amount: parseUsd('150'), currency: 'USD', index: FIXED_INDEX, basePeriod: new Date().toISOString().slice(0, 7) },
    rail: RAIL, deadline: t + 86400 * 14, created_at: t - 3600,
  }));
  return { ...relay, advertiser: getPublicKey(brandKey), creators };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const relay = await startDemoRelay(Number(process.argv[2] ?? 7777));
  console.log(`Demo relay with ${relay.events.length} events on ${relay.url}`);
}
