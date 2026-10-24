/** Desktop chrome: a sidebar with every section, and a right-hand column with search, safety and topics. */
import { useState } from 'react';
import { STARTER_TOPICS } from '@core/feed.ts';
import { useApp } from '../context.ts';
import { safetySettings } from '../lib/safety.ts';
import { Icon } from './ui.tsx';

const SECTIONS = [
  { path: '/', label: 'Posts', icon: 'home' },
  { path: '/photos', label: 'Photos', icon: 'photo' },
  { path: '/videos', label: 'Videos', icon: 'play' },
  { path: '/shorts', label: 'Shorts', icon: 'shorts' },
  { path: '/listen', label: 'Listen', icon: 'headphones' },
  { path: '/market', label: 'Market', icon: 'bag' },
  { path: '/search', label: 'Search', icon: 'search' },
  { path: '/messages', label: 'Messages', icon: 'comment' },
  { path: '/orders', label: 'Orders', icon: 'receipt' },
  { path: '/create', label: 'Create', icon: 'spark' },
  { path: '/you', label: 'You', icon: 'user' },
];

export function Sidebar({ path }: { path: string }) {
  const active = (p: string) => (p === '/' ? path === '/' : path === p || path.startsWith(`${p}/`));
  return (
    <aside className="sidebar" aria-label="Sections">
      <a className="brand sidebar-brand" href="#/"><img src="./icon.svg" alt="" width={32} height={32} /><strong>Fairground</strong></a>
      <nav>
        {SECTIONS.map((s) => (
          <a key={s.path} href={`#${s.path}`} aria-current={active(s.path) ? 'page' : undefined}><Icon name={s.icon} />{s.label}</a>
        ))}
      </nav>
      <a className="btn primary block" href="#/post">New post</a>
    </aside>
  );
}

export function Aside() {
  const { navigate } = useApp();
  const [q, setQ] = useState('');
  const safe = !safetySettings().showSensitive;
  return (
    <aside className="aside" aria-label="Search and topics">
      <form onSubmit={(e) => (e.preventDefault(), q.trim() && navigate(`/search?q=${encodeURIComponent(q.trim())}`))}>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Fairground" aria-label="Search Fairground" />
      </form>
      <div className="card stack">
        <strong>Topics</strong>
        <div className="chips">
          {STARTER_TOPICS.map((t) => <button key={t.label} type="button" className="chip" onClick={() => navigate(`/search?q=${encodeURIComponent(`#${t.tags[0]}`)}`)}>{t.label}</button>)}
        </div>
      </div>
      <div className="card small stack">
        <span><strong>Your feed runs on this device.</strong> Nothing about what you read leaves it.</span>
        <span className="muted">Safe search is {safe ? 'on' : 'off'}. <a href="#/feed">Change</a></span>
      </div>
      <p className="tiny muted">Fairground is open source. <a href="https://github.com/anthony-firn/fairground" target="_blank" rel="noopener noreferrer">Code</a> · <a href="#/about">About</a></p>
    </aside>
  );
}
