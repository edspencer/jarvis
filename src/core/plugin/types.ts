// The plugin API: everything a plugin can see and do. These types are the public contract (docs/plugins.md); the
// implementations live next to them (host.ts, store.ts, keys.ts, …) and in src/ui/ (the HUD).
//
// A plugin is a definePlugin({ id, setup(ctx) }) object. The host starts it once the main model is in, if the site
// manifest has a section for it (plugins.<id>) or it is marked autoStart, after the plugins it `requires` (and those
// listed in `after`, when present). Everything a plugin registers through ctx is disposed with it; a plugin that throws
// is stopped, reported with a toast, and the walkthrough carries on without it.
import type * as THREE from 'three';

// ------------------------------------------------------------------ basics

/** walking (first person) or the overview (orbit) */
export type Mode = 'walk' | 'orbit';

/** the view's toggles, as plugins see them (read-only: change them through ViewApi) */
export interface ViewState {
  readonly mode: Mode;
  readonly cutaway: boolean;
  readonly upperHidden: boolean;
  readonly ghost: boolean;
  /** layer id -> hidden */
  readonly hidden: Readonly<Record<string, boolean>>;
}

/** what the site manifest says, resolved (paths are URLs, defaults filled in) */
export interface SiteInfo {
  id: string;
  name: string;
  description: string;
  /** the manifest's own URL: ctx.load() resolves against it */
  url: string;
  geo: { lat: number; lon: number; timeZone: string };
  /** plan units */
  units: 'ft' | 'm';
  /** metres per plan unit */
  unit: number;
  /** true bearing of plan +Y, degrees */
  northAzimuth: number;
  /** the building's centre on the plan */
  centre: [number, number];
  /** bottom up */
  storeys: StoreyInfo[];
  viewpoints: { name: string; at: [number, number, number]; yaw: number }[];
  layers: LayerInfo[];
  /** every plugin's resolved manifest section (null: not configured); your own is ctx.config */
  plugins: Readonly<Record<string, unknown>>;
}
export interface StoreyInfo {
  name: string;
  short: string;
  /** floor level, plan units */
  z: number;
  /** a standing position above this is on this storey */
  from: number;
  /** an object whose bottom is above this belongs to this storey */
  objectsFrom: number;
}
export interface LayerInfo {
  id: string;
  label: string;
  /** the toggle key's KeyboardEvent.code, or null */
  code: string | null;
  key: string | null;
  help: string;
  /** hidden at start */
  hidden: boolean;
  /** the extra model whose nodes all join it, or null */
  model: string | null;
  builtin: boolean;
}

/** the loaded model, as plugins see it (docs/model-format.md); treat it as read-only */
export interface ModelInfo {
  root: THREE.Object3D;
  /** fixture id -> its node (the lamps of an extra model join when it loads: the `model` event) */
  fixtures: Record<string, THREE.Object3D>;
  /** room floor nodes (a `room` extra) */
  rooms: THREE.Object3D[];
  /** the top-level nodes */
  owners: THREE.Object3D[];
  /** top-level nodes by what hides them: one list per layer, and `upper` (the storeys above the first) */
  groups: Record<string, THREE.Object3D[]> & { upper: THREE.Object3D[] };
  /** the main model's wall-plate group (extras layer: switches), or null */
  switchRoot: THREE.Object3D | null;
  /** the main model's box, world space */
  box: THREE.Box3;
  /** the top-level node a descendant belongs to */
  ownerOf(o: THREE.Object3D): THREE.Object3D;
}

/** a model hit */
export interface PickResult {
  node: THREE.Object3D;
  hit: THREE.Intersection;
  /** a merged node's source object (the parts file), or null */
  part: { name: string; props: Record<string, unknown> } | null;
}

export interface Disposable {
  dispose(): void;
}

/** a core icon name ('pin', 'sun', 'bolt', …: src/ui/icons.ts) or an SVG string ('<svg …>'), kept to drawing elements and
 * presentation attributes (no scripts, styles, links, <use> or animation) */
export type IconRef = string;

/** the shared status colours (hud-panels.md §5): one meaning each, always with a glyph or text */
export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'off';

/** a letter on a coloured disc: a pin category, a device's severity */
export interface Glyph {
  letter: string;
  /** '#rrggbb' */
  colour: string;
  /** placed by its room only: drawn as a ring */
  hollow?: boolean;
}

