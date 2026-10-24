/**
 * Search across Fairground's posts, media, people, hashtags and market. Fairground is its own network, so search covers
 * Fairground accounts only: it fetches their recent posts, profiles and listings and matches on the device, which also
 * keeps what the reader searched for to themselves. Results pass the same safety rules as the feed.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Event } from 'nostr-tools/pure';
import { formatPrice, parseListing } from '@core/commerce.ts';
import { KIND } from '@core/kinds.ts';
import { ALL_MEDIA_KINDS, toMedia } from '@core/media.ts';
import { PostCard } from '../components/PostCard.tsx';
import { Avatar, Name, Segmented, TopBar } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { getProfile, rememberProfile } from '../lib/hooks.ts';
import { authorChunks, loadMembers } from '../lib/members.ts';
import { query } from '../lib/net.ts';
import { allowed, safetySettings } from '../lib/safety.ts';
import { load } from '../lib/storage.ts';
import { listingPath } from './Market.tsx';
import { mediaPath } from './Media.tsx';

type Tab = 'posts' | 'people' | 'market';

/** A profile's name and bio, which is what the safety rules judge; the event itself is JSON. */
function profileText(ev: Event): string {
  try {
    const p = JSON.parse(ev.content) as { name?: string; display_name?: string; about?: string };
    return [p.display_name, p.name, p.about].filter((v) => typeof v === 'string').join(' ') || '-';
  } catch {
    return '';
  }
}

export function Search({ query: q }: { query: URLSearchParams }) {
  const { navigate } = useApp();
  const [text, setText] = useState(q.get('q') ?? '');
  const [term, setTerm] = useState(q.get('q') ?? '');
  const [tab, setTab] = useState<Tab>('posts');
  const [results, setResults] = useState<Event[]>([]);
  const [loading, setLoading] = useState(false);
  const asked = q.get('q') ?? '';
  useEffect(() => {
    setText(asked);
    setTerm(asked);
  }, [asked]);

  useEffect(() => {
    if (!term.trim()) return setResults([]);
    let cancelled = false;
    setLoading(true);
    (async () => {
      const t = term.trim();
      const hashtag = t.startsWith('#') ? t.slice(1).toLowerCase() : undefined;
      const kinds = tab === 'people' ? [0] : tab === 'market' ? [KIND.listing] : ALL_MEDIA_KINDS;
      const network = await loadMembers().catch(() => new Set<string>());
      const batches = await Promise.all(authorChunks(network).map((authors) =>
        query(hashtag ? { kinds, authors, '#t': [hashtag], limit: 200 } : { kinds, authors, limit: tab === 'people' ? authors.length : 500 }, 4000)));
      const words = t.toLowerCase().split(/\s+/).filter(Boolean);
      const searchable = (ev: Event) => (ev.kind === 0 ? profileText(ev) : ev.kind === KIND.listing ? `${parseListing(ev)?.title ?? ''} ${ev.content}` : `${ev.tags.find((x) => x[0] === 'title')?.[1] ?? ''} ${ev.content}`).toLowerCase();
      const found = batches.flat().filter((ev) => hashtag || words.every((w) => searchable(ev).includes(w))).slice(0, 200);
      if (tab === 'people') found.forEach(rememberProfile);
      else {
        const authors = [...new Set(found.map((e) => e.pubkey))].slice(0, 200);
        (await query({ kinds: [0], authors }, 2500)).forEach(rememberProfile);
      }
      const settings = safetySettings();
      const follows = new Set(load<string[]>('follows', []));
      const muted = new Set(load<string[]>('muted', []));
      const safe = found.filter((ev) => {
        if (muted.has(ev.pubkey)) return false;
        const text = ev.kind === 0 ? profileText(ev) : ev.kind === KIND.listing ? `${parseListing(ev)?.title ?? ''} ${ev.content}` : ev.content;
        if (!allowed({ ...ev, content: text }, { ...settings, allLanguages: true }, follows.has(ev.pubkey))) return false;
        return network.has(ev.pubkey);
      });
      if (!cancelled) {
        setResults(safe.sort((a, b) => Number(network.has(b.pubkey)) - Number(network.has(a.pubkey)) || b.created_at - a.created_at));
        setLoading(false);
      }
    })().catch(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [term, tab]);

  const people = useMemo(() => [...new Map(results.filter((e) => e.kind === 0).map((e) => [e.pubkey, e])).values()], [results]);
  return (
    <>
      <TopBar title="Search" back={() => history.back()} />
      <div className="page">
        <form className="row" onSubmit={(e) => (e.preventDefault(), setTerm(text), navigate(`/search?q=${encodeURIComponent(text)}`))}>
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search posts, people, #topics or the market" aria-label="Search" autoFocus />
          <button type="submit" className="btn primary">Search</button>
        </form>
        <Segmented value={tab} onChange={setTab} options={[['posts', 'Posts'], ['people', 'People'], ['market', 'Market']]} />
        {loading && <div className="skeleton" />}
        {!loading && term && !results.length && <p className="muted center">Nothing found. Try a #hashtag, which every relay can search.</p>}
      </div>
      {tab === 'people' && people.map((ev) => (
        <button key={ev.pubkey} type="button" className="card row" style={{ margin: '0 16px 8px', cursor: 'pointer', textAlign: 'left', width: 'calc(100% - 32px)' }} onClick={() => navigate(`/p/${ev.pubkey}`)}>
          <Avatar pubkey={ev.pubkey} /><span className="grow"><strong><Name pubkey={ev.pubkey} /></strong><br /><span className="small muted">{getProfile(ev.pubkey)?.about?.slice(0, 100)}</span></span>
        </button>
      ))}
      {tab === 'market' && (
        <div className="market-grid page">
          {results.map((ev) => parseListing(ev)).filter((l) => !!l).map((l) => (
            <button key={l!.address} type="button" className="listing-card" onClick={() => navigate(listingPath(l!.address))}>
              {l!.images[0] ? <img src={l!.images[0]} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="ph">🏷</span>}
              <strong className="small">{l!.title}</strong><span className="small">{formatPrice(l!.price)}</span>
            </button>
          ))}
        </div>
      )}
      {tab === 'posts' && results.map((ev) => {
        const m = toMedia(ev);
        return m && m.kind !== 'post' && ev.kind !== 1
          ? <button key={ev.id} type="button" className="card" style={{ margin: '0 16px 8px', textAlign: 'left', cursor: 'pointer', width: 'calc(100% - 32px)' }} onClick={() => navigate(mediaPath(ev.id))}>
              <strong>{m.title || m.description.slice(0, 80)}</strong><br /><span className="small muted">{m.kind} · <Name pubkey={ev.pubkey} /></span>
            </button>
          : <PostCard key={ev.id} post={ev} />;
      })}
    </>
  );
}
