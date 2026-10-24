/**
 * Direct sponsorships: an advertiser's offer, a creator's acceptance, the creator's disclosed post and the advertiser's
 * payment receipt. Each step is a signed public Nostr event, so anyone can check who agreed to what and whether it was
 * paid. The project never holds or splits money: the advertiser pays the creator's own wallet.
 *
 * The offer, acceptance and receipt carry hybrid post-quantum signatures. The sponsored post is an ordinary note, so
 * every Nostr client shows it; its own post-quantum signature is optional but checked when present.
 */
import { finalizeEvent, verifyEvent, type Event } from 'nostr-tools/pure';
import { KIND } from './kinds.ts';
import { signHybrid, verifyHybrid, verifyPq, type KeyLookup, type PqKeys } from './pq.ts';
import {
  FIXED_INDEX,
  formatUsd,
  indexedAmount,
  isPeriod,
  resolvedPeriods,
  resolveIndexValue,
  type IndexedPrice,
  type IndexPolicy,
} from './pricing.ts';
import { RAILS } from './rails/index.ts';
import type { Rail } from './rails/rail.ts';
import { MEMO } from './memos.ts';
import { markedEvent, now, tag, tagValue } from './tags.ts';

/** Sponsored posts must say so (FTC Endorsement Guides, 16 CFR 255). `#ad` in the text is the required disclosure. */
export const hasDisclosure = (text: string): boolean => /(^|\s)#ad\b/i.test(text);

export interface OfferInput {
  /** Stable identifier; republishing with the same slug replaces the offer until someone accepts it. */
  slug: string;
  title: string;
  brief: string;
  price: IndexedPrice;
  rail: string;
  /** Unix seconds by which the post must be published. */
  deadline: number;
  /** Restricts the offer to one creator's pubkey; open to anyone when omitted. */
  creator?: string;
  created_at?: number;
}

export interface Offer extends Omit<OfferInput, 'created_at'> {
  event: Event;
  advertiser: string;
}

export function createOffer(nostrKey: Uint8Array, pq: PqKeys, o: OfferInput): Event {
  const { amount, currency, index, basePeriod } = o.price;
  const tags = [
    ['d', o.slug],
    ['title', o.title],
    ['price', amount.toString(), currency, index, basePeriod],
    ['rail', o.rail],
    ['deadline', String(o.deadline)],
  ];
  if (o.creator) tags.push(['p', o.creator]);
  return signHybrid({ kind: KIND.offer, created_at: o.created_at ?? now(), content: o.brief, tags }, nostrKey, pq);
}

export function parseOffer(ev: Event): Offer | undefined {
  if (ev.kind !== KIND.offer) return undefined;
  const [, amount = '', currency, index, basePeriod = ''] = tag(ev, 'price') ?? [];
  const slug = tagValue(ev, 'd');
  const title = tagValue(ev, 'title');
  const rail = tagValue(ev, 'rail');
  const deadline = Number(tagValue(ev, 'deadline'));
  if (!slug || !title || !rail || !index || currency !== 'USD' || !isPeriod(basePeriod)) return undefined;
  if (!/^[1-9]\d*$/.test(amount) || !Number.isSafeInteger(deadline)) return undefined;
  return {
    event: ev,
    advertiser: ev.pubkey,
    slug,
    title,
    brief: ev.content,
    price: { amount: BigInt(amount), currency, index, basePeriod },
    rail,
    deadline,
    creator: tagValue(ev, 'p'),
  };
}

/**
 * Accepts the exact offer event, so the advertiser can't change the terms afterwards. Relays keep only the newest
 * version of an offer, so the accepted version is embedded in the acceptance and the contract survives on its own.
 */
export function createAcceptance(nostrKey: Uint8Array, pq: PqKeys, offer: Offer, payTo: string, created_at = now()): Event {
  const tags = [
    ['e', offer.event.id, '', 'offer'],
    ['a', `${KIND.offer}:${offer.advertiser}:${offer.slug}`],
    ['p', offer.advertiser],
    ['payto', offer.rail, payTo],
  ];
  const content = JSON.stringify(offer.event);
  return signHybrid({ kind: KIND.acceptance, created_at, content, tags }, nostrKey, pq);
}

/** The offer version embedded in an acceptance, if it is the one the acceptance names. Its signatures are unchecked. */
export function acceptedOffer(acc: Event): Event | undefined {
  try {
    const ev = JSON.parse(acc.content) as Event;
    return ev?.id === markedEvent(acc, 'offer') ? ev : undefined;
  } catch {
    return undefined;
  }
}

