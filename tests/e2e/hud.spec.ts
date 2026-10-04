// The HUD against the dev site (any site folder) with mock Home Assistant: every rail button opens its panel, the
// inspector gathers sections from several plugins, a mock light switches (and a failed call says so), the connector
// modal keeps focus, search finds a room, help lists only the running plugins' keys, and the HUD's components work as
// custom elements. A test whose plugin the site lacks is skipped. The HUD's elements are in shadow roots; Playwright's
// CSS locators reach into them.
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

const { nextFrame, needs, press, insp, closeInspector, siteLayers } = viewerHelpers(() => page);

/** a fixture the model may switch, on a mock entity that is on or off; preferably one that is also a registry item */
const switchable = () =>
  twin<string>(
    page,
    `(() => {
      const ok = Object.keys(twin.lights.fx).filter((id) => !twin.lights.blocker(id) && ['on', 'off'].includes(twin.store.get(twin.lights.entityOf(id))?.state));
      return ok.find((id) => twin.pins?.byFixture?.(id)) || ok[0];
    })()`,
  );

test('every rail button opens its panel in the dock; at most two stay open', async () => {
  const ids = await page
    .locator('jv-rail [role="toolbar"] > button[data-panel]')
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

test('no plugins.assistant (the demo site): no assistant at all, nothing shown, nothing connecting', async () => {
  test.skip(await twin<boolean>(page, `!!twin.site.plugins.assistant`), 'this site has an assistant');
  expect(await twin<boolean>(page, `twin.host.running('assistant')`)).toBe(false);
  await expect(page.locator('jv-rail button[data-panel="assistant"]')).toHaveCount(0);
  await expect(page.locator('jv-status [data-item="assistant"]')).toHaveCount(0);
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

test('on a phone (390 × 844) the rail is a bottom bar, about 52 px tall and the width of the screen', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  const bar = page.locator('jv-rail [role="toolbar"]');
  await expect
    .poll(
      async () => {
        const b = await bar.boundingBox();
        return b && { h: Math.round(b.height), wide: b.width > 390 - 40 };
      },
      { timeout: 30_000 },
    )
    .toMatchObject({ h: 52, wide: true });
  const b = (await bar.boundingBox())!;
  expect(844 - (b.y + b.height), 'at the bottom').toBeLessThan(24);
  expect(b.x, 'from the left edge').toBeLessThan(20);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect.poll(async () => Math.round((await bar.boundingBox())?.height ?? 0)).toBeGreaterThan(200);
});

test('no console errors after all that', () => {
  expect(errors).toEqual([]);
});
