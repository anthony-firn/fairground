import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Event } from 'nostr-tools/pure';
import { keyLookup } from '../src/pq.ts';
import {
  answerTimes,
  createAnswer,
  createSurvey,
  finalizeTokens,
  issueTokens,
  parseSurvey,
  requestTokens,
  STANDARD_QUESTIONS,
  tallySurvey,
  type Survey,
  type Token,
} from '../src/survey.ts';
import { actor, DAY, fromRelay, type Actor } from './helpers.ts';

const T0 = 1_790_000_000;
const creator = actor();
const followers = [actor(), actor(), actor()];
const pqKeyOf = keyLookup([creator.binding]);

const { event, secrets } = await createSurvey(creator.nostrKey, creator.pq, {
  title: 'Who watches this channel?',
  purpose: 'So I can pick sponsors that fit you. Answers are anonymous; only totals are public.',
  questions: [STANDARD_QUESTIONS.age, STANDARD_QUESTIONS.region],
  closes: T0 + 7 * DAY,
  created_at: T0,
});
const survey = parseSurvey(fromRelay(event), pqKeyOf)!;
const issuedTo = new Set<string>();

/** Runs the participant side for one account and returns the public events plus its tokens. */
async function participate(who: Actor, s: Survey = survey) {
  const { request, pending } = await requestTokens(who.nostrKey, s, T0 + DAY);
  const issue = (await issueTokens(creator.nostrKey, s, secrets, fromRelay(request), issuedTo, T0 + DAY + 60))!;
  const tokens = await finalizeTokens(s, request, pending, fromRelay(issue));
  const byQuestion = Object.fromEntries(tokens.map((t) => [t.questionId, t])) as Record<string, Token>;
  return { events: [fromRelay(request), fromRelay(issue)], tokens: byQuestion };
}

const answer = (token: Token, choice: string, at = T0 + 2 * DAY): Event => fromRelay(createAnswer(survey, token, choice, at));

const people = await Promise.all(followers.map((f) => participate(f)));
const setup = people.flatMap((p) => p.events);
const honest = [
  answer(people[0].tokens.age, '25–34'), answer(people[0].tokens.region, 'Europe'),
  answer(people[1].tokens.age, '25–34'), answer(people[1].tokens.region, 'Northern America'),
  answer(people[2].tokens.age, '35–44'),
];

test('the survey parses with its standard questions and the creator’s signature', () => {
  assert.deepEqual(survey.questions.map((q) => q.id), ['age', 'region']);
  assert.equal(parseSurvey(fromRelay(event), () => undefined), undefined, 'unsigned without a post-quantum key');
});

test('anyone can recount the answers, and skipping a question is allowed', async () => {
  const tally = await tallySurvey(survey, [...setup, ...honest]);
  assert.equal(tally.participants, 3);
  assert.equal(tally.suspect, false);
  const age = tally.questions.find((q) => q.id === 'age')!;
  assert.equal(age.total, 3);
  assert.deepEqual(age.counts.filter((c) => c.count), [{ choice: '25–34', count: 2 }, { choice: '35–44', count: 1 }]);
  assert.equal(tally.questions.find((q) => q.id === 'region')!.total, 2);
});

test('answers come from throwaway keys, not the participants’ accounts', () => {
  const authors = new Set(honest.map((a) => a.pubkey));
  assert.equal(authors.size, honest.length, 'every answer has its own key');
  for (const f of [...followers, creator]) assert.ok(!authors.has(f.pubkey));
});

test('a token counts once and only for its own question', async () => {
  const reused = answer(people[0].tokens.age, '65+', T0 + 3 * DAY);
  const swapped = answer({ ...people[2].tokens.age, questionId: 'region' }, 'Oceania');
  const tally = await tallySurvey(survey, [...setup, ...honest, reused, swapped]);
  assert.equal(tally.questions.find((q) => q.id === 'age')!.total, 3);
  assert.equal(tally.questions.find((q) => q.id === 'region')!.total, 2);
});

test('answers after the survey closes are ignored', async () => {
  const late = await participate(actor());
  const tally = await tallySurvey(survey, [...setup, ...late.events, answer(late.tokens.age, '65+', T0 + 8 * DAY)]);
  assert.equal(tally.questions.find((q) => q.id === 'age')!.total, 0);
});

test('each account is issued tokens only once', async () => {
  const again = await requestTokens(followers[0].nostrKey, survey, T0 + DAY);
  assert.equal(await issueTokens(creator.nostrKey, survey, secrets, again.request, issuedTo), undefined);
});

test('answers invented by the creator are flagged', async () => {
  // The creator signs tokens for a sock account and keeps the request and issue events off the relays.
  const sock = await participate(actor());
  const invented = [answer(sock.tokens.age, '18–24'), answer(sock.tokens.region, 'Northern America')];
  const hidden = await tallySurvey(survey, [...setup, ...honest, ...invented]);
  assert.equal(hidden.participants, 3);
  assert.equal(hidden.suspect, true);

  // Published, the sock counts only if the reader's own account filter accepts it.
  const real = new Set(followers.map((f) => f.pubkey));
  const filtered = await tallySurvey(survey, [...setup, ...sock.events, ...honest, ...invented], (pk) => real.has(pk));
  assert.equal(filtered.suspect, true);
});

test('answers are scheduled at independent times before the survey closes', () => {
  const times = answerTimes(50, T0, T0 + DAY);
  assert.ok(times.every((t) => t >= T0 && t < T0 + DAY));
  assert.ok(new Set(times).size > 40);
  assert.throws(() => createAnswer(survey, people[0].tokens.age, 'Not a bracket'));
});
