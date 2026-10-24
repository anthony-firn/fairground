/**
 * Feeds the reader controls.
 *
 * Ranking runs in the reader's own client, so nobody else learns what they read or like. A feed recipe is plain data:
 * which signals matter and how much, how to treat sponsored posts, how varied the feed is, and what to hide. Readers
 * write their own, or follow and fork recipes others publish; a recipe can't contain code, so running a stranger's is
 * safe. Every ranked post carries the breakdown of its score.
 *
 * Topic matching can use an AI model on the reader's own device through the `Embedder` interface: an Ollama model on
 * their computer, or one running in the browser. The core ships no model and sends nothing anywhere.
 */
import { finalizeEvent, type Event } from 'nostr-tools/pure';
import { KIND } from './kinds.ts';
import { now } from './tags.ts';
import { hasDisclosure } from './sponsorship.ts';

export type Signal = 'recency' | 'trust' | 'engagement' | 'topic' | 'similarity';
const SIGNALS: Signal[] = ['recency', 'trust', 'engagement', 'topic', 'similarity'];

export interface FeedRecipe {
  name: string;
  description: string;
  /**
   * Which posts are candidates: from accounts the reader follows, from their wider web of trust, on these topics, or
   * everything the client fetched from its relays, which a brand-new reader with no follows needs.
   */
  sources: { follows: boolean; trusted: boolean; everyone: boolean; topics: string[] };
  /** Relative weight of each signal, 0–1. */
  weights: Record<Signal, number>;
  /** Hours for the recency signal to halve. */
  halfLifeHours: number;
  sponsored: 'show' | 'downrank' | 'hide';
  /** Posts by one author beyond this many move to the end of the feed. */
  maxPerAuthor: number;
  mutedWords: string[];
  /** The local embedding model the similarity signal expects, e.g. `ollama:nomic-embed-text`. */
  model?: string;
}

const base: Omit<FeedRecipe, 'name' | 'description' | 'weights'> =
  { sources: { follows: true, trusted: false, everyone: false, topics: [] }, halfLifeHours: 24, sponsored: 'show', maxPerAuthor: 3, mutedWords: [] };
const weights = (w: Partial<Record<Signal, number>>): Record<Signal, number> =>
  ({ recency: 0, trust: 0, engagement: 0, topic: 0, similarity: 0, ...w });

/** A small embedding model that runs in the browser with nothing to install (about 23 MB, cached after first use). */
export const BROWSER_MODEL = 'transformers.js:Xenova/all-MiniLM-L6-v2';

/**
 * What every new reader gets: the whole network, ranked by an AI model on their device, with no follows, likes or
 * settings needed. Until the model loads, engagement, newness and any topics they picked carry the feed.
 */
export const DEFAULT_RECIPE: FeedRecipe = {
  ...base,
  name: 'For you',
  description: 'The best of the whole network, learning what you like as you go. It all happens on your device.',
  sources: { follows: true, trusted: true, everyone: true, topics: [] },
  weights: weights({ recency: 0.3, trust: 0.2, engagement: 0.5, topic: 0.4, similarity: 0.8 }),
  model: BROWSER_MODEL,
};

export const PRESET_RECIPES: FeedRecipe[] = [
  DEFAULT_RECIPE,
  { ...base, name: 'Following', description: 'Everyone you follow, newest first.', weights: weights({ recency: 1 }), maxPerAuthor: 1000 },
  {
    ...base, name: 'Trusted and popular', description: 'Your wider circle, favouring what people you trust engage with.',
    sources: { ...base.sources, trusted: true }, weights: weights({ recency: 0.4, trust: 0.3, engagement: 0.6 }),
  },
  {
    ...DEFAULT_RECIPE, name: 'No ads, my own model', description: 'Like For you, ranked by a model you run in Ollama, with sponsored posts hidden.',
    sponsored: 'hide', model: 'ollama:nomic-embed-text',
  },
];

export interface StarterTopic {
  label: string;
  /** Hashtags that match before the AI model has loaded. */
  tags: string[];
}

/** The optional one-tap "What are you into?" choices for a new reader. */
export const STARTER_TOPICS: StarterTopic[] = [
  { label: 'Music', tags: ['music'] },
  { label: 'Gaming', tags: ['gaming', 'games'] },
  { label: 'Cooking', tags: ['cooking', 'food', 'recipes'] },
  { label: 'Sports', tags: ['sports'] },
  { label: 'Tech', tags: ['tech', 'technology'] },
  { label: 'Art', tags: ['art'] },
  { label: 'Comedy', tags: ['comedy', 'funny', 'memes'] },
  { label: 'News', tags: ['news'] },
  { label: 'Science', tags: ['science'] },
  { label: 'Fitness', tags: ['fitness'] },
  { label: 'Travel', tags: ['travel'] },
  { label: 'Film and TV', tags: ['movies', 'tv'] },
  { label: 'Books', tags: ['books'] },
  { label: 'Nature', tags: ['nature', 'photography'] },
  { label: 'Pets', tags: ['pets', 'cats', 'dogs'] },
];

