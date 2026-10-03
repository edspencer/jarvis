import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// The e2e tests drive the dev server against a real site folder (JARVIS_SITE, default sites/default) in mock Home
// Assistant mode. WebGL uses the GPU when there is one (a DRM render node; E2E_GPU=0 forces software), else ANGLE's
// software renderer, SwiftShader, which is ~50x slower: the tests share one page and have generous timeouts for it.
const PORT = Number(process.env.E2E_PORT || 5192);
const GPU = process.env.E2E_GPU ? process.env.E2E_GPU !== '0' : existsSync('/dev/dri/renderD128');
const GL_ARGS = GPU
  ? ['--use-angle=gl-egl', '--use-gl=angle', '--ignore-gpu-blocklist', '--enable-gpu']
  : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 10 * 60_000,
  expect: { timeout: 180_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: `http://localhost:${PORT}/`,
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      // a locally installed Chromium, if the one this Playwright version expects isn't installed
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
      args: GL_ARGS,
    },
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
