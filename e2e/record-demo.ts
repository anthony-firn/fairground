/**
 * Records the phone-size demo video for the project page: onboarding, the feed, "why", a sponsorship offer and fan
 * support, against the demo relay's invented sample data.
 *
 *   npm run app:build && node e2e/record-demo.ts <output-dir>    # writes demo.webm (raw Playwright capture)
 */
import { renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { startDemoRelay } from '../tools/demo-relay.ts';

const out = path.resolve(process.argv[2] ?? '.');
const root = path.dirname(fileURLToPath(import.meta.url));
const relay = await startDemoRelay(7795);
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
  await pause(1200);
  for (const topic of ['Cooking', 'Gaming', 'Art']) {
    await page.getByRole('button', { name: topic, exact: true }).click();
    await pause(450);
  }
  await pause(500);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.locator('article.post').first().waitFor();
  await pause(1800);
  await page.mouse.wheel(0, 380);
  await pause(1000);
  await page.mouse.wheel(0, -380);
  await pause(600);
  await page.locator('article.post').first().getByRole('button', { name: /Why/ }).click();
  await pause(2400);
  await page.getByRole('button', { name: 'Close' }).click();
  await pause(500);
  await page.getByRole('link', { name: 'Create' }).click();
  await pause(1800);
  await page.getByRole('button', { name: /^Find sponsors/ }).first().click();
  await page.getByText('Our autumn trail shoe').waitFor();
  await pause(1000);
  await page.getByText('Our autumn trail shoe').click();
  await pause(2400);
  await page.keyboard.press('Escape');
  await page.goto(`${url}#/p/${relay.creators[0]}`);
  await page.getByRole('button', { name: 'Support' }).waitFor();
  await pause(1200);
  await page.getByRole('button', { name: 'Support' }).click();
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
