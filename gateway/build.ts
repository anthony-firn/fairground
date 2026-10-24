/**
 * Bundles the gateway into one dependency-free ES module, dist-gateway/fairground-gateway.js, for platforms that
 * deploy a single file (Netlify and Deno edge functions, Cloudflare Workers, Bun).
 *
 *   node gateway/build.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    lib: { entry: path.join(root, 'index.ts'), formats: ['es'], fileName: () => 'fairground-gateway.js' },
    outDir: path.join(root, '../dist-gateway'),
    emptyOutDir: true,
    target: 'es2022',
    minify: true,
  },
});
console.log('built dist-gateway/fairground-gateway.js');