// ------------------------------------------------------------------ subjects

/** What the inspector shows: something picked in the model, or an item a plugin owns. */
export type Subject =
  | {
      kind: 'object';
      node: THREE.Object3D;
      /** a merged node's source object (the parts file) */
      part?: { name: string; props: Record<string, unknown> } | null;
      /** the hit, when it was picked */
      hit?: THREE.Intersection | null;
    }
  | {
      kind: 'item';
      /** '<owner kind>:<id>': 'pins:elec.panel.a', 'plates:KT-S-A', 'devices:zha-1234' */
      id: string;
      hit?: THREE.Intersection | null;
    };

/** A subject, or a string reference to one: 'pins:elec.panel.a', 'fixture:<fixture id>', 'room:<room id>'. */
export type SubjectRef = Subject | string;

/** the inspector header for a subject */
export interface SubjectInfo {
  title: string;
  /** the line under the title: 'Light fixture · pendant · kitchen' */
  type?: string;
  icon?: IconRef;
  glyph?: Glyph;
  /** a short trail above the title: ['Kitchen', 'lights'] */
  crumbs?: string[];
}

/** a plugin's item kind ('pins', 'plates', 'devices'): its titles, and how to fly to one */
export interface SubjectResolver {
  describe(id: string): SubjectInfo | null;
  /** fly the camera to it (default: nothing) */
  fly?(id: string): void;
}

// ------------------------------------------------------------------ blocks: declarative UI

/** an inline value: plain text, or a styled span */
export type Inline = string | number | InlineSpan | (string | number | InlineSpan)[];
export interface InlineSpan {
  text: string;
  /** a status pill */
  pill?: Tone;
  /** coloured text */
  tone?: Tone;
  muted?: boolean;
  mono?: boolean;
  title?: string;
  /** an external link (opens in a new tab) */
  href?: string;
}

export interface ButtonSpec {
  label: string;
  kind?: 'primary' | 'secondary' | 'danger';
  /** shown as a key hint on the button ('T') */
  key?: string;
  title?: string;
  disabled?: boolean;
  /** ask first, with the standard modal */
  confirm?: string | ConfirmSpec;
  onClick(): void;
}

/** a link: to a subject (title and icon from its owner), or a custom one */
export type LinkItem =
  | SubjectRef
  | {
      text: string;
      icon?: IconRef;
      glyph?: Glyph;
      subject?: SubjectRef;
      run?(): void;
      href?: string;
      title?: string;
    };

export interface ListRow {
  /** stable key for the list diff (default: the index) */
  id?: string;
  text: string;
  secondary?: string;
  /** trailing value: '3.1 kW', '›' */
  value?: string;
  dot?: Tone;
  glyph?: Glyph;
  icon?: IconRef;
  /** fly there and open it */
  subject?: SubjectRef;
  /** or run this */
  run?(): void;
  title?: string;
  selected?: boolean;
  /** 0-1: a bar under the row */
  bar?: number;
}

export interface ChipItem {
  id: string;
  label: string;
  glyph?: Glyph;
  dot?: Tone;
  count?: number | string;
  on: boolean;
  title?: string;
  onToggle(): void;
  /** Alt-click, and the chip's "only" menu item */
  onSolo?(): void;
}

