/** Private bridge from the public edge gateway to the fixed-IP payment service. */
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { RequestInfo } from '../src/gateway.ts';

export interface PaymentBridgeOptions {
  secret: string;
  publicOrigin: string;
  base: string;
  handle: (request: Request, info: RequestInfo) => Promise<Response>;
  now?: () => number;
}

export function createPaymentBridge(opts: PaymentBridgeOptions) {
  if (opts.secret.length < 32) throw new Error('the payment bridge needs a secret of at least 32 characters');
  const origin = new URL(opts.publicOrigin).origin;
  const base = opts.base.replace(/\/+$/, '');
  const expected = Buffer.from(opts.secret);
  const rates = new Map<string, { start: number; count: number }>();
  const now = opts.now ?? Date.now;
  const error = (status: number) => Response.json({ error: 'payment gateway unavailable' }, { status, headers: { 'Cache-Control': 'no-store' } });

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === '/health' && req.method === 'GET') return Response.json({ service: 'fairground-payments', ok: true }, { headers: { 'Cache-Control': 'no-store' } });
    const supplied = Buffer.from(req.headers.get('x-fairground-proxy-secret') ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return error(403);
    const path = url.pathname.slice(base.length);
    if (!url.pathname.startsWith(base + '/') || url.search || !(
      (path === '/wallet/config' && ['GET', 'OPTIONS'].includes(req.method)) ||
      (path === '/ramp/session' && ['POST', 'OPTIONS'].includes(req.method)) ||
      (/^\/ramp\/order\/[A-Za-z0-9-]{6,80}$/.test(path) && ['GET', 'OPTIONS'].includes(req.method))
    )) return error(404);
    const ip = req.headers.get('x-fairground-client-ip') ?? '';
    if (!isIP(ip) || ip === '0.0.0.0' || ip === '::') return error(400);
    const time = now();
    for (const [key, value] of rates) if (time - value.start >= 60_000) rates.delete(key);
    if (!rates.has(ip) && rates.size >= 10_000) return error(503);
    const rate = rates.get(ip) ?? { start: time, count: 0 };
    rates.set(ip, rate);
    if (++rate.count > 60) return error(429);
    const headers = new Headers();
    for (const name of ['authorization', 'origin', 'content-type']) {
      const value = req.headers.get(name);
      if (value) headers.set(name, value);
    }
    // Reconstruct the original public URL so NIP-98 signatures still verify.
    // Never accept an original URL, Host, or forwarding chain supplied by a client.
    const body = req.method === 'POST' ? await req.arrayBuffer() : undefined;
    if (body && body.byteLength > 16_384) return error(413);
    return opts.handle(new Request(origin + url.pathname, { method: req.method, headers, body }), { ip });
  };
}
