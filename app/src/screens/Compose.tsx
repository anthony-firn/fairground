import { useState } from 'react';
import { finalizeEvent, type Event } from 'nostr-tools/pure';
import { TopBar } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { publish } from '../lib/net.ts';
import { nowSeconds } from '../lib/format.ts';

/** Hashtags in the text become `t` tags, so topic feeds can find the post. */
export const hashtags = (text: string): string[][] =>
  [...new Set([...text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1].toLowerCase()))].map((t) => ['t', t]);

export function Compose() {
  const { account, navigate, toast } = useApp();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  async function post() {
    setBusy(true);
    try {
      const ev: Event = finalizeEvent({ kind: 1, created_at: nowSeconds(), content: text.trim(), tags: hashtags(text) }, account.nostrKey);
      await publish(ev);
      setText('');
      toast('Posted');
      navigate(`/p/${account.pubkey}`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar title="New post" />
      <div className="page">
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="What’s happening? Add #topics so people find it." autoFocus maxLength={5000} style={{ minHeight: 180 }} />
        <div className="row between">
          <span className="small muted">{text.length ? `${text.length} characters` : 'Anyone can post. Followers, fans and sponsors come with it.'}</span>
          <button type="button" className="btn primary" disabled={!text.trim() || busy} onClick={post}>{busy ? 'Posting…' : 'Post'}</button>
        </div>
      </div>
    </>
  );
}
