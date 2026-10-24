/**
 * Audio on the device: recording a host-read ad, converting it to MP3 that matches a show's episodes (so a gateway can
 * splice it into downloads), and reading files' length and MP3 structure before upload. MP3 encoding uses LAME
 * (lame.sourceforge.net, LGPL), loaded as its own file only when a read is converted.
 */
import { mp3Layout, type Mp3Layout } from '@core/mp3.ts';

/** Records from the microphone until `stop` is called. */
export async function startRecording(): Promise<{ stop: () => Promise<Blob>; cancel: () => void }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start(1000);
  const release = () => stream.getTracks().forEach((t) => t.stop());
  return {
    stop: () => new Promise((resolve) => {
      recorder.onstop = () => {
        release();
        resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
      };
      recorder.stop();
    }),
    cancel: () => {
      recorder.onstop = release;
      recorder.stop();
    },
  };
}

/** The shape a read must have to be spliced into a show's MP3s. Defaults to podcast norms when a show has none yet. */
export interface Mp3Target {
  sampleRate: number;
  channels: 1 | 2;
  kbps: number;
}

export const DEFAULT_TARGET: Mp3Target = { sampleRate: 44100, channels: 1, kbps: 96 };

/** Decodes any audio the browser can play and encodes it as constant-bitrate MP3 in the target's format. */
export async function toMp3(input: Blob, target: Mp3Target = DEFAULT_TARGET): Promise<{ blob: Blob; layout: Mp3Layout }> {
  const decoded = await new AudioContext().decodeAudioData(await input.arrayBuffer());
  const length = Math.ceil(decoded.duration * target.sampleRate);
  const offline = new OfflineAudioContext(target.channels, length, target.sampleRate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const pcm = (ch: number) => {
    const f = rendered.getChannelData(Math.min(ch, rendered.numberOfChannels - 1));
    const out = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) out[i] = Math.max(-1, Math.min(1, f[i])) * 0x7fff;
    return out;
  };
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const encoder = new Mp3Encoder(target.channels, target.sampleRate, target.kbps);
  const left = pcm(0);
  const right = target.channels === 2 ? pcm(1) : undefined;
  const parts: Uint8Array[] = [];
  for (let i = 0; i < left.length; i += 1152) {
    const chunk = encoder.encodeBuffer(left.subarray(i, i + 1152), right?.subarray(i, i + 1152));
    if (chunk.length) parts.push(new Uint8Array(chunk));
  }
  parts.push(new Uint8Array(encoder.flush()));
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  const layout = mp3Layout(bytes);
  if (!layout) throw new Error('Could not convert the recording.');
  return { blob: new Blob([bytes], { type: 'audio/mpeg' }), layout };
}

/** The length of an audio or video file, read by the browser. */
export function mediaDuration(file: Blob): Promise<number | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio');
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(el.duration) ? el.duration : undefined);
    };
    el.onerror = () => resolve(undefined);
    el.src = url;
  });
}

/** Blossom serves a blob under any extension; podcast apps (Apple's included) expect the right one. */
export function withExtension(url: string, ext: string): string {
  const m = /^(https:\/\/[^/]+\/[0-9a-f]{64})(\.[a-z0-9]+)?$/i.exec(url);
  return m ? `${m[1]}.${ext}` : url;
}
