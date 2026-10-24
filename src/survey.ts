/**
 * Audience surveys: how creators show advertisers who their audience is without anyone giving up their privacy.
 *
 * A creator publishes a survey in plain language. A follower who wants to take part asks for one blind token per
 * question; that request is public and signed by the follower's real account, so taking part is visible but the
 * answers are not. Each answer is a separate event from a throwaway key, carrying a token the creator signed without
 * seeing it (RSA blind signatures, RFC 9474), so neither the creator nor anyone else can link an answer to a person or
 * one answer to another. Clients publish each answer at an independent random time, so timing doesn't link them either.
 *
 * Advertisers recount the answers themselves. A creator could sign extra tokens and answer for imaginary fans, but
 * every answer needs a token and every honest token is matched by a public request from a real account, so a survey
 * with more answers than participants is flagged.
 *
 * Blind RSA signatures stay unlinkable even against a quantum computer; only their unforgeability depends on RSA.
 */
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { base64 } from '@scure/base';
import { finalizeEvent, generateSecretKey, verifyEvent, type Event } from 'nostr-tools/pure';
import { KIND, PROTOCOL } from './kinds.ts';
import { signHybrid, verifyHybrid, type KeyLookup, type PqKeys } from './pq.ts';
import { byTime, markedEvent, now, tag, tagValue } from './tags.ts';

const suite = RSABSSA.SHA384.PSS.Randomized();
const RSA = { name: 'RSA-PSS', hash: 'SHA-384' };
/** RFC 9474's randomized variant prefixes each message with 32 random bytes, which makes every token unique. */
const PREFIX = 32;

export interface Question {
  /** Lowercase identifier, e.g. `age`. Standard ids let advertisers compare audiences across creators. */
  id: string;
  prompt: string;
  choices: string[];
}

/** Questions with fixed wording and choices, so results from different creators line up. */
export const STANDARD_QUESTIONS = {
  age: { id: 'age', prompt: 'How old are you?', choices: ['Under 18', '18–24', '25–34', '35–44', '45–54', '55–64', '65+'] },
  region: {
    id: 'region',
    prompt: 'Where do you live?',
    choices: ['Africa', 'Asia', 'Europe', 'Latin America and the Caribbean', 'Northern America', 'Oceania'],
  },
} satisfies Record<string, Question>;

export interface Survey {
  event: Event;
  creator: string;
  title: string;
  /** What the answers are for, in the creator's words. */
  purpose: string;
  questions: (Question & { key: Uint8Array })[];
  closes: number;
}

export interface SurveyInput {
  title: string;
  purpose: string;
  questions: Question[];
  closes: number;
  created_at?: number;
}

/** Returns the survey and the per-question signing keys, which the creator's client keeps until the survey closes. */
export async function createSurvey(nostrKey: Uint8Array, pq: PqKeys, s: SurveyInput) {
  const ids = new Set(s.questions.map((q) => q.id));
  if (!s.questions.length || ids.size !== s.questions.length) throw new Error('questions need unique ids');
  for (const q of s.questions) {
    if (!/^[a-z0-9-]+$/.test(q.id)) throw new Error(`invalid question id: ${q.id}`);
    if (q.choices.length < 2 || new Set(q.choices).size !== q.choices.length) throw new Error(`${q.id} needs distinct choices`);
  }
  const secrets = new Map<string, CryptoKey>();
  const tags = [['title', s.title], ['closes', String(s.closes)]];
  for (const q of s.questions) {
    const { privateKey, publicKey } = await suite.generateKey({ modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) });
    secrets.set(q.id, privateKey);
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', publicKey));
    tags.push(['question', q.id, q.prompt, ...q.choices], ['tokenkey', q.id, base64.encode(spki)]);
  }
  const event = signHybrid({ kind: KIND.survey, created_at: s.created_at ?? now(), content: s.purpose, tags }, nostrKey, pq);
  return { event, secrets };
}

