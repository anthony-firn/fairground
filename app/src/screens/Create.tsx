/**
 * The Create tab: everyone can post and earn from day one. A short checklist gets a reader to their first payout; the
 * rest (sponsorships, fan support, surveys, promoting others, running a relay) is one tap away.
 */
import { useEffect, useState } from 'react';
import type { Event } from 'nostr-tools/pure';
import { KIND } from '@core/kinds.ts';
import { createMediaKit, parseMediaKit, type KitFormat } from '@core/mediakit.ts';
import { parseUsd, formatUsd } from '@core/pricing.ts';
import { algorandUsdc, isAlgorandAddress, RAIL } from '@core/rails/algorand.ts';
import { createSupportPage, fetchSupport, monthSupport, parseSupportPage, periodOf } from '@core/support.ts';
import { STARTER_TOPICS } from '@core/feed.ts';
import { DonationSheet } from '../components/DonationSheet.tsx';
import { Field, Icon, Sheet, TopBar } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { newPrice, payoutAddress, pqKeys, priceNow, useIndex } from '../lib/data.ts';
import { nowSeconds, usd } from '../lib/format.ts';
import { useProfile } from '../lib/hooks.ts';
import { publish, query } from '../lib/net.ts';
import { save } from '../lib/storage.ts';
import { useEditProfile } from './Profile.tsx';
import { showPath, useMyShows } from './Podcast.tsx';

/** Where payments arrive: the person's own Algorand wallet, checked for typos and for USDC being switched on. */
export function PayoutSheet({ onClose, onSaved }: { onClose: () => void; onSaved?: (address: string) => void }) {
  const [address, setAddress] = useState(payoutAddress());
  const [state, setState] = useState<'idle' | 'checking' | 'no-usdc' | 'invalid'>('idle');
  async function check() {
    const a = address.trim().toUpperCase();
    if (!isAlgorandAddress(a)) return setState('invalid');
    setState('checking');
    const ok = await algorandUsdc.canReceive(a).catch(() => false);
    if (!ok) return setState('no-usdc');
    save('payTo', a);
    onSaved?.(a);
    onClose();
  }
  return (
    <Sheet title="Where should payments go?" onClose={onClose}>
      <p className="muted">Sponsors and fans pay your own wallet directly, in USDC (digital dollars). Fairground never holds your money.</p>
      <ol className="small" style={{ paddingLeft: 20, margin: 0 }}>
        <li>Install <a href="https://perawallet.app" target="_blank" rel="noopener noreferrer">Pera Wallet</a> and create an account. Choose a quantum-safe (Falcon) account if offered.</li>
        <li>In Pera, add the asset “USDC” so your account can receive it.</li>
        <li>Copy your account address and paste it here.</li>
      </ol>
      <Field label="Your Algorand address">
        <input type="text" value={address} onChange={(e) => (setAddress(e.target.value), setState('idle'))} autoCapitalize="characters" spellCheck={false} placeholder="58 letters and digits" />
      </Field>
      {state === 'invalid' && <p className="bad small">That address has a typo: it doesn’t pass the checksum.</p>}
      {state === 'no-usdc' && <p className="warn small">This address can’t receive USDC yet. In Pera, add the USDC asset, then try again.</p>}
      <button type="button" className="btn primary block" disabled={!address || state === 'checking'} onClick={check}>{state === 'checking' ? 'Checking…' : 'Save'}</button>
    </Sheet>
  );
}

function Step({ done, title, detail, onClick }: { done: boolean; title: string; detail: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}>
      <span className="row">
        <span className={`badge${done ? ' good' : ''}`} aria-hidden="true">{done ? '✓' : '○'}</span>
        <span><span>{title}</span><br /><span className="small muted" style={{ fontWeight: 400 }}>{detail}</span></span>
      </span>
      <Icon name="chevron" />
    </button>
  );
}

