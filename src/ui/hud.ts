// The HUD controller: the state behind the rail, the dock, the inspector, the status strip, the legend, toasts, modals
// and search, and the APIs plugins use to fill them (types.ts HudApi, InspectorApi, StatusApi, …). The Lit elements
// in shell.ts draw it; they re-render when told (update()), and Lit's diffing keeps scroll and focus.
import type { Site } from '../site';
import type { Mode } from '../core/types';
import type { KeyRegistry } from '../core/plugin/keys';
import { keyName } from '../core/plugin/keys';
import type {
  ConfirmSpec,
  Disposable,
  HoverProvider,
  InspectorApi,
  LegendSpec,
  ModalHandle,
  ModalSpec,
  PanelHandle,
  PanelSpec,
  ProgressHandle,
  SearchHit,
  SearchProvider,
  SectionProvider,
  StatusItemSpec,
  StorageApi,
  Subject,
  SubjectInfo,
  SubjectRef,
  SubjectResolver,
  ToastHandle,
  ToastSpec,
  ToggleSpec,
  Blocks,
} from '../core/plugin/types';
import { openPanel, sameSubject, sectionsFor, type SectionRec } from './model';
import type { BlockEnv } from './blocks';

export type Region = 'rail' | 'dock' | 'inspector' | 'status' | 'legend' | 'toasts' | 'modal' | 'search' | 'hover';

export interface PanelRec {
  spec: PanelSpec;
  owner: string;
  el: HTMLElement;
  fn: (() => Blocks) | null;
  cleanup: void | (() => void);
  rendered: boolean;
  handle: PanelHandle;
}
export interface ToggleRec {
  spec: ToggleSpec;
  owner: string;
}
export interface ToastRec {
  id: number;
  spec: ToastSpec;
  timer?: ReturnType<typeof setTimeout>;
}
export interface ModalRec {
  id: number;
  spec: ModalSpec;
  resolve?: (ok: boolean) => void;
}
export interface ProgressRec {
  id: number;
  label: string;
  pct: number | null;
}

export interface HudDeps {
  site: Site;
  keys: KeyRegistry;
  /** jarvis.ui.<site id> */
  storage: StorageApi;
  /** fly the camera to a subject */
  flyTo(s: Subject): void;
  /** can it be flown to? */
  canFly(s: Subject): boolean;
  /** the core's own references ('fixture:<id>', 'room:<id>'): a subject, or null */
  resolveRef(ref: string): Subject | null;
  /** an object's default header (from the model) */
  describeObject(s: Extract<Subject, { kind: 'object' }>): SubjectInfo;
  /** the subject changed (the select event) */
  onSelect(s: Subject | null, prev: Subject | null): void;
  locked(): boolean;
  mode(): Mode;
  setMode(m: Mode): void;
}

interface Saved {
  open?: string[];
  pinned?: string[];
  collapsed?: string[];
  width?: number;
  sections?: Record<string, boolean>;
  groups?: Record<string, boolean>;
  toggles?: Record<string, boolean>;
}

const SMALL = '(max-width: 719px)';

