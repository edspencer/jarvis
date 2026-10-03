// Smoke test against the dev site (any site folder) with mock Home Assistant: loads to walkable with no console errors,
// the toggles and the site's own layers change what is shown, a click inspects, and a mock light switches. The layer
// tests read the site's layers from the manifest (window.twin.site); a test whose layer or plugin the site lacks is
// skipped.
import { expect, test, type Page } from '@playwright/test';
import { openViewer, twin, waitForLayers, watchErrors } from './helpers';

test.describe.configure({ mode: 'serial' });

let page: Page;
let errors: string[];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  errors = watchErrors(page);
  await openViewer(page, 'ha=mock&hamock=static&noextra&sun=15,276');
});

test.afterAll(async () => {
  await page.close();
});

test('loads to walkable with no console errors', async () => {
  await expect(page.locator('#loading')).toBeHidden();
  expect(await twin<number>(page, 'Object.keys(twin.fixtures).length')).toBeGreaterThan(0);
  expect(await twin<string>(page, 'twin.state.mode')).toBe('walk');
  await waitForLayers(page);
  await expect(page.locator('#flags')).toContainText('Walk');
  expect(errors).toEqual([]);
});

/** number of visible top-level nodes in a group */
const shown = (group: string) => twin<number>(page, `twin.groups.${group}.filter((o) => o.visible).length`);
/** wait until the viewer has drawn a frame (software WebGL can take seconds per frame) */
const nextFrame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
/** skip a test unless the site configures this plugin */
const needs = async (plugin: string) =>
  test.skip(
    !(await twin<boolean>(page, `!!twin.site.plugins[${JSON.stringify(plugin)}]`)),
    `the site has no ${plugin}`,
  );
const press = async (key: string) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(150);
};

test('X (cutaway) hides ceilings and roofs, and back', async () => {
  const ceil = await shown('ceiling');
  const roof = await shown('roof');
  expect(ceil).toBeGreaterThan(0);
  await press('x');
  expect(await twin<boolean>(page, 'twin.state.cutaway')).toBe(true);
  expect(await shown('ceiling')).toBe(0);
  expect(await shown('roof')).toBe(0);
  await press('x');
  expect(await shown('ceiling')).toBe(ceil);
  expect(await shown('roof')).toBe(roof);
});

