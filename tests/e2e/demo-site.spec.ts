// Checks that need a known building: the demo house (examples/demo-site, the default dev site), skipped on any other
// site. The walker climbs the stair to the first floor and "where am I" names the room it arrives in.
import { expect, test, type Page } from '@playwright/test';
import { openViewer, twin } from './helpers';

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await openViewer(page, 'ha=mock&hamock=static&noextra');
});

test.afterAll(async () => {
  await page.close();
});

/** the walker's plan position */
const at = () =>
  twin<{ X: number; Y: number; Z: number }>(page, 'twin.toPlan(twin.player.pos)').then((p) => ({
    X: +p.X.toFixed(2),
    Y: +p.Y.toFixed(2),
    Z: +p.Z.toFixed(2),
  }));

test('walks up the stair to the landing', async () => {
  test.skip((await twin<string>(page, 'twin.site.id')) !== 'demo-house', 'only for the demo house');
  // just short of the stair, facing up it (plan north), ghost mode off
  await twin(page, 'twin.teleport(11.3, 2.4, 0, 0)');
  if (await twin<boolean>(page, 'twin.state.ghost')) await page.keyboard.press('g');
  expect(await twin<boolean>(page, 'twin.state.ghost')).toBe(false);
  // Hold W and step the walker in the page, 50 ms at a time (the viewer's own per-frame cap): the same physics as
  // the render loop's, but not tied to the frame rate, which in software WebGL on a CI runner is a frame or two a second.
  await page.keyboard.down('w');
  const reached = await page.evaluate(() => {
    const t = (
      window as unknown as {
        twin: { toPlan(p: unknown): { Y: number }; player: { pos: unknown }; stepWalk(dt: number): void };
      }
    ).twin;
    for (let i = 0; i < 400 && t.toPlan(t.player.pos).Y <= 8; i++) t.stepWalk(0.05);
    return t.toPlan(t.player.pos).Y > 8;
  });
  await page.keyboard.up('w');
  expect(reached, `reached the landing (at ${JSON.stringify(await at())})`).toBe(true);
  const p = await at();
  expect(p.Z, `standing on the first floor (at ${JSON.stringify(p)})`).toBeCloseTo(3.2, 1);
  await twin(page, 'twin.updateWhere()');
  await expect(page.locator('#where')).toContainText('landing');
  await expect(page.locator('#where')).toContainText('first floor');
});
