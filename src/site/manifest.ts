// The site manifest (site.json): everything that describes one building rather than the viewer. Its JSON Schema is
// schema/site.schema.json; these types match it (tests/unit/site-schema.test.ts checks the two agree). Positions and
// heights are in the plan frame and its units (`frame.units`), except `walk`, whose body sizes are in metres. Paths
// are relative to the manifest's own URL, or absolute URLs.

/** the manifest format this viewer reads */
export const MANIFEST_VERSION = 'jarvis-site/1';

/** a point in the plan frame: X, Y, Z */
export type PlanXYZ = [number, number, number];
/** a point on the plan: X, Y */
export type PlanXY = [number, number];

export interface SiteManifest {
  /** an editor hint (a URL or path to the schema); ignored by the viewer */
  $schema?: string;
  /** the format: 'jarvis-site/1' */
  jarvis: string;
  /** a short id: letters, digits, '-', '_' (used to keep this site's saved state apart from another's) */
  id: string;
  /** shown in the title, the help and the loading screen */
  name: string;
  /** a line under the name in the help */
  description?: string;
  geo: Geo;
  frame?: Frame;
  /** the building's centre on the plan: the sun's shadows, the far ground and the overview aim here (default 0, 0) */
  centre?: PlanXY;
  /** where the overview (orbit) camera starts, plan X, Y, Z (default: off the south-east corner of the model) */
  overview?: { camera?: PlanXYZ };
  ground?: Ground;
  sun?: SunOptions;
  models: Models;
  storeys?: Storey[];
  /** the numbered viewpoints (keys 1-9, ?view=N); at least one */
  viewpoints: Viewpoint[];
  /** the viewpoint the viewer opens at, 1-based (default 1) */
  startView?: number;
  layers?: LayerDef[];
  materials?: MaterialRoles;
  colliders?: Colliders;
  rooms?: Rooms;
  walk?: WalkParams;
  /** each optional layer's configuration, keyed by plugin id; a plugin that isn't listed doesn't start. A section that
   * isn't a built-in plugin's, with a `module`, loads that plugin from the site (an ExternalPluginConfig). */
  plugins?: PluginConfigs;
  /** origins ('https://plugins.example.org') an external plugin's module may come from besides the viewer's own;
   * honoured only when the manifest itself is on the viewer's origin */
  pluginOrigins?: string[];
}

export interface Geo {
  /** degrees, north positive */
  lat: number;
  /** degrees, east positive */
  lon: number;
  /** IANA time zone, e.g. 'Europe/London': the sun's clock time */
  timeZone: string;
}

export interface Frame {
  /** plan units: 'ft' (default) or 'm'. The model itself is always glTF metres. */
  units?: 'ft' | 'm';
  /** true bearing (degrees clockwise from true north) of plan +Y (default 0: plan north is true north) */
  northAzimuth?: number;
}

export interface Ground {
  /** the far ground's level, plan units (default 0); draw it just under the site's own grade */
  z?: number;
  /** the far ground's colour, '#rrggbb' (default a grass green) */
  colour?: string;
}

export interface SunOptions {
  /** half the side of the square the sun's shadows cover, centred on `centre`, plan units (default: fitted to the
   * main model's footprint) */
  shadowRadius?: number;
}

export interface ModelRef {
  /** a .glb or .gltf */
  url: string;
  /** the merged-node parts index (see docs/model-format.md) */
  parts?: string;
}

export interface ExtraModel extends ModelRef {
  /** a short id */
  id: string;
  /** every top-level node of this model joins this layer (declared in `layers`); its key loads the model if needed */
  layer?: string;
}

export interface Models {
  /** loaded first; walking starts once it is in */
  main: ModelRef;
  /** loaded in the background after the main model (with ?noextra, only when their layer's key is pressed) */
  extra?: ExtraModel[];
}

export interface Storey {
  /** e.g. 'ground floor': the HUD shows it under the room name */
  name: string;
  /** a short form for the room list, e.g. 'upstairs' (default: the name) */
  short?: string;
  /** finished floor level, plan units */
  z: number;
  /** a standing position at or above this level is on this storey (default: z) */
  from?: number;
  /** an object whose bottom (or a marker whose position) is above this level belongs to this storey: U hides it with
   * the storeys above the first (default: from) */
  objectsFrom?: number;
}

export interface Viewpoint {
  name: string;
  /** plan X, Y and the floor's Z */
  at: PlanXYZ;
  /** degrees: 0 = plan north, 90 = west, 180 = south, -90 = east */
  yaw: number;
}

/** Which top-level nodes a layer takes: any one rule matching is enough. */
export interface LayerMatch {
  /** node names starting with one of these */
  namePrefix?: string[];
  /** the node's `layer` extra is one of these */
  layer?: string[];
  /** one of the node's meshes uses a material with one of these names */
  material?: string[];
  /** the node has one of these extras, truthy */
  extra?: string[];
}

export interface LayerDef {
  /** 'roof', 'ceiling' and 'door' are built in (X cutaway, U, O); any other id is the site's own */
  id: string;
  /** the flag row and the help: 'Shed' -> 'Shed hidden'; a layer that starts hidden shows 'Doors' while shown */
  label?: string;
  /** the toggle key, one letter (not one the viewer or its plugins use) */
  key?: string;
  /** the help's line, after 'Show / hide' (default: the label in lower case) */
  help?: string;
  /** hidden at start (default false; the door layer defaults to true) */
  hidden?: boolean;
  /** default: { layer: [id] }, or the built-in layer's rules */
  match?: LayerMatch;
}

