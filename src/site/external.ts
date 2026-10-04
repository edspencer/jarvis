// External plugins: a `plugins.<id>` section with a `module` loads that ES module from the site (relative to the
// manifest) instead of a built-in plugin. These are the pure rules for them, shared by the viewer and validate-site:
// which URLs may be imported (the trust model in docs/plugins.md), and what a module must export.
import type { PluginDef } from '../core/plugin/types.ts';

/** an external plugin's id: lower-case letters, digits and '-', starting with a letter */
export const PLUGIN_ID = /^[a-z][a-z0-9-]*$/;

/** a section that names a module to load */
export const isExternalSection = (v: unknown): v is { module: string } & Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && 'module' in v;

/**
 * Why the viewer won't import a plugin module from `moduleUrl`, or null if it may. The site owner chooses the code a
 * site runs, so the rule follows who controls what:
 * - a module on the viewer's own origin is always allowed (whoever can put files there already controls the page);
 * - one on another origin only if the manifest lists that origin in `pluginOrigins`, and the manifest itself is on the
 *   viewer's origin: a manifest opened from elsewhere (`?site=https://…`) can show its data but never bring code;
 * - only http(s): no data:, blob: or javascript: URLs.
 * An origin is scheme, host and port, never a path: a viewer under a sub-path trusts its whole host. The module's URL
 * must not redirect (moduleFetchRefusal), and the server's CSP enforces all this for the browser itself.
 */
export function moduleRefusal(
  moduleUrl: string,
  o: { page: string; manifest: string; origins: readonly string[] },
): string | null {
  let u: URL;
  try {
    u = new URL(moduleUrl);
  } catch {
    return `${moduleUrl} isn't a URL`;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    return `${u.protocol} URLs aren't loaded: serve the module over http(s)`;
  const page = new URL(o.page).origin;
  if (u.origin === page) return null;
  const manifest = new URL(o.manifest).origin;
  if (manifest !== page)
    return `the module is on ${u.origin} and the site manifest on ${manifest}, not the viewer's origin (${page}): a manifest from another origin can't bring code`;
  if (o.origins.includes(u.origin)) return null;
  return `${u.origin} isn't the viewer's origin: list it in the manifest's pluginOrigins to allow it`;
}

/**
 * Fetch the module once without following redirects, before importing it: import() follows redirects, so a URL on an
 * allowed origin that redirects (an open redirect on the viewer's own origin) would bring code from anywhere. Returns
 * why it won't be imported, or null. Best effort (the server could answer the import differently): the real
 * enforcement is the server's Content-Security-Policy (script-src), as deploy/nginx.conf sends it.
 */
export async function moduleFetchRefusal(url: string, f: typeof fetch): Promise<string | null> {
  let r: Response;
  try {
    r = await f(url, { redirect: 'manual', credentials: 'same-origin', cache: 'no-cache' });
  } catch (e) {
    return `couldn't fetch ${url} (${(e as Error).message})`;
  }
  if (r.type === 'opaqueredirect' || r.redirected || (r.status >= 300 && r.status < 400))
    return `${url} redirects: a plugin module is loaded only from its own URL, never through a redirect`;
  if (!r.ok) return `${url}: HTTP ${r.status}`;
  return null;
}

const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** The plugin an external module exports (its default export), or what is wrong with it. */
export function pluginOf(mod: unknown, id: string): { def: PluginDef | null; problems: string[] } {
  const def = (mod as { default?: unknown } | null)?.default as Partial<PluginDef> | undefined;
  if (!def || typeof def !== 'object')
    return { def: null, problems: ['the module has no default export: export default definePlugin({ … })'] };
  const problems: string[] = [];
  if (def.id !== id) problems.push(`it exports the plugin "${String(def.id)}", but the section is plugins.${id}`);
  if (typeof def.name !== 'string' || !def.name) problems.push('it has no name');
  if (typeof def.setup !== 'function') problems.push('it has no setup(ctx) function');
  if (def.requires !== undefined && !strings(def.requires)) problems.push('requires: expected a list of plugin ids');
  if (def.after !== undefined && !strings(def.after)) problems.push('after: expected a list of plugin ids');
  if (def.keys !== undefined && !(strings(def.keys) && def.keys.every((k) => /^[A-Z]$/.test(k))))
    problems.push("keys: expected a list of capital letters (['M'])");
  if (def.validate !== undefined && typeof def.validate !== 'function') problems.push('validate: expected a function');
  return problems.length ? { def: null, problems } : { def: def as PluginDef, problems };
}

/** a plugin's own check of its section (PluginDef.validate); one that throws counts as a problem */
export function configProblems(def: Pick<PluginDef, 'validate'>, config: unknown): string[] {
  try {
    const r = def.validate?.(config);
    return Array.isArray(r) ? r.map(String) : [];
  } catch (e) {
    return [`its validate() threw: ${(e as Error)?.message || e}`];
  }
}
