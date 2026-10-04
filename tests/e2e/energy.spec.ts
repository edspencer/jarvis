// The energy plugin on the demo house (examples/demo-site, its energy.json), with mock Home Assistant and the energy
// plugin's mock loads held still (hamock=static): J switches energy mode (the chip, the legend, the ghost materials,
// and everything put back after), Shift+J opens the Energy panel (top consumers, the house load in the status strip),
// and the inspector's Energy section for a metered subject. CI renders WebGL in software at 1-2 fps, so these test the
// state the plugin exposes on window.twin.energy and the HUD it draws, not motion. Skipped on any other site.
import { expect, test, type Page } from '@playwright/test';
import { openViewer, twin, waitForLayers, watchErrors } from './helpers';

test.describe.configure({ mode: 'serial' });

let page: Page;
let errors: string[];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  errors = watchErrors(page);
  await openViewer(page, 'ha=mock&hamock=static&noextra');
  await waitForLayers(page);
});

test.afterAll(async () => {
  await page.close();
});

test.beforeEach(async () => {
  test.skip((await twin<string>(page, 'twin.site.id')) !== 'demo-house', 'only for the demo house');
});

const press = async (key: string) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(150);
};
const energyOn = () => twin<boolean>(page, 'twin.energy.on');
/** meshes under the model whose material is one of the energy plugin's (energy.ghost, energy.room.*, energy.load.*) */
const energyMeshes = () =>
  twin<number>(
    page,
    `(() => {
      let n = 0;
      twin.root.traverse((o) => {
        if (!o.isMesh) return;
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        if (ms.some((m) => m && typeof m.name === 'string' && m.name.startsWith('energy.'))) n++;
      });
      return n;
    })()`,
  );
/** meshes drawn fainter than their own material (the blueprint fade): see-through or without depth writes */
const fadedMeshes = () =>
  twin<number>(
    page,
    `(() => {
      let n = 0;
      twin.root.traverse((o) => {
        if (!o.isMesh || Array.isArray(o.material)) return;
        const own = twin.materials.base(o);
        if (o.material !== own && (o.material.opacity < own.opacity - 1e-6 || o.material.depthWrite !== own.depthWrite)) n++;
      });
      return n;
    })()`,
  );
const insp = () => page.locator('jv-inspector aside');
const energyPanel = () => page.locator('jv-dock section[data-panel="energy"]');

test('the plugin is up with the demo map and mock loads', async () => {
  expect(await twin<boolean>(page, 'twin.host.running("energy")')).toBe(true);
  expect(await twin<number>(page, 'twin.energy.tree.roots.length')).toBe(3);
  await expect.poll(() => twin<number | null>(page, 'twin.energy.totals().load')).toBeGreaterThan(0);
  expect(await twin<number | null>(page, 'twin.energy.readings().get("circuit.fridge").w')).not.toBeNull();
});

