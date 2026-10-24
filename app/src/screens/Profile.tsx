import { useEffect, useState } from 'react';
import { finalizeEvent, type Event } from 'nostr-tools/pure';
import { KIND } from '@core/kinds.ts';
import { parseMediaKit, type MediaKit } from '@core/mediakit.ts';
import { MEMO } from '@core/memos.ts';
import { parseUsd } from '@core/pricing.ts';
import { algorandUsdc } from '@core/rails/algorand.ts';
import { brokenPledges, fetchSupport, monthSupport, parseSupportPage, periodOf, previousPeriod, type SupportPage } from '@core/support.ts';
import { PayDialog } from '../components/PayDialog.tsx';
import { PostCard } from '../components/PostCard.tsx';
import { Avatar, Field, Meter, Name, Sheet, TopBar } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { pqKeys, priceNow, useIndex } from '../lib/data.ts';
import { setFollowing } from '../lib/feedEngine.ts';
import { nowSeconds, shortKey, usd } from '../lib/format.ts';
import { rememberProfile, useEvents, useProfile } from '../lib/hooks.ts';
import { publish, query } from '../lib/net.ts';
import { load, save } from '../lib/storage.ts';

export interface Supporting {
  creator: string;
  amount: string;
  period: string;
}

export function SupportSheet({ page, onClose }: { page: SupportPage; onClose: () => void }) {
  const { toast } = useApp();
  const index = useIndex();
  const suggested = priceNow(page.suggested, index).amount;
  const goal = page.goal !== undefined ? priceNow({ ...page.suggested, amount: page.goal }, index).amount : undefined;
  const [month, setMonth] = useState<{ total: bigint; supporters: number }>();
  const [pledgeKept, setPledgeKept] = useState<boolean>();
  const [amount, setAmount] = useState(suggested);
  const [custom, setCustom] = useState('');
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    const period = periodOf(nowSeconds());
    fetchSupport(page, algorandUsdc, period).then((t) => setMonth(monthSupport(period, t, goal)), () => undefined);
    if (page.adFree && goal !== undefined) {
      (async () => {
        const last = previousPeriod(period);
        const lastMonth = monthSupport(last, await fetchSupport(page, algorandUsdc, last), goal);
        const acceptances = await query({ kinds: [KIND.acceptance], authors: [page.creator], since: nowSeconds() - 62 * 86400 }, 3000);
        setPledgeKept(brokenPledges(page, [lastMonth], acceptances).length === 0);
      })().catch(() => undefined);
    }
  }, [page, goal]);

  useEffect(() => setAmount(suggested), [suggested]);

  if (paying) {
    return (
      <PayDialog
        title="Support this creator"
        description="All of it goes to the creator. Nothing links this payment to your Fairground account."
        request={{ to: page.payTo, amount, memo: MEMO.support(page.creator) }}
        onClose={onClose}
        onPaid={(t) => {
          const list = load<Supporting[]>('supporting', []).filter((s) => s.creator !== page.creator);
          save('supporting', [...list, { creator: page.creator, amount: t.amount.toString(), period: periodOf(t.time) }]);
          toast('Thank you for supporting them.');
          onClose();
        }}
      />
    );
  }

  return (
    <Sheet title={page.title} onClose={onClose}>
      <p>{page.pitch}</p>
      {month && goal !== undefined && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="row between small"><span>{usd(month.total)} of {usd(goal)} this month</span><span className="muted">{month.supporters} supporters</span></div>
          <Meter fraction={Number(month.total) / Number(goal || 1n)} />
        </div>
      )}
      {page.adFree && (
        <p className="small">
          Ad-free pledge: after a month when supporters meet the goal, no sponsorships the next month.
          {pledgeKept === true && <span className="good"> Kept so far.</span>}
          {pledgeKept === false && <span className="bad"> Broken last month.</span>}
        </p>
      )}
      <div className="chips">
        {[suggested, suggested * 2n, suggested * 5n].map((a) => (
          <button key={a.toString()} type="button" className="chip" aria-pressed={amount === a && !custom} onClick={() => (setAmount(a), setCustom(''))}>{usd(a)}</button>
        ))}
      </div>
      <Field label="Or another amount"><input type="text" inputMode="decimal" value={custom} placeholder="10.00" onChange={(e) => {
        setCustom(e.target.value);
        try {
          setAmount(parseUsd(e.target.value));
        } catch {
          // Keep the last valid amount while typing.
        }
      }} /></Field>
      <button type="button" className="btn primary block" disabled={amount <= 0n} onClick={() => setPaying(true)}>Support with {usd(amount)} this month</button>
      <p className="tiny muted">Paid directly to the creator in USDC. Monthly support is a payment you make each month; nothing renews automatically.</p>
    </Sheet>
  );
}

