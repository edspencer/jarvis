// The live demo (npm run build:pages) at a sub-path: the viewer, the demo house and every file they fetch load from
// under /jarvis/, and Home Assistant is the mock without asking for it.
import { expect, test } from '@playwright/test';
import { twin, watchErrors } from '../e2e/helpers';

test('the demo loads under /jarvis/ with mock Home Assistant', async ({ page }) => {
  const errors = watchErrors(page);
  const outside: string[] = [];
  const failed: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol.startsWith('http') && !u.pathname.startsWith('/jarvis/')) outside.push(r.url());
  });
  page.on('response', (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });
  await page.addInitScript(() => localStorage.setItem('twin.helpSeen', '1'));
  await page.goto('./');
  await page.waitForFunction(() => !!(window as unknown as { twin?: { collider?: unknown } }).twin?.collider, null, {
    timeout: 5 * 60_000,
    polling: 500,
  });
  expect(new URL(page.url()).searchParams.get('ha'), 'index.html added ?ha=mock').toBe('mock');
  expect(await twin<string>(page, 'twin.site.id')).toBe('demo-house');
  await page.waitForFunction(
    () => (window as unknown as { twin: { ha?: { status?: string } } }).twin.ha?.status === 'mock',
    null,
    {
      timeout: 60_000,
    },
  );
  // the KTX2 transcoder resolves next to its loader: fetch it from where the bundle says it is
  const transcoder = await page.evaluate(async () => {
    const js = [...document.querySelectorAll<HTMLScriptElement>('script[type=module][src]')].map((s) => s.src);
    const text = (await Promise.all(js.map((u) => fetch(u).then((r) => r.text())))).join('\n');
    const names = [...new Set(text.match(/basis_transcoder-[\w-]+\.(?:js|wasm)/g) || [])];
    const base = new URL('assets/', location.href);
    return Promise.all(names.map(async (n) => [n, (await fetch(new URL(n, base))).status] as const));
  });
  expect(transcoder.length, 'the bundle names the Basis transcoder').toBeGreaterThan(0);
  for (const [name, status] of transcoder) expect(status, name).toBe(200);
  expect(outside, 'requests outside /jarvis/').toEqual([]);
  expect(failed, 'failed requests').toEqual([]);
  expect(errors, 'console errors').toEqual([]);
});

test('?ha=off is left alone', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('twin.helpSeen', '1'));
  await page.goto('./?ha=off');
  expect(new URL(page.url()).searchParams.get('ha')).toBe('off');
});
