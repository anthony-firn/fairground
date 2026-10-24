/**
 * One app, several ways to watch and listen: Photos (like Instagram), Videos (like YouTube), Shorts (like TikTok) and
 * Listen (podcasts and audio). All of them share the reader's recipe, the safety rules and Reddit-style comments.
 */
import { useEffect, useRef, useState } from 'react';
import { finalizeEvent, type Event } from 'nostr-tools/pure';
import { formatDuration, toMedia, type MediaItem } from '@core/media.ts';
import { Content } from '../components/Content.tsx';
import { PostMenu } from '../components/PostMenu.tsx';
import { Thread } from '../components/Thread.tsx';
import { Avatar, Icon, Name, Sheet, TopBar } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { timeAgo } from '../lib/format.ts';
import { useMediaFeed } from '../lib/mediaFeed.ts';
import { publish, query } from '../lib/net.ts';
import { allowed, safetySettings } from '../lib/safety.ts';
import { learnLanguage } from '../lib/language.ts';

export const FORMATS = [
  { path: '/', label: 'Posts', icon: 'home' },
  { path: '/photos', label: 'Photos', icon: 'photo' },
  { path: '/videos', label: 'Videos', icon: 'play' },
  { path: '/shorts', label: 'Shorts', icon: 'shorts' },
  { path: '/listen', label: 'Listen', icon: 'headphones' },
];

/** The row of formats under the top bar on phones; on desktop the sidebar does this job. */
export function FormatBar({ current }: { current: string }) {
  return (
    <nav className="format-bar" aria-label="Formats">
      {FORMATS.map((f) => <a key={f.path} href={`#${f.path}`} aria-current={current === f.path ? 'page' : undefined}>{f.label}</a>)}
    </nav>
  );
}

export const mediaPath = (id: string) => `/media/${id}`;

function useLike() {
  const { account } = useApp();
  const [liked, setLiked] = useState(new Set<string>());
  return {
    liked,
    like(ev: Event) {
      if (liked.has(ev.id)) return;
      setLiked(new Set(liked).add(ev.id));
      learnLanguage(ev.content, 1);
      publish(finalizeEvent({ kind: 7, created_at: Math.floor(Date.now() / 1000), content: '+', tags: [['e', ev.id], ['p', ev.pubkey], ['k', String(ev.kind)]] }, account.nostrKey)).catch(() => undefined);
    },
  };
}

function Empty({ what }: { what: string }) {
  return (
    <div className="page center stack">
      <p className="muted">No {what} from your network yet. They appear as people you follow, and the starting network, post them.</p>
      <p className="small muted">To widen this, turn on “Include accounts outside the starting network” in You → Your feed and AI.</p>
    </div>
  );
}

const titleOf = (m: MediaItem) => m.title || m.description.split('\n')[0].slice(0, 100) || 'Untitled';

export function PhotosScreen() {
  const { recipeVersion, navigate } = useApp();
  const { items, ready } = useMediaFeed('photo', recipeVersion);
  const { liked, like } = useLike();
  return (
    <>
      <TopBar title="Photos" />
      <FormatBar current="/photos" />
      {!ready && <div className="skeleton" />}
      {ready && !items.length && <Empty what="photos" />}
      <div className="photo-feed">
        {items.map((m) => (
          <article key={m.event.id} className="photo-card">
            <div className="row" style={{ padding: '10px 12px' }}>
              <Avatar pubkey={m.event.pubkey} onClick={() => navigate(`/p/${m.event.pubkey}`)} />
              <span className="grow"><strong className="small"><Name pubkey={m.event.pubkey} /></strong><br /><span className="tiny muted">{timeAgo(m.event.created_at)}</span></span>
            </div>
            <button type="button" className="photo-frame" onClick={() => navigate(mediaPath(m.event.id))} aria-label={`Open ${titleOf(m)}`}>
              <img src={m.images[0]} alt={m.title ?? ''} loading="lazy" referrerPolicy="no-referrer" />
              {m.images.length > 1 && <span className="badge photo-count">1/{m.images.length}</span>}
            </button>
            <div className="post-actions" style={{ padding: '0 10px' }}>
              <button type="button" className={`icon-btn${liked.has(m.event.id) ? ' on' : ''}`} onClick={() => like(m.event)} aria-label="Like"><Icon name="heart" filled={liked.has(m.event.id)} /></button>
              <button type="button" className="icon-btn" onClick={() => navigate(mediaPath(m.event.id))} aria-label="Comments"><Icon name="comment" /></button>
            </div>
            {(m.title || m.description) && <p className="small photo-caption"><strong><Name pubkey={m.event.pubkey} /></strong> {m.title ? `${m.title} · ` : ''}{m.description.slice(0, 200)}</p>}
          </article>
        ))}
      </div>
    </>
  );
}

