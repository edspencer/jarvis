// The safety rules for calling Home Assistant. The viewer is logged in as a user who can do anything in HA (locks,
// covers, the alarm, HVAC, the plug a network switch or a water heater hangs on), so every call goes through send(),
// the single choke point, which checks two things:
//   1. the domain and service: only a short list of pairs (SEND_OK), each entity in the service's own domain;
//   2. every entity: it must be on the allow-list (buildAllowlist), which is made only from the site's own files: the
//      controls file's entities (with the services their action needs) and the fixture map's lights (a switch.* only
//      where the map marks it as a light and the controls file's fixture_toggle allows that), and the service data
//      may only carry a light's brightness and colour.
// No plugin can extend the allow-list at run time. The Controls panel goes through act() on top (controlCall). Pure
// functions, so they can be tested.
import type { Control, Entities, MapEntry, ServiceData, Status, TogglePolicy } from './types';

/** stage 1: the viewer shows (and may switch) lights and switches only */
export const DOMAINS = /^(light|switch)\./;

/** a fixture's entities: one, or several bulbs; only light.* and switch.* ever count */
export function entitiesOf(entry: MapEntry | undefined): string[] {
  const e = entry?.entity_id;
  return (Array.isArray(e) ? e : e ? [e] : []).filter((x): x is string => typeof x === 'string' && DOMAINS.test(x));
}

/** Domain and service pairs the viewer may ever send. Anything else (lock, cover, alarm_control_panel, climate, fan,
 * media_player, …) is refused, whatever the caller. */
export const SEND_OK: Readonly<Record<string, readonly string[]>> = {
  light: ['toggle', 'turn_on', 'turn_off'],
  switch: ['toggle', 'turn_on', 'turn_off'],
  script: ['turn_on'],
  scene: ['turn_on'],
};

const domainOf = (entityId: string): string => String(entityId).split('.')[0];

/** null if send() may make this call, else the refusal */
export function sendRefusal(domain: string, service: string, data: ServiceData): string | null {
  const ids = ([] as string[]).concat(data.entity_id);
  if (
    !Object.hasOwn(SEND_OK, domain) ||
    !SEND_OK[domain].includes(service) ||
    !ids.length ||
    ids.some((e) => domainOf(e) !== domain)
  ) {
    return `refused: ${domain}.${service} on ${ids.join(', ')}`;
  }
  return null;
}

/** entity -> the services send() may call on it */
export type Allowlist = ReadonlyMap<string, ReadonlySet<string>>;

/** the keys a call's data may carry besides entity_id (a light's level and colour: the blink test puts a bulb back) */
export const DATA_OK: ReadonlySet<string> = new Set(['brightness', 'color_temp_kelvin', 'xy_color', 'rgb_color']);

const TOGGLE = ['toggle', 'turn_on', 'turn_off'];

/** Build the allow-list from the site's files: the controls (each with its action's services), and the fixture map's
 * entities the toggle policy lets the model switch. `extra` (mock mode only) adds made-up lights. */
export function buildAllowlist({
  controls,
  map,
  toggle,
  extra = [],
}: {
  controls: readonly Control[];
  map: Record<string, MapEntry>;
  toggle: TogglePolicy;
  extra?: readonly string[];
}): Allowlist {
  const out = new Map<string, Set<string>>();
  const add = (e: string, services: readonly string[]) => {
    if (!out.has(e)) out.set(e, new Set());
    for (const s of services) out.get(e)!.add(s);
  };
  for (const c of controls) {
    if (!c || !isControlAction(c.action)) continue;
    const allowed = CONTROL_SERVICES[c.action][domainOf(c.entity_id)];
    if (allowed) add(c.entity_id, allowed);
  }
  for (const entry of Object.values(map)) {
    for (const e of entitiesOf(entry)) {
      const d = domainOf(e);
      if ((d === 'light' && toggle.light) || (d === 'switch' && toggle.switch_marked_as_light && entry.switch_is_light))
        add(e, TOGGLE);
    }
  }
  for (const e of extra) if (domainOf(e) === 'light') add(e, TOGGLE);
  return out;
}

/** null if every entity in the call is allowed this service and the data carries nothing else, else the refusal */
export function allowRefusal(allow: Allowlist, service: string, data: ServiceData): string | null {
  const ids = ([] as string[]).concat(data.entity_id);
  const off = ids.filter((e) => !allow.get(e)?.has(service));
  if (off.length)
    return `refused: ${off.join(', ')} ${off.length > 1 ? 'are' : 'is'} not on the allow-list for ${service}`;
  const extra = Object.keys(data).filter((k) => k !== 'entity_id' && !DATA_OK.has(k));
  if (extra.length) return `refused: ${extra.join(', ')} in the call's data`;
  return null;
}

