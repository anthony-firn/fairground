/**
 * End-to-end test of the built-in wallet: a first deposit (ALGO, bought by card) sets the wallet up and is converted to
 * dollars, later deposits buy dollars directly, a creator is paid into their wallet, a fan pays in one tap, the creator
 * cashes out through a Transak order checked before anything moves, and a donation is paid from the wallet. Algorand,
 * the exchange router, the gateway and Transak are in-process stand-ins; nothing real is touched or funded.
 *
 *   npm run app:build && node e2e/wallet.ts [screenshot-dir]
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import algosdk from 'algosdk';
import { chromium, type BrowserContext, type Page, type Route } from 'playwright';
import { preview } from 'vite';
import { DEFAULT_GATEWAY, DEVELOPMENT_ADDRESS } from '../src/defaults.ts';
import { createGateway } from '../src/gateway.ts';
import { DEFAULT_INDEXER } from '../src/rails/algorand.ts';
import { ROUTER_API } from '../src/swap.ts';
import { DEFAULT_ALGOD } from '../src/walletkey.ts';
import { createFakeChain, createFakeRouter } from '../test/fakechain.ts';
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
const router = createFakeRouter(0.1, ROUTER_API);
chain.fund(DEVELOPMENT_ADDRESS!, 200_000n, 0n);
const transakDeposit = algosdk.generateAccount().addr.toString();
chain.fund(transakDeposit, 200_000n, 0n);
let orderCustomer = '';
const sessions: Record<string, unknown>[] = [];

const transak: typeof fetch = async (input, init) => {
  const u = String(input);
  if (u.endsWith('/refresh-token')) return Response.json({ data: { accessToken: 'tok', expiresAt: Math.floor(Date.now() / 1000) + 86400 } });
  if (u.endsWith('/auth/session')) {
    sessions.push(JSON.parse(String(init?.body)).widgetParams);
    return Response.json({ data: { widgetUrl: 'https://global-stg.transak.com/?sessionId=test' } });
  }
  if (u.includes('/order/')) {
    return Response.json({ data: { status: 'AWAITING_PAYMENT_FROM_USER', isBuyOrSell: 'SELL', cryptoCurrency: 'USDC', network: 'algorand', cryptoAmount: 4, fiatAmount: 3.92, fiatCurrency: 'USD', walletAddress: transakDeposit, partnerCustomerId: orderCustomer } });
  }
  return new Response('no', { status: 404 });
};
const gw = createGateway({
  relays: [relay.url], base: '/fairground', appUrl: url, fetch: (i, init) => (String(i).includes('transak') ? transak(i, init) : chain.fetch(i, init)),
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
  await ctx.route(`${ROUTER_API}/**`, (r) => relayTo(r, (req) => router.fetch(req.url)));
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

  step('a new wallet asks for a first deposit; nobody else funds it');
  const configUrl = `${DEFAULT_GATEWAY}/wallet/config`;
  await fan.ctx.route(configUrl, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'payment service temporarily unavailable' }) }));
  await go(fan.page, '/wallet');
  await fan.page.getByText('Set up your wallet with a first deposit').waitFor({ timeout: 15000 });
  await fan.page.getByRole('button', { name: 'Transfer ALGO from another wallet', exact: true }).click();
  const receive = fan.page.getByRole('dialog', { name: 'Receive', exact: true });
  await receive.getByText('For your first deposit, send ALGO', { exact: false }).waitFor();
  assert.match(await receive.locator('code').innerText(), /^[A-Z2-7]{58}$/);
  await receive.getByRole('button', { name: 'Close', exact: true }).click();
  await fan.page.getByRole('button', { name: 'Add money' }).click();
  await fan.page.getByText('Card payments are temporarily unavailable.', { exact: false }).waitFor();
  assert.equal(await fan.page.getByText('At an exchange such as Kraken', { exact: false }).count(), 0, 'a card outage must not replace checkout with exchange instructions');
  await fan.ctx.unroute(configUrl);
  await fan.page.getByRole('button', { name: 'Try again', exact: true }).click();
  await fan.page.getByText('This first deposit also sets up your wallet').waitFor();
  const popup = fan.page.waitForEvent('popup');
  await fan.page.getByRole('button', { name: 'Continue with Transak' }).click();
  const widget = await popup;
  await widget.waitForURL(/global-stg\.transak\.com\/\?sessionId=test/);
  await widget.close();
  assert.equal(sessions.at(-1)!.cryptoCurrencyCode, 'ALGO', 'the first deposit buys ALGO');
  assert.equal(sessions.at(-1)!.paymentMethod, 'credit_debit_card');
  assert.equal(sessions.at(-1)!.hideExchangeScreen, true);
  const fanWallet = String(sessions.at(-1)!.walletAddress);

  step('when the ALGO arrives, the wallet sets itself up and converts it to dollars');
  chain.fund(fanWallet, 250_000_000n); // Transak delivers $25 of ALGO.
  await fan.page.getByRole('button', { name: 'Close', exact: true }).click();
  await fan.page.getByText('$24.8').first().waitFor({ timeout: 20000 });
  const fanState = chain.accounts.get(fanWallet)!;
  assert.ok(fanState.usdc! > 24_800_000n && fanState.usdc! < 25_000_000n, `converted: ${fanState.usdc}`);
  assert.ok(fanState.algo >= 400_000n && fanState.algo <= 520_000n, `a reserve for fees: ${fanState.algo}`);
  await shot(fan.page, 'wallet');

  step('later deposits buy dollars directly');
  await fan.page.getByRole('button', { name: 'Add money' }).click();
  const popup2 = fan.page.waitForEvent('popup');
  await fan.page.getByRole('button', { name: 'Continue with Transak' }).click();
  const widget2 = await popup2;
  await widget2.waitForURL(/sessionId=test/);
  await widget2.close();
  assert.equal(sessions.at(-1)!.cryptoCurrencyCode, 'USDC');
  await fan.page.keyboard.press('Escape');

  step('a creator sets up their wallet with a small first deposit and is paid into it');
  await go(creator.page, '/create/support');
  await creator.page.getByRole('button', { name: 'Turn on fan support' }).click();
  await creator.page.getByText('Set up your wallet with a first deposit').waitFor();
  await creator.page.getByRole('button', { name: 'Add money' }).click();
  const popup3 = creator.page.waitForEvent('popup');
  await creator.page.getByRole('button', { name: 'Continue with Transak' }).click();
  const widget3 = await popup3;
  await widget3.waitForURL(/sessionId=test/);
  await widget3.close();
  const creatorWallet = String(sessions.at(-1)!.walletAddress);
  chain.fund(creatorWallet, 50_000_000n); // $5 of ALGO.
  await creator.page.reload();
  await go(creator.page, '/wallet');
  await creator.page.getByText('$4.9').first().waitFor({ timeout: 20000 });
  await go(creator.page, '/create/support');
  await creator.page.getByRole('button', { name: 'Turn on fan support' }).click();
  await creator.page.getByRole('button', { name: /Use my Fairground wallet/ }).click();
  await creator.page.getByText('Fan support is on').waitFor({ timeout: 15000 });
  const page = relay.events.filter((e) => e.kind === 13470 && e.pubkey === creator.pubkey).at(-1)!;
  assert.equal(page.tags.find((t) => t[0] === 'payto')![2], creatorWallet);
  const creatorStart = usdcOf(creatorWallet)!;

  step('the fan supports the creator in one tap from their wallet');
  await go(fan.page, `/p/${creator.pubkey}`);
  await fan.page.getByRole('button', { name: 'Support', exact: true }).click();
  await fan.page.getByRole('button', { name: /Support with \$5\.00 this month/ }).click();
  await fan.page.getByRole('button', { name: 'Pay $5.00 from my wallet' }).click();
  await fan.page.getByText('Thank you for supporting them.').waitFor({ timeout: 15000 });
  assert.equal(usdcOf(creatorWallet), creatorStart + 5_000_000n);
  const support = chain.txns.find((t) => t.receiver === creatorWallet && t.sender === fanWallet)!;
  assert.equal(new TextDecoder().decode(support.note), `fairground:support:${creator.pubkey}`);

  step('the creator cashes out through a checked Transak order');
  orderCustomer = creator.pubkey;
  await creator.page.goto(`${url}&ramp=sell&orderId=order-123`);
  await creator.page.getByRole('button', { name: 'Send $4.00' }).click();
  await creator.page.getByText('Transak will pay your bank').waitFor({ timeout: 15000 });
  assert.equal(usdcOf(transakDeposit), 4_000_000n);
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
