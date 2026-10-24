/**
 * Reddit-style comment threads for any post or listing: nested replies, up and down votes, and Best, Top, New and
 * Controversial sorting.
 *
 * Replies to ordinary notes are kind-1 notes with NIP-10 `root` and `reply` markers, as every Nostr client writes
 * them, so replies from other apps join the thread. Comments on anything else (listings, stores) are NIP-22 kind-1111
 * comments. Votes are NIP-25 reactions: `-` is a down vote and anything else an up vote, and only each voter's latest
 * reaction counts.
 */
import { finalizeEvent, type Event } from 'nostr-tools/pure';
import { KIND } from './kinds.ts';
import { now } from './tags.ts';

const isAddressable = (kind: number) => kind >= 30000 && kind < 40000;
const dTag = (ev: Event) => ev.tags.find((t) => t[0] === 'd')?.[1] ?? '';
export const addressOf = (ev: Event): string => `${ev.kind}:${ev.pubkey}:${dTag(ev)}`;

/** The id a thread is keyed by: the address for addressable roots (stable across edits), else the event id. */
export const threadKey = (root: Event): string => (isAddressable(root.kind) ? addressOf(root) : root.id);

/** The parent's thread key, or undefined if the event isn't a reply in this thread. */
export function parentOf(ev: Event, root: Event): string | undefined {
  const key = threadKey(root);
  if (ev.kind === KIND.note) {
    const marked = (m: string) => ev.tags.find((t) => t[0] === 'e' && t[3] === m)?.[1];
    const reply = marked('reply');
    const rootRef = marked('root');
    if (reply) return reply;
    if (rootRef) return rootRef === root.id ? key : undefined;
    const positional = ev.tags.filter((t) => t[0] === 'e' && !t[3]).map((t) => t[1]);
    if (!positional.length || positional[0] !== root.id) return undefined;
    return positional.length > 1 ? positional.at(-1) : key;
  }
  if (ev.kind === KIND.comment) {
    const inScope = ev.tags.some((t) => (t[0] === 'A' || t[0] === 'E') && t[1] === key);
    if (!inScope) return undefined;
    const parentKind = ev.tags.find((t) => t[0] === 'k')?.[1];
    if (parentKind === String(root.kind)) return key;
    return ev.tags.find((t) => t[0] === 'e')?.[1];
  }
  return undefined;
}

/** A reply to `parent` (the root itself, or a comment in its thread). */
export function createComment(nostrKey: Uint8Array, root: Event, parent: Event, text: string, created_at = now()): Event {
  if (root.kind === KIND.note) {
    const tags = [['e', root.id, '', 'root', root.pubkey]];
    if (parent.id !== root.id) tags.push(['e', parent.id, '', 'reply', parent.pubkey]);
    for (const pk of new Set([root.pubkey, parent.pubkey])) tags.push(['p', pk]);
    return finalizeEvent({ kind: KIND.note, created_at, content: text, tags }, nostrKey);
  }
  const rootScope = isAddressable(root.kind) ? ['A', addressOf(root), ''] : ['E', root.id, '', root.pubkey];
  const tags = [rootScope, ['K', String(root.kind)], ['P', root.pubkey]];
  if (parent.id === root.id) {
    if (isAddressable(root.kind)) tags.push(['a', addressOf(root), ''], ['e', root.id, '', root.pubkey]);
    else tags.push(['e', root.id, '', root.pubkey]);
    tags.push(['k', String(root.kind)], ['p', root.pubkey]);
  } else {
    tags.push(['e', parent.id, '', parent.pubkey], ['k', String(parent.kind)], ['p', parent.pubkey]);
  }
  return finalizeEvent({ kind: KIND.comment, created_at, content: text, tags }, nostrKey);
}

/** A thread's comments live under a root `e` tag (notes) or root `A`/`E` scope (comments). */
export function threadFilters(root: Event) {
  return root.kind === KIND.note
    ? [{ kinds: [KIND.note], '#e': [root.id] }]
    : [{ kinds: [KIND.comment], [isAddressable(root.kind) ? '#A' : '#E']: [threadKey(root)] }];
}

export type Vote = 1 | 0 | -1;

