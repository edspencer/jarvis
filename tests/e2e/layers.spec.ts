// The 3D view against the dev site (any site folder) with mock Home Assistant: loads to walkable with no console errors,
// and the keys and the status strip's chips change what is shown (cutaway, storeys, the site's layers, ghost, the
// overview, pins, plates, faults, blueprints, extra models). Tests read the site's layers and plugins from the manifest
// (window.twin.site); a test whose layer or plugin the site lacks is skipped. The HUD's elements are in shadow roots;
// Playwright's CSS locators reach into them. The HUD itself is in hud.spec.ts.
import { expect, test, type Page } from '@playwright/test';
import { openViewer, twin, viewerHelpers, waitForLayers, watchErrors } from './helpers';

test.describe.configure({ mode: 'serial' });

let page: Page;
let errors: string[];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  errors = watchErrors(page);
  await openViewer(page, 'ha=mock&hamock=static&noextra&sun=15,276');
  await waitForLayers(page);
});

test.afterAll(async () => {
  await page.close();
});

const { shown, needs, press, chip, insp, closeInspector, siteLayers } = viewerHelpers(() => page);

test('loads to walkable with every plugin up and no console errors', async () => {
  await expect(page.locator('#loading')).toBeHidden();
  expect(await twin<number>(page, 'Object.keys(twin.fixtures).length')).toBeGreaterThan(0);
  expect(await twin<string>(page, 'twin.state.mode')).toBe('walk');
  const failed = await twin<string[]>(
    page,
    `twin.host.records().filter((r) => r.state !== 'running').map((r) => r.def.id + ': ' + r.error)`,
  );
  expect(failed).toEqual([]);
  await expect(page.locator('jv-status [data-mode="walk"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('jv-status [data-item="core.place"]')).not.toBeEmpty();
  await expect(page.locator('#hud, #info, #flags')).toHaveCount(0); // the old HUD is gone
  expect(errors).toEqual([]);
});

test('X (cutaway) hides ceilings and roofs, and its chip shows it and switches it back', async () => {
  const ceil = await shown('ceiling');
  const roof = await shown('roof');
  expect(ceil).toBeGreaterThan(0);
  await press('x');
  expect(await twin<boolean>(page, 'twin.state.cutaway')).toBe(true);
  expect(await shown('ceiling')).toBe(0);
  expect(await shown('roof')).toBe(0);
  await expect(chip('core.cutaway')).toHaveAttribute('aria-pressed', 'true');
  await chip('core.cutaway').click(); // a chip is a real button: the same as the key
  expect(await twin<boolean>(page, 'twin.state.cutaway')).toBe(false);
  expect(await shown('ceiling')).toBe(ceil);
  expect(await shown('roof')).toBe(roof);
});

test('U hides the upper storey', async () => {
  const upper = await shown('upper');
  test.skip(!upper, 'a one-storey site');
  await press('u');
  expect(await shown('upper')).toBe(0);
  await press('u');
  expect(await shown('upper')).toBe(upper);
});

test("each of the site's layer keys toggles its layer, and so does its entry in the strip's ⋯ menu", async () => {
  const layers = (await siteLayers()).filter((l) => l.key && !l.model);
  test.skip(!layers.length, 'the site declares no keyed layers');
  for (const l of layers) {
    const n = await twin<number>(page, `twin.groups.${l.id}.length`);
    expect(n, `layer ${l.id} takes nodes`).toBeGreaterThan(0);
    const before = await shown(l.id);
    expect(before, `${l.id} at start`).toBe(l.hidden ? 0 : n);
    await press(l.key!.toLowerCase());
    expect(await shown(l.id), `${l.id} toggled`).toBe(l.hidden ? n : 0);
    await press(l.key!.toLowerCase());
    expect(await shown(l.id), `${l.id} back`).toBe(before);
  }
  const l = layers[0];
  const n = await twin<number>(page, `twin.groups.${l.id}.length`);
  await chip('more').click();
  await page
    .getByRole('menuitemcheckbox', { name: new RegExp(`\\b${l.key}$`) })
    .first()
    .click();
  expect(await shown(l.id)).toBe(l.hidden ? n : 0);
  await press(l.key!.toLowerCase());
  expect(await shown(l.id)).toBe(l.hidden ? 0 : n);
});

test('G toggles ghost mode', async () => {
  expect(await twin<boolean>(page, 'twin.state.ghost')).toBe(true);
  await press('g');
  expect(await twin<boolean>(page, 'twin.state.ghost')).toBe(false);
  await expect(chip('core.ghost')).toHaveAttribute('aria-pressed', 'false');
  await press('g');
  await expect(chip('core.ghost')).toHaveAttribute('aria-pressed', 'true');
});

test('Tab and the mode switch go to the overview and back', async () => {
  await press('Tab');
  expect(await twin<string>(page, 'twin.state.mode')).toBe('orbit');
  await expect(page.locator('#cross')).toBeHidden();
  await page.locator('jv-status [data-mode="walk"]').click();
  expect(await twin<string>(page, 'twin.state.mode')).toBe('walk');
  await expect(page.locator('#cross')).toBeVisible();
});

test('P shows the equipment pins and the chip follows; Shift-P through walls', async () => {
  await needs('pins');
  const vis = (name: string) => twin<boolean>(page, `twin.scene.getObjectByName('${name}').visible`);
  expect(await vis('Pins')).toBe(false);
  await press('p');
  expect(await vis('Pins')).toBe(true);
  await expect(chip('pins')).toHaveAttribute('aria-pressed', 'true');
  await press('Shift+P');
  expect(await vis('Pins_through_walls')).toBe(true);
  await press('Shift+P');
  await chip('pins').click();
  expect(await vis('Pins')).toBe(false);
});

test('L highlights the wall plates', async () => {
  await needs('switches');
  const vis = () => twin<boolean>(page, `twin.scene.getObjectByName('Switches_marks').visible`);
  expect(await vis()).toBe(false);
  await press('l');
  expect(await vis()).toBe(true);
  await expect(page.locator('jv-legend [data-legend="plates"]')).toBeVisible();
  await press('l');
  expect(await vis()).toBe(false);
});

test('V shows faults through walls (mock): chip, markers, legend, badge, and the panel lists them by room', async () => {
  await needs('faults');
  await press('v');
  expect(await twin<boolean>(page, 'twin.faults.on')).toBe(true);
  await expect(chip('faults')).toHaveAttribute('aria-pressed', 'true');
  // step the markers' update in the page instead of waiting for frames (a CI runner renders a frame or two a second)
  expect(
    await twin<boolean>(page, '(twin.faults.update(0.05), twin.faults.points.visible)'),
    'fault markers drawn',
  ).toBe(true);
  await expect(page.locator('jv-legend [data-legend="faults"]')).toContainText('Device health');
  await expect(page.locator('jv-rail button[data-panel="faults"] .badge')).not.toBeEmpty();
  await page.locator('jv-rail button[data-panel="faults"]').click();
  const panel = page.locator('jv-dock section[data-panel="faults"]');
  await expect(panel.locator('.grp').first()).toBeVisible();
  await panel.locator('.li.act').first().click(); // a device: fly there and open it
  await expect(insp().locator('[data-section="faults"]')).toBeVisible();
  await panel.locator('button[aria-label^="Close"]').click();
  await closeInspector();
  await press('v');
  await expect(page.locator('jv-legend [data-legend="faults"]')).toHaveCount(0);
});

test('B shows a blueprint sheet, fades the model and names the sheet in the legend', async () => {
  await needs('blueprints');
  await press('b');
  await page.waitForFunction(() => !!(window as unknown as { twin: { bp: { mesh: unknown } } }).twin.bp.mesh, null, {
    timeout: 120_000,
  });
  expect(await twin<boolean>(page, 'twin.bp.faded.size > 0')).toBe(true);
  await expect(page.locator('jv-legend [data-legend="blueprints"]')).toBeVisible();
  await press('b');
  expect(await twin<boolean>(page, 'twin.bp.mesh === null && twin.bp.faded.size === 0')).toBe(true);
});

test("an extra model's key loads it (?noextra), then hides and shows it", async () => {
  const l = (await siteLayers()).find((x) => x.key && x.model);
  test.skip(!l, 'the site has no keyed extra model');
  const key = l!.key!.toLowerCase();
  expect(await twin<string>(page, `twin.extras[${JSON.stringify(l!.model)}].status`)).toBe('none');
  await press(key);
  await page.waitForFunction(
    (id) =>
      (window as unknown as { twin: { extras: Record<string, { status: string }> } }).twin.extras[id].status !==
      'loading',
    l!.model!,
    { timeout: 5 * 60_000, polling: 1000 },
  );
  expect(await twin<string>(page, `twin.extras[${JSON.stringify(l!.model)}].status`)).toBe('loaded');
  const n = await shown(l!.id);
  expect(n).toBeGreaterThan(0);
  await press(key);
  expect(await shown(l!.id)).toBe(0);
  await press(key);
  expect(await shown(l!.id)).toBe(n);
});

test('no console errors after all that', () => {
  expect(errors).toEqual([]);
});

test('reports which WebGL renderer ran the tests', async () => {
  const renderer = await twin<string>(
    page,
    `(() => { const gl = twin.renderer.getContext(); const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })()`,
  );
  console.log(`WebGL renderer: ${renderer}`);
  expect(renderer).toBeTruthy();
});
