// Finding and loading the site manifest in the browser. The viewer reads `?site=<url>` (relative to the page, or
// absolute: a cross-origin manifest and its files need CORS), else `site.json` next to the page.
import { formatIssues, validateManifest, type Issue } from './validate.ts';
import { resolveSite, type Site } from './resolve.ts';

export const DEFAULT_MANIFEST = 'site.json';

/** A manifest that couldn't be read or didn't validate: `lines` are what the loading screen lists. */
export class SiteError extends Error {
  constructor(
    readonly url: string,
    readonly lines: string[],
    readonly warnings: string[] = [],
  ) {
    super(`${url}: ${lines.join('; ')}`);
  }
}

/** where the manifest is, as an absolute URL */
export function manifestUrl(loc: { href: string; search: string } = location): string {
  const q = new URLSearchParams(loc.search).get('site');
  return new URL(q || DEFAULT_MANIFEST, loc.href).href;
}

/** Fetch, parse, validate and resolve the manifest; throws SiteError with readable lines. */
export async function loadSite(
  url = manifestUrl(),
  fetcher: typeof fetch = fetch,
): Promise<{ site: Site; warnings: string[] }> {
  let res: Response;
  try {
    res = await fetcher(url, { cache: 'no-cache' });
  } catch (e) {
    throw new SiteError(url, [`couldn't fetch it (${(e as Error).message})`]);
  }
  // a dev server or an SPA host answers a missing file with the app's own page
  const html = (res.headers.get('content-type') || '').includes('text/html');
  if (!res.ok || html)
    throw new SiteError(url, [
      `${html ? 'got a web page' : `HTTP ${res.status}`}: no site manifest here. Serve a site folder with a site.json next to the app, or open ?site=<url of a site.json>`,
    ]);
  let json: unknown;
  try {
    json = JSON.parse(await res.text());
  } catch (e) {
    throw new SiteError(url, [`not valid JSON (${(e as Error).message})`]);
  }
  const v = validateManifest(json);
  const warnings = formatIssues(v.warnings);
  if (!v.ok) throw new SiteError(url, formatIssues(v.errors), warnings);
  // the manifest's own URL is where it came from after any redirects: its paths resolve there, and its origin decides
  // whether it may bring plugin code (src/site/external.ts). A redirect on the viewer's origin to another one makes
  // it a manifest from that other origin.
  return { site: resolveSite(json as Parameters<typeof resolveSite>[0], res.url || url), warnings };
}

export type { Issue, Site };
