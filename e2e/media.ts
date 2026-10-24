/**
 * End-to-end test of the media formats (photos, videos, shorts, listening), search, languages and the desktop layout,
 * against a local relay. Test media comes from e2e/media, served on a fake https origin by Playwright routing.
 *
 *   npm run app:build && node e2e/media.ts [screenshot-dir]
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { preview } from 'vite';
import { KIND } from '../src/kinds.ts';
import { MEDIA, startFixtureRelay } from './fixtures.ts';

const root = path.dirname(fileURLToPath(import.meta.url));
const shots = process.argv[2];
const relay = await startFixtureRelay(7793);
const server = await preview({ root: path.join(root, '../app'), configFile: path.join(root, '../app/vite.config.ts'), preview: { port: 4183, strictPort: true } });
const url = 'http://localhost:4183/?relay=ws://localhost:7793';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors: string[] = [];
const step = (name: string) => console.log(`- ${name}`);
const TYPES: Record<string, string> = { jpg: 'image/jpeg', webm: 'video/webm', ogg: 'audio/ogg' };

async function serveMedia(ctx: BrowserContext) {
  await ctx.route(`${MEDIA}/**`, async (route) => {
    const name = path.basename(new URL(route.request().url()).pathname);
    const body = await readFile(path.join(root, 'media', name)).catch(() => undefined);
    await (body ? route.fulfill({ body, contentType: TYPES[name.split('.').pop()!], headers: { 'Access-Control-Allow-Origin': '*' } }) : route.fulfill({ status: 404 }));
  });
}

async function person(viewport: { width: number; height: number }): Promise<{ page: Page; pubkey: string }> {
  const ctx = await browser.newContext({ viewport, locale: 'en-US' });
  await serveMedia(ctx);
  await ctx.addInitScript(() => {
    localStorage.setItem('fairground.model', JSON.stringify({ kind: 'off' }));
    localStorage.setItem('fairground.searchRelays', JSON.stringify(['ws://localhost:7793']));
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByRole('button', { name: /Skip and start/ }).click();
  await page.waitForFunction(() => !!localStorage.getItem('fairground.account'));
  const pubkey = await page.evaluate(() => JSON.parse(localStorage.getItem('fairground.account')!).binding.pubkey as string);
  return { page, pubkey };
}
const shot = async (page: Page, name: string) => shots && page.screenshot({ path: path.join(shots, `${name}.png`) });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  const { page, pubkey } = await person({ width: 1440, height: 900 });
  const sidebar = page.getByRole('complementary', { name: 'Sections' });

  step('desktop: a sidebar and a side column instead of the phone tab bar');
  await page.locator('article.post').first().waitFor({ timeout: 15000 });
  await sidebar.waitFor();
  assert.ok(await page.getByRole('complementary', { name: 'Search and topics' }).isVisible());
  assert.ok(!(await page.locator('.tabbar').isVisible()), 'no tab bar on desktop');
  assert.ok(!(await page.locator('.format-bar').isVisible()), 'formats live in the sidebar on desktop');
  await shot(page, 'desktop-home');

  step('posts in another language stay out of an English reader’s feed');
  const feed = await page.locator('article.post').allInnerTexts();
  assert.ok(!feed.some((t) => t.includes('Publicación de prueba')));
  assert.ok(feed.some((t) => t.includes('Test post with a photo')));

  step('photos: photo posts and posts with photos, in a grid');
  await sidebar.getByRole('link', { name: 'Photos' }).click();
  await page.locator('.photo-card').first().waitFor({ timeout: 10000 });
  const photos = await page.locator('.photo-card').allInnerTexts();
  assert.ok(photos.some((t) => t.includes('Test photo set')));
  assert.ok(photos.some((t) => t.includes('Test post with a photo')));
  assert.ok(!photos.some((t) => t.includes('Test video')), 'videos are not photos');
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.photo-card img')].every((i) => i.complete && i.naturalWidth > 0));
  await shot(page, 'desktop-photos');

  step('videos: a grid of thumbnails with durations');
  await sidebar.getByRole('link', { name: 'Videos' }).click();
  await page.locator('.video-card').first().waitFor({ timeout: 10000 });
  assert.equal(await page.locator('.video-card').count(), 2);
  assert.ok((await page.locator('.video-card').first().innerText()).includes('0:04'));
  await shot(page, 'desktop-videos');

  step('watching: the player, comments, and up next');
  await page.locator('.video-card', { hasText: 'Test video', hasNotText: 'two' }).click();
  await page.getByRole('heading', { name: 'Test video', exact: true }).waitFor();
  await page.waitForFunction(() => (document.querySelector<HTMLVideoElement>('video.player')?.readyState ?? 0) >= 2, undefined, { timeout: 10000 });
  await page.getByRole('heading', { name: 'Up next' }).waitFor();
  await page.locator('.watch-next .video-card', { hasText: 'Test video two' }).waitFor();
  const video = relay.events.find((e) => e.kind === 21 && e.tags.some((t) => t[0] === 'title' && t[1] === 'Test video'))!;
  assert.ok(page.url().endsWith(`/media/${video.id}`));
  await page.getByPlaceholder('Add a comment').fill('Test comment on a video');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.getByText('Test comment on a video').waitFor();
  await wait(500);
  const comment = relay.events.find((e) => e.pubkey === pubkey && e.content === 'Test comment on a video')!;
  assert.equal(comment.kind, KIND.comment, 'comments on videos use NIP-22');
  assert.ok(comment.tags.some((t) => t[0] === 'E' && t[1] === video.id) && comment.tags.some((t) => t[0] === 'K' && t[1] === '21'));
  await shot(page, 'desktop-watch');

  step('shorts: a centred column that plays the short on screen');
  await sidebar.getByRole('link', { name: 'Shorts' }).click();
  await page.locator('.short video').first().waitFor({ timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector<HTMLVideoElement>('.short video')?.paused, undefined, { timeout: 10000 });
  await page.getByRole('button', { name: 'Comments' }).first().click();
  await page.getByRole('dialog', { name: 'Comments' }).waitFor();
  await wait(400);
  await shot(page, 'desktop-shorts');
  await page.getByRole('button', { name: 'Close' }).click();

  step('listen: episodes with a player');
  await sidebar.getByRole('link', { name: 'Listen' }).click();
  await page.getByRole('button', { name: /Test episode 1/ }).click();
  await page.locator('audio').waitFor();
  await page.waitForFunction(() => (document.querySelector('audio')?.readyState ?? 0) >= 1, undefined, { timeout: 10000 });
  await shot(page, 'desktop-listen');

  step('search: free text, hashtags and people');
  await page.goBack();
  await page.getByRole('button', { name: /Test episode 1/ }).waitFor();
  await page.getByRole('complementary', { name: 'Search and topics' }).getByRole('searchbox').fill('photo set');
  await page.keyboard.press('Enter');
  await page.getByText('Test photo set').first().waitFor({ timeout: 10000 });
  await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('#cooking');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByText('Test post 1 about #cooking').waitFor({ timeout: 10000 });
  assert.ok(!(await page.getByText('Test photo set').isVisible()));
  await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('media creator');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'People' }).click();
  await page.getByRole('button', { name: /Test media creator/ }).waitFor({ timeout: 10000 });
  await shot(page, 'desktop-search');

  step('languages: adding Spanish brings Spanish posts in');
  await sidebar.getByRole('link', { name: 'You' }).click();
  await page.getByRole('button', { name: /Your feed and AI/ }).or(page.getByRole('link', { name: /Your feed and AI/ })).first().click();
  await page.getByRole('combobox', { name: 'Add a language' }).selectOption('es');
  await page.getByRole('button', { name: /Spanish/ }).waitFor();
  await shot(page, 'desktop-languages');
  await sidebar.getByRole('link', { name: 'Posts' }).click();
  await page.getByText('Publicación de prueba').waitFor({ timeout: 15000 });

  step('posting a video by link');
  await sidebar.getByRole('link', { name: 'New post' }).click();
  await page.getByRole('button', { name: 'Video', exact: true }).click();
  await page.getByLabel('Title').fill('My test upload');
  await page.getByLabel('Or paste a link').fill(`${MEDIA}/video.webm`);
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.getByRole('heading', { name: 'My test upload' }).waitFor({ timeout: 10000 });
  assert.ok(relay.events.some((e) => e.kind === 21 && e.pubkey === pubkey && e.tags.some((t) => t[0] === 'imeta' && t.includes(`url ${MEDIA}/video.webm`))));

  step('phone: the tab bar and a row of formats, no sidebar');
  const phone = await person({ width: 412, height: 900 });
  await phone.page.locator('article.post').first().waitFor({ timeout: 15000 });
  assert.ok(await phone.page.locator('.tabbar').isVisible());
  assert.ok(!(await phone.page.getByRole('complementary', { name: 'Sections' }).isVisible()));
  await shot(phone.page, 'phone-home');
  await phone.page.getByRole('navigation', { name: 'Formats' }).getByRole('link', { name: 'Shorts' }).click();
  await phone.page.locator('.short video').first().waitFor({ timeout: 10000 });
  await shot(phone.page, 'phone-shorts');
  await phone.page.getByRole('navigation', { name: 'Formats' }).getByRole('link', { name: 'Videos' }).click();
  await phone.page.locator('.video-card').first().waitFor({ timeout: 10000 });
  await shot(phone.page, 'phone-videos');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('media e2e passed');
} finally {
  await browser.close();
  await relay.close();
  await new Promise<void>((done) => server.httpServer.close(() => done()));
}
