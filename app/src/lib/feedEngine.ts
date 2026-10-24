/**
 * The home feed. Within a couple of seconds it shows posts from the people the reader follows and, for strangers, the
 * starting network (accounts followed by long-standing seeds), ranked by the reader's recipe, then refines itself on
 * the device: engagement from reactions, trust from the people the reader follows, and the AI model once it has
 * loaded. Everything passes the safety rules in safety.ts first. Reordering only happens near the top of the page or
 * when the reader asks, so the feed never jumps.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { finalizeEvent, type Event } from 'nostr-tools/pure';
import {
  DEFAULT_RECIPE,
  embedPosts,
  interestsFromTopics,
  learn,
  rankFeed,
  STARTER_TOPICS,
  withTopics,
  type FeedRecipe,
  type RankedPost,
  type Reaction,
} from '@core/feed.ts';
import type { Account } from './account.ts';
import { rememberProfile } from './hooks.ts';
import { currentEmbedder } from './model.ts';
import { repeats } from '@core/safety.ts';
import { allowed, loadNetwork, safetySettings } from './safety.ts';
import { markSeen, publish, query, subscribe, subscribeAttributed } from './net.ts';
import { load, save } from './storage.ts';

export function currentRecipe(): FeedRecipe {
  const picked = STARTER_TOPICS.filter((t) => load<string[]>('topics', []).includes(t.label));
  return withTopics(load<FeedRecipe>('recipe', DEFAULT_RECIPE), picked);
}

const isTopLevel = (ev: Event) => !ev.tags.some((t) => t[0] === 'e' && (!t[3] || t[3] === 'reply' || t[3] === 'root'));

export type ModelStatus = 'off' | 'loading' | 'ready' | 'error';

export interface Feed {
  posts: RankedPost[];
  ready: boolean;
  newCount: number;
  model: ModelStatus;
  follows: Set<string>;
  refresh(): void;
  react(post: Event, reaction: Reaction): void;
  liked: Set<string>;
}

export function useFeed(account: Account, recipeVersion: number): Feed {
  const posts = useRef(new Map<string, Event>());
  const reactors = useRef(new Map<string, Set<string>>());
  const embeddings = useRef(new Map<string, Float32Array>());
  const trust = useRef(new Map<string, number>());
  const readOnce = useRef(new Set<string>());
  const snapshotAt = useRef(0);
  const [follows, setFollows] = useState(() => new Set(load<string[]>('follows', [])));
  const [ranked, setRanked] = useState<RankedPost[]>([]);
  const [ready, setReady] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const [model, setModel] = useState<ModelStatus>('off');
  const [liked, setLiked] = useState(() => new Set(load<string[]>('liked', [])));
  const [hidden] = useState(() => new Set<string>());
  const [network, setNetwork] = useState<Set<string> | null>(null);

  useEffect(() => {
    loadNetwork().then(setNetwork, () => setNetwork(new Set()));
  }, [recipeVersion]);

  const interests = () => {
    const saved = load<number[] | null>('interests', null);
    return saved ? Float32Array.from(saved) : undefined;
  };

  const rank = useCallback(() => {
    const recipe = currentRecipe();
    const settings = safetySettings();
    const all = [...posts.current.values()];
    const repeated = repeats(all);
    const candidates = all.filter((ev) => {
      if (hidden.has(ev.id) || repeated.has(ev.id) || !isTopLevel(ev) || ev.content.length > 3000) return false;
      const known = ev.pubkey === account.pubkey || follows.has(ev.pubkey);
      if (!allowed(ev, settings, known)) return false;
      if (known || (trust.current.get(ev.pubkey) ?? 0) > 0) return true;
      // Strangers must be in the starting network, which keeps new spam and abuse accounts out of a newcomer's feed.
      return settings.unvetted || !network?.size || network.has(ev.pubkey);
    });
    const engagement = new Map([...reactors.current].map(([id, set]) => [id, set.size]));
    const now = Math.floor(Date.now() / 1000);
    setRanked(rankFeed(candidates, recipe, {
      now, follows, trust: trust.current, muted: new Set(load<string[]>('muted', [])), engagement,
      interests: interests(), embeddings: embeddings.current,
    }).slice(0, 200));
    snapshotAt.current = now;
    setNewCount(0);
  }, [account.pubkey, follows, hidden, network]);

  const nearTop = () => window.scrollY < 120;

  // Sources: the starting network (or, if the reader opts in, everyone), the people they follow, and their topics.
  useEffect(() => {
    if (!network) return;
    let cancelled = false;
    const recipe = currentRecipe();
    const add = (ev: Event) => {
      if (ev.kind !== 1 || posts.current.has(ev.id)) return;
      posts.current.set(ev.id, ev);
      if (snapshotAt.current && ev.created_at > snapshotAt.current) setNewCount((n) => n + 1);
    };
    const closers: (() => void)[] = [];
    if (safetySettings().unvetted || !network.size) closers.push(subscribeAttributed({ kinds: [1], limit: 250 }, add));
    else {
      const members = [...network];
      for (let i = 0; i < members.length; i += 700) closers.push(subscribeAttributed({ kinds: [1], authors: members.slice(i, i + 700), limit: 60 }, add));
    }
    if (follows.size) closers.push(subscribeAttributed({ kinds: [1], authors: [...follows].slice(0, 500), limit: 150 }, add));
    if (recipe.sources.topics.length) closers.push(subscribeAttributed({ kinds: [1], '#t': recipe.sources.topics, limit: 150 }, add));

    (async () => {
      await new Promise((r) => setTimeout(r, 1500));
      const authors = [...new Set([...posts.current.values()].map((e) => e.pubkey))].slice(0, 300);
      (await query({ kinds: [0], authors }, 2500)).forEach(rememberProfile);
      if (cancelled) return;
      rank();
      setReady(true);
      const top = [...posts.current.keys()].slice(-300);
      for (const r of await query({ kinds: [7], '#e': top }, 3000)) {
        const target = r.tags.findLast((t) => t[0] === "e")?.[1];
        if (!target || r.content === '-') continue;
        if (!reactors.current.has(target)) reactors.current.set(target, new Set());
        reactors.current.get(target)!.add(r.pubkey);
      }
      if (!cancelled && nearTop()) rank();
    })();
    return () => {
      cancelled = true;
      closers.forEach((c) => c());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follows, recipeVersion, network]);

  // Who the reader follows, and who those people follow (a simple web of trust).
  useEffect(() => {
    return subscribe({ kinds: [3], authors: [account.pubkey], limit: 1 }, async (ev) => {
      const list = new Set(ev.tags.filter((t) => t[0] === 'p' && /^[0-9a-f]{64}$/.test(t[1])).map((t) => t[1]));
      save('follows', [...list]);
      setFollows(list);
      const counts = new Map<string, number>();
      for (const c of await query({ kinds: [3], authors: [...list].slice(0, 150) }, 3000)) {
        for (const t of c.tags) if (t[0] === 'p' && !list.has(t[1])) counts.set(t[1], (counts.get(t[1]) ?? 0) + 1);
      }
      trust.current = new Map([...counts].map(([pk, n]) => [pk, Math.min(1, n / 3)]));
    });
  }, [account.pubkey]);

  // The on-device model: embed the feed, seed interests from picked topics, then personalize.
  useEffect(() => {
    if (!ready) return;
    const embedder = currentEmbedder();
    if (!embedder) return setModel('off');
    let cancelled = false;
    setModel('loading');
    (async () => {
      try {
        if (!interests()) {
          const picked = STARTER_TOPICS.filter((t) => load<string[]>('topics', []).includes(t.label));
          const seeded = await interestsFromTopics(picked, embedder);
          if (seeded) save('interests', [...seeded]);
        }
        const queue = ranked.map((r) => r.event).slice(0, 120);
        for (let i = 0; i < queue.length && !cancelled; i += 16) await embedPosts(queue.slice(i, i + 16), embedder, embeddings.current);
        if (cancelled) return;
        setModel('ready');
        if (interests() && nearTop()) rank();
      } catch (err) {
        console.warn('On-device model unavailable:', err);
        if (!cancelled) setModel('error');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, recipeVersion]);

  useEffect(() => {
    if (ready) rank();
  }, [ready, recipeVersion, rank]);

  const react = useCallback((post: Event, reaction: Reaction) => {
    if (reaction === 'read') {
      markSeen(post.id);
      if (readOnce.current.has(post.id)) return;
      readOnce.current.add(post.id);
    }
    const vector = embeddings.current.get(post.id);
    if (vector) save('interests', [...learn(interests(), vector, reaction)]);
    if (reaction === 'less') {
      hidden.add(post.id);
      setRanked((list) => list.filter((r) => r.event.id !== post.id));
    }
    if (reaction === 'like' && !liked.has(post.id)) {
      const next = new Set(liked).add(post.id);
      setLiked(next);
      save('liked', [...next].slice(-500));
      publish(finalizeEvent({ kind: 7, created_at: Math.floor(Date.now() / 1000), content: '+', tags: [['e', post.id], ['p', post.pubkey]] }, account.nostrKey))
        .catch(() => undefined);
    }
  }, [account.nostrKey, hidden, liked]);

  return { posts: ranked, ready, newCount, model, follows, refresh: rank, react, liked };
}

export async function setFollowing(account: Account, pubkey: string, follow: boolean): Promise<Set<string>> {
  const [latest] = (await query({ kinds: [3], authors: [account.pubkey], limit: 1 }, 2500)).sort((a, b) => b.created_at - a.created_at);
  const tags = (latest?.tags ?? []).filter((t) => !(t[0] === 'p' && t[1] === pubkey));
  if (follow) tags.push(['p', pubkey]);
  await publish(finalizeEvent({ kind: 3, created_at: Math.floor(Date.now() / 1000), content: latest?.content ?? '', tags }, account.nostrKey));
  const list = new Set(tags.filter((t) => t[0] === 'p').map((t) => t[1]));
  save('follows', [...list]);
  return list;
}
