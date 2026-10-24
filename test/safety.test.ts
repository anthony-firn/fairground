import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { assess, isChildAbuse, isIllegal, readerScripts, repeats, scriptOf } from '../src/safety.ts';

const key = generateSecretKey();
const post = (content: string, tags: string[][] = [], at = 1_790_000_000) => finalizeEvent({ kind: 1, created_at: at, content, tags }, key);

test('sexual content involving minors is blocked, including through hashtags and codes', () => {
  assert.ok(isChildAbuse(post('teen nude content, dm me')));
  assert.ok(isChildAbuse(post('new content', [['t', 'teenage'], ['t', 'nolimit']])));
  assert.ok(isChildAbuse(post('cp jk, see t.me/someone')));
  assert.ok(isChildAbuse(post('pthc')));
  assert.ok(isChildAbuse(post('young incest contents in bio')));
  assert.deepEqual(assess(post('✅Teens ✅Rape')), { block: true });
});

test('ordinary posts about young people or with similar letters are not blocked', () => {
  assert.equal(isChildAbuse(post('Run cp -r src dist before deploying')), false);
  assert.equal(isChildAbuse(post('Teen mental health study shows sleep matters')), false);
  assert.equal(isChildAbuse(post('Kids loved the science fair today')), false);
  assert.equal(isChildAbuse(post('Sussex hiking trip with the kids')), false);
  assert.deepEqual(assess(post('Kids loved the science fair today')), { block: false });
});

test('adult content, hate, spam, junk and bots are hidden with a reason', () => {
  assert.deepEqual(assess(post('new nsfw set')), { block: false, hide: 'sexual' });
  assert.deepEqual(assess(post('hello', [['content-warning', 'nudity']])), { block: false, hide: 'sexual' });
  assert.deepEqual(assess(post("You've been warned, all of you")), { block: false, hide: 'hate' });
  const tags = Array.from({ length: 12 }, (_, i) => `#tag${i}`).join(' ');
  assert.deepEqual(assess(post(`buy now ${tags}`)), { block: false, hide: 'spam' });
  assert.deepEqual(assess(post('{"id":"p1792818888598455","n":"x","ty":"p"}')), { block: false, hide: 'junk' });
  assert.deepEqual(assess(post('Block 972882 found'), { bot: true }), { block: false, hide: 'bot' });
  assert.deepEqual(assess(post('{ a regular thought in braces }')), { block: false });
});

test('the main writing system of a post is detected, ignoring links and hashtags', () => {
  assert.equal(scriptOf('One of the gladdest moments of human life'), 'latin');
  assert.equal(scriptOf('長野の飯田のお菓子、おいしい'), 'cjk');
  assert.equal(scriptOf('Таки, наше море глубже, чем наши шутки! #юмор'), 'cyrillic');
  assert.equal(scriptOf('Short ok https://example.com/путь #日本'), 'latin');
  assert.equal(scriptOf('😂😂'), 'none');
});

test('reader scripts come from browser languages, always including Latin', () => {
  assert.deepEqual([...readerScripts(['en-US', 'en'])].sort(), ['latin', 'none']);
  assert.deepEqual([...readerScripts(['ja-JP'])].sort(), ['cjk', 'latin', 'none']);
});

test('a bot repeating itself shows once', () => {
  const a = post('Block #972879 — no winner', [], 100);
  const b = post('Block #972882 — no winner', [], 200);
  const c = post('Something else', [], 150);
  assert.deepEqual([...repeats([a, b, c])], [a.id]);
});

test('bestiality and non-consensual intimate imagery are blocked like child abuse; legal adult content is only hidden', () => {
  assert.ok(isIllegal(post('new bestiality clips')));
  assert.ok(isIllegal(post('hidden cam in the changing room')));
  assert.ok(isIllegal(post('revenge porn of my ex')));
  assert.equal(isIllegal(post('new nsfw set, adults only')), false);
  assert.deepEqual(assess(post('new nsfw set, adults only')), { block: false, hide: 'sexual' });
  assert.deepEqual(assess(post('deepfake nudes of a celebrity')), { block: true });
});

test('photos, videos and episodes are judged by their titles and alt text too', () => {
  const video = (title: string, content = '', url = 'https://x.example/v.mp4') =>
    finalizeEvent({ kind: 21, created_at: 1, content, tags: [['title', title], ['imeta', `url ${url}`, 'm video/mp4']] }, key);
  assert.deepEqual(assess(video('Build log, part 1')), { block: false }, 'a title with no description is not junk');
  assert.deepEqual(assess(video('teen nudes t.me/x')), { block: true }, 'abuse in a title is blocked');
  assert.deepEqual(assess(video('new nsfw set')), { block: false, hide: 'sexual' });
  const alt = finalizeEvent({ kind: 20, created_at: 1, content: '', tags: [['title', 'Set'], ['imeta', 'url https://x.example/a.jpg', 'alt nsfw shoot']] }, key);
  assert.deepEqual(assess(alt), { block: false, hide: 'sexual' });
  assert.equal(repeats([video('Clip', '', 'https://x.example/1.mp4'), video('Clip', '', 'https://x.example/2.mp4')]).size, 0, 'different videos with one title are not repeats');
});