function EditProfile({ onClose }: { onClose: () => void }) {
  const { account, toast } = useApp();
  const profile = useProfile(account.pubkey);
  const [name, setName] = useState(profile?.name ?? '');
  const [about, setAbout] = useState(profile?.about ?? '');
  const [picture, setPicture] = useState(profile?.picture ?? '');
  async function saveProfile() {
    const ev = finalizeEvent({ kind: 0, created_at: nowSeconds(), tags: [], content: JSON.stringify({ name, display_name: name, about, picture: picture || undefined }) }, account.nostrKey);
    try {
      await publish(ev);
      rememberProfile(ev);
      toast('Profile saved');
      onClose();
    } catch (e) {
      toast((e as Error).message);
    }
  }
  return (
    <Sheet title="Your profile" onClose={onClose}>
      <Field label="Name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></Field>
      <Field label="About"><textarea value={about} onChange={(e) => setAbout(e.target.value)} maxLength={600} /></Field>
      <Field label="Photo link" hint="An https:// link to an image."><input type="url" value={picture} onChange={(e) => setPicture(e.target.value)} /></Field>
      <button type="button" className="btn primary block" disabled={!name.trim()} onClick={saveProfile}>Save</button>
    </Sheet>
  );
}

export function useEditProfile() {
  const [open, setOpen] = useState(false);
  return { open: () => setOpen(true), sheet: open ? <EditProfile onClose={() => setOpen(false)} /> : null };
}

export function Profile({ pubkey }: { pubkey: string }) {
  const { account, navigate, toast } = useApp();
  const profile = useProfile(pubkey);
  const mine = pubkey === account.pubkey;
  const index = useIndex();
  const [follows, setFollows] = useState(() => new Set(load<string[]>('follows', [])));
  const [page, setPage] = useState<SupportPage>();
  const [kit, setKit] = useState<MediaKit>();
  const [supporting, setSupporting] = useState(false);
  const edit = useEditProfile();
  const { events: posts, loading } = useEvents({ kinds: [1], authors: [pubkey], limit: 40 });
  const topLevel = posts.filter((p: Event) => !p.tags.some((t) => t[0] === 'e' && (!t[3] || t[3] === 'reply' || t[3] === 'root')));

  useEffect(() => {
    (async () => {
      const [pages, kits] = await Promise.all([
        query({ kinds: [KIND.supportPage], authors: [pubkey], limit: 1 }, 3000),
        query({ kinds: [KIND.mediaKit], authors: [pubkey], limit: 1 }, 3000),
      ]);
      const lookup = await pqKeys([pubkey]);
      const newest = (list: Event[]) => list.sort((a, b) => b.created_at - a.created_at)[0];
      setPage(pages.length ? parseSupportPage(newest(pages), lookup) : undefined);
      setKit(kits.length ? parseMediaKit(newest(kits), lookup) : undefined);
    })().catch(() => undefined);
  }, [pubkey]);

  async function toggleFollow() {
    try {
      setFollows(await setFollowing(account, pubkey, !follows.has(pubkey)));
    } catch (e) {
      toast((e as Error).message);
    }
  }

  return (
    <>
      <TopBar title={<Name pubkey={pubkey} />} back={() => history.back()} />
      <div className="page">
        <div className="row">
          <Avatar pubkey={pubkey} large />
          <div className="grow">
            <h2 style={{ margin: 0, fontSize: 22 }}><Name pubkey={pubkey} /></h2>
            <p className="tiny muted mono" style={{ margin: 0 }}>{shortKey(pubkey)}</p>
          </div>
        </div>
        {profile?.about && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{profile.about}</p>}
        <div className="row wrap">
          {mine ? (
            <button type="button" className="btn" onClick={edit.open}>Edit profile</button>
          ) : (
            <>
              <button type="button" className={`btn${follows.has(pubkey) ? '' : ' primary'}`} onClick={toggleFollow}>{follows.has(pubkey) ? 'Following' : 'Follow'}</button>
              {page && <button type="button" className="btn" onClick={() => setSupporting(true)}>Support</button>}
              <button type="button" className="btn" onClick={() => navigate(`/promote?to=${pubkey}`)}>Sponsor</button>
            </>
          )}
        </div>
        {kit && (
          <div className="card small">
            <strong>Open to sponsorships</strong> · {usd(priceNow(kit.rate, index).amount)} per post
            {kit.topics.length > 0 && <span className="muted"> · {kit.topics.map((t) => `#${t}`).join(' ')}</span>}
            <p className="muted">{kit.pitch}</p>
          </div>
        )}
      </div>
      {loading && !posts.length && <div className="skeleton" />}
      {topLevel.map((p) => <PostCard key={p.id} post={p} />)}
      {!loading && !topLevel.length && <p className="center muted">{mine ? 'Your posts will show here.' : 'No posts yet.'}</p>}
      {supporting && page && <SupportSheet page={page} onClose={() => setSupporting(false)} />}
      {edit.sheet}
    </>
  );
}