export type Block =
  | { type: 'kv'; rows: ([string, Inline] | { key: string; value: Inline; title?: string } | null | false)[] }
  | { type: 'note'; text: string; label?: string; lines?: number }
  | { type: 'label'; text: string }
  | { type: 'text'; text: Inline }
  | {
      type: 'list';
      title?: string;
      rows: ListRow[];
      empty?: string;
    }
  | {
      type: 'group';
      /** remembered collapse state (per site) */
      id: string;
      title: string;
      count?: number | string;
      collapsed?: boolean;
      blocks: Block[];
    }
  | { type: 'chips'; items: ChipItem[] }
  | {
      type: 'toggle';
      label: string;
      value: boolean;
      key?: string;
      title?: string;
      disabled?: boolean;
      onChange(v: boolean): void;
    }
  | {
      type: 'slider';
      label: string;
      min: number;
      max: number;
      step?: number;
      value: number;
      /** shown beside it */
      valueText?: string;
      title?: string;
      onInput(v: number): void;
    }
  | {
      type: 'select';
      label: string;
      value: string;
      options: { value: string; label: string }[];
      title?: string;
      onChange(v: string): void;
    }
  | {
      type: 'segmented';
      label?: string;
      value: string;
      options: { value: string; label: string; title?: string }[];
      onChange(v: string): void;
    }
  | {
      type: 'search';
      /** remembered focus target ('pins.search') */
      id: string;
      value: string;
      placeholder?: string;
      /** key hint ('/') */
      key?: string;
      onInput(v: string): void;
      onEnter?(): void;
    }
  | { type: 'meter'; value: number | string; unit?: string; spark?: number[] }
  | { type: 'status'; tone: Tone; text: string; detail?: string }
  | { type: 'links'; title?: string; items: LinkItem[] }
  | { type: 'buttons'; items: ButtonSpec[] }
  | { type: 'callout'; tone: Tone; text: string; action?: { label: string; run(): void } }
  | { type: 'textarea'; value: string; rows?: number }
  | { type: 'empty' | 'error' | 'loading'; text: string; retry?(): void }
  | { type: 'custom'; key: string; render(el: HTMLElement): void | (() => void) };

/** the blocks to show, or null/false entries to skip */
export type Blocks = (Block | null | false | undefined | '' | 0)[];

// ------------------------------------------------------------------ the HUD

export interface PanelBody {
  /** fill the panel with blocks; `fn` runs again on every refresh */
  blocks(fn: () => Blocks): void;
  /** or draw it yourself: a container with the theme's CSS variables in scope */
  readonly el: HTMLElement;
}

export interface PanelSpec {
  /** 'pins.equipment' */
  id: string;
  title: string;
  icon: IconRef;
  /** opens / closes it; in help and the rail tooltip */
  key?: KeySpec;
  /** position on the rail (core panels 10-30, plugins 40+) */
  order?: number;
  badge?: () => string | number | null;
  /** badge colour (default: neutral) */
  badgeTone?: () => Tone | null;
  /** header text right of the title ('140 shown') */
  meta?: () => string | null;
  render(body: PanelBody): void | (() => void);
  /** footer buttons */
  actions?: () => ButtonSpec[];
  /** the rail button only appears while this is true */
  when?: () => boolean;
}

export interface PanelHandle extends Disposable {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /** re-run the panel's blocks, badge and meta (throttled by the HUD) */
  refresh(): void;
}

export interface LegendItem {
  label: string;
  tone?: Tone;
  colour?: string;
  glyph?: Glyph;
  hollow?: boolean;
}

export interface LegendSpec {
  id: string;
  title: string;
  /** right of the title: 'V · Shift-V all' */
  hint?: string;
  when(): boolean;
  items(): LegendItem[];
}

export interface HudApi {
  addPanel(p: PanelSpec): PanelHandle;
  addLegend(l: LegendSpec): Disposable;
  /** something the HUD shows changed: badges, status items, chips, legends (coalesced to one update a frame) */
  invalidate(): void;
}

export interface SectionContentBlocks {
  blocks: Blocks;
  actions?: ButtonSpec[];
}
export interface SectionContentRender {
  /** a stable key: the element is kept while the key stays the same */
  key: string;
  render(el: HTMLElement): void | (() => void);
}
export type SectionContent = SectionContentBlocks | SectionContentRender;

export interface SectionProvider {
  /** 'lights' (its collapse state is remembered under this id) */
  id: string;
  title: string;
  icon: IconRef;
  /** base 0, the subject's owner 10, others 50+ */
  order?: number;
  defaultCollapsed?: boolean;
  /** null = nothing to say about this subject */
  for(s: Subject): SectionContent | null;
}

export interface InspectorApi {
  addSection(s: SectionProvider): Disposable;
  /** titles and fly-to for a kind of item ('pins' for 'pins:<id>') */
  registerSubject(kind: string, r: SubjectResolver): Disposable;
  /** a header for objects picked in the model (a fixture is a 'Light fixture'); the first non-null answer wins */
  describeObject(fn: (node: THREE.Object3D) => Partial<SubjectInfo> | null): Disposable;
  /** show a subject; `fly` also flies there. Pushes the history. */
  open(s: SubjectRef, opts?: { fly?: boolean }): void;
  close(): void;
  current(): Subject | null;
  /** re-run the open subject's sections (throttled; the DOM is diffed, so scroll and focus stay) */
  refresh(match?: (s: Subject) => boolean): void;
  /** a subject's header */
  describe(s: SubjectRef): SubjectInfo | null;
  /** turn a reference into a subject (null if its owner doesn't know it) */
  resolve(s: SubjectRef): Subject | null;
  /** a subject's reference string for bindings: 'fixture:<id>' for a fixture, the id for an item, else null */
  refOf(s: Subject): string | null;
}

