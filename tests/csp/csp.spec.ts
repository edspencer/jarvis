// The built viewer under its Content-Security-Policy (tools/csp.ts, deploy/nginx.conf): the demo house and every
// plugin start with no violation (the model's decoders compile WebAssembly, the Basis transcoder runs in blob:
// workers), and a script from another origin is refused by the browser itself, whatever the viewer's own checks say.
import { expect, test } from '@playwright/test';
import { openViewer, twin, waitForLayers, watchErrors } from '../e2e/helpers';

/** the same server under another origin: localhost <-> 127.0.0.1 */
const elsewhere = (u: string) =>
  u.includes('//localhost') ? u.replace('//localhost', '//127.0.0.1') : u.replace('//127.0.0.1', '//localhost');

test('the demo house loads under the CSP with no violation, and a script from another origin is blocked', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.addInitScript(() => {
    const w = window as unknown as { cspViolations: string[] };
    w.cspViolations = [];
    addEventListener('securitypolicyviolation', (e) => w.cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const res = await page.request.get('./');
  expect(res.headers()['content-security-policy']).toMatch(/script-src 'self'/);

  await openViewer(page, 'ha=mock&hamock=static');
  await waitForLayers(page);
  expect(await twin<boolean>(page, 'twin.host.running("energy")')).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([]);
  expect(errors).toEqual([]);

  // what a plugin module from another origin would meet, even past the viewer's checks (a redirect)
  const other = new URL('site.json', elsewhere(page.url())).href;
  const result = await page.evaluate(
    (u) =>
      import(/* @vite-ignore */ u).then(
        () => 'loaded',
        (e) => String(e),
      ),
    other,
  );
  expect(result).not.toBe('loaded');
  expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([
    `script-src-elem ${other}`,
  ]);
});
