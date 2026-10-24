/**
 * The audio and video player. It streams HLS where the browser can't natively (hls.js, loaded only when needed) and
 * plays host-read ad breaks: pre-rolls before the content, mid-rolls at the creator's marks (also when a listener seeks
 * past one), post-rolls at the end. Every ad is labelled with its sponsor and can be skipped, as Apple Podcasts also
 * requires of ads.
 */
import { useEffect, useRef, useState } from 'react';
import type { AdBreak } from '@core/ads.ts';
import { HLS } from '@core/media.ts';

/** Plays a URL in a media element, through hls.js for HLS outside Safari. Returns a cleanup. */
export async function attachSource(el: HTMLMediaElement, url: string): Promise<() => void> {
  if (!HLS.test(url) || el.canPlayType('application/vnd.apple.mpegurl')) {
    el.src = url;
    return () => el.removeAttribute('src');
  }
  const { default: Hls } = await import('hls.js');
  if (!Hls.isSupported()) {
    el.src = url;
    return () => el.removeAttribute('src');
  }
  // No worker: the app's Content-Security-Policy allows scripts only from itself.
  const hls = new Hls({ enableWorker: false });
  hls.loadSource(url);
  hls.attachMedia(el);
  return () => hls.destroy();
}

interface Props {
  kind: 'audio' | 'video';
  src: string;
  hls?: string;
  poster?: string;
  breaks?: AdBreak[];
  autoPlay?: boolean;
  label?: string;
}

export function MediaPlayer({ kind, src, hls, poster, breaks = [], autoPlay, label }: Props) {
  const main = useRef<HTMLVideoElement>(null);
  const played = useRef(new Set<number>());
  const last = useRef(0);
  const [ad, setAd] = useState<{ b: number; i: number }>();
  const [left, setLeft] = useState<number>();
  const source = hls ?? src;

  useEffect(() => {
    const el = main.current;
    if (!el) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    attachSource(el, source).then((c) => {
      if (cancelled) return c();
      cleanup = c;
      if (autoPlay) el.play().catch(() => undefined);
    }, () => {
      el.src = src;
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [source, src, autoPlay]);

  const start = (index: number) => {
    played.current.add(index);
    main.current?.pause();
    setAd({ b: index, i: 0 });
  };
  const next = () => {
    if (!ad) return;
    const brk = breaks[ad.b];
    if (ad.i + 1 < brk.ads.length) return setAd({ b: ad.b, i: ad.i + 1 });
    setAd(undefined);
    setLeft(undefined);
    if (brk.slot !== 'post') main.current?.play().catch(() => undefined);
  };

  const onPlay = () => {
    if (ad) return main.current?.pause();
    const pre = breaks.findIndex((b) => b.slot === 'pre');
    if (pre >= 0 && !played.current.has(pre)) start(pre);
  };
  const onTime = () => {
    const t = main.current?.currentTime ?? 0;
    const due = breaks.findIndex((b, i) => b.slot === 'mid' && !played.current.has(i) && last.current < b.at && t >= b.at);
    last.current = t;
    if (due >= 0 && !ad) start(due);
  };
  const onEnded = () => {
    const post = breaks.findIndex((b) => b.slot === 'post');
    if (post >= 0 && !played.current.has(post)) start(post);
  };

  const current = ad && breaks[ad.b]?.ads[ad.i];
  const videoAd = current && kind === 'video' && current.spot.type.startsWith('video/');
  const adKey = `${ad?.b}-${ad?.i}`;
  const adProps = {
    src: current?.spot.url,
    autoPlay: true,
    playsInline: true,
    onEnded: next,
    onError: next,
    onTimeUpdate: (e: React.SyntheticEvent<HTMLMediaElement>) => setLeft(Math.max(0, Math.ceil(e.currentTarget.duration - e.currentTarget.currentTime))),
  };
  const banner = current && (
    <div className="ad-banner" role="status">
      <span><span className="badge">Ad</span> {current.placement.label}{breaks[ad!.b].ads.length > 1 ? ` · ${ad!.i + 1} of ${breaks[ad!.b].ads.length}` : ''}{left !== undefined && Number.isFinite(left) ? ` · ${left}s` : ''}</span>
      <span className="row">
        {current.placement.code && <span className="badge good">Code {current.placement.code}</span>}
        {current.placement.link && <a className="btn small" href={current.placement.link} target="_blank" rel="noopener noreferrer sponsored">Visit sponsor</a>}
        <button type="button" className="btn small ghost" onClick={next}>Skip</button>
      </span>
    </div>
  );

  return (
    <div className={`player-wrap ${kind}`}>
      {kind === 'video'
        ? <video ref={main} className="player" poster={poster} controls={!ad} playsInline onPlay={onPlay} onTimeUpdate={onTime} onEnded={onEnded} aria-label={label} />
        : <audio ref={main as unknown as React.RefObject<HTMLAudioElement>} controls={!ad} preload="metadata" onPlay={onPlay} onTimeUpdate={onTime} onEnded={onEnded} style={{ width: '100%' }} aria-label={label} />}
      {current && (videoAd
        ? <div className="ad-layer"><video key={adKey} {...adProps} className="player" /></div>
        : <audio key={adKey} {...adProps} />)}
      {banner}
    </div>
  );
}
