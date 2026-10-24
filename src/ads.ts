/**
 * Host-read ads with dynamic insertion, for audio and video.
 *
 * An advertiser plans a campaign (kind 33479): the goal, the offer and promo code, talking points, formats, audience,
 * budget, dates and brand-safety exclusions. Each creator they want gets an offer (sponsorship.ts) carrying the
 * campaign's terms. A creator who accepts records the read in their own voice and publishes a placement (kind 33480):
 * the recording, the slots it plays in (pre-, mid- or post-roll), the dates it runs and which shows or videos it runs
 * on. If the offer asked for it, the advertiser approves that exact recording (kind 3481) before it plays.
 *
 * Insertion is dynamic: nothing is baked into the episode. Fairground's players insert the read while it plays, and a
 * podcast gateway stitches it into downloads for Apple Podcasts, Spotify and other apps. So a read can run across a
 * creator's whole back catalogue, starts and stops on its dates, and is replaced when the next sponsor comes along.
 */
import { finalizeEvent, verifyEvent, type Event } from 'nostr-tools/pure';
import { KIND } from './kinds.ts';
import { signHybrid, verifyHybrid, verifyPq, type KeyLookup, type PqKeys } from './pq.ts';
import { acceptedOffer, parseOffer, type Offer } from './sponsorship.ts';
import type { BreakMark } from './podcast.ts';
import { markedEvent, now, tag, tagValue } from './tags.ts';

export type Slot = 'pre' | 'mid' | 'post';
export const SLOTS: Slot[] = ['pre', 'mid', 'post'];
export type AdFormat = 'host-read' | 'post';
export type Objective = 'awareness' | 'consideration' | 'conversions';

/** Content categories an advertiser can keep their ads away from (after the GARM brand-safety framework). */
export const BRAND_SAFETY: Record<string, string> = {
  adult: 'Adult and explicit content',
  violence: 'Violence, weapons and crime',
  drugs: 'Drugs, alcohol and tobacco',
  politics: 'Politics and elections',
  religion: 'Religion',
  tragedy: 'Death, injury and tragedy',
  profanity: 'Strong language',
  gambling: 'Gambling',
};

/** Typical podcast host-read prices per thousand listens: $15 to $50, around $25 on average. */
export const CPM_GUIDE = { low: 15, typical: 25, high: 50 };

export interface CampaignInput {
  slug: string;
  name: string;
  /** Anything else creators should know, in the advertiser's words. */
  brief?: string;
  objective: Objective;
  product: string;
  /** What listeners get, e.g. "20% off your first order". */
  offer?: string;
  url?: string;
  /** The base promo code; each creator gets their own, so results can be counted per creator. */
  promo?: string;
  points: string[];
  avoid: string[];
  formats: AdFormat[];
  media: ('audio' | 'video')[];
  slots: Slot[];
  start: number;
  end: number;
  /** Micro-dollars. */
  budget: bigint;
  /** Target price per thousand, micro-dollars. */
  cpm: bigint;
  topics: string[];
  regions: string[];
  languages: string[];
  exclude: string[];
  /** Whether the advertiser approves each read before it plays. */
  approval: boolean;
  created_at?: number;
}

export interface Campaign extends Omit<CampaignInput, 'created_at'> {
  event: Event;
  advertiser: string;
  address: string;
}

export const campaignAddress = (advertiser: string, slug: string) => `${KIND.campaign}:${advertiser}:${slug}`;

/** A campaign is the advertiser's own plan. Offers made from it are the contracts, so it needs only a Nostr signature. */
export function createCampaign(nostrKey: Uint8Array, c: CampaignInput): Event {
  if (c.end <= c.start) throw new Error('a campaign must end after it starts');
  const tags = [
    ['d', c.slug],
    ['title', c.name],
    ['objective', c.objective],
    ['product', c.product],
    ['flight', String(c.start), String(c.end)],
    ['budget', c.budget.toString()],
    ['cpm', c.cpm.toString()],
    ...c.formats.map((f) => ['format', f]),
    ...c.media.map((m) => ['media', m]),
    ...c.slots.map((s) => ['slot', s]),
    ...c.points.map((p) => ['point', p]),
    ...c.avoid.map((a) => ['avoid', a]),
    ...c.topics.map((t) => ['t', t.toLowerCase()]),
    ...c.regions.map((r) => ['region', r]),
    ...c.languages.map((l) => ['language', l]),
    ...c.exclude.map((x) => ['exclude', x]),
  ];
  if (c.offer) tags.push(['offer', c.offer]);
  if (c.url) tags.push(['r', c.url]);
  if (c.promo) tags.push(['code', c.promo]);
  if (c.approval) tags.push(['approval', 'read']);
  return finalizeEvent({ kind: KIND.campaign, created_at: c.created_at ?? now(), content: c.brief ?? '', tags }, nostrKey);
}

