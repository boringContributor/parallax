import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // relative asset + data URLs → works at a domain root or under a subpath (e.g. GitHub Pages)
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