export function Create() {
  const { account, navigate } = useApp();
  const shows = useMyShows();
  const profile = useProfile(account.pubkey);
  const edit = useEditProfile();
  const [payout, setPayout] = useState(false);
  const [hasPage, setHasPage] = useState(false);
  const [payTo, setPayTo] = useState(payoutAddress());
  useEffect(() => {
    query({ kinds: [KIND.supportPage], authors: [account.pubkey], limit: 1 }, 3000).then((e) => setHasPage(e.length > 0), () => undefined);
  }, [account.pubkey]);

  return (
    <>
      <TopBar title="Create" />
      <div className="page">
        <div className="card stack">
          <h3>Start earning</h3>
          <div className="list">
            <Step done={!!profile?.name} title="Add your name and photo" detail="So people recognise you." onClick={edit.open} />
            <Step done={!!payTo} title="Add where payments go" detail="Your own wallet; nobody takes a cut." onClick={() => setPayout(true)} />
            <Step done={hasPage} title="Turn on fan support" detail="Let fans pay for your work, ad-free if you like." onClick={() => navigate('/create/support')} />
            <Step done={false} title="Find sponsors" detail="Open offers and advertisers who pay on time." onClick={() => navigate('/create/sponsors')} />
          </div>
        </div>
        <h2>Earn</h2>
        <div className="card list">
          <button type="button" onClick={() => navigate('/create/sponsors')}>Find sponsors <Icon name="chevron" /></button>
          <button type="button" onClick={() => navigate('/create/deals')}>Your sponsorships <Icon name="chevron" /></button>
          <button type="button" onClick={() => navigate('/create/kit')}>Media kit: open to sponsors <Icon name="chevron" /></button>
          <button type="button" onClick={() => navigate('/create/support')}>Fan support <Icon name="chevron" /></button>
          <button type="button" onClick={() => navigate('/create/survey')}>Audience survey <Icon name="chevron" /></button>
        </div>
        <h2>Podcast</h2>
        <div className="card list">
          {shows.map((s) => <button key={s.address} type="button" onClick={() => navigate(showPath(s.creator, s.slug))}>{s.title} <Icon name="chevron" /></button>)}
          <button type="button" onClick={() => navigate('/podcast/new')}>{shows.length ? 'Start another podcast' : 'Start a podcast: in every podcast app'} <Icon name="chevron" /></button>
        </div>
        <h2>Sell</h2>
        <div className="card list">
          <button type="button" onClick={() => navigate('/market/new')}>Sell something or offer a service <Icon name="chevron" /></button>
          <button type="button" onClick={() => navigate('/create/store')}>Your store or restaurant <Icon name="chevron" /></button>
          <button type="button" onClick={() => navigate('/orders')}>Orders <Icon name="chevron" /></button>
          <button type="button" onClick={() => navigate('/create/credentials')}>Credentials and trust <Icon name="chevron" /></button>
        </div>
        <h2>Grow</h2>
        <div className="card list">
          <button type="button" onClick={() => navigate('/promote')}>Advertise or cross-promote <Icon name="chevron" /></button>
          <button type="button" onClick={() => navigate('/relay')}>Become a relay <Icon name="chevron" /></button>
        </div>
      </div>
      {edit.sheet}
      {payout && <PayoutSheet onClose={() => setPayout(false)} onSaved={setPayTo} />}
    </>
  );
}

export function SupportPageScreen() {
  const { account, navigate, toast } = useApp();
  const index = useIndex();
  const [title, setTitle] = useState('Support my work');
  const [pitch, setPitch] = useState('Your support pays for my time, so I can keep making things without ads.');
  const [suggested, setSuggested] = useState('5');
  const [goal, setGoal] = useState('');
  const [adFree, setAdFree] = useState(true);
  const [payout, setPayout] = useState(false);
  const [month, setMonth] = useState<{ total: bigint; supporters: number }>();
  const [donating, setDonating] = useState(false);

  useEffect(() => {
    (async () => {
      const [ev] = (await query({ kinds: [KIND.supportPage], authors: [account.pubkey], limit: 1 }, 3000)).sort((a, b) => b.created_at - a.created_at);
      const page = ev && parseSupportPage(ev, await pqKeys([account.pubkey]));
      if (!page) return;
      setTitle(page.title);
      setPitch(page.pitch);
      setSuggested(formatUsd(page.suggested.amount));
      setGoal(page.goal ? formatUsd(page.goal) : '');
      setAdFree(page.adFree);
      const period = periodOf(nowSeconds());
      setMonth(monthSupport(period, await fetchSupport(page, algorandUsdc, period)));
    })().catch(() => undefined);
  }, [account.pubkey]);

  async function publishPage() {
    const payTo = payoutAddress();
    if (!payTo) return setPayout(true);
    try {
      await publish(createSupportPage(account.nostrKey, account.pq, {
        title, pitch, suggested: newPrice(parseUsd(suggested), index), goal: goal ? parseUsd(goal) : undefined, rail: RAIL, payTo, adFree,
      }));
      toast('Fan support is on. A Support button now shows on your profile.');
      navigate('/create');
    } catch (e) {
      toast((e as Error).message);
    }
  }

  return (
    <>
      <TopBar title="Fan support" back={() => navigate('/create')} />
      <div className="page">
        {month && (
          <div className="card row between">
            <span><strong>{usd(month.total)}</strong> from {month.supporters} supporters this month</span>
            {month.total > 0n && <button type="button" className="btn small" onClick={() => setDonating(true)}>Give a little back</button>}
          </div>
        )}
        <Field label="Title"><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="What support pays for"><textarea value={pitch} onChange={(e) => setPitch(e.target.value)} /></Field>
        <Field label="Suggested monthly amount ($)" hint={index?.latest ? 'Kept in step with the cost of living.' : undefined}>
          <input type="text" inputMode="decimal" value={suggested} onChange={(e) => setSuggested(e.target.value)} />
        </Field>
        <Field label="Monthly goal ($, optional)"><input type="text" inputMode="decimal" value={goal} onChange={(e) => setGoal(e.target.value)} /></Field>
        <label className="switch card">
          <span><strong>Ad-free pledge</strong><br /><span className="small muted">After a month when fans meet the goal, take no sponsorships the next month. Anyone can check it.</span></span>
          <input type="checkbox" checked={adFree} disabled={!goal} onChange={(e) => setAdFree(e.target.checked)} />
        </label>
        <button type="button" className="btn primary block" disabled={!title || !suggested} onClick={publishPage}>Turn on fan support</button>
      </div>
      {payout && <PayoutSheet onClose={() => setPayout(false)} onSaved={() => publishPage()} />}
      {donating && month && <DonationSheet amount={month.total} onClose={() => setDonating(false)} />}
    </>
  );
}

