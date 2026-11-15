import { defineConfig } from 'vite';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const dataEntry = resolve(root, 'src/data/index.js');
const hasData = existsSync(dataEntry);
if (!hasData) {
  // The data layer (src/data/) is owned by another workstream. Until it lands,
  // alias it to an empty stub so the visual layer still builds and boots.
  console.warn('[dashboard] src/data/index.js not found, using src/stub/data-stub.js');
}

export default defineConfig({
  resolve: {
    alias: hasData ? {} : { './data/index.js': resolve(root, 'src/stub/data-stub.js') },
  },
  server: {
    port: 5173,
    // The mock data layer may import JSON examples from ../contract/
    fs: { allow: [resolve(root, '..')] },
  },
  build: { chunkSizeWarningLimit: 1200 },
});
