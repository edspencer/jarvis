// The assistant panel against the mock assistant (?assistant=mock: an in-page scripted server speaking the real
// protocol; src/plugins/assistant/mock.ts) on the demo house with mock Home Assistant: Shift-M opens the panel, a typed
// message streams a reply with a tool chip (and the typing doesn't reach the viewer's keys), a confirmation is
// approved and another denied, "where is …" flies there and opens the inspector, a chip with a subject flies there,
// holding M talks (the mock "hears" a fixed phrase), and New conversation starts over. Then the login, against a routed
// WebSocket standing in for the server: no credential asks for an access code, a refused one says so (and doesn't
// retry), the right one connects, Forget code signs out.
// The demo site has no assistant section (the assistant needs a server of its own, and the Pages site must not try
// to reach one), so each page here gets site.json with one added.
import { expect, test, type Page } from '@playwright/test';
import { openViewer, twin, waitForLayers, watchErrors } from './helpers';

test.describe.configure({ mode: 'serial' });

/** serve the demo's site.json with plugins.assistant added */
async function withAssistant(p: Page): Promise<void> {
  await p.route('**/site.json', async (route) => {
    const response = await route.fetch();
    const site = await response.json();
    site.plugins.assistant = { server: '/assistant' };
    await route.fulfill({ response, json: site });
  });
}

let page: Page;
let errors: string[];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  errors = watchErrors(page);
  await withAssistant(page);
  await openViewer(page, 'ha=mock&hamock=static&assistant=mock&noextra');
  await waitForLayers(page);
  await page.waitForFunction(
    () =>
      (window as never as { twin: { assistant?: { state(): { conn: string } } } }).twin.assistant?.state().conn ===
      'connected',
  );
});

test.afterAll(async () => {
  await page.close();
});

const panel = () => page.locator('jv-dock section[data-panel="assistant"]');
const input = () => panel().locator('input[aria-label="Message"]');
const chip = (text: string) => panel().locator('.tool', { hasText: text });
const dialog = () => page.locator('jv-modal [role="dialog"]');
const insp = () => page.locator('jv-inspector aside');
const send = async (text: string) => {
  await input().fill(text);
  await input().press('Enter');
};
const idle = () => expect(panel().locator('.state')).toHaveAttribute('data-phase', 'idle');

test('the status item shows the mock assistant, and Shift-M opens the panel', async () => {
  expect(await twin<boolean>(page, `twin.host.running('assistant')`)).toBe(true);
  await expect(page.locator('jv-status [data-item="assistant"]')).toContainText('Assistant · mock');
  await page.keyboard.press('Shift+KeyM');
  await expect(panel()).toBeVisible();
  await expect(panel()).toContainText('Mock assistant (?assistant=mock)');
});

test('a typed message streams a reply with a tool chip, and the typing never reaches the viewer', async () => {
  const before = await twin<{ ghost: boolean; cutaway: boolean }>(
    page,
    '({ ghost: twin.state.ghost, cutaway: twin.state.cutaway })',
  );
  // g, u, x, h are the viewer's keys (ghost, upper storey, cutaway, help)
  await send('turn off the kitchen lights, then go home x');
  await expect(panel().locator('.u').last()).toHaveText('turn off the kitchen lights, then go home x');
  await expect(chip('Turning off Kitchen pendants')).toHaveAttribute('data-status', 'done');
  await expect(panel().locator('.a').last()).toHaveText("I've turned off the kitchen pendants.");
  await idle();
  expect(await twin(page, '({ ghost: twin.state.ghost, cutaway: twin.state.cutaway })')).toEqual(before);
  await expect(dialog()).toHaveCount(0);
  // one say went out; the reply was spoken (the mock records sentences instead of speaking)
  expect(await twin<number>(page, `twin.assistant.received().filter((m) => m.type === 'say').length`)).toBe(1);
  expect(await twin<string[]>(page, 'twin.assistant.spoken()')).toEqual(["I've turned off the kitchen pendants."]);
});

