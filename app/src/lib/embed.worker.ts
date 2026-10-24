/** Runs the embedding model off the main thread, so scrolling stays smooth while posts are embedded. */
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

let extractor: Promise<FeatureExtractionPipeline> | undefined;
// Typed as a Worker from the inside: the app's TypeScript program uses the DOM library, not the worker one.
const scope = self as unknown as Worker;

scope.onmessage = async (e: MessageEvent<{ id: number; model: string; texts: string[]; ortBase: string }>) => {
  const { id, model, texts, ortBase } = e.data;
  try {
    if (!extractor) {
      const wasm = env.backends.onnx.wasm!;
      wasm.wasmPaths = { mjs: `${ortBase}ort-wasm-simd-threaded.mjs`, wasm: `${ortBase}ort-wasm-simd-threaded.wasm` };
      wasm.numThreads = 1;
      env.allowLocalModels = false;
      // Load the runtime straight from the app, not through a blob: URL, which a strict CSP forbids.
      env.useWasmCache = false;
      extractor = pipeline('feature-extraction', model, { dtype: 'q8', device: 'wasm' });
    }
    const output = await (await extractor)(texts, { pooling: 'mean', normalize: true });
    scope.postMessage({ id, vectors: output.tolist() as number[][] });
  } catch (err) {
    extractor = undefined;
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
