/**
 * End-to-end test of the built-in wallet: turning it on (the sponsor pays), adding money through Transak, a creator
 * paid into their wallet, a fan paying in one tap, cashing out through a Transak order checked before anything moves,
 * and donating from the wallet. Algorand, the gateway and Transak are in-process stand-ins; nothing real is touched.
 *
 *   npm run app:build && node e2e/wallet.ts [screenshot-dir]
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import algosdk from 'algosdk';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { encodeAddressKey } from '../src/algotx.ts';
import { chromium, type BrowserContext, type Page, type Route } from 'playwright';
import { preview } from 'vite';
import { DEFAULT_GATEWAY, DEVELOPMENT_ADDRESS } from '../src/defaults.ts';
import { createGateway } from '../src/gateway.ts';
import { DEFAULT_INDEXER } from '../src/rails/algorand.ts';
import { DEFAULT_ALGOD } from '../src/walletkey.ts';
import { createFakeChain } from '../test/fakechain.ts';
import { startFixtureRelay } from './fixtures.ts';

const root = path.dirname(fileURLToPath(import.meta.url));
const shots = process.argv[2];
const relay = await startFixtureRelay(7797);
const server = await preview({ root: path.join(root, '../app'), configFile: path.join(root, '../app/vite.config.ts'), preview: { port: 4187, strictPort: true } });
const url = 'http://localhost:4187/?relay=ws://localhost:7797';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors: string[] = [];
const step = (name: string) => console.log(`- ${name}`);

const chain = createFakeChain({ algod: DEFAULT_ALGOD, indexer: DEFAULT_INDEXER });
const sponsorSeed = randomBytes(32);
const sponsor = { addr: encodeAddressKey(ed25519.getPublicKey(sponsorSeed)) };
chain.fund(sponsor.addr, 10_000_000n);
chain.fund(DEVELOPMENT_ADDRESS!, 200_000n, 0n);
const transakDeposit = algosdk.generateAccount().addr.toString();
chain.fund(transakDeposit, 200_000n, 0n);
let orderCustomer = '';

const transak: typeof fetch = async (input) => {
  const u = String(input);
  if (u.endsWith('/refresh-token')) return Response.json({ data: { accessToken: 'tok', expiresAt: Math.floor(Date.now() / 1000) + 86400 } });
  if (u.endsWith('/auth/session')) return Response.json({ data: { widgetUrl: 'https://global-stg.transak.com/?sessionId=test' } });
  if (u.includes('/order/')) {
    return Response.json({ data: { status: 'AWAITING_PAYMENT_FROM_USER', isBuyOrSell: 'SELL', cryptoCurrency: 'USDC', network: 'algorand', cryptoAmount: 4, fiatAmount: 3.92, fiatCurrency: 'USD', walletAddress: transakDeposit, partnerCustomerId: orderCustomer } });
  }
  return new Response('no', { status: 404 });
};
const gw = createGateway({
  relays: [relay.url], base: '/fairground', appUrl: url, fetch: (i, init) => (String(i).includes('transak') ? transak(i, init) : chain.fetch(i, init)),
  starter: { key: bytesToHex(sponsorSeed), algod: DEFAULT_ALGOD, indexer: DEFAULT_INDEXER },
  ramp: { apiKey: 'key', apiSecret: 'secret', environment: 'staging', referrerDomain: 'localhost' },
});

/** Hands a browser request to an in-process handler and returns its answer. */
async function relayTo(route: Route, handler: (req: Request) => Promise<Response>) {
  const r = route.request();
  const body = r.postDataBuffer();
  const res = await handler(new Request(r.url(), { method: r.method(), headers: r.headers(), ...(body && r.method() !== 'GET' ? { body: new Uint8Array(body) } : {}) }));
  await route.fulfill({ status: res.status, headers: { ...Object.fromEntries(res.headers), 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }, body: Buffer.from(await res.arrayBuffer()) });
}

async function standIns(ctx: BrowserContext) {
  await ctx.route(`${DEFAULT_ALGOD}/**`, (r) => (r.request().method() === 'OPTIONS'
    ? r.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } })
    : relayTo(r, async (req) => chain.fetch(req.url, { method: req.method, body: req.method === 'POST' ? new Uint8Array(await req.arrayBuffer()) : undefined }))));
  await ctx.route(`${DEFAULT_INDEXER}/**`, (r) => relayTo(r, (req) => chain.fetch(req.url)));
  await ctx.route(`${DEFAULT_GATEWAY}/**`, (r) => relayTo(r, (req) => gw(req, { ip: '9.9.9.9' })));
  await ctx.route('https://global-stg.transak.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Transak (test)</title><p>Transak test widget</p>' }));
}

