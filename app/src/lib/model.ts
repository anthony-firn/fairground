/** The reader's AI model: in the browser by default, their own Ollama if they choose, or none. */
import { BROWSER_MODEL, ollamaEmbedder, type Embedder } from '@core/feed.ts';
import { load } from './storage.ts';

export type ModelChoice = { kind: 'browser' } | { kind: 'ollama'; model: string; url: string } | { kind: 'off' };

export const modelChoice = (): ModelChoice => load<ModelChoice>('model', { kind: 'browser' });

let worker: Worker | undefined;
let nextId = 0;
const waiting = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>();

function browserEmbedder(): Embedder {
  const model = BROWSER_MODEL.replace(/^transformers\.js:/, '');
  return {
    id: BROWSER_MODEL,
    embed(texts) {
      if (!worker) {
        worker = new Worker(new URL('./embed.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (e: MessageEvent<{ id: number; vectors?: number[][]; error?: string }>) => {
          const job = waiting.get(e.data.id);
          waiting.delete(e.data.id);
          if (e.data.error) job?.reject(new Error(e.data.error));
          else job?.resolve(e.data.vectors!.map((v) => Float32Array.from(v)));
        };
      }
      const id = nextId++;
      const ortBase = new URL('./ort/', document.baseURI).href;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        worker!.postMessage({ id, model, texts: texts.map((t) => t.slice(0, 512)), ortBase });
      });
    },
  };
}

export function currentEmbedder(): Embedder | undefined {
  const choice = modelChoice();
  if (choice.kind === 'browser') return browserEmbedder();
  if (choice.kind === 'ollama') return ollamaEmbedder(choice.model, choice.url);
  return undefined;
}
