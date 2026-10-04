// A validated manifest with every default filled in and every path turned into a URL: what the viewer and the plugins
// read at run time. Pure (no DOM), so tests and the validate-site tool use it too.
import type {
  BlueprintsConfig,
  EnergyConfig,
  ExternalPluginConfig,
  FaultsConfig,
  Geo,
  HomeAssistantConfig,
  LightsConfig,
  LayerDef,
  LayerMatch,
  PinsConfig,
  PlanXY,
  PlanXYZ,
  SiteManifest,
  Storey,
  SwitchesConfig,
  Viewpoint,
} from './manifest.ts';
import { isExternalSection } from './external.ts';
import { BUILTIN_PLUGINS } from '../plugins/registry.ts';

export type Match = Required<LayerMatch>;

export interface Layer {
  id: string;
  label: string;
  /** the KeyboardEvent.code that toggles it ('KeyK'), or null */
  code: string | null;
  /** the letter, for the help */
  key: string | null;
  help: string;
  hidden: boolean;
  match: Match;
  /** the extra model whose nodes all join this layer (its key loads it first), or null */
  model: string | null;
  builtin: boolean;
}

export interface ResolvedStorey {
  name: string;
  short: string;
  z: number;
  from: number;
  objectsFrom: number;
}

export interface ResolvedModel {
  id: string;
  url: string;
  parts: string | null;
  layer: string | null;
}

export interface Site {
  /** the manifest as written */
  manifest: SiteManifest;
  /** the manifest's own URL: paths resolve against it */
  url: string;
  id: string;
  name: string;
  description: string;
  geo: Geo;
  units: 'ft' | 'm';
  /** metres per plan unit */
  unit: number;
  northAzimuth: number;
  centre: PlanXY;
  /** null: fit to the model */
  overviewCamera: PlanXYZ | null;
  ground: { z: number; colour: string | null };
  /** plan units; null: fit to the model */
  shadowRadius: number | null;
  models: { main: ResolvedModel; extra: ResolvedModel[] };
  /** bottom up; at least one */
  storeys: ResolvedStorey[];
  viewpoints: Viewpoint[];
  /** 0-based */
  startView: number;
  layers: Layer[];
  materials: { glass: string[]; water: string[]; screens: Record<string, { wire: number }> };
  passable: Match;
  floorPrefix: string;
  walk: { eyeHeight: number; crouchEyeHeight: number; radius: number; maxStep: number };
  plugins: {
    'home-assistant': (Required<Pick<HomeAssistantConfig, 'url'>> & Omit<HomeAssistantConfig, 'url'>) | null;
    lights: LightsConfig | null;
    faults: FaultsConfig | null;
    pins: PinsConfig | null;
    switches: SwitchesConfig | null;
    blueprints: BlueprintsConfig | null;
    energy: EnergyConfig | null;
  } & Record<string, unknown>;
  /** the plugins loaded from the site (a section with a `module`), by id: the module's URL, and the keys the section
   * declares (they win over the plugin's own). Their sections, without `module` and `keys`, are in `plugins`. */
  external: Record<string, { module: string; keys?: string[] }>;
  /** where an external plugin's module may come from besides the viewer's origin (src/site/external.ts) */
  pluginOrigins: string[];
}

const FT = 0.3048;

const match = (m: LayerMatch = {}): Match => ({
  namePrefix: m.namePrefix || [],
  layer: m.layer || [],
  material: m.material || [],
  extra: m.extra || [],
});

/** the built-in layers' defaults; a manifest layer with the same id overrides them field by field (match whole) */
const BUILTIN: Record<string, LayerDef> = {
  roof: { id: 'roof', label: 'Roofs', match: { namePrefix: ['Roof_'], layer: ['roof'] } },
  ceiling: { id: 'ceiling', label: 'Ceilings', match: { namePrefix: ['Ceil_'], layer: ['ceiling'] } },
  door: {
    id: 'door',
    label: 'Doors',
    key: 'O',
    hidden: true,
    help: 'door leaves',
    match: { layer: ['door'], extra: ['door_leaf'] },
  },
};

/** model-format defaults (docs/model-format.md) */
export const DEFAULTS = {
  glass: ['glass'],
  water: ['water'],
  passable: { namePrefix: ['Win_', 'WinFrame_', 'WinMull_', 'Label_'], extra: ['passable'] } as LayerMatch,
  floorPrefix: 'Floor_',
  walk: { eyeHeight: 5.5 * FT, crouchEyeHeight: 3 * FT, radius: 0.3, maxStep: 0.35 },
  storey: { name: 'ground floor', z: 0 } as Storey,
};

/** a path from the manifest as a URL, relative to the manifest */
export function resolvePath(path: string, base: string): string {
  return new URL(path, base).href;
}

