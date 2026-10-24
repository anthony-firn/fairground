import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Serves the ONNX runtime for the in-browser model from the app itself, because evolvetech.dev only allows scripts
 * from its own origin. The CPU build is enough for a small embedding model and works in every browser.
 */
function onnxRuntime(): Plugin {
  const files = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
  return {
    name: 'fairground-onnx-runtime',
    buildStart() {
      const out = path.join(root, 'public/ort');
      mkdirSync(out, { recursive: true });
      for (const f of files) copyFileSync(path.join(root, '../node_modules/onnxruntime-web/dist', f), path.join(out, f));
    },
  };
}

export default defineConfig({
  // Relative paths, so the same build works under /play/fairground/ and inside the iOS and Android apps.
  base: './',
  plugins: [react(), onnxRuntime()],
  resolve: {
    alias: [
      { find: '@core', replacement: path.join(root, '../src') },
      // Transformers.js imports the WebGPU build, which bundles a 27 MB runtime; the CPU build loads the one above.
      { find: /^onnxruntime-web\/webgpu$/, replacement: path.join(root, '../node_modules/onnxruntime-web/dist/ort.wasm.min.mjs') },
    ],
  },
  build: { target: 'es2022', outDir: 'dist', chunkSizeWarningLimit: 2500 },
  worker: { format: 'es' },
  server: { port: 5173 },
});