test('J toggles energy mode: chip, legend, ghosted materials; off puts the materials back', async () => {
  expect(await energyOn()).toBe(false);
  expect(await energyMeshes()).toBe(0);
  await press('j');
  await expect.poll(energyOn).toBe(true);
  await expect(page.locator('jv-status [data-chip="energy"]')).toHaveAttribute('aria-pressed', 'true');
  const legend = page.locator('jv-legend [data-legend="energy"]');
  await expect(legend).toBeVisible();
  await expect(legend.locator('.lt')).toContainText('Load');
  await expect(legend).toContainText('no data');
  await expect.poll(energyMeshes).toBeGreaterThan(0);
  // the ghost material is the plugin's own
  expect(await twin<boolean>(page, 'twin.energy.scene.isOurs(twin.energy.scene.ghost)')).toBe(true);

  await press('j');
  await expect.poll(energyOn).toBe(false);
  await expect(page.locator('jv-status [data-chip="energy"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(legend).toHaveCount(0);
  expect(await energyMeshes()).toBe(0);
});

test('blueprint fade and energy mode share the materials: B on, J on, B off, J off puts everything back', async () => {
  expect(await fadedMeshes()).toBe(0);
  await press('b');
  await expect.poll(() => twin<boolean>(page, 'twin.bp.mesh !== null')).toBe(true);
  await expect.poll(fadedMeshes).toBeGreaterThan(0);
  await press('j');
  await expect.poll(energyOn).toBe(true);
  await expect.poll(energyMeshes).toBeGreaterThan(0);
  await press('b');
  await expect.poll(() => twin<boolean>(page, 'twin.bp.active === null && twin.bp.faded.size === 0')).toBe(true);
  expect(await energyMeshes()).toBeGreaterThan(0); // energy mode is still on
  await press('j');
  await expect.poll(energyOn).toBe(false);
  expect(await energyMeshes()).toBe(0);
  expect(await fadedMeshes()).toBe(0); // the house isn't left faded
});

test('Shift+J opens the Energy panel: top consumers, and the house load in the status strip', async () => {
  await press('Shift+J');
  const panel = energyPanel();
  await expect(panel).toBeVisible();
  const consumers = panel.locator('.list').filter({ hasText: 'Top consumers' });
  await expect(consumers).toBeVisible();
  await expect(consumers.locator('.li')).toHaveCount(8);
  await expect(consumers.locator('.li .v').first()).toHaveText(/^[\d,.]+ k?W$/);
  await expect(panel.locator('.list').filter({ hasText: 'Panels' })).toContainText('Main panel');
  await expect(panel.locator('.kv')).toContainText('House load');

  const load = page.locator('jv-status [data-item="energy.load"]');
  await expect(load).toBeVisible();
  await expect(load).toHaveText(/^\s*[\d,.]+ k?W\s*$/);
  const w = await twin<number>(page, 'twin.energy.totals().load');
  await expect(load).toContainText(w >= 1000 ? `${(w / 1000).toFixed(w < 10000 ? 1 : 0)} kW` : `${Math.round(w)} W`);
});

test("clicking a consumer opens the inspector's Energy section with its power", async () => {
  const panel = energyPanel();
  if (!(await panel.isVisible())) await press('Shift+J');
  const row = panel
    .locator('.list')
    .filter({ hasText: 'Top consumers' })
    .locator('.li.act')
    .filter({ hasNotText: 'Other ·' })
    .first();
  const name = (await row.locator('.p').textContent())!.trim();
  await row.click();
  const sec = insp().locator('[data-section="energy"]');
  await expect(sec).toBeVisible();
  await expect(sec.locator('.meter .val')).toHaveText(/^\d[\d.]*\s*k?W$/);
  // the subject it opened (the meter, or the first thing it feeds) shows that meter
  const id = await twin<string>(page, `twin.energy.tree.all.find((m) => m.label === ${JSON.stringify(name)}).id`);
  await expect.poll(() => twin<string[]>(page, 'twin.energy.metersOf(twin.hud.subject)')).toContain(id);
});

test("a wall plate's Energy section: its circuit's power and breaker 5", async () => {
  await twin(page, `twin.inspect('plates:LV-O-A')`);
  expect(await twin<string[]>(page, `twin.energy.metersOf('plates:LV-O-A')`)).toEqual(['circuit.living_outlets']);
  const sec = insp().locator('[data-section="energy"]');
  await expect(sec).toBeVisible();
  await expect(sec.locator('.meter .val')).toHaveText(/^\d[\d.]*\s*k?W$/);
  const breaker = sec.locator('.kv .k', { hasText: /^Breaker$/ });
  await expect(breaker).toHaveCount(1);
  await expect(breaker.locator('xpath=following-sibling::div[1]')).toHaveText('5');
  const w = await twin<number>(page, 'twin.energy.readings().get("circuit.living_outlets").w');
  expect(w).toBeGreaterThan(0);
});

test('no console errors', async () => {
  expect(errors).toEqual([]);
});
