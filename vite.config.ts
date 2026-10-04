/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { contentSecurityPolicy } from './tools/csp.ts';
import { licenceFiles, siteFolder } from './tools/vite-plugins.ts';

// The site folder holds one building: its site.json manifest, the model and the data files it names. It is not part of the
// app: point JARVIS_SITE at one (sites/ is git-ignored); without it, the demo house in examples/demo-site.
const site = process.env.JARVIS_SITE || 'examples/demo-site';

export default defineConfig({
  base: './',
  plugins: [siteFolder(site), licenceFiles()],
  server: { port: 5173, host: true },
  // the built viewer under the policy the container sends (the dev server has none: Vite's client needs more)
  preview: {
    port: 4173,
    host: true,
    headers: { 'Content-Security-Policy': contentSecurityPolicy(process.env.JARVIS_PLUGIN_ORIGINS) },
  },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500 },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'tools/**/*.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
