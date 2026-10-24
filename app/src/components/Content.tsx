/** Post text as React elements: links, images, video, audio, mentions and hashtags. Never raw HTML. */
import type { ReactNode } from 'react';
import { decode } from 'nostr-tools/nip19';
import { useApp } from '../context.ts';
import { Name } from './ui.tsx';

const TOKEN = /(https?:\/\/[^\s<>"']+)|(nostr:(?:npub1|nprofile1)[02-9ac-hj-np-z]+)|(#[\p{L}\p{N}_]+)/gu;
const IMAGE = /\.(jpe?g|png|gif|webp|avif)(\?\S*)?$/i;
const VIDEO = /\.(mp4|webm|mov)(\?\S*)?$/i;
const AUDIO = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav)(\?\S*)?$/i;

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
  let visualMedia = 0;
  let last = 0;
  // Media shows where its link appears, so authors control the layout. Each item is a block of its own, so the line
  // break on either side of it would show as a blank line.
  let afterBlock = false;
  const pushText = (t: string) => {
    parts.push(afterBlock ? t.replace(/^[ \t]*\n/, '') : t);
    afterBlock = false;
  };
  const pushBlock = (node: ReactNode) => {
    const before = parts.at(-1);
    if (typeof before === 'string') parts[parts.length - 1] = before.replace(/[ \t]*\n?[ \t]*$/, '');
    parts.push(node);
    afterBlock = true;
  };
  for (const m of text.matchAll(TOKEN)) {
    pushText(text.slice(last, m.index));
    last = m.index! + m[0].length;
    const [token, url, mention, hashtag] = m;
    const https = url?.startsWith('https://');
    if (https && IMAGE.test(url) && visualMedia < 4) {
      visualMedia++;
      pushBlock(<img key={last} className="post-media" src={url} alt="" loading="lazy" referrerPolicy="no-referrer" />);
    } else if (https && VIDEO.test(url) && visualMedia < 4) {
      visualMedia++;
      pushBlock(<video key={last} className="post-media" src={url} controls preload="metadata" playsInline />);
    } else if (https && AUDIO.test(url)) {
      // Nothing downloads until play is pressed.
      pushBlock(<audio key={last} className="post-audio" src={url} controls preload="none" />);
    } else if (url) {
      parts.push(<a key={last} href={url} target="_blank" rel="noopener noreferrer nofollow">{url.replace(/^https?:\/\//, '').slice(0, 48)}{url.length > 56 ? '…' : ''}</a>);
    } else if (mention) {
      const pk = mentionKey(mention);
      parts.push(pk ? <a key={last} href={`#/p/${pk}`} onClick={(e) => (e.preventDefault(), navigate(`/p/${pk}`))}>@<Name pubkey={pk} /></a> : token);
    } else if (hashtag) {
      parts.push(<span key={last} className="tag">{hashtag}</span>);
    }
  }
  pushText(text.slice(last));
  return <div className="post-body">{parts}</div>;
}
