import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import {
  BROWSER_MODEL,
  cosine,
  createRecipeEvent,
  DEFAULT_RECIPE,
  embedPosts,
  interestsFromTopics,
  learn,
  ollamaEmbedder,
  parseRecipe,
  PRESET_RECIPES,
  rankFeed,
  recipeFromEvent,
  STARTER_TOPICS,
  updateInterests,
  withTopics,
  type FeedRecipe,
  type ReaderContext,
} from '../src/feed.ts';

const NOW = 1_790_000_000;
const HOUR = 3600;
const [friendKey, strangerKey, circleKey] = [generateSecretKey(), generateSecretKey(), generateSecretKey()];
const [friend, circle] = [friendKey, circleKey].map(getPublicKey);

const post = (key: Uint8Array, content: string, hoursAgo: number, tags: string[][] = []): Event =>
  finalizeEvent({ kind: 1, created_at: NOW - hoursAgo * HOUR, content, tags }, key);

const ctx = (over: Partial<ReaderContext> = {}): ReaderContext => ({
  now: NOW, follows: new Set([friend]), trust: new Map([[circle, 0.5]]), muted: new Set(), engagement: new Map(), ...over,
});

const [forYou, following, trusted] = PRESET_RECIPES;

const cooking = STARTER_TOPICS.find((t) => t.label === 'Cooking')!;

test('the default is the AI For you feed, using a model that runs in the browser', () => {
  assert.equal(forYou, DEFAULT_RECIPE);
  assert.equal(forYou.model, BROWSER_MODEL);
  assert.equal(forYou.sources.everyone, true);
});

test('a brand-new reader with no follows gets a feed at once, led by the topics they tapped', () => {
  const cold = ctx({ follows: new Set(), trust: new Map() });
  const soup = post(strangerKey, 'tomato soup tonight', 2, [['t', 'food']]);
  const tips = post(circleKey, 'stock tips', 1);
  assert.equal(rankFeed([tips, soup], DEFAULT_RECIPE, cold).length, 2, 'nothing to set up first');
  assert.deepEqual(rankFeed([tips, soup], withTopics(DEFAULT_RECIPE, [cooking]), cold).map((p) => p.event.id), [soup.id, tips.id]);
});

test('picked topics seed the AI before the first like, and everyday reactions refine it', async () => {
  const model = { id: 'test', embed: async (texts: string[]) => texts.map((t) => Float32Array.from(/cook/i.test(t) ? [1, 0] : [0, 1])) };
  const interests = (await interestsFromTopics([cooking], model))!;
  assert.ok(cosine(interests, Float32Array.from([1, 0])) > 0.99);
  assert.equal(await interestsFromTopics([], model), undefined);

  const seen = Float32Array.from([0.6, 0.8]);
  const liked = learn(interests, seen, 'like');
  const less = learn(interests, seen, 'less');
  assert.ok(cosine(liked, seen) > cosine(interests, seen) && cosine(interests, seen) > cosine(less, seen));
  assert.ok(cosine(learn(undefined, seen, 'less'), seen) < -0.99, 'a first "less like this" points away');
});

test('the Following recipe is everyone you follow, newest first', () => {
  const older = post(friendKey, 'older', 5);
  const newer = post(friendKey, 'newer', 1);
  const outsider = post(strangerKey, 'not followed', 0);
  assert.deepEqual(rankFeed([older, outsider, newer], following, ctx()).map((p) => p.event.content), ['newer', 'older']);
});

test('trusted engagement lifts a post, and each post explains its score', () => {
  const quiet = post(friendKey, 'quiet', 1);
  const loved = post(circleKey, 'loved by people you trust', 2);
  const [top] = rankFeed([quiet, loved], trusted, ctx({ engagement: new Map([[loved.id, 30]]) }));
  assert.equal(top.event.id, loved.id);
  assert.deepEqual(top.reasons.map((r) => r.signal), ['recency', 'trust', 'engagement']);
  assert.ok(top.reasons.find((r) => r.signal === 'engagement')!.value > 0.9);
});