export function MediaKitScreen() {
  const { account, navigate, toast } = useApp();
  const index = useIndex();
  const [pitch, setPitch] = useState('');
  const [rate, setRate] = useState('100');
  const [topics, setTopics] = useState<string[]>([]);
  const [survey, setSurvey] = useState<string>();
  const [formats, setFormats] = useState<KitFormat[]>(['post']);
  const [audience, setAudience] = useState('');
  const [cpm, setCpm] = useState('');

  useEffect(() => {
    (async () => {
      const [kits, surveys] = await Promise.all([
        query({ kinds: [KIND.mediaKit], authors: [account.pubkey], limit: 1 }, 3000),
        query({ kinds: [KIND.survey], authors: [account.pubkey], limit: 1 }, 3000),
      ]);
      setSurvey(surveys.sort((a: Event, b: Event) => b.created_at - a.created_at)[0]?.id);
      const kit = kits[0] && parseMediaKit(kits[0], await pqKeys([account.pubkey]));
      if (!kit) return;
      setPitch(kit.pitch);
      setRate(formatUsd(priceNow(kit.rate, index).amount));
      setTopics(kit.topics);
      if (kit.formats?.length) setFormats(kit.formats);
      setAudience(kit.audience ? String(kit.audience) : '');
      setCpm(kit.cpm ? formatUsd(kit.cpm) : '');
    })().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.pubkey]);

  async function publishKit() {
    try {
      await publish(createMediaKit(account.nostrKey, account.pq, {
        pitch, rate: newPrice(parseUsd(rate), index), topics, survey, formats, audience: Number(audience) || undefined, cpm: cpm ? parseUsd(cpm) : undefined,
      }));
      toast('You’re listed. Advertisers can now find you and send offers.');
      navigate('/create');
    } catch (e) {
      toast((e as Error).message);
    }
  }

  const allTopics = [...new Set([...STARTER_TOPICS.map((t) => t.tags[0]), ...topics])];
  return (
    <>
      <TopBar title="Media kit" back={() => navigate('/create')} />
      <div className="page">
        <p className="muted">List yourself for advertisers: what you make, your rate per sponsored post, and (if you’ve run one) your anonymous audience survey.</p>
        <Field label="About your content"><textarea value={pitch} onChange={(e) => setPitch(e.target.value)} placeholder="Weekly trail-running videos and honest gear reviews." /></Field>
        <div className="stack">
          <strong className="small">What you offer sponsors</strong>
          <div className="chips">
            {([['post', 'Sponsored posts'], ['podcast', 'Podcast host-reads'], ['video', 'Video host-reads']] as [KitFormat, string][]).map(([f, label]) => (
              <button key={f} type="button" className="chip" aria-pressed={formats.includes(f)} onClick={() => setFormats(formats.includes(f) ? formats.filter((x) => x !== f) : [...formats, f])}>{label}</button>
            ))}
          </div>
        </div>
        <Field label="Rate per sponsored post ($)"><input type="text" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
        {formats.some((f) => f !== 'post') && (
          <div className="row wrap">
            <Field label="Typical listens or views per episode" hint="Be honest: sponsors compare it with what your promo codes bring in."><input type="number" min={0} value={audience} onChange={(e) => setAudience(e.target.value)} /></Field>
            <Field label="Price per 1,000 ($)" hint="Host-reads usually go for $15 to $50; about $25 is typical."><input type="text" inputMode="decimal" value={cpm} onChange={(e) => setCpm(e.target.value)} placeholder="25" /></Field>
          </div>
        )}
        <div className="stack">
          <strong className="small">Topics</strong>
          <div className="chips">
            {allTopics.map((t) => (
              <button key={t} type="button" className="chip" aria-pressed={topics.includes(t)} onClick={() => setTopics(topics.includes(t) ? topics.filter((x) => x !== t) : [...topics, t])}>#{t}</button>
            ))}
          </div>
        </div>
        <p className="small muted">{survey ? 'Your latest audience survey will be linked.' : 'Tip: run an audience survey so advertisers can see who you reach.'}</p>
        <button type="button" className="btn primary block" disabled={!pitch || !rate} onClick={publishKit}>Publish media kit</button>
      </div>
    </>
  );
}
