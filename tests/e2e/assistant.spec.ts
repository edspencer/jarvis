// The assistant panel against the mock assistant (?assistant=mock: an in-page scripted server speaking the real
// protocol; src/plugins/assistant/mock.ts) on the demo house with mock Home Assistant: Shift-M opens the panel, a typed
// message streams a reply with a tool chip (and the typing doesn't reach the viewer's keys), a confirmation is
// approved and another denied, "where is …" flies there and opens the inspector, a chip with a subject flies there,
// holding M talks (the mock "hears" a fixed phrase), and New conversation starts over.
import { expect, test, type Page } from '@playwright/test';
import { openViewer, twin, waitForLayers, watchErrors } from './helpers';

test.describe.configure({ mode: 'serial' });

let page: Page;
let errors: string[];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  errors = watchErrors(page);
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
  test.skip(!(await twin<boolean>(page, `twin.host.running('assistant')`)), 'the site has no assistant');
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
  await expect(panel().locator('.a').last()).toContainText("That's the water heater, in the kitchen.");
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
