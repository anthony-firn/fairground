import { useState } from 'react';
import { STARTER_TOPICS } from '@core/feed.ts';
import { save } from '../lib/storage.ts';
import { SignInSheet } from './SignIn.tsx';

/** The first screen anyone sees: one optional tap on a few topics, then straight into a feed. */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [signingIn, setSigningIn] = useState(false);
  const toggle = (label: string) => setPicked((p) => (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]));
  const start = () => {
    save('topics', picked);
    save('onboarded', true);
    onDone();
  };
  return (
    <div className="onboarding">
      <div>
        <div className="brand"><img src="./icon.svg" alt="" width={40} height={40} /><strong>Fairground</strong></div>
        <h1>Posts from everyone, ranked by an AI that works for you.</h1>
        <p className="muted">No company in the middle: creators are paid directly, and your feed is chosen on your device. What are you into?</p>
        <div className="chips">
          {STARTER_TOPICS.map((t) => (
            <button key={t.label} type="button" className="chip" aria-pressed={picked.includes(t.label)} onClick={() => toggle(t.label)}>{t.label}</button>
          ))}
        </div>
        <button type="button" className="btn primary block" onClick={start}>{picked.length ? 'Start' : 'Skip and start'}</button>
        <button type="button" className="btn ghost block" onClick={() => setSigningIn(true)}>I already have an account</button>
      </div>
      {signingIn && <SignInSheet onClose={() => setSigningIn(false)} />}
    </div>
  );
}
