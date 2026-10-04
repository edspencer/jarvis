// Home Assistant shapes the viewer reads: entity states, the fixture map and the controls
// (ha_controls.json).

// the store's entity shape is Home Assistant's state object
export type { EntityAttributes, EntityState, Entities } from '../../plugin-api';

/** service call data: always an entity_id (one or several), plus attributes for turn_on */
export interface ServiceData {
  entity_id: string | string[];
  [key: string]: unknown;
}

/** one fixture's entry in the fixture map */
export interface MapEntry {
  /** one entity, or several bulbs lighting one fixture; null = none mapped yet */
  entity_id?: string | string[] | null;
  conf?: string;
  src?: string;
  group?: string;
  /** 'off': a smart bulb behind a wall switch; unavailable just means the switch is off */
  unavailable_means?: string;
  /** a switch.* entity that is really a light (the model may switch it) */
  switch_is_light?: boolean;
}

export interface Control {
  id: string;
  label: string;
  entity_id: string;
  /** run: script / scene turn_on; toggle: a switch or light, on / off */
  action: 'run' | 'toggle';
  /** ask first, with this question */
  confirm?: string;
  /** a power sensor to show beside a toggle (W) */
  power?: string;
  /** ?ha=mock's rough stand-in for a script: which rooms' lights go on or off */
  mock?: { lights_on?: string[]; lights_off?: string[]; except?: string[] };
}

/** which fixtures the model may switch (ha_controls.json fixture_toggle) */
export interface TogglePolicy {
  light?: boolean;
  switch_marked_as_light?: boolean;
}

export type Status = 'disconnected' | 'connecting' | 'live' | 'error' | 'mock';
export type ConnectorStatusLabel = Record<Status, string>;

/** the `home-assistant.auth` service: the person's Home Assistant login, for plugins whose own server checks it (the
 * assistant). null in mock or off mode, or when nobody is logged in; an expired token is refreshed first. */
export interface HomeAssistantAuth {
  accessToken(): Promise<string | null>;
}
