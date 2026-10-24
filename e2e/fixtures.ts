/**
 * Test fixtures for the end-to-end test: a local relay with plainly labelled test accounts, posts, an offer, a media
 * kit and a fan-support page. Used only by automated tests; nothing here is real or published.
 */
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import { createListing, createStore } from '../src/commerce.ts';
import { createEpisode, createPhotoPost, createVideo } from '../src/media.ts';
import { createMediaKit } from '../src/mediakit.ts';
import { createPqBinding, generatePqKeys } from '../src/pq.ts';
import { FIXED_INDEX, parseUsd } from '../src/pricing.ts';
import { encodeAddress, RAIL } from '../src/rails/algorand.ts';
import { createOffer } from '../src/sponsorship.ts';
import { createSupportPage } from '../src/support.ts';
import { startDevRelay, type DevRelay } from '../tools/dev-relay.ts';

const TOPICS = [['cooking', 'food'], ['gaming', 'games'], ['running', 'outdoors'], ['tech', 'technology'], ['art', 'art'], ['music', 'music']];
const now = () => Math.floor(Date.now() / 1000);

/** Test media is served from this origin by Playwright routing (see serveMedia in media.ts), from the files in e2e/media. */
export const MEDIA = 'https://media.fairground.test';
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
  // One of each media format, and a post in another language that an English reader shouldn't see by default.
  const mediaKey = generateSecretKey();
  store(finalizeEvent({ kind: 0, created_at: t - 86400, tags: [], content: JSON.stringify({ name: 'Test media creator' }) }, mediaKey));
  store(createPhotoPost(mediaKey, { title: 'Test photo set', description: 'Test photos #art', images: [{ url: `${MEDIA}/photo1.jpg`, dim: '640x480' }, { url: `${MEDIA}/photo2.jpg` }], created_at: t - 1200 }));
  store(finalizeEvent({ kind: 1, created_at: t - 1300, content: `Test post with a photo #art ${MEDIA}/photo3.jpg`, tags: [['t', 'art']] }, mediaKey));
  store(createVideo(mediaKey, { short: false, title: 'Test video', description: 'Test video description #tech', url: `${MEDIA}/video.webm`, m: 'video/webm', poster: `${MEDIA}/poster.jpg`, duration: 4, dim: '640x360', created_at: t - 1400 }));
  store(createVideo(mediaKey, { short: false, title: 'Test video two', description: 'Another test video', url: `${MEDIA}/video.webm`, m: 'video/webm', duration: 4, dim: '640x360', created_at: t - 1500 }));
  store(createVideo(mediaKey, { short: true, title: 'Test short', description: 'Test short #music', url: `${MEDIA}/short.webm`, m: 'video/webm', duration: 4, dim: '360x640', created_at: t - 1600 }));
  store(createEpisode(mediaKey, { title: 'Test episode 1', description: 'Test podcast episode', audio: `${MEDIA}/episode.ogg`, type: 'audio/ogg', image: `${MEDIA}/cover.jpg`, created_at: t - 1700 }));
  store(finalizeEvent({ kind: 1, created_at: t - 1800, content: 'Publicación de prueba: el perro de mi vecino no para de ladrar por la noche', tags: [] }, mediaKey));

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