export class Hud {
  readonly deps: HudDeps;
  readonly regions = new Map<Region, { requestUpdate(): void }>();
  // dock
  panels: PanelRec[] = [];
  open: string[] = [];
  pinned = new Set<string>();
  collapsed = new Set<string>();
  dockWidth = 320;
  // inspector
  sections: SectionRec[] = [];
  resolvers = new Map<string, SubjectResolver>();
  describers: ((n: import('three').Object3D) => Partial<SubjectInfo> | null)[] = [];
  history: Subject[] = [];
  hi = -1;
  subject: Subject | null = null;
  sectionClosed: Record<string, boolean> = {};
  // strip
  items: { spec: StatusItemSpec; owner: string }[] = [];
  toggles: ToggleRec[] = [];
  progress: ProgressRec[] = [];
  // the rest
  legends: LegendSpec[] = [];
  toasts: ToastRec[] = [];
  /** the last 20 toasts as shown (and as updated), oldest first, whether or not they're still up: a record for tests
   * and the console (twin.hud.toastLog), as a toast that times out may be gone before a slow page is looked at */
  toastLog: { id: number; text: string; tone?: string }[] = [];
  modals: ModalRec[] = [];
  hovers: HoverProvider[] = [];
  searchers: SearchProvider[] = [];
  searchOpen = false;
  query = '';
  hoverLabel: { title: string; line: string; at: { x: number; y: number } | null } | null = null;
  groups: Record<string, boolean> = {};
  expanded = new Set<string>();
  savedToggles: Record<string, boolean> = {};
  small: boolean;
  /** bottom sheet height on small screens */
  sheet: 'peek' | 'half' | 'full' = 'half';
  private seq = 0;
  private queued = new Set<Region>();
  private raf = 0;
  private inspT: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: HudDeps) {
    this.deps = deps;
    const s = deps.storage.get<Saved>('state', {});
    this.open = s.open || [];
    this.pinned = new Set(s.pinned || []);
    this.collapsed = new Set(s.collapsed || []);
    this.dockWidth = Math.min(480, Math.max(280, s.width || 320));
    this.sectionClosed = s.sections || {};
    this.groups = s.groups || {};
    this.savedToggles = s.toggles || {};
    const mq = typeof matchMedia === 'function' ? matchMedia(SMALL) : null;
    this.small = !!mq?.matches;
    mq?.addEventListener?.('change', (e) => {
      this.small = e.matches;
      if (this.small && this.open.length > 1) this.open = this.open.slice(-1);
      this.update();
    });
  }

  // ------------------------------------------------------------------ updates
  /** redraw some regions (all by default) on the next frame */
  update(...rs: Region[]): void {
    for (const r of rs.length ? rs : ([...this.regions.keys()] as Region[])) this.queued.add(r);
    if (this.raf) return;
    const run = () => {
      this.raf = 0;
      const q = [...this.queued];
      this.queued.clear();
      for (const r of q) this.regions.get(r)?.requestUpdate();
    };
    this.raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(run)
        : (setTimeout(run, 16) as unknown as number);
  }
  save(): void {
    const s: Saved = {
      open: this.open,
      pinned: [...this.pinned],
      collapsed: [...this.collapsed],
      width: this.dockWidth,
      sections: this.sectionClosed,
      groups: this.groups,
      toggles: this.savedToggles,
    };
    this.deps.storage.set('state', s);
  }

  // ------------------------------------------------------------------ dock panels
  addPanel(owner: string, spec: PanelSpec): PanelHandle {
    const el = document.createElement('div');
    el.className = 'pbody-custom';
    const isOpen = () => this.open.includes(spec.id);
    const rec: PanelRec = {
      spec,
      owner,
      el,
      fn: null,
      cleanup: undefined,
      rendered: false,
      handle: {
        get isOpen() {
          return isOpen();
        },
        open: () => this.openPanel(spec.id),
        close: () => this.closePanel(spec.id),
        toggle: () => (this.open.includes(spec.id) ? this.closePanel(spec.id) : this.openPanel(spec.id)),
        refresh: () => this.update('dock', 'rail'),
        dispose: () => {
          this.closePanel(spec.id, false);
          this.panels = this.panels.filter((p) => p !== rec);
          this.teardownPanel(rec);
          this.update('rail', 'dock');
        },
      },
    };
    if (this.panels.some((p) => p.spec.id === spec.id)) console.warn(`hud: panel ${spec.id} registered twice`);
    this.panels.push(rec);
    this.panels.sort((a, b) => (a.spec.order ?? 50) - (b.spec.order ?? 50));
    this.update('rail', 'dock');
    return rec.handle;
  }
  /** fill a panel's body the first time it is drawn */
  ensureRendered(rec: PanelRec): void {
    if (rec.rendered) return;
    rec.rendered = true;
    try {
      rec.cleanup = rec.spec.render({
        el: rec.el,
        blocks: (fn) => {
          rec.fn = fn;
        },
      });
    } catch (err) {
      console.error(`panel ${rec.spec.id} failed to render`, err);
      rec.fn = () => [{ type: 'error', text: `This panel failed: ${(err as Error).message}` }];
    }
  }
  private teardownPanel(rec: PanelRec): void {
    try {
      rec.cleanup?.();
    } catch (err) {
      console.error(err);
    }
    rec.rendered = false;
    rec.fn = null;
  }
  openPanel(id: string): void {
    const rec = this.panels.find((p) => p.spec.id === id);
    if (!rec || (rec.spec.when && !rec.spec.when())) return;
    if (this.small) this.closeInspector();
    // only panels that exist and show count towards the two (a saved id whose plugin is gone doesn't)
    const live = this.open.filter((x) => this.openPanels().some((p) => p.spec.id === x));
    this.open = openPanel(live, this.pinned, id, this.small ? 1 : 2);
    this.collapsed.delete(id);
    this.save();
    this.update('rail', 'dock', 'legend', 'status');
  }
  closePanel(id: string, save = true): void {
    if (!this.open.includes(id)) return;
    this.open = this.open.filter((x) => x !== id);
    if (save) this.save();
    this.update('rail', 'dock', 'legend', 'status');
  }
  togglePin(id: string): void {
    if (this.pinned.has(id)) this.pinned.delete(id);
    else this.pinned.add(id);
    this.save();
    this.update('dock');
  }
  toggleCollapsed(id: string): void {
    if (this.collapsed.has(id)) this.collapsed.delete(id);
    else this.collapsed.add(id);
    this.save();
    this.update('dock');
  }
  /** the panels drawn in the dock now: open, and their `when` holds */
  openPanels(): PanelRec[] {
    return this.open
      .map((id) => this.panels.find((p) => p.spec.id === id))
      .filter((p): p is PanelRec => !!p && (!p.spec.when || p.spec.when()));
  }

  // ------------------------------------------------------------------ the inspector
  readonly inspector = (owner: string): InspectorApi => ({
    addSection: (p: SectionProvider) => {
      const rec: SectionRec = { provider: p, owner, seq: this.seq++ };
      this.sections.push(rec);
      this.update('inspector');
      return {
        dispose: () => {
          this.sections = this.sections.filter((x) => x !== rec);
          this.update('inspector');
        },
      };
    },
    registerSubject: (kind, r) => {
      this.resolvers.set(kind, r);
      return {
        dispose: () => {
          if (this.resolvers.get(kind) === r) this.resolvers.delete(kind);
          if (this.subject?.kind === 'item' && this.subject.id.startsWith(`${kind}:`)) this.closeInspector();
        },
      };
    },
    describeObject: (fn) => {
      this.describers.push(fn);
      return { dispose: () => void (this.describers = this.describers.filter((f) => f !== fn)) };
    },
    open: (s, opts) => this.inspect(s, opts),
    close: () => this.closeInspector(),
    current: () => this.subject,
    refresh: (match) => {
      if (!this.subject || (match && !match(this.subject))) return;
      if (this.inspT) return;
      this.inspT = setTimeout(() => {
        this.inspT = null;
        this.update('inspector');
      }, 120);
    },
    describe: (s) => this.describe(s),
    resolve: (s) => this.resolve(s),
    refOf: (s) => this.refOf(s),
  });

  resolve(s: SubjectRef): Subject | null {
    if (typeof s !== 'string') return s;
    const core = this.deps.resolveRef(s);
    if (core) return core;
    const kind = s.split(':')[0];
    const r = this.resolvers.get(kind);
    return r && r.describe(s.slice(kind.length + 1)) ? { kind: 'item', id: s } : null;
  }
  refOf(s: Subject): string | null {
    if (s.kind === 'item') return s.id;
    const fid = s.node.userData.fixture_id as string | undefined;
    return fid ? `fixture:${fid}` : null;
  }
  describe(ref: SubjectRef): SubjectInfo | null {
    const s = this.resolve(ref);
    if (!s) return null;
    if (s.kind === 'item') {
      const kind = s.id.split(':')[0];
      return this.resolvers.get(kind)?.describe(s.id.slice(kind.length + 1)) ?? { title: s.id };
    }
    const info = this.deps.describeObject(s);
    for (const d of this.describers) {
      try {
        const x = d(s.node);
        if (x) return { ...info, ...x };
      } catch (err) {
        console.error(err);
      }
    }
    return info;
  }
  inspect(ref: SubjectRef, opts: { fly?: boolean; history?: boolean } = {}): void {
    const s = this.resolve(ref);
    if (!s) {
      console.warn(`inspector: nothing knows ${typeof ref === 'string' ? ref : ref.kind}`);
      return;
    }
    if (opts.history !== false && !sameSubject(this.history[this.hi] ?? null, s)) {
      this.history = [...this.history.slice(0, this.hi + 1), s].slice(-50);
      this.hi = this.history.length - 1;
    } else if (opts.history !== false) this.history[this.hi] = s; // the same thing, picked again: keep the new hit
    this.setSubject(s);
    if (opts.fly) this.deps.flyTo(s);
  }
  private setSubject(s: Subject | null): void {
    const prev = this.subject;
    this.subject = s;
    for (const k of [...this.expanded]) if (k.startsWith('inspector:')) this.expanded.delete(k);
    if (s && this.small) this.open = [];
    this.update('inspector', 'legend', 'dock', 'rail');
    if (!sameSubject(prev, s) || prev !== s) this.deps.onSelect(s, prev);
  }
  /** a history entry still there? (its owner may have gone, its node left the scene) */
  private alive(s: Subject): boolean {
    if (s.kind === 'object') return !!s.node.parent;
    const kind = s.id.split(':')[0];
    return !!this.resolvers.get(kind)?.describe(s.id.slice(kind.length + 1));
  }
  private step(dir: -1 | 1): void {
    // with the inspector closed, Back reopens the last subject rather than the one before it
    let i = !this.subject && dir === -1 ? this.hi + 1 : this.hi;
    do i += dir;
    while (i >= 0 && i < this.history.length && !this.alive(this.history[i]));
    if (i < 0 || i >= this.history.length) return;
    this.hi = i;
    this.setSubject(this.history[i]);
  }
  back(): void {
    this.step(-1);
  }
  forward(): void {
    this.step(1);
  }
  closeInspector(): void {
    if (!this.subject) return;
    this.setSubject(null);
  }
  shownSections() {
    return this.subject ? sectionsFor(this.sections, this.subject) : [];
  }
  sectionIsClosed(p: SectionProvider): boolean {
    return this.sectionClosed[p.id] ?? !!p.defaultCollapsed;
  }
  toggleSection(p: SectionProvider): void {
    this.sectionClosed[p.id] = !this.sectionIsClosed(p);
    this.save();
    this.update('inspector');
  }

  // ------------------------------------------------------------------ the status strip
  addItem(owner: string, spec: StatusItemSpec): Disposable {
    const rec = { spec, owner };
    this.items.push(rec);
    this.items.sort((a, b) => (a.spec.order ?? 100) - (b.spec.order ?? 100));
    this.update('status');
    return { dispose: () => ((this.items = this.items.filter((x) => x !== rec)), this.update('status')) };
  }
  addToggle(owner: string, spec: ToggleSpec): Disposable {
    const rec: ToggleRec = { spec, owner };
    this.toggles.push(rec);
    this.toggles.sort((a, b) => (a.spec.order ?? 50) - (b.spec.order ?? 50));
    if (spec.persist && spec.id in this.savedToggles && spec.get() !== this.savedToggles[spec.id])
      spec.set(this.savedToggles[spec.id]);
    this.update('status');
    return { dispose: () => ((this.toggles = this.toggles.filter((x) => x !== rec)), this.update('status')) };
  }
  /** a chip was clicked (or its key pressed through the registry) */
  setToggle(t: ToggleSpec, v: boolean): void {
    t.set(v);
    if (t.persist) {
      this.savedToggles[t.id] = v;
      this.save();
    }
    this.update('status', 'legend');
  }
  addProgress(label: string): ProgressHandle {
    const rec: ProgressRec = { id: this.seq++, label, pct: null };
    this.progress.push(rec);
    this.update('status');
    return {
      set: (pct, l) => {
        rec.pct = pct;
        if (l) rec.label = l;
        this.update('status');
      },
      done: () => {
        this.progress = this.progress.filter((x) => x !== rec);
        this.update('status');
      },
    };
  }

  // ------------------------------------------------------------------ legend
  addLegend(l: LegendSpec): Disposable {
    this.legends.push(l);
    this.update('legend');
    return { dispose: () => ((this.legends = this.legends.filter((x) => x !== l)), this.update('legend')) };
  }

  // ------------------------------------------------------------------ toasts
  toast(t: ToastSpec | string): ToastHandle {
    const spec: ToastSpec = typeof t === 'string' ? { text: t } : { ...t };
    const rec: ToastRec = { id: this.seq++, spec };
    const arm = () => {
      clearTimeout(rec.timer);
      if (!rec.spec.sticky && rec.spec.tone !== 'bad') rec.timer = setTimeout(close, rec.spec.timeout ?? 4000);
    };
    const log = () => {
      this.toastLog = [...this.toastLog, { id: rec.id, text: rec.spec.text, tone: rec.spec.tone }].slice(-20);
    };
    const close = () => {
      clearTimeout(rec.timer);
      this.toasts = this.toasts.filter((x) => x !== rec);
      this.update('toasts');
    };
    this.toasts = [...this.toasts, rec].slice(-3);
    log();
    arm();
    this.update('toasts');
    return {
      update: (p) => {
        Object.assign(rec.spec, p);
        log();
        if (!this.toasts.includes(rec)) this.toasts = [...this.toasts, rec].slice(-3);
        arm();
        this.update('toasts');
      },
      close,
    };
  }

  // ------------------------------------------------------------------ modals
  modal(spec: ModalSpec): ModalHandle & { rec: ModalRec } {
    const rec: ModalRec = { id: this.seq++, spec };
    this.modals = [...this.modals, rec];
    if (document.pointerLockElement) document.exitPointerLock();
    this.update('modal');
    return {
      rec,
      close: () => this.closeModal(rec, false),
      refresh: () => this.update('modal'),
    };
  }
  closeModal(rec: ModalRec, ok: boolean): void {
    if (!this.modals.includes(rec)) return;
    this.modals = this.modals.filter((x) => x !== rec);
    rec.resolve?.(ok);
    try {
      rec.spec.onClose?.();
    } catch (err) {
      console.error(err);
    }
    this.update('modal');
  }
  confirm(c: ConfirmSpec): Promise<boolean> {
    return new Promise((resolve) => {
      const h = this.modal({
        title: c.title,
        blocks: () => (c.text ? [{ type: 'text', text: c.text }] : []),
        actions: () => [
          { label: 'Cancel', onClick: () => this.closeModal(h.rec, false) },
          {
            label: c.confirm || 'OK',
            kind: c.danger ? 'danger' : 'primary',
            onClick: () => this.closeModal(h.rec, true),
          },
        ],
      });
      h.rec.resolve = resolve;
    });
  }

  // ------------------------------------------------------------------ search
  addSearch(p: SearchProvider): Disposable {
    this.searchers.push(p);
    this.searchers.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
    return { dispose: () => void (this.searchers = this.searchers.filter((x) => x !== p)) };
  }
  results(): { provider: SearchProvider; hits: SearchHit[] }[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return [];
    return this.searchers
      .map((provider) => {
        try {
          return { provider, hits: provider.search(q).slice(0, 6) };
        } catch (err) {
          console.error(`search ${provider.id} failed`, err);
          return { provider, hits: [] };
        }
      })
      .filter((r) => r.hits.length);
  }
  openSearch(): void {
    if (document.pointerLockElement) document.exitPointerLock();
    this.searchOpen = true;
    this.update('search');
  }
  closeSearch(): void {
    this.searchOpen = false;
    this.query = '';
    this.update('search');
  }
  pickHit(h: SearchHit): void {
    this.closeSearch();
    if (h.run) h.run();
    else if (h.subject) this.inspect(h.subject, { fly: true });
  }

  // ------------------------------------------------------------------ hover label
  addHover(p: HoverProvider): Disposable {
    this.hovers.push(p);
    this.hovers.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
    return { dispose: () => void (this.hovers = this.hovers.filter((x) => x !== p)) };
  }
  /** the label for what's under the crosshair or the mouse (null hides it) */
  setHover(s: Subject | null, at: { x: number; y: number } | null): void {
    if (!s) {
      if (this.hoverLabel) {
        this.hoverLabel = null;
        this.update('hover');
      }
      return;
    }
    const info = this.describe(s);
    const lines: string[] = [];
    for (const p of this.hovers) {
      try {
        const l = p.label(s);
        if (l) lines.push(l);
      } catch (err) {
        console.error(err);
      }
    }
    this.hoverLabel = { title: info?.title || '?', line: lines.join(' · '), at };
    this.update('hover');
  }

  // ------------------------------------------------------------------ help
  private helpOpening = false;
  help(): void {
    if (this.helpOpening || this.modals.some((m) => m.spec.title === 'Keys and controls')) return;
    this.helpOpening = true;
    import('./help').then(({ helpBlocks }) => {
      this.helpOpening = false;
      const h = this.modal({
        title: 'Keys and controls',
        wide: true,
        blocks: () => helpBlocks(this.deps.site, this.deps.keys.list()),
        actions: () => [{ label: 'Close', kind: 'primary', onClick: () => h.close() }],
      });
    });
    try {
      localStorage.setItem('twin.helpSeen', '1');
    } catch {
      /* private mode */
    }
  }

  /** the blocks' environment for one region */
  env(region: Region): BlockEnv {
    return {
      open: (s) => this.inspect(s, { fly: true }),
      describe: (s) => this.describe(s),
      confirm: (c) => this.confirm(c),
      groupClosed: (id, d) => this.groups[id] ?? d,
      toggleGroup: (id, d) => {
        this.groups[id] = !(this.groups[id] ?? d);
        this.save();
        this.update(region);
      },
      isOpen: (k) => this.expanded.has(`${region}:${k}`),
      toggleOpen: (k) => {
        const id = `${region}:${k}`;
        if (this.expanded.has(id)) this.expanded.delete(id);
        else this.expanded.add(id);
        this.update(region);
      },
    };
  }

  keyHint(k: { code: string; shift?: boolean; alt?: boolean } | undefined): string {
    return k ? keyName(k) : '';
  }
}
