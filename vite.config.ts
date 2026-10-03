/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { siteFolder } from './tools/vite-plugins.ts';

// The site folder holds one building: its site.json manifest, the model and the data files it names. It is not part of the
// app: point JARVIS_SITE at it (default sites/default; sites/ is git-ignored).
const site = process.env.JARVIS_SITE || 'sites/default';

export default defineConfig({
  base: './',
  plugins: [siteFolder(site)],
  server: { port: 5173, host: true },
  preview: { port: 4173, host: true },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500 },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
