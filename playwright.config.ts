import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// The e2e tests drive the dev server against a site folder (JARVIS_SITE, default the demo house in examples/demo-site)
// in mock Home Assistant mode. WebGL uses the GPU when there is one (a DRM render node; E2E_GPU=0 forces software), else ANGLE's
// software renderer, SwiftShader, which is ~50x slower: the tests share one page and have generous timeouts for it.
const PORT = Number(process.env.E2E_PORT || 5192);
const CI = !!process.env.CI;
const GPU = process.env.E2E_GPU ? process.env.E2E_GPU !== '0' : existsSync('/dev/dri/renderD128');
const GL_ARGS = GPU
  ? ['--use-angle=gl-egl', '--use-gl=angle', '--ignore-gpu-blocklist', '--enable-gpu']
  : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
// SwiftShader's cost is mostly fill rate: under it, the viewer renders at half resolution (openViewer reports a
// devicePixelRatio of 0.5; the page's layout is the same 1280 × 720). About 3x faster on 4 cores. E2E_PIXEL_RATIO overrides.
process.env.E2E_PIXEL_RATIO ??= GPU ? '' : '0.5';

// the HUD's specs (hud, a11y, the phone walk layout); "view" has the rest (the 3D view's layers, energy, the demo
// house, parity)
const HUD_SPECS = ['**/hud.spec.ts', '**/a11y.spec.ts', '**/mobile.spec.ts'];

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 10 * 60_000,
  expect: { timeout: 180_000 },
  workers: 1,
  fullyParallel: false,
  // CI: a blob report per shard (the workflow merges them into one HTML report, with the traces of failed tests), and
  // annotations on the PR
  reporter: CI ? [['list'], ['blob'], ['github']] : [['list']],
  outputDir: 'test-results',
  // two halves of about the same time under software WebGL, one per CI shard (Playwright's --shard keeps whole files
  // in order, which left one shard with most of the work). A new spec file lands in "view"; rebalance here if needed.
  projects: [
    { name: 'hud', testMatch: HUD_SPECS },
    { name: 'view', testIgnore: HUD_SPECS },
  ],
  use: {
    baseURL: `http://localhost:${PORT}/`,
    viewport: { width: 1280, height: 720 },
    // an action that can't happen fails with its reason ("<jv-status> intercepts pointer events") instead of retrying
    // until the 10-minute test timeout, which looks like a hang
    actionTimeout: 180_000,
    navigationTimeout: 5 * 60_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      // a locally installed Chromium, if the one this Playwright version expects isn't installed
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
      args: GL_ARGS,
    },
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    // never someone else's server: a dev server already on the port may be another checkout's (another branch). With
    // --strictPort a busy port fails the run instead; pick another with E2E_PORT, or E2E_REUSE_SERVER=1 to use yours.
    reuseExistingServer: !CI && process.env.E2E_REUSE_SERVER === '1',
    timeout: 60_000,
  },
});
