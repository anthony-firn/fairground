import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import { buildThread, controversy, countComments, createComment, createVote, parentOf, tallyVotes, threadFilters, threadKey, wilson } from '../src/comments.ts';
import { KIND } from '../src/kinds.ts';

const people = Array.from({ length: 8 }, () => generateSecretKey());
const [alice, bob, carol] = people;
const T = 1_790_000_000;
const note = (key: Uint8Array, content: string, at = T) => finalizeEvent({ kind: 1, created_at: at, content, tags: [] }, key);

test('Wilson and controversy scores rank like Reddit', () => {
  assert.ok(wilson(10, 1) > wilson(1, 0), 'many votes with a few downs beat a single up vote');
  assert.equal(wilson(0, 0), 0);
  assert.ok(controversy(50, 50) > controversy(90, 10));
  assert.equal(controversy(10, 0), 0);
});

test('replies to notes use NIP-10, nest, and sort by Best', () => {
  const root = note(alice, 'Root post');
  const a = createComment(bob, root, root, 'Top-level A', T + 1);
  const b = createComment(carol, root, root, 'Top-level B', T + 2);
  const aReply = createComment(alice, root, a, 'Reply to A', T + 3);
  assert.equal(a.kind, KIND.note);
  assert.deepEqual(a.tags.find((t) => t[3] === 'root')?.slice(0, 2), ['e', root.id]);
  assert.equal(parentOf(aReply, root), a.id);
  assert.deepEqual(threadFilters(root), [{ kinds: [1], '#e': [root.id] }]);

  const votes = [
    ...people.slice(0, 5).map((k) => createVote(k, b, 1)),
    createVote(people[5], a, 1),
  ];
  const thread = buildThread(root, [a, b, aReply], votes, 'best');
  assert.deepEqual(thread.map((n) => n.event.content), ['Top-level B', 'Top-level A']);
  assert.equal(thread[1].children[0].event.content, 'Reply to A');
  assert.equal(thread[1].children[0].depth, 1);
  assert.equal(countComments(thread), 3);
  assert.deepEqual(buildThread(root, [a, b, aReply], votes, 'new').map((n) => n.event.content), ['Top-level B', 'Top-level A']);
});

test('replies written by other clients join the thread', () => {
  const root = note(alice, 'Root post');
  const legacy = finalizeEvent({ kind: 1, created_at: T + 1, content: 'Old-style reply', tags: [['e', root.id]] }, bob);
  const legacyNested = finalizeEvent({ kind: 1, created_at: T + 2, content: 'Old nested', tags: [['e', root.id], ['e', legacy.id]] }, carol);
  const unrelated = finalizeEvent({ kind: 1, created_at: T + 3, content: 'Elsewhere', tags: [['e', 'f'.repeat(64)]] }, carol);
  assert.equal(parentOf(legacy, root), threadKey(root));
  assert.equal(parentOf(legacyNested, root), legacy.id);
  assert.equal(parentOf(unrelated, root), undefined);
  const thread = buildThread(root, [legacy, legacyNested, unrelated], [], 'new');
  assert.equal(thread.length, 1);
  assert.equal(thread[0].children[0].event.content, 'Old nested');
});

test('comments on a listing use NIP-22 and survive the listing being edited', () => {
  const listing = finalizeEvent({ kind: KIND.listing, created_at: T, content: 'Bike', tags: [['d', 'bike'], ['title', 'Bike']] }, alice);
  const q = createComment(bob, listing, listing, 'Still available?', T + 1);
  const answer = createComment(alice, listing, q, 'Yes!', T + 2);
  assert.equal(q.kind, KIND.comment);
  assert.deepEqual(q.tags.find((t) => t[0] === 'A')?.[1], `30402:${getPublicKey(alice)}:bike`);
  assert.deepEqual(threadFilters(listing), [{ kinds: [KIND.comment], '#A': [threadKey(listing)] }]);
  const edited = finalizeEvent({ ...listing, created_at: T + 10, content: 'Bike, new tyres' } as Event, alice);
  const thread = buildThread(edited, [q, answer], [], 'best');
  assert.equal(thread[0].event.id, q.id);
  assert.equal(thread[0].children[0].event.id, answer.id);
});

test('only each voter’s latest vote counts, and it can be withdrawn', () => {
  const post = note(alice, 'p');
  const me = getPublicKey(bob);
  const votes = [createVote(bob, post, 1, T), createVote(bob, post, -1, T + 1), createVote(carol, post, 1, T)];
  assert.deepEqual(tallyVotes(votes, me).get(post.id), { up: 1, down: 1, mine: -1 });
  const withdrawn = [...votes, createVote(bob, post, 0, T + 2)];
  assert.deepEqual(tallyVotes(withdrawn, me).get(post.id), { up: 1, down: 0, mine: 0 });
  const trustedOnly = tallyVotes(votes, me, (pk) => pk === me);
  assert.deepEqual(trustedOnly.get(post.id), { up: 0, down: 1, mine: -1 });
});
