// The safety rules for calling Home Assistant. The viewer is logged in as a user who can do anything in HA (locks,
// covers, the alarm, HVAC), so every call goes through send(), which allows only a short list of domain and
// service pairs, each entity in the service's own domain; the HUD's buttons go through act() on top, which allows only
// entities listed in ha_controls.json and the service their action needs. Pure functions, so they can be tested.
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

export interface SenderDeps<R> {
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
    const refused = sendRefusal(domain, service, data);
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
