/** Small Node payment service behind the authenticated edge bridge. */
import { createServer } from 'node:http';
import { createGateway } from '../src/gateway.ts';
import { DEFAULT_RELAYS } from '../src/defaults.ts';
import { createPaymentBridge } from './payment-bridge.ts';
import { meldOptions } from './meld-config.ts';

const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`missing setting: ${key}`);
  return value;
};
const appUrl = process.env.FAIRGROUND_APP_URL ?? 'https://www.evolvetech.dev/play/fairground/';
const base = '/fairground';
const enabled = process.env.PAYMENTS_ENABLED === 'true';
// Public wallets use mainnet. Sandbox credentials are used only by the local preview.
const bridge = createPaymentBridge({
  secret: required('PAYMENTS_PROXY_SECRET'), publicOrigin: new URL(appUrl).origin, base,
  handle: createGateway({
    relays: DEFAULT_RELAYS, base, appUrl,
    walletOrigins: [new URL(appUrl).origin, 'capacitor://localhost', 'http://localhost'],
    ramp: enabled ? meldOptions(process.env, 'production') : undefined,
  }),
});

const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 16_384) { res.writeHead(413, { 'Cache-Control': 'no-store' }); res.end(); return; }
      chunks.push(bytes);
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const method = req.method ?? 'GET';
    const request = new Request('http://payments.internal' + (req.url ?? '/'), {
      method, headers, ...(method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
    });
    const response = await bridge(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    // Never log requests, tokens, wallet addresses, or provider response bodies.
    res.writeHead(502, { 'Cache-Control': 'no-store' }); res.end('payment gateway unavailable');
  }
});
server.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? '0.0.0.0', () => console.log('Fairground payment gateway listening'));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.close(() => process.exit(0)));
