/** Post text as React elements: links, images, video, mentions and hashtags. Never raw HTML. */
import type { ReactNode } from 'react';
import { decode } from 'nostr-tools/nip19';
import { useApp } from '../context.ts';
import { Name } from './ui.tsx';

const TOKEN = /(https?:\/\/[^\s<>"']+)|(nostr:(?:npub1|nprofile1)[02-9ac-hj-np-z]+)|(#[\p{L}\p{N}_]+)/gu;
const IMAGE = /\.(jpe?g|png|gif|webp|avif)(\?\S*)?$/i;
const VIDEO = /\.(mp4|webm|mov)(\?\S*)?$/i;

function mentionKey(uri: string): string | undefined {
  try {
    const d = decode(uri.slice('nostr:'.length));
    if (d.type === 'npub') return d.data;
    if (d.type === 'nprofile') return d.data.pubkey;
  } catch {
    return undefined;
  }
}

export function Content({ text }: { text: string }) {
  const { navigate } = useApp();
  const parts: ReactNode[] = [];
  const media: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    parts.push(text.slice(last, m.index));
    last = m.index! + m[0].length;
    const [token, url, mention, hashtag] = m;
    if (url) {
      if (url.startsWith('https://') && IMAGE.test(url)) media.push(<img key={media.length} className="post-media" src={url} alt="" loading="lazy" referrerPolicy="no-referrer" />);
      else if (url.startsWith('https://') && VIDEO.test(url)) media.push(<video key={media.length} className="post-media" src={url} controls preload="metadata" playsInline />);
      else parts.push(<a key={last} href={url} target="_blank" rel="noopener noreferrer nofollow">{url.replace(/^https?:\/\//, '').slice(0, 48)}{url.length > 56 ? '…' : ''}</a>);
    } else if (mention) {
      const pk = mentionKey(mention);
      parts.push(pk ? <a key={last} href={`#/p/${pk}`} onClick={(e) => (e.preventDefault(), navigate(`/p/${pk}`))}>@<Name pubkey={pk} /></a> : token);
    } else if (hashtag) {
      parts.push(<span key={last} className="tag">{hashtag}</span>);
    }
  }
  parts.push(text.slice(last));
  return (
    <>
      <div className="post-body">{parts}</div>
      {media.slice(0, 4)}
    </>
  );
}
