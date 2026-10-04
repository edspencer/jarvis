// External plugins and lazy loading, on the demo house. The site manifest is patched in flight (page.route), so
// examples/demo-site stays as generated: one variant loads the guide's Measure plugin (docs/examples/measure.ts, built
// with tools/build-plugin.ts as a site would) from plugins/measure.js, and it measures, takes Esc after the core's
// inspector, and is refused from another origin unless pluginOrigins lists it; another variant drops the energy and
// blueprints sections, and their code is never fetched.
import { expect, test, type Page } from '@playwright/test';
import { buildPlugin } from '../../tools/build-plugin';
import { openViewer, twin, waitForLayers } from './helpers';

test.describe.configure({ mode: 'serial' });

let code: string;
test.beforeAll(async () => {
  code = await buildPlugin('docs/examples/measure.ts');
});

type Manifest = { id: string; plugins: Record<string, unknown>; pluginOrigins?: string[] };

/** open the viewer on the dev site with its manifest patched, serving the built Measure plugin at any
 * …/plugins/measure.js; returns every URL the page requested */
async function openPatched(page: Page, patch: (m: Manifest) => void, query = 'ha=mock&hamock=static&noextra') {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.route('**/site.json', async (route) => {
    const res = await route.fetch();
    const m = (await res.json()) as Manifest;
    patch(m);
    await route.fulfill({ response: res, json: m });
  });
  await page.route('**/plugins/measure.js', (route) =>
    route.fulfill({
      body: code,
      contentType: 'text/javascript',
      headers: { 'Access-Control-Allow-Origin': '*' }, // for the cross-origin case
    }),
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

test('loads the Measure plugin from the site: it measures, and Esc reaches it after the inspector', async ({
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
  // the measurement opened in the inspector: the first Esc is the core's (it closes the inspector) …
  await expect(page.locator('jv-inspector aside')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('jv-inspector aside')).toHaveCount(0);
  await expect(item(page)).toContainText('click the first point'); // still measuring
  // … the second goes to the plugin's binding: measuring stops
  await page.keyboard.press('Escape');
  await expect(item(page)).toHaveCount(0);
});

test("refuses a module from another origin, unless the manifest's pluginOrigins lists it", async ({ page }) => {
  // localhost and 127.0.0.1 are different origins for the same dev server
  const base = test.info().project.use.baseURL!.replace('//localhost:', '//127.0.0.1:');
  const requests = await openPatched(page, (m) => {
    m.plugins.measure = { module: `${base}plugins/measure.js` };
  });
  expect(await twin<boolean>(page, 'twin.host.running("measure")')).toBe(false);
  expect(requests.some((u) => u.startsWith(base) && u.endsWith('measure.js'))).toBe(false); // never fetched
  await expect(page.getByText(/The measure plugin didn't load: .* isn't the viewer's origin/)).toBeVisible();
});

test('loads it from another origin the manifest allows', async ({ page }) => {
  const base = test.info().project.use.baseURL!.replace('//localhost:', '//127.0.0.1:');
  await openPatched(page, (m) => {
    m.plugins.measure = { module: `${base}plugins/measure.js` };
    m.pluginOrigins = [new URL(base).origin];
  });
  expect(await twin<boolean>(page, 'twin.host.running("measure")')).toBe(true);
});