export interface StatusView {
  text: string;
  /** bold lead text before `text` */
  strong?: string;
  dot?: Tone;
  icon?: IconRef;
  title?: string;
}

export interface StatusItemSpec {
  id: string;
  order?: number;
  /** null hides it */
  render(): StatusView | null;
  onClick?(): void;
}

export interface ToggleVariant {
  label: string;
  key?: KeySpec;
  get(): boolean;
  set(v: boolean): void;
}

export interface ToggleSpec {
  id: string;
  label: string;
  icon?: IconRef;
  /** pressing it toggles; shown on the chip, in help and the tooltip */
  key?: KeySpec;
  title?: string;
  /** strip order (core layers 10-30, plugins 40+) */
  order?: number;
  get(): boolean;
  set(v: boolean): void;
  /** extra modes in the chip's menu ('Through walls', Shift-P) */
  variants?: ToggleVariant[];
  /** the chip only shows while this is true */
  when?: () => boolean;
  /** a label override while on ('Pins · through walls') */
  text?: () => string;
  /** remember the state per site (URL parameters still win) */
  persist?: boolean;
  /** rarely used: it lives in the strip's ⋯ menu (its key still works) */
  overflow?: boolean;
}

export interface ProgressHandle {
  /** 0-100, or null for indeterminate */
  set(pct: number | null, label?: string): void;
  done(): void;
}

export interface StatusApi {
  addItem(i: StatusItemSpec): Disposable;
  addToggle(t: ToggleSpec): Disposable;
  progress(label: string): ProgressHandle;
}

export interface ToastSpec {
  text: string;
  tone?: Tone;
  /** stays until dismissed (errors always do) */
  sticky?: boolean;
  /** ms (default 4000) */
  timeout?: number;
  actions?: { label: string; run(): void }[];
}
export interface ToastHandle {
  update(t: Partial<ToastSpec>): void;
  close(): void;
}

export interface ConfirmSpec {
  title: string;
  text?: string;
  /** the confirm button's label (default 'OK') */
  confirm?: string;
  danger?: boolean;
}

export interface ModalSpec {
  title: string;
  /** blocks (re-run on refresh), or a custom renderer */
  blocks?: () => Blocks;
  render?(el: HTMLElement): void | (() => void);
  actions?: () => ButtonSpec[];
  onClose?(): void;
  /** wider (help) */
  wide?: boolean;
}
export interface ModalHandle {
  close(): void;
  refresh(): void;
}

export interface HoverProvider {
  id: string;
  order?: number;
  /** a short line after the subject's title ('on 82 %'), or null */
  label(s: Subject): string | null;
}

export interface SearchHit {
  text: string;
  secondary?: string;
  glyph?: Glyph;
  icon?: IconRef;
  subject?: SubjectRef;
  run?(): void;
}
export interface SearchProvider {
  id: string;
  /** the group heading in the results */
  label: string;
  order?: number;
  search(q: string): SearchHit[];
}

// ------------------------------------------------------------------ keys

export interface KeySpec {
  /** KeyboardEvent.code: 'KeyP', 'Slash', 'Digit1' */
  code: string;
  shift?: boolean;
  alt?: boolean;
  /** what it does, for help and tooltips */
  label: string;
  /** shown instead of the key name in help ('W A S D / arrows') */
  display?: string;
  /** the help's heading for it (default: the plugin's name) */
  group?: string;
  /** only active while this is true */
  when?: () => boolean;
}

export interface KeyBinding extends KeySpec {
  /** omitted: listed in help only (keys the core handles itself, e.g. held movement keys) */
  run?(e: KeyboardEvent): void;
  /** the key went up again (hold to talk): called once per press, also when the window loses focus while it's
   * held. Key repeat never runs `run` again while the key is held. */
  release?(e: KeyboardEvent | null): void;
  /** works but isn't listed in help (another entry describes it: keys 2-6 under '1 – 6') */
  hidden?: boolean;
}

