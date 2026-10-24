/**
 * Recording a host-read ad for an accepted deal. The creator reads the sponsor's points in their own words (recorded
 * here or uploaded), picks the slots, dates and shows, and publishes a placement. The read is converted on the device
 * to MP3 matching the creator's episodes, so it can be stitched into downloads for every podcast app.
 */
import { useEffect, useRef, useState } from 'react';
import type { Event } from 'nostr-tools/pure';
import { createPlacement, type Slot, type Spot } from '@core/ads.ts';
import { KIND } from '@core/kinds.ts';
import { parseEpisode } from '@core/podcast.ts';
import type { Offer } from '@core/sponsorship.ts';
import { useApp } from '../context.ts';
import { DEFAULT_TARGET, mediaDuration, startRecording, toMp3, withExtension, type Mp3Target } from '../lib/audio.ts';
import { nowSeconds } from '../lib/format.ts';
import { getProfile } from '../lib/hooks.ts';
import { publish, query } from '../lib/net.ts';
import { displayName } from '../lib/format.ts';
import { uploadBlob, uploadFile } from '../lib/upload.ts';
import { useMyShows } from '../screens/Podcast.tsx';
import { Field, Sheet } from './ui.tsx';

const DAY = 86400;
const dateInput = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const fromDate = (d: string) => Math.floor(new Date(`${d}T00:00:00`).getTime() / 1000);

/** The MP3 format of the creator's newest episode, which a read must match to be spliced in. */
async function showFormat(pubkey: string): Promise<Mp3Target> {
  const eps = (await query({ kinds: [54], authors: [pubkey], limit: 20 }, 3000)).map(parseEpisode).filter((e) => e?.mp3);
  const m = eps.sort((a, b) => b!.published - a!.published)[0]?.mp3;
  return m ? { sampleRate: m.sampleRate, channels: m.channels, kbps: m.channels === 2 ? 128 : 96 } : DEFAULT_TARGET;
}

