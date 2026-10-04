// node tools/demo-site/shots.ts <out dir> [shots.json]: pictures of the demo house (or JARVIS_SITE) for checking the
// generator's output by eye: eye-level views (walk mode, teleported) and straight-down plan views of a storey (an
// orthographic camera, ceilings and roof cut away, the upper storey hidden for the ground floor). The viewer's HUD is
// hidden. With no shots file it takes a default set: every viewpoint, a plan of each storey, and those plans again in
// energy mode (J). Uses the GPU when there is a DRM render node (as the e2e tests do).
//
// A shots file is a JSON array of
//   { "name": "living-tv", "walk": [x, y, z, yawDeg, pitchRad?] }            plan metres; z is the floor the eye is above
//   { "name": "plan-ground", "plan": { "storey": 0, "box": [x0, y0, x1, y1] } }  plan metres; box defaults to the house
//   ...either with "energy": true (energy mode on), "hour": 15 (the sun's hour), "furniture": false (hide the F layer)
// (the page side is untyped: window.twin is the viewer's console hook)
/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

interface Shot {
  name: string;
  walk?: [number, number, number, number, number?];
  plan?: { storey: number; box?: [number, number, number, number] };
  energy?: boolean;
  hour?: number;
  furniture?: boolean;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const [out = '/tmp/demo-shots', file] = process.argv.slice(2);
const SIZE = { width: 1280, height: 800 };

const GPU = process.env.E2E_GPU ? process.env.E2E_GPU !== '0' : existsSync('/dev/dri/renderD128');
const server = await createServer({ root: ROOT, server: { port: 0, host: '127.0.0.1' }, logLevel: 'warn' });
await server.listen();
const url = server.resolvedUrls!.local[0];
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  args: GPU
    ? ['--use-angle=gl-egl', '--use-gl=angle', '--ignore-gpu-blocklist', '--enable-gpu']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
await mkdir(out, { recursive: true });
try {
  const page = await browser.newPage({ viewport: SIZE });
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => localStorage.setItem('twin.helpSeen', '1'));
  await page.goto(`${url}?ha=mock&hamock=static`);
  await page.waitForFunction(
    () => {
      const t = (window as unknown as { twin?: { collider?: unknown; extras?: Record<string, { status: string }> } })
        .twin;
      return !!t?.collider && Object.values(t.extras || {}).every((x) => x.status === 'loaded');
    },
    null,
    { timeout: 5 * 60_000, polling: 500 },
  );
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    for (const el of document.querySelectorAll<HTMLElement>('body > *'))
      if (!canvas || !el.contains(canvas)) el.style.visibility = 'hidden';
  });
  const views = await page.evaluate(() => (window as any).twin.VIEWS as { name: string; at: number[]; yaw: number }[]);
  const shots: Shot[] = file
    ? JSON.parse(await readFile(file, 'utf8'))
    : [
        ...views.map((v, i) => ({ name: `view-${i + 1}`, walk: [v.at[0], v.at[1], v.at[2], v.yaw] as Shot['walk'] })),
        { name: 'plan-ground', plan: { storey: 0 } },
        { name: 'plan-first', plan: { storey: 1 } },
        { name: 'plan-ground-energy', plan: { storey: 0 }, energy: true },
        { name: 'plan-first-energy', plan: { storey: 1 }, energy: true },
      ];
  for (const s of shots) {
    const png = await page.evaluate(async (s: Shot) => {
      const twin = (window as any).twin;
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      const settle = async () => {
        for (let i = 0; i < 4; i++) await frame();
        await new Promise((r) => setTimeout(r, 900));
        for (let i = 0; i < 3; i++) await frame();
      };
      twin.setSun(s.hour ?? 15, 200);
      const energy = !!twin.energy?.on;
      if (!!s.energy !== energy) twin.energy?.setOn(!!s.energy);
      const furnLayer = twin.site.layers.find((l: { id: string }) => l.id === 'furniture');
      if (furnLayer) {
        const hidden = s.furniture === false;
        if (!!twin.state.hidden?.[furnLayer.id] !== hidden) twin.toggleLayer(furnLayer.id);
      }
      if (s.walk) {
        twin.state.cutaway = false;
        twin.state.upperHidden = false;
        twin.applyVisibility();
        const [x, y, z, yaw, pitch] = s.walk;
        twin.teleport(x, y, z, yaw);
        twin.player.pitch = pitch ?? -0.12;
        await settle();
        return null;
      }
      // a plan: an orthographic camera straight down, rendered here and read back at once
      const p = s.plan!;
      const st = twin.site.storeys;
      twin.setMode('orbit');
      twin.state.cutaway = true;
      twin.state.upperHidden = p.storey < st.length - 1;
      twin.applyVisibility();
      await settle();
      const T = twin.THREE;
      const box = p.box ?? [-1.5, -1.5, 20.5, 10.5];
      const [x0, y0, x1, y1] = box;
      const w = x1 - x0,
        h = y1 - y0,
        aspect = twin.renderer.domElement.width / twin.renderer.domElement.height;
      const hw = Math.max(w / 2, (h / 2) * aspect),
        hh = hw / aspect;
      const cam = new T.OrthographicCamera(-hw, hw, hh, -hh, 0.1, 100);
      const z = (st[p.storey]?.z ?? 0) + (st[p.storey + 1] ? st[p.storey + 1].z - (st[p.storey].z ?? 0) - 0.4 : 2.5);
      // from well above (the ground floor's walls reach above z), hiding what starts above z
      cam.position.copy(twin.P((x0 + x1) / 2, (y0 + y1) / 2, z + 30));
      cam.up.set(0, 0, -1); // north up
      cam.lookAt(twin.P((x0 + x1) / 2, (y0 + y1) / 2, 0));
      cam.updateProjectionMatrix();
      // hide anything above the eye (the storey above's floor, the roof)
      const hidden: { visible: boolean }[] = [];
      twin.root.traverse((o: any) => {
        if (!o.isMesh || !o.visible) return;
        const b = new T.Box3().setFromObject(o);
        if (b.min.y > z * twin.site.unit) {
          o.visible = false;
          hidden.push(o);
        }
      });
      twin.renderer.render(twin.scene, cam);
      const data = twin.renderer.domElement.toDataURL('image/png');
      for (const o of hidden) o.visible = true;
      twin.setMode('walk');
      return data;
    }, s);
    const path = join(out, `${s.name}.png`);
    if (png) await writeFile(path, Buffer.from(png.split(',')[1], 'base64'));
    else await page.screenshot({ path });
    console.log(path);
  }
  if (errors.length) console.log('console errors:\n' + errors.join('\n'));
} finally {
  await browser.close();
  await server.close();
}
