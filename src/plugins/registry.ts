// The plugins that ship with the viewer, and the letter keys each one claims. Each is its own chunk, downloaded only
// when the site enables it (a manifest section) or it starts on its own (`autoStart`, repeated here so the viewer
// knows without loading the module; tests/unit/external-plugins.test.ts, "the registry's autoStart", checks
// the two agree). The keys are listed here, not
// only where the plugin registers them, so the site validator (which runs in Node, without the plugins) keeps a site
// layer's key off them; the key registry warns if a plugin uses a letter it doesn't declare. A plugin that isn't
// built in is loaded from the site instead (`plugins.<id>.module`, docs/plugins.md).
import type { PluginDef } from '../plugin-api';

type Loader = () => Promise<{ default: PluginDef<never> }>;

export interface BuiltinPlugin {
  /** letter keys it registers */
  keys: readonly string[];
  /** starts without a manifest section (the plugin's own `autoStart`) */
  autoStart?: boolean;
  load: Loader;
}

export const BUILTIN_PLUGINS: Record<string, BuiltinPlugin> = {
  sun: { keys: [], autoStart: true, load: () => import('./sun/index.ts') },
  blueprints: { keys: ['B'], load: () => import('./blueprints/index.ts') },
  'home-assistant': { keys: [], load: () => import('./home-assistant/index.ts') },
  lights: { keys: ['T', 'V'], load: () => import('./lights/index.ts') },
  faults: { keys: ['V'], load: () => import('./faults/index.ts') },
  pins: { keys: ['P'], load: () => import('./pins/index.ts') },
  switches: { keys: ['L'], autoStart: true, load: () => import('./switches/index.ts') },
  energy: { keys: ['J'], load: () => import('./energy/index.ts') },
  assistant: { keys: ['M'], load: () => import('./assistant/index.ts') },
};

/** the built-in plugins to download: those the site enables and the autoStart ones, in registry order */
export function builtinsToLoad(
  enabled: (id: string) => boolean,
  registry: Record<string, BuiltinPlugin> = BUILTIN_PLUGINS,
): string[] {
  return Object.entries(registry)
    .filter(([id, p]) => p.autoStart || enabled(id))
    .map(([id]) => id);
}

/** the letter keys of the built-in plugins a manifest enables (autoStart ones always count) */
export function pluginKeys(enabled: Iterable<string>): string[] {
  const ids = new Set(enabled);
  const out = new Set<string>();
  for (const [id, p] of Object.entries(BUILTIN_PLUGINS))
    if (p.autoStart || ids.has(id)) for (const k of p.keys) out.add(k);
  return [...out];
}