/** Fill in the defaults and resolve the paths of a manifest that passed validateManifest(). */
export function resolveSite(m: SiteManifest, url: string): Site {
  const r = (p: string) => resolvePath(p, url);
  const rOpt = (p: string | undefined) => (p ? r(p) : null);
  const units = m.frame?.units || 'ft';

  const given = new Map((m.layers || []).map((l) => [l.id, l]));
  const defs: LayerDef[] = [
    ...Object.values(BUILTIN).map((b) => ({ ...b, ...given.get(b.id), match: given.get(b.id)?.match || b.match })),
    ...(m.layers || []).filter((l) => !BUILTIN[l.id]),
  ];
  const extra = (m.models.extra || []).map((x) => ({
    id: x.id,
    url: r(x.url),
    parts: rOpt(x.parts),
    layer: x.layer || null,
  }));
  const layers: Layer[] = defs.map((l) => {
    const label = l.label || l.id;
    return {
      id: l.id,
      label,
      key: l.key || null,
      code: l.key ? `Key${l.key}` : null,
      help: l.help || label.toLowerCase(),
      hidden: !!l.hidden,
      match: match(l.match || { layer: [l.id] }),
      model: extra.find((x) => x.layer === l.id)?.id || null,
      builtin: !!BUILTIN[l.id],
    };
  });

  const storeys: ResolvedStorey[] = (m.storeys?.length ? m.storeys : [DEFAULTS.storey]).map((s: Storey) => {
    const from = s.from ?? s.z;
    return { name: s.name, short: s.short || s.name, z: s.z, from, objectsFrom: s.objectsFrom ?? from };
  });

  const p = m.plugins || {};
  const ha = p['home-assistant'];
  // the external plugins' sections (validateManifest kept only those with an id of their own)
  const ext = Object.entries(p as Record<string, unknown>).filter(
    (e): e is [string, ExternalPluginConfig] => isExternalSection(e[1]) && !Object.hasOwn(BUILTIN_PLUGINS, e[0]),
  );
  return {
    manifest: m,
    url,
    id: m.id,
    name: m.name,
    description: m.description || '',
    geo: m.geo,
    units,
    unit: units === 'm' ? 1 : FT,
    northAzimuth: m.frame?.northAzimuth ?? 0,
    centre: m.centre || [0, 0],
    overviewCamera: m.overview?.camera || null,
    ground: { z: m.ground?.z ?? 0, colour: m.ground?.colour || null },
    shadowRadius: m.sun?.shadowRadius ?? null,
    models: { main: { id: 'main', url: r(m.models.main.url), parts: rOpt(m.models.main.parts), layer: null }, extra },
    storeys,
    viewpoints: m.viewpoints,
    startView: (m.startView || 1) - 1,
    layers,
    materials: {
      glass: m.materials?.glass || DEFAULTS.glass,
      water: m.materials?.water || DEFAULTS.water,
      screens: m.materials?.screens || {},
    },
    passable: match(m.colliders?.passable || DEFAULTS.passable),
    floorPrefix: m.rooms?.floorPrefix || DEFAULTS.floorPrefix,
    walk: { ...DEFAULTS.walk, ...m.walk },
    plugins: {
      ...Object.fromEntries(ext.map(([id, { module: _, keys: __, ...config }]) => [id, config])),
      'home-assistant': ha
        ? {
            ...ha,
            url: (ha.url || '').replace(/\/+$/, ''),
            controls: rOpt(ha.controls) || undefined,
            map: undefined,
            emitterHints: undefined,
          }
        : null,
      // the fixture map used to be the home-assistant section's (map, emitterHints): read that as a lights section
      // with Home Assistant and no lights section, the lights still start (with no map, ?ha=mock makes up entities); the
      // fixture map used to be the home-assistant section's (map, emitterHints): read that as the lights section
      lights: p.lights
        ? { ...p.lights, map: rOpt(p.lights.map) || undefined }
        : ha
          ? { map: rOpt(ha.map) || undefined, emitterHints: ha.emitterHints }
          : null,
      faults: p.faults ? { ...p.faults, devices: r(p.faults.devices) } : null,
      pins: p.pins ? { ...p.pins, registry: r(p.pins.registry) } : null,
      switches: p.switches || null,
      blueprints: p.blueprints ? { ...p.blueprints, index: r(p.blueprints.index) } : null,
      energy: p.energy ? { ...p.energy, map: r(p.energy.map) } : null,
    },
    external: Object.fromEntries(
      ext.map(([id, x]) => [id, { module: r(x.module), ...(x.keys ? { keys: x.keys } : {}) }]),
    ),
    pluginOrigins: m.pluginOrigins || [],
  };
}

// ------------------------------------------------------------------ storeys

/** the storey a standing position at plan height z is on */
export function storeyAt(site: Pick<Site, 'storeys'>, z: number): { index: number; storey: ResolvedStorey } {
  let index = 0;
  site.storeys.forEach((s, i) => {
    if (i > 0 && z > s.from) index = i;
  });
  return { index, storey: site.storeys[index] };
}

/** the storey an object (its bottom) or a marker at plan height z belongs to */
export function storeyOfObject(site: Pick<Site, 'storeys'>, z: number): { index: number; storey: ResolvedStorey } {
  let index = 0;
  site.storeys.forEach((s, i) => {
    if (i > 0 && z > s.objectsFrom) index = i;
  });
  return { index, storey: site.storeys[index] };
}

/** three.js Y (metres) above which an object is in the upper storeys (U hides it); Infinity for a one-storey site */
export const upperFromY = (site: Pick<Site, 'storeys' | 'unit'>): number =>
  site.storeys.length > 1 ? site.storeys[1].objectsFrom * site.unit : Infinity;

// ------------------------------------------------------------------ layer matching

export interface NodeFacts {
  name: string;
  extras: Record<string, unknown>;
  /** the names of the materials its meshes use */
  materials: Iterable<string>;
}

/** does a top-level node match a layer's (or the collider's) rules? */
export function matches(m: Match, n: NodeFacts): boolean {
  if (m.namePrefix.some((p) => n.name.startsWith(p))) return true;
  if (m.layer.length && typeof n.extras.layer === 'string' && m.layer.includes(n.extras.layer)) return true;
  if (m.extra.some((k) => !!n.extras[k])) return true;
  if (m.material.length) for (const mn of n.materials) if (m.material.includes(mn)) return true;
  return false;
}
