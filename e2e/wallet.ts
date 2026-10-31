/**
 * End-to-end test of the built-in wallet: a first deposit (ALGO, bought by card) sets the wallet up and is converted to
 * dollars, later deposits buy dollars directly, a creator is paid into their wallet, a fan pays in one tap, the creator
 * cashes out through a Meld order checked before anything moves, and a donation is paid from the wallet. Algorand,
 * the exchange router, the gateway and Meld are in-process stand-ins; nothing real is touched or funded.
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
import { sign, submit, suggestedParams, usdcPayment } from '../src/wallet.ts';
import { createRelayPayout } from '../src/commons.ts';
import { RAIL } from '../src/rails/algorand.ts';
import { actor } from '../test/helpers.ts';
import { finalizeEvent } from 'nostr-tools/pure';
import { fakeMeld, MELD_TEST_OPTIONS } from '../test/fakemeld.ts';
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
const meldDeposit = algosdk.generateAccount().addr.toString();
chain.fund(meldDeposit, 200_000n, 0n);
const meld = fakeMeld(meldDeposit);
const sessions = () => [...meld.sessions.values()].map((s) => s.sessionData as Record<string, unknown>);
const gw = createGateway({
  relays: [relay.url], base: '/fairground', appUrl: url,
  fetch: (i, init) => String(i).includes('api.meld.io') ? meld.fetch(i, init) : chain.fetch(i, init),
  ramp: MELD_TEST_OPTIONS,
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
  await ctx.route('https://meldcrypto.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Meld (test)</title><p>Meld test widget</p>' }));
}

async function person(): Promise<{ page: Page; ctx: BrowserContext; pubkey: string }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US', permissions: ['clipboard-read', 'clipboard-write'] });
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
  const crypto = await person();

  step('an existing crypto user can fund their wallet while Meld is disabled');
  await crypto.ctx.route(`${DEFAULT_GATEWAY}/wallet/config`, (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ramp: false }) }));
  await go(crypto.page, '/wallet');
  await crypto.page.getByRole('button', { name: 'Transfer crypto I already own', exact: true }).click();
  const funding = crypto.page.getByRole('dialog', { name: 'Transfer crypto to Fairground', exact: true });
  await funding.getByText('First deposit: ALGO.', { exact: true }).waitFor();
  assert.equal(await funding.getByRole('button', { name: 'USDC', exact: true }).count(), 0, 'USDC is unavailable before opt-in');
  const cryptoAddress = await funding.getByRole('textbox', { name: 'Your Fairground address', exact: true }).inputValue();
  await funding.getByRole('button', { name: 'Copy address', exact: true }).click();
  assert.equal(await crypto.page.evaluate(() => navigator.clipboard.readText()), cryptoAddress);
  await funding.getByRole('button', { name: 'Kraken', exact: true }).click();
  await funding.getByText('Network: Algorand (mainnet)', { exact: true }).waitFor();
  await funding.evaluate((e) => e.scrollTop = 0);
  await shot(crypto.page, 'crypto-transfer-setup');
  await crypto.page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await funding.evaluate((e) => e.scrollWidth <= e.clientWidth), 'funding instructions fit a phone');
  await funding.evaluate((e) => e.scrollTop = 0);
  await shot(crypto.page, 'crypto-transfer-mobile');
  await crypto.page.setViewportSize({ width: 1280, height: 900 });
  chain.fund(cryptoAddress, 2_000_000n);
  await funding.getByText('USDC ready.', { exact: true }).waitFor({ timeout: 20000 });
  await funding.getByText('Asset: USDC', { exact: true }).waitFor();
  await funding.getByRole('button', { name: 'ALGO', exact: true }).click();
  await funding.getByText('Asset: ALGO', { exact: true }).waitFor();
  await funding.getByRole('button', { name: 'USDC', exact: true }).click();
  await funding.getByRole('button', { name: 'Close', exact: true }).click();

  step('a new wallet asks for a first deposit; nobody else funds it');
  const configUrl = `${DEFAULT_GATEWAY}/wallet/config`;
  await fan.ctx.route(configUrl, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'payment service temporarily unavailable' }) }));
  await go(fan.page, '/wallet');
  await fan.page.getByText('Set up your wallet with a first deposit').waitFor({ timeout: 15000 });
  await fan.page.getByRole('button', { name: 'Transfer crypto I already own', exact: true }).click();
  const receive = fan.page.getByRole('dialog', { name: 'Transfer crypto to Fairground', exact: true });
  await receive.getByText('First deposit: ALGO.', { exact: true }).waitFor();
  assert.match(await receive.getByRole('textbox', { name: 'Your Fairground address', exact: true }).inputValue(), /^[A-Z2-7]{58}$/);
  await receive.getByRole('button', { name: 'Close', exact: true }).click();
  await fan.page.getByRole('button', { name: 'Add money' }).click();
  await fan.page.getByText('Card payments are not available yet.', { exact: false }).waitFor();
  await fan.page.getByRole('button', { name: 'Transfer crypto I already own', exact: true }).waitFor();
  await fan.ctx.unroute(configUrl);
  await fan.page.getByRole('button', { name: 'Try again', exact: true }).click();
  await fan.page.getByText('This first deposit also sets up your wallet').waitFor();
  const popup = fan.page.waitForEvent('popup');
  await fan.page.getByRole('textbox', { name: 'US state', exact: true }).fill('CA');
  await fan.page.getByRole('button', { name: 'Continue with Meld' }).click();
  const widget = await popup;
  await widget.waitForURL(/meldcrypto\.com\/\?token=session-/);
  await widget.close();
  assert.equal(sessions().at(-1)!.destinationCurrencyCode, 'ALGO', 'the first deposit buys ALGO');
  assert.equal(sessions().at(-1)!.paymentMethodType, 'CREDIT_DEBIT_CARD');
  const fanWallet = String(sessions().at(-1)!.walletAddress);

  step('when the ALGO arrives, the wallet sets itself up and converts it to dollars');
  chain.fund(fanWallet, 250_000_000n); // Meld delivers $25 of ALGO.
  await fan.page.getByRole('button', { name: 'Close', exact: true }).click();
  await fan.page.getByText('$24.8').first().waitFor({ timeout: 20000 });
  const fanState = chain.accounts.get(fanWallet)!;
  assert.ok(fanState.usdc! > 24_800_000n && fanState.usdc! < 25_000_000n, `converted: ${fanState.usdc}`);
  assert.ok(fanState.algo >= 400_000n && fanState.algo <= 520_000n, `a reserve for fees: ${fanState.algo}`);
  await shot(fan.page, 'wallet');

  step('later deposits buy dollars directly');
  await fan.page.getByRole('button', { name: 'Add money' }).click();
  const popup2 = fan.page.waitForEvent('popup');
  await fan.page.getByRole('textbox', { name: 'US state', exact: true }).fill('CA');
  await fan.page.getByRole('button', { name: 'Continue with Meld' }).click();
  const widget2 = await popup2;
  await widget2.waitForURL(/token=session-/);
  await widget2.close();
  assert.equal(sessions().at(-1)!.destinationCurrencyCode, 'USDC_ALGORAND');
  await fan.page.keyboard.press('Escape');

  step('a creator sets up their wallet with a small first deposit and is paid into it');
  await go(creator.page, '/create/support');
  await creator.page.getByRole('button', { name: 'Turn on fan support' }).click();
  await creator.page.getByText('Set up your wallet with a first deposit').waitFor();
  await creator.page.getByRole('button', { name: 'Add money' }).click();
  const popup3 = creator.page.waitForEvent('popup');
  await creator.page.getByRole('textbox', { name: 'US state', exact: true }).fill('CA');
  await creator.page.getByRole('button', { name: 'Continue with Meld' }).click();
  const widget3 = await popup3;
  await widget3.waitForURL(/token=session-/);
  await widget3.close();
  const creatorWallet = String(sessions().at(-1)!.walletAddress);
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

  step('external USDC payments work without Meld and require the correct transaction');
  const external = algosdk.generateAccount();
  chain.fund(external.addr.toString(), 1_000_000n, 30_000_000n);
  const externalPay = async (to: string, amount: bigint, memo: string) => submit([
    sign(usdcPayment(external.addr.toString(), { to, amount, memo }, await suggestedParams(DEFAULT_ALGOD, chain.fetch)), external.sk.slice(0, 32)),
  ], DEFAULT_ALGOD, chain.fetch);
  await go(crypto.page, `/p/${creator.pubkey}`);
  await crypto.page.getByRole('button', { name: 'Support', exact: true }).click();
  await crypto.page.getByRole('button', { name: /Support with \$5\.00 this month/ }).click();
  await crypto.page.getByRole('button', { name: 'Pay with another Algorand wallet', exact: true }).click();
  const recipient = await crypto.page.getByRole('textbox', { name: 'Recipient address', exact: true }).inputValue();
  const note = await crypto.page.getByRole('textbox', { name: 'Payment note (required)', exact: true }).inputValue();
  assert.equal(recipient, creatorWallet);
  const paymentLink = await crypto.page.getByRole('link', { name: 'Open payment in my wallet', exact: true }).getAttribute('href');
  assert.equal(new URL(paymentLink!).searchParams.get('asset'), '31566704');
  assert.equal(new URL(paymentLink!).searchParams.get('amount'), '5000000');
  assert.equal(new URL(paymentLink!).searchParams.get('xnote'), note);
  await externalPay(recipient, 5_000_000n, note); // A different recent donor must not complete this dialog automatically.
  await crypto.page.waitForTimeout(4500);
  await crypto.page.getByRole('button', { name: 'Confirm my payment', exact: true }).waitFor();
  const wrong = await externalPay(recipient, 5_000_000n, 'wrong-note');
  await crypto.page.getByRole('textbox', { name: 'Transaction ID', exact: true }).fill(wrong);
  await crypto.page.getByRole('button', { name: 'Confirm my payment', exact: true }).click();
  await crypto.page.getByText('The payment note does not match.', { exact: false }).waitFor();
  await shot(crypto.page, 'external-payment');
  const correct = await externalPay(recipient, 5_000_000n, note);
  await crypto.page.getByRole('textbox', { name: 'Transaction ID', exact: true }).fill(correct);
  await crypto.page.getByRole('button', { name: 'Confirm my payment', exact: true }).click();
  await crypto.page.getByText('Thank you for supporting them.', { exact: false }).waitFor({ timeout: 15000 });

  step('the creator cashes out through a checked Meld session, with no provider callback order ID');
  await go(creator.page, '/wallet');
  await creator.page.getByRole('button', { name: 'Cash out', exact: true }).click();
  await creator.page.getByRole('textbox', { name: 'Amount to cash out ($)', exact: true }).fill('4');
  await creator.page.getByRole('textbox', { name: 'US state', exact: true }).fill('CA');
  const sellPopup = creator.page.waitForEvent('popup');
  await creator.page.getByRole('button', { name: 'Continue with Meld' }).click();
  const sellerWidget = await sellPopup;
  await sellerWidget.waitForURL(/token=session-/);
  await sellerWidget.close();
  await creator.page.goto(`${url}&ramp=sell`);
  await creator.page.getByRole('button', { name: 'Send $4.00', exact: true }).waitFor();
  await shot(creator.page, 'meld-cashout');
  // Revalidation at signing time rejects a changed owner even after the confirmation was shown.
  meld.transactionPatch = { externalCustomerId: 'someone-else' };
  await creator.page.getByRole('button', { name: 'Send $4.00', exact: true }).click();
  await creator.page.getByText('that order belongs to someone else', { exact: false }).waitFor();
  assert.equal(usdcOf(meldDeposit), 0n);
  meld.transactionPatch = {};
  await creator.page.getByRole('button', { name: 'Send $4.00', exact: true }).click();
  await creator.page.getByText('The payment provider will process your bank payout.', { exact: false }).waitFor({ timeout: 15000 });
  assert.equal(usdcOf(meldDeposit), 4_000_000n);
  await creator.page.reload();
  assert.equal(await creator.page.getByRole('button', { name: 'Send $4.00', exact: true }).count(), 0, 'the completed session is cleared');

  step('a donation to Fairground is paid from the wallet');
  await go(fan.page, '/you');
  await fan.page.getByRole('button', { name: 'Support Fairground' }).click();
  await fan.page.getByRole('button', { name: /Donate \$5\.00/ }).click();
  await fan.page.getByRole('button', { name: 'Pay $5.00 from my wallet' }).click();
  await fan.page.getByText('Thank you. Your donation went straight to them.').waitFor({ timeout: 15000 });
  assert.equal(usdcOf(DEVELOPMENT_ADDRESS!), 5_000_000n);

  step('split donations advance to the next recipient with fresh payment state');
  const operator = actor();
  const relayAddress = algosdk.generateAccount().addr.toString();
  chain.fund(relayAddress, 200_000n, 0n);
  relay.events.push(operator.binding,
    createRelayPayout(operator.nostrKey, operator.pq, { relays: ['wss://donation-relay.test'], rail: RAIL, payTo: relayAddress, passOn: 20 }),
    finalizeEvent({ kind: 3, created_at: Math.floor(Date.now() / 1000), tags: [['p', fan.pubkey]], content: '' }, operator.nostrKey),
  );
  await fan.ctx.route('https://donation-relay.test/**', (r) => r.fulfill({ contentType: 'application/nostr+json', body: JSON.stringify({ pubkey: operator.pubkey }) }));
  await fan.page.getByRole('button', { name: 'Support Fairground', exact: true }).click();
  await fan.page.getByText('donation-relay.test', { exact: true }).waitFor({ timeout: 15000 });
  await fan.page.getByRole('button', { name: 'Donate $5.00 · 2 payments', exact: true }).click();
  await fan.page.getByRole('button', { name: 'Pay $2.50 from my wallet', exact: true }).click();
  await fan.page.getByRole('dialog', { name: 'Donate to donation-relay.test', exact: true }).waitFor();
  await fan.page.getByRole('button', { name: 'Pay $2.50 from my wallet', exact: true }).click();
  await fan.page.getByText('Thank you. Your donation went straight to them.', { exact: false }).waitFor({ timeout: 15000 });
  await fan.page.getByRole('dialog', { name: 'Donate to donation-relay.test', exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
  assert.equal(usdcOf(relayAddress), 2_500_000n);
  assert.equal(usdcOf(DEVELOPMENT_ADDRESS!), 7_500_000n);

  assert.deepEqual(errors, [], 'no page errors');
  console.log('wallet e2e passed');
} finally {
  await browser.close();
  await relay.close();
  await new Promise<void>((done) => server.httpServer.close(() => done()));
}
