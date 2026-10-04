// The built viewer under its Content-Security-Policy (tools/csp.ts, deploy/nginx.conf): the demo house (with its
// KTX2 plaque: the Basis transcoder runs in a blob: worker and compiles with new Function) and every plugin start with
// no violation and no EvalError, and a script from another origin is refused by the browser itself.
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

  await openViewer(page, 'ha=mock&hamock=static'); // the model in, colliders built
  await waitForLayers(page);
  // the plaque's KTX2 (Basis) texture went through the transcoder worker (embind compiles with new Function)
  if ((await twin<string>(page, 'twin.site.id')) === 'demo-house')
    expect(
      await twin<unknown>(
        page,
        `(() => { const t = twin.root.getObjectByName('Plaque_house_name')?.material?.map;
          return t && { compressed: !!t.isCompressedTexture, mips: t.mipmaps?.length, w: t.image?.width }; })()`,
      ),
    ).toEqual({ compressed: true, mips: 8, w: 128 });
  const records = await twin<{ id: string; state: string }[]>(
    page,
    'twin.host.records().map((r) => ({ id: r.def.id, state: r.state }))',
  );
  expect(records.filter((r) => r.state !== 'running')).toEqual([]);
  expect(records.length).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([]);
  expect(errors.filter((e) => /EvalError|Content Security Policy|unsafe-eval/i.test(e))).toEqual([]);
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