/** An up or down vote. A neutral vote (0) withdraws an earlier one, since only the latest reaction counts. */
export function createVote(nostrKey: Uint8Array, target: Event, vote: Vote, created_at = now()): Event {
  const content = vote === 1 ? '+' : vote === -1 ? '-' : '';
  const tags = [['e', target.id], ['p', target.pubkey], ['k', String(target.kind)]];
  return finalizeEvent({ kind: KIND.reaction, created_at, content, tags }, nostrKey);
}

export interface Tally {
  up: number;
  down: number;
  /** The given voter's current vote. */
  mine: Vote;
}

/** Each voter's latest reaction per target. `counts` decides whose votes count, e.g. accounts the reader trusts. */
export function tallyVotes(reactions: Event[], me?: string, counts: (pubkey: string) => boolean = () => true): Map<string, Tally> {
  const latest = new Map<string, Event>();
  for (const r of reactions) {
    if (r.kind !== KIND.reaction) continue;
    const target = r.tags.findLast((t) => t[0] === 'e')?.[1];
    if (!target) continue;
    const key = `${target}:${r.pubkey}`;
    const prev = latest.get(key);
    if (!prev || r.created_at > prev.created_at || (r.created_at === prev.created_at && r.id > prev.id)) latest.set(key, r);
  }
  const tallies = new Map<string, Tally>();
  for (const [key, r] of latest) {
    const target = key.slice(0, key.lastIndexOf(':'));
    const t = tallies.get(target) ?? { up: 0, down: 0, mine: 0 };
    const vote: Vote = r.content === '-' ? -1 : r.content === '' ? 0 : 1;
    if (r.pubkey === me) t.mine = vote;
    if (counts(r.pubkey) || r.pubkey === me) {
      if (vote === 1) t.up++;
      if (vote === -1) t.down++;
    }
    tallies.set(target, t);
  }
  return tallies;
}

/** Reddit's "best": the lower bound of the Wilson score interval for the share of up votes (80% confidence). */
export function wilson(up: number, down: number): number {
  const n = up + down;
  if (!n) return 0;
  const z = 1.281551565545;
  const p = up / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / (1 + (z * z) / n);
}

/** Reddit's "controversial": many votes, evenly split. */
export function controversy(up: number, down: number): number {
  if (up <= 0 || down <= 0) return 0;
  return (up + down) ** (up > down ? down / up : up / down);
}

export type Sort = 'best' | 'top' | 'new' | 'controversial';

export interface ThreadNode {
  event: Event;
  up: number;
  down: number;
  score: number;
  mine: Vote;
  depth: number;
  children: ThreadNode[];
}

/** Builds the tree under `root`. Replies whose parent hasn't arrived are shown at the top level rather than lost. */
export function buildThread(
  root: Event,
  comments: Event[],
  reactions: Event[],
  sort: Sort,
  opts: { me?: string; counts?: (pubkey: string) => boolean; muted?: Set<string> } = {},
): ThreadNode[] {
  const tallies = tallyVotes(reactions, opts.me, opts.counts);
  const key = threadKey(root);
  const unique = [...new Map(comments.map((c) => [c.id, c])).values()].filter((c) => !opts.muted?.has(c.pubkey));
  const nodes = new Map<string, ThreadNode>();
  for (const event of unique) {
    if (parentOf(event, root) === undefined) continue;
    const t = tallies.get(event.id) ?? { up: 0, down: 0, mine: 0 as Vote };
    nodes.set(event.id, { event, up: t.up, down: t.down, score: t.up - t.down, mine: t.mine, depth: 0, children: [] });
  }
  const top: ThreadNode[] = [];
  for (const node of nodes.values()) {
    const parent = parentOf(node.event, root);
    const parentNode = parent && parent !== key ? nodes.get(parent) : undefined;
    (parentNode ? parentNode.children : top).push(node);
  }
  const rank: Record<Sort, (n: ThreadNode) => number> = {
    best: (n) => wilson(n.up, n.down),
    top: (n) => n.score,
    new: (n) => n.event.created_at,
    controversial: (n) => controversy(n.up, n.down),
  };
  const order = (list: ThreadNode[], depth: number) => {
    list.sort((a, b) => rank[sort](b) - rank[sort](a) || a.event.created_at - b.event.created_at);
    for (const n of list) {
      n.depth = depth;
      order(n.children, depth + 1);
    }
  };
  order(top, 0);
  return top;
}

export const countComments = (nodes: ThreadNode[]): number => nodes.reduce((n, c) => n + 1 + countComments(c.children), 0);
