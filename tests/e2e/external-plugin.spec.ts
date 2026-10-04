// External plugins and lazy loading, on the demo house. The site manifest is patched in flight (page.route), so
// examples/demo-site stays as generated: one variant loads the guide's Measure plugin (docs/examples/measure.ts, built
// with tools/build-plugin.ts as a site would) from plugins/measure.js, and it measures and takes Esc before the
// inspector does. The trust rules: a module from another origin only if pluginOrigins lists it; never from a manifest
// on another origin, even one reached through a redirect on the viewer's origin; never through a redirect. Another
// variant drops the energy and blueprints sections, and their code is never fetched.
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { buildPlugin } from '../../tools/build-plugin';
import { openViewer, twin, waitForLayers } from './helpers';

test.describe.configure({ mode: 'serial' });

let code: string;
test.beforeAll(async () => {
  code = await buildPlugin('docs/examples/measure.ts');
});

type Manifest = { id: string; plugins: Record<string, unknown>; pluginOrigins?: string[] };

/** the dev server under another origin (localhost and 127.0.0.1 are different origins for the same server) */
const elsewhere = () => test.info().project.use.baseURL!.replace('//localhost:', '//127.0.0.1:');

/** open the viewer on the dev site with its manifest patched, serving the built Measure plugin at any
 * …/plugins/measure.js and answering /go?u=<url> with a redirect there (an open redirect on the viewer's origin);
 * the other origin answers with CORS headers, as a hostile host would. Returns every URL the page requested. */
async function openPatched(page: Page, patch: (m: Manifest) => void, query = 'ha=mock&hamock=static&noextra') {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  const cors = { 'access-control-allow-origin': '*' };
  await page.route(
    (u) => u.origin === new URL(elsewhere()).origin,
    async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, headers: { ...res.headers(), ...cors } });
    },
  );
  await page.route(
    (u) => u.pathname === '/go',
    (route) =>
      route.fulfill({ status: 302, headers: { location: new URL(route.request().url()).searchParams.get('u')! } }),
  );
  await page.route('**/site.json', async (route) => {
    const res = await route.fetch();
    const m = (await res.json()) as Manifest;
    patch(m);
    await route.fulfill({ response: res, json: m, headers: { ...res.headers(), ...cors } });
  });
  await page.route('**/plugins/measure.js', (route) =>
    route.fulfill({ body: code, contentType: 'text/javascript', headers: cors }),
  );
  await openViewer(page, query);
  test.skip((await twin<string>(page, 'twin.site.id')) !== 'demo-house', 'only for the demo house');
  await waitForLayers(page);
  return requests;
}

/** Measure's status item (shown while measuring) */
const item = (page: Page) => page.locator('jv-status [data-item="measure"]');

test('a site without energy or blueprints never downloads their code', async ({ page }) => {
  const requests = await openPatched(page, (m) => {
    delete m.plugins.energy;
    delete m.plugins.blueprints;
  });
  const fetched = (dir: string) => requests.some((u) => u.includes(`/src/plugins/${dir}/`));
  expect(fetched('pins')).toBe(true); // enabled: fetched (and the pattern matches the dev server's module URLs)
  expect(fetched('sun')).toBe(true); // autoStart
  expect(fetched('energy')).toBe(false);
  expect(fetched('blueprints')).toBe(false);
  expect(await twin<boolean>(page, 'twin.host.running("energy")')).toBe(false);
});

test('loads the Measure plugin from the site: it measures, and Esc cancels it before closing the inspector', async ({
  page,
}) => {
  const requests = await openPatched(page, (m) => {
    m.plugins.measure = { module: 'plugins/measure.js', decimals: 3 };
  });
  expect(requests.some((u) => u.endsWith('/plugins/measure.js'))).toBe(true);
  expect(await twin<boolean>(page, 'twin.host.running("measure")')).toBe(true);
  // its keys are in help, under its name
  expect(
    await twin<string[]>(page, 'twin.keyRegistry.list().filter((k) => k.owner === "measure").map((k) => k.code)'),
  ).toEqual(['KeyM', 'KeyM', 'Escape']);

  await page.keyboard.press('Tab'); // the overview: clicks pick under the mouse
  await page.keyboard.press('m');
  await expect(item(page)).toContainText('click the first point');
  const box = (await page.locator('canvas').boundingBox())!;
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  await page.mouse.click(cx, cy);
  await expect(item(page)).toContainText('click the second point');
  await page.mouse.click(cx + 60, cy + 20);
  await expect.poll(() => twin<number>(page, 'twin.measure.list().length'), { message: 'a measurement' }).toBe(1);
  // the measurement opened in the inspector; one Esc stops measuring (the active tool goes first) …
  await expect(page.locator('jv-inspector aside')).toHaveCount(1);
  await expect(item(page)).toContainText('click the first point');
  await page.keyboard.press('Escape');
  await expect(item(page)).toHaveCount(0);
  await expect(page.locator('jv-inspector aside')).toHaveCount(1);
  // … the next closes the inspector
  await page.keyboard.press('Escape');
  await expect(page.locator('jv-inspector aside')).toHaveCount(0);
});