test('a confirmation: Allow does it', async () => {
  await send('set the thermostat to 72');
  await expect(chip('waiting for your OK')).toHaveAttribute('data-status', 'pending');
  await expect(dialog()).toBeVisible();
  await expect(dialog()).toContainText('Set the Hall thermostat to 72 °F');
  await expect(dialog()).toContainText('climate.set_temperature on climate.hall');
  await expect(dialog()).toContainText(/Expires in \d+ s/);
  await dialog().getByRole('button', { name: 'Allow' }).click();
  await expect(dialog()).toHaveCount(0);
  await expect(chip('Set the Hall thermostat to 72 °F').last()).toHaveAttribute('data-status', 'done');
  await expect(panel().locator('.a').last()).toHaveText('Done: the hall thermostat is set to 72 °F.');
  await idle();
});

test("another: Don't refuses it", async () => {
  await send('close the garage');
  await expect(dialog()).toBeVisible();
  await expect(dialog()).toContainText('Close the Garage door');
  await dialog().getByRole('button', { name: "Don't" }).click();
  await expect(dialog()).toHaveCount(0);
  await expect(chip('Close the Garage door: not confirmed')).toHaveAttribute('data-status', 'refused');
  await expect(panel().locator('.a').last()).toHaveText("OK, I won't.");
  const replies = await twin<{ approved: boolean }[]>(
    page,
    `twin.assistant.received().filter((m) => m.type === 'confirm.reply')`,
  );
  expect(replies.map((r) => r.approved)).toEqual([true, false]);
  await idle();
});

test('a refusal says why', async () => {
  await send('unlock the front door');
  await expect(chip('Unlocking Front door: not allowed')).toHaveAttribute('data-status', 'refused');
  await expect(panel().locator('.a').last()).toContainText("I can't do that");
  await idle();
});

test('"where is …" flies there and opens it in the inspector', async () => {
  await send('where is the water heater?');
  await expect(insp()).toContainText('Water heater');
  await expect(chip('Showing Water heater')).toHaveAttribute('data-status', 'done');
  await expect(panel().locator('.a').last()).toContainText("That's the water heater, in the garage.");
  const views = await twin<{ op: string; ok: boolean; args: { subject?: string } }[]>(page, 'twin.assistant.views()');
  expect(views.at(-1)).toMatchObject({ op: 'fly', ok: true, args: { subject: 'pins:plumb.water-heater' } });
  await idle();
});

test('a tool chip with a subject flies there on click', async () => {
  await chip('Turning off Kitchen pendants').click();
  await expect(insp()).toContainText('Kitchen pendants');
});

test('holding M talks: listening while held, then the (mock) transcription starts a voice turn', async () => {
  // focus out of the panel's text box (through the shadow roots), as after clicking the view
  await page.evaluate(() => {
    let el = document.activeElement as HTMLElement | null;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement as HTMLElement;
    el?.blur();
  });
  await page.keyboard.down('KeyM');
  await expect(panel().locator('.state')).toHaveAttribute('data-phase', 'listening');
  await expect(page.locator('jv-status [data-item="assistant"]')).toContainText('listening');
  await page.keyboard.up('KeyM');
  await expect(panel().locator('.u').last()).toContainText('show me the air handler');
  const last = await twin<{ source: string }>(
    page,
    `twin.assistant.transcript().filter((e) => e.kind === 'user').at(-1)`,
  );
  expect(last.source).toBe('voice');
  await expect(insp()).toContainText('Air handler');
  await idle();
});

test('view_layer switches view layers and the core toggles only', async () => {
  await send('hide the furniture');
  await expect(chip('Hiding Furniture')).toHaveAttribute('data-status', 'done');
  await idle();
  type View = { op: string; ok: boolean; detail?: string };
  expect((await twin<View[]>(page, 'twin.assistant.views()')).at(-1)).toMatchObject({
    op: 'layer',
    ok: true,
    detail: 'Furniture hidden',
  });
  const cutaway = await twin<boolean>(page, 'twin.state.cutaway');
  for (const want of [!cutaway, cutaway]) {
    await send('toggle the cutaway');
    await expect.poll(() => twin<boolean>(page, 'twin.state.cutaway')).toBe(want);
    await expect(panel().locator('.a').last()).toHaveText(`Done: Cutaway ${want ? 'on' : 'off'}.`);
    await idle();
  }
});

test('New conversation starts over', async () => {
  await panel().getByRole('button', { name: 'New conversation' }).click();
  await expect(panel().locator('.divider')).toHaveText('New conversation');
  await expect(panel().locator('.u')).toHaveCount(0);
});

test('no console errors', () => {
  expect(errors).toEqual([]);
});