function VideoCard({ m }: { m: MediaItem }) {
  const { navigate } = useApp();
  const duration = formatDuration(m.video?.duration);
  return (
    <button type="button" className="video-card" onClick={() => navigate(mediaPath(m.event.id))}>
      <span className="video-thumb">
        {m.video?.poster
          ? <img src={m.video.poster} alt="" loading="lazy" referrerPolicy="no-referrer" />
          : <video src={`${m.video!.url}#t=0.5`} preload="metadata" muted playsInline />}
        {duration && <span className="duration">{duration}</span>}
      </span>
      <span className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
        <Avatar pubkey={m.event.pubkey} />
        <span className="grow" style={{ textAlign: 'left' }}>
          <strong className="small clamp-2">{titleOf(m)}</strong>
          <span className="tiny muted" style={{ display: 'block' }}><Name pubkey={m.event.pubkey} /> · {timeAgo(m.event.created_at)}</span>
        </span>
      </span>
    </button>
  );
}

export function VideosScreen() {
  const { recipeVersion } = useApp();
  const { items, ready } = useMediaFeed('video', recipeVersion);
  return (
    <>
      <TopBar title="Videos" />
      <FormatBar current="/videos" />
      {!ready && <div className="skeleton" />}
      {ready && !items.length && <Empty what="videos" />}
      <div className="video-grid page">{items.map((m) => <VideoCard key={m.event.id} m={m} />)}</div>
    </>
  );
}

/** One short, playing only while most of it is on screen. */
function Short({ m, muted, onToggleMute, onComments, onMenu, liked, onLike }: {
  m: MediaItem; muted: boolean; onToggleMute: () => void; onComments: () => void; onMenu: () => void; liked: boolean; onLike: () => void;
}) {
  const { navigate } = useApp();
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) video.play().catch(() => undefined);
      else video.pause();
    }, { threshold: 0.7 });
    io.observe(video);
    return () => io.disconnect();
  }, []);
  return (
    <section className="short">
      <video ref={ref} src={m.video!.url} poster={m.video!.poster} muted={muted} loop playsInline preload="metadata" onClick={onToggleMute} />
      <div className="short-side">
        <Avatar pubkey={m.event.pubkey} onClick={() => navigate(`/p/${m.event.pubkey}`)} />
        <button type="button" className={`short-btn${liked ? ' on' : ''}`} onClick={onLike} aria-label="Like"><Icon name="heart" filled={liked} /></button>
        <button type="button" className="short-btn" onClick={onComments} aria-label="Comments"><Icon name="comment" /></button>
        <button type="button" className="short-btn" onClick={onToggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>{muted ? '🔇' : '🔊'}</button>
        <button type="button" className="short-btn" onClick={onMenu} aria-label="More options"><Icon name="more" /></button>
      </div>
      <div className="short-caption">
        <strong><Name pubkey={m.event.pubkey} /></strong>
        <span>{titleOf(m)}</span>
      </div>
    </section>
  );
}

export function ShortsScreen() {
  const { recipeVersion } = useApp();
  const { items, ready } = useMediaFeed('short', recipeVersion);
  const [muted, setMuted] = useState(true);
  const [comments, setComments] = useState<Event>();
  const [menu, setMenu] = useState<Event>();
  const { liked, like } = useLike();
  return (
    <>
      <div className="shorts-top"><FormatBar current="/shorts" /></div>
      {!ready && <div className="skeleton" />}
      {ready && !items.length && <Empty what="shorts" />}
      <div className="shorts">
        {items.map((m) => (
          <Short key={m.event.id} m={m} muted={muted} onToggleMute={() => setMuted(!muted)} onComments={() => setComments(m.event)}
            onMenu={() => setMenu(m.event)} liked={liked.has(m.event.id)} onLike={() => like(m.event)} />
        ))}
      </div>
      {comments && <Sheet title="Comments" onClose={() => setComments(undefined)}><Thread root={comments} /></Sheet>}
      {menu && <PostMenu post={menu} onClose={() => setMenu(undefined)} onHidden={() => setMenu(undefined)} />}
    </>
  );
}

