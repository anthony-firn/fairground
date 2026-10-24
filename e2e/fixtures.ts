/**
 * Test fixtures for the end-to-end test: a local relay with plainly labelled test accounts, posts, an offer, a media
 * kit and a fan-support page. Used only by automated tests; nothing here is real or published.
 */
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import { createMediaKit } from '../src/mediakit.ts';
import { createPqBinding, generatePqKeys } from '../src/pq.ts';
import { FIXED_INDEX, parseUsd } from '../src/pricing.ts';
import { encodeAddress, RAIL } from '../src/rails/algorand.ts';
import { createOffer } from '../src/sponsorship.ts';
import { createSupportPage } from '../src/support.ts';
import { startDevRelay, type DevRelay } from '../tools/dev-relay.ts';

const TOPICS = [['cooking', 'food'], ['gaming', 'games'], ['running', 'outdoors'], ['tech', 'technology'], ['art', 'art'], ['music', 'music']];
const now = () => Math.floor(Date.now() / 1000);
const month = () => new Date().toISOString().slice(0, 7);

export async function startFixtureRelay(port: number): Promise<DevRelay & { creators: string[]; advertiser: string }> {
  const relay = await startDevRelay(port);
  const store = (ev: Event) => relay.events.push(ev);
  const t = now();
  const creators = TOPICS.map(([first, second], i) => {
    const key = generateSecretKey();
    const pq = generatePqKeys();
    store(createPqBinding(key, pq, undefined, t - 86400 * 30));
    store(finalizeEvent({ kind: 0, created_at: t - 86400, tags: [], content: JSON.stringify({ name: `Test creator ${i + 1}` }) }, key));
    [first, second].forEach((topic, j) => store(finalizeEvent({
      kind: 1, created_at: t - 3600 * (i * 2 + j + 1), content: `Test post ${j + 1} about #${topic}`, tags: [['t', topic]],
    }, key)));
    if (i === 2) {
      store(createSupportPage(key, pq, {
        title: 'Test support page', pitch: 'Test pitch.', rail: RAIL, payTo: encodeAddress(new Uint8Array(32).fill(7)), adFree: true,
        suggested: { amount: parseUsd('5'), currency: 'USD', index: FIXED_INDEX, basePeriod: month() }, goal: parseUsd('500'),
      }));
      store(createMediaKit(key, pq, {
        pitch: 'Test media kit.', topics: ['running'], rate: { amount: parseUsd('250'), currency: 'USD', index: FIXED_INDEX, basePeriod: month() },
      }));
    }
    return getPublicKey(key);
  });
  const fans = Array.from({ length: 5 }, () => generateSecretKey());
  for (const fan of fans) for (const post of relay.events.filter((e) => e.kind === 1).slice(0, 4)) {
    store(finalizeEvent({ kind: 7, created_at: t - 60, content: '+', tags: [['e', post.id], ['p', post.pubkey]] }, fan));
  }
  const brandKey = generateSecretKey();
  const brandPq = generatePqKeys();
  store(createPqBinding(brandKey, brandPq, undefined, t - 86400 * 30));
  store(finalizeEvent({ kind: 0, created_at: t - 86400, tags: [], content: JSON.stringify({ name: 'Test advertiser' }) }, brandKey));
  store(createOffer(brandKey, brandPq, {
    slug: 'test-offer', title: 'Test offer', brief: 'Test brief.', rail: RAIL, deadline: t + 86400 * 14, created_at: t - 3600,
    price: { amount: parseUsd('150'), currency: 'USD', index: FIXED_INDEX, basePeriod: month() },
  }));
  return { ...relay, creators, advertiser: getPublicKey(brandKey) };
}
