/**
 * Test fixtures for the end-to-end test: a local relay with plainly labelled test accounts, posts, an offer, a media
 * kit and a fan-support page. Used only by automated tests; nothing here is real or published.
 */
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import { createListing, createStore } from '../src/commerce.ts';
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

export async function startFixtureRelay(port: number): Promise<DevRelay & { creators: string[]; advertiser: string; shop: string }> {
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
  // Posts the feed must never show (abuse) or show only with safe search off (adult); synthetic test strings.
  const unsafeKey = generateSecretKey();
  store(finalizeEvent({ kind: 0, created_at: t - 86400, tags: [], content: JSON.stringify({ name: 'Test unsafe account' }) }, unsafeKey));
  store(finalizeEvent({ kind: 1, created_at: t - 60, content: 'Test abuse fixture: teen nude content t.me/x', tags: [] }, unsafeKey));
  store(finalizeEvent({ kind: 1, created_at: t - 61, content: 'Test adult fixture #nsfw', tags: [['t', 'nsfw']] }, unsafeKey));

  // A restaurant with a menu item, a service, and a request for help.
  const shopKey = generateSecretKey();
  const shopPq = generatePqKeys();
  const shop = getPublicKey(shopKey);
  const shopPay = { rail: RAIL, address: encodeAddress(new Uint8Array(32).fill(9)) };
  store(createPqBinding(shopKey, shopPq, undefined, t - 86400 * 30));
  store(finalizeEvent({ kind: 0, created_at: t - 86400, tags: [], content: JSON.stringify({ name: 'Test restaurant owner' }) }, shopKey));
  store(createStore(shopKey, shopPq, { slug: 'store', kind: 'restaurant', name: 'Test Kitchen', about: 'Test restaurant.', hours: 'Daily 11–9', fulfillment: ['pickup', 'delivery'], payTo: shopPay, open: true, created_at: t - 3600 }));
  store(createListing(shopKey, shopPq, {
    slug: 'test-burrito', type: 'food', title: 'Test burrito', description: 'Test menu item.', price: { amount: '12.50', currency: 'USD' },
    images: [], categories: ['mains'], payTo: shopPay, fulfillment: ['pickup', 'delivery'], store: `33477:${shop}:store`, created_at: t - 3000,
  }));
  store(createListing(shopKey, shopPq, {
    slug: 'test-errands', type: 'service', title: 'Test grocery runs', description: 'Test service.', price: { amount: '20', currency: 'USD', frequency: 'hour' },
    images: [], categories: ['groceries'], payTo: shopPay, fulfillment: ['onsite'], created_at: t - 2900,
  }));

  const brandKey = generateSecretKey();
  const brandPq = generatePqKeys();
  store(createPqBinding(brandKey, brandPq, undefined, t - 86400 * 30));
  store(finalizeEvent({ kind: 0, created_at: t - 86400, tags: [], content: JSON.stringify({ name: 'Test advertiser' }) }, brandKey));
  store(createOffer(brandKey, brandPq, {
    slug: 'test-offer', title: 'Test offer', brief: 'Test brief.', rail: RAIL, deadline: t + 86400 * 14, created_at: t - 3600,
    price: { amount: parseUsd('150'), currency: 'USD', index: FIXED_INDEX, basePeriod: month() },
  }));
  return { ...relay, creators, advertiser: getPublicKey(brandKey), shop };
}