const measureJs = (requests: string[], origin: string) =>
  requests.some((u) => u.startsWith(origin) && u.endsWith('/plugins/measure.js'));
const refused = (page: Page, why: RegExp) =>
  expect(page.getByText(new RegExp(`The measure plugin didn't load: .*${why.source}`))).toBeVisible();

test("refuses a module from another origin, unless the manifest's pluginOrigins lists it", async ({ page }) => {
  const base = elsewhere();
  const requests = await openPatched(page, (m) => {
    m.plugins.measure = { module: `${base}plugins/measure.js` };
  });
  expect(await twin<boolean>(page, 'twin.host.running("measure")')).toBe(false);
  expect(measureJs(requests, base)).toBe(false); // never fetched
  await refused(page, /isn't the viewer's origin/);
});

test('loads it from another origin the manifest allows', async ({ page }) => {
  const base = elsewhere();
  await openPatched(page, (m) => {
    m.plugins.measure = { module: `${base}plugins/measure.js` };
    m.pluginOrigins = [new URL(base).origin];
  });
  expect(await twin<boolean>(page, 'twin.host.running("measure")')).toBe(true);
});

/** the demo manifest with Measure from its own folder, and that folder's origin allowed */
const hostile = (m: Manifest) => {
  m.plugins.measure = { module: 'plugins/measure.js' };
  m.pluginOrigins = [new URL(elsewhere()).origin];
};

test("a manifest from another origin (?site=) can't bring code, whatever its pluginOrigins say", async ({ page }) => {
  const base = elsewhere();
  const requests = await openPatched(page, hostile, `site=${encodeURIComponent(`${base}site.json`)}&ha=mock&noextra`);
  expect(await twin<string>(page, 'twin.site.url')).toBe(`${base}site.json`);
  expect(await twin<boolean>(page, 'twin.host.running("measure")')).toBe(false);
  expect(measureJs(requests, base)).toBe(false);
  await refused(page, /a manifest from another origin can't bring code/);
});

test("an open redirect on the viewer's origin doesn't make another origin's manifest its own", async ({ page }) => {
  // Playwright doesn't route a redirect's next hop, so the hostile manifest is a real file the dev server serves:
  // the demo's, with Measure from that folder, its origin allowed, and its model at absolute URLs
  const base = elsewhere();
  const m = (await (await page.request.get('site.json')).json()) as Manifest & {
    models: { main: { url: string; parts?: string }; extra?: unknown[] };
  };
  m.models = { main: { url: `${base}${m.models.main.url}`, parts: `${base}${m.models.main.parts}` } };
  m.plugins = { measure: { module: 'plugins/measure.js' } };
  m.pluginOrigins = [new URL(base).origin];
  mkdirSync('test-results/hostile-site', { recursive: true });
  writeFileSync('test-results/hostile-site/site.json', JSON.stringify(m));
  const target = `${base}test-results/hostile-site/site.json`;
  const via = `/go?u=${encodeURIComponent(target)}`; // ?site= on the viewer's origin, redirected away
  const requests = await openPatched(page, () => {}, `site=${encodeURIComponent(via)}&noextra`);
  expect(await twin<string>(page, 'twin.site.url')).toBe(target); // where it really came from
  expect(await twin<boolean>(page, 'twin.host.running("measure")')).toBe(false);
  expect(measureJs(requests, base)).toBe(false);
  await refused(page, /a manifest from another origin can't bring code/);
});

test("a module URL on the viewer's origin that redirects elsewhere is never imported", async ({ page }) => {
  const base = elsewhere();
  const requests = await openPatched(page, (m) => {
    m.plugins.measure = { module: `go?u=${encodeURIComponent(`${base}plugins/measure.js`)}` };
  });
  expect(await twin<boolean>(page, 'twin.host.running("measure")')).toBe(false);
  expect(measureJs(requests, base)).toBe(false); // the redirect wasn't followed
  await refused(page, /redirects: a plugin module is loaded only from its own URL/);
});
