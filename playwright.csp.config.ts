import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

// The built viewer under its Content-Security-Policy (tools/csp.ts): tests/csp checks the demo house loads with no
// violation and that the policy blocks a script from another origin. Against `vite preview` (run `npm run build`
// first), or a running container with CSP_BASE_URL=http://127.0.0.1:8080/ (the CI image job).
const PORT = Number(process.env.CSP_PORT || 5194);
const external = process.env.CSP_BASE_URL;

export default defineConfig({
  ...base,
  testDir: 'tests/csp',
  projects: [{ name: 'csp' }],
  use: { ...base.use, baseURL: external || `http://localhost:${PORT}/` },
  webServer: external
    ? undefined
    : {
        command: `npx vite preview --port ${PORT} --strictPort`,
        url: `http://localhost:${PORT}/`,
        reuseExistingServer: false,
        timeout: 30_000,
      },
});