/** One action on entities of several domains (a fixture with a light and a switch): one call per domain, and
 * every one of them checked before any is sent, so a refusal never leaves the action half done. */
export function planCalls(
  ids: readonly string[],
  service: string,
  data: Record<string, unknown>,
  allow: Allowlist,
): { calls: [string, ServiceData][] } | { refused: string } {
  const byDomain = new Map<string, string[]>();
  for (const e of ids) {
    const d = domainOf(e);
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d)!.push(e);
  }
  const calls: [string, ServiceData][] = [...byDomain].map(([d, list]) => [
    d,
    { ...data, entity_id: list.length === 1 ? list[0] : list },
  ]);
  if (!calls.length) return { refused: 'refused: no entity' };
  for (const [d, sd] of calls) {
    const r = sendRefusal(d, service, sd) || allowRefusal(allow, service, sd);
    if (r) return { refused: r };
  }
  return { calls };
}

export interface SenderDeps<R> {
  /** the entity allow-list (rebuilt when the site's files load) */
  allow: () => Allowlist;
  /** ?ha=mock: calls go to the simulator, never to HA */
  mock: () => ((domain: string, service: string, data: ServiceData) => Promise<R>) | null;
  status: () => Status;
  /** the live connection, if any */
  connected: () => boolean;
  /** home-assistant-js-websocket's callService on the live connection */
  call: (domain: string, service: string, data: ServiceData) => Promise<R>;
}

/** send(): the only call to Home Assistant. Throws on a refusal or when not connected. */
export function createSender<R>(deps: SenderDeps<R>) {
  return async function send(domain: string, service: string, data: ServiceData): Promise<R | void> {
    const refused = sendRefusal(domain, service, data) || allowRefusal(deps.allow(), service, data);
    if (refused) throw new Error(refused);
    const mock = deps.mock();
    if (mock) return mock(domain, service, data);
    if (!deps.connected() || deps.status() !== 'live') throw new Error('not connected to Home Assistant');
    return deps.call(domain, service, data);
  };
}

/** The HUD controls' actions: run = script / scene turn_on; toggle = a switch or a light, on or off. */
export const CONTROL_SERVICES: Readonly<Record<Control['action'], Readonly<Record<string, readonly string[]>>>> = {
  run: { script: ['turn_on'], scene: ['turn_on'] },
  toggle: { switch: ['turn_on', 'turn_off'], light: ['turn_on', 'turn_off'] },
};

export const isControlAction = (a: unknown): a is Control['action'] =>
  typeof a === 'string' && Object.hasOwn(CONTROL_SERVICES, a);

/** What act() would call for control `c`: its domain and service, or a refusal (never anything outside the list). */
export function controlCall(
  controls: readonly Control[],
  c: Control,
  entities: Entities,
): { domain: string; service: string } | { refused: string } {
  const listed = controls.find((x) => x.id === c.id && x.entity_id === c.entity_id);
  const domain = domainOf(c.entity_id);
  const st = entities[c.entity_id];
  const service = c.action === 'run' ? 'turn_on' : st?.state === 'on' ? 'turn_off' : 'turn_on';
  const allowed = isControlAction(c.action) ? CONTROL_SERVICES[c.action] : undefined;
  if (!listed || !allowed || !Object.hasOwn(allowed, domain) || !allowed[domain].includes(service)) {
    return { refused: `refused ${domain}.${service} on ${c.entity_id} (not in ha_controls.json)` };
  }
  return { domain, service };
}

/** Why a fixture can't be switched from the model, or null if it can. */
export function toggleBlocker({
  entry,
  policy,
  status,
  states,
}: {
  entry: MapEntry | undefined;
  policy: TogglePolicy;
  status: Status;
  states: Entities;
}): string | null {
  const es = entitiesOf(entry);
  const m = entry || {};
  if (!es.length) return 'no Home Assistant entity mapped to this fixture yet';
  for (const e of es) {
    const d = domainOf(e);
    const ok =
      (d === 'light' && policy.light) || (d === 'switch' && policy.switch_marked_as_light && m.switch_is_light);
    if (!ok)
      return `${e} isn't a light the model may switch (the controls file's fixture_toggle)${d === 'switch' ? '; a switch needs switch_is_light in the fixture map' : ''}`;
  }
  if (!(status === 'live' || status === 'mock')) return 'not connected to Home Assistant';
  if (es.every((e) => ['unavailable', 'unknown', undefined].includes(states[e]?.state)))
    return 'unavailable in Home Assistant';
  return null;
}