export interface KeyEntry extends KeyBinding {
  /** the plugin (or 'core') that registered it */
  owner: string;
  ownerName: string;
}

export interface KeyApi {
  add(k: KeyBinding): Disposable;
  /** every registered key, for help */
  list(): KeyEntry[];
  /** 'Shift-P' */
  name(k: Pick<KeySpec, 'code' | 'shift' | 'alt'>): string;
}

// ------------------------------------------------------------------ events

export interface ViewerEvents {
  /** every frame, before rendering */
  frame: { dt: number; now: number };
  /** the inspector's subject changed */
  select: { subject: Subject | null; previous: Subject | null };
  mode: { mode: Mode };
  /** visibility was re-applied (a layer, U, X, a blueprint's "hide above") */
  visibility: Record<string, never>;
  /** a model is in ('main', or an extra model's id): there may be new fixtures */
  model: { id: string };
  pointerlock: { locked: boolean };
  /** every plugin has started (or failed): a plugin can now see which others run */
  ready: Record<string, never>;
  /** a click on the view, before it inspects: set `handled` to stop that (Shift-click switches a light) */
  click: { subject: Subject | null; shiftKey: boolean; handled: boolean };
}

export interface EventBus {
  on<K extends keyof ViewerEvents>(name: K, fn: (e: ViewerEvents[K]) => void): Disposable;
  /** a plugin's own event: '<plugin id>:<name>' */
  on(name: string, fn: (e: unknown) => void): Disposable;
  emit<K extends keyof ViewerEvents>(name: K, e: ViewerEvents[K]): void;
  emit(name: string, e?: unknown): void;
}

// ------------------------------------------------------------------ the store: devices, entities, bindings

/** An entity's state. The shape is Home Assistant's state object, a widely used and documented one; other connectors
 * map into it (attributes.device_class, unit_of_measurement and friendly_name keep their usual meaning). */
export interface EntityState {
  entity_id: string;
  state: string;
  attributes: EntityAttributes;
  last_changed?: string;
  last_updated?: string;
}
export interface EntityAttributes {
  friendly_name?: string;
  device_class?: string;
  unit_of_measurement?: string;
  brightness?: number | null;
  color_mode?: string;
  rgb_color?: number[];
  xy_color?: number[];
  color_temp_kelvin?: number;
  color_temp?: number;
  /** a group lists its members */
  entity_id?: string[];
  installed_version?: string;
  latest_version?: string;
  [key: string]: unknown;
}
export type Entities = Record<string, EntityState>;

/** connector-neutral actions; a connector maps them to its own services (HA: <domain>.<action>) */
export type StoreAction = 'toggle' | 'turn_on' | 'turn_off';

export type ConnectorStatus = 'disconnected' | 'connecting' | 'live' | 'error' | 'mock';

export interface ConnectorInfo {
  id: string;
  name: string;
  status: ConnectorStatus;
  /** an error or a note */
  detail: string;
}

export interface ConnectorSpec {
  id: string;
  name: string;
  /** execute an action under the connector's own allow-list; throws with the reason on refusal or failure */
  call(entityIds: string[], action: StoreAction, data?: Record<string, unknown>): Promise<void>;
  /** why the action (with this data) would be refused, null if it may be called: everything call() would refuse it for,
   * as the store checks every connector's part before it sends any. Also for disabling buttons up front. */
  refusal?(entityIds: string[], action: StoreAction, data?: Record<string, unknown>): string | null;
  /** mock mode: take made-up states (for testing other plugins against fake data) */
  simulate?(states: EntityState[]): void;
  /** past states of one of its entities between two times (ms), oldest first; read-only */
  history?(entityId: string, from: number, to: number): Promise<HistoryPoint[]>;
}

/** one past state: when, the state, and its number (null if it isn't one: 'unavailable', 'on') */
export interface HistoryPoint {
  t: number;
  state: string;
  v: number | null;
}

export interface ConnectorHandle extends Disposable {
  /** replace this connector's entities (unchanged objects keep their identity, so only real changes notify) */
  replace(ents: Entities): void;
  /** add or update some */
  update(states: EntityState[]): void;
  status(s: ConnectorStatus, detail?: string): void;
}

