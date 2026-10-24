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

/** nostr.build's free Blossom service (20 MiB per upload), then Primal's. */
export const DEFAULT_MEDIA_SERVERS = ['https://blossom.band', 'https://blossom.primal.net'];

async function reencode(file: File, maxSide = 1600): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process the photo.'))), 'image/jpeg', 0.85));
}

export const uploadPhoto = async (account: Account, file: File): Promise<string> => uploadBlob(account, await reencode(file), 'image/jpeg');

/** The free media servers take up to 20 MiB per file; bigger videos need a link from somewhere else. */
export const MAX_UPLOAD = 20 * 1024 * 1024;

/** Uploads a video or audio file as it is. */
export async function uploadFile(account: Account, file: File): Promise<string> {
  if (file.size > MAX_UPLOAD) throw new Error(`That file is ${(file.size / 1048576).toFixed(0)} MB; the free media servers take up to 20 MB. Paste a link to it instead.`);
  return uploadBlob(account, file, file.type || 'application/octet-stream');
}

export async function uploadBlob(account: Account, blob: Blob, type: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const hash = bytesToHex(sha256(bytes));
  const auth = finalizeEvent({
    kind: 24242, created_at: Math.floor(Date.now() / 1000), content: 'Upload media',
    tags: [['t', 'upload'], ['x', hash], ['expiration', String(Math.floor(Date.now() / 1000) + 300)]],
  }, account.nostrKey);
  const header = `Nostr ${base64.encode(new TextEncoder().encode(JSON.stringify(auth)))}`;
  let lastError = 'No media server accepted the photo.';
  for (const server of load<string[]>('mediaServers', DEFAULT_MEDIA_SERVERS)) {
    try {
      const res = await fetch(`${server}/upload`, { method: 'PUT', headers: { Authorization: header, 'Content-Type': type }, body: blob });
      if (!res.ok) {
        lastError = `${new URL(server).host} said ${res.status}${res.headers.get('x-reason') ? `: ${res.headers.get('x-reason')}` : ''}`;
        continue;
      }
      const descriptor = (await res.json()) as { url?: string; sha256?: string };
      if (descriptor.sha256 && descriptor.sha256 !== hash) throw new Error('The server stored something else.');
      if (descriptor.url?.startsWith('https://')) return descriptor.url;
    } catch (e) {
      lastError = (e as Error).message;
    }
  }
  throw new Error(lastError);
}
