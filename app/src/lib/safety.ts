/**
 * The app's side of safety: the reader's safety settings, and accounts blocked for posting sexual content involving
 * minors. Which accounts appear at all is decided by membership (members.ts).
 */
import { finalizeEvent, type Event } from 'nostr-tools/pure';
import { reportTemplate, type ReportReason } from '@core/commerce.ts';
import { detectLanguage } from '@core/language.ts';
import { assess } from '@core/safety.ts';
import { readerLangs } from './language.ts';
import type { Account } from './account.ts';
import { getProfile } from './hooks.ts';
import { publish } from './net.ts';
import { load, save } from './storage.ts';

export interface SafetySettings {
  showSensitive: boolean;
  showOffensive: boolean;
  allLanguages: boolean;
}

export const safetySettings = (): SafetySettings => ({
  showSensitive: load('showSensitive', false),
  showOffensive: load('showOffensive', false),
  allLanguages: load('allLanguages', false),
});

const blocked = new Set(load<string[]>('blocked', []));

export const isBlocked = (pubkey: string): boolean => blocked.has(pubkey);

function block(pubkey: string) {
  if (blocked.has(pubkey)) return;
  blocked.add(pubkey);
  save('blocked', [...blocked].slice(-2000));
}

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
  if (!settings.allLanguages && !following) {
    const lang = detectLanguage(ev.content);
    if (lang && !readerLangs().has(lang)) return false;
  }
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
