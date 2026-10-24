/**
 * Campaigns: how an advertiser plans a host-read campaign, finds the right creators, approves their reads and sees
 * what it returned. The guidance follows how podcast advertising works in practice: fit between product, audience and
 * host; tests spread across several shows with several insertions each; CPMs around $25; a promo code and tracked
 * link per creator so results can be counted; and the host liking the product enough to read it in their own words.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Event } from 'nostr-tools/pure';
import {
  BRAND_SAFETY,
  CPM_GUIDE,
  createApproval,
  createCampaign,
  parseCampaign,
  planBudget,
  promoCodeFor,
  SLOTS,
  trackedUrl,
  type AdFormat,
  type Campaign,
  type Objective,
  type Placement,
  type Slot,
} from '@core/ads.ts';
import { STARTER_TOPICS } from '@core/feed.ts';
import { KIND } from '@core/kinds.ts';
import { insertionPrice, parseMediaKit, type MediaKit } from '@core/mediakit.ts';
import { MEMO } from '@core/memos.ts';
import { formatUsd, parseUsd } from '@core/pricing.ts';
import { RAIL } from '@core/rails/algorand.ts';
import { acceptedOffer, createOffer, createPaymentReceipt, parseOffer, type Offer } from '@core/sponsorship.ts';
import { markedEvent, tag, tagValue } from '@core/tags.ts';
import { DonationSheet } from '../components/DonationSheet.tsx';
import { PayDialog } from '../components/PayDialog.tsx';
import { Field, Name, Sheet, TopBar } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { loadPlacements } from '../lib/ads.ts';
import { newPrice, pqKeys, priceNow, useIndex } from '../lib/data.ts';
import { nowSeconds, usd } from '../lib/format.ts';
import { getProfile, useEvents } from '../lib/hooks.ts';
import { useMembership } from '../lib/members.ts';
import { publish } from '../lib/net.ts';
import { load, save } from '../lib/storage.ts';

export const campaignPath = (slug: string) => `/promote/campaign/${slug}`;
const DAY = 86400;
const dateInput = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const fromDate = (d: string) => Math.floor(new Date(`${d}T00:00:00`).getTime() / 1000);
const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

const OBJECTIVES: [Objective, string, string][] = [
  ['conversions', 'Sales and sign-ups', 'Direct response: a clear offer, a promo code and a link, measured by what they bring in.'],
  ['consideration', 'Consideration', 'For bigger or considered purchases: the host explains why it’s worth a look.'],
  ['awareness', 'Awareness', 'Get the name known: more reach, more repetition, fewer demands on the listener.'],
];

const FORMAT_LABELS: Record<string, string> = { podcast: 'Podcast host-reads', video: 'Video host-reads', post: 'Sponsored posts' };

export function CampaignBuilder() {
  const { account, navigate, toast } = useApp();
  const [name, setName] = useState('');
  const [objective, setObjective] = useState<Objective>('conversions');
  const [product, setProduct] = useState('');
  const [offer, setOffer] = useState('');
  const [url, setUrl] = useState('');
  const [promo, setPromo] = useState('');
  const [brief, setBrief] = useState('');
  const [points, setPoints] = useState('');
  const [avoid, setAvoid] = useState('');
  const [media, setMedia] = useState<('audio' | 'video')[]>(['audio']);
  const [posts, setPosts] = useState(false);
  const [slots, setSlots] = useState<Slot[]>(['pre', 'mid']);
  const [topics, setTopics] = useState<string[]>([]);
  const [regions, setRegions] = useState('');
  const [languages, setLanguages] = useState('en');
  const [budget, setBudget] = useState('5000');
  const [cpm, setCpm] = useState(String(CPM_GUIDE.typical));
  const [creators, setCreators] = useState('4');
  const [start, setStart] = useState(dateInput(nowSeconds() + 7 * DAY));
  const [end, setEnd] = useState(dateInput(nowSeconds() + 35 * DAY));
  const [exclude, setExclude] = useState<string[]>(['adult']);
  const [approval, setApproval] = useState(true);
  const [busy, setBusy] = useState(false);

  let plan: ReturnType<typeof planBudget> | undefined;
  try {
    plan = planBudget(parseUsd(budget || '0'), parseUsd(cpm || '0'), Number(creators) || 0);
  } catch {
    plan = undefined;
  }
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  async function save() {
    setBusy(true);
    try {
      const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'campaign'}-${Math.random().toString(36).slice(2, 6)}`;
      const formats: AdFormat[] = [...(media.length ? ['host-read' as const] : []), ...(posts ? ['post' as const] : [])];
      await publish(createCampaign(account.nostrKey, {
        slug, name: name.trim(), brief: brief.trim() || undefined, objective, product: product.trim(), offer: offer.trim() || undefined,
        url: url.trim() || undefined, promo: promo.trim() || undefined, points: lines(points), avoid: lines(avoid), formats, media, slots,
        start: fromDate(start), end: fromDate(end) + DAY, budget: parseUsd(budget), cpm: parseUsd(cpm), topics,
        regions: regions.split(',').map((r) => r.trim().toUpperCase()).filter(Boolean), languages: languages.split(',').map((l) => l.trim().toLowerCase()).filter(Boolean),
        exclude, approval,
      }));
      toast('Campaign saved. Now pick the creators.');
      navigate(campaignPath(slug));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const ready = name.trim() && product.trim() && (media.length || posts) && (!media.length || slots.length) && budget && cpm && start < end;
  return (
    <>
      <TopBar title="New campaign" back={() => history.back()} />
      <div className="page campaign-form">
        <p className="muted">Plan it once, then send each creator an offer with their own promo code and link. Creators read your ad in their own words, which
          is why host-reads work, and you approve each read before it runs.</p>

        <h2>1. Goal</h2>
        <div className="stack">
          {OBJECTIVES.map(([value, label, hint]) => (
            <label key={value} className={`card choice${objective === value ? ' on' : ''}`}>
              <input type="radio" name="objective" checked={objective === value} onChange={() => setObjective(value)} />
              <span><strong>{label}</strong><br /><span className="small muted">{hint}</span></span>
            </label>
          ))}
        </div>

        <h2>2. What you’re promoting</h2>
        <Field label="Campaign name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Fall launch" /></Field>
        <Field label="Product or service"><input type="text" value={product} onChange={(e) => setProduct(e.target.value)} placeholder="Trailhead running shoes" /></Field>
        <Field label="Offer for listeners (optional)" hint="A specific offer makes host-reads work much harder."><input type="text" value={offer} onChange={(e) => setOffer(e.target.value)} placeholder="20% off your first order" /></Field>
        <div className="row wrap">
          <Field label="Landing page"><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" /></Field>
          <Field label="Promo code base" hint="Each creator gets their own, e.g. TRAILJANE, so you can count results per creator."><input type="text" value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} placeholder="TRAIL" /></Field>
        </div>

        <h2>3. The message</h2>
        <Field label="Talking points, one per line" hint="Three or four is plenty; let hosts put them in their own words."><textarea value={points} onChange={(e) => setPoints(e.target.value)} placeholder={'Weighs under 250 g\nGrips on wet rock\nFree returns for 60 days'} /></Field>
        <Field label="Don’t say, one per line (optional)"><textarea value={avoid} onChange={(e) => setAvoid(e.target.value)} placeholder={'No medical claims\nDon’t mention competitors'} style={{ minHeight: 70 }} /></Field>
        <Field label="Anything else for creators (optional)"><textarea value={brief} onChange={(e) => setBrief(e.target.value)} style={{ minHeight: 70 }} /></Field>
        <label className="switch card"><span><strong>Approve each read before it runs</strong><br /><span className="small muted">You hear the creator’s recording first and approve it or ask for changes.</span></span>
          <input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} /></label>

        <h2>4. Where it runs</h2>
        <div className="chips">
          <button type="button" className="chip" aria-pressed={media.includes('audio')} onClick={() => setMedia(toggle(media, 'audio'))}>Podcasts</button>
          <button type="button" className="chip" aria-pressed={media.includes('video')} onClick={() => setMedia(toggle(media, 'video'))}>Videos</button>
          <button type="button" className="chip" aria-pressed={posts} onClick={() => setPosts(!posts)}>Sponsored posts</button>
        </div>
        {media.length > 0 && (
          <div className="stack">
            <span className="small"><strong>Ad slots</strong> <span className="muted">Mid-rolls hold attention best; pre-rolls reach everyone who starts.</span></span>
            <div className="chips">{SLOTS.map((s) => <button key={s} type="button" className="chip" aria-pressed={slots.includes(s)} onClick={() => setSlots(toggle(slots, s))}>{s === 'pre' ? 'Pre-roll' : s === 'mid' ? 'Mid-roll' : 'Post-roll'}</button>)}</div>
            <span className="tiny muted">Reads are inserted dynamically, into new episodes and the back catalogue, only between your dates, in Fairground and in downloads for Apple Podcasts, Spotify and other apps.</span>
          </div>
        )}

        <h2>5. Audience</h2>
        <span className="small muted">Fit matters most: product, audience and host. Don’t only match the obvious topic; audiences next door often convert better because
          competitors haven’t reached them.</span>
        <div className="chips">{STARTER_TOPICS.map((t) => <button key={t.label} type="button" className="chip" aria-pressed={topics.includes(t.tags[0])} onClick={() => setTopics(toggle(topics, t.tags[0]))}>{t.label}</button>)}</div>
        <div className="row wrap">
          <Field label="Countries (optional)" hint="Codes, e.g. US, CA"><input type="text" value={regions} onChange={(e) => setRegions(e.target.value)} /></Field>
          <Field label="Languages"><input type="text" value={languages} onChange={(e) => setLanguages(e.target.value)} /></Field>
        </div>

        <h2>6. Budget and dates</h2>
        <div className="row wrap">
          <Field label="Budget ($)"><input type="text" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} /></Field>
          <Field label="Price per 1,000 listens ($)" hint={`Podcast host-reads usually cost $${CPM_GUIDE.low}–$${CPM_GUIDE.high}; about $${CPM_GUIDE.typical} is typical.`}><input type="text" inputMode="decimal" value={cpm} onChange={(e) => setCpm(e.target.value)} /></Field>
          <Field label="Creators"><input type="number" min={1} value={creators} onChange={(e) => setCreators(e.target.value)} /></Field>
        </div>
        <div className="row wrap">
          <Field label="Starts"><input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="Ends"><input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
        </div>
        {plan && (
          <div className="card small stack" style={{ gap: 4 }}>
            <div className="row between"><span>Estimated listens</span><strong>{plan.impressions.toLocaleString()}</strong></div>
            <div className="row between"><span>Per creator</span><strong>{usd(plan.perCreator)}</strong></div>
            {plan.warning && <span className="warn">{plan.warning}</span>}
            <span className="muted">Plan to run several weeks with each creator: listeners often act on the second or third time they hear a read.</span>
          </div>
        )}

        <h2>7. Brand safety</h2>
        <span className="small muted">Creators see what you’d rather not appear next to before they accept.</span>
        <div className="chips">{Object.entries(BRAND_SAFETY).map(([k, label]) => <button key={k} type="button" className="chip" aria-pressed={exclude.includes(k)} onClick={() => setExclude(toggle(exclude, k))}>{label}</button>)}</div>

        <button type="button" className="btn primary block" disabled={!ready || busy} onClick={save}>{busy ? 'Saving…' : 'Save and find creators'}</button>
      </div>
    </>
  );
}

/** Advertiser's campaigns, newest first. */
export function useCampaigns(): Campaign[] {
  const { account } = useApp();
  const { events } = useEvents({ kinds: [KIND.campaign], authors: [account.pubkey], limit: 100 });
  return useMemo(() => {
    const byAddress = new Map<string, Campaign>();
    for (const c of events.map(parseCampaign)) if (c && (!byAddress.get(c.address) || byAddress.get(c.address)!.event.created_at < c.event.created_at)) byAddress.set(c.address, c);
    return [...byAddress.values()].sort((a, b) => b.event.created_at - a.event.created_at);
  }, [events]);
}

