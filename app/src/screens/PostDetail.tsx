import { useEffect, useState } from 'react';
import type { Event } from 'nostr-tools/pure';
import { PostCard } from '../components/PostCard.tsx';
import { Thread } from '../components/Thread.tsx';
import { TopBar } from '../components/ui.tsx';
import { query } from '../lib/net.ts';
import { allowed, safetySettings } from '../lib/safety.ts';

/** One post and its comments. */
export function PostDetail({ id }: { id: string }) {
  const [post, setPost] = useState<Event | null>();
  useEffect(() => {
    query({ ids: [id] }, 4000).then(([ev]) => setPost(ev && allowed(ev, { ...safetySettings(), allLanguages: true }, true) ? ev : null), () => setPost(null));
  }, [id]);
  return (
    <>
      <TopBar title="Post" back={() => history.back()} />
      {post === undefined && <div className="skeleton" />}
      {post === null && <p className="page muted">This post isn’t available.</p>}
      {post && (
        <>
          <PostCard post={post} />
          <Thread root={post} />
        </>
      )}
    </>
  );
}