/** The creator's post. `#ad` is appended when the text doesn't already disclose the sponsorship. */
export function createSponsoredPost(
  nostrKey: Uint8Array,
  acceptance: Event,
  text: string,
  pq?: PqKeys,
  created_at = now(),
): Event {
  const content = hasDisclosure(text) ? text : `${text.trimEnd()}\n\n#ad`;
  const tags = [['e', acceptance.id, '', 'sponsorship'], ['p', tagValue(acceptance, 'p') ?? ''], ['t', 'ad']];
  const template = { kind: KIND.note, created_at, content, tags };
  return pq ? signHybrid(template, nostrKey, pq) : finalizeEvent(template, nostrKey);
}

export interface ReceiptInput {
  acceptance: Event;
  delivery: Event;
  rail: string;
  txid: string;
  amount: bigint;
  /** The index period the amount was computed with. */
  period: string;
  created_at?: number;
}

export function createPaymentReceipt(nostrKey: Uint8Array, pq: PqKeys, r: ReceiptInput): Event {
  const tags = [
    ['e', r.acceptance.id, '', 'acceptance'],
    ['e', r.delivery.id, '', 'delivery'],
    ['p', r.acceptance.pubkey],
    ['tx', r.rail, r.txid],
    ['amount', r.amount.toString()],
    ['period', r.period],
  ];
  return signHybrid({ kind: KIND.payment, created_at: r.created_at ?? now(), content: '', tags }, nostrKey, pq);
}

export interface Deal {
  offer: Event;
  acceptance?: Event;
  delivery?: Event;
  payment?: Event;
}

/** How far a deal has validly progressed. `receipted` means the advertiser claims payment; `verifyPayment` checks it. */
export type Stage = 'invalid' | 'offered' | 'accepted' | 'delivered' | 'receipted';

export interface DealOptions {
  pqKeyOf: KeyLookup;
  rails?: Record<string, Rail>;
}

export interface DealCheck {
  stage: Stage;
  offer?: Offer;
  /** Why the deal stops at `stage`, empty when it simply hasn't gone further yet. */
  problems: string[];
}

const signedBy = (ev: Event, author: string, pqKeyOf: KeyLookup): boolean => {
  const key = pqKeyOf(author);
  return ev.pubkey === author && key !== undefined && verifyHybrid(ev, key);
};

function acceptanceProblem(acc: Event, offer: Offer, rail: Rail, pqKeyOf: KeyLookup): string | undefined {
  const [, payRail, payTo = ''] = tag(acc, 'payto') ?? [];
  if (acc.kind !== KIND.acceptance) return 'acceptance has the wrong kind';
  if (!signedBy(acc, acc.pubkey, pqKeyOf)) return 'acceptance lacks the creator’s post-quantum signature';
  if (markedEvent(acc, 'offer') !== offer.event.id) return 'acceptance is for a different version of the offer';
  if (tagValue(acc, 'p') !== offer.advertiser) return 'acceptance names a different advertiser';
  if (acc.pubkey === offer.advertiser) return 'advertisers can’t sponsor themselves';
  if (offer.creator && acc.pubkey !== offer.creator) return 'offer was made to a different creator';
  if (payRail !== offer.rail || !rail.isAddress(payTo)) return 'acceptance has no valid payment address';
  if (acc.created_at > offer.deadline) return 'accepted after the deadline';
}

function deliveryProblem(post: Event, acc: Event, offer: Offer, pqKeyOf: KeyLookup): string | undefined {
  if (post.kind !== KIND.note || !verifyEvent(post)) return 'sponsored post is not a validly signed note';
  if (post.pubkey !== acc.pubkey) return 'sponsored post is by someone other than the creator';
  if (post.tags.some((t) => t[0] === 'pq')) {
    const key = pqKeyOf(post.pubkey);
    if (!key || !verifyPq(post, key)) return 'sponsored post has an invalid post-quantum signature';
  }
  if (markedEvent(post, 'sponsorship') !== acc.id) return 'sponsored post doesn’t reference the acceptance';
  const tagged = post.tags.some((t) => t[0] === 't' && t[1]?.toLowerCase() === 'ad');
  if (!tagged || !hasDisclosure(post.content)) return 'sponsored post isn’t disclosed as an ad';
  if (post.created_at < acc.created_at || post.created_at > offer.deadline) return 'posted outside the agreed window';
}

function receiptProblem(r: Event, acc: Event, post: Event, offer: Offer, pqKeyOf: KeyLookup): string | undefined {
  const [, txRail, txid] = tag(r, 'tx') ?? [];
  if (r.kind !== KIND.payment) return 'receipt has the wrong kind';
  if (!signedBy(r, offer.advertiser, pqKeyOf)) return 'receipt lacks the advertiser’s post-quantum signature';
  if (markedEvent(r, 'acceptance') !== acc.id || markedEvent(r, 'delivery') !== post.id) {
    return 'receipt is for a different deal';
  }
  if (txRail !== offer.rail || !txid) return 'receipt doesn’t name a transfer on the agreed rail';
  if (!/^\d+$/.test(tagValue(r, 'amount') ?? '') || !isPeriod(tagValue(r, 'period') ?? '')) {
    return 'receipt is missing its amount or index period';
  }
}

