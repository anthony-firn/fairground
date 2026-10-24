import { useState } from 'react';
import type { Event } from 'nostr-tools/pure';
import type { ReportReason } from '@core/commerce.ts';
import { useApp } from '../context.ts';
import { hideAccount, report } from '../lib/safety.ts';
import { Name, Sheet } from './ui.tsx';

const REASONS: [ReportReason, string][] = [
  ['spam', 'Spam or scam'],
  ['illegal', 'Child safety or other illegal content'],
  ['impersonation', 'Pretending to be someone else'],
  ['nudity', 'Sexual content'],
  ['profanity', 'Hate or harassment'],
  ['other', 'Something else'],
];

/** Options for one post: show less, hide the account, or report it. */
export function PostMenu({ post, onLess, onClose, onHidden }: { post: Event; onLess?: () => void; onClose: () => void; onHidden: () => void }) {
  const { account, toast } = useApp();
  const [reporting, setReporting] = useState(false);
  return (
    <Sheet title={reporting ? 'Report this post' : 'Post options'} onClose={onClose}>
      {reporting ? (
        <div className="list card">
          {REASONS.map(([reason, label]) => (
            <button key={reason} type="button" onClick={async () => {
              await report(account, post, reason);
              toast('Reported. You won’t see this account again.');
              onHidden();
              onClose();
            }}>{label}</button>
          ))}
          {reasons()}
        </div>
      ) : (
        <div className="list card">
          {onLess && <button type="button" onClick={() => (onLess(), onClose())}>Show less like this</button>}
          <button type="button" onClick={() => {
            hideAccount(post.pubkey);
            toast('Hidden. Change this in You → Your feed and AI.');
            onHidden();
            onClose();
          }}>Hide posts from <Name pubkey={post.pubkey} /></button>
          <button type="button" onClick={() => setReporting(true)}>Report…</button>
        </div>
      )}
    </Sheet>
  );
}

function reasons() {
  return (
    <p className="tiny muted" style={{ padding: '8px 4px 0', margin: 0 }}>
      Reports are public Nostr events that other apps and relays can act on. For child sexual abuse material, also report to
      the <a href="https://report.cybertip.org/" target="_blank" rel="noopener noreferrer">NCMEC CyberTipline</a>.
    </p>
  );
}