const values = (ev: Event, name: string) => ev.tags.filter((t) => t[0] === name && t[1]).map((t) => t[1]);
const micros = (v?: string) => (v && /^\d+$/.test(v) ? BigInt(v) : 0n);

export function parseCampaign(ev: Event): Campaign | undefined {
  const slug = tagValue(ev, 'd');
  const name = tagValue(ev, 'title');
  const [, start, end] = tag(ev, 'flight') ?? [];
  const objective = tagValue(ev, 'objective');
  if (ev.kind !== KIND.campaign || !slug || !name || !start || !end || !verifyEvent(ev)) return undefined;
  return {
    event: ev,
    advertiser: ev.pubkey,
    address: campaignAddress(ev.pubkey, slug),
    slug,
    name,
    brief: ev.content || undefined,
    objective: objective === 'awareness' || objective === 'consideration' ? objective : 'conversions',
    product: tagValue(ev, 'product') ?? name,
    offer: tagValue(ev, 'offer'),
    url: tagValue(ev, 'r'),
    promo: tagValue(ev, 'code'),
    points: values(ev, 'point'),
    avoid: values(ev, 'avoid'),
    formats: values(ev, 'format').filter((f): f is AdFormat => f === 'host-read' || f === 'post'),
    media: values(ev, 'media').filter((m): m is 'audio' | 'video' => m === 'audio' || m === 'video'),
    slots: values(ev, 'slot').filter((s): s is Slot => SLOTS.includes(s as Slot)),
    start: Number(start),
    end: Number(end),
    budget: micros(tagValue(ev, 'budget')),
    cpm: micros(tagValue(ev, 'cpm')),
    topics: values(ev, 't'),
    regions: values(ev, 'region'),
    languages: values(ev, 'language'),
    exclude: values(ev, 'exclude'),
    approval: tagValue(ev, 'approval') === 'read',
  };
}

/** A creator's own promo code for a campaign, so the advertiser can count what each creator brought in. */
export function promoCodeFor(base: string, creatorName: string): string {
  const name = creatorName.normalize('NFKD').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10) || 'FG';
  return `${base.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}${name}`;
}

/** The landing page with UTM parameters naming Fairground, the campaign and the creator. */
export function trackedUrl(url: string, campaign: string, creator: string): string {
  const u = new URL(url);
  u.searchParams.set('utm_source', 'fairground');
  u.searchParams.set('utm_medium', 'host-read');
  u.searchParams.set('utm_campaign', campaign);
  u.searchParams.set('utm_content', creator.slice(0, 12));
  return u.toString();
}

/**
 * How many listens a budget buys at a price per thousand, and how to spread it. Podcast tests work best across several
 * shows with several insertions each, rather than one big buy.
 */
export function planBudget(budget: bigint, cpm: bigint, creators: number): { impressions: number; perCreator: bigint; warning?: string } {
  const impressions = cpm > 0n ? Number((budget * 1000n) / cpm) : 0;
  const perCreator = creators > 0 ? budget / BigInt(creators) : budget;
  let warning: string | undefined;
  if (creators > 0 && creators < 3) warning = 'Spread a test across at least three creators, so one show’s fit doesn’t decide the result.';
  else if (impressions < 10_000) warning = 'This buys fewer than 10,000 listens; results may be too small to read.';
  return { impressions, perCreator, warning };
}

export interface Spot {
  url: string;
  /** MIME type: audio/* plays in audio and video, video/* only in video. */
  type: string;
  duration?: number;
  /** MP3 frame layout, which lets a gateway stitch the read into MP3 downloads. */
  mp3?: { version: 1 | 2 | 2.5; sampleRate: number; channels: 1 | 2; audioStart: number; audioEnd: number };
}

export interface PlacementInput {
  acceptance: Event;
  slots: Slot[];
  start: number;
  end: number;
  /** Shows the read plays on (`33478:…` addresses); every show when empty. */
  shows: string[];
  /** Whether it also plays on the creator's videos. */
  video: boolean;
  spots: Spot[];
  /** The disclosure shown while it plays, e.g. "Sponsored by Acme". */
  label: string;
  link?: string;
  code?: string;
  /** The words of the read, for the advertiser's approval and for transparency. */
  script?: string;
  created_at?: number;
}

export interface Placement extends Omit<PlacementInput, 'acceptance' | 'created_at'> {
  event: Event;
  creator: string;
  advertiser: string;
  acceptanceId: string;
  address: string;
}

export const placementAddress = (creator: string, acceptanceId: string) => `${KIND.placement}:${creator}:${acceptanceId}`;

