/**
 * Photo uploads to a Blossom media server (content-addressed, signed with the account's Nostr key). Photos are
 * re-encoded on the device first, which strips their metadata (including the GPS location phones embed) and keeps
 * them small.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { finalizeEvent } from 'nostr-tools/pure';
import type { Account } from './account.ts';
import { load } from './storage.ts';

/**
 * Free Blossom servers, checked October 2026: blossom.band takes up to 20 MiB per file, Primal's and nostr.download
 * take podcast-sized files. Each upload asks a server first whether it will take the file (BUD-06), so a big episode
 * skips the servers that won't.
 */
export const DEFAULT_MEDIA_SERVERS = ['https://blossom.band', 'https://blossom.primal.net', 'https://nostr.download'];

async function reencode(file: File, maxSide = 1600, square = false): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const [sw, sh] = square ? [side, side] : [bitmap.width, bitmap.height];
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - sw) / 2, (bitmap.height - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process the photo.'))), 'image/jpeg', 0.88));
}

export const uploadPhoto = async (account: Account, file: File): Promise<string> => uploadBlob(account, await reencode(file), 'image/jpeg');

/** Podcast artwork: cropped square and sized for Apple Podcasts (1400 to 3000 pixels). */
export async function uploadArtwork(account: Account, file: File): Promise<{ url: string; side: number }> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(3000, bitmap.width, bitmap.height);
  if (side < 1400) throw new Error(`That image is ${Math.min(bitmap.width, bitmap.height)} pixels across; podcast apps need at least 1400 × 1400.`);
  return { url: await uploadBlob(account, await reencode(file, 3000, true), 'image/jpeg'), side };
}

export const MAX_UPLOAD = 500 * 1024 * 1024;

/** Uploads a video or audio file as it is. */
export async function uploadFile(account: Account, file: Blob, onProgress?: (fraction: number) => void): Promise<string> {
  if (file.size > MAX_UPLOAD) throw new Error(`That file is ${(file.size / 1048576).toFixed(0)} MB; uploads here take up to 500 MB. Paste a link to it instead.`);
  return uploadBlob(account, file, file.type || 'application/octet-stream', onProgress);
}

function put(url: string, blob: Blob, headers: Record<string, string>, onProgress?: (fraction: number) => void): Promise<{ status: number; reason: string; body: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    if (onProgress) xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => resolve({ status: xhr.status, reason: xhr.getResponseHeader('x-reason') ?? '', body: xhr.responseText });
    xhr.onerror = () => reject(new Error(`Could not reach ${new URL(url).host}.`));
    xhr.send(blob);
  });
}

export async function uploadBlob(account: Account, blob: Blob, type: string, onProgress?: (fraction: number) => void): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const hash = bytesToHex(sha256(bytes));
  const auth = finalizeEvent({
    kind: 24242, created_at: Math.floor(Date.now() / 1000), content: 'Upload media',
    tags: [['t', 'upload'], ['x', hash], ['expiration', String(Math.floor(Date.now() / 1000) + 3600)]],
  }, account.nostrKey);
  const header = `Nostr ${base64.encode(new TextEncoder().encode(JSON.stringify(auth)))}`;
  let lastError = 'No media server accepted the file.';
  for (const server of load<string[]>('mediaServers', DEFAULT_MEDIA_SERVERS)) {
    const host = new URL(server).host;
    try {
      if (blob.size > 8 * 1024 * 1024) {
        const check = await fetch(`${server}/upload`, {
          method: 'HEAD', headers: { Authorization: header, 'X-Content-Length': String(blob.size), 'X-Content-Type': type, 'X-SHA-256': hash },
        }).catch(() => undefined);
        if (check && !check.ok) {
          lastError = `${host} won’t take this file${check.headers.get('x-reason') ? `: ${check.headers.get('x-reason')}` : ''}`;
          continue;
        }
      }
      // Send the bytes already read for the hash, rather than streaming the file from disk again.
      const res = await put(`${server}/upload`, new Blob([bytes], { type }), { Authorization: header, 'Content-Type': type }, onProgress);
      if (res.status < 200 || res.status >= 300) {
        lastError = `${host} said ${res.status}${res.reason ? `: ${res.reason}` : ''}`;
        continue;
      }
      const descriptor = JSON.parse(res.body) as { url?: string; sha256?: string };
      if (descriptor.sha256 && descriptor.sha256 !== hash) throw new Error('The server stored something else.');
      if (descriptor.url?.startsWith('https://')) return descriptor.url;
    } catch (e) {
      lastError = (e as Error).message;
    }
  }
  throw new Error(lastError);
}
