/**
 * Reddit-style comments under any post or listing: nested replies, up and down votes, sorting, and collapsible
 * branches. Comments pass the same safety rules as the feed; heavily down-voted ones start collapsed.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Event } from 'nostr-tools/pure';
import { buildThread, countComments, createComment, createVote, threadFilters, type Sort, type ThreadNode, type Vote } from '@core/comments.ts';
import { KIND } from '@core/kinds.ts';
import { useApp } from '../context.ts';
import { useMembership } from '../lib/members.ts';
import { timeAgo } from '../lib/format.ts';
import { publish, query, subscribe } from '../lib/net.ts';
import { allowed, safetySettings } from '../lib/safety.ts';
import { load } from '../lib/storage.ts';
import { Content } from './Content.tsx';
import { Icon, Name, Segmented } from './ui.tsx';

function Composer({ placeholder, onSend, autoFocus }: { placeholder: string; onSend: (text: string) => Promise<void>; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form className="stack" style={{ gap: 8 }} onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      try {
        await onSend(text.trim());
        setText('');
      } finally {
        setBusy(false);
      }
    }}>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} autoFocus={autoFocus} style={{ minHeight: 72 }} maxLength={5000} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="submit" className="btn primary small" disabled={!text.trim() || busy}>{busy ? 'Posting…' : 'Post'}</button>
      </div>
    </form>
  );
}

function Node({ node, root, onVote, onReply }: {
  node: ThreadNode;
  root: Event;
  onVote: (target: Event, vote: Vote) => void;
  onReply: (parent: Event, text: string) => Promise<void>;
}) {
  const { navigate } = useApp();
  const [collapsed, setCollapsed] = useState(node.score <= -4);
  const [replying, setReplying] = useState(false);
  const { event } = node;
  return (
    <div className="comment" style={{ marginLeft: Math.min(node.depth, 6) * 14 }}>
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className="icon-btn tiny" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Expand' : 'Collapse'}>{collapsed ? '[+]' : '[–]'}</button>
        <button type="button" className="name small" onClick={() => navigate(`/p/${event.pubkey}`)}><Name pubkey={event.pubkey} /></button>
        <span className="tiny muted">{node.score} points · {timeAgo(event.created_at)}{collapsed && node.children.length ? ` · ${countComments(node.children)} hidden` : ''}</span>
      </div>
      {!collapsed && (
        <>
          <div className="comment-body"><Content text={event.content} /></div>
          <div className="row" style={{ gap: 2 }}>
            <button type="button" className={`icon-btn${node.mine === 1 ? ' on' : ''}`} aria-label="Up vote" aria-pressed={node.mine === 1} onClick={() => onVote(event, node.mine === 1 ? 0 : 1)}><Icon name="up" /></button>
            <span className="small" style={{ minWidth: 20, textAlign: 'center' }}>{node.score}</span>
            <button type="button" className={`icon-btn${node.mine === -1 ? ' on' : ''}`} aria-label="Down vote" aria-pressed={node.mine === -1} onClick={() => onVote(event, node.mine === -1 ? 0 : -1)}><Icon name="down" /></button>
            <button type="button" className="icon-btn" onClick={() => setReplying(!replying)}>Reply</button>
          </div>
          {replying && <Composer placeholder="Write a reply" autoFocus onSend={async (t) => (await onReply(event, t), setReplying(false))} />}
          {node.children.map((c) => <Node key={c.event.id} node={c} root={root} onVote={onVote} onReply={onReply} />)}
        </>
      )}
    </div>
  );
}

export function Thread({ root }: { root: Event }) {
  const { account, toast } = useApp();
  const [comments, setComments] = useState<Event[]>([]);
  const [reactions, setReactions] = useState<Event[]>([]);
  const [sort, setSort] = useState<Sort>('best');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const seen = new Map<string, Event>();
    const [filter] = threadFilters(root);
    const close = subscribe(filter, (ev) => {
      seen.set(ev.id, ev);
      setComments([...seen.values()]);
    }, () => setLoading(false));
    const stop = setTimeout(() => setLoading(false), 4000);
    return () => (close(), clearTimeout(stop));
  }, [root]);

  const ids = comments.map((c) => c.id).sort().join();
  useEffect(() => {
    if (!ids) return;
    query({ kinds: [KIND.reaction], '#e': ids.split(',') }, 3000).then(setReactions, () => undefined);
  }, [ids]);

  const members = useMembership(comments.map((c) => c.pubkey));
  const settings = safetySettings();
  const follows = new Set(load<string[]>('follows', []));
  const muted = new Set(load<string[]>('muted', []));
  const visible = comments.filter((c) => !!members?.has(c.pubkey) && allowed(c, { ...settings, allLanguages: true }, follows.has(c.pubkey)));
  const thread = useMemo(() => buildThread(root, visible, reactions, sort, { me: account.pubkey, muted }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [root, comments, reactions, sort, account.pubkey]);

  async function reply(parent: Event, text: string) {
    try {
      const ev = createComment(account.nostrKey, root, parent, text);
      await publish(ev);
      setComments((c) => [...c, ev]);
    } catch (e) {
      toast((e as Error).message);
    }
  }

  function vote(target: Event, v: Vote) {
    const ev = createVote(account.nostrKey, target, v);
    setReactions((r) => [...r, ev]);
    publish(ev).catch(() => toast('Your vote didn’t reach any relay.'));
  }

  return (
    <section className="thread page" aria-label="Comments">
      <div className="row between">
        <strong style={{ whiteSpace: 'nowrap' }}>{countComments(thread) === 1 ? '1 comment' : `${countComments(thread)} comments`}</strong>
        <Segmented value={sort} onChange={setSort} options={[['best', 'Best'], ['top', 'Top'], ['new', 'New'], ['controversial', 'Hot takes']]} />
      </div>
      <Composer placeholder="Add a comment" onSend={(t) => reply(root, t)} />
      {loading && !comments.length && <p className="muted small">Loading comments…</p>}
      {!loading && !thread.length && <p className="muted small">No comments yet. Start the conversation.</p>}
      {thread.map((n) => <Node key={n.event.id} node={n} root={root} onVote={vote} onReply={reply} />)}
    </section>
  );
}
