// npm run screenshots: renders the demo house (or JARVIS_SITE) for the docs: the README's picture and the HUD mockup's
// backgrounds (docs/design/mockup). The viewer's own HUD is hidden, so only the 3D view is in the picture. Uses the GPU
// when there is a DRM render node, else SwiftShader (slower, same picture); PLAYWRIGHT_CHROMIUM_EXECUTABLE picks a
// local Chromium.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import { createServer } from 'vite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = { width: 1440, height: 900 };

interface Shot {
  file: string;
  /** console calls on window.twin, before the picture */
  setup: string;
}
const SHOTS: Shot[] = [
  {
    file: 'docs/img/demo-overview.jpg',
    setup: `twin.setSun(10.5, 160); twin.state.cutaway = true; twin.applyVisibility(); twin.setMode('orbit');`,
  },
  {
    file: 'docs/design/mockup/demo-overview.jpg',
    setup: `twin.setSun(10.5, 160); twin.state.cutaway = true; twin.applyVisibility(); twin.setMode('orbit');`,
  },
  {
    file: 'docs/design/mockup/demo-walk.jpg',
    setup: `twin.setSun(15, 276); twin.state.cutaway = false; twin.applyVisibility(); twin.setMode('walk');
      twin.teleport(6.5, 0.45, 0, 48); twin.player.pitch = -0.1;`,
  },
];

const GPU = process.env.E2E_GPU ? process.env.E2E_GPU !== '0' : existsSync('/dev/dri/renderD128');
const server = await createServer({ root: ROOT, server: { port: 0, host: '127.0.0.1' }, logLevel: 'warn' });
await server.listen();
const url = server.resolvedUrls!.local[0];
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  args: GPU
    ? ['--use-angle=gl-egl', '--use-gl=angle', '--ignore-gpu-blocklist', '--enable-gpu']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  const page: Page = await browser.newPage({ viewport: SIZE });
  await page.addInitScript(() => localStorage.setItem('twin.helpSeen', '1'));
  await page.goto(`${url}?ha=mock&hamock=static`);
  // the model, the extra models and the plugins' data all in
  await page.waitForFunction(
    () => {
      const t = (window as unknown as { twin?: { collider?: unknown; extras?: Record<string, { status: string }> } })
        .twin;
      return !!t?.collider && Object.values(t.extras || {}).every((x) => x.status === 'loaded');
    },
    null,
    { timeout: 5 * 60_000, polling: 500 },
  );
  // only the canvas
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    for (const el of document.querySelectorAll<HTMLElement>('body > *'))
      if (!canvas || !el.contains(canvas)) el.style.visibility = 'hidden';
  });
  for (const s of SHOTS) {
    await page.evaluate(`(() => { const twin = window.twin; ${s.setup} })()`);
    // a few frames, and time for the sun's shadows and the light pool to settle
    await page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      for (let i = 0; i < 4; i++) await frame();
      await new Promise((r) => setTimeout(r, 1500));
      for (let i = 0; i < 3; i++) await frame();
    });
    await page.screenshot({ path: join(ROOT, s.file), type: 'jpeg', quality: 85 });
    console.log(s.file);
  }
} finally {
  await browser.close();
  await server.close();
}
