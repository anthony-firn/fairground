/** JSON-only server transport: use the reserved IPv4, never an unapproved IPv6. */
import { request } from 'node:https';

const hosts = new Set(['api-stg.transak.com', 'api.transak.com', 'api-gateway-stg.transak.com', 'api-gateway.transak.com']);
export const transakFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.port || url.username || url.password) throw new Error('invalid Transak endpoint');
  if (init?.body !== undefined && typeof init.body !== 'string') throw new Error('Transak requires a JSON body');
  return new Promise<Response>((resolve, reject) => {
    const headers = new Headers(init?.headers);
    headers.set('User-Agent', 'Fairground-Payments/0.1');
    const req = request(url, { method: init?.method ?? 'GET', headers: Object.fromEntries(headers), family: 4, timeout: 20_000 }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1_048_576) { res.destroy(new Error('Transak response too large')); return; }
        chunks.push(chunk);
      });
      res.on('error', () => reject(new Error('Transak connection failed')));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 502, headers: { 'Content-Type': 'application/json' } })));
    });
    req.on('timeout', () => req.destroy(new Error('Transak request timed out')));
    req.on('error', () => reject(new Error('Transak connection failed')));
    if (typeof init?.body === 'string') req.write(init.body);
    req.end();
  });
};
