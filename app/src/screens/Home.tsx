import { useState } from 'react';
import type { RankedPost, Signal } from '@core/feed.ts';
import type { Event } from 'nostr-tools/pure';
import { PostCard } from '../components/PostCard.tsx';
import { PostMenu } from '../components/PostMenu.tsx';
import { Icon, Meter, Sheet, TopBar } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { currentRecipe, useFeed, type ModelStatus } from '../lib/feedEngine.ts';
import { SurveyPrompts } from './Survey.tsx';

const SIGNAL_LABELS: Record<Signal, string> = {
  recency: 'Posted recently',
  trust: 'From people you follow or trust',
  engagement: 'People liked it',
  topic: 'On topics you picked',
  similarity: 'Like posts you enjoy (AI on your device)',
};

function WhySheet({ ranked, onClose }: { ranked: RankedPost; onClose: () => void }) {
  const { navigate } = useApp();
  return (
    <Sheet title="Why you’re seeing this" onClose={onClose}>
      <p className="muted small">Your feed is ranked on your device by the recipe “{currentRecipe().name}”. Nothing about what you read leaves it.</p>
      {ranked.reasons.map((r) => (
        <div key={r.signal} className="stack" style={{ gap: 4 }}>
          <div className="row between small"><span>{SIGNAL_LABELS[r.signal]}</span><span className="muted">{Math.round(r.value * 100)}%</span></div>
          <Meter fraction={r.value} />
        </div>
      ))}
      {ranked.sponsored && <p className="small">This is a sponsored post: the creator was paid for it and labelled it.</p>}
      <button type="button" className="btn block" onClick={() => (onClose(), navigate('/feed'))}>Change how my feed works</button>
    </Sheet>
  );
}

function ModelLine({ status }: { status: ModelStatus }) {
  if (status === 'off') return null;
  const text = { loading: 'Personalizing on your device…', ready: 'Personalized on your device', error: 'On-device AI unavailable; ranking without it' }[status];
  return <p className="status" style={{ padding: '8px 16px 0' }}><span className={`dot ${status === 'ready' ? 'good' : status === 'loading' ? 'warn' : ''}`} />{text}</p>;
}

export function Home() {
  const { account, recipeVersion, navigate } = useApp();
  const feed = useFeed(account, recipeVersion);
  const [why, setWhy] = useState<RankedPost>();
  const [menu, setMenu] = useState<Event>();
  return (
    <>
      <TopBar title={<span className="brand"><img src="./icon.svg" alt="" width={28} height={28} />Fairground</span>}>
        <button type="button" className="btn small" onClick={() => navigate('/feed')}>{currentRecipe().name}</button>
      </TopBar>
      <ModelLine status={feed.model} />
      {feed.newCount > 0 && (
        <button type="button" className="pill" onClick={() => (feed.refresh(), window.scrollTo({ top: 0 }))}>
          {feed.newCount} new {feed.newCount === 1 ? 'post' : 'posts'}
        </button>
      )}
      <SurveyPrompts follows={feed.follows} />
      {!feed.ready && Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton" />)}
      {feed.ready && !feed.posts.length && (
        <div className="page center">
          <p className="muted">Nothing to show yet. Check your connection, or try the “Following” or “Trusted and popular” feeds.</p>
          <button type="button" className="btn" onClick={() => feed.refresh()}>Try again</button>
        </div>
      )}
      {feed.posts.map((r) => (
        <PostCard key={r.event.id} post={r.event} ranked={r} liked={feed.liked.has(r.event.id)} onReact={feed.react} onWhy={setWhy} onMenu={setMenu} />
      ))}
      {feed.ready && feed.posts.length > 0 && (
        <p className="center muted small" style={{ padding: 24 }}><Icon name="check" /> You’re caught up</p>
      )}
      {why && <WhySheet ranked={why} onClose={() => setWhy(undefined)} />}
      {menu && <PostMenu post={menu} onLess={() => feed.react(menu, 'less')} onClose={() => setMenu(undefined)} onHidden={() => feed.refresh()} />}
    </>
  );
}
