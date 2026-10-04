// Parity with a reference build (an earlier build of this app, e.g. main, or the single-site prototype it was
// extracted from): the same views, rendered by this app and by the reference with the HUD hidden, compared pixel by
// pixel, so a HUD or plugin refactor can prove the 3D render didn't move. The views are the site manifest's viewpoints
// by day, the second and third by night too, and the overview in cutaway with the fault markers. Skipped unless
// PROTOTYPE_URL points at a running copy of the reference (a dev server or any static server over its folder) with
// the same site data. Screenshots and diff images go to test-results/parity/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';

const PROTOTYPE_URL = process.env.PROTOTYPE_URL;
const OUT = 'test-results/parity';

interface View {
  name: string;
  /** console calls on window.twin, the same API in both */
  setup: string;
}
interface Viewpoint {
  name: string;
  at: [number, number, number];
  yaw: number;
}
function views(viewpoints: Viewpoint[]): View[] {
  const walk = (v: Viewpoint, sun: string) =>
    `twin.setMode('walk'); twin.teleport(${v.at.join(', ')}, ${v.yaw}); twin.setSun(${sun});`;
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return [
    ...viewpoints.map((v, i) => ({ name: `${i + 1}-${slug(v.name)}-day`, setup: walk(v, '15, 276') })),
    ...viewpoints.slice(1, 3).map((v, i) => ({ name: `${i + 2}-${slug(v.name)}-night`, setup: walk(v, '21, 274') })),
    {
      name: 'overview-cutaway-faults',
      // the fault overlay: the faults plugin's now, the HA layer's in older builds (twin.ha.setWallhack is kept for them)
      setup: `twin.setSun(15, 276); twin.state.cutaway = true; twin.applyVisibility(); twin.setMode('orbit'); twin.ha?.setWallhack(true);`,
    },
  ];
}

async function open(browser: Browser, url: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(() => localStorage.setItem('twin.helpSeen', '1'));
  await page.goto(url);
  await page.waitForFunction(
    () => {
      const t = (window as unknown as { twin?: Record<string, { [k: string]: unknown } | undefined> }).twin;
      // every extra model in (this app: twin.extras; the prototype: twin.furn)
      const extras = t?.extras
        ? Object.values(t.extras as Record<string, { status: string }>).every((x) => x.status === 'loaded')
        : t?.furn?.status === 'loaded';
      return !!(t?.collider && extras && t.faults?.points && t.pins?.items && t.switches);
    },
    null,
    { timeout: 10 * 60_000, polling: 1000 },
  );
  // the HUD off: everything on the page but the canvas (this app's <jv-hud>, the prototype's #hud, #info, #cross, …)
  await page.addStyleTag({ content: 'body > :not(canvas) { display: none !important; }' });
  return page;
}

const settle = (page: Page) =>
  page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    for (let i = 0; i < 4; i++) await frame();
    await new Promise((r) => setTimeout(r, 1500)); // the light pool re-picks every 0.2 s, the fault list every 0.5 s
    for (let i = 0; i < 3; i++) await frame();
  });

test.skip(!PROTOTYPE_URL, 'set PROTOTYPE_URL to compare with the prototype');

test('renders the same views as the prototype', async ({ browser, request }) => {
  test.setTimeout(40 * 60_000);
  mkdirSync(OUT, { recursive: true });
  const VIEWS = views(((await (await request.get('./site.json')).json()) as { viewpoints: Viewpoint[] }).viewpoints);
  const query = '?ha=mock&hamock=static&sun=15,276';
  const [mine, proto] = await Promise.all([open(browser, `./${query}`), open(browser, `${PROTOTYPE_URL}/${query}`)]);
  // the comparison runs in a blank page: the viewers' own main threads are busy rendering
  const scratch = await browser.newPage();
  const results: Record<string, { differing: number; maxDelta: number }> = {};
  for (const v of VIEWS) {
    const shots: Buffer[] = [];
    for (const page of [mine, proto]) {
      await page.evaluate(`(() => { const twin = window.twin; ${v.setup} })()`);
      await settle(page);
      shots.push(await page.screenshot());
    }
    writeFileSync(`${OUT}/${v.name}.port.png`, shots[0]);
    writeFileSync(`${OUT}/${v.name}.prototype.png`, shots[1]);
    // compare in a browser canvas: the share of pixels differing by more than 8 / 255 in any channel
    const cmp = await scratch.evaluate(
      async ([a, b]) => {
        const load = (s: string) =>
          new Promise<HTMLImageElement>((r) => {
            const i = new Image();
            i.onload = () => r(i);
            i.src = `data:image/png;base64,${s}`;
          });
        const [ia, ib] = await Promise.all([load(a), load(b)]);
        const c = document.createElement('canvas');
        c.width = ia.width;
        c.height = ia.height;
        const g = c.getContext('2d')!;
        g.drawImage(ia, 0, 0);
        const da = g.getImageData(0, 0, c.width, c.height);
        g.drawImage(ib, 0, 0);
        const db = g.getImageData(0, 0, c.width, c.height);
        const out = g.createImageData(c.width, c.height);
        let differing = 0,
          maxDelta = 0;
        for (let i = 0; i < da.data.length; i += 4) {
          const d = Math.max(
            Math.abs(da.data[i] - db.data[i]),
            Math.abs(da.data[i + 1] - db.data[i + 1]),
            Math.abs(da.data[i + 2] - db.data[i + 2]),
          );
          maxDelta = Math.max(maxDelta, d);
          if (d > 8) differing++;
          out.data[i] = d > 8 ? 255 : da.data[i] / 4;
          out.data[i + 1] = d > 8 ? 0 : da.data[i + 1] / 4;
          out.data[i + 2] = d > 8 ? 0 : da.data[i + 2] / 4;
          out.data[i + 3] = 255;
        }
        g.putImageData(out, 0, 0);
        return { differing: differing / (da.data.length / 4), maxDelta, diff: c.toDataURL('image/png').split(',')[1] };
      },
      [shots[0].toString('base64'), shots[1].toString('base64')] as const,
    );
    writeFileSync(`${OUT}/${v.name}.diff.png`, Buffer.from(cmp.diff, 'base64'));
    results[v.name] = { differing: cmp.differing, maxDelta: cmp.maxDelta };
  }
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  console.log(results);
  for (const [name, r] of Object.entries(results)) expect(r.differing, name).toBeLessThan(0.005);
});
