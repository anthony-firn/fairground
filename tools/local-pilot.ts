/** Loopback-only interface preview with a local relay and real Transak staging sessions. */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { createServer } from 'vite';
import { createGateway } from '../src/gateway.ts';
import { transakFetch } from '../gateway/transak-fetch.ts';
import { startDevRelay } from './dev-relay.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = 5186;
const origin = `http://localhost:${port}`;
const envPath = path.join(homedir(), '.config/evolvetech/transak.env');
const settings = Object.fromEntries(readFileSync(envPath, 'utf8').split('\n')
  .filter((line) => line.trim() && !line.trim().startsWith('#') && line.includes('='))
  .map((line) => { const at = line.indexOf('='); return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
const apiKey = settings.TRANSAK_STAGING_API_KEY;
const apiSecret = settings.TRANSAK_STAGING_API_SECRET;
if (!apiKey || !apiSecret) throw new Error('fill in the staging credentials in ~/.config/evolvetech/transak.env');
// No production key is copied into environment variables, frontend configuration, or responses.
const ipResponse = await fetch('https://api4.ipify.org', { signal: AbortSignal.timeout(10_000) });
if (!ipResponse.ok) throw new Error('could not determine this computer’s public IPv4');
const publicIp = (await ipResponse.text()).trim();
if (isIP(publicIp) !== 4) throw new Error('could not determine this computer’s public IPv4');
const relay = await startDevRelay(7799, { host: '127.0.0.1' });
const gateway = createGateway({
  relays: [relay.url], base: '/fairground', appUrl: origin + '/',
  ramp: { apiKey, apiSecret, environment: 'staging', referrerDomain: 'localhost', fetch: transakFetch },
});
const server = await createServer({
  root: path.join(root, 'app'), configFile: path.join(root, 'app/vite.config.ts'),
  define: {
    'import.meta.env.VITE_LOCAL_PILOT': JSON.stringify('1'),
    'import.meta.env.VITE_LOCAL_RELAY': JSON.stringify(relay.url),
  },
  server: { host: '127.0.0.1', port, strictPort: true },
  plugins: [{
    name: 'fairground-local-payments',
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/fairground/')) return next();
        if (req.headers.host !== `localhost:${port}`) { res.statusCode = 403; res.end('use localhost'); return; }
        try {
          const method = req.method ?? 'GET';
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            const bytes = Buffer.from(chunk);
            size += bytes.length;
            if (size > 16_384) { res.statusCode = 413; res.end('request too large'); return; }
            chunks.push(bytes);
          }
          const headers = new Headers();
          for (const name of ['authorization', 'origin', 'content-type']) {
            const value = req.headers[name];
            if (typeof value === 'string') headers.set(name, value);
          }
          const request = new Request(origin + req.url, { method, headers, ...(method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
          const response = await gateway(request, { ip: publicIp });
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch {
          res.writeHead(502, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'local staging gateway could not complete the request' }));
        }
      });
    },
  }],
});
try { await server.listen(); } catch (error) { await relay.close(); throw error; }
console.log(`Local staging preview: ${origin}/#/wallet`);
console.log(`Transak egress IPv4: ${publicIp} (checked at startup; restart if the IP changes)`);
console.log('Staging credentials only. Demo balance; real wallet transfers disabled. Local relay resets on restart.');
const stop = async () => { await server.close(); await relay.close(); process.exit(0); };
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void stop(); });
