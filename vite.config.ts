import { crx } from '@crxjs/vite-plugin';
import { defineConfig } from 'vite';

import manifest from './manifest.json' with { type: 'json' };

export default defineConfig({
  publicDir: 'public',
  plugins: [crx({ manifest })],
  build: {
    chunkSizeWarningLimit: 1_100,
    rollupOptions: {
      input: ['index.html', 'offscreen.html'],
    },
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
});
