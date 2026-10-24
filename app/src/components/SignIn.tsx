import { useState } from 'react';
import { restoreAccount } from '../lib/account.ts';
import { save } from '../lib/storage.ts';
import { findAccountVault, unlockAccountVault, type Found } from '../lib/vaultSync.ts';
import { Field, Meter, Segmented, Sheet } from './ui.tsx';

/** Sign in on a new device with a username and password (plus passkey or recovery code), or a backup code. */
export function SignInSheet({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<'password' | 'code'>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [progress, setProgress] = useState<number | undefined>();
  const [found, setFound] = useState<Found>();
  const [error, setError] = useState('');

  const finish = () => {
    save('onboarded', true);
    location.reload();
  };

  async function signIn() {
    setError('');
    try {
      setProgress(0);
      const f = await findAccountVault(username, password, setProgress);
      if (f.needs === 'nothing') {
        await unlockAccountVault(f, 'password');
        return finish();
      }
      setFound(f);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(undefined);
    }
  }

  async function second(via: 'passkey' | { recoveryCode: string }) {
    setError('');
    try {
      await unlockAccountVault(found!, via);
      finish();
    } catch (e) {
      setError(via === 'passkey' ? 'That passkey didn’t unlock this account.' : (e as Error).message || 'That recovery code isn’t right.');
    }
  }

  return (
    <Sheet title="Sign in" onClose={onClose}>
      {!found && <Segmented value={mode} onChange={setMode} options={[['password', 'Username & password'], ['code', 'Backup code']]} />}
      {found ? (
        <div className="stack">
          <p>This account also needs your passkey.</p>
          <button type="button" className="btn primary block" onClick={() => second('passkey')}>Use my passkey</button>
          <Field label="Or a recovery code"><input type="text" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" /></Field>
          <button type="button" className="btn block" disabled={!code} onClick={() => second({ recoveryCode: code })}>Use recovery code</button>
        </div>
      ) : mode === 'password' ? (
        <form className="stack" onSubmit={(e) => (e.preventDefault(), signIn())}>
          <Field label="Username"><input type="text" autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
          <Field label="Password"><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {progress !== undefined && <><Meter fraction={progress} /><p className="tiny muted">Unlocking on this device…</p></>}
          <button type="submit" className="btn primary block" disabled={!username || !password || progress !== undefined}>Sign in</button>
        </form>
      ) : (
        <form className="stack" onSubmit={(e) => {
          e.preventDefault();
          try {
            restoreAccount(code);
            finish();
          } catch (err) {
            setError((err as Error).message);
          }
        }}>
          <Field label="Backup code or nsec" hint="From “Save your account” on your other device, or a key from another Nostr app.">
            <textarea value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="none" spellCheck={false} style={{ minHeight: 80 }} />
          </Field>
          <button type="submit" className="btn primary block" disabled={!code}>Restore</button>
        </form>
      )}
      {error && <p className="bad small">{error}</p>}
    </Sheet>
  );
}