export function CampaignList() {
  const { navigate } = useApp();
  const campaigns = useCampaigns();
  return (
    <div className="stack">
      <button type="button" className="btn primary block" onClick={() => navigate('/promote/campaign/new')}>Plan a campaign</button>
      {!campaigns.length && <p className="small muted center">Plan a host-read campaign across several creators, or send a quick one-off offer.</p>}
      {campaigns.map((c) => (
        <button key={c.address} type="button" className="card" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => navigate(campaignPath(c.slug))}>
          <div className="row between"><strong>{c.name}</strong><span className={`badge${nowSeconds() >= c.start && nowSeconds() < c.end ? ' good' : ''}`}>{nowSeconds() < c.start ? 'Upcoming' : nowSeconds() < c.end ? 'Running' : 'Ended'}</span></div>
          <span className="small muted">{c.product} · {usd(c.budget)} · {new Date(c.start * 1000).toLocaleDateString()} to {new Date(c.end * 1000).toLocaleDateString()}</span>
        </button>
      ))}
    </div>
  );
}

function briefFor(c: Campaign): string {
  return [`${c.product}${c.offer ? `: ${c.offer}` : ''}`, c.brief].filter(Boolean).join('\n\n');
}

/** Creators who fit: listed media kits, scored by the formats and topics the campaign wants. */
function Matches({ campaign, already, onSend }: { campaign: Campaign; already: Set<string>; onSend: (picks: { kit: MediaKit; price: bigint }[]) => Promise<void> }) {
  const index = useIndex();
  const { events } = useEvents({ kinds: [KIND.mediaKit], limit: 200 });
  const members = useMembership(events.map((e) => e.pubkey));
  const [kits, setKits] = useState<MediaKit[]>([]);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    pqKeys(events.map((e) => e.pubkey)).then((lookup) => setKits(events.map((e) => parseMediaKit(e, lookup)).filter((k): k is MediaKit => !!k)), () => undefined);
  }, [events]);
  const wanted = new Set([...(campaign.media.includes('audio') ? ['podcast'] : []), ...(campaign.media.includes('video') ? ['video'] : []), ...(campaign.formats.includes('post') ? ['post'] : [])]);
  const scored = kits
    .filter((k) => members?.has(k.creator) && k.creator !== campaign.advertiser && !already.has(k.creator))
    .map((k) => {
      const formats = k.formats?.length ? k.formats : ['post'];
      const fit = formats.filter((f) => wanted.has(f)).length * 2 + k.topics.filter((t) => campaign.topics.includes(t)).length;
      const price = insertionPrice(k, campaign.cpm) ?? priceNow(k.rate, index).amount;
      return { kit: k, fit, price, formats };
    })
    .filter((x) => x.formats.some((f) => wanted.has(f)))
    .sort((a, b) => b.fit - a.fit);
  const picks = scored.filter((s) => picked[s.kit.creator] !== undefined);
  const total = picks.reduce((n, s) => n + (Number(picked[s.kit.creator]) > 0 ? parseUsd(picked[s.kit.creator]) : 0n), 0n);
  return (
    <div className="stack">
      {!scored.length && <p className="small muted">No listed creators match yet. Creators list themselves under Create → Media kit; as they do, they appear here.</p>}
      {scored.map(({ kit, price, formats }) => (
        <label key={kit.creator} className="card stack" style={{ cursor: 'pointer' }}>
          <span className="row between">
            <span className="row"><input type="checkbox" checked={picked[kit.creator] !== undefined} onChange={(e) => {
              const next = { ...picked };
              if (e.target.checked) next[kit.creator] = formatUsd(price);
              else delete next[kit.creator];
              setPicked(next);
            }} /><strong><Name pubkey={kit.creator} /></strong></span>
            <span className="small">{kit.audience ? `${kit.audience.toLocaleString()} per episode` : 'Audience not stated'}</span>
          </span>
          <span className="small" style={{ margin: 0 }}>{kit.pitch}</span>
          <span className="tiny muted">{formats.map((f) => FORMAT_LABELS[f]).join(' · ')}{kit.topics.length ? ` · ${kit.topics.map((t) => `#${t}`).join(' ')}` : ''}{kit.survey ? ' · audience survey' : ''}</span>
          {picked[kit.creator] !== undefined && (
            <Field label="Offer ($)" hint={kit.audience ? `${kit.audience.toLocaleString()} listens at ${usd(kit.cpm ?? campaign.cpm)} per thousand` : 'Their listed rate'}>
              <input type="text" inputMode="decimal" value={picked[kit.creator]} onChange={(e) => setPicked({ ...picked, [kit.creator]: e.target.value })} />
            </Field>
          )}
        </label>
      ))}
      {picks.length > 0 && (
        <button type="button" className="btn primary block" disabled={busy} onClick={async () => {
          setBusy(true);
          await onSend(picks.map((p) => ({ kit: p.kit, price: parseUsd(picked[p.kit.creator] || '0') }))).finally(() => setBusy(false));
          setPicked({});
        }}>{busy ? 'Sending…' : `Send ${picks.length} offer${picks.length > 1 ? 's' : ''} · ${usd(total)}`}</button>
      )}
    </div>
  );
}

