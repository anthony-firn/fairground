import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { detectLanguage, readerLanguages } from '../src/language.ts';
import { createEpisode, createPhotoPost, createVideo, formatDuration, parseImeta, toMedia } from '../src/media.ts';

const key = generateSecretKey();
const note = (content: string) => finalizeEvent({ kind: 1, created_at: 1, content, tags: [] }, key);

test('imeta tags parse into key → values', () => {
  assert.deepEqual(parseImeta(['imeta', 'url https://x.example/a.mp4', 'm video/mp4', 'image https://x.example/a.jpg', 'image https://y.example/a.jpg']),
    { url: ['https://x.example/a.mp4'], m: ['video/mp4'], image: ['https://x.example/a.jpg', 'https://y.example/a.jpg'] });
});

test('NIP-68 photos, NIP-71 videos and shorts, and NIP-F4 episodes round-trip', () => {
  const photo = toMedia(createPhotoPost(key, { title: 'Sunrise', description: 'Over the bay #photography', images: [{ url: 'https://x.example/1.jpg', dim: '1200x800' }, { url: 'https://x.example/2.jpg' }] }))!;
  assert.equal(photo.kind, 'photo');
  assert.deepEqual(photo.images, ['https://x.example/1.jpg', 'https://x.example/2.jpg']);
  assert.ok(photo.event.tags.some((t) => t[0] === 't' && t[1] === 'photography'));

  const video = toMedia(createVideo(key, { short: false, title: 'Build log', description: 'Part 1', url: 'https://x.example/v.mp4', poster: 'https://x.example/v.jpg', duration: 754.2, dim: '1920x1080' }))!;
  assert.equal(video.kind, 'video');
  assert.deepEqual(video.video, { url: 'https://x.example/v.mp4', poster: 'https://x.example/v.jpg', duration: 754.2, width: 1920, height: 1080 });

  const short = toMedia(createVideo(key, { short: true, title: 'Flip', description: '', url: 'https://x.example/s.mp4', dim: '1080x1920' }))!;
  assert.equal(short.kind, 'short');
  assert.equal(short.event.kind, 22);

  const ep = toMedia(createEpisode(key, { title: 'Episode 1', description: 'Pilot', audio: 'https://x.example/e1.mp3', image: 'https://x.example/cover.jpg' }))!;
  assert.equal(ep.kind, 'audio');
  assert.equal(ep.audio?.url, 'https://x.example/e1.mp3');
  assert.deepEqual(ep.images, ['https://x.example/cover.jpg']);
});

test('ordinary posts are classified by the media they link', () => {
  assert.equal(toMedia(note('Look https://x.example/a.png'))?.kind, 'photo');
  assert.equal(toMedia(note('Clip https://x.example/a.mp4'))?.kind, 'video');
  assert.equal(toMedia(note('Album https://x.example/a.mp3 https://x.example/cover.jpg'))?.kind, 'audio');
  assert.equal(toMedia(note('Just words'))?.kind, 'post');
  assert.equal(toMedia(note('Insecure http://x.example/a.png'))?.kind, 'post', 'only https media');
});

test('durations format like a player', () => {
  assert.equal(formatDuration(754.2), '12:34');
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDuration(undefined), undefined);
});

test('languages are detected from scripts and common words', () => {
  assert.equal(detectLanguage('This is just what I wanted to say about the game'), 'en');
  assert.equal(detectLanguage('El perro de mi vecino no para de ladrar por la noche'), 'es');
  assert.equal(detectLanguage('Je pense que le film est vraiment pas mal pour les enfants'), 'fr');
  assert.equal(detectLanguage('Ich bin heute nicht zu Hause und auch nicht im Büro'), 'de');
  assert.equal(detectLanguage('長野の飯田のお菓子、おいしい'), 'ja');
  assert.equal(detectLanguage('今天天气很好我们去公园散步吧'), 'zh');
  assert.equal(detectLanguage('Таки, наше море глубже, чем наши шутки'), 'ru');
  assert.equal(detectLanguage('GM'), undefined, 'too short to tell');
  assert.equal(detectLanguage('https://x.example/a.png #bitcoin'), undefined);
});

test('reader languages come from the browser and grow with what they engage with', () => {
  assert.deepEqual([...readerLanguages(['en-US', 'en'])], ['en']);
  assert.deepEqual([...readerLanguages(['en-US'], { es: 6, en: 20 })].sort(), ['en', 'es']);
  assert.deepEqual([...readerLanguages(['en-US'], { es: 2, en: 40 })], ['en'], 'a couple of clicks is not a preference');
});
