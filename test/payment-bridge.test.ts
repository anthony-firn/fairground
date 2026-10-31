import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentBridge } from '../gateway/payment-bridge.ts';
import { authHeader, verifyAuthHeader } from '../src/httpauth.ts';
import { generateSecretKey } from 'nostr-tools/pure';

const secret = 'a-test-bridge-secret-at-least-32-characters';
test('only the authenticated edge can forward payment requests and a verified client IP', async () => {
  const body = JSON.stringify({ side: 'BUY' });
  const publicUrl = 'https://www.evolvetech.dev/fairground/ramp/session';
  const key = generateSecretKey();
  let calls = 0;
  const bridge = createPaymentBridge({ secret, publicOrigin: 'https://www.evolvetech.dev', base: '/fairground', handle: async (req, info) => {
    calls++;
    assert.equal(req.url, publicUrl);
    assert.equal(info.ip, '203.0.113.9');
    assert.equal(req.headers.get('x-user-ip'), null);
    assert.equal(req.headers.get('x-fairground-proxy-secret'), null);
    assert.equal(req.headers.get('host'), null);
    assert.ok(!('error' in verifyAuthHeader(req.headers.get('authorization'), req.url, req.method, await req.text())));
    return Response.json({ url: 'https://meldcrypto.com/?token=test' });
  } });
  const request = (extra: Record<string, string> = {}, path = '/fairground/ramp/session') => new Request('https://payments.evolvetech.dev' + path, {
    method: 'POST', body,
    headers: { 'x-fairground-proxy-secret': secret, 'x-fairground-client-ip': '203.0.113.9', Authorization: authHeader(key, publicUrl, 'POST', body), 'x-user-ip': '192.0.2.1', Host: 'attacker.test', ...extra },
  });
  assert.equal((await bridge(request({ 'x-fairground-proxy-secret': 'wrong' }))).status, 403);
  assert.equal((await bridge(request({ 'x-fairground-client-ip': '203.0.113.9, 192.0.2.1' }))).status, 400);
  assert.equal((await bridge(request({}, '/fairground/podcast/anything'))).status, 404);
  assert.equal((await bridge(request({}, '/fairground/ramp/session?upstream=https://attacker.test'))).status, 404);
  assert.equal(calls, 0);
  assert.equal((await bridge(request())).status, 200);
  assert.equal(calls, 1);
});

test('the payment bridge limits requests without denying recovery after the minute expires', async () => {
  let now = 0;
  const bridge = createPaymentBridge({ secret, publicOrigin: 'https://www.evolvetech.dev', base: '/fairground', now: () => now, handle: async () => Response.json({ ramp: false }) });
  const request = () => new Request('https://payments.evolvetech.dev/fairground/wallet/config', { headers: { 'x-fairground-proxy-secret': secret, 'x-fairground-client-ip': '203.0.113.9' } });
  for (let i = 0; i < 60; i++) assert.equal((await bridge(request())).status, 200);
  assert.equal((await bridge(request())).status, 429);
  now = 60_000;
  assert.equal((await bridge(request())).status, 200);
});
