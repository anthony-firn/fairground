import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { KIND } from '@core/kinds.ts';
import { DEFAULT_RELAYS, DEVELOPMENT_ADDRESS } from '@core/defaults.ts';
import { createRecipeEvent, DEFAULT_RECIPE, PRESET_RECIPES, recipeFromEvent, type FeedRecipe, type Signal } from '@core/feed.ts';
import { normalizeRelayUrl } from '@core/memos.ts';
import { periodOf, parseSupportPage } from '@core/support.ts';
import { passwordProblem } from '@core/vault.ts';
import { DonationSheet, developmentReady } from '../components/DonationSheet.tsx';
import { Avatar, Field, Icon, Meter, Name, Segmented, Sheet, TopBar } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { backupCode } from '../lib/account.ts';
import { pqKeys } from '../lib/data.ts';
import { nowSeconds, shortKey, usd } from '../lib/format.ts';
import { useEvents } from '../lib/hooks.ts';
import { modelChoice, type ModelChoice } from '../lib/model.ts';
import { pool, publish, query, relays, setRelays } from '../lib/net.ts';
import { isBrowserLanguage, languageName, readerLangs, resetLearnedLanguages, setExtraLanguage } from '../lib/language.ts';
import { passkeysSupported } from '../lib/passkey.ts';
import { load, save } from '../lib/storage.ts';
import { createAccountVault, requirePasskey, session, signOutEverywhereLocal } from '../lib/vaultSync.ts';
import { SupportSheet, useEditProfile, type Supporting } from './Profile.tsx';

export function You() {
  const { account, navigate } = useApp();
  const edit = useEditProfile();
  const signedIn = session();
  const [donating, setDonating] = useState(false);
  return (
    <>
      <TopBar title="You" />
      <div className="page">
        <button type="button" className="card row" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => navigate(`/p/${account.pubkey}`)}>
          <Avatar pubkey={account.pubkey} />
          <span className="grow"><strong><Name pubkey={account.pubkey} /></strong><br /><span className="small muted">View your profile</span></span>
          <Icon name="chevron" />
        </button>
        {!signedIn && (
          <button type="button" className="card" style={{ textAlign: 'left', cursor: 'pointer', borderColor: 'var(--accent)' }} onClick={() => navigate('/account')}>
            <strong>Save your account</strong><br /><span className="small muted">Add a username and password to use Fairground on any device.</span>
          </button>
        )}
        <div className="card list">
          <button type="button" onClick={edit.open}>Edit profile <Icon name="chevron" /></button>
          <button type="button" onClick={() => navigate('/feed')}>Your feed and AI <Icon name="chevron" /></button>
          <button type="button" onClick={() => navigate('/messages')}>Messages <Icon name="chevron" /></button>
          <button type="button" onClick={() => navigate('/orders')}>Orders <Icon name="chevron" /></button>
          <button type="button" onClick={() => navigate('/supporting')}>Creators you support <Icon name="chevron" /></button>
          <button type="button" onClick={() => navigate('/account')}>Account and sign-in <Icon name="chevron" /></button>
          <button type="button" onClick={() => navigate('/relays')}>Relays <Icon name="chevron" /></button>
          <button type="button" onClick={() => navigate('/about')}>About Fairground <Icon name="chevron" /></button>
          <button type="button" onClick={() => setDonating(true)}>Support Fairground <Icon name="heart" /></button>
        </div>
      </div>
      {edit.sheet}
      {donating && <DonationSheet onClose={() => setDonating(false)} />}
    </>
  );
}

const SIGNALS: [Signal, string][] = [
  ['similarity', 'Like what I enjoy (AI)'],
  ['engagement', 'Popular with people'],
  ['recency', 'New'],
  ['trust', 'From people I follow'],
  ['topic', 'My topics'],
];

