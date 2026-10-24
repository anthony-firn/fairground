import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { createPqBinding, generatePqKeys, keyLookup, resolvePqKey, signHybrid, verifyHybrid, verifyPq } from '../src/pq.ts';
import { actor, fromRelay } from './helpers.ts';

const note = (content = 'hello') => ({ kind: 1, created_at: 1_790_000_000, tags: [['t', 'demo']], content });

test('a hybrid event verifies under both schemes and is still an ordinary Nostr event', () => {
  const a = actor();
  const ev = fromRelay(signHybrid(note(), a.nostrKey, a.pq));
  assert.ok(verifyEvent(ev));
  assert.ok(verifyHybrid(ev, a.pq.publicKey));
});

test('someone who can forge Schnorr signatures still cannot change a hybrid event', () => {
  const a = actor();
  const ev = signHybrid(note(), a.nostrKey, a.pq);
  const forged = fromRelay(finalizeEvent({ ...fromRelay(ev), content: 'send funds elsewhere' }, a.nostrKey));
  assert.ok(verifyEvent(forged), 'the forged Schnorr signature is valid');
  assert.equal(verifyPq(forged, a.pq.publicKey), false);
});

test('a post-quantum signature cannot be moved onto another event', () => {
  const a = actor();
  const original = signHybrid(note('one'), a.nostrKey, a.pq);
  const other = note('two');
  const moved = fromRelay(finalizeEvent({ ...other, tags: [...other.tags, original.tags.at(-1)!] }, a.nostrKey));
  assert.equal(verifyPq(moved, a.pq.publicKey), false);
});

test('stripping the pq tag or using another key fails post-quantum verification', () => {
  const a = actor();
  const ev = signHybrid(note(), a.nostrKey, a.pq);
  const stripped = fromRelay(finalizeEvent({ ...note(), tags: ev.tags.filter((t) => t[0] !== 'pq') }, a.nostrKey));
  assert.equal(verifyHybrid(stripped, a.pq.publicKey), false);
  assert.equal(verifyHybrid(fromRelay(ev), generatePqKeys().publicKey), false);
});

test('a binding resolves to its key, and a rotation signed by the old key moves to the new one', () => {
  const a = actor();
  assert.deepEqual(resolvePqKey([a.binding], a.pubkey)?.key, a.pq.publicKey);

  const next = generatePqKeys();
  const rotation = createPqBinding(a.nostrKey, next, { binding: a.binding, keys: a.pq }, a.binding.created_at + 60);
  const resolved = resolvePqKey([rotation, a.binding].map(fromRelay), a.pubkey);
  assert.deepEqual(resolved?.key, next.publicKey);
  assert.equal(resolved?.conflict, false);
});

test('a rotation not signed by the previous key is ignored', () => {
  const a = actor();
  const attacker = generatePqKeys();
  const hijack = createPqBinding(a.nostrKey, attacker, { binding: a.binding, keys: attacker }, a.binding.created_at + 60);
  assert.deepEqual(resolvePqKey([a.binding, hijack], a.pubkey)?.key, a.pq.publicKey);
});

test('competing starting keys are flagged and the oldest wins', () => {
  const a = actor();
  const later = createPqBinding(a.nostrKey, generatePqKeys(), undefined, a.binding.created_at + 60);
  const resolved = resolvePqKey([later, a.binding], a.pubkey);
  assert.deepEqual(resolved?.key, a.pq.publicKey);
  assert.equal(resolved?.conflict, true);
});

test('bindings published by someone else do not count', () => {
  const a = actor();
  const b = actor();
  const lookup = keyLookup([a.binding, b.binding]);
  assert.deepEqual(lookup(a.pubkey), a.pq.publicKey);
  assert.equal(resolvePqKey([b.binding], a.pubkey), undefined);
});

test('republishing the same key is not a conflict', () => {
  const a = actor();
  const again = createPqBinding(a.nostrKey, a.pq, undefined, a.binding.created_at + 60);
  assert.equal(resolvePqKey([a.binding, again], a.pubkey)?.conflict, false);
});
