// The touch walk controls on a desktop (1280 × 720, a mouse, no touch emulation): the thumb-stick never shows for
// the mouse and keyboard, walking included; a finger on the view (a laptop's touch screen) brings it, and the next
// mouse press puts the desktop back: no stick, the crosshair, and a click in the walk view asking for the pointer
// lock again. Touches go through CDP (Input.dispatchTouchEvent). State is read through window.twin and polled:
// software WebGL draws 1–2 frames a second.
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { openViewer, twin, watchErrors } from './helpers';

test.describe.configure({ mode: 'serial' });

let page: Page;
let cdp: CDPSession;
let errors: string[];

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  page = await context.newPage();
  errors = watchErrors(page);
  cdp = await context.newCDPSession(page);
  await openViewer(page, 'ha=mock&hamock=static&noextra&sun=15,276');
  // count the walk view's pointer-lock requests (headless Chromium may not grant one, and the test needn't)
  await page.evaluate(() => {
    const t = window as unknown as { twin: { renderer: { domElement: HTMLCanvasElement } }; lockAsks: number };
    t.lockAsks = 0;
    t.twin.renderer.domElement.requestPointerLock = () => (t.lockAsks++, Promise.resolve());
  });
});

test.afterAll(async () => {
  await page.close();
});

const stick = () => page.locator('jv-stick .stick');
const cross = () => page.locator('#cross');
const lockAsks = () => page.evaluate(() => (window as unknown as { lockAsks: number }).lockAsks);
const pos = () => twin<{ x: number; z: number }>(page, '({ x: twin.player.pos.x, z: twin.player.pos.z })');

/** a point on the left of the view where the canvas is on top (clear of the rail, the strip and the dock) */
const onCanvas = () =>
  twin<{ x: number; y: number } | null>(
    page,
    `(() => {
      for (let y = 200; y < 560; y += 40) for (let x = 200; x < 700; x += 40)
        if (document.elementFromPoint(x, y) === twin.renderer.domElement) return { x, y };
      return null;
    })()`,
  );

test('no stick on a desktop without touch, in walk mode, while walking with the keyboard', async () => {
  expect(await twin<boolean>(page, 'twin.hud.touch')).toBe(false);
  await twin(page, "twin.setMode('walk')");
  await expect.poll(() => twin<string>(page, 'twin.state.mode')).toBe('walk');
  await expect(cross()).toBeVisible();
  await expect(stick()).toHaveCount(0);
  // walk with W: held, and the walker stepped in the page (not tied to the frame rate)
  const p0 = await pos();
  await page.locator('body').focus();
  await page.keyboard.down('w');
  await expect.poll(() => twin<boolean>(page, '!!twin.keys.KeyW')).toBe(true);
  await twin(page, '(() => { for (let i = 0; i < 20; i++) twin.stepWalk(0.05); })()');
  await page.keyboard.up('w');
  const p1 = await pos();
  expect(Math.hypot(p1.x - p0.x, p1.z - p0.z), 'walked').toBeGreaterThan(0.2);
  await twin(page, "twin.hud.update('stick', 'status')");
  await expect.poll(() => twin<unknown>(page, 'twin.hud.stickAt()')).toBeNull();
  await expect(stick()).toHaveCount(0);
  await expect(cross()).toBeVisible();
  expect(await twin<boolean>(page, 'twin.hud.touch')).toBe(false);
});

test('a finger brings the stick; the next mouse press restores the desktop (no stick, crosshair, pointer lock)', async () => {
  const at = await onCanvas();
  expect(at, 'a point on the canvas').not.toBeNull();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...at!, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => twin<boolean>(page, 'twin.hud.touch')).toBe(true);
  await expect(stick()).toBeVisible();
  await expect(cross()).toBeHidden(); // a tap picks at the finger
  expect(await lockAsks()).toBe(0); // touch never asks for the lock
  // a tap may have inspected something: close it, so the mouse lands on the view
  if (await twin<boolean>(page, '!!twin.hud.subject')) await twin(page, 'twin.hud.closeInspector()');

  const asked = await lockAsks();
  const m = (await onCanvas())!;
  await page.mouse.click(m.x, m.y);
  await expect.poll(() => twin<boolean>(page, 'twin.hud.touch')).toBe(false);
  await expect(stick()).toHaveCount(0);
  await expect(cross()).toBeVisible();
  expect(await page.evaluate(() => document.body.classList.contains('touch'))).toBe(false);
  // the click in the walk view went the mouse's way: it asked for the pointer lock (and inspected nothing)
  await expect.poll(lockAsks).toBe(asked + 1);
  expect(await twin<unknown>(page, 'twin.hud.subject')).toBeNull();
  expect(errors).toEqual([]);
});