/** a site mapping: a reference ('fixture:den.lamp', 'pins:elec.panel.a', 'devices:abc') -> entities */
export interface BindingInput {
  ref: string;
  entities: string[];
  /** who said so (default: the plugin that bound it) */
  source?: string;
  /** 'high' | 'low' | 'mock' | … (mock bindings give way to any other) */
  conf?: string;
  /** where it comes from ('name match', 'blink test 2026-09-30') */
  src?: string;
  /** anything else the mapping says (unavailable_means, switch_is_light, group, …) */
  meta?: Record<string, unknown>;
}
export interface Binding extends BindingInput {
  source: string;
}

export interface StoreChange {
  /** the entity ids that changed */
  changed: string[];
  entities: Entities;
  previous: Entities;
}

export interface Store {
  get(id: string): EntityState | undefined;
  /** every entity, as one snapshot (a new object after each change) */
  entities(): Entities;
  /** called after changes; `filter` limits it to some entities */
  onChange(fn: (c: StoreChange) => void, filter?: string[] | ((id: string) => boolean)): Disposable;
  /** route an action to the connector that owns these entities (several connectors: split) */
  call(entityIds: string | string[], action: StoreAction, data?: Record<string, unknown>): Promise<void>;
  /** why call() (with this data) would be refused, or null */
  refusal(entityIds: string | string[], action: StoreAction, data?: Record<string, unknown>): string | null;
  /** the connector an entity comes from */
  sourceOf(id: string): string | undefined;
  /** the numeric changes seen since the page loaded (the last ~360), for a live sparkline */
  recent(id: string): HistoryPoint[];
  /** an entity's past states between two times (ms since 1970), from the owning connector's recorder if it has one
   * (Home Assistant's history), else what this page has seen; oldest first */
  history(id: string, from: number, to?: number): Promise<HistoryPoint[]>;

  addConnector(c: ConnectorSpec): ConnectorHandle;
  connectors(): ConnectorInfo[];
  /** is any connector delivering states (live or mock)? */
  live(): boolean;
  /** any connector in mock mode? */
  mock(): boolean;
  /** hand made-up states to the mock connectors (no-op unless one is in mock mode) */
  simulate(states: EntityState[]): void;
  onConnectors(fn: () => void): Disposable;

  /** declare that a reference is bound to entities (a site mapping file) */
  bind(b: BindingInput): Disposable;
  /** the bindings of a reference; mock bindings only where no other binding names an entity */
  bindingsOf(ref: string): Binding[];
  /** the entities bound to a reference (de-duplicated) */
  entitiesOf(ref: string): string[];
  /** the references an entity is bound to */
  refsOf(entityId: string): string[];
  onBindings(fn: () => void): Disposable;
}

// ------------------------------------------------------------------ the scene

export interface ThreeApi {
  THREE: typeof THREE;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  model: ModelInfo;
  /** plan (X east, Y north, Z up; plan units) -> three.js world (metres, Y up) */
  P(x: number, y: number, z: number): THREE.Vector3;
  /** three.js world -> plan */
  toPlan(v: THREE.Vector3): { X: number; Y: number; Z: number };
  /** metres per plan unit */
  unit: number;
  /** material overrides: the only way to change what a model mesh is drawn with (see MaterialsApi) */
  materials: MaterialsApi;
}

/** an override's material: a fixed one, or one made from the material beneath it (the mesh's own, or a lower layer's;
 * called again whenever the stack changes, so cache what it makes) */
export type MaterialLayer = THREE.Material | ((below: THREE.Material, mesh: THREE.Mesh) => THREE.Material);

/** one layer on a set of meshes; dispose takes it off (in any order), and it goes when the plugin stops */
export interface MaterialOverride extends Disposable {
  /** change this layer's material; it keeps its place in each mesh's stack */
  set(m: MaterialLayer): void;
  /** run the layers again (yours changed what a function above it copies, e.g. a light's glow under the fade) */
  refresh(): void;
}

/** Each mesh shows the top of a stack of overrides over its own material: higher `priority` on top (default 0; the
 * lights' glowing copies are at -10, the blueprint fade at -5, energy mode at 0), and the later push on top of an
 * equal one. Don't assign `mesh.material` on model meshes yourself. */
export interface MaterialsApi {
  push(meshes: THREE.Mesh | Iterable<THREE.Mesh>, m: MaterialLayer, opts?: { priority?: number }): MaterialOverride;
  /** the mesh's own material, whatever is drawn over it (also in userData.baseMaterial while it has overrides) */
  base(mesh: THREE.Mesh): THREE.Material;
}

