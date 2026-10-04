// Walking on a phone (390 × 844, touch): the strip's mode switch walks, the thumb-stick moves the walker, a drag on
// the view looks around (with the stick at the same time), a tap inspects what is under the finger (a drag doesn't),
// and axe passes on the layout. Touches go through CDP (Input.dispatchTouchEvent), so the page sees real touch
// Pointer Events. Assertions read the walker's state through window.twin and poll: software WebGL draws 1–2 frames a
// second.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { openViewer, twin, viewerHelpers, waitForLayers, watchErrors } from './helpers';

test.describe.configure({ mode: 'serial' });

let page: Page;
let cdp: CDPSession;
let errors: string[];

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  page = await context.newPage();
  errors = watchErrors(page);
  cdp = await context.newCDPSession(page);
  await openViewer(page, 'ha=mock&hamock=static&noextra&sun=15,276');
  await waitForLayers(page);
});

test.afterAll(async () => {
  await page.close();
});

const { insp, closeInspector } = viewerHelpers(() => page);
const stick = () => page.locator('jv-stick [role="application"]');

type Pt = { x: number; y: number; id: number };
const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', points: Pt[]) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ ...p, radiusX: 4, radiusY: 4 })) });

/** a finger dragged from a to b in a few steps (and left down) */
async function drag(id: number, a: { x: number; y: number }, b: { x: number; y: number }, others: Pt[] = []) {
  await touch('touchStart', [...others, { ...a, id }]);
  for (let i = 1; i <= 5; i++)
    await touch('touchMove', [...others, { x: a.x + ((b.x - a.x) * i) / 5, y: a.y + ((b.y - a.y) * i) / 5, id }]);
}

const centreOf = async () => {
  const b = (await stick().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const pos = () => twin<{ x: number; z: number }>(page, '({ x: twin.player.pos.x, z: twin.player.pos.z })');
const yaw = () => twin<number>(page, 'twin.player.yaw');
const moved = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

test('a phone starts in the overview; the strip switches to walk, which shows the thumb-stick', async () => {
  expect(await twin<string>(page, 'twin.state.mode')).toBe('orbit');
  expect(await twin<boolean>(page, 'twin.hud.touch')).toBe(true);
  await expect(stick()).toHaveCount(0);
  const walk = page.locator('jv-status [data-mode="walk"]');
  await expect(walk).toBeVisible();
  await walk.tap();
  await expect.poll(() => twin<string>(page, 'twin.state.mode')).toBe('walk');
  await expect(stick()).toBeVisible();
  await expect(stick()).toHaveAttribute('aria-label', /Move/);
  // clear of the tab bar
  const [s, rail] = await Promise.all([stick().boundingBox(), page.locator('jv-rail .rail').boundingBox()]);
  expect(s!.y + s!.height).toBeLessThanOrEqual(rail!.y);
});

test('the thumb-stick moves the walker; let go (or cancelled), it stops', async () => {
  const c = await centreOf();
  const p0 = await pos();
  await drag(1, c, { x: c.x, y: c.y - 50 }); // pushed forward
  await expect.poll(() => twin<number>(page, 'twin.analog.y')).toBeGreaterThan(0.9);
  await expect.poll(async () => moved(await pos(), p0)).toBeGreaterThan(0.5);
  await touch('touchEnd', []);
  await expect.poll(() => twin<number>(page, 'Math.hypot(twin.analog.x, twin.analog.y)')).toBe(0);
  // a pointercancel lets go too
  await drag(1, c, { x: c.x + 50, y: c.y });
  await expect.poll(() => twin<number>(page, 'twin.analog.x')).toBeGreaterThan(0.9);
  await touch('touchCancel', []);
  await expect.poll(() => twin<number>(page, 'Math.hypot(twin.analog.x, twin.analog.y)')).toBe(0);
});

test('a drag on the view looks around, with the stick held at the same time; no inspect after it', async () => {
  const c = await centreOf();
  const y0 = await yaw();
  const p0 = await pos();
  await drag(1, c, { x: c.x, y: c.y - 50 }); // the stick, held
  const thumb = { x: c.x, y: c.y - 50, id: 1 };
  await drag(2, { x: 320, y: 420 }, { x: 220, y: 400 }, [thumb]); // a second finger, on the right half
  await expect.poll(async () => Math.abs((await yaw()) - y0)).toBeGreaterThan(0.4);
  expect(await yaw()).toBeGreaterThan(y0); // dragged left: turned left
  await expect.poll(async () => moved(await pos(), p0)).toBeGreaterThan(0.3);
  await touch('touchEnd', [thumb]);
  await touch('touchEnd', []);
  await expect.poll(() => twin<number>(page, 'Math.hypot(twin.analog.x, twin.analog.y)')).toBe(0);
  await page.waitForTimeout(300);
  await expect(insp()).toHaveCount(0);
});

test('a tap inspects what is under the finger (no pointer lock)', async () => {
  const at = await twin<{ x: number; y: number } | null>(
    page,
    `(() => {
      for (let y = 160; y < 640; y += 30) for (let x = 200; x < 380; x += 30) {
        if (document.elementFromPoint(x, y)?.tagName !== 'CANVAS') continue;
        const ndc = new twin.THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
        if (twin.pickAt(ndc)) return { x, y };
      }
      return null;
    })()`,
  );
  expect(at, 'something to tap on').not.toBeNull();
  await page.touchscreen.tap(at!.x, at!.y);
  await expect(insp()).toBeVisible();
  await expect(insp().locator('h2')).not.toBeEmpty();
  expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
  // a peek sheet: the stick stays, above it
  await expect(stick()).toBeVisible();
  const [s, sheet] = await Promise.all([stick().boundingBox(), insp().boundingBox()]);
  expect(s!.y + s!.height).toBeLessThanOrEqual(sheet!.y);
});

test('axe: the walk layout on a phone, with the inspector peeking and without', async () => {
  await twin(page, 'twin.renderer.setAnimationLoop(null)'); // (the scans read the DOM only)
  await scan('phone walk, inspector peeking');
  await closeInspector();
  await expect(stick()).toBeVisible();
  await scan('phone walk');
});

test('the overview again: the stick goes', async () => {
  await page.locator('jv-status [data-mode="orbit"]').tap();
  await expect.poll(() => twin<string>(page, 'twin.state.mode')).toBe('orbit');
  await expect(stick()).toHaveCount(0);
  expect(errors).toEqual([]);
});

async function scan(state: string) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
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