test('readers choose whether sponsored posts show, sink or disappear', () => {
  const ad = post(friendKey, 'Great shoes #ad', 0, [['t', 'ad']]);
  const plain = post(friendKey, 'a walk', 1);
  const order = (sponsored: FeedRecipe['sponsored']) =>
    rankFeed([ad, plain], { ...following, sponsored, weights: { ...following.weights, recency: 0.5, trust: 0.5 } }, ctx())
      .map((p) => p.event.content);
  assert.deepEqual(order('show'), ['Great shoes #ad', 'a walk']);
  assert.deepEqual(order('downrank'), ['a walk', 'Great shoes #ad']);
  assert.deepEqual(order('hide'), ['a walk']);
});

test('muted accounts and words are removed, and one author can’t flood the top', () => {
  const recipe = { ...trusted, maxPerAuthor: 1, mutedWords: ['spoiler'] };
  const posts = [post(friendKey, 'one', 1), post(friendKey, 'two', 2), post(circleKey, 'three', 3), post(friendKey, 'spoiler alert', 0)];
  const ranked = rankFeed(posts, recipe, ctx()).map((p) => p.event.content);
  assert.deepEqual(ranked, ['one', 'three', 'two']);
  assert.deepEqual(rankFeed(posts, recipe, ctx({ muted: new Set([friend]) })).map((p) => p.event.content), ['three']);
});

test('topics bring in posts from outside your circle', () => {
  const recipe = { ...following, sources: { ...following.sources, topics: ['woodworking'] } };
  const onTopic = post(strangerKey, 'dovetails', 1, [['t', 'Woodworking']]);
  assert.deepEqual(rankFeed([onTopic], recipe, ctx()).map((p) => p.event.id), [onTopic.id]);
});

test('a local model ranks by similarity to what the reader liked', async () => {
  const fakeModel = { id: 'test', embed: async (texts: string[]) => texts.map((t) => Float32Array.from(t.includes('bread') ? [1, 0] : [0, 1])) };
  const sourdough = post(friendKey, 'my sourdough bread', 3);
  const prices = post(friendKey, 'token prices', 1);
  const embeddings = new Map<string, Float32Array>();
  await embedPosts([sourdough, prices], fakeModel, embeddings);
  const interests = updateInterests(undefined, embeddings.get(sourdough.id)!);
  const ranked = rankFeed([prices, sourdough], forYou, ctx({ embeddings, interests }));
  assert.equal(ranked[0].event.id, sourdough.id);
  assert.ok(cosine(interests, embeddings.get(sourdough.id)!) > 0.99);
});

test('liking moves interests toward a post and disliking moves them away', () => {
  const start = Float32Array.from([1, 0]);
  const toward = updateInterests(start, Float32Array.from([0, 1]), 0.5);
  const away = updateInterests(start, Float32Array.from([0, 1]), -0.5);
  assert.ok(toward[1] > 0 && away[1] < 0);
  assert.ok(Math.abs(Math.hypot(...toward) - 1) < 1e-6);
});

test('recipes round-trip through Nostr, and malformed or hostile ones are rejected', () => {
  const ev = createRecipeEvent(friendKey, 'cozy', forYou, NOW);
  assert.deepEqual(recipeFromEvent(ev), forYou);
  assert.equal(parseRecipe({ ...forYou, weights: { ...forYou.weights, trust: 5 } }), undefined);
  assert.equal(parseRecipe({ ...forYou, sponsored: 'boost' }), undefined);
  assert.equal(parseRecipe({ ...forYou, mutedWords: ['x'.repeat(10_000)] }), undefined);
  assert.equal(parseRecipe(null), undefined);
  assert.ok(!('script' in parseRecipe({ ...forYou, script: 'alert(1)' })!), 'unknown fields are dropped');
});

test('the Ollama embedder calls the local API', async () => {
  let body: unknown;
  const model = ollamaEmbedder('nomic-embed-text', 'http://localhost:11434', async (url, init) => {
    assert.equal(String(url), 'http://localhost:11434/api/embed');
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }));
  });
  assert.equal(model.id, 'ollama:nomic-embed-text');
  assert.deepEqual([...(await model.embed(['hi']))[0]].map((v) => +v.toFixed(2)), [0.1, 0.2]);
  assert.deepEqual(body, { model: 'nomic-embed-text', input: ['hi'] });
});
