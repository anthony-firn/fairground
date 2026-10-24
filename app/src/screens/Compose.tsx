/** Posting in any format: a post, a photo set, a video, a short, or (through a show) a podcast episode. */
import { useState } from 'react';
import { finalizeEvent, type Event } from 'nostr-tools/pure';
import { createPhotoPost, createVideo } from '@core/media.ts';
import { Field, Segmented, TopBar } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { nowSeconds } from '../lib/format.ts';
import { learnLanguage } from '../lib/language.ts';
import { publish } from '../lib/net.ts';
import { uploadBlob, uploadFile, uploadPhoto } from '../lib/upload.ts';
import { mediaPath } from './Media.tsx';
import { showPath, useMyShows } from './Podcast.tsx';

/** Hashtags in the text become `t` tags, so topic feeds can find the post. */
export const hashtags = (text: string): string[][] =>
  [...new Set([...text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1].toLowerCase()))].map((t) => ['t', t]);

type Format = 'post' | 'photo' | 'video' | 'short' | 'episode';

interface VideoInfo {
  duration: number;
  dim: string;
  poster?: Blob;
}

/** Duration, size and a poster frame, read on the device from the chosen file. */
function inspectVideo(file: File): Promise<VideoInfo> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    video.src = url;
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(1, video.duration / 2);
    };
    video.onseeked = () => {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d')!.drawImage(video, 0, 0);
      canvas.toBlob((poster) => {
        URL.revokeObjectURL(url);
        resolve({ duration: video.duration, dim: `${video.videoWidth}x${video.videoHeight}`, poster: poster ?? undefined });
      }, 'image/jpeg', 0.8);
    };
    video.onerror = () => resolve({ duration: 0, dim: '' });
  });
}

export function Compose() {
  const { account, navigate, toast } = useApp();
  const shows = useMyShows();
  const [format, setFormat] = useState<Format>('post');
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [mediaUrl, setMediaUrl] = useState('');
  const [info, setInfo] = useState<{ duration?: number; dim?: string; poster?: string }>({});
  const [busy, setBusy] = useState('');

  async function addPhotos(files: FileList | null) {
    if (!files?.length) return;
    setBusy('Uploading photos…');
    try {
      for (const f of [...files].slice(0, 10)) {
        const url = await uploadPhoto(account, f);
        setImages((list) => [...list, url]);
      }
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function addMedia(file: File | undefined) {
    if (!file) return;
    setBusy('Reading and uploading video…');
    try {
      const meta = await inspectVideo(file);
      const url = await uploadFile(account, file);
      const poster = meta.poster ? await uploadBlob(account, meta.poster, 'image/jpeg').catch(() => undefined) : undefined;
      setMediaUrl(url);
      setInfo({ duration: meta.duration || undefined, dim: meta.dim || undefined, poster });
      const [w, h] = meta.dim.split('x').map(Number);
      if (h > w && meta.duration <= 90) setFormat('short');
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function post() {
    setBusy('Posting…');
    try {
      let ev: Event;
      if (format === 'photo') ev = createPhotoPost(account.nostrKey, { title, description: text, images: images.map((url) => ({ url })) });
      else if (format === 'video' || format === 'short') {
        ev = createVideo(account.nostrKey, { short: format === 'short', title, description: text, url: mediaUrl.trim(), poster: info.poster, duration: info.duration, dim: info.dim });
      } else ev = finalizeEvent({ kind: 1, created_at: nowSeconds(), content: text.trim(), tags: hashtags(text) }, account.nostrKey);
      await publish(ev);
      learnLanguage(`${title} ${text}`, 5);
      toast('Posted');
      navigate(format === 'post' ? `/p/${account.pubkey}` : mediaPath(ev.id));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  const ready = format === 'post' ? !!text.trim()
    : format === 'photo' ? images.length > 0 && !!title.trim()
      : !!title.trim() && /^https:\/\//.test(mediaUrl.trim());
  return (
    <>
      <TopBar title="New" />
      <div className="page">
        <Segmented value={format} onChange={setFormat} options={[['post', 'Text'], ['photo', 'Photo'], ['video', 'Video'], ['short', 'Short'], ['episode', 'Episode']]} />
        {format === 'episode' && (
          <div className="card stack">
            <span className="small">Episodes belong to a podcast, which gets its own feed for Apple Podcasts, Spotify and every other app.</span>
            {shows.map((s) => <button key={s.address} type="button" className="btn" onClick={() => navigate(`${showPath(s.creator, s.slug)}/new`)}>New episode of {s.title}</button>)}
            <button type="button" className={`btn${shows.length ? '' : ' primary'}`} onClick={() => navigate('/podcast/new')}>Start a podcast</button>
          </div>
        )}
        {format !== 'post' && format !== 'episode' && <Field label="Title"><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={150} /></Field>}
        {format === 'photo' && (
          <div className="stack">
            <div className="row wrap">
              {images.map((src) => <img key={src} src={src} alt="" width={80} height={80} style={{ objectFit: 'cover', borderRadius: 8 }} />)}
              <label className="btn">{images.length ? 'Add more' : 'Choose photos'}<input type="file" accept="image/*" multiple hidden onChange={(e) => addPhotos(e.target.files)} /></label>
            </div>
            <span className="tiny muted">Shrunk and stripped of location data on your device before upload.</span>
          </div>
        )}
        {(format === 'video' || format === 'short') && (
          <div className="stack">
            <label className="btn">Choose a video
              <input type="file" accept="video/*" hidden onChange={(e) => addMedia(e.target.files?.[0])} />
            </label>
            <Field label="Or paste a link" hint="Uploads go to free media servers, up to 500 MB. A link to an MP4 or an HLS stream (.m3u8) works too.">
              <input type="url" value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} placeholder="https://…" />
            </Field>
            {info.poster && <img src={info.poster} alt="Poster frame" style={{ maxWidth: 200, borderRadius: 8 }} />}
          </div>
        )}
        {format !== 'episode' && <Field label={format === 'post' ? 'What’s happening?' : 'Description'}>
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={format === 'post' ? 'Add #topics so people find it.' : ''} maxLength={5000} style={{ minHeight: format === 'post' ? 180 : 100 }} />
        </Field>}
        <div className="row between">
          <button type="button" className="btn ghost small" onClick={() => navigate('/market/new')}>Sell something instead</button>
          {format !== 'episode' && <button type="button" className="btn primary" disabled={!ready || !!busy} onClick={post}>{busy || 'Post'}</button>}
        </div>
      </div>
    </>
  );
}
