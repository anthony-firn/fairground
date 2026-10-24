import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from '@noble/hashes/utils.js';
import { verifyEvent } from 'nostr-tools/pure';
import {
  createVaultEvent,
  deriveCredentials,
  newRecoveryCode,
  normalizeUsername,
  openVault,
  parseVaultEvent,
  passwordProblem,
  recoveryCodeBytes,
  sealVault,
  wrapDataKey,
  type Factor,
} from '../src/vault.ts';
import { fromRelay } from './helpers.ts';

// Cheap settings keep the tests fast; the app uses the real ones.
const FAST = { m: 64, t: 1, p: 1 };
const creds = await deriveCredentials('Ada.Lovelace', 'correct horse battery', FAST);
const contents = { account: { nostrKey: 'secret' }, recipe: 'For you' };

test('usernames are normalized and checked; weak passwords are refused', () => {
  assert.equal(normalizeUsername('  Ada.Lovelace '), 'ada.lovelace');
  assert.throws(() => normalizeUsername('a'));
  assert.throws(() => normalizeUsername('has space'));
  assert.ok(passwordProblem('short'));
  assert.ok(passwordProblem('aaaaaaaaaaaa'));
  assert.ok(passwordProblem('alllowercase'));
  assert.equal(passwordProblem('correct horse battery'), undefined);
});

test('the same username and password always find the same vault; anything else finds another', async () => {
  const again = await deriveCredentials('ada.lovelace', 'correct horse battery', FAST);
  const wrong = await deriveCredentials('ada.lovelace', 'correct horse battery!', FAST);
  const otherUser = await deriveCredentials('grace', 'correct horse battery', FAST);
  assert.equal(again.locator, creds.locator);
  assert.notEqual(wrong.locator, creds.locator);
  assert.notEqual(otherUser.locator, creds.locator);
});

test('a password vault round-trips through a relay event', () => {
  const dataKey = randomBytes(32);
  const file = sealVault(creds, dataKey, contents, wrapDataKey(creds, dataKey, [{ kind: 'password' }]));
  const ev = fromRelay(createVaultEvent(creds, file));
  assert.ok(verifyEvent(ev));
  assert.ok(!ev.content.includes('secret'), 'contents are encrypted');
  const parsed = parseVaultEvent(ev, creds.locator)!;
  assert.deepEqual(openVault(creds, parsed, { kind: 'password' }).contents, contents);
  assert.equal(parseVaultEvent(ev, 'someone-else'), undefined);
});

test('a wrong password cannot open the vault, and tampering is detected', async () => {
  const dataKey = randomBytes(32);
  const file = sealVault(creds, dataKey, contents, wrapDataKey(creds, dataKey, [{ kind: 'password' }]));
  const wrong = await deriveCredentials('ada.lovelace', 'correct horse battery!', FAST);
  assert.throws(() => openVault({ ...wrong, locator: creds.locator }, file, { kind: 'password' }));
  const tampered = { ...file, body: { ...file.body, ct: file.body.ct.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) } };
  assert.throws(() => openVault(creds, tampered, { kind: 'password' }));
});

test('with a passkey on, the password alone opens nothing; the recovery code still works', () => {
  const dataKey = randomBytes(32);
  const passkey: Factor = { kind: 'passkey', secret: randomBytes(32), credentialId: 'cred-1', prfSalt: 'salt' };
  const code = newRecoveryCode();
  const recovery: Factor = { kind: 'recovery', secret: recoveryCodeBytes(code) };
  const file = sealVault(creds, dataKey, contents, wrapDataKey(creds, dataKey, [passkey, recovery]));

  assert.throws(() => openVault(creds, file, { kind: 'password' }), /can't be opened with a password/);
  assert.deepEqual(openVault(creds, file, passkey).contents, contents);
  assert.deepEqual(openVault(creds, file, { kind: 'recovery', secret: recoveryCodeBytes(code.toLowerCase()) }).contents, contents);
  assert.throws(() => openVault(creds, file, { ...passkey, secret: randomBytes(32) }));
  assert.throws(() => openVault(creds, file, { ...passkey, credentialId: 'cred-2' }));
});

test('re-sealing new contents keeps every way in', () => {
  const dataKey = randomBytes(32);
  const wraps = wrapDataKey(creds, dataKey, [{ kind: 'password' }]);
  const updated = sealVault(creds, dataKey, { ...contents, recipe: 'Following' }, wraps);
  assert.equal(openVault<typeof contents>(creds, updated, { kind: 'password' }).contents.recipe, 'Following');
});

test('recovery codes are eight groups of four', () => {
  const code = newRecoveryCode();
  assert.match(code, /^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
  assert.throws(() => recoveryCodeBytes('ABCD'));
});
