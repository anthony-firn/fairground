/**
 * The reader's languages: their browser's, plus languages they keep reading, liking and writing in, learned on the
 * device. The feed and search show posts in these languages, so it feels like their own community from the start.
 */
import { detectLanguage, readerLanguages } from '@core/language.ts';
import { load, save } from './storage.ts';

let cached: Set<string> | undefined;

const browserLanguages = (): readonly string[] =>
  typeof navigator === 'undefined' ? ['en'] : navigator.languages?.length ? navigator.languages : [navigator.language ?? 'en'];

export function readerLangs(): Set<string> {
  cached ??= new Set([...readerLanguages(browserLanguages(), load<Record<string, number>>('langStats', {})), ...load<string[]>('extraLangs', [])]);
  return cached;
}

/** Adds a language by hand, or removes one whether it was added or learned. */
export function setExtraLanguage(lang: string, on: boolean): void {
  const list = new Set(load<string[]>('extraLangs', []));
  if (on) list.add(lang);
  else {
    list.delete(lang);
    const stats = load<Record<string, number>>('langStats', {});
    delete stats[lang];
    save('langStats', stats);
  }
  save('extraLangs', [...list]);
  cached = undefined;
}

/** Counts engagement with a post's language: reading 1, liking 2, writing 5. */
export function learnLanguage(text: string, weight: number): void {
  const lang = detectLanguage(text);
  if (!lang) return;
  const stats = load<Record<string, number>>('langStats', {});
  stats[lang] = (stats[lang] ?? 0) + weight;
  save('langStats', stats);
  cached = undefined;
}

export function resetLearnedLanguages(): void {
  save('langStats', {});
  save('extraLangs', []);
  cached = undefined;
}

export const isBrowserLanguage = (lang: string): boolean => browserLanguages().some((l) => l.toLowerCase().split('-')[0] === lang);

export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames([browserLanguages()[0] ?? 'en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}
