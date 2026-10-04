import type { Page } from '@playwright/test';

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
