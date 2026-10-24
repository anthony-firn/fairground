/**
 * Records the phone-size demo video for the project page from real posts only: it copies one account's published
 * events from public relays into a local relay, then walks through onboarding, the feed, an album post playing, "why"
 * and the profile. Nothing is published.
 *
 *   npm run app:build && node e2e/record-demo.ts <npub or hex pubkey> <output-dir>    # writes demo.webm
 */
import { renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from 'nostr-tools/nip19';
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { chromium } from 'playwright';
import { preview } from 'vite';
import WebSocket from 'ws';
import { DEFAULT_RELAYS } from '../src/defaults.ts';
import { startDevRelay } from '../tools/dev-relay.ts';

useWebSocketImplementation(WebSocket);
const [who = '', outDir = '.'] = process.argv.slice(2);
const author = who.startsWith('npub') ? (decode(who).data as string) : who;
if (!/^[0-9a-f]{64}$/.test(author)) throw new Error('usage: node e2e/record-demo.ts <npub or hex pubkey> <output-dir>');

const pool = new SimplePool();
const events = await pool.querySync(DEFAULT_RELAYS, { authors: [author] }, { maxWait: 6000 });
pool.close(DEFAULT_RELAYS);
const relay = await startDevRelay(7795);
relay.events.push(...events);
console.log(`Mirrored ${events.length} real events from ${who}`);

const out = path.resolve(outDir);
const root = path.dirname(fileURLToPath(import.meta.url));
const server = await preview({ root: path.join(root, '../app'), configFile: path.join(root, '../app/vite.config.ts'), preview: { port: 4185, strictPort: true } });
const url = 'http://localhost:4185/?relay=ws://localhost:7795';
const browser = await chromium.launch({ channel: 'chrome' });
const size = { width: 430, height: 860 };
const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, colorScheme: 'light', recordVideo: { dir: out, size } });
const page = await context.newPage();
const pause = (ms: number) => page.waitForTimeout(ms);

try {
  await page.goto(url);
  await page.getByRole('heading', { name: /Posts from everyone/ }).waitFor();
  await pause(1400);
  for (const topic of ['Music', 'Tech']) {
    await page.getByRole('button', { name: topic, exact: true }).click();
    await pause(500);
  }
  await pause(500);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.locator('img.post-media').first().waitFor();
  await pause(2200);
  await page.mouse.wheel(0, 640);
  await pause(1200);
  const track = page.locator('audio').first();
  await track.evaluate((a: HTMLAudioElement) => { a.muted = true; return a.play(); });
  await pause(3200);
  await page.mouse.wheel(0, 900);
  await pause(1400);
  await page.locator('article.post').first().getByRole('button', { name: /Why/ }).click();
  await pause(2600);
  await page.getByRole('button', { name: 'Close' }).click();
  await pause(400);
  await page.goto(`${url}#/p/${author}`);
  await page.locator('article.post').first().waitFor();
  await pause(2600);
} finally {
  const video = page.video();
  await context.close();
  if (video) renameSync(await video.path(), path.join(out, 'demo.webm'));
  await browser.close();
  await new Promise<void>((done) => server.httpServer.close(() => done()));
  await relay.close();
}
console.log(`Recorded ${path.join(out, 'demo.webm')}`);