export function FeedSettings() {
  const { navigate, bumpRecipe, account, toast } = useApp();
  const [recipe, setRecipe] = useState<FeedRecipe>(() => load('recipe', DEFAULT_RECIPE));
  const [model, setModel] = useState<ModelChoice>(modelChoice);
  const [muted, setMuted] = useState(recipe.mutedWords.join(', '));
  const [sensitive, setSensitive] = useState(() => load('showSensitive', false));
  const { events: shared } = useEvents({ kinds: [KIND.feedRecipe], limit: 30 });

  const apply = (next: FeedRecipe) => {
    setRecipe(next);
    save('recipe', next);
    bumpRecipe();
  };
  const applyModel = (next: ModelChoice) => {
    setModel(next);
    save('model', next);
    bumpRecipe();
  };

  return (
    <>
      <TopBar title="Your feed and AI" back={() => navigate('/you')} />
      <div className="page">
        <p className="muted small">Your feed is ranked on this device by a recipe you control. Nothing about what you read is sent anywhere.</p>
        <h2>Recipe</h2>
        <div className="stack">
          {PRESET_RECIPES.map((p) => (
            <button key={p.name} type="button" className="card" style={{ textAlign: 'left', cursor: 'pointer', borderColor: recipe.name === p.name ? 'var(--accent)' : undefined }}
              onClick={() => (apply(p), setMuted(''))}>
              <strong>{p.name}</strong>{recipe.name === p.name && <span className="badge good" style={{ marginLeft: 8 }}>On</span>}<br />
              <span className="small muted">{p.description}</span>
            </button>
          ))}
        </div>
        <h2>Fine-tune</h2>
        <div className="card stack">
          {SIGNALS.map(([s, label]) => (
            <Field key={s} label={label}>
              <input type="range" min={0} max={1} step={0.1} value={recipe.weights[s]} onChange={(e) => apply({ ...recipe, name: 'My recipe', weights: { ...recipe.weights, [s]: Number(e.target.value) } })} />
            </Field>
          ))}
          <Field label="Sponsored posts">
            <Segmented value={recipe.sponsored} onChange={(v) => apply({ ...recipe, name: 'My recipe', sponsored: v })} options={[['show', 'Show'], ['downrank', 'Fewer'], ['hide', 'Hide']]} />
          </Field>
          <Field label="Hide posts with these words" hint="Separate with commas.">
            <input type="text" value={muted} onChange={(e) => setMuted(e.target.value)} onBlur={() => apply({ ...recipe, mutedWords: muted.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean) })} />
          </Field>
        </div>
        <h2>Safety and languages</h2>
        <div className="card stack">
          <SafeSearch on={!sensitive} onChange={(on) => (setSensitive(!on), save('showSensitive', !on), bumpRecipe())} />
          <Toggle setting="showOffensive" label="Show posts with slurs or threats" />
          <Languages />
          <Toggle setting="allLanguages" label="Show posts in all languages" />
          <details className="small">
            <summary>Who you see here</summary>
            <p className="muted">Only people on Fairground. It stores posts on Nostr relays but is its own network, so the spam and
              abuse that circulate on the wider Nostr network never reach your feed.</p>
          </details>
        </div>
        <h2>AI model</h2>
        <div className="card stack">
          <Segmented value={model.kind} onChange={(k) => applyModel(k === 'ollama' ? { kind: 'ollama', model: 'nomic-embed-text', url: 'http://localhost:11434' } : { kind: k })}
            options={[['browser', 'On this device'], ['ollama', 'My Ollama'], ['off', 'Off']]} />
          {model.kind === 'browser' && <p className="small muted">A small model (about 23 MB, downloaded once) runs in this app.</p>}
          {model.kind === 'ollama' && (
            <>
              <Field label="Model"><input type="text" value={model.model} onChange={(e) => applyModel({ ...model, model: e.target.value })} /></Field>
              <Field label="Ollama address" hint="Set OLLAMA_ORIGINS on your computer to allow this app."><input type="url" value={model.url} onChange={(e) => applyModel({ ...model, url: e.target.value })} /></Field>
            </>
          )}
          {model.kind === 'off' && <p className="small muted">No AI: ranked by the other signals only.</p>}
          <button type="button" className="btn small" onClick={() => (save('interests', null), bumpRecipe(), toast('Your AI interests were reset.'))}>Reset what the AI learned</button>
        </div>
        <h2>Share and discover</h2>
        <div className="card stack">
          <button type="button" className="btn" onClick={() => publish(createRecipeEvent(account.nostrKey, recipe.name.toLowerCase().replace(/\W+/g, '-'), recipe)).then(() => toast('Recipe shared'), (e: Error) => toast(e.message))}>
            Share my recipe
          </button>
          {shared.map((ev) => {
            const r = recipeFromEvent(ev);
            return r && (
              <div key={ev.id} className="row between">
                <span className="small"><strong>{r.name}</strong> by <Name pubkey={ev.pubkey} /><br /><span className="muted">{r.description}</span></span>
                <button type="button" className="btn small" onClick={() => (apply(r), toast(`Using ${r.name}`))}>Use</button>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

/**
 * Safe search hides explicit content. Turning it off needs a self-declared 18+ confirmation, and in the iOS and Android
 * apps it can only be changed on the web, as the app stores require; the setting then follows the account.
 */
function SafeSearch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const [confirming, setConfirming] = useState(false);
  const native = Capacitor.isNativePlatform();
  return (
    <>
      <label className="switch">
        <span>Safe search<br /><span className="tiny muted">{on ? 'Explicit content is hidden.' : 'Explicit content can appear. You confirmed you are 18 or older.'}</span></span>
        <input type="checkbox" checked={on} disabled={native} onChange={(e) => (e.target.checked ? onChange(true) : setConfirming(true))} />
      </label>
      {native && <p className="tiny muted" style={{ margin: 0 }}>Adult content can only be turned on in the web version, at evolvetech.dev/play/fairground. The setting then follows your account here.</p>}
      <p className="tiny muted" style={{ margin: 0 }}>Always blocked, whatever this says: sexual content involving minors, bestiality, and intimate images shared without consent.</p>
      {confirming && (
        <Sheet title="Turn off safe search?" onClose={() => setConfirming(false)}>
          <p>Explicit sexual content may appear in your feed and on profiles. Only turn this off if you are <strong>18 or older</strong> and it is
            legal for you to view such content where you live.</p>
          <button type="button" className="btn primary block" onClick={() => {
            save('adultConfirmedAt', Math.floor(Date.now() / 1000));
            onChange(false);
            setConfirming(false);
          }}>I’m 18 or older, turn it off</button>
          <button type="button" className="btn ghost block" onClick={() => setConfirming(false)}>Keep safe search on</button>
        </Sheet>
      )}
    </>
  );
}

/** Languages the feed and search show: the device's, plus ones learned from what the reader reads and writes. */
const COMMON_LANGUAGES = ['en', 'es', 'pt', 'fr', 'de', 'it', 'nl', 'sv', 'pl', 'cs', 'tr', 'id', 'vi', 'ru', 'uk', 'ar', 'he', 'hi', 'th', 'ja', 'ko', 'zh'];

function Languages() {
  const { bumpRecipe } = useApp();
  const [langs, setLangs] = useState(() => [...readerLangs()]);
  const refresh = () => (setLangs([...readerLangs()]), bumpRecipe());
  return (
    <div className="stack">
      <span>Languages<br /><span className="tiny muted">Posts in these languages, so it feels local from the start. Ones you keep reading or writing in are added automatically.</span></span>
      <div className="chips">
        {langs.map((l) => (
          <button key={l} type="button" className="chip on" disabled={isBrowserLanguage(l)} title={isBrowserLanguage(l) ? 'Your device language' : 'Remove'}
            onClick={() => (setExtraLanguage(l, false), refresh())}>
            {languageName(l)}{isBrowserLanguage(l) ? '' : ' ×'}
          </button>
        ))}
        <select aria-label="Add a language" value="" onChange={(e) => e.target.value && (setExtraLanguage(e.target.value, true), refresh())}>
          <option value="">Add…</option>
          {COMMON_LANGUAGES.filter((l) => !langs.includes(l)).map((l) => <option key={l} value={l}>{languageName(l)}</option>)}
        </select>
      </div>
      <button type="button" className="btn ghost small" onClick={() => (resetLearnedLanguages(), refresh())}>Forget learned languages</button>
    </div>
  );
}

function Toggle({ setting, label, hint }: { setting: 'showOffensive' | 'allLanguages'; label: string; hint?: string }) {
  const { bumpRecipe } = useApp();
  const [on, setOn] = useState(() => load(setting, false));
  return (
    <label className="switch">
      <span>{label}{hint && <><br /><span className="tiny muted">{hint}</span></>}</span>
      <input type="checkbox" checked={on} onChange={(e) => {
        setOn(e.target.checked);
        save(setting, e.target.checked);
        bumpRecipe();
      }} />
    </label>
  );
}

export function AccountScreen() {
  const { account, navigate, toast } = useApp();
  const [current, setCurrent] = useState(session);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [progress, setProgress] = useState<number>();
  const [recovery, setRecovery] = useState('');
  const [showBackup, setShowBackup] = useState(false);
  const [passkeyPassword, setPasskeyPassword] = useState('');
  const weak = password ? passwordProblem(password) : undefined;
  const passkeyOn = current?.wraps.some((w) => w.kind === 'passkey');

  async function create() {
    try {
      setProgress(0);
      await createAccountVault(username, password, setProgress);
      setCurrent(session());
      toast('Saved. Sign in with this username and password on any device.');
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setProgress(undefined);
    }
  }

  async function addPasskey() {
    try {
      setProgress(0);
      setRecovery(await requirePasskey(passkeyPassword, setProgress));
      setCurrent(session());
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setProgress(undefined);
    }
  }

  return (
    <>
      <TopBar title="Account and sign-in" back={() => navigate('/you')} />
      <div className="page">
        {current ? (
          <div className="card stack">
            <p style={{ margin: 0 }}>Signed in as <strong>{current.username}</strong>. Your settings, AI, subscriptions and creator tools follow you to any device.</p>
            <p className="small muted" style={{ margin: 0 }}>Your account is stored encrypted on relays. Nobody, including Fairground, can read it or find it without your username and password.</p>
            {passkeyOn ? <p className="small good">Passkey required to sign in.</p> : passkeysSupported() && (
              <div className="stack">
                <strong>Require a passkey too</strong>
                <p className="small muted" style={{ margin: 0 }}>Face ID, fingerprint or a security key. With it, your password alone can’t open your account.</p>
                <Field label="Confirm your password"><input type="password" autoComplete="current-password" value={passkeyPassword} onChange={(e) => setPasskeyPassword(e.target.value)} /></Field>
                <button type="button" className="btn" disabled={!passkeyPassword || progress !== undefined} onClick={addPasskey}>Add a passkey</button>
              </div>
            )}
          </div>
        ) : (
          <form className="card stack" onSubmit={(e) => (e.preventDefault(), create())}>
            <h3>Save your account</h3>
            <p className="small muted" style={{ margin: 0 }}>Choose a username and password to sign in on other devices. No email, no company server: your account is encrypted on this device and stored on relays.</p>
            <Field label="Username"><input type="text" autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
            <Field label="Password" hint={weak ?? 'A long phrase works well.'}><input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
            <Field label="Password again"><input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
            <p className="tiny muted" style={{ margin: 0 }}>If you forget it, nobody can reset it. Keep it somewhere safe.</p>
            <button type="submit" className="btn primary" disabled={!username || !password || !!weak || password !== confirm || progress !== undefined}>Save account</button>
          </form>
        )}
        {progress !== undefined && <><Meter fraction={progress} /><p className="tiny muted">Encrypting on this device…</p></>}
        <div className="card stack">
          <strong>Backup code</strong>
          <p className="small muted" style={{ margin: 0 }}>Another way back in: your account’s keys. Anyone with this code is you, so keep it private.</p>
          {showBackup ? <p className="mono">{backupCode(account)}</p> : <button type="button" className="btn small" onClick={() => setShowBackup(true)}>Show backup code</button>}
          <p className="tiny muted mono" style={{ margin: 0 }}>Public key: {shortKey(account.pubkey)}</p>
        </div>
        <button type="button" className="btn ghost" onClick={() => {
          if (window.confirm('Sign out and erase this account from this device? Make sure you can sign back in first.')) {
            signOutEverywhereLocal();
            location.reload();
          }
        }}>Sign out of this device</button>
      </div>
      {recovery && (
        <Sheet title="Your recovery code" onClose={() => setRecovery('')}>
          <p>If you lose your passkey, this code and your password get you back in. Write it down; it won’t be shown again.</p>
          <p className="mono center" style={{ fontSize: 18 }}>{recovery}</p>
          <button type="button" className="btn primary block" onClick={() => setRecovery('')}>I’ve saved it</button>
        </Sheet>
      )}
    </>
  );
}

export function RelaysScreen() {
  const { navigate, toast } = useApp();
  const [list, setList] = useState(relays);
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState(new Map<string, boolean>());
  useEffect(() => {
    const tick = () => setStatus(pool.listConnectionStatus());
    tick();
    const t = setInterval(tick, 2000);
    return () => clearInterval(t);
  }, []);
  const update = (next: string[]) => {
    setRelays(next);
    setList(relays());
  };
  return (
    <>
      <TopBar title="Relays" back={() => navigate('/you')} />
      <div className="page">
        <p className="muted small">Relays are independent servers that carry posts. Using several keeps you online if one goes down.</p>
        <div className="card list">
          {list.map((r) => (
            <div key={r} className="row between" style={{ padding: '12px 4px' }}>
              <span className="status"><span className={`dot ${status.get(r) || status.get(`${r}/`) ? 'good' : ''}`} />{r.replace(/^wss?:\/\//, '')}</span>
              <button type="button" className="btn ghost small" disabled={list.length < 2} onClick={() => update(list.filter((x) => x !== r))}>Remove</button>
            </div>
          ))}
        </div>
        <form className="row" onSubmit={(e) => {
          e.preventDefault();
          try {
            update([...list, normalizeRelayUrl(url)]);
            setUrl('');
          } catch {
            toast('Relay addresses start with wss://');
          }
        }}>
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="wss://relay.example.com" autoCapitalize="none" />
          <button type="submit" className="btn">Add</button>
        </form>
        <button type="button" className="btn ghost" onClick={() => update(DEFAULT_RELAYS)}>Reset to defaults</button>
      </div>
    </>
  );
}

export function SupportingScreen() {
  const { navigate } = useApp();
  const list = load<Supporting[]>('supporting', []);
  const [open, setOpen] = useState<string>();
  const [pages, setPages] = useState(new Map<string, ReturnType<typeof parseSupportPage>>());
  const month = periodOf(nowSeconds());
  useEffect(() => {
    if (!list.length) return;
    (async () => {
      const events = await query({ kinds: [KIND.supportPage], authors: list.map((s) => s.creator) }, 3000);
      const lookup = await pqKeys(events.map((e) => e.pubkey));
      setPages(new Map(events.map((e) => [e.pubkey, parseSupportPage(e, lookup)])));
    })().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const page = open ? pages.get(open) : undefined;
  return (
    <>
      <TopBar title="Creators you support" back={() => navigate('/you')} />
      <div className="page">
        {!list.length && <p className="muted center">When you support a creator from their profile, they’ll show here with a reminder each month.</p>}
        {list.map((s) => (
          <div key={s.creator} className="card row between">
            <span><strong><Name pubkey={s.creator} /></strong><br /><span className="small muted">{usd(BigInt(s.amount))} · last paid {s.period}</span></span>
            {s.period === month ? <span className="badge good">Paid this month</span>
              : <button type="button" className="btn primary small" disabled={!pages.get(s.creator)} onClick={() => setOpen(s.creator)}>Support for {month}</button>}
          </div>
        ))}
      </div>
      {page && <SupportSheet page={page} onClose={() => setOpen(undefined)} />}
    </>
  );
}

export function About() {
  const { navigate } = useApp();
  const [donating, setDonating] = useState(false);
  const [ready, setReady] = useState<boolean>();
  useEffect(() => {
    developmentReady().then(setReady, () => setReady(false));
  }, []);
  return (
    <>
      <TopBar title="About Fairground" back={() => navigate('/you')} />
      <div className="page">
        <div className="card stack">
          <p style={{ margin: 0 }}>Fairground is a social network with no company in the middle. Your feed is ranked on your device, advertisers and fans pay
            creators directly, and every deal is a public, signed record. It is its own network: you see only people on Fairground.</p>
          <p className="small muted" style={{ margin: 0 }}>Open source under the Apache 2.0 licence. Built by Anthony Firn at EvolveTech. MP3 encoding by
            {' '}<a href="https://lame.sourceforge.io" target="_blank" rel="noopener noreferrer">LAME</a> (LGPL); streaming by hls.js.</p>
          <a className="btn" href="https://www.evolvetech.dev/projects/fairground/" target="_blank" rel="noopener noreferrer">Project page</a>
        </div>
        <h2>How it’s funded</h2>
        <div className="card stack">
          <p className="small" style={{ margin: 0 }}>Fairground takes no cut of anything. It runs on optional donations, split between development and the relays
            that carry posts. Every donation is a public transfer you can check.</p>
          {DEVELOPMENT_ADDRESS && (
            <p className="tiny muted" style={{ margin: 0, wordBreak: 'break-all' }}>Development fund (USDC on Algorand):{' '}
              <a href={`https://explorer.perawallet.app/address/${DEVELOPMENT_ADDRESS}/`} target="_blank" rel="noopener noreferrer">{DEVELOPMENT_ADDRESS}</a>
              {ready === false ? ' · opening soon' : ''}</p>
          )}
          <button type="button" className="btn primary" onClick={() => setDonating(true)}>Support Fairground</button>
        </div>
      </div>
      {donating && <DonationSheet onClose={() => setDonating(false)} />}
    </>
  );
}
