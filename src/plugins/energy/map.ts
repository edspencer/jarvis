// The energy map: the site's file that says which meters there are (feed → panel → circuit → device), which store
// entities give their power and energy, and what each one feeds in the model. Its schema is schema/energy.schema.json
// (read by the site validator's interpreter); checkEnergyMap() adds the rules a schema can't say. Pure: the viewer and
// `npm run validate-site` share it. docs/plugins/energy.md explains the format.
import schema from '../../../schema/energy.schema.json' with { type: 'json' };
import { checkSchema, type Issue, type Schema, type ValidationResult } from '../../site/validate.ts';

export const ENERGY_MAP_VERSION = 'jarvis-energy/1';

/** one thing in the model a meter feeds: exactly one of registry, plate, fixture, node, room */
export interface FeedRef {
  /** a registry (equipment pin) id */
  registry?: string;
  /** a wall plate's box id */
  plate?: string;
  /** a light fixture id */
  fixture?: string;
  /** a node name in the model */
  node?: string;
  /** a room id */
  room?: string;
  conf?: string;
  src?: string;
}

export type MeterKind = 'load' | 'source' | 'storage';

/** an entity id, or several summed */
export type Entities = string | string[];

export interface MeterSpec {
  id: string;
  label?: string;
  kind?: MeterKind;
  /** W or kW (the entity's unit); several are summed (the legs of a 240 V circuit) */
  power?: Entities;
  /** a label per power entity */
  legs?: string[];
  energy?: { today?: Entities; month?: Entities };
  /** a sensor reporting the unmetered remainder (a monitor's Balance) */
  remainder?: string;
  panel?: string;
  breaker?: string | number | (string | number)[];
  volts?: number;
  feeds?: FeedRef[];
  conf?: string;
  src?: string;
  question?: string;
  note?: string;
  children?: MeterSpec[];
}

export interface EnergyMap {
  $schema?: string;
  jarvis: typeof ENERGY_MAP_VERSION;
  scale?: { idle?: number; max?: number };
  meters: MeterSpec[];
}

export const FEED_KINDS = ['registry', 'plate', 'fixture', 'node', 'room'] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

/** a feed's kind and target ('registry', 'elec.panel.a'), or null if it names none or several */
export function feedTarget(f: FeedRef): { kind: FeedKind; id: string } | null {
  const ks = FEED_KINDS.filter((k) => typeof f[k] === 'string');
  return ks.length === 1 ? { kind: ks[0], id: f[ks[0]]! } : null;
}

/** the store reference a feed binds ('pins:elec.panel.a', 'plates:KIT-O-H', 'fixture:den.lamp', 'room:kitchen');
 * a node has no reference ('node:<name>' is the energy plugin's own) */
export function feedRef(f: FeedRef): string | null {
  const t = feedTarget(f);
  if (!t) return null;
  const prefix = { registry: 'pins', plate: 'plates', fixture: 'fixture', node: 'node', room: 'room' }[t.kind];
  return `${prefix}:${t.id}`;
}

export const asList = (e: Entities | undefined): string[] => (e === undefined ? [] : Array.isArray(e) ? e : [e]);

/** '17+19', '12' */
export function breakerText(b: MeterSpec['breaker']): string | null {
  if (b === undefined || b === null || b === '') return null;
  return Array.isArray(b) ? b.join('+') : String(b);
}

/** Schema, then rules: unique ids, a feed names one target, legs match the power entities, a meter has power or
 * children. Warnings: an entity used twice in power (double counting), a source or storage meter below a load. */
export function checkEnergyMap(value: unknown): ValidationResult {
  const errors = checkSchema(value, schema as Schema, '', [], schema as Schema);
  if (errors.length) return { ok: false, errors, warnings: [] };
  const m = value as EnergyMap;
  const warnings: Issue[] = [];
  const ids = new Map<string, string>();
  const powerUse = new Map<string, string>();
  const walk = (list: MeterSpec[], path: string, parent: MeterSpec | null) =>
    list.forEach((x, i) => {
      const p = `${path}[${i}]`;
      if (ids.has(x.id)) errors.push({ path: `${p}.id`, message: `"${x.id}" is already ${ids.get(x.id)}` });
      else if (x.id.endsWith('.other'))
        errors.push({ path: `${p}.id`, message: "ids ending in .other are the plugin's own (a parent's Other)" });
      else ids.set(x.id, p);
      const power = asList(x.power);
      if (!power.length && !x.children?.length)
        errors.push({ path: p, message: 'a meter needs a power entity or children (its power is their sum)' });
      if (x.legs && x.legs.length !== power.length)
        errors.push({
          path: `${p}.legs`,
          message: `${x.legs.length} labels for ${power.length} power entit${power.length === 1 ? 'y' : 'ies'}`,
        });
      for (const e of power) {
        if (powerUse.has(e))
          warnings.push({ path: `${p}.power`, message: `${e} is also ${powerUse.get(e)}'s: it is counted twice` });
        else powerUse.set(e, p);
      }
      (x.feeds || []).forEach((f, j) => {
        if (!feedTarget(f))
          errors.push({
            path: `${p}.feeds[${j}]`,
            message: `name exactly one of ${FEED_KINDS.join(', ')}`,
          });
      });
      if (x.remainder && !x.children?.length)
        warnings.push({ path: `${p}.remainder`, message: 'a remainder without children: there is no Other to show' });
      else if (x.remainder && !power.length)
        warnings.push({
          path: `${p}.remainder`,
          message:
            "a remainder on a meter without power: ignored (its power is its children's sum, so there is no Other)",
        });
      if (parent && (parent.kind ?? 'load') === 'load' && x.kind && x.kind !== 'load')
        warnings.push({ path: `${p}.kind`, message: `a ${x.kind} under a load: it is not summed into the load` });
      if (x.children) walk(x.children, `${p}.children`, x);
    });
  walk(m.meters, 'meters', null);
  if (m.scale?.idle && m.scale.max && m.scale.idle >= m.scale.max)
    errors.push({ path: 'scale.idle', message: 'must be below scale.max' });
  return { ok: !errors.length, errors, warnings };
}
