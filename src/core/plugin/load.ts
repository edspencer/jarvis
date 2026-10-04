// Fetching the plugins' code: the built-in plugins the site enables (and the autoStart ones), each its own chunk, and
// the external plugins the site names (`plugins.<id>.module`), from where the trust rules allow (src/site/external.ts).
// Nothing else is downloaded: a site without energy never fetches the energy chunk. A module that fails to load, or
// isn't a plugin, is reported and left out; the rest start.
import type { Site } from '../../site';
import { moduleRefusal, pluginOf } from '../../site/external';
import { BUILTIN_PLUGINS, builtinsToLoad, type BuiltinPlugin } from '../../plugins/registry';
import type { PluginDef } from './types';

export interface LoadedPlugins {
  /** built-in ones first (registry order), then the external ones (manifest order) */
  defs: PluginDef[];
  /** each external plugin's declared letter keys (for the key registry's "doesn't declare it" warning) */
  keys: Record<string, readonly string[]>;
}

export async function loadPlugins(
  site: Pick<Site, 'url' | 'external' | 'pluginOrigins'>,
  o: {
    /** does the site enable this plugin? */
    enabled(id: string): boolean;
    /** the page's URL (the viewer's origin) */
    page: string;
    /** a plugin didn't load, and why */
    failed(id: string, why: string): void;
    /** import an external module (default: the browser's import()) */
    importModule?: (url: string) => Promise<unknown>;
    builtins?: Record<string, BuiltinPlugin>;
  },
): Promise<LoadedPlugins> {
  const builtins = o.builtins ?? BUILTIN_PLUGINS;
  const importModule = o.importModule ?? ((url: string) => import(/* @vite-ignore */ url));
  const builtin = await Promise.all(
    builtinsToLoad(o.enabled, builtins).map(async (id) => {
      try {
        const def = (await builtins[id].load()).default as PluginDef;
        return o.enabled(id) || def.autoStart ? def : null;
      } catch (err) {
        console.warn(`plugin ${id} didn't load (${(err as Error).message})`);
        if (o.enabled(id)) o.failed(id, (err as Error).message);
        return null;
      }
    }),
  );
  const keys: Record<string, readonly string[]> = {};
  const external = await Promise.all(
    Object.entries(site.external).map(async ([id, { module }]) => {
      const refused = moduleRefusal(module, { page: o.page, manifest: site.url, origins: site.pluginOrigins });
      if (refused) {
        console.warn(`plugin ${id}: not loading ${module}: ${refused}`);
        o.failed(id, refused);
        return null;
      }
      let mod: unknown;
      try {
        mod = await importModule(module);
      } catch (err) {
        console.warn(`plugin ${id}: ${module} didn't load`, err);
        o.failed(id, `${module} didn't load (${(err as Error).message})`);
        return null;
      }
      const { def, problems } = pluginOf(mod, id);
      if (!def) {
        console.warn(`plugin ${id}: ${module}: ${problems.join('; ')}`);
        o.failed(id, problems.join('; '));
        return null;
      }
      keys[id] = def.keys ?? [];
      // an external plugin starts from its section: autoStart is for the built-in ones
      return { ...def, autoStart: false };
    }),
  );
  return { defs: [...builtin, ...external].filter((d): d is PluginDef => !!d), keys };
}