export function RecordReadSheet({ acceptance, offer, onClose }: { acceptance: Event; offer: Offer; onClose: () => void }) {
  const { account, toast } = useApp();
  const shows = useMyShows();
  const terms = offer.terms;
  const offered = terms?.slots.length ? terms.slots : (['pre', 'mid'] as Slot[]);
  const recorder = useRef<Awaited<ReturnType<typeof startRecording>>>(undefined);
  const [recording, setRecording] = useState(false);
  const [audio, setAudio] = useState<{ blob: Blob; url: string }>();
  const [video, setVideo] = useState<File>();
  const [script, setScript] = useState('');
  const [slots, setSlots] = useState<Slot[]>(offered);
  const [start, setStart] = useState(dateInput(Math.max(nowSeconds(), terms?.flight?.start ?? 0)));
  const [end, setEnd] = useState(dateInput((terms?.flight?.end ?? nowSeconds() + 28 * DAY) - DAY));
  const [onShows, setOnShows] = useState<string[]>([]);
  const [onVideos, setOnVideos] = useState(!!terms?.media.includes('video'));
  const [label, setLabel] = useState(`Sponsored by ${displayName(offer.advertiser, getProfile(offer.advertiser))}`);
  const [busy, setBusy] = useState('');

  useEffect(() => () => recorder.current?.cancel(), []);

  async function toggleRecording() {
    try {
      if (!recording) {
        recorder.current = await startRecording();
        setRecording(true);
      } else {
        const blob = await recorder.current!.stop();
        recorder.current = undefined;
        setRecording(false);
        setAudio({ blob, url: URL.createObjectURL(blob) });
      }
    } catch (e) {
      setRecording(false);
      toast((e as Error).name === 'NotAllowedError' ? 'Allow the microphone to record here, or upload a recording.' : (e as Error).message);
    }
  }

  async function publishRead() {
    if (!audio && !video) return;
    try {
      const spots: Spot[] = [];
      if (audio) {
        setBusy('Converting to MP3…');
        const { blob, layout } = await toMp3(audio.blob, await showFormat(account.pubkey));
        setBusy('Uploading the read…');
        const url = withExtension(await uploadBlob(account, blob, 'audio/mpeg'), 'mp3');
        spots.push({ url, type: 'audio/mpeg', duration: layout.duration, mp3: { version: layout.version, sampleRate: layout.sampleRate, channels: layout.channels, audioStart: layout.audioStart, audioEnd: layout.audioEnd } });
      }
      if (video) {
        setBusy('Uploading the video read…');
        spots.push({ url: await uploadFile(account, video), type: video.type || 'video/mp4', duration: await mediaDuration(video) });
      }
      setBusy('Publishing…');
      await publish(createPlacement(account.nostrKey, {
        acceptance, slots, start: fromDate(start), end: fromDate(end) + DAY, shows: onShows, video: onVideos && !!video,
        spots, label: label.trim(), link: terms?.url, code: terms?.code, script: script.trim() || undefined,
      }, account.pq));
      toast(terms?.approval ? 'Sent to the sponsor to approve. It runs once they do.' : 'Your read is scheduled.');
      onClose();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <Sheet title="Record your read" onClose={onClose}>
      <div className="card small stack" style={{ gap: 6 }}>
        <strong>{offer.title}</strong>
        <span style={{ whiteSpace: 'pre-wrap' }}>{offer.brief}</span>
        {terms?.points.length ? <span><strong>Talking points:</strong> {terms.points.join(' · ')}</span> : null}
        {terms?.avoid.length ? <span className="warn"><strong>Don’t say:</strong> {terms.avoid.join(' · ')}</span> : null}
        {terms?.code && <span><strong>Your code:</strong> {terms.code}</span>}
        {terms?.url && <span className="muted" style={{ wordBreak: 'break-all' }}><strong>Your link:</strong> {terms.url}</span>}
      </div>
      <p className="small muted">Read it in your own words, the way you’d recommend something to a friend. Say it’s sponsored; listeners also see “{label}”.</p>
      <div className="row wrap">
        <button type="button" className={`btn${recording ? ' primary' : ''}`} onClick={toggleRecording}>{recording ? '■ Stop recording' : audio ? 'Record again' : '● Record'}</button>
        <label className="btn">Upload audio<input type="file" accept="audio/*" hidden onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) setAudio({ blob: f, url: URL.createObjectURL(f) });
        }} /></label>
        {terms?.media.includes('video') && <label className="btn">{video ? 'Change video' : 'Upload a video read'}<input type="file" accept="video/*" hidden onChange={(e) => setVideo(e.target.files?.[0])} /></label>}
      </div>
      {audio && <audio src={audio.url} controls style={{ width: '100%' }} aria-label="Your read" />}
      {video && <span className="small">Video: {video.name}</span>}
      <Field label="What you said (optional)" hint="Helps the sponsor approve it, and anyone can read it."><textarea value={script} onChange={(e) => setScript(e.target.value)} style={{ minHeight: 70 }} /></Field>
      <div className="stack">
        <span className="small"><strong>Where it plays</strong></span>
        <div className="chips">{offered.map((s) => <button key={s} type="button" className="chip" aria-pressed={slots.includes(s)} onClick={() => setSlots(toggle(slots, s))}>{s === 'pre' ? 'Pre-roll' : s === 'mid' ? 'Mid-roll' : 'Post-roll'}</button>)}</div>
        {shows.length > 1 && (
          <div className="chips">{shows.map((s) => <button key={s.address} type="button" className="chip" aria-pressed={!onShows.length || onShows.includes(s.address)} onClick={() => setOnShows(toggle(onShows.length ? onShows : shows.map((x) => x.address), s.address))}>{s.title}</button>)}</div>
        )}
        {terms?.media.includes('video') && <label className="switch"><span>Also in my videos</span><input type="checkbox" checked={onVideos} onChange={(e) => setOnVideos(e.target.checked)} /></label>}
        <span className="tiny muted">It’s inserted into every episode{shows.length > 1 ? ' of the chosen shows' : ''}, new and old, between these dates, here and in downloads for other podcast apps. Mid-rolls go at the breaks you marked.</span>
      </div>
      <div className="row wrap">
        <Field label="From"><input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="Until"><input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
      </div>
      <Field label="Label shown while it plays"><input type="text" value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
      <button type="button" className="btn primary block" disabled={(!audio && !video) || !slots.length || recording || !!busy || !/sponsor|paid|\bad\b/i.test(label)} onClick={publishRead}>
        {busy || (terms?.approval ? 'Send for approval' : 'Schedule the read')}
      </button>
    </Sheet>
  );
}

/** What a placement is waiting on, for the creator. */
export function readStatus(offer: Offer, placement: Event | undefined, approvals: Event[]): { label: string; tone: '' | 'good' | 'warn' | 'bad'; note?: string } {
  if (!placement) return { label: 'Record your read', tone: 'warn' };
  const mine = approvals.filter((a) => a.kind === KIND.approval && a.pubkey === offer.advertiser && a.tags.some((t) => t[0] === 'e' && t[1] === placement.id)).sort((a, b) => b.created_at - a.created_at)[0];
  const verdict = mine?.tags.find((t) => t[0] === 'status')?.[1];
  if (verdict === 'changes') return { label: 'Changes asked', tone: 'bad', note: mine!.content };
  if (offer.terms?.approval && verdict !== 'approved') return { label: 'Waiting for approval', tone: '' };
  return { label: 'Scheduled', tone: 'good' };
}
