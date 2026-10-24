import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { nsecEncode, npubEncode } from 'nostr-tools/nip19';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import { DEFAULT_RELAYS } from '../src/defaults.ts';
import { createPqBinding, generatePqKeys } from '../src/pq.ts';

const dir = `${process.env.HOME}/.config/fairground`;
const keyFile = `${dir}/anthony-firn.json`;
if (!existsSync(keyFile)) {
  const nostrKey = generateSecretKey();
  const pqSeed = randomBytes(32);
  const binding = createPqBinding(nostrKey, generatePqKeys(pqSeed));
  writeFileSync(keyFile, JSON.stringify({
    nostrKey: bytesToHex(nostrKey), pqSeed: bytesToHex(pqSeed), binding,
    backupCode: `fairground:${nsecEncode(nostrKey)}:${bytesToHex(pqSeed)}`,
  }, null, 2) + '\n', { mode: 0o600 });
}
const key = JSON.parse(readFileSync(keyFile, 'utf8'));
const sk = hexToBytes(key.nostrKey);
const now = Math.floor(Date.now() / 1000);
const tags = (text: string) => [...new Set([...text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1].toLowerCase()))].map((t) => ['t', t]);

const meta = JSON.parse(readFileSync(process.argv[2], 'utf8')) as { files: { name: string; title: string }[] };
const base = 'https://archive.org/download/jamendo-176504/';
const tracks = meta.files
  .filter((f) => f.name.endsWith('.mp3'))
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((f, i) => `${i + 1}. ${f.title.replace(/^King Gizzard & the Lizard Wizard - /, '')} ${base}${encodeURIComponent(f.name)}`);

const intro = `Hi, I'm Anthony. I'm building Fairground: a social network with no company in the middle. Creators get paid directly, your feed is ranked by an AI on your own device, and every deal is a public, signed record.

It's open source and early. Try it at https://www.evolvetech.dev/play/fairground/ or read the code at https://github.com/anthony-firn/fairground

#fairground #nostr #opensource`;

const album = `Polygondwanaland by King Gizzard & the Lizard Wizard (2017)
${base}cover.jpg

The band gave this record away: “This album is FREE. Free as in, free. Free to download and if you wish, free to make copies.” And: “We do not own this record. You do. Go forth, share, enjoy.”

So here's the whole album, playable right here:

${tracks.join('\n')}

Free downloads from the band, with the WAV, CD and vinyl masters: https://kinggizzardandthelizardwizard.com/polygondwanaland
Artwork by Jason Galea.

#music #kinggizzard #polygondwanaland`;

const events: Event[] = [
  key.binding,
  finalizeEvent({ kind: 0, created_at: now, tags: [], content: JSON.stringify({
    name: 'Anthony Firn', display_name: 'Anthony Firn',
    about: 'Software engineer. Building Fairground, a social network with no company in the middle, at EvolveTech.',
    website: 'https://www.evolvetech.dev',
  }) }, sk),
  finalizeEvent({ kind: 10002, created_at: now, content: '', tags: DEFAULT_RELAYS.map((r) => ['r', r]) }, sk),
  finalizeEvent({ kind: 1, created_at: now, content: intro, tags: tags(intro) }, sk),
  finalizeEvent({ kind: 1, created_at: now + 60, content: album, tags: tags(album) }, sk),
];
writeFileSync(`${dir}/anthony-firn-events.json`, JSON.stringify(events, null, 2) + '\n', { mode: 0o600 });
console.log('npub:', npubEncode(getPublicKey(sk)));
console.log('pubkey:', getPublicKey(sk));
for (const e of events) console.log(`kind ${e.kind}: ${e.content.length} chars, tags ${JSON.stringify(e.tags.filter((t) => t[0] === 't').map((t) => t[1]))}`);
console.log('\n--- album post ---\n' + album.replace(/https:\/\/archive\.org\/download\/jamendo-176504\/\S+\.mp3/g, '[mp3]'));
