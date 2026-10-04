// Smoke test against the dev site (any site folder) with mock Home Assistant: loads to walkable with no console errors,
// the keys and the status strip's chips change what is shown, every rail button opens its panel, the inspector
// gathers sections from several plugins, a mock light switches (and a failed call says so), help lists only the
// running plugins' keys, and search finds a room. Tests read the site's layers and plugins from the manifest
// (window.twin.site); a test whose layer or plugin the site lacks is skipped. The HUD's elements are in shadow roots;
// Playwright's CSS locators reach into them.
import { expect, test, type Page } from '@playwright/test';
import { openViewer, twin, waitForLayers, watchErrors } from './helpers';

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

/** number of visible top-level nodes in a group */
const shown = (group: string) => twin<number>(page, `twin.groups.${group}.filter((o) => o.visible).length`);
/** wait until the viewer has drawn a frame */
const nextFrame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
/** skip a test unless the plugin is running on this site */
const needs = async (plugin: string) =>
  test.skip(!(await twin<boolean>(page, `twin.host.running(${JSON.stringify(plugin)})`)), `the site has no ${plugin}`);
const press = async (key: string) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(150);
};
const chip = (id: string) => page.locator(`jv-status [data-chip="${id}"]`);
const insp = () => page.locator('jv-inspector aside');
const closeInspector = async () => {
  await page.locator('jv-inspector #inspector-close').click();
  await expect(insp()).toHaveCount(0);
};

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

interface LayerInfo {
  id: string;
  key: string | null;
  hidden: boolean;
  model: string | null;
}
const siteLayers = () =>
  twin<LayerInfo[]>(page, 'twin.site.layers.map((l) => ({ id: l.id, key: l.key, hidden: l.hidden, model: l.model }))');

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

