import { expect, test, type Page } from '@playwright/test';

/** Collect console errors and page errors from now on. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/** Open the viewer with the help hidden (and the pixel ratio lowered, if asked) and wait until it is walkable (the model and its collider are in). */
export async function openViewer(page: Page, query: string): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('twin.helpSeen', '1'));
  // a lower pixel ratio for the renderer (playwright.config.ts: under software WebGL)
  const ratio = Number(process.env.E2E_PIXEL_RATIO || 0);
  if (ratio)
    await page.addInitScript((r) => Object.defineProperty(window, 'devicePixelRatio', { get: () => r }), ratio);
  await page.goto(`./?${query}`);
  await page.waitForFunction(() => !!(window as unknown as { twin?: { collider?: unknown } }).twin?.collider, null, {
    timeout: 5 * 60_000,
    polling: 500,
  });
}

/** Wait until every plugin the site enables has started, failed or been skipped (and mock HA is up, if configured). */
export async function waitForLayers(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const t = (
        window as unknown as {
          twin: {
            site: { plugins: Record<string, unknown> };
            host?: { records(): { state: string }[] };
            ha?: { status?: string };
          };
        }
      ).twin;
      const recs = t.host?.records() || [];
      return (
        recs.length > 0 &&
        recs.every((r) => r.state !== 'pending' && r.state !== 'starting') &&
        (!t.site.plugins['home-assistant'] || t.ha?.status === 'mock')
      );
    },
    null,
    { timeout: 5 * 60_000, polling: 500 },
  );
}

/** Run a function against window.twin in the page. */
export function twin<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate(`(() => { const twin = window.twin; return (${fn}); })()`) as Promise<T>;
}

/** The HUD helpers the specs share, on the page `get()` returns (each spec file shares one page across its tests). */
export function viewerHelpers(get: () => Page) {
  const page = () => get();
  const twinOn = <T>(fn: string) => twin<T>(page(), fn);
  return {
    /** number of visible top-level nodes in a group */
    shown: (group: string) => twinOn<number>(`twin.groups.${group}.filter((o) => o.visible).length`),
    /** wait until the viewer has drawn a frame */
    nextFrame: () => page().evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))),
    /** skip a test unless the plugin is running on this site */
    needs: async (plugin: string) =>
      test.skip(!(await twinOn<boolean>(`twin.host.running(${JSON.stringify(plugin)})`)), `the site has no ${plugin}`),
    press: async (key: string) => {
      await page().keyboard.press(key);
      await page().waitForTimeout(150);
    },
    chip: (id: string) => page().locator(`jv-status [data-chip="${id}"]`),
    insp: () => page().locator('jv-inspector aside'),
    closeInspector: async () => {
      await page().locator('jv-inspector #inspector-close').click();
      await expect(page().locator('jv-inspector aside')).toHaveCount(0);
    },
    siteLayers: () =>
      twinOn<LayerInfo[]>('twin.site.layers.map((l) => ({ id: l.id, key: l.key, hidden: l.hidden, model: l.model }))'),
  };
}

export interface LayerInfo {
  id: string;
  key: string | null;
  hidden: boolean;
  model: string | null;
}
