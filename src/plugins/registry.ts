// The plugins that ship with the viewer, loaded on demand (each is its own chunk), and the letter keys each one
// claims. The keys are listed here, not only where the plugin registers them, so the site validator (which runs in
// Node, without the plugins) keeps a site layer's key off them; the key registry warns if a plugin uses a letter it
// doesn't declare.
import type { PluginDef } from '../plugin-api';

type Loader = () => Promise<{ default: PluginDef<never> }>;

export interface BuiltinPlugin {
  /** letter keys it registers */
  keys: readonly string[];
  load: Loader;
}

export const BUILTIN_PLUGINS: Record<string, BuiltinPlugin> = {
  sun: { keys: [], load: () => import('./sun/index.ts') },
  blueprints: { keys: ['B'], load: () => import('./blueprints/index.ts') },
  'home-assistant': { keys: [], load: () => import('./home-assistant/index.ts') },
  lights: { keys: ['T', 'V'], load: () => import('./lights/index.ts') },
  faults: { keys: ['V'], load: () => import('./faults/index.ts') },
  pins: { keys: ['P'], load: () => import('./pins/index.ts') },
  switches: { keys: ['L'], load: () => import('./switches/index.ts') },
};

/** the letter keys of the built-in plugins a manifest enables (autoStart ones always count) */
export function pluginKeys(enabled: Iterable<string>): string[] {
  const out = new Set<string>(BUILTIN_PLUGINS.sun.keys);
  for (const id of [...enabled, 'switches']) for (const k of BUILTIN_PLUGINS[id]?.keys || []) out.add(k);
  return [...out];
}