/** Parses a survey and checks the creator's hybrid signature. */
export function parseSurvey(ev: Event, pqKeyOf: KeyLookup): Survey | undefined {
  const key = pqKeyOf(ev.pubkey);
  if (ev.kind !== KIND.survey || !key || !verifyHybrid(ev, key)) return undefined;
  const title = tagValue(ev, 'title');
  const closes = Number(tagValue(ev, 'closes'));
  if (!title || !Number.isSafeInteger(closes)) return undefined;
  const questions: Survey['questions'] = [];
  for (const [, id, prompt, ...choices] of ev.tags.filter((t) => t[0] === 'question')) {
    const spki = ev.tags.find((t) => t[0] === 'tokenkey' && t[1] === id)?.[2];
    if (!id || !prompt || choices.length < 2 || !spki || questions.some((q) => q.id === id)) return undefined;
    questions.push({ id, prompt, choices, key: base64.decode(spki) });
  }
  return questions.length ? { event: ev, creator: ev.pubkey, title, purpose: ev.content, questions, closes } : undefined;
}

const keyCache = new WeakMap<Uint8Array, Promise<CryptoKey>>();
function tokenKey(spki: Uint8Array): Promise<CryptoKey> {
  if (!keyCache.has(spki)) keyCache.set(spki, crypto.subtle.importKey('spki', new Uint8Array(spki), RSA, true, ['verify']));
  return keyCache.get(spki)!;
}

const tokenMessage = (surveyId: string, questionId: string) =>
  new TextEncoder().encode(`${PROTOCOL}:survey:${surveyId}:${questionId}`);

/** Secrets the participant's client keeps until the creator signs. */
export interface PendingToken {
  questionId: string;
  prepared: Uint8Array;
  inv: Uint8Array;
}

/**
 * Asks for one token per question, always for every question, so the request doesn't reveal which ones the
 * participant will answer. Skipping a question just means not publishing that answer.
 */
export async function requestTokens(nostrKey: Uint8Array, survey: Survey, created_at = now()) {
  const pending: PendingToken[] = [];
  const tags = [['e', survey.event.id, '', 'survey'], ['p', survey.creator]];
  for (const q of survey.questions) {
    const prepared = suite.prepare(tokenMessage(survey.event.id, q.id));
    const { blindedMsg, inv } = await suite.blind(await tokenKey(q.key), prepared);
    pending.push({ questionId: q.id, prepared, inv });
    tags.push(['blinded', q.id, base64.encode(blindedMsg)]);
  }
  const request = finalizeEvent({ kind: KIND.tokenRequest, created_at, content: '', tags }, nostrKey);
  return { request, pending };
}

const isRequestFor = (req: Event, survey: Survey): boolean =>
  req.kind === KIND.tokenRequest &&
  markedEvent(req, 'survey') === survey.event.id &&
  req.pubkey !== survey.creator &&
  req.created_at <= survey.closes &&
  verifyEvent(req);

/**
 * Signs a participant's blinded tokens. Returns undefined for a request this survey shouldn't honour, including a
 * second request from someone already issued tokens.
 */
export async function issueTokens(
  nostrKey: Uint8Array,
  survey: Survey,
  secrets: Map<string, CryptoKey>,
  request: Event,
  issuedTo: Set<string>,
  created_at = now(),
): Promise<Event | undefined> {
  if (!isRequestFor(request, survey) || issuedTo.has(request.pubkey)) return undefined;
  const tags = [['e', survey.event.id, '', 'survey'], ['e', request.id, '', 'request'], ['p', request.pubkey]];
  for (const q of survey.questions) {
    const blinded = request.tags.find((t) => t[0] === 'blinded' && t[1] === q.id)?.[2];
    const secret = secrets.get(q.id);
    if (!blinded || !secret) return undefined;
    tags.push(['blindsig', q.id, base64.encode(await suite.blindSign(secret, base64.decode(blinded)))]);
  }
  issuedTo.add(request.pubkey);
  return finalizeEvent({ kind: KIND.tokenIssue, created_at, content: '', tags }, nostrKey);
}

export interface Token {
  questionId: string;
  prepared: Uint8Array;
  signature: Uint8Array;
}

/** Unblinds the creator's signatures; throws if any is invalid. */
export async function finalizeTokens(survey: Survey, request: Event, pending: PendingToken[], issue: Event): Promise<Token[]> {
  if (issue.pubkey !== survey.creator || markedEvent(issue, 'request') !== request.id || !verifyEvent(issue)) {
    throw new Error('not the creator’s answer to this request');
  }
  const q = (id: string) => survey.questions.find((x) => x.id === id)!;
  return Promise.all(pending.map(async (p) => {
    const blindSig = issue.tags.find((t) => t[0] === 'blindsig' && t[1] === p.questionId)?.[2];
    if (!blindSig) throw new Error(`no signature for ${p.questionId}`);
    const signature = await suite.finalize(await tokenKey(q(p.questionId).key), p.prepared, base64.decode(blindSig), p.inv);
    return { questionId: p.questionId, prepared: p.prepared, signature };
  }));
}