export interface MaterialRoles {
  /** see-through glass: drawn faint, looked through when picking, passable (default ['glass']) */
  glass?: string[];
  /** water: drawn translucent, passable (default ['water']) */
  water?: string[];
  /** wire screens (an insect screen, a mesh fence): name -> the wire's share of the area, 0-1 */
  screens?: Record<string, { wire: number }>;
}

export interface Colliders {
  /** top-level nodes walked through (besides glass, water, fixtures, plants, wall plates and every toggled layer) */
  passable?: LayerMatch;
}

export interface Rooms {
  /** floor nodes named with this prefix and carrying a `room` extra are the rooms (default 'Floor_') */
  floorPrefix?: string;
}

/** The walker's body, in metres. */
export interface WalkParams {
  /** eye height above the feet (default 1.6764: 5.5 ft) */
  eyeHeight?: number;
  /** eye height while crouching (default 0.9144: 3 ft) */
  crouchEyeHeight?: number;
  /** body radius for wall collision (default 0.3) */
  radius?: number;
  /** the highest step walked up without a jump (default 0.35); raise it for steps the model has no treads for */
  maxStep?: number;
}

export interface HomeAssistantConfig {
  /** Home Assistant's base URL; it must list the viewer's origin in http: cors_allowed_origins */
  url?: string;
  /** the Controls panel's actions and the fixture-toggle policy. With the lights plugin's fixture map, this is the
   * allow-list: the viewer calls Home Assistant only for entities named in one of the two. */
  controls?: string;
  /** deprecated: plugins.lights.map (read as that when there is no lights section) */
  map?: string;
  /** deprecated: plugins.lights.emitterHints */
  emitterHints?: string;
}

/** The lights plugin also starts, with these defaults, on a site with a home-assistant section and no lights section. */
export interface LightsConfig {
  /** the fixture map: fixture id -> entity (or entities); also what Home Assistant may switch from the model */
  map?: string;
  /** a regular expression (case-insensitive) on material names: which parts of a fixture glow when it has no
   * emissive material (default: glass, bulb, lens, shade, led, light, globe, …) */
  emitterHints?: string;
}

export interface FaultsConfig {
  /** device -> place and health map */
  devices: string;
  /** shown as the panel's source row, e.g. the file the device map is built from */
  source?: string;
}

export interface PinCategory {
  /** one character drawn on the pin */
  letter: string;
  /** '#rrggbb' */
  colour: string;
  name: string;
}

export interface PinsConfig {
  /** the equipment registry, placed */
  registry: string;
  /** a link for an item's source file: '{file}' is replaced by its path */
  sourceLink?: string;
  /** a prefix taken off the file path where it is shown */
  stripPrefix?: string;
  /** category id -> letter, colour and name (default: a general building set) */
  categories?: Record<string, PinCategory>;
}

export interface SwitchesConfig {
  /** a regular expression for box ids written in notes and roles: group 1 the box, optional group 2 a position
   * (default: the box ids the plates carry, written as they are) */
  boxIdPattern?: string;
  /** shown as the panel's source row: '{file}' is replaced by the plate's `file` extra */
  source?: string;
}

export interface BlueprintsConfig {
  /** the sheet index; images are relative to it */
  index: string;
  /** the sheet B shows the first time (default: the first sheet) */
  default?: string;
}

export interface EnergyConfig {
  /** the energy map: meters (feed → panel → circuit → device), their entities and what they feed in the model
   * (schema/energy.schema.json, docs/plugins/energy.md) */
  map: string;
}

/** The voice assistant's companion server (docs/design/voice-assistant.md). With no server reachable the plugin stays
 * quiet: its status item says "Assistant offline" and it keeps retrying. */
export interface AssistantConfig {
  /** the server's base URL, relative to the page: a same-origin path through the reverse proxy, '/assistant'
   * (cross-origin isn't supported in v1: plain HTTP, no CORS). The WebSocket is <server>/ws; transcription is
   * POST <server>/transcribe */
  server: string;
  /** speak replies with the browser's speech synthesis (default true; the panel's toggle overrides it per browser) */
  tts?: boolean;
}

/** a plugin loaded from the site: its module, and whatever fields the plugin itself reads (its ctx.config) */
export interface ExternalPluginConfig {
  /** the ES module whose default export is the plugin, relative to the manifest */
  module: string;
  /** the letter keys it binds, as the site declares them: wins over the plugin's own `keys` (not in ctx.config) */
  keys?: string[];
  [field: string]: unknown;
}

/** the built-in plugins' sections (an external plugin's is an ExternalPluginConfig under its own id) */
export interface PluginConfigs {
  'home-assistant'?: HomeAssistantConfig;
  lights?: LightsConfig;
  faults?: FaultsConfig;
  pins?: PinsConfig;
  switches?: SwitchesConfig;
  blueprints?: BlueprintsConfig;
  energy?: EnergyConfig;
  assistant?: AssistantConfig;
}