/** Checks signatures, roles, exact references and the deadline. Offline; `verifyPayment` checks the money. */
export function checkDeal(deal: Deal, { pqKeyOf, rails = RAILS }: DealOptions): DealCheck {
  const offer = parseOffer(deal.offer);
  if (!offer) return { stage: 'invalid', problems: ['offer is malformed'] };
  const stop = (stage: Stage, problem?: string): DealCheck => ({ stage, offer, problems: problem ? [problem] : [] });

  if (!signedBy(deal.offer, offer.advertiser, pqKeyOf)) {
    return stop('invalid', 'offer lacks the advertiser’s post-quantum signature');
  }
  const rail = rails[offer.rail];
  if (!rail) return stop('invalid', `offer uses an unsupported payment rail: ${offer.rail}`);

  const { acceptance: acc, delivery: post, payment: receipt } = deal;
  if (!acc) return stop('offered');
  const accProblem = acceptanceProblem(acc, offer, rail, pqKeyOf);
  if (accProblem) return stop('offered', accProblem);
  if (!post) return stop('accepted');
  const postProblem = deliveryProblem(post, acc, offer, pqKeyOf);
  if (postProblem) return stop('accepted', postProblem);
  if (!receipt) return stop('delivered');
  const receiptIssue = receiptProblem(receipt, acc, post, offer, pqKeyOf);
  return receiptIssue ? stop('delivered', receiptIssue) : stop('receipted');
}

export interface PaymentOptions extends DealOptions {
  attestations: Event[];
  indexPolicy: IndexPolicy;
}

export interface PaymentCheck {
  ok: boolean;
  /** What the creator was owed at the receipt's index period. */
  required?: bigint;
  paid?: bigint;
  problems: string[];
}

/**
 * Confirms on the rail that the creator's address received at least the indexed price, with a memo naming this deal.
 * A `fixed` price needs no index values and is owed in full.
 * The receipt may use either of the two latest index periods published before the payment confirmed, which allows
 * for an index that came out while the advertiser was paying.
 */
export async function verifyPayment(deal: Deal, opts: PaymentOptions): Promise<PaymentCheck> {
  const check = checkDeal(deal, opts);
  if (check.stage !== 'receipted') {
    return { ok: false, problems: check.problems.length ? check.problems : ['deal has no payment receipt'] };
  }
  const offer = check.offer!;
  const acc = deal.acceptance!;
  const receipt = deal.payment!;
  const rail = (opts.rails ?? RAILS)[offer.rail];
  const { attestations, indexPolicy: policy, pqKeyOf } = opts;
  const fixed = offer.price.index === FIXED_INDEX;
  if (!fixed && policy.index !== offer.price.index) {
    return { ok: false, problems: [`offer is priced against ${offer.price.index}, which this client doesn’t track`] };
  }

  let transfer;
  try {
    transfer = await rail.fetchTransfer(tag(receipt, 'tx')![2]);
  } catch (e) {
    return { ok: false, problems: [`payment not found: ${(e as Error).message}`] };
  }
  const problems: string[] = [];
  if (transfer.receiver !== tag(acc, 'payto')![2]) problems.push('payment went to a different address');
  if (transfer.note !== MEMO.deal(acc.id)) problems.push('payment memo doesn’t name this deal');
  if (transfer.amount !== BigInt(tagValue(receipt, 'amount')!)) problems.push('receipt amount doesn’t match the transfer');

  const period = tagValue(receipt, 'period')!;
  if (fixed) {
    const required = offer.price.amount;
    if (transfer.amount < required) problems.push(`underpaid: ${formatUsd(transfer.amount)} of ${formatUsd(required)}`);
    return { ok: problems.length === 0, required, paid: transfer.amount, problems };
  }
  const base = resolveIndexValue(attestations, policy, offer.price.basePeriod, pqKeyOf);
  const usable = resolvedPeriods(attestations, policy, pqKeyOf, transfer.time).slice(0, 2);
  const current = usable.includes(period) && period >= offer.price.basePeriod
    ? resolveIndexValue(attestations, policy, period, pqKeyOf, transfer.time)
    : undefined;
  let required: bigint | undefined;
  if (base === undefined) problems.push('the base-period index value isn’t attested by enough trusted publishers');
  else if (current === undefined) problems.push('receipt doesn’t use one of the two latest index values before payment');
  else {
    required = indexedAmount(offer.price, base, current);
    if (transfer.amount < required) problems.push(`underpaid: ${formatUsd(transfer.amount)} of ${formatUsd(required)}`);
  }
  return { ok: problems.length === 0, required, paid: transfer.amount, problems };
}
