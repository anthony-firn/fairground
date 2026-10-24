/**
 * The app's side of safety: the starting network (cached for a day), the reader's safety settings, and accounts
 * blocked for posting sexual content involving minors.
 */
import { finalizeEvent, type Event } from 'nostr-tools/pure';
import { reportTemplate, type ReportReason } from '@core/commerce.ts';
import { assess, networkFrom, readerScripts, scriptOf, SEED_ACCOUNTS } from '@core/safety.ts';
import type { Account } from './account.ts';
import { getProfile } from './hooks.ts';
import { publish, query } from './net.ts';
import { load, save } from './storage.ts';

export interface SafetySettings {
  showSensitive: boolean;
  showOffensive: boolean;
  allLanguages: boolean;
  /** Let strangers outside the starting network into "For you". */
  unvetted: boolean;
}

export const safetySettings = (): SafetySettings => ({
  showSensitive: load('showSensitive', false),
  showOffensive: load('showOffensive', false),
  allLanguages: load('allLanguages', false),
  unvetted: load('unvetted', false),
});

export const seedAccounts = (): string[] => load<string[]>('seeds', SEED_ACCOUNTS.map((s) => s.pubkey));

// The network is a few thousand keys: cached outside the settings that sync to the account vault.
const CACHE = 'fg-cache.network';
let networkPromise: Promise<Set<string>> | undefined;

export function loadNetwork(): Promise<Set<string>> {
  networkPromise ??= (async () => {
    const seeds = seedAccounts();
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE) ?? 'null') as { at: number; seeds: string[]; list: string[] } | null;
      if (cached && Date.now() - cached.at < 86_400_000 && cached.seeds.join() === seeds.join()) return new Set(cached.list);
    } catch {
      // Fetch it again.
    }
    const lists = await query({ kinds: [3], authors: seeds }, 6000);
    // On relays that don't carry the seeds' follow lists (private or test relays) there is no network to gate by.
    if (!lists.length) return new Set<string>();
    const network = networkFrom(lists, seeds);
    try {
      localStorage.setItem(CACHE, JSON.stringify({ at: Date.now(), seeds, list: [...network] }));
    } catch {
      // The cache is optional.
    }
    return network;
  })();
  return networkPromise;
}

export function resetNetwork(): void {
  networkPromise = undefined;
  try {
    localStorage.removeItem(CACHE);
  } catch {
    // Nothing cached.
  }
}

const blocked = new Set(load<string[]>('blocked', []));

export const isBlocked = (pubkey: string): boolean => blocked.has(pubkey);

function block(pubkey: string) {
  if (blocked.has(pubkey)) return;
  blocked.add(pubkey);
  save('blocked', [...blocked].slice(-2000));
}

const scripts = readerScripts(typeof navigator === 'undefined' ? ['en'] : navigator.languages ?? [navigator.language]);

/**
 * Whether a post may be shown at all. Sexual content involving minors blocks its author for good, whatever the
 * settings. `following` relaxes the bot rule for accounts the reader chose to follow.
 */
export function allowed(ev: Event, settings: SafetySettings, following = false): boolean {
  if (blocked.has(ev.pubkey)) return false;
  const verdict = assess(ev, getProfile(ev.pubkey));
  if (verdict.block) {
    block(ev.pubkey);
    return false;
  }
  if (verdict.hide === 'sexual' && !settings.showSensitive) return false;
  if (verdict.hide === 'hate' && !settings.showOffensive) return false;
  if (verdict.hide === 'spam' || verdict.hide === 'junk') return false;
  if (verdict.hide === 'bot' && !following) return false;
  if (!settings.allLanguages && !following && !scripts.has(scriptOf(ev.content))) return false;
  return true;
}

export function hideAccount(pubkey: string): void {
  const muted = new Set(load<string[]>('muted', []));
  muted.add(pubkey);
  save('muted', [...muted]);
}

/** Publishes a NIP-56 report, so other readers' clients can weigh it, and hides the account here. */
export async function report(account: Account, target: Event, reason: ReportReason): Promise<void> {
  hideAccount(target.pubkey);
  if (reason === 'illegal') block(target.pubkey);
  await publish(finalizeEvent(reportTemplate(target, reason), account.nostrKey)).catch(() => undefined);
}
