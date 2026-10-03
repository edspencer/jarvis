// Home Assistant shapes the viewer reads: entity states, the fixture map and the controls
// (ha_controls.json).

export interface EntityAttributes {
  friendly_name?: string;
  brightness?: number | null;
  color_mode?: string;
  rgb_color?: number[];
  xy_color?: number[];
  color_temp_kelvin?: number;
  /** mireds (older HA) */
  color_temp?: number;
  /** a group / Hue room or zone lists its members */
  entity_id?: string[];
  unit_of_measurement?: string;
  installed_version?: string;
  latest_version?: string;
  [key: string]: unknown;
}

export interface EntityState {
  entity_id: string;
  state: string;
  attributes: EntityAttributes;
  last_changed?: string;
  last_updated?: string;
}

export type Entities = Record<string, EntityState>;

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