export function ListenScreen() {
  const { recipeVersion, navigate } = useApp();
  const { items, ready } = useMediaFeed('audio', recipeVersion);
  return (
    <>
      <TopBar title="Listen" />
      <FormatBar current="/listen" />
      <div className="page">
        {!ready && <div className="skeleton" />}
        {ready && !items.length && <Empty what="podcasts or music" />}
        {items.map((m) => (
          <button key={m.event.id} type="button" className="card row episode" onClick={() => navigate(mediaPath(m.event.id))}>
            {m.images[0] ? <img src={m.images[0]} alt="" width={72} height={72} loading="lazy" referrerPolicy="no-referrer" /> : <span className="episode-art" aria-hidden="true">🎧</span>}
            <span className="grow" style={{ textAlign: 'left' }}>
              <strong className="clamp-2">{titleOf(m)}</strong>
              <span className="small muted" style={{ display: 'block' }}><Name pubkey={m.event.pubkey} /> · {timeAgo(m.event.created_at)}</span>
            </span>
            <Icon name="play" />
          </button>
        ))}
      </div>
    </>
  );
}

/** A photo set, video or episode on its own page, with comments and, for videos, what to watch next. */
export function MediaDetail({ id }: { id: string }) {
  const { navigate, recipeVersion } = useApp();
  const [item, setItem] = useState<MediaItem | null>();
  const [menu, setMenu] = useState(false);
  const { liked, like } = useLike();
  const next = useMediaFeed('video', recipeVersion);
  useEffect(() => {
    query({ ids: [id] }, 4000).then(([ev]) => {
      const ok = ev && allowed(ev, { ...safetySettings(), allLanguages: true }, true);
      setItem(ok ? toMedia(ev) ?? null : null);
    }, () => setItem(null));
  }, [id]);
  if (item === undefined) return <><TopBar title="" back={() => history.back()} /><div className="skeleton" /></>;
  if (item === null) return <><TopBar title="" back={() => history.back()} /><p className="page muted">This isn’t available.</p></>;
  const ev = item.event;
  return (
    <>
      <TopBar title={item.kind === 'video' ? 'Watch' : item.kind === 'audio' ? 'Listen' : 'Photo'} back={() => history.back()}>
        <button type="button" className="icon-btn" onClick={() => setMenu(true)} aria-label="More options"><Icon name="more" /></button>
      </TopBar>
      <div className="watch">
        <div className="watch-main">
          {(item.kind === 'video' || item.kind === 'short') && <video className="player" src={item.video!.url} poster={item.video!.poster} controls autoPlay playsInline />}
          {item.kind === 'photo' && <div className="photos">{item.images.map((src) => <img key={src} src={src} alt="" referrerPolicy="no-referrer" />)}</div>}
          {item.kind === 'audio' && (
            <div className="card stack center">
              {item.images[0] && <img src={item.images[0]} alt="" style={{ width: 220, height: 220, objectFit: 'cover', borderRadius: 16, margin: '0 auto' }} referrerPolicy="no-referrer" />}
              <audio src={item.audio!.url} controls preload="metadata" style={{ width: '100%' }} />
            </div>
          )}
          <div className="page" style={{ gap: 10 }}>
            <h2 className="watch-title">{titleOf(item)}</h2>
            <div className="row">
              <Avatar pubkey={ev.pubkey} onClick={() => navigate(`/p/${ev.pubkey}`)} />
              <span className="grow"><strong><Name pubkey={ev.pubkey} /></strong><br /><span className="tiny muted">{timeAgo(ev.created_at)}</span></span>
              <button type="button" className={`btn small${liked.has(ev.id) ? ' primary' : ''}`} onClick={() => like(ev)}><Icon name="heart" filled={liked.has(ev.id)} /> Like</button>
              <button type="button" className="btn small" onClick={() => navigate(`/p/${ev.pubkey}`)}>Profile</button>
            </div>
            {item.description && <div className="card small"><Content text={item.description} /></div>}
          </div>
          <Thread root={ev} />
        </div>
        {item.kind === 'video' && (
          <aside className="watch-next">
            <h2>Up next</h2>
            {next.items.filter((m) => m.event.id !== ev.id).slice(0, 12).map((m) => <VideoCard key={m.event.id} m={m} />)}
          </aside>
        )}
      </div>
      {menu && <PostMenu post={ev} onClose={() => setMenu(false)} onHidden={() => history.back()} />}
    </>
  );
}