type Stage = 'offered' | 'accepted' | 'review' | 'changes' | 'live' | 'scheduled' | 'paid';
const STAGE_LABEL: Record<Stage, string> = {
  offered: 'Offer sent', accepted: 'Recording', review: 'Read to review', changes: 'Changes asked', live: 'Running', scheduled: 'Approved', paid: 'Paid',
};

/** One creator's progress in a campaign, with what the advertiser can do next. */
function CreatorRow({ offer, acceptance, placement, approvals, receipt, onChanged }: {
  offer: Offer; acceptance?: Event; placement?: Placement; approvals: Event[]; receipt?: Event; onChanged: () => void;
}) {
  const { account, toast } = useApp();
  const index = useIndex();
  const [reviewing, setReviewing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [donation, setDonation] = useState<{ amount: bigint; receipt: Event }>();
  const [note, setNote] = useState('');
  const verdicts = placement ? approvals.filter((a) => a.pubkey === account.pubkey && markedEvent(a, 'placement') === placement.event.id).sort((a, b) => b.created_at - a.created_at) : [];
  const verdict = verdicts[0] && tagValue(verdicts[0], 'status');
  const now = nowSeconds();
  let stage: Stage = 'offered';
  if (receipt) stage = 'paid';
  else if (placement) {
    if (verdict === 'changes') stage = 'changes';
    else if (offer.terms?.approval && verdict !== 'approved') stage = 'review';
    else stage = now >= placement.start && now < placement.end ? 'live' : 'scheduled';
  } else if (acceptance) stage = 'accepted';
  const due = priceNow(offer.price, index);
  const payTo = acceptance ? tag(acceptance, 'payto')?.[2] ?? '' : '';
  const spot = placement?.spots.find((s) => s.type.startsWith('audio/')) ?? placement?.spots[0];

  async function answer(status: 'approved' | 'changes') {
    try {
      await publish(createApproval(account.nostrKey, account.pq, placement!.event, status, note.trim()));
      toast(status === 'approved' ? 'Approved. The read runs on its dates.' : 'Sent your notes to the creator.');
      setReviewing(false);
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    }
  }

  return (
    <div className="card stack">
      <div className="row between">
        <span><strong><Name pubkey={offer.creator ?? acceptance?.pubkey ?? ''} /></strong> <span className="small muted">· {usd(due.amount)}{offer.terms?.code ? ` · code ${offer.terms.code}` : ''}</span></span>
        <span className={`badge${stage === 'paid' || stage === 'live' ? ' good' : stage === 'review' || stage === 'changes' ? ' warn' : ''}`}>{STAGE_LABEL[stage]}</span>
      </div>
      {placement && (
        <div className="row wrap">
          <button type="button" className="btn small" onClick={() => setReviewing(true)}>{stage === 'review' ? 'Review the read' : 'Hear the read'}</button>
          {!receipt && stage !== 'review' && stage !== 'changes' && <button type="button" className="btn small primary" onClick={() => setPaying(true)}>Pay {usd(due.amount)}</button>}
        </div>
      )}
      {reviewing && placement && (
        <Sheet title="The read" onClose={() => setReviewing(false)}>
          {spot && (spot.type.startsWith('video/') ? <video src={spot.url} controls className="player" /> : <audio src={spot.url} controls style={{ width: '100%' }} />)}
          {placement.script && <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{placement.script}</p>}
          <p className="small muted">{placement.label} · {placement.slots.join(', ')}-roll · {new Date(placement.start * 1000).toLocaleDateString()} to {new Date(placement.end * 1000).toLocaleDateString()}
            {placement.shows.length ? ` · ${placement.shows.length} show(s)` : ' · all their shows'}{placement.video ? ' and videos' : ''}</p>
          <Field label="Notes for the creator (optional)"><textarea value={note} onChange={(e) => setNote(e.target.value)} style={{ minHeight: 70 }} /></Field>
          <button type="button" className="btn primary block" onClick={() => answer('approved')}>Approve this read</button>
          <button type="button" className="btn block" onClick={() => answer('changes')} disabled={!note.trim()}>Ask for changes</button>
        </Sheet>
      )}
      {paying && acceptance && placement && (
        <PayDialog title={`Pay for ${offer.title}`} description="This goes straight to the creator’s wallet." request={{ to: payTo, amount: due.amount, memo: MEMO.deal(acceptance.id) }}
          onClose={() => setPaying(false)}
          onPaid={async (t) => {
            setPaying(false);
            const r = createPaymentReceipt(account.nostrKey, account.pq, { acceptance, delivery: placement.event, rail: RAIL, txid: t.id, amount: t.amount, period: due.period });
            await publish(r).catch((e: Error) => toast(e.message));
            setDonation({ amount: t.amount, receipt: r });
            onChanged();
          }} />
      )}
      {donation && <DonationSheet amount={donation.amount} payment={donation.receipt} onClose={() => setDonation(undefined)} />}
    </div>
  );
}

interface Results { [creator: string]: { orders: string; revenue: string } }

export function CampaignPage({ slug }: { slug: string }) {
  const { account, navigate, toast } = useApp();
  const index = useIndex();
  const campaigns = useEvents({ kinds: [KIND.campaign], authors: [account.pubkey], '#d': [slug] });
  const campaign = useMemo(() => campaigns.events.map(parseCampaign).filter((c): c is Campaign => !!c).sort((a, b) => b.event.created_at - a.event.created_at)[0], [campaigns.events]);
  const address = campaign?.address ?? '';
  const [version, setVersion] = useState(0);
  const offerEvents = useEvents(address ? { kinds: [KIND.offer], authors: [account.pubkey], '#a': [address], limit: 200, ...(version ? { until: 4_102_444_800 + version } : {}) } : null);
  const accEvents = useEvents({ kinds: [KIND.acceptance], '#p': [account.pubkey], limit: 500 });
  const offers = useMemo(() => offerEvents.events.map(parseOffer).filter((o): o is Offer => !!o), [offerEvents.events]);
  const acceptances = useMemo(() => accEvents.events.filter((a) => {
    const o = acceptedOffer(a);
    return o && o.pubkey === account.pubkey && o.tags.some((t) => t[0] === 'a' && t[1] === address);
  }), [accEvents.events, address, account.pubkey]);
  const accIds = acceptances.map((a) => a.id);
  const receipts = useEvents(accIds.length ? { kinds: [KIND.payment], authors: [account.pubkey], '#e': accIds } : null);
  const [data, setData] = useState<{ placements: Placement[]; approvals: Event[] }>({ placements: [], approvals: [] });
  const key = accIds.join();
  useEffect(() => {
    if (!key) return;
    loadPlacements({ '#e': key.split(',') }).then(setData, () => undefined);
  }, [key, version]);
  const [results, setResults] = useState<Results>(() => load<Results>(`campaignResults:${slug}`, {}));

  if (!campaign) return <><TopBar title="Campaign" back={() => navigate('/promote')} />{campaigns.loading ? <div className="skeleton" /> : <p className="page muted">This campaign isn’t available.</p>}</>;

  async function send(picks: { kit: MediaKit; price: bigint }[]) {
    const c = campaign!;
    let sent = 0;
    for (const { kit, price } of picks) {
      // Named creators get a readable code (TRAILJANE); others a short one from their key (TRAIL3F9A).
      const p = getProfile(kit.creator);
      const creatorName = p?.display_name || p?.name || kit.creator.slice(0, 4);
      const wantsRead = c.formats.includes('host-read') && (kit.formats ?? []).some((f) => f === 'podcast' || f === 'video');
      try {
        await publish(createOffer(account.nostrKey, account.pq, {
          slug: `${c.slug}-${kit.creator.slice(0, 8)}`, title: c.name, brief: briefFor(c), price: newPrice(price, index), rail: RAIL,
          deadline: c.end, creator: kit.creator,
          terms: {
            format: wantsRead ? 'host-read' : 'post', media: c.media, slots: wantsRead ? c.slots : [], flight: { start: c.start, end: c.end },
            points: c.points, avoid: c.avoid, url: c.url ? trackedUrl(c.url, c.slug, kit.creator) : undefined,
            code: c.promo ? promoCodeFor(c.promo, creatorName) : undefined, approval: c.approval, campaign: c.address,
          },
        }));
        sent++;
      } catch (e) {
        toast((e as Error).message);
      }
    }
    toast(`Sent ${sent} offer${sent === 1 ? '' : 's'}. Creators see them in Find sponsors.`);
    setVersion((v) => v + 1);
  }

  const paid = receipts.events.reduce((n, r) => n + BigInt(tagValue(r, 'amount') ?? '0'), 0n);
  const committed = offers.reduce((n, o) => n + priceNow(o.price, index).amount, 0n);
  const orders = Object.values(results).reduce((n, r) => n + (Number(r.orders) || 0), 0);
  const revenue = Object.values(results).reduce((n, r) => n + (Number(r.revenue) || 0), 0);
  const spent = Number(paid) / 1e6;
  const setResult = (creator: string, field: 'orders' | 'revenue', value: string) => {
    const next = { ...results, [creator]: { ...(results[creator] ?? { orders: '', revenue: '' }), [field]: value } };
    setResults(next);
    save(`campaignResults:${slug}`, next);
  };

  return (
    <>
      <TopBar title={campaign.name} back={() => navigate('/promote')} />
      <div className="page">
        <div className="card stack" style={{ gap: 6 }}>
          <strong>{campaign.product}{campaign.offer ? ` · ${campaign.offer}` : ''}</strong>
          <span className="small muted">{OBJECTIVES.find((o) => o[0] === campaign.objective)?.[1]} · {new Date(campaign.start * 1000).toLocaleDateString()} to {new Date(campaign.end * 1000).toLocaleDateString()}
            {campaign.slots.length ? ` · ${campaign.slots.map((s) => `${s}-roll`).join(', ')}` : ''}{campaign.approval ? ' · you approve each read' : ''}</span>
          <div className="stats">
            <span><strong>{usd(campaign.budget)}</strong><br /><span className="tiny muted">Budget</span></span>
            <span><strong>{usd(committed)}</strong><br /><span className="tiny muted">Offered</span></span>
            <span><strong>{usd(paid)}</strong><br /><span className="tiny muted">Paid</span></span>
            <span><strong>{offers.length}</strong><br /><span className="tiny muted">Creators</span></span>
          </div>
          {committed > campaign.budget && <span className="small warn">Offers add up to more than the budget.</span>}
        </div>

        <h2>Creators</h2>
        {!offers.length && <p className="small muted">No offers yet. Pick creators below.</p>}
        {offers.map((o) => {
          const acc = acceptances.find((a) => acceptedOffer(a)?.id === o.event.id || markedEvent(a, 'offer') === o.event.id);
          return (
            <CreatorRow key={o.event.id} offer={o} acceptance={acc}
              placement={acc && data.placements.find((p) => p.acceptanceId === acc.id)} approvals={data.approvals}
              receipt={acc && receipts.events.find((r) => markedEvent(r, 'acceptance') === acc.id)} onChanged={() => setVersion((v) => v + 1)} />
          );
        })}

        <h2>Find creators</h2>
        <Matches campaign={campaign} already={new Set(offers.map((o) => o.creator ?? ''))} onSend={send} />

        <h2>Results</h2>
        <div className="card stack">
          <span className="small muted">From your store’s reports: orders that used each creator’s promo code or link. Kept on this device.</span>
          {offers.map((o) => o.creator && (
            <div key={o.creator} className="row wrap">
              <span className="grow small"><Name pubkey={o.creator} />{o.terms?.code ? <span className="muted"> · {o.terms.code}</span> : ''}</span>
              <input type="number" min={0} placeholder="Orders" aria-label="Orders" value={results[o.creator]?.orders ?? ''} onChange={(e) => setResult(o.creator!, 'orders', e.target.value)} style={{ width: 100 }} />
              <input type="number" min={0} placeholder="Revenue $" aria-label="Revenue" value={results[o.creator]?.revenue ?? ''} onChange={(e) => setResult(o.creator!, 'revenue', e.target.value)} style={{ width: 120 }} />
            </div>
          ))}
          <div className="stats">
            <span><strong>{orders}</strong><br /><span className="tiny muted">Orders</span></span>
            <span><strong>{orders && spent ? `$${(spent / orders).toFixed(2)}` : '–'}</strong><br /><span className="tiny muted">Cost per order</span></span>
            <span><strong>{spent && revenue ? `${(revenue / spent).toFixed(1)}×` : '–'}</strong><br /><span className="tiny muted">Return on spend</span></span>
          </div>
          <span className="tiny muted">Renew with the creators who performed, and give new ones a few weeks: host-reads often build over repeated listens.</span>
        </div>
      </div>
    </>
  );
}
