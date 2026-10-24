import { useEffect, useRef } from 'react';
import type { Event } from 'nostr-tools/pure';
import type { RankedPost, Reaction } from '@core/feed.ts';
import { useApp } from '../context.ts';
import { timeAgo } from '../lib/format.ts';
import { Content } from './Content.tsx';
import { Avatar, Icon, Name } from './ui.tsx';

interface Props {
  post: Event;
  ranked?: RankedPost;
  liked?: boolean;
  onReact?: (post: Event, reaction: Reaction) => void;
  onWhy?: (ranked: RankedPost) => void;
  onMenu?: (post: Event) => void;
}

/** Reading a post for a few seconds counts as interest, and credits the relay that delivered it. */
function useRead(onRead: (() => void) | undefined) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !onRead) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const io = new IntersectionObserver(([entry]) => {
      clearTimeout(timer);
      if (entry.isIntersecting) timer = setTimeout(onRead, 2500);
    }, { threshold: 0.6 });
    io.observe(el);
    return () => {
      clearTimeout(timer);
      io.disconnect();
    };
  }, [onRead]);
  return ref;
}

export function PostCard({ post, ranked, liked, onReact, onWhy, onMenu }: Props) {
  const { navigate } = useApp();
  const ref = useRead(onReact ? () => onReact(post, 'read') : undefined);
  const openProfile = () => navigate(`/p/${post.pubkey}`);
  const sponsored = ranked?.sponsored ?? post.tags.some((t) => t[0] === 't' && t[1] === 'ad');
  return (
    <article className="post" ref={ref}>
      <Avatar pubkey={post.pubkey} onClick={openProfile} />
      <div className="grow">
        <div className="post-head">
          <button type="button" className="name" onClick={openProfile}><Name pubkey={post.pubkey} /></button>
          <span className="muted small">· {timeAgo(post.created_at)}</span>
          {sponsored && <span className="sponsored" title="The creator was paid for this post">Sponsored</span>}
        </div>
        <Content text={post.content} />
        {onReact && (
          <div className="post-actions">
            <button type="button" className={`icon-btn${liked ? ' on' : ''}`} onClick={() => onReact(post, 'like')} aria-pressed={liked} aria-label="Like">
              <Icon name="heart" filled={liked} />
            </button>
            {ranked && onWhy && (
              <button type="button" className="icon-btn" onClick={() => onWhy(ranked)} aria-label="Why am I seeing this?"><Icon name="info" /> Why</button>
            )}
            <button type="button" className="icon-btn" onClick={() => onReact(post, 'less')} aria-label="Show less like this"><Icon name="less" /> Less</button>
            <button type="button" className="icon-btn" onClick={() => navigate(`/post/${post.id}`)} aria-label="Comments"><Icon name="comment" /></button>
            {onMenu && <button type="button" className="icon-btn" onClick={() => onMenu(post)} aria-label="More options"><Icon name="more" /></button>}
          </div>
        )}
      </div>
    </article>
  );
}
