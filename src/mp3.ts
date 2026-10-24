/**
 * MP3 structure, for stitching host-read ads into podcast downloads without re-encoding.
 *
 * An MP3 file is a sequence of independent frames, optionally preceded by an ID3v2 tag and a Xing/Info/VBRI header
 * frame, and followed by ID3v1 or APE tags. Frames of the same sample rate and channel count can be joined end to end,
 * so an ad read is inserted by splicing its frames in at a frame boundary. The header frame describes the original
 * file's length, so stitched files leave it out and players measure the audio itself.
 */

export interface Mp3Layout {
  version: 1 | 2 | 2.5;
  sampleRate: number;
  channels: 1 | 2;
  samplesPerFrame: number;
  /** Bytes before this are the ID3v2 tag (title, artwork), kept at the front of a stitched file. */
  id3End: number;
  /** The first audio frame, after any Xing/Info/VBRI header frame. */
  audioStart: number;
  /** The end of the last audio frame, before any ID3v1 or APE tag. */
  audioEnd: number;
  frames: number;
  /** Seconds. */
  duration: number;
  /** Average kilobits per second. */
  bitrate: number;
}

interface FrameHeader {
  version: 1 | 2 | 2.5;
  sampleRate: number;
  channels: 1 | 2;
  samplesPerFrame: number;
  length: number;
}

const BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };

/** A Layer III frame header at `pos`, or undefined. Free-format and reserved values are rejected. */
function frameAt(b: Uint8Array, pos: number): FrameHeader | undefined {
  if (pos + 4 > b.length || b[pos] !== 0xff || (b[pos + 1] & 0xe0) !== 0xe0) return undefined;
  const versionBits = (b[pos + 1] >> 3) & 3;
  const layerBits = (b[pos + 1] >> 1) & 3;
  const bitrateIndex = b[pos + 2] >> 4;
  const rateIndex = (b[pos + 2] >> 2) & 3;
  if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return undefined;
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const kbps = BITRATES[version === 1 ? 1 : 2][bitrateIndex];
  const sampleRate = SAMPLE_RATES[version][rateIndex];
  const padding = (b[pos + 2] >> 1) & 1;
  const length = Math.floor(((version === 1 ? 144 : 72) * kbps * 1000) / sampleRate) + padding;
  return { version, sampleRate, channels: (b[pos + 3] >> 6) === 3 ? 1 : 2, samplesPerFrame: version === 1 ? 1152 : 576, length };
}

const ascii = (b: Uint8Array, pos: number, n: number) => String.fromCharCode(...b.subarray(pos, pos + n));

function id3v2End(b: Uint8Array): number {
  if (b.length < 10 || ascii(b, 0, 3) !== 'ID3') return 0;
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  return 10 + size + (b[5] & 0x10 ? 10 : 0);
}

/** Whether the frame at `pos` is a Xing, Info or VBRI header frame rather than audio. */
function isHeaderFrame(b: Uint8Array, pos: number, h: FrameHeader): boolean {
  const side = h.version === 1 ? (h.channels === 1 ? 17 : 32) : h.channels === 1 ? 9 : 17;
  const xing = ascii(b, pos + 4 + side, 4);
  return xing === 'Xing' || xing === 'Info' || ascii(b, pos + 36, 4) === 'VBRI';
}

/** The first frame at or after `from` whose successor also starts where it should, so a stray 0xFF isn't mistaken. */
function firstFrame(b: Uint8Array, from: number): number {
  const limit = Math.min(b.length - 4, from + 65536);
  for (let pos = from; pos < limit; pos++) {
    const h = frameAt(b, pos);
    if (!h) continue;
    const next = frameAt(b, pos + h.length);
    if (pos + h.length === b.length || (next && next.sampleRate === h.sampleRate)) return pos;
  }
  return -1;
}

/** The layout of an MP3 file, or undefined if it isn't one. */
export function mp3Layout(bytes: Uint8Array): Mp3Layout | undefined {
  const id3End = id3v2End(bytes);
  let pos = firstFrame(bytes, id3End);
  if (pos < 0) return undefined;
  const first = frameAt(bytes, pos)!;
  if (isHeaderFrame(bytes, pos, first)) pos += first.length;
  const audioStart = pos;
  let frames = 0;
  while (true) {
    const h = frameAt(bytes, pos);
    if (!h || h.sampleRate !== first.sampleRate || pos + h.length > bytes.length) break;
    pos += h.length;
    frames++;
  }
  if (!frames) return undefined;
  const duration = (frames * first.samplesPerFrame) / first.sampleRate;
  return {
    version: first.version,
    sampleRate: first.sampleRate,
    channels: first.channels,
    samplesPerFrame: first.samplesPerFrame,
    id3End,
    audioStart,
    audioEnd: pos,
    frames,
    duration,
    bitrate: Math.round(((pos - audioStart) * 8) / duration / 1000),
  };
}

/** The byte offset of the first frame that starts at or after `seconds`: where a mid-roll can be spliced in. */
export function mp3OffsetAt(bytes: Uint8Array, layout: Mp3Layout, seconds: number): number {
  const target = Math.max(0, Math.ceil((seconds * layout.sampleRate) / layout.samplesPerFrame));
  let pos = layout.audioStart;
  for (let i = 0; i < target && pos < layout.audioEnd; i++) pos += frameAt(bytes, pos)!.length;
  return Math.min(pos, layout.audioEnd);
}

/** Whether two files' frames can be joined: same MPEG version, sample rate and channel count. */
export const canJoin = (a: Pick<Mp3Layout, 'version' | 'sampleRate' | 'channels'>, b: Pick<Mp3Layout, 'version' | 'sampleRate' | 'channels'>): boolean =>
  a.version === b.version && a.sampleRate === b.sampleRate && a.channels === b.channels;