test('every rail button opens its panel in the dock; at most two stay open', async () => {
  const ids = await page
    .locator('jv-rail nav > button[data-panel]')
    .evaluateAll((bs) =>
      bs.map((b) => (b as HTMLElement).dataset.panel!).filter((id) => id !== 'search' && id !== 'help'),
    );
  expect(ids.length).toBeGreaterThanOrEqual(2); // Navigate and Sun & time on any site
  for (const [i, id] of ids.entries()) {
    await page.locator(`jv-rail button[data-panel="${id}"]`).click();
    await expect(page.locator(`jv-dock section[data-panel="${id}"]`), id).toBeVisible();
    await expect(page.locator(`jv-dock section[data-panel="${id}"] h2`)).not.toBeEmpty();
    await expect(page.locator('jv-dock section[data-panel]')).toHaveCount(Math.min(2, i + 1));
  }
  for (const id of ids) {
    const s = page.locator(`jv-dock section[data-panel="${id}"]`);
    if (await s.count()) await s.locator('button[aria-label^="Close"]').click();
  }
  await expect(page.locator('jv-dock section[data-panel]')).toHaveCount(0);
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
  expect(await twin<boolean>(page, 'twin.bp.saved.size > 0')).toBe(true);
  await expect(page.locator('jv-legend [data-legend="blueprints"]')).toBeVisible();
  await press('b');
  expect(await twin<boolean>(page, 'twin.bp.mesh === null && twin.bp.saved.size === 0')).toBe(true);
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

test('a click in the overview inspects the object under the mouse; the Object section has its details', async () => {
  await press('Tab');
  await nextFrame();
  // a point on the canvas with the model under it, clear of the HUD
  const at = await twin<{ x: number; y: number } | null>(
    page,
    `(() => {
      for (let y = 160; y < 600; y += 40) for (let x = 420; x < 900; x += 40) {
        if (document.elementFromPoint(x, y)?.tagName !== 'CANVAS') continue;
        const ndc = new twin.THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
        const s = twin.pickAt(ndc);
        if (s && s.kind === 'object') return { x, y };
      }
      return null;
    })()`,
  );
  expect(at).not.toBeNull();
  await page.mouse.click(at!.x, at!.y);
  await expect(insp()).toBeVisible();
  await expect(insp().locator('h2')).not.toBeEmpty();
  const obj = insp().locator('[data-section="core.object"]');
  await obj.locator('.sh').click(); // collapsed by default
  await expect(obj).toContainText('Hit at');
  await obj.locator('.sh').click();
  await page.keyboard.press('Escape'); // Esc closes the inspector (no pointer lock in the overview)
  await expect(insp()).toHaveCount(0);
  await press('Tab');
});

/** a fixture the model may switch, on a mock entity that is on or off; preferably one that is also a registry item */
const switchable = () =>
  twin<string>(
    page,
    `(() => {
      const ok = Object.keys(twin.lights.fx).filter((id) => !twin.lights.blocker(id) && ['on', 'off'].includes(twin.store.get(twin.lights.entityOf(id))?.state));
      return ok.find((id) => twin.pins?.byFixture?.(id)) || ok[0];
    })()`,
  );

test('a fixture gathers sections from several plugins: Light, Equipment, Home Assistant, Object', async () => {
  await needs('lights');
  const fid = await switchable();
  expect(fid).toBeTruthy();
  await twin(page, `twin.inspect('fixture:' + ${JSON.stringify(fid)})`);
  await expect(insp()).toBeVisible();
  const ids = await insp()
    .locator('[data-section]')
    .evaluateAll((ss) => ss.map((s) => (s as HTMLElement).dataset.section));
  expect(ids).toContain('lights');
  expect(ids).toContain('home-assistant');
  expect(ids.at(-1)).toBe('core.object');
  if (await twin<boolean>(page, `!!twin.pins?.byFixture?.(${JSON.stringify(fid)})`)) expect(ids).toContain('pins');
  expect(new Set(await insp().locator('[data-section] .src').allTextContents()).size).toBeGreaterThanOrEqual(3);
});

test("the Light section's button switches the mock light, without re-rendering the inspector wholesale", async () => {
  await needs('lights');
  const fid = await switchable();
  await twin(page, `twin.inspect('fixture:' + ${JSON.stringify(fid)})`);
  const entity = await twin<string>(page, `twin.lights.entityOf(${JSON.stringify(fid)})`);
  const before = await twin<string>(page, `twin.store.get(${JSON.stringify(entity)}).state`);
  const button = insp().locator('.if .btn.primary');
  await expect(button).toContainText(before === 'on' ? 'Turn off' : 'Turn on');
  // the header stays the same DOM node through live updates (Lit diffs; the old panel rewrote innerHTML every 300 ms)
  await insp()
    .locator('h2')
    .evaluate((h) => ((window as unknown as { __h: Element }).__h = h));
  await button.click();
  const after = before === 'on' ? 'off' : 'on';
  await page.waitForFunction(
    ([e, s]) =>
      (window as unknown as { twin: { store: { get(e: string): { state: string } } } }).twin.store.get(e)?.state === s,
    [entity, after],
  );
  expect(await twin<string>(page, `twin.lights.look(${JSON.stringify(fid)}).kind`)).toBe(after);
  expect(await twin<string>(page, 'twin.ha.mock.calls.at(-1).domain')).toBe(entity.split('.')[0]);
  await expect(button).toContainText(after === 'on' ? 'Turn off' : 'Turn on');
  expect(
    await insp()
      .locator('h2')
      .evaluate((h) => h === (window as unknown as { __h: Element }).__h),
  ).toBe(true);
  // the ok toast times out after 4 s, which at a frame or two a second can pass before a DOM check runs: assert on
  // the HUD's record of toasts instead (the error-toast test below checks the DOM: an error toast stays up)
  await expect
    .poll(() => twin<{ text: string; tone?: string }[]>(page, 'twin.hud.toastLog'))
    .toContainEqual(expect.objectContaining({ tone: 'ok', text: expect.stringContaining(`Turned ${after}`) }));
});

test('a failed call (mock) shows an error toast and puts the real state back', async () => {
  await needs('lights');
  const fid = await switchable();
  await twin(page, `twin.inspect('fixture:' + ${JSON.stringify(fid)})`);
  const look = await twin<string>(page, `twin.lights.look(${JSON.stringify(fid)}).kind`);
  await twin(page, `twin.ha.mock.failNext = 'the bulb said no'`);
  await insp().locator('.if .btn.primary').click();
  const toast = page.locator('jv-toasts [data-tone="bad"]');
  await expect(toast).toContainText('the bulb said no');
  expect(await twin<string>(page, `twin.lights.look(${JSON.stringify(fid)}).kind`)).toBe(look);
  await expect(insp().locator('[data-section="lights"]')).toContainText('the bulb said no');
  await toast.locator('button[aria-label="Dismiss"]').click();
  await expect(toast).toHaveCount(0);
  await closeInspector();
});

test('the Home Assistant status item opens the connector modal (focus stays in it; Esc closes)', async () => {
  await needs('home-assistant');
  await page.locator('jv-status [data-item="home-assistant"]').click();
  const m = page.locator('jv-modal [role="dialog"]');
  await expect(m).toContainText('mock data');
  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
  expect(await page.locator('jv-modal').evaluate((el) => !!el.shadowRoot!.activeElement)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(m).toHaveCount(0);
});

test('search (/) finds a room and goes there', async () => {
  const label = await twin<string | null>(
    page,
    `(() => { const r = twin.root && Object.values(twin.fixtures).find((n) => n.userData.room)?.userData.room; return r ? String(r).replace(/_/g, ' ') : null; })()`,
  );
  test.skip(!label, 'no named rooms');
  await press('/');
  const box = page.locator('jv-search input');
  await expect(box).toBeFocused();
  await box.fill(label!);
  await expect(page.locator('jv-search .li').first()).toBeVisible();
  await box.press('Enter');
  await expect(page.locator('jv-search input')).toHaveCount(0);
});

test('help is generated from the key registry: the viewpoints, the layer keys, and only the running plugins', async () => {
  await press('h');
  const help = page.locator('jv-modal [role="dialog"]');
  await expect(help).toBeVisible();
  for (const n of await twin<string[]>(page, 'twin.site.viewpoints.map((v) => v.name)'))
    await expect(help).toContainText(n);
  for (const l of (await siteLayers()).filter((x) => x.key))
    await expect(help.locator('.kv .k', { hasText: new RegExp(`^${l.key}$`) })).toHaveCount(1);
  const groups = await twin<string[]>(
    page,
    `[...new Set(twin.keyRegistry.list().filter((k) => !k.hidden).map((k) => k.group || k.ownerName))]`,
  );
  for (const g of groups) await expect(help.locator('.lbl', { hasText: new RegExp(`^${g}$`) })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);
  // stop a plugin: its keys leave the registry and the help (last: the pins are gone for the tests after this)
  if (await twin<boolean>(page, `twin.host.running('pins')`)) {
    await twin(page, `twin.host.dispose('pins')`);
    await press('h');
    await expect(help).toBeVisible();
    await expect(help.locator('.lbl', { hasText: /^Equipment pins$/ })).toHaveCount(0);
    await expect(help.locator('.kv .k', { hasText: /^P$/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
  }
  expect(await page.title()).toContain(await twin<string>(page, 'twin.site.name'));
});

test("the HUD's components work as custom elements for a plugin's own UI (<jv-meter>, <jv-list>, <jv-blocks>)", async () => {
  await page.evaluate(() => {
    const box = document.createElement('div');
    box.id = 'custom-ui';
    const m = Object.assign(document.createElement('jv-meter'), { spark: [1, 3, 2, 5] });
    m.setAttribute('value', '1210');
    m.setAttribute('unit', 'W');
    const l = Object.assign(document.createElement('jv-list'), { rows: [{ text: 'Coffee machine', value: '900 W' }] });
    const b = Object.assign(document.createElement('jv-blocks'), {
      blocks: [{ type: 'kv', rows: [['Today', '3.2 kWh']] }],
    });
    box.append(m, l, b);
    document.body.append(box);
  });
  await expect(page.locator('#custom-ui jv-meter')).toContainText('1210');
  await expect(page.locator('#custom-ui jv-list')).toContainText('Coffee machine');
  await expect(page.locator('#custom-ui jv-blocks')).toContainText('3.2 kWh');
  await page.evaluate(() => document.getElementById('custom-ui')!.remove());
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