test('on a phone (touch): the panel opens from More in the tab bar, and holding the 48 px mic button talks', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p = await context.newPage();
  const errs = watchErrors(p);
  try {
    await withAssistant(p);
    await openViewer(p, 'ha=mock&hamock=static&assistant=mock&noextra');
    await waitForLayers(p);
    await p.locator('jv-rail button[aria-label="More"]').tap();
    await p.locator('jv-rail [role="menuitem"]', { hasText: 'Assistant' }).tap();
    const sheet = p.locator('jv-dock section[data-panel="assistant"]');
    await expect(sheet).toBeVisible();
    const talk = sheet.locator('button[data-action="talk"]');
    const box = (await talk.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await expect(sheet.locator('.keyhint')).toBeHidden(); // no "hold M" on a phone
    // press and hold with a finger (CDP touch events: real touch Pointer Events), then let go
    const cdp = await context.newCDPSession(p);
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1, radiusX: 4, radiusY: 4 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
    await expect(sheet.locator('.state')).toHaveAttribute('data-phase', 'listening');
    await p.waitForTimeout(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    // the voice turn flies there; on a phone the inspector's sheet takes the dock sheet's place
    await expect
      .poll(() =>
        twin<string | undefined>(p, `twin.assistant.transcript().filter((e) => e.kind === 'user').at(-1)?.text`),
      )
      .toBe('show me the air handler');
    await expect(p.locator('jv-inspector aside')).toContainText('Air handler');
    expect(errs).toEqual([]);
  } finally {
    await context.close();
  }
});

test('the login: an access code is asked for, a wrong one refused without retrying, the right one connects', async ({
  browser,
}) => {
  const p = await browser.newPage();
  const errs = watchErrors(p);
  await withAssistant(p);
  // the server: a welcome for one access code, 4401 for anything else
  const hellos: { auth?: { type: string; secret?: string } }[] = [];
  await p.routeWebSocket('**/assistant/ws', (ws) => {
    ws.onMessage((raw) => {
      const m = JSON.parse(String(raw));
      if (m.type !== 'hello') return;
      hellos.push(m);
      if (m.auth?.type === 'secret' && m.auth.secret === 'tablet:right')
        ws.send(
          JSON.stringify({
            type: 'welcome',
            transcript: [],
            status: 'idle',
            agent: 'routed',
            transcribe: false,
            ha: 'mock',
            user: { name: 'tablet' },
            ticket: 't1',
          }),
        );
      else {
        ws.send(JSON.stringify({ type: 'error', message: 'not authorised' }));
        ws.close({ code: 4401, reason: 'not authorised' });
      }
    });
  });
  // mock Home Assistant has no login to offer, so there is no credential at first
  await openViewer(p, 'ha=mock&hamock=static&noextra');
  await waitForLayers(p);
  const status = p.locator('jv-status [data-item="assistant"]');
  const box = p.locator('jv-dock section[data-panel="assistant"]');
  const signin = box.locator('.signin');
  const code = signin.locator('input[aria-label="Access code"]');
  await expect(status).toContainText('Assistant · sign in');
  await p.keyboard.press('Shift+KeyM');
  await expect(signin).toHaveAttribute('data-auth', 'needed');
  expect(hellos).toEqual([]); // nothing to send, so nothing was sent

  await code.fill('tablet:wrong');
  await signin.getByRole('button', { name: 'Use code' }).click();
  await expect(signin).toHaveAttribute('data-auth', 'refused');
  await expect(signin).toContainText("didn't accept this access code");
  await p.waitForTimeout(1500);
  expect(hellos.map((h) => h.auth)).toEqual([{ type: 'secret', secret: 'tablet:wrong' }]); // and no retry

  await code.fill('tablet:right');
  await code.press('Enter');
  await expect(status).toHaveText('Assistant'); // ready: no "· sign in"
  await expect(signin).toHaveCount(0);
  await expect(box.locator('.agent')).toHaveText('routed · tablet');
  expect(hellos.at(-1)).toMatchObject({ auth: { type: 'secret', secret: 'tablet:right' } });
  expect(hellos.at(-1)).not.toHaveProperty('surface');

  await box.getByRole('button', { name: 'Forget code' }).click();
  await expect(signin).toHaveAttribute('data-auth', 'needed');
  await expect(status).toContainText('Assistant · sign in');
  await expect(box.getByRole('button', { name: 'Forget code' })).toHaveCount(0);
  expect(errs).toEqual([]);
  await p.close();
});
