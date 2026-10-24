/**
 * Podcasts: a show, its episodes, and its RSS feed for every podcast app. Creators upload MP3s here (or link files
 * hosted elsewhere), mark natural pauses where mid-roll ads can go, and copy one feed link into Apple Podcasts,
 * Spotify, YouTube Music and Podcast Index. Ads they run with sponsors are stitched into downloads by the gateway.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { decode, npubEncode } from 'nostr-tools/nip19';
import type { Event } from 'nostr-tools/pure';
import { DEFAULT_GATEWAY } from '@core/defaults.ts';
import { KIND } from '@core/kinds.ts';
import { mp3Layout, mp3OffsetAt, type Mp3Layout } from '@core/mp3.ts';
import {
  createPodcastEpisode,
  createShow,
  currentEpisodes,
  feedProblems,
  feedUrl,
  parseShow,
  PODCAST_CATEGORIES,
  podcastGuid,
  showAddress,
  type Show,
} from '@core/podcast.ts';
import { formatDuration } from '@core/media.ts';
import { Field, Icon, Segmented, TopBar } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { mediaDuration, withExtension } from '../lib/audio.ts';
import { timeAgo } from '../lib/format.ts';
import { useEvents, useProfile } from '../lib/hooks.ts';
import { languageName, readerLangs } from '../lib/language.ts';
import { useMembership } from '../lib/members.ts';
import { publish, query } from '../lib/net.ts';
import { load } from '../lib/storage.ts';
import { uploadArtwork, uploadFile, uploadPhoto } from '../lib/upload.ts';
import { hashtags } from './Compose.tsx';
import { mediaPath } from './Media.tsx';

export const gateway = (): string => load<string>('gateway', DEFAULT_GATEWAY);
export const showPath = (creator: string, slug: string) => `/show/${npubEncode(creator)}/${slug}`;
const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'show';
const LANGUAGES = ['en', 'es', 'pt', 'fr', 'de', 'it', 'nl', 'sv', 'pl', 'tr', 'id', 'vi', 'ru', 'uk', 'ar', 'hi', 'ja', 'ko', 'zh'];

function newest(events: Event[]): Show | undefined {
  return events.map(parseShow).filter((s): s is Show => !!s).sort((a, b) => b.event.created_at - a.event.created_at)[0];
}

/** The reader's own shows. */
export function useMyShows(): Show[] {
  const { account } = useApp();
  const { events } = useEvents({ kinds: [KIND.show], authors: [account.pubkey], limit: 20 });
  return useMemo(() => {
    const byAddress = new Map<string, Show>();
    for (const s of events.map(parseShow)) if (s && (!byAddress.get(s.address) || byAddress.get(s.address)!.event.created_at < s.event.created_at)) byAddress.set(s.address, s);
    return [...byAddress.values()];
  }, [events]);
}

