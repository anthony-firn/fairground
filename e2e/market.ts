/**
 * End-to-end test of comments, safety and the marketplace with two people in two browsers, against a local relay.
 *
 *   npm run app:build && node e2e/market.ts
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from '@noble/hashes/utils.js';
import { chromium, type Page } from 'playwright';
import { preview } from 'vite';
import { KIND } from '../src/kinds.ts';
import { encodeAddress } from '../src/rails/algorand.ts';
import { startFixtureRelay } from './fixtures.ts';

const root = path.dirname(fileURLToPath(import.meta.url));
const relay = await startFixtureRelay(7792);
const server = await preview({ root: path.join(root, '../app'), configFile: path.join(root, '../app/vite.config.ts'), preview: { port: 4182, strictPort: true } });
const url = 'http://localhost:4182/?relay=ws://localhost:7792';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors: string[] = [];
const step = (name: string) => console.log(`- ${name}`);

async function person(payTo: boolean): Promise<{ page: Page; pubkey: string }> {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await ctx.addInitScript(([pay]) => {
    localStorage.setItem('fairground.model', JSON.stringify({ kind: 'off' }));
    if (pay) localStorage.setItem('fairground.payTo', JSON.stringify(pay));
  }, [payTo ? encodeAddress(randomBytes(32)) : '']);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByRole('button', { name: /Skip and start/ }).click();
  await page.waitForFunction(() => !!localStorage.getItem('fairground.account'));
  const pubkey = await page.evaluate(() => JSON.parse(localStorage.getItem('fairground.account')!).binding.pubkey as string);
  return { page, pubkey };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  const alice = await person(true);
  const bob = await person(true);

  step('the feed never shows the abuse fixture, and hides adult posts by default');
  await alice.page.locator('article.post').first().waitFor({ timeout: 15000 });
  const feed = await alice.page.locator('article.post').allInnerTexts();
  assert.ok(!feed.some((t) => t.includes('Test abuse fixture')));
  assert.ok(!feed.some((t) => t.includes('Test adult fixture')));

  step('comments: a reply and a vote on a post');
  await alice.page.locator('article.post').first().getByRole('button', { name: 'Comments' }).click();
  await alice.page.getByPlaceholder('Add a comment').fill('First test comment');
  await alice.page.getByRole('button', { name: 'Post', exact: true }).click();
  await alice.page.getByText('First test comment').waitFor();
  await alice.page.getByRole('button', { name: 'Up vote' }).first().click();
  await wait(500);
  const reply = relay.events.find((e) => e.kind === 1 && e.pubkey === alice.pubkey && e.content === 'First test comment');
  assert.ok(reply?.tags.some((t) => t[0] === 'e' && t[3] === 'root'), 'NIP-10 root marker');
  assert.ok(relay.events.some((e) => e.kind === 7 && e.pubkey === alice.pubkey && e.content === '+'));

  step('the market lists the restaurant’s menu item and service, and search narrows it');
  await alice.page.getByRole('link', { name: 'Market' }).click();
  await alice.page.getByText('Test burrito').waitFor();
  await alice.page.getByText('Test grocery runs').waitFor();
  await alice.page.getByPlaceholder(/Search bikes/).fill('burrito');
  assert.equal(await alice.page.getByText('Test grocery runs').count(), 0);

  step('a listing has a Q&A thread (NIP-22) and a seller record');
  await alice.page.getByText('Test burrito').click();
  await alice.page.getByText(/New: no verified orders yet/).waitFor();
  await alice.page.getByPlaceholder('Add a comment').fill('Is it spicy?');
  await alice.page.getByRole('button', { name: 'Post', exact: true }).click();
  await wait(500);
  assert.ok(relay.events.some((e) => e.kind === KIND.comment && e.content === 'Is it spicy?' && e.tags.some((t) => t[0] === 'A')));

  step('buying sends an encrypted order to the seller and asks for payment');
  await alice.page.getByRole('button', { name: /^Buy · \$12\.50/ }).click();
  await alice.page.getByLabel(/Details for the seller/).fill('Pickup at 6pm');
  await alice.page.getByRole('button', { name: /Send order and pay \$12\.50/ }).click();
  await alice.page.getByRole('link', { name: 'Open my wallet' }).waitFor();
  assert.ok(relay.events.some((e) => e.kind === 1059 && e.tags.some((t) => t[0] === 'p' && t[1] === relay.shop)), 'gift-wrapped to the seller');
  assert.ok(!relay.events.some((e) => e.kind === 1059 && e.content.includes('Pickup at 6pm')), 'the relay sees only ciphertext');
  await alice.page.keyboard.press('Escape');

  step('Bob lists a request; Alice offers to help; Bob accepts and is asked to pay');
  await bob.page.goto(`${url}#/market/new?type=request`);
  await bob.page.getByRole('button', { name: 'Ask for help' }).click();
  await bob.page.getByPlaceholder(/Ride to the airport/).fill('Test: help moving a couch');
  await bob.page.getByLabel('Details').fill('Second floor, no lift.');
  await bob.page.getByRole('button', { name: 'Post request' }).click();
  await bob.page.getByRole('button', { name: /Offer to help|Message/ }).first().waitFor({ state: 'detached', timeout: 3000 }).catch(() => undefined);
  await wait(500);
  const request = relay.events.find((e) => e.kind === KIND.listing && e.pubkey === bob.pubkey)!;
  const address = `30402:${bob.pubkey}:${request.tags.find((t) => t[0] === 'd')![1]}`;
  await alice.page.goto(`${url}#/l/${encodeURIComponent(address)}`);
  await alice.page.getByRole('button', { name: 'Offer to help' }).click();
  await alice.page.getByLabel(/Your price/).fill('40');
  await alice.page.getByRole('button', { name: 'Send offer' }).click();
  await alice.page.getByText(/Offer sent/).waitFor();
  await bob.page.goto(`${url}#/messages/${alice.pubkey}`);
  await bob.page.getByRole('button', { name: /Accept and pay \$40\.00/ }).click({ timeout: 15000 });
  await bob.page.getByRole('link', { name: 'Open my wallet' }).waitFor();
  await bob.page.keyboard.press('Escape');

  step('Alice sees Bob’s order in Selling, accepts it, and Bob sees the update');
  await alice.page.goto(`${url}#/orders`);
  await alice.page.getByRole('button', { name: 'Selling' }).click();
  await alice.page.getByText(/Test: help moving a couch/).waitFor({ timeout: 15000 });
  await alice.page.getByText(/Not paid yet|Checking payment/).first().waitFor();
  await alice.page.getByRole('button', { name: 'Accepted' }).click();
  await alice.page.getByText(/Marked accepted/).waitFor();
  await bob.page.goto(`${url}#/orders`);
  await bob.page.getByText('Accepted', { exact: true }).waitFor({ timeout: 15000 });

  assert.deepEqual(errors, [], 'no uncaught page errors');
  console.log('Market test passed');
} finally {
  await browser.close();
  await new Promise<void>((done) => server.httpServer.close(() => done()));
  await relay.close();
}
