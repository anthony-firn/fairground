/**
 * End-to-end test of podcasts and host-read ads: a creator starts a show and publishes an episode with a mid-roll mark,
 * lists a media kit, an advertiser plans a campaign and sends an offer, the creator records the read, the advertiser
 * approves it, a listener hears it in the app, and the gateway stitches it into the RSS download. Also checks that
 * anyone can donate to the development fund. Media servers and the Algorand indexer are stand-ins; nothing is real.
 *
 *   npm run app:build && node e2e/podcast.ts [screenshot-dir]
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { npubEncode } from 'nostr-tools/nip19';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { preview } from 'vite';
import { createGateway } from '../src/gateway.ts';
import { KIND } from '../src/kinds.ts';
import { mp3Layout } from '../src/mp3.ts';
import { DEVELOPMENT_ADDRESS } from '../src/defaults.ts';
import { encodeAddress } from '../src/rails/algorand.ts';
import { MEDIA, startFixtureRelay } from './fixtures.ts';

const root = path.dirname(fileURLToPath(import.meta.url));
const shots = process.argv[2];
const relay = await startFixtureRelay(7794);
const server = await preview({ root: path.join(root, '../app'), configFile: path.join(root, '../app/vite.config.ts'), preview: { port: 4184, strictPort: true } });
const url = 'http://localhost:4184/?relay=ws://localhost:7794';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors: string[] = [];
const step = (name: string) => console.log(`- ${name}`);
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, PUT, OPTIONS', 'Access-Control-Expose-Headers': '*' };
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4' };

/** What the stand-in media servers hold, by SHA-256. */
const blobs = new Map<string, { body: Buffer; type: string }>();

async function standIns(ctx: BrowserContext) {
  await ctx.route(/^https:\/\/(blossom\.band|blossom\.primal\.net|nostr\.download)\/upload$/, async (route) => {
    const req = route.request();
    if (req.method() !== 'PUT') return route.fulfill({ status: req.method() === 'OPTIONS' ? 204 : 200, headers: CORS });
    const body = req.postDataBuffer()!;
    const type = req.headers()['content-type'] ?? 'application/octet-stream';
    const hash = createHash('sha256').update(body).digest('hex');
    blobs.set(hash, { body, type });
    await route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ url: `${MEDIA}/${hash}.${EXT[type] ?? 'bin'}`, sha256: hash, size: body.length, type }) });
  });
  await ctx.route(`${MEDIA}/**`, async (route) => {
    const name = path.basename(new URL(route.request().url()).pathname);
    const blob = blobs.get(name.split('.')[0]);
    const body = blob?.body ?? (await readFile(path.join(root, 'media', name)).catch(() => undefined));
    await (body ? route.fulfill({ body, headers: CORS, contentType: blob?.type ?? 'application/octet-stream' }) : route.fulfill({ status: 404 }));
  });
  // The Algorand indexer: every account can receive USDC, and no payment has arrived.
  await ctx.route('https://mainnet-idx.4160.nodely.dev/**', (route) => route.fulfill({
    headers: CORS, contentType: 'application/json',
    body: JSON.stringify(route.request().url().includes('/assets') ? { assets: [{ 'asset-id': 31566704, amount: 0, 'is-frozen': false, deleted: false }] } : { transactions: [] }),
  }));
}

async function person(viewport = { width: 1440, height: 900 }): Promise<{ page: Page; pubkey: string }> {
  const ctx = await browser.newContext({ viewport, locale: 'en-US' });
  await standIns(ctx);
  await ctx.addInitScript((payTo) => {
    localStorage.setItem('fairground.model', JSON.stringify({ kind: 'off' }));
    localStorage.setItem('fairground.payTo', JSON.stringify(payTo));
  }, encodeAddress(crypto.getRandomValues(new Uint8Array(32))));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByRole('button', { name: /Skip and start/ }).click();
  await page.waitForFunction(() => !!localStorage.getItem('fairground.account'));
  const pubkey = await page.evaluate(() => JSON.parse(localStorage.getItem('fairground.account')!).binding.pubkey as string);
  await page.waitForTimeout(800);
  return { page, pubkey };
}
const shot = async (page: Page, name: string) => shots && page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });
const latest = (kind: number, pubkey: string) => relay.events.filter((e) => e.kind === kind && e.pubkey === pubkey).sort((a, b) => b.created_at - a.created_at)[0];
const tag = (ev: { tags: string[][] }, name: string) => ev.tags.find((t) => t[0] === name);
const go = (page: Page, hash: string) => page.evaluate((h) => (location.hash = h), hash);

