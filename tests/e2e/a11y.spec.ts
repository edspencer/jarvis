// Accessibility of the HUD (axe-core, WCAG 2.2 A and AA): the walk view as it loads, the rail's panels open in the
// dock, the inspector on a fixture with sections from several plugins, energy mode with its panel and the inspector's
// Energy section, and the help modal. The 3D canvas itself is
// out of scope (it has its own text alternative: the status strip's place item and the inspector).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { openViewer, twin, viewerHelpers, waitForLayers } from './helpers';

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage(); // axe needs a page from an explicit context
  await openViewer(page, 'ha=mock&hamock=static&noextra&sun=15,276');
  await waitForLayers(page);
  // the scans read the DOM only: stop drawing frames, which under software WebGL take the main thread from axe
  await twin(page, 'twin.renderer.setAnimationLoop(null)');
});

test.afterAll(async () => {
  await page.close(); // (not its context: closing that in afterAll races the trace clean-up of the passed tests)
});

const { insp } = viewerHelpers(() => page);

// Rules switched off on purpose, with the reason (none: the HUD passes WCAG 2.2 AA and axe best practice as is):
const DISABLED: Record<string, string> = {};

async function scan(state: string) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .disableRules(Object.keys(DISABLED))
    .analyze();
  const found = r.violations.map((v) => ({
    rule: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => `${JSON.stringify(n.target)} ${n.failureSummary?.split('\n').slice(1).join(' ')}`),
  }));
  if (found.length) console.log(`${state}:\n${JSON.stringify(found, null, 2)}`);
  expect.soft(found, `axe violations: ${state}`).toEqual([]);
}

test('the walk view as it loads', async () => {
  await expect(page.locator('#loading')).toBeHidden();
  await scan('walk view');
});

test('the rail panels open in the dock', async () => {
  const ids = await page
    .locator('jv-rail [role="toolbar"] > button[data-panel]')
    .evaluateAll((bs) =>
      bs.map((b) => (b as HTMLElement).dataset.panel!).filter((id) => id !== 'search' && id !== 'help'),
    );
  for (const id of ids) {
    await page.locator(`jv-rail button[data-panel="${id}"]`).click();
    await expect(page.locator(`jv-dock section[data-panel="${id}"]`)).toBeVisible();
    await scan(`panel ${id}`);
  }
  for (const id of ids) {
    const s = page.locator(`jv-dock section[data-panel="${id}"]`);
    if (await s.count()) await s.locator('button[aria-label^="Close"]').click();
  }
});

test('the inspector on a fixture', async () => {
  const fid = await twin<string | undefined>(
    page,
    `(() => { const ids = Object.keys(twin.lights?.fx ?? {}); return ids.find((id) => twin.pins?.byFixture?.(id)) || ids[0] || Object.keys(twin.fixtures)[0]; })()`,
  );
  test.skip(!fid, 'the site has no fixtures');
  await twin(page, `twin.inspect('fixture:' + ${JSON.stringify(fid)})`);
  await expect(insp()).toBeVisible();
  // the status strip makes room for the inspector at once (the render loop is stopped here, so no later refresh does
  // it): the bar ends left of the inspector
  const [bar, panel] = await Promise.all([page.locator('jv-status .bar').boundingBox(), insp().boundingBox()]);
  expect(bar!.x + bar!.width, 'status bar clear of the inspector').toBeLessThanOrEqual(panel!.x);
  await scan('inspector');
  await page.locator('jv-inspector #inspector-close').click();
});

test("energy: energy mode (its chip and legend), the Energy panel, and the inspector's Energy section", async () => {
  test.skip(!(await twin<boolean>(page, `twin.host.running('energy')`)), 'the site has no energy plugin');
  await page.keyboard.press('j');
  await expect.poll(() => twin<boolean>(page, 'twin.energy.on')).toBe(true);
  await expect(page.locator('jv-legend [data-legend="energy"]')).toBeVisible();
  await scan('energy mode');
  const panel = page.locator('jv-dock section[data-panel="energy"]');
  if (!(await panel.isVisible())) await page.locator('jv-rail button[data-panel="energy"]').click();
  await expect(panel).toBeVisible();
  await scan('energy mode, Energy panel');
  // a consumer's row opens its subject in the inspector, with the Energy section
  await panel.locator('.li.act').filter({ hasNotText: 'Other ·' }).first().click();
  await expect(insp().locator('[data-section="energy"]')).toBeVisible();
  await scan("inspector's Energy section");
  await page.locator('jv-inspector #inspector-close').click();
  await panel.locator('button[aria-label^="Close"]').click();
  await page.keyboard.press('j');
  await expect.poll(() => twin<boolean>(page, 'twin.energy.on')).toBe(false);
});

test('the help modal', async () => {
  await page.keyboard.press('h');
  await expect(page.locator('jv-modal [role="dialog"]')).toBeVisible();
  await scan('help');
  await page.keyboard.press('Escape');
});
