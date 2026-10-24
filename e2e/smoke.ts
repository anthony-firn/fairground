/**
 * End-to-end smoke test: the built app in Chrome against a local relay with test fixtures. Covers a newcomer's first minute (onboarding,
 * a ranked feed, "why", liking, posting), creator and advertiser flows, and signing in on a second device.
 *
 *   npm run app:build && node e2e/smoke.ts          # uses the system Chrome
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { preview } from 'vite';
import { KIND } from '../src/kinds.ts';
import { startFixtureRelay } from './fixtures.ts';

const root = path.dirname(fileURLToPath(import.meta.url));
const relay = await startFixtureRelay(7791);
const server = await preview({ root: path.join(root, '../app'), configFile: path.join(root, '../app/vite.config.ts'), preview: { port: 4180, strictPort: true } });
const url = 'http://localhost:4180/?relay=ws://localhost:7791';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors: string[] = [];
const watch = (page: Page) => page.on('pageerror', (e) => errors.push(e.message));
const eventsOf = (kind: number, pubkey?: string) => relay.events.filter((e) => e.kind === kind && (!pubkey || e.pubkey === pubkey));
const step = (name: string) => console.log(`- ${name}`);

try {
  const a = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await a.newPage();
  watch(page);
  await page.goto(url);

  step('a newcomer sees onboarding and picks a topic');
  await page.getByRole('heading', { name: /Posts from everyone/ }).waitFor();
  await page.getByRole('button', { name: 'Cooking' }).click();
  await page.getByRole('button', { name: 'Start', exact: true }).click();

  step('the feed appears within seconds, led by the picked topic');
  const first = page.locator('article.post').first();
  await first.waitFor({ timeout: 10_000 });
  assert.match(await first.innerText(), /#(cooking|food)/);
  assert.ok(await page.locator('article.post').count() >= 8);
  const me = await page.evaluate(() => JSON.parse(localStorage.getItem('fairground.account')!).binding.pubkey as string);
  await page.waitForTimeout(500);
  assert.ok(eventsOf(KIND.pqBinding, me).length, 'the account announced its post-quantum key');

  step('"Why" explains the ranking');
  await first.getByRole('button', { name: /Why/ }).click();
  await page.getByText('On topics you picked').waitFor();
  await page.getByRole('button', { name: 'Close' }).click();

  step('liking publishes a reaction');
  await first.getByRole('button', { name: 'Like', exact: true }).click();
  await page.waitForTimeout(500);
  assert.equal(eventsOf(7, me).length, 1);

  step('posting');
  await page.getByRole('link', { name: 'Post', exact: true }).click();
  await page.getByLabel('What’s happening?').fill('Hello from the smoke test #testing');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.getByText('Hello from the smoke test').first().waitFor();
  assert.ok(eventsOf(1, me).some((e) => e.tags.some((t) => t[0] === 't' && t[1] === 'testing')));

  step('a creator finds a sponsor and is asked where payments go');
  await page.getByRole('link', { name: 'Create' }).click();
  await page.getByRole('button', { name: /^Find sponsors/ }).first().click();
  await page.getByText('Test offer').click();
  await page.getByText('Paid to').waitFor();
  await page.getByRole('button', { name: 'Accept and write the post' }).click();
  await page.getByRole('heading', { name: 'Where should payments go?' }).waitFor();
  await page.getByPlaceholder('58 letters and digits').fill('NOTANADDRESS');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText(/has a typo/).waitFor();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  step('anyone can sponsor a creator from their profile');
  const creator = relay.creators[2];
  await page.goto(`${url}#/p/${creator}`);
  await page.getByRole('button', { name: 'Support' }).waitFor();
  await page.getByRole('button', { name: 'Sponsor' }).click();
  await page.getByPlaceholder('What you’re promoting').fill('Try our trail bars');
  await page.locator('textarea').fill('Share an honest review of our trail bars.');
  await page.getByRole('button', { name: 'Send offer' }).click();
  await page.waitForTimeout(800);
  const sent = eventsOf(KIND.offer, me);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tags.find((t) => t[0] === 'p')?.[1], creator);

  step('saving the account with a username and password');
  await page.goto(`${url}#/account`);
  await page.getByLabel('Username').fill('smoke.tester');
  await page.getByLabel('Password', { exact: true }).fill('correct horse battery staple');
  await page.getByLabel('Password again').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Save account' }).click();
  await page.getByText(/Signed in as/).waitFor({ timeout: 30_000 });
  assert.equal(relay.events.filter((e) => e.kind === 30078).length, 1);

  step('signing in on a second device restores the same account');
  const b = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const other = await b.newPage();
  watch(other);
  await other.goto(url);
  await other.getByRole('button', { name: 'I already have an account' }).click();
  await other.getByLabel('Username').fill('smoke.tester');
  await other.getByLabel('Password').fill('correct horse battery staple');
  await other.getByRole('button', { name: 'Sign in' }).click();
  await other.waitForFunction(() => !!localStorage.getItem('fairground.session'), undefined, { timeout: 30_000 });
  await other.waitForLoadState('load');
  const restored = await other.evaluate(() => JSON.parse(localStorage.getItem('fairground.account')!).binding.pubkey as string);
  assert.equal(restored, me);
  const topics = await other.evaluate(() => localStorage.getItem('fairground.topics'));
  assert.equal(topics, '["Cooking"]', 'settings came along');

  step('the on-device model personalizes the feed (downloads the model once)');
  const status = await page.goto(url).then(() => page.locator('.status').first());
  await page.getByText(/Personalized on your device|On-device AI unavailable/).waitFor({ timeout: 120_000 });
  console.log(`  model: ${await status.innerText()}`);

  assert.deepEqual(errors, [], 'no uncaught page errors');
  console.log('Smoke test passed');
} finally {
  await browser.close();
  await new Promise<void>((done) => server.httpServer.close(() => done()));
  await relay.close();
}