/** One answer, signed by a key used once and thrown away. */
export function createAnswer(survey: Survey, token: Token, choice: string, created_at = now()): Event {
  const question = survey.questions.find((q) => q.id === token.questionId);
  if (!question?.choices.includes(choice)) throw new Error(`not a choice for ${token.questionId}: ${choice}`);
  const tags = [
    ['e', survey.event.id, '', 'survey'],
    ['question', token.questionId],
    ['choice', choice],
    ['token', base64.encode(token.prepared), base64.encode(token.signature)],
  ];
  return finalizeEvent({ kind: KIND.answer, created_at, content: '', tags }, generateSecretKey());
}

/** Independent random publish times for each answer, between `from` and the survey's close. */
export function answerTimes(count: number, from: number, closes: number, random: () => number = Math.random): number[] {
  return Array.from({ length: count }, () => from + Math.floor(random() * Math.max(0, closes - from)));
}

export interface QuestionTally {
  id: string;
  prompt: string;
  total: number;
  counts: { choice: string; count: number }[];
}

export interface SurveyTally {
  questions: QuestionTally[];
  /** Distinct accounts that publicly asked to take part and were issued tokens, after the reader's account filter. */
  participants: number;
  /** Some question has more answers than participants, so the creator may have answered for imaginary fans. */
  suspect: boolean;
}

async function validAnswer(ev: Event, survey: Survey): Promise<{ questionId: string; choice: string; token: string } | undefined> {
  if (ev.kind !== KIND.answer || markedEvent(ev, 'survey') !== survey.event.id || ev.created_at > survey.closes) return undefined;
  const question = survey.questions.find((q) => q.id === tagValue(ev, 'question'));
  const choice = tagValue(ev, 'choice');
  const [, prepared, signature] = tag(ev, 'token') ?? [];
  if (!question || !choice || !question.choices.includes(choice) || !prepared || !signature || !verifyEvent(ev)) return undefined;
  try {
    const msg = base64.decode(prepared);
    const expected = tokenMessage(survey.event.id, question.id);
    if (msg.length !== PREFIX + expected.length || !expected.every((b, i) => msg[PREFIX + i] === b)) return undefined;
    if (!(await suite.verify(await tokenKey(question.key), base64.decode(signature), msg))) return undefined;
  } catch {
    return undefined;
  }
  return { questionId: question.id, choice, token: prepared };
}

/**
 * Recounts a survey from public events. `isRealAccount` is the reader's own test for which participants count, for
 * example accounts their web of trust follows.
 */
export async function tallySurvey(
  survey: Survey,
  events: Event[],
  isRealAccount: (pubkey: string) => boolean = () => true,
): Promise<SurveyTally> {
  const requests = new Map(events.filter((e) => isRequestFor(e, survey)).map((e) => [e.id, e]));
  const participants = new Set<string>();
  for (const issue of events) {
    if (issue.kind !== KIND.tokenIssue || issue.pubkey !== survey.creator || markedEvent(issue, 'survey') !== survey.event.id) continue;
    const request = requests.get(markedEvent(issue, 'request') ?? '');
    if (request && tagValue(issue, 'p') === request.pubkey && isRealAccount(request.pubkey) && verifyEvent(issue)) {
      participants.add(request.pubkey);
    }
  }

  const counts = new Map(survey.questions.map((q) => [q.id, new Map(q.choices.map((c) => [c, 0]))]));
  const spent = new Set<string>();
  for (const ev of events.filter((e) => e.kind === KIND.answer).sort(byTime)) {
    const answer = await validAnswer(ev, survey);
    if (!answer || spent.has(answer.token)) continue;
    spent.add(answer.token);
    const byChoice = counts.get(answer.questionId)!;
    byChoice.set(answer.choice, byChoice.get(answer.choice)! + 1);
  }

  const questions = survey.questions.map((q) => {
    const byChoice = counts.get(q.id)!;
    const list = q.choices.map((choice) => ({ choice, count: byChoice.get(choice)! }));
    return { id: q.id, prompt: q.prompt, total: list.reduce((n, c) => n + c.count, 0), counts: list };
  });
  return { questions, participants: participants.size, suspect: questions.some((q) => q.total > participants.size) };
}