try {
  const creator = await person();
  const sidebar = creator.page.getByRole('complementary', { name: 'Sections' });

  step('a creator starts a podcast');
  await sidebar.getByRole('link', { name: 'Create' }).click();
  await creator.page.getByRole('button', { name: /Start a podcast/ }).click();
  await creator.page.locator('input[type=file][accept="image/jpeg,image/png"]').setInputFiles(path.join(root, 'media/art.jpg'));
  await creator.page.getByRole('img', { name: 'Show artwork' }).waitFor();
  await creator.page.getByLabel('Show name').fill('Test Show & Friends');
  await creator.page.getByLabel('What it’s about').fill('A test podcast about testing.');
  await creator.page.getByLabel('Host or author').fill('Test Host');
  await creator.page.getByLabel('Owner email (optional)').fill('host@example.com');
  await shot(creator.page, 'show-editor');
  await creator.page.getByRole('button', { name: 'Create show' }).click();
  await creator.page.getByRole('heading', { name: 'Test Show & Friends' }).waitFor();
  const show = latest(KIND.show, creator.pubkey);
  assert.equal(tag(show, 'title')?.[1], 'Test Show & Friends');
  assert.match(tag(show, 'image')?.[1] ?? '', /\.jpg$/, 'artwork URLs end in .jpg, as podcast apps expect');
  await creator.page.getByText('Publish at least one episode.').waitFor();

  step('publishes an episode, marking a mid-roll break');
  await creator.page.getByRole('button', { name: 'New episode' }).click();
  await creator.page.locator('input[type=file][accept^="audio/mpeg"]').setInputFiles(path.join(root, '../test/fixtures/episode.mp3'));
  await creator.page.getByText('Uploaded').waitFor({ timeout: 15000 });
  await creator.page.locator('.card audio').evaluate((a: HTMLAudioElement) => new Promise<void>((resolve) => {
    a.addEventListener('seeked', () => resolve(), { once: true });
    a.currentTime = 5;
  }));
  await creator.page.getByRole('button', { name: 'Add a break here' }).click();
  await creator.page.getByRole('button', { name: /Remove the break at 0:05/ }).waitFor();
  await creator.page.getByLabel('Title').fill('Test episode one');
  await creator.page.getByLabel('Show notes').fill('The first test episode. #testing');
  await shot(creator.page, 'episode-editor');
  await creator.page.getByRole('button', { name: 'Publish episode' }).click();
  await creator.page.getByRole('heading', { name: 'Test episode one' }).waitFor();
  const episode = latest(54, creator.pubkey);
  const brk = tag(episode, 'break')!;
  assert.equal(Number(brk[1]), 5);
  assert.ok(Number(brk[2]) > 0, 'the break records its MP3 byte offset');
  assert.ok(tag(episode, 'mp3'), 'the episode records its MP3 layout');

  step('lists a media kit for podcast host-reads');
  await go(creator.page, '/create/kit');
  await creator.page.getByLabel('About your content').fill('Test Show: weekly testing talk.');
  await creator.page.getByRole('button', { name: 'Podcast host-reads' }).click();
  await creator.page.getByLabel('Typical listens or views per episode').fill('5000');
  await creator.page.getByLabel('Price per 1,000 ($)').fill('25');
  await creator.page.getByRole('button', { name: 'Publish media kit' }).click();
  await creator.page.waitForTimeout(500);
  assert.equal(tag(latest(KIND.mediaKit, creator.pubkey), 'audience')?.[1], '5000');

  step('an advertiser plans a campaign and sends the creator an offer');
  const brand = await person();
  await go(brand.page, '/promote');
  await brand.page.getByRole('button', { name: 'Plan a campaign' }).click();
  await brand.page.getByLabel('Campaign name').fill('Test campaign');
  await brand.page.getByLabel('Product or service').fill('Test product');
  await brand.page.getByLabel('Offer for listeners (optional)').fill('20% off');
  await brand.page.getByLabel('Landing page').fill('https://shop.example/test');
  await brand.page.getByLabel('Promo code base').fill('TEST');
  await brand.page.getByLabel('Talking points, one per line').fill('Fast\nReliable');
  await brand.page.getByLabel('Budget ($)').fill('1000');
  await brand.page.getByLabel('Starts').fill(new Date().toISOString().slice(0, 10));
  await shot(brand.page, 'campaign-builder');
  await brand.page.getByRole('button', { name: 'Save and find creators' }).click();
  await brand.page.getByRole('heading', { name: 'Find creators' }).waitFor();
  const kit = brand.page.locator('label.card', { hasText: 'weekly testing talk' });
  await kit.getByRole('checkbox').check();
  await brand.page.getByRole('button', { name: /Send 1 offer · \$125\.00/ }).click();
  await brand.page.getByText('Offer sent').waitFor();
  const offer = latest(KIND.offer, brand.pubkey);
  assert.equal(tag(offer, 'format')?.[1], 'host-read');
  assert.equal(tag(offer, 'p')?.[1], creator.pubkey);
  assert.match(tag(offer, 'code')?.[1] ?? '', /^TEST/);
  assert.match(tag(offer, 'r')?.[1] ?? '', /utm_source=fairground/);
  assert.equal(tag(offer, 'approval')?.[1], 'read');
  await shot(brand.page, 'campaign-page');

  step('the creator accepts and records the read');
  await go(creator.page, '/create/sponsors');
  await creator.page.getByRole('button', { name: /Test campaign/ }).click();
  await creator.page.getByText('Talking points:').first().waitFor();
  await creator.page.getByRole('button', { name: 'Accept and record the read' }).click();
  await creator.page.locator('input[type=file][accept="audio/*"]').setInputFiles(path.join(root, '../test/fixtures/spot.mp3'));
  await creator.page.getByRole('button', { name: 'Send for approval' }).click();
  await creator.page.getByText('Sent to the sponsor to approve').waitFor({ timeout: 20000 });
  const placement = latest(KIND.placement, creator.pubkey);
  const spot = tag(placement, 'spot')!;
  assert.equal(spot[2], 'audio/mpeg');
  assert.equal(spot[5], '44100', 'the read was converted to match the episode');
  assert.equal(spot[6], '1');

  step('the advertiser hears it and approves');
  await brand.page.reload();
  await brand.page.getByRole('button', { name: 'Review the read' }).click();
  await brand.page.getByRole('button', { name: 'Approve this read' }).click();
  await brand.page.getByText('Approved').first().waitFor();
  const approval = latest(KIND.approval, brand.pubkey);
  assert.equal(tag(approval, 'status')?.[1], 'approved');

  step('a listener hears the read before the episode, labelled with the sponsor and code');
  const listener = await person({ width: 412, height: 900 });
  await go(listener.page, `/media/${episode.id}`);
  await listener.page.getByRole('heading', { name: 'Test episode one' }).waitFor();
  await listener.page.waitForTimeout(1500);
  await listener.page.locator('.player-wrap audio').first().evaluate((a: HTMLAudioElement) => a.play());
  const banner = listener.page.locator('.ad-banner');
  await banner.waitFor({ timeout: 10000 });
  assert.match(await banner.innerText(), /Sponsored by/);
  assert.match(await banner.innerText(), /Code TEST/);
  await shot(listener.page, 'listener-ad');
  await banner.getByRole('button', { name: 'Skip' }).click();
  await banner.waitFor({ state: 'detached' });

  step('the RSS feed is valid, and downloads have the read stitched in');
  const fileFetch: typeof fetch = async (input, init) => {
    const blob = blobs.get(path.basename(new URL(String(input)).pathname).split('.')[0]);
    if (!blob) return new Response('missing', { status: 404 });
    const range = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('Range') ?? '');
    return range ? new Response(new Uint8Array(blob.body.subarray(Number(range[1]), Number(range[2]) + 1)), { status: 206 }) : new Response(new Uint8Array(blob.body));
  };
  const gw = createGateway({ relays: [relay.url], base: '/fairground', appUrl: 'https://app.test/', fetch: fileFetch, cacheSeconds: 0 });
  const slug = tag(show, 'd')![1];
  const feed = await gw(new Request(`https://gw.test/fairground/podcast/${npubEncode(creator.pubkey)}/${slug}.xml`));
  const xml = await feed.text();
  assert.equal(XMLValidator.validate(xml), true);
  const channel = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(xml).rss.channel;
  assert.equal(channel.title, 'Test Show & Friends');
  assert.equal(channel['itunes:owner']['itunes:email'], 'host@example.com');
  const download = await gw(new Request(channel.item.enclosure['@_url']));
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('X-Fairground-Ads'), '2', 'a pre-roll and the mid-roll');
  const stitched = mp3Layout(new Uint8Array(await download.arrayBuffer()))!;
  const read = mp3Layout(new Uint8Array(blobs.get(path.basename(new URL(spot[1]).pathname).split('.')[0])!.body))!;
  assert.ok(Math.abs(stitched.duration - (10.03 + 2 * read.duration)) < 0.1, `stitched length ${stitched.duration}`);

  step('anyone can donate to Fairground’s development fund');
  await go(listener.page, '/you');
  await listener.page.getByRole('button', { name: 'Support Fairground' }).click();
  await listener.page.getByRole('button', { name: /Donate \$5\.00/ }).click();
  const link = await listener.page.getByRole('link', { name: 'Open my wallet' }).getAttribute('href');
  assert.ok(link?.startsWith(`algorand://${DEVELOPMENT_ADDRESS}?amount=5000000&asset=31566704`), link ?? '');
  assert.ok(link?.includes('xnote=fairground%3Adevelopment'));
  await shot(listener.page, 'donate');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('podcast e2e passed');
} finally {
  await browser.close();
  await relay.close();
  await new Promise<void>((done) => server.httpServer.close(() => done()));
}