export interface ViewApi {
  readonly state: Readonly<ViewState>;
  setMode(m: Mode): void;
  /** fly the camera to look at a world point, standing off towards `centre` (null: away from the building) */
  fly(target: THREE.Vector3, centre?: THREE.Vector3 | null): void;
  /** fly to a subject (its owner knows where it is) */
  flyTo(s: SubjectRef): void;
  /** walk to a plan position */
  teleport(x: number, y: number, z: number, yaw: number): void;
  /** the room id the walker is in, or null */
  here(): string | null;
  /** where the person is aiming, NDC: the crosshair while walking with the mouse captured, else the mouse */
  aim(): THREE.Vector2;
  /** can the camera see this world point? (a ray against the collider) */
  seen(p: THREE.Vector3): boolean;
  /** hide these objects too while the rule says so (re-run on applyVisibility) */
  addVisibilityRule(fn: () => Iterable<THREE.Object3D>): Disposable;
  applyVisibility(): void;
  toggleLayer(id: string): void;
  layers(): LayerInfo[];
  requestShadows(): void;
}

export interface PickApi {
  /** the subject under a screen point (NDC): marker pickers first, then the model */
  at(ndc: THREE.Vector2): Subject | null;
  /** the model under a screen point */
  model(ndc: THREE.Vector2): PickResult | null;
  /** markers drawn in screen space (pins, fault markers): checked before the model, lowest order first */
  addScreenPicker(p: { id: string; order?: number; at(ndc: THREE.Vector2): Subject | null }): Disposable;
  /** turn a model hit into a plugin's subject (a wall plate's instance) */
  addResolver(fn: (p: PickResult) => Subject | null): Disposable;
}

// ------------------------------------------------------------------ the rest of ctx

export interface UrlApi {
  has(k: string): boolean;
  get(k: string): string | null;
  /** a number, or `d` */
  num(k: string, d: number): number;
  /** change the address bar (no reload); null removes it */
  set(k: string, v: string | null): void;
}

export interface StorageApi {
  get<T>(key: string, d: T): T;
  set(key: string, v: unknown): void;
  remove(key: string): void;
}

export interface ServicesApi {
  /** offer an API to other plugins under a name */
  provide<T>(name: string, api: T): Disposable;
  get<T>(name: string): T | undefined;
}

export interface Logger {
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

export interface PluginContext<C = unknown> {
  /** this plugin's id */
  id: string;
  site: SiteInfo;
  /** the plugin's manifest section, with its paths resolved to URLs ({} for an autoStart plugin with none) */
  config: C;
  three: ThreeApi;
  view: ViewApi;
  pick: PickApi;
  events: EventBus;
  keys: KeyApi;
  store: Store;
  hud: HudApi;
  inspector: InspectorApi;
  status: StatusApi;
  hover: { add(p: HoverProvider): Disposable };
  search: { add(p: SearchProvider): Disposable };
  toast(t: ToastSpec | string): ToastHandle;
  confirm(c: ConfirmSpec): Promise<boolean>;
  modal(m: ModalSpec): ModalHandle;
  url: UrlApi;
  /** per site and plugin, in localStorage */
  storage: StorageApi;
  services: ServicesApi;
  plugins: { has(id: string): boolean };
  log: Logger;
  /** fetch JSON relative to the site manifest (or an absolute URL) */
  load<T>(path: string): Promise<T>;
  /** put an API on the console hook (window.twin.<name>) */
  expose(name: string, api: unknown): void;
  /** tie a disposer to this plugin's life */
  own(d: Disposable | (() => void)): void;
}

export interface PluginInstance {
  dispose?(): void;
}

export interface PluginDef<C = unknown> {
  /** the manifest key (plugins.<id>) */
  id: string;
  name: string;
  /** plugins that must be running first; if one is missing or fails, this one doesn't start */
  requires?: string[];
  /** start after these if they are present (soft ordering) */
  after?: string[];
  /** start even without a manifest section */
  autoStart?: boolean;
  setup(ctx: PluginContext<C>): void | PluginInstance | Promise<void | PluginInstance>;
}

export const definePlugin = <C = unknown>(def: PluginDef<C>): PluginDef<C> => def;