const spotTag = (s: Spot) => ['spot', s.url, s.type, s.duration ? s.duration.toFixed(3) : '',
  ...(s.mp3 ? [String(s.mp3.version), String(s.mp3.sampleRate), String(s.mp3.channels), String(s.mp3.audioStart), String(s.mp3.audioEnd)] : [])];

function parseSpot(t: string[]): Spot | undefined {
  const [, url, type, duration, version, sampleRate, channels, audioStart, audioEnd] = t;
  if (!url?.startsWith('https://') || !/^(audio|video)\//.test(type ?? '') && !/mpegurl/i.test(type ?? '')) return undefined;
  const spot: Spot = { url, type, duration: Number(duration) > 0 ? Number(duration) : undefined };
  const mp3 = [version, sampleRate, channels, audioStart, audioEnd].map(Number);
  if (version && [1, 2, 2.5].includes(mp3[0]) && mp3[1] > 0 && (mp3[2] === 1 || mp3[2] === 2) && Number.isSafeInteger(mp3[3]) && mp3[4] > mp3[3]) {
    spot.mp3 = { version: mp3[0] as 1 | 2 | 2.5, sampleRate: mp3[1], channels: mp3[2] as 1 | 2, audioStart: mp3[3], audioEnd: mp3[4] };
  }
  return spot;
}

/** The creator's placement for a deal; replaceable, one per acceptance. It is the deal's delivery. */
export function createPlacement(nostrKey: Uint8Array, p: PlacementInput, pq?: PqKeys): Event {
  if (p.end <= p.start) throw new Error('a placement must end after it starts');
  if (!p.spots.length || !p.slots.length) throw new Error('a placement needs a recording and at least one slot');
  if (!/sponsor|paid|\bad\b/i.test(p.label)) throw new Error('the label must disclose the sponsorship, e.g. “Sponsored by …”');
  const tags = [
    ['d', p.acceptance.id],
    ['e', p.acceptance.id, '', 'sponsorship'],
    ['p', tagValue(p.acceptance, 'p') ?? ''],
    ['flight', String(p.start), String(p.end)],
    ['label', p.label],
    ...p.slots.map((s) => ['slot', s]),
    ...p.shows.map((a) => ['a', a]),
    ...p.spots.map(spotTag),
    ['t', 'ad'],
  ];
  if (p.video) tags.push(['scope', 'video']);
  if (p.link) tags.push(['r', p.link]);
  if (p.code) tags.push(['code', p.code]);
  const template = { kind: KIND.placement, created_at: p.created_at ?? now(), content: p.script ?? '', tags };
  return pq ? signHybrid(template, nostrKey, pq) : finalizeEvent(template, nostrKey);
}

export function parsePlacement(ev: Event): Placement | undefined {
  const acceptanceId = markedEvent(ev, 'sponsorship');
  const [, start, end] = tag(ev, 'flight') ?? [];
  const label = tagValue(ev, 'label');
  const advertiser = tagValue(ev, 'p');
  if (ev.kind !== KIND.placement || !acceptanceId || tagValue(ev, 'd') !== acceptanceId || !label || !advertiser || !start || !end) return undefined;
  const spots = ev.tags.filter((t) => t[0] === 'spot').map(parseSpot).filter((s): s is Spot => !!s);
  const slots = values(ev, 'slot').filter((s): s is Slot => SLOTS.includes(s as Slot));
  if (!spots.length || !slots.length) return undefined;
  return {
    event: ev,
    creator: ev.pubkey,
    advertiser,
    acceptanceId,
    address: placementAddress(ev.pubkey, acceptanceId),
    slots,
    start: Number(start),
    end: Number(end),
    shows: values(ev, 'a'),
    video: values(ev, 'scope').includes('video'),
    spots,
    label,
    link: tagValue(ev, 'r'),
    code: tagValue(ev, 'code'),
    script: ev.content || undefined,
  };
}

/** Checks a placement as a deal's delivery: by the creator, for this acceptance, disclosed, within the window. */
export function placementProblem(ev: Event, acceptance: Event, offer: Offer, pqKeyOf: KeyLookup): string | undefined {
  const p = parsePlacement(ev);
  if (!p || !verifyEvent(ev)) return 'placement is malformed or badly signed';
  if (ev.tags.some((t) => t[0] === 'pq')) {
    const key = pqKeyOf(ev.pubkey);
    if (!key || !verifyPq(ev, key)) return 'placement has an invalid post-quantum signature';
  }
  if (p.creator !== acceptance.pubkey) return 'placement is by someone other than the creator';
  if (p.acceptanceId !== acceptance.id) return 'placement doesn’t reference the acceptance';
  if (p.advertiser !== offer.advertiser) return 'placement names a different advertiser';
  if (ev.created_at < acceptance.created_at || ev.created_at > offer.deadline) return 'placed outside the agreed window';
  const terms = offer.terms;
  if (terms?.flight && (p.start < terms.flight.start - 86400 || p.end > terms.flight.end + 86400)) return 'placement runs outside the campaign dates';
  if (terms?.slots.length && !p.slots.every((s) => terms.slots.includes(s))) return 'placement uses slots the offer didn’t include';
}

export type ApprovalStatus = 'approved' | 'changes';

/** The advertiser's answer to one exact version of a read. */
export function createApproval(nostrKey: Uint8Array, pq: PqKeys, placement: Event, status: ApprovalStatus, note = '', created_at = now()): Event {
  const tags = [['e', placement.id, '', 'placement'], ['a', `${KIND.placement}:${placement.pubkey}:${tagValue(placement, 'd')}`], ['p', placement.pubkey], ['status', status]];
  return signHybrid({ kind: KIND.approval, created_at, content: note, tags }, nostrKey, pq);
}

/** The advertiser's newest verdict on this exact version of the placement, if any. */
export function approvalOf(placement: Placement, approvals: Event[], pqKeyOf: KeyLookup): ApprovalStatus | undefined {
  const key = pqKeyOf(placement.advertiser);
  const mine = approvals
    .filter((a) => a.kind === KIND.approval && a.pubkey === placement.advertiser && markedEvent(a, 'placement') === placement.event.id)
    .filter((a) => key && verifyHybrid(a, key))
    .sort((a, b) => b.created_at - a.created_at);
  const status = mine[0] && tagValue(mine[0], 'status');
  return status === 'approved' || status === 'changes' ? status : undefined;
}

/** What to play in one break. */
export interface AdBreak {
  slot: Slot;
  /** Seconds into the content: 0 for a pre-roll, the content's length (or Infinity) for a post-roll. */
  at: number;
  byteOffset?: number;
  ads: { placement: Placement; spot: Spot }[];
}

export interface PlayableMedia {
  creator: string;
  kind: 'audio' | 'video';
  /** The show an episode belongs to. */
  show?: string;
  duration?: number;
  marks: BreakMark[];
}

export interface BreakContext {
  now?: number;
  /** Acceptances the placements reference, to read the offer's terms (such as whether the read needs approval). */
  acceptances: Event[];
  approvals: Event[];
  pqKeyOf: KeyLookup;
}

/** Ads per break; more than this and listeners skip. */
export const MAX_ADS_PER_BREAK = 3;

/** Whether a placement may play now: in its dates, with a real deal behind it, and approved if the deal requires it. */
export function isLive(p: Placement, ctx: BreakContext): boolean {
  const t = ctx.now ?? now();
  if (t < p.start || t >= p.end) return false;
  const acceptance = ctx.acceptances.find((a) => a.id === p.acceptanceId && a.pubkey === p.creator && a.kind === KIND.acceptance);
  const embedded = acceptance && acceptedOffer(acceptance);
  const offer = embedded && parseOffer(embedded);
  if (!offer || offer.advertiser !== p.advertiser) return false;
  const verdict = approvalOf(p, ctx.approvals, ctx.pqKeyOf);
  if (verdict === 'changes') return false;
  return !offer.terms?.approval || verdict === 'approved';
}

/** The ad breaks for one episode or video right now. Each placement plays once per slot; mid-rolls need a mark. */
export function breaksFor(media: PlayableMedia, placements: Placement[], ctx: BreakContext): AdBreak[] {
  const live = placements
    .filter((p) => p.creator === media.creator && isLive(p, ctx))
    .filter((p) => (media.kind === 'video' ? p.video : !p.shows.length || (media.show !== undefined && p.shows.includes(media.show))))
    .sort((a, b) => a.start - b.start || (a.event.id < b.event.id ? -1 : 1));
  const spotFor = (p: Placement) =>
    media.kind === 'video' ? p.spots.find((s) => s.type.startsWith('video/')) ?? p.spots.find((s) => s.type.startsWith('audio/')) : p.spots.find((s) => s.type.startsWith('audio/'));
  const ads = (slot: Slot) => live.filter((p) => p.slots.includes(slot) && spotFor(p)).slice(0, MAX_ADS_PER_BREAK).map((p) => ({ placement: p, spot: spotFor(p)! }));
  const breaks: AdBreak[] = [];
  const pre = ads('pre');
  if (pre.length) breaks.push({ slot: 'pre', at: 0, ads: pre });
  const mid = ads('mid');
  if (mid.length) for (const m of media.marks) breaks.push({ slot: 'mid', at: m.at, byteOffset: m.byteOffset, ads: mid });
  const post = ads('post');
  if (post.length) breaks.push({ slot: 'post', at: media.duration ?? Infinity, ads: post });
  return breaks;
}