/** The recipe with the picked topics' hashtags added, so they match immediately. */
export const withTopics = (recipe: FeedRecipe, picked: StarterTopic[]): FeedRecipe =>
  ({ ...recipe, sources: { ...recipe.sources, topics: [...new Set([...recipe.sources.topics, ...picked.flatMap((t) => t.tags)])] } });

const RECIPE_LIMITS = { text: 500, list: 100 };

/** Validates untrusted recipe JSON into a recipe, or undefined. Unknown fields are dropped. */
export function parseRecipe(json: unknown): FeedRecipe | undefined {
  const r = json as Partial<FeedRecipe> | null;
  const isText = (s: unknown): s is string => typeof s === 'string' && s.length <= RECIPE_LIMITS.text;
  const isList = (l: unknown): l is string[] => Array.isArray(l) && l.length <= RECIPE_LIMITS.list && l.every(isText);
  const inRange = (n: unknown, lo: number, hi: number): n is number => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
  if (!r || !isText(r.name) || !r.name || !isText(r.description)) return undefined;
  const s = r.sources;
  if (!s || typeof s.follows !== 'boolean' || typeof s.trusted !== 'boolean' || typeof s.everyone !== 'boolean') return undefined;
  if (!isList(s.topics)) return undefined;
  if (!r.weights || !SIGNALS.every((k) => inRange(r.weights![k], 0, 1))) return undefined;
  if (!inRange(r.halfLifeHours, 0.1, 24 * 365) || !inRange(r.maxPerAuthor, 1, 1000) || !Number.isInteger(r.maxPerAuthor)) return undefined;
  if (!['show', 'downrank', 'hide'].includes(r.sponsored as string) || !isList(r.mutedWords)) return undefined;
  if (r.model !== undefined && !isText(r.model)) return undefined;
  return {
    name: r.name,
    description: r.description,
    sources: { follows: s.follows, trusted: s.trusted, everyone: s.everyone, topics: s.topics.map((t) => t.toLowerCase()) },
    weights: Object.fromEntries(SIGNALS.map((k) => [k, r.weights![k]])) as Record<Signal, number>,
    halfLifeHours: r.halfLifeHours,
    sponsored: r.sponsored!,
    maxPerAuthor: r.maxPerAuthor,
    mutedWords: r.mutedWords.map((w) => w.toLowerCase()),
    model: r.model,
  };
}

/** Publishes a recipe so others can use or fork it. Republishing the same slug updates it. */
export function createRecipeEvent(nostrKey: Uint8Array, slug: string, recipe: FeedRecipe, created_at = now()): Event {
  const tags = [['d', slug], ['title', recipe.name], ...recipe.sources.topics.map((t) => ['t', t])];
  return finalizeEvent({ kind: KIND.feedRecipe, created_at, content: JSON.stringify(recipe), tags }, nostrKey);
}

export function recipeFromEvent(ev: Event): FeedRecipe | undefined {
  if (ev.kind !== KIND.feedRecipe) return undefined;
  try {
    return parseRecipe(JSON.parse(ev.content));
  } catch {
    return undefined;
  }
}

/** What the reader's client knows locally. None of it leaves the device. */
export interface ReaderContext {
  now: number;
  follows: Set<string>;
  /** Web-of-trust score per account, 0–1, computed by the client (for example, followed by people you follow). */
  trust: Map<string, number>;
  muted: Set<string>;
  /** Reactions and zaps per post from accounts the reader trusts. */
  engagement: Map<string, number>;
  /** The reader's interest vector, built from posts they liked. */
  interests?: Float32Array;
  /** Embeddings per post id, from the same local model as `interests`. */
  embeddings?: Map<string, Float32Array>;
}

export interface RankedPost {
  event: Event;
  score: number;
  /** Each signal's value (0–1) and weight, so the client can show why the post is here. */
  reasons: { signal: Signal; value: number; weight: number }[];
  sponsored: boolean;
}

const topicsOf = (ev: Event) => ev.tags.filter((t) => t[0] === 't' && t[1]).map((t) => t[1].toLowerCase());

export const isSponsored = (ev: Event): boolean => topicsOf(ev).includes('ad') || hasDisclosure(ev.content);

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function signals(ev: Event, recipe: FeedRecipe, ctx: ReaderContext): Record<Signal, number> {
  const ageHours = Math.max(0, ctx.now - ev.created_at) / 3600;
  const likes = ctx.engagement.get(ev.id) ?? 0;
  const embedding = ctx.embeddings?.get(ev.id);
  return {
    recency: 0.5 ** (ageHours / recipe.halfLifeHours),
    trust: ctx.follows.has(ev.pubkey) ? 1 : ctx.trust.get(ev.pubkey) ?? 0,
    engagement: likes / (likes + 3),
    topic: topicsOf(ev).some((t) => recipe.sources.topics.includes(t)) ? 1 : 0,
    similarity: ctx.interests && embedding ? Math.max(0, cosine(ctx.interests, embedding)) : 0,
  };
}

