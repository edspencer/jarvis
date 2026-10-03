import type { Page } from '@playwright/test';

/** the bits of the console hook (window.twin) waitForLayers reads */
interface LayersView {
  site: { plugins: Record<string, unknown> };
  ha?: { status?: string };
  faults?: { points?: unknown };
  pins?: { items?: unknown[] };
  switches?: { group?: unknown };
  bp?: { index?: unknown };
}

/** Collect console errors and page errors from now on. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/** Open the viewer with the help hidden and wait until it is walkable (the model and its collider are in). */
export async function openViewer(page: Page, query: string): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('twin.helpSeen', '1'));
  await page.goto(`./?${query}`);
  await page.waitForFunction(() => !!(window as unknown as { twin?: { collider?: unknown } }).twin?.collider, null, {
    timeout: 5 * 60_000,
    polling: 500,
  });
}

/** Wait for the optional layers the site configures (HA mock, faults, pins, plates, blueprints) to be up. */
export async function waitForLayers(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const t = (window as unknown as { twin: LayersView }).twin;
      const p = t.site.plugins;
      return (
        (!p['home-assistant'] || t.ha?.status === 'mock') &&
        (!p.faults || t.faults?.points) &&
        (!p.pins || t.pins?.items?.length) &&
        (!p.switches || t.switches?.group) &&
        (!p.blueprints || t.bp?.index)
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