export function ShowEditor({ slug }: { slug?: string }) {
  const { account, navigate, toast } = useApp();
  const profile = useProfile(account.pubkey);
  const [loaded, setLoaded] = useState<Show>();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [image, setImage] = useState('');
  const [author, setAuthor] = useState('');
  const [category, setCategory] = useState('Technology');
  const [subcategory, setSubcategory] = useState('');
  const [explicit, setExplicit] = useState(false);
  const [language, setLanguage] = useState(() => [...readerLangs()][0] ?? 'en');
  const [email, setEmail] = useState('');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    if (!slug) return;
    query({ kinds: [KIND.show], authors: [account.pubkey], '#d': [slug] }, 4000).then((list) => {
      const s = newest(list);
      if (!s) return;
      setLoaded(s);
      setTitle(s.title);
      setDescription(s.description);
      setImage(s.image);
      setAuthor(s.author);
      setCategory(s.category);
      setSubcategory(s.subcategory ?? '');
      setExplicit(s.explicit);
      setLanguage(s.language);
      setEmail(s.ownerEmail ?? '');
      setLink(s.link ?? '');
    }, () => undefined);
  }, [slug, account.pubkey]);

  async function art(file?: File) {
    if (!file) return;
    setBusy('Uploading artwork…');
    try {
      setImage(withExtension((await uploadArtwork(account, file)).url, 'jpg'));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function save() {
    const finalSlug = loaded?.slug ?? slugify(title);
    setBusy('Saving…');
    try {
      await publish(createShow(account.nostrKey, {
        slug: finalSlug, title: title.trim(), description: description.trim(), image, author: (author || profile?.name || title).trim(),
        category, subcategory: subcategory || undefined, explicit, language, ownerName: author || profile?.name, ownerEmail: email.trim() || undefined,
        link: link.trim() || undefined, guid: loaded?.guid ?? podcastGuid(feedUrl(gateway(), account.pubkey, finalSlug)),
      }));
      toast(loaded ? 'Show updated' : 'Your show is ready. Add the first episode.');
      navigate(showPath(account.pubkey, finalSlug));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  const ready = title.trim() && description.trim() && image && category;
  return (
    <>
      <TopBar title={loaded ? 'Edit show' : 'Start a podcast'} back={() => history.back()} />
      <div className="page">
        <p className="muted">One show, one feed: listeners can follow it here and in Apple Podcasts, Spotify and every other podcast app.</p>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          {image ? <img src={image} alt="Show artwork" width={120} height={120} style={{ borderRadius: 12, objectFit: 'cover' }} />
            : <span className="episode-art" style={{ width: 120, height: 120 }} aria-hidden="true">🎙</span>}
          <div className="stack grow">
            <label className="btn">{image ? 'Change artwork' : 'Choose artwork'}<input type="file" accept="image/jpeg,image/png" hidden onChange={(e) => art(e.target.files?.[0])} /></label>
            <span className="tiny muted">Square, at least 1400 × 1400 pixels. It’s cropped square and sized for Apple Podcasts on your device.</span>
          </div>
        </div>
        <Field label="Show name"><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={150} /></Field>
        <Field label="What it’s about"><textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} /></Field>
        <Field label="Host or author"><input type="text" value={author} onChange={(e) => setAuthor(e.target.value)} placeholder={profile?.name ?? ''} /></Field>
        <div className="row wrap">
          <Field label="Category">
            <select value={category} onChange={(e) => (setCategory(e.target.value), setSubcategory(''))}>{Object.keys(PODCAST_CATEGORIES).map((c) => <option key={c}>{c}</option>)}</select>
          </Field>
          {PODCAST_CATEGORIES[category]?.length > 0 && (
            <Field label="Subcategory">
              <select value={subcategory} onChange={(e) => setSubcategory(e.target.value)}><option value="">None</option>{PODCAST_CATEGORIES[category].map((c) => <option key={c}>{c}</option>)}</select>
            </Field>
          )}
          <Field label="Language">
            <select value={language} onChange={(e) => setLanguage(e.target.value)}>{[...new Set([language, ...LANGUAGES])].map((l) => <option key={l} value={l}>{languageName(l)}</option>)}</select>
          </Field>
        </div>
        <label className="switch"><span>Explicit<br /><span className="tiny muted">Strong language or adult themes. Podcast apps label it.</span></span>
          <input type="checkbox" checked={explicit} onChange={(e) => setExplicit(e.target.checked)} /></label>
        <Field label="Owner email (optional)" hint="Apple and Spotify send a code here to confirm the show is yours. It’s public in the feed, so you can remove it once they’ve confirmed.">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </Field>
        <Field label="Website (optional)"><input type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" /></Field>
        <button type="button" className="btn primary block" disabled={!ready || !!busy} onClick={save}>{busy || (loaded ? 'Save' : 'Create show')}</button>
      </div>
    </>
  );
}

function CopyLink({ url }: { url: string }) {
  const { toast } = useApp();
  return (
    <div className="row">
      <input type="text" readOnly value={url} aria-label="RSS feed link" onFocus={(e) => e.currentTarget.select()} />
      <button type="button" className="btn" onClick={() => navigator.clipboard.writeText(url).then(() => toast('Feed link copied'), () => toast('Select the link and copy it'))}>Copy</button>
    </div>
  );
}

const DIRECTORIES: [string, string, string][] = [
  ['Apple Podcasts', 'https://podcastsconnect.apple.com/', 'Sign in, choose + then “New Show”, and “Add a show with an RSS feed”. Apple checks the feed and asks the owner email to confirm.'],
  ['Spotify', 'https://creators.spotify.com/', 'Choose “Get started”, then “Find an existing podcast”, and paste the link. Spotify sends a code to the owner email.'],
  ['YouTube Music', 'https://studio.youtube.com/', 'In YouTube Studio choose Create, “New podcast”, then “Submit an RSS feed”.'],
  ['Podcast Index', 'https://podcastindex.org/add', 'Paste the link once, and Overcast, Pocket Casts, Castro, Fountain and many other apps can find it.'],
];

export function ShowPage({ npub, slug }: { npub: string; slug: string }) {
  const { account, navigate } = useApp();
  const creator = useMemo(() => {
    try {
      const d = decode(npub);
      return d.type === 'npub' ? d.data : undefined;
    } catch {
      return undefined;
    }
  }, [npub]);
  const shows = useEvents(creator ? { kinds: [KIND.show], authors: [creator], '#d': [slug] } : null);
  const show = newest(shows.events);
  const address = creator ? showAddress(creator, slug) : '';
  const eps = useEvents(creator ? { kinds: [54], authors: [creator], '#a': [address], limit: 500 } : null);
  const episodes = useMemo(() => currentEpisodes(eps.events, address), [eps.events, address]);
  const owner = creator === account.pubkey;
  if (!creator) return <><TopBar title="" back={() => history.back()} /><p className="page muted">This isn’t a show link.</p></>;
  if (!show) return <><TopBar title="" back={() => history.back()} />{shows.loading ? <div className="skeleton" /> : <p className="page muted">This show isn’t available.</p>}</>;
  const feed = feedUrl(gateway(), creator, slug);
  const problems = feedProblems(show, episodes);
  return (
    <>
      <TopBar title="Podcast" back={() => history.back()}>
        {owner && <button type="button" className="btn small" onClick={() => navigate(`/podcast/edit/${slug}`)}>Edit</button>}
      </TopBar>
      <div className="page">
        <div className="row show-head" style={{ alignItems: 'flex-start' }}>
          <img src={show.image} alt="" width={140} height={140} className="show-art" referrerPolicy="no-referrer" />
          <div className="stack grow" style={{ gap: 6 }}>
            <h2 className="watch-title" style={{ fontSize: 22 }}>{show.title}</h2>
            <span className="small muted">{show.author} · {show.subcategory ?? show.category}{show.explicit ? ' · Explicit' : ''}</span>
            {owner && <button type="button" className="btn primary small" style={{ justifySelf: 'start' }} onClick={() => navigate(`${showPath(creator, slug)}/new`)}>New episode</button>}
          </div>
        </div>
        <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{show.description}</p>
        <div className="card stack">
          <strong>Listen in any podcast app</strong>
          <CopyLink url={feed} />
          <span className="tiny muted">The RSS feed. Paste it into any app that lets you add a podcast by URL.</span>
        </div>
        {owner && (
          <div className="card stack">
            <strong>Get it into Apple Podcasts, Spotify and more</strong>
            {problems.length ? (
              <ul className="small" style={{ margin: 0, paddingLeft: 20 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
            ) : <p className="small good" style={{ margin: 0 }}>Your feed has everything these apps require.</p>}
            <ol className="small stack" style={{ margin: 0, paddingLeft: 20, gap: 8 }}>
              {DIRECTORIES.map(([name, url, how]) => <li key={name}><a href={url} target="_blank" rel="noopener noreferrer"><strong>{name}</strong></a>: {how}</li>)}
            </ol>
            <span className="tiny muted">Sponsor reads you run are stitched into downloads in every app; episodes with no ad running download straight from your file.
              Video in Apple Podcasts’ new HLS player is open only to Apple’s approved hosting partners, so the feed uses standard audio files, which every app accepts.</span>
          </div>
        )}
        <h2>Episodes</h2>
        {eps.loading && !episodes.length && <div className="skeleton" />}
        {!eps.loading && !episodes.length && <p className="muted center">No episodes yet.</p>}
        {episodes.map((e) => (
          <button key={e.guid} type="button" className="card row episode" onClick={() => navigate(mediaPath(e.event.id))}>
            <img src={e.image ?? show.image} alt="" width={64} height={64} referrerPolicy="no-referrer" />
            <span className="grow" style={{ textAlign: 'left' }}>
              <strong className="clamp-2">{e.episode ? `${e.episode}. ` : ''}{e.title}</strong>
              <span className="small muted" style={{ display: 'block' }}>{timeAgo(e.published)}{e.audio.duration ? ` · ${formatDuration(e.audio.duration)}` : ''}</span>
            </span>
            <Icon name="play" />
          </button>
        ))}
      </div>
    </>
  );
}

export function EpisodeEditor({ npub, slug }: { npub: string; slug: string }) {
  const { account, navigate, toast } = useApp();
  const address = showAddress(account.pubkey, slug);
  const eps = useEvents({ kinds: [54], authors: [account.pubkey], '#a': [address], limit: 500 });
  const existing = useMemo(() => currentEpisodes(eps.events, address), [eps.events, address]);
  const bytes = useRef<Uint8Array>(undefined);
  const player = useRef<HTMLAudioElement>(null);
  const [file, setFile] = useState<{ name: string; type: string; size: number; local: string }>();
  const [layout, setLayout] = useState<Mp3Layout>();
  const [duration, setDuration] = useState<number>();
  const [url, setUrl] = useState('');
  const [progress, setProgress] = useState<number>();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [number, setNumber] = useState('');
  const [numberTouched, setNumberTouched] = useState(false);
  const [season, setSeason] = useState('');
  const [type, setType] = useState<'full' | 'trailer' | 'bonus'>('full');
  const [explicit, setExplicit] = useState(false);
  const [cover, setCover] = useState('');
  const [breaks, setBreaks] = useState<number[]>([]);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    if (!numberTouched && !eps.loading) setNumber(String(Math.max(0, ...existing.map((e) => e.episode ?? 0)) + 1));
  }, [existing, eps.loading, numberTouched]);

  async function choose(f?: File) {
    if (!f) return;
    const data = new Uint8Array(await f.arrayBuffer());
    bytes.current = data;
    const l = mp3Layout(data);
    setLayout(l);
    setDuration(l?.duration ?? (await mediaDuration(f)));
    setFile({ name: f.name, type: l ? 'audio/mpeg' : f.type || 'audio/mpeg', size: f.size, local: URL.createObjectURL(f) });
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '));
    setProgress(0);
    try {
      const uploaded = await uploadFile(account, f, setProgress);
      setUrl(withExtension(uploaded, l ? 'mp3' : f.type.includes('mp4') || f.name.endsWith('.m4a') ? 'm4a' : 'mp3'));
    } catch (e) {
      toast((e as Error).message);
      setProgress(undefined);
    }
  }

  function addBreak() {
    const t = player.current?.currentTime ?? 0;
    if (t < 5 || (duration && t > duration - 5)) return toast('Pick a pause in the middle; pre- and post-rolls are already available.');
    setBreaks([...new Set([...breaks, Math.round(t * 10) / 10])].sort((a, b) => a - b));
  }

  async function post() {
    setBusy('Publishing…');
    try {
      const marks = breaks.map((at) => ({ at, byteOffset: layout && bytes.current ? mp3OffsetAt(bytes.current, layout, at) : undefined }));
      const ev = createPodcastEpisode(account.nostrKey, {
        show: address, guid: crypto.randomUUID(), title: title.trim(), description: description.trim(),
        audio: { url: url.trim(), type: file?.type ?? 'audio/mpeg', size: file?.size, duration },
        episode: Number(number) || undefined, season: Number(season) || undefined, episodeType: type, explicit,
        image: cover || undefined, breaks: marks, mp3: layout, topics: hashtags(description).map((t) => t[1]),
      });
      await publish(ev);
      toast('Episode published. It’s in your feed for every podcast app.');
      navigate(mediaPath(ev.id));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  const uploading = progress !== undefined && !url;
  return (
    <>
      <TopBar title="New episode" back={() => navigate(`/show/${npub}/${slug}`)} />
      <div className="page">
        {!file ? (
          <div className="stack">
            <label className="btn primary">Choose the audio file<input type="file" accept="audio/mpeg,audio/mp3,audio/mp4,audio/x-m4a,.mp3,.m4a" hidden onChange={(e) => choose(e.target.files?.[0])} /></label>
            <span className="tiny muted">MP3 works best: sponsor reads can then be stitched into downloads in every podcast app. Up to 500 MB.</span>
            <Field label="Or paste a link to an MP3 hosted elsewhere"><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></Field>
          </div>
        ) : (
          <div className="card stack">
            <strong className="small">{file.name}</strong>
            <span className="tiny muted">{(file.size / 1048576).toFixed(1)} MB{duration ? ` · ${formatDuration(duration)}` : ''}{layout ? ` · MP3 ${layout.sampleRate / 1000} kHz ${layout.channels === 1 ? 'mono' : 'stereo'}` : ' · not an MP3: ads play in Fairground only'}</span>
            {uploading && <progress max={1} value={progress} aria-label="Upload progress" />}
            {url && <span className="tiny good">Uploaded</span>}
            <audio ref={player} src={file.local} controls preload="metadata" style={{ width: '100%' }} />
            <div className="row between">
              <span className="small"><strong>Ad breaks</strong><br /><span className="tiny muted">Pre- and post-rolls are always available. Add mid-rolls at natural pauses.</span></span>
              <button type="button" className="btn small" onClick={addBreak}>Add a break here</button>
            </div>
            {breaks.length > 0 && (
              <div className="chips">{breaks.map((b) => <button key={b} type="button" className="chip on" onClick={() => setBreaks(breaks.filter((x) => x !== b))} aria-label={`Remove the break at ${formatDuration(b)}`}>{formatDuration(b)} ×</button>)}</div>
            )}
          </div>
        )}
        <Field label="Title"><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
        <Field label="Show notes"><textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} /></Field>
        <div className="row wrap">
          <Field label="Episode number"><input type="number" min={0} value={number} onChange={(e) => (setNumber(e.target.value), setNumberTouched(true))} /></Field>
          <Field label="Season (optional)"><input type="number" min={0} value={season} onChange={(e) => setSeason(e.target.value)} /></Field>
        </div>
        <Segmented value={type} onChange={setType} options={[['full', 'Episode'], ['trailer', 'Trailer'], ['bonus', 'Bonus']]} />
        <label className="switch"><span>Explicit</span><input type="checkbox" checked={explicit} onChange={(e) => setExplicit(e.target.checked)} /></label>
        <label className="btn">{cover ? 'Change episode artwork' : 'Episode artwork (optional)'}
          <input type="file" accept="image/*" hidden onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setCover(withExtension(await uploadPhoto(account, f).catch((err: Error) => (toast(err.message), '')), 'jpg'));
          }} />
        </label>
        <button type="button" className="btn primary block" disabled={!title.trim() || !/^https:\/\//.test(url.trim()) || !!busy || uploading} onClick={post}>
          {busy || (uploading ? `Uploading ${Math.round((progress ?? 0) * 100)}%…` : 'Publish episode')}
        </button>
      </div>
    </>
  );
}

/** Shows on Fairground, for the Listen tab. */
export function ShowShelf() {
  const { navigate } = useApp();
  const { events } = useEvents({ kinds: [KIND.show], limit: 100 });
  const members = useMembership(events.map((e) => e.pubkey));
  const shows = useMemo(() => {
    const byAddress = new Map<string, Show>();
    for (const s of events.map(parseShow)) if (s && members?.has(s.creator) && (!byAddress.get(s.address) || byAddress.get(s.address)!.event.created_at < s.event.created_at)) byAddress.set(s.address, s);
    return [...byAddress.values()];
  }, [events, members]);
  return (
    <div className="stack">
      <div className="row between"><h2 style={{ margin: 0 }}>Podcasts</h2><button type="button" className="btn small" onClick={() => navigate('/podcast/new')}>Start a podcast</button></div>
      {shows.length ? (
        <div className="show-shelf">
          {shows.map((s) => (
            <button key={s.address} type="button" className="show-card" onClick={() => navigate(showPath(s.creator, s.slug))}>
              <img src={s.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
              <strong className="small clamp-2">{s.title}</strong>
              <span className="tiny muted">{s.author}</span>
            </button>
          ))}
        </div>
      ) : <p className="small muted">No podcasts yet. Yours could be the first, and it reaches Apple Podcasts and Spotify too.</p>}
    </div>
  );
}