test('U hides the upper storey', async () => {
  const upper = await shown('upper');
  expect(upper).toBeGreaterThan(0);
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

test("each of the site's layer keys toggles its layer", async () => {
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
});

test('G toggles ghost mode', async () => {
  expect(await twin<boolean>(page, 'twin.state.ghost')).toBe(true);
  await press('g');
  expect(await twin<boolean>(page, 'twin.state.ghost')).toBe(false);
  await expect(page.locator('#flags span.on', { hasText: 'Ghost' })).toHaveCount(0);
  await press('g');
  expect(await twin<boolean>(page, 'twin.state.ghost')).toBe(true);
});

test('Tab switches to the overview and back', async () => {
  await press('Tab');
  expect(await twin<string>(page, 'twin.state.mode')).toBe('orbit');
  await expect(page.locator('#cross')).toBeHidden();
  await press('Tab');
  expect(await twin<string>(page, 'twin.state.mode')).toBe('walk');
  await expect(page.locator('#cross')).toBeVisible();
});

test('P shows the equipment pins, Shift-P through walls', async () => {
  await needs('pins');
  const vis = (name: string) => twin<boolean>(page, `twin.scene.getObjectByName('${name}').visible`);
  expect(await vis('Pins')).toBe(false);
  await press('p');
  expect(await vis('Pins')).toBe(true);
  await expect(page.locator('#pincount')).toContainText('shown');
  await press('Shift+P');
  expect(await vis('Pins_through_walls')).toBe(true);
  await press('Shift+P');
  await press('p');
  expect(await vis('Pins')).toBe(false);
});

test('L highlights the wall plates', async () => {
  test.skip(!(await twin<boolean>(page, '!!twin.switches')), 'the model has no wall plates');
  const vis = () => twin<boolean>(page, `twin.scene.getObjectByName('Switches_marks').visible`);
  expect(await vis()).toBe(false);
  await press('l');
  expect(await twin<boolean>(page, 'twin.switches.on')).toBe(true);
  expect(await vis()).toBe(true);
  await press('l');
  expect(await vis()).toBe(false);
});

test('V shows faults through walls (mock)', async () => {
  await needs('faults');
  await press('v');
  expect(await twin<boolean>(page, 'twin.ha.wallhack')).toBe(true);
  await expect(page.locator('#faultlist')).toBeVisible();
  await expect(page.locator('#faultlist')).toContainText('Device faults');
  await page.waitForFunction(
    () => (window as unknown as { twin: { faults: { points: { visible: boolean } } } }).twin.faults.points.visible,
    null,
    { timeout: 180_000 },
  );
  await press('v');
  await expect(page.locator('#faultlist')).toBeHidden();
});

test('B shows a blueprint sheet and fades the model', async () => {
  await needs('blueprints');
  await press('b');
  await page.waitForFunction(() => !!(window as unknown as { twin: { bp: { mesh: unknown } } }).twin.bp.mesh, null, {
    timeout: 120_000,
  });
  expect(await twin<boolean>(page, 'twin.bp.saved.size > 0')).toBe(true);
  await expect(page.locator('#bpopts')).toBeVisible();
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

test('the help lists the viewpoints and layer keys from the manifest', async () => {
  const names = await twin<string[]>(page, 'twin.site.viewpoints.map((v) => v.name)');
  const help = page.locator('#help');
  for (const n of names) await expect(help).toContainText(n);
  for (const l of (await siteLayers()).filter((x) => x.key))
    await expect(help.locator('td', { hasText: new RegExp(`^${l.key}$`) })).toHaveCount(1);
  expect(await page.title()).toContain(await twin<string>(page, 'twin.site.name'));
});

test('a click in the overview inspects the object under the mouse', async () => {
  await press('Tab');
  await nextFrame();
  // a point on the canvas (the HUD can cover the middle of a small window) with the model under it
  const at = await twin<{ x: number; y: number } | null>(
    page,
    `(() => {
      for (let y = 120; y < 600; y += 40) for (let x = 400; x < 1240; x += 40) {
        if (document.elementFromPoint(x, y)?.tagName !== 'CANVAS') continue;
        const ndc = new twin.THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
        if (twin.pick(ndc)) return { x, y };
      }
      return null;
    })()`,
  );
  expect(at).not.toBeNull();
  await page.mouse.click(at!.x, at!.y);
  await expect(page.locator('#info')).toBeVisible();
  await expect(page.locator('#info h2')).not.toBeEmpty();
  await expect(page.locator('#info')).toContainText('hit at');
  await page.locator('#infoclose').click();
  await expect(page.locator('#info')).toBeHidden();
  await press('Tab');
});

test("a fixture's Turn on / off button switches its mock light", async () => {
  await needs('home-assistant');
  // a fixture the model may switch, on a mock entity that is on or off
  const fid = await twin<string>(
    page,
    `Object.keys(twin.ha.fx).find((id) => !twin.ha.toggleBlocker(id) && ['on', 'off'].includes(twin.ha.entities[twin.ha.entityOf(id)]?.state))`,
  );
  expect(fid).toBeTruthy();
  const entity = await twin<string>(page, `twin.ha.entityOf(${JSON.stringify(fid)})`);
  const before = await twin<string>(page, `twin.ha.entities[${JSON.stringify(entity)}].state`);
  // open its inspect panel as a click on it would
  await twin(
    page,
    `(() => {
      const node = twin.fixtures[${JSON.stringify(fid)}];
      let mesh = null;
      node.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
      twin.showInfo({ node, part: null, hit: { point: node.getWorldPosition(new twin.THREE.Vector3()), object: mesh } });
    })()`,
  );
  const button = page.locator('#info .haswitch button').first();
  await expect(button).toHaveText(before === 'on' ? 'Turn off' : 'Turn on');
  await button.click();
  const after = before === 'on' ? 'off' : 'on';
  await page.waitForFunction(
    ([e, s]) =>
      (window as unknown as { twin: { ha: { entities: Record<string, { state: string }> } } }).twin.ha.entities[e]
        ?.state === s,
    [entity, after],
  );
  expect(await twin<string>(page, `twin.ha.fx[${JSON.stringify(fid)}].look.kind`)).toBe(after);
  expect(await twin<number>(page, 'twin.ha.mock.calls.length')).toBeGreaterThan(0);
  expect(await twin<string>(page, 'twin.ha.mock.calls.at(-1).domain')).toBe(entity.split('.')[0]);
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