async function person(): Promise<{ page: Page; ctx: BrowserContext; pubkey: string }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  await standIns(ctx);
  await ctx.addInitScript(() => localStorage.setItem('fairground.model', JSON.stringify({ kind: 'off' })));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByRole('button', { name: /Skip and start/ }).click();
  await page.waitForFunction(() => !!localStorage.getItem('fairground.account'));
  const pubkey = await page.evaluate(() => JSON.parse(localStorage.getItem('fairground.account')!).binding.pubkey as string);
  await page.waitForTimeout(800);
  return { page, ctx, pubkey };
}
const go = (page: Page, hash: string) => page.evaluate((h) => (location.hash = h), hash);
const shot = async (page: Page, name: string) => shots && page.screenshot({ path: path.join(shots, `${name}.png`) });
const usdcOf = (addr: string) => chain.accounts.get(addr)?.usdc ?? null;

try {
  const fan = await person();
  const creator = await person();

  step('a fan turns on their wallet; the sponsor covers the setup');
  await go(fan.page, '/wallet');
  await fan.page.getByRole('button', { name: 'Turn on my wallet' }).click();
  await fan.page.getByRole('button', { name: 'Add money' }).waitFor({ timeout: 15000 });
  const fanAddress = [...chain.accounts.keys()].find((a) => a !== sponsor.addr && a !== DEVELOPMENT_ADDRESS && a !== transakDeposit && chain.accounts.get(a)!.usdc !== null)!;
  assert.equal(chain.accounts.get(fanAddress)!.algo, 250_000n);
  assert.equal(usdcOf(fanAddress), 0n);

  step('adding money opens a Transak session made by the gateway');
  await fan.page.getByRole('button', { name: 'Add money' }).click();
  const popup = fan.page.waitForEvent('popup');
  await fan.page.getByRole('button', { name: 'Continue with Transak' }).click();
  const widget = await popup;
  await widget.waitForURL(/global-stg\.transak\.com\/\?sessionId=test/);
  await widget.close();
  await fan.page.getByText('Finish in the Transak window').waitFor();
  chain.fund(fanAddress, 0n, 50_000_000n); // Transak delivers the USDC.
  await fan.page.reload();
  await fan.page.getByText('$50.00').first().waitFor({ timeout: 10000 });
  await shot(fan.page, 'wallet');

  step('a creator turns on fan support, paid into their own wallet');
  await go(creator.page, '/create/support');
  await creator.page.getByRole('button', { name: 'Turn on fan support' }).click();
  await creator.page.getByRole('button', { name: 'Turn on my wallet' }).click();
  await creator.page.getByText('Fan support is on').waitFor({ timeout: 15000 });
  const page = relay.events.filter((e) => e.kind === 13470 && e.pubkey === creator.pubkey).at(-1)!;
  const creatorAddress = page.tags.find((t) => t[0] === 'payto')![2];
  assert.equal(usdcOf(creatorAddress), 0n, 'the creator’s wallet is on and can receive');

  step('the fan supports the creator in one tap from their wallet');
  await go(fan.page, `/p/${creator.pubkey}`);
  await fan.page.getByRole('button', { name: 'Support', exact: true }).click();
  await fan.page.getByRole('button', { name: /Support with \$5\.00 this month/ }).click();
  await shot(fan.page, 'pay');
  await fan.page.getByRole('button', { name: 'Pay $5.00 from my wallet' }).click();
  await fan.page.getByRole('dialog').waitFor({ state: 'detached', timeout: 15000 });
  assert.equal(usdcOf(creatorAddress), 5_000_000n);
  assert.equal(usdcOf(fanAddress), 45_000_000n);
  const support = chain.txns.find((t) => t.receiver === creatorAddress && t.sender === fanAddress)!;
  assert.equal(new TextDecoder().decode(support.note), `fairground:support:${creator.pubkey}`);

  step('the creator sees it in their wallet and cashes out through a checked Transak order');
  orderCustomer = creator.pubkey;
  await go(creator.page, '/wallet');
  await creator.page.getByText('Fan support').waitFor({ timeout: 10000 });
  await creator.page.getByText('+$5.00').waitFor();
  await creator.page.goto(`${url}&ramp=sell&orderId=order-123`);
  await creator.page.getByRole('button', { name: 'Send $4.00' }).click();
  await creator.page.getByText('Transak will pay your bank').waitFor({ timeout: 15000 });
  assert.equal(usdcOf(transakDeposit), 4_000_000n);
  assert.equal(usdcOf(creatorAddress), 1_000_000n);
  orderCustomer = 'someone-else';
  await creator.page.goto(`${url}&ramp=sell&orderId=order-456`);
  await creator.page.getByText(/can’t be paid: that order belongs to someone else/).waitFor({ timeout: 10000 });

  step('a donation to Fairground is paid from the wallet');
  await go(fan.page, '/you');
  await fan.page.getByRole('button', { name: 'Support Fairground' }).click();
  await fan.page.getByRole('button', { name: /Donate \$5\.00/ }).click();
  await fan.page.getByRole('button', { name: 'Pay $5.00 from my wallet' }).click();
  await fan.page.getByText('Thank you. Your donation went straight to them.').waitFor({ timeout: 15000 });
  assert.equal(usdcOf(DEVELOPMENT_ADDRESS!), 5_000_000n);

  assert.deepEqual(errors, [], 'no page errors');
  console.log('wallet e2e passed');
} finally {
  await browser.close();
  await relay.close();
  await new Promise<void>((done) => server.httpServer.close(() => done()));
}