function isCandidate(ev: Event, recipe: FeedRecipe, ctx: ReaderContext): boolean {
  if (ev.kind !== KIND.note || ctx.muted.has(ev.pubkey)) return false;
  const text = ev.content.toLowerCase();
  if (recipe.mutedWords.some((w) => w && text.includes(w))) return false;
  if (recipe.sponsored === 'hide' && isSponsored(ev)) return false;
  const { follows, trusted, everyone, topics } = recipe.sources;
  return everyone ||
    (follows && ctx.follows.has(ev.pubkey)) ||
    (trusted && (ctx.trust.get(ev.pubkey) ?? 0) > 0) ||
    topicsOf(ev).some((t) => topics.includes(t));
}

export function rankFeed(posts: Event[], recipe: FeedRecipe, ctx: ReaderContext): RankedPost[] {
  const total = SIGNALS.reduce((sum, k) => sum + recipe.weights[k], 0) || 1;
  const unique = [...new Map(posts.map((p) => [p.id, p])).values()];
  const ranked = unique
    .filter((ev) => isCandidate(ev, recipe, ctx))
    .map((event) => {
      const values = signals(event, recipe, ctx);
      const sponsored = isSponsored(event);
      const raw = SIGNALS.reduce((sum, k) => sum + recipe.weights[k] * values[k], 0) / total;
      const reasons = SIGNALS.filter((k) => recipe.weights[k] > 0).map((k) => ({ signal: k, value: values[k], weight: recipe.weights[k] }));
      return { event, score: sponsored && recipe.sponsored === 'downrank' ? raw / 2 : raw, reasons, sponsored };
    })
    .sort((a, b) => b.score - a.score || b.event.created_at - a.event.created_at || (a.event.id < b.event.id ? -1 : 1));

  const perAuthor = new Map<string, number>();
  const kept: RankedPost[] = [];
  const overflow: RankedPost[] = [];
  for (const post of ranked) {
    const n = (perAuthor.get(post.event.pubkey) ?? 0) + 1;
    perAuthor.set(post.event.pubkey, n);
    (n <= recipe.maxPerAuthor ? kept : overflow).push(post);
  }
  return [...kept, ...overflow];
}

/** A text-embedding model on the reader's own device. */
export interface Embedder {
  id: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/**
 * An Ollama model on the reader's computer. The browser must be allowed to reach it: set OLLAMA_ORIGINS to the
 * client's origin.
 */
export function ollamaEmbedder(model: string, baseUrl = 'http://localhost:11434', fetchImpl: typeof fetch = fetch): Embedder {
  return {
    id: `ollama:${model}`,
    async embed(texts) {
      const res = await fetchImpl(`${baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
      const { embeddings } = (await res.json()) as { embeddings?: number[][] };
      if (!embeddings || embeddings.length !== texts.length) throw new Error('Ollama returned the wrong number of embeddings');
      return embeddings.map((e) => Float32Array.from(e));
    },
  };
}

/** Embeds the posts not yet in `cache`, in one batch. */
export async function embedPosts(posts: Event[], embedder: Embedder, cache: Map<string, Float32Array>): Promise<void> {
  const missing = posts.filter((p) => !cache.has(p.id));
  if (!missing.length) return;
  const vectors = await embedder.embed(missing.map((p) => p.content));
  missing.forEach((p, i) => cache.set(p.id, vectors[i]));
}

/** Moves the interest vector toward a post (or away from it, with a negative rate). */
export function updateInterests(interests: Float32Array | undefined, post: Float32Array, rate = 0.1): Float32Array {
  const next = interests
    ? Float32Array.from(interests, (v, i) => v + rate * ((post[i] ?? 0) - v))
    : Float32Array.from(post, (v) => (rate < 0 ? -v : v));
  const norm = Math.hypot(...next) || 1;
  return next.map((v) => v / norm);
}

/** A starting interest vector from the topics a new reader picked, so AI ranking works before their first like. */
export async function interestsFromTopics(picked: StarterTopic[], embedder: Embedder): Promise<Float32Array | undefined> {
  if (!picked.length) return undefined;
  const vectors = await embedder.embed(picked.map((t) => t.label));
  return vectors.reduce<Float32Array | undefined>((acc, v, i) => updateInterests(acc, v, 1 / (i + 1)), undefined);
}

/** Everyday actions the client learns from; none of them is ever sent anywhere. */
export type Reaction = 'like' | 'read' | 'skip' | 'less';
const LEARNING_RATES: Record<Reaction, number> = { like: 0.15, read: 0.05, skip: -0.02, less: -0.25 };

export const learn = (interests: Float32Array | undefined, post: Float32Array, reaction: Reaction): Float32Array =>
  updateInterests(interests, post, LEARNING_RATES[reaction]);
