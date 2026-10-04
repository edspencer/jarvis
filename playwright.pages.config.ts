import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

// The live demo's build (npm run build:pages) served under /jarvis/, as GitHub Pages will: tests/pages checks that the
// viewer loads at a sub-path with the demo house and mock Home Assistant. Run `npm run build && npm run build:pages`
// first; the same browser and WebGL settings as the e2e tests.
const PORT = Number(process.env.PAGES_PORT || 5193);

export default defineConfig({
  ...base,
  testDir: 'tests/pages',
  projects: [{ name: 'pages' }], // (not the e2e config's two halves)
  use: { ...base.use, baseURL: `http://localhost:${PORT}/jarvis/` },
  webServer: {
    command: `node tools/serve-pages.ts ${PORT}`,
    url: `http://localhost:${PORT}/jarvis/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
