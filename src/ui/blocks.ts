// The standard body blocks (hud-panels.md §2), rendered with Lit. Plugins describe their UI as data (types.ts Block);
// this turns it into DOM and, because Lit diffs templates, a refresh changes only what changed: a list being scrolled
// or a slider being dragged keeps its scroll position and focus.
import { LitElement, html, nothing, svg, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { live } from 'lit/directives/live.js';
import type {
  Block,
  Blocks,
  ButtonSpec,
  ConfirmSpec,
  Glyph,
  Inline,
  InlineSpan,
  LinkItem,
  ListRow,
  SubjectInfo,
  SubjectRef,
  Tone,
} from '../core/plugin/types';
import { iconSvg } from './icons';

/** what the blocks need from their host */
export interface BlockEnv {
  /** fly to a subject and inspect it */
  open(s: SubjectRef): void;
  describe(s: SubjectRef): SubjectInfo | null;
  confirm(c: ConfirmSpec): Promise<boolean>;
  /** a group's collapse state (remembered per site) */
  groupClosed(id: string, d: boolean): boolean;
  toggleGroup(id: string, d: boolean): void;
  /** a clamped note or value opened with "more" */
  isOpen(key: string): boolean;
  toggleOpen(key: string): void;
}

/** only web and mail links from data (a registry's document URL): never javascript: or data: */
export const safeHref = (u: string | undefined): string | null => {
  if (!u) return null;
  try {
    const p = new URL(u, location.href).protocol;
    return p === 'http:' || p === 'https:' || p === 'mailto:' ? u : null;
  } catch {
    return null;
  }
};

export const icon = (ref: string | undefined) =>
  ref ? html`<span class="ic">${unsafeSVG(iconSvg(ref))}</span>` : nothing;

export const glyph = (g: Glyph | undefined) =>
  g
    ? html`<span
        class="glyph ${g.hollow ? 'hollow' : ''}"
        style="background:${g.colour};color:${g.hollow ? g.colour : '#111'}"
        >${g.letter}</span
      >`
    : nothing;

export const dot = (t: Tone | undefined) => (t ? html`<span class="dot tone-${t}"></span>` : nothing);

function span(x: string | number | InlineSpan): TemplateResult | string {
  if (typeof x !== 'object') return String(x);
  const cls = [x.mono && 'mono', x.muted && 'muted', x.tone && `t tone-${x.tone}`].filter(Boolean).join(' ');
  if (x.pill) return html`<span class="pill tone-${x.pill}" title=${x.title ?? nothing}>${x.text}</span>`;
  if (safeHref(x.href))
    return html`<a class=${cls} href=${safeHref(x.href)!} target="_blank" rel="noopener" title=${x.title ?? nothing}
      >${x.text}</a
    >`;
  return html`<span class=${cls} title=${x.title ?? nothing}>${x.text}</span>`;
}
export const inline = (v: Inline): TemplateResult | string =>
  Array.isArray(v) ? html`${v.map((x, i) => html`${i ? ' ' : ''}${span(x)}`)}` : span(v);

const inlineText = (v: Inline): string =>
  Array.isArray(v)
    ? v.map((x) => (typeof x === 'object' ? x.text : String(x))).join(' ')
    : typeof v === 'object'
      ? v.text
      : String(v);

export function button(b: ButtonSpec, env: BlockEnv): TemplateResult {
  const click = async () => {
    if (b.confirm) {
      const c = typeof b.confirm === 'string' ? { title: b.confirm, confirm: b.label } : b.confirm;
      if (!(await env.confirm(c))) return;
    }
    b.onClick();
  };
  return html`<button
    type="button"
    class="btn ${b.kind || ''}"
    ?disabled=${!!b.disabled}
    title=${b.title ?? nothing}
    @click=${click}
  >
    ${b.label}${b.key ? html` <kbd>${b.key}</kbd>` : nothing}
  </button>`;
}

function link(item: LinkItem, env: BlockEnv): TemplateResult {
  if (typeof item === 'string' || (typeof item === 'object' && 'kind' in item)) {
    const info = env.describe(item);
    return html`<button type="button" class="lnk" @click=${() => env.open(item)} title=${info?.type ?? nothing}>
      ${info?.glyph ? glyph(info.glyph) : icon(info?.icon || 'cube')}<span class="tx"
        >${info?.title || String(item)}</span
      ><span class="go">›</span>
    </button>`;
  }
  const lead = item.glyph ? glyph(item.glyph) : icon(item.icon || (item.href ? 'link' : 'cube'));
  if (safeHref(item.href))
    return html`<a
      class="lnk"
      href=${safeHref(item.href)!}
      target="_blank"
      rel="noopener"
      title=${item.title ?? nothing}
      >${lead}<span class="tx">${item.text}</span></a
    >`;
  const go = () => (item.run ? item.run() : item.subject && env.open(item.subject));
  return html`<button type="button" class="lnk" title=${item.title ?? nothing} @click=${go}>
    ${lead}<span class="tx">${item.text}</span>${item.subject ? html`<span class="go">›</span>` : nothing}
  </button>`;
}

function listRow(r: ListRow, env: BlockEnv): TemplateResult {
  const act = !!(r.subject || r.run);
  const go = () => (r.run ? r.run() : r.subject && env.open(r.subject));
  const body = html`<span class="lead">${r.glyph ? glyph(r.glyph) : r.dot ? dot(r.dot) : icon(r.icon)}</span>
    <span class="m"
      ><div class="p">${r.text}</div>
      ${r.secondary ? html`<div class="s">${r.secondary}</div>` : nothing}
      ${
        r.bar != null
          ? html`<div class="lbar">
              <span style="width:${Math.round(Math.max(0, Math.min(1, r.bar)) * 100)}%"></span>
            </div>`
          : nothing
      }</span
    >
    <span class="v num">${r.value ?? (act ? '›' : '')}</span>`;
  // (in a role=list: a row is a listitem, holding its button)
  return act
    ? html`<div role="listitem">
        <button type="button" class="li act ${r.selected ? 'sel' : ''}" title=${r.title ?? nothing} @click=${go}>
          ${body}
        </button>
      </div>`
    : html`<div role="listitem" class="li ${r.selected ? 'sel' : ''}" title=${r.title ?? nothing}>${body}</div>`;
}

function spark(values: number[]): TemplateResult {
  if (values.length < 2) return html``;
  const lo = Math.min(...values),
    hi = Math.max(...values),
    span = hi - lo || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${30 - ((v - lo) / span) * 28}`).join(' ');
  return html`<svg viewBox="0 0 100 32" preserveAspectRatio="none">
    ${svg`<polyline points=${pts} fill="none" stroke="#ffd166" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`}
  </svg>`;
}

const LONG = 140;

function block(b: Block, env: BlockEnv, key: string): TemplateResult | typeof nothing {
  switch (b.type) {
    case 'kv':
      return html`<div class="kv">
        ${b.rows.map((r, i) => {
          if (!r) return nothing;
          const [k, v, title] = Array.isArray(r) ? [r[0], r[1], undefined] : [r.key, r.value, r.title];
          const long = inlineText(v).length > LONG;
          const id = `${key}.${i}`;
          const open = long && env.isOpen(id);
          return html`<div class="k">${k}</div>
            <div
              class="v ${open ? 'open' : ''}"
              title=${title ?? (long && !open ? 'click for all of it' : nothing)}
              style=${long ? 'cursor:pointer' : ''}
              @click=${long ? () => env.toggleOpen(id) : null}
            >
              ${inline(v)}
            </div>`;
        })}
      </div>`;
    case 'note': {
      const lines = b.lines ?? 3;
      const long = b.text.length > lines * 60 || b.text.split('\n').length > lines;
      const open = env.isOpen(key);
      return html`<div>
        ${b.label ? html`<div class="lbl" style="margin-bottom:5px">${b.label}</div>` : nothing}
        <div class="note ${open ? 'open' : ''}" style="-webkit-line-clamp:${lines}">${b.text}</div>
        ${
          long
            ? html`<button type="button" class="more" @click=${() => env.toggleOpen(key)}>
                ${open ? 'Show less' : 'Show all'}
              </button>`
            : nothing
        }
      </div>`;
    }
    case 'label':
      return html`<div class="lbl">${b.text}</div>`;
    case 'text':
      return html`<div>${inline(b.text)}</div>`;
    case 'list':
      return html`<div class="list" role="list">
        ${b.title ? html`<div class="lbl" style="margin:0 0 4px 6px">${b.title}</div>` : nothing}
        ${
          b.rows.length
            ? repeat(
                b.rows,
                (r, i) => r.id ?? i,
                (r) => listRow(r, env),
              )
            : html`<div class="state">${b.empty || 'Nothing to show'}</div>`
        }
      </div>`;
    case 'group': {
      const closed = env.groupClosed(b.id, !!b.collapsed);
      return html`<div>
        <button
          type="button"
          class="grp ${closed ? 'closed' : ''}"
          aria-expanded=${!closed}
          @click=${() => env.toggleGroup(b.id, !!b.collapsed)}
        >
          <span class="car">${unsafeSVG(iconSvg('chevron'))}</span>${b.title}<span class="n">${b.count ?? ''}</span>
        </button>
        ${closed ? nothing : renderBlocks(b.blocks, env, `${key}.g`)}
      </div>`;
    }
    case 'chips':
      return html`<div class="chips">
        ${repeat(
          b.items,
          (c) => c.id,
          (c) =>
            html`<button
              type="button"
              class="fchip ${c.on ? '' : 'off'}"
              aria-pressed=${c.on}
              title=${c.title ?? `${c.label}: click to show / hide${c.onSolo ? '; Alt-click for only this' : ''}`}
              @click=${(e: MouseEvent) => (e.altKey && c.onSolo ? c.onSolo() : c.onToggle())}
              @contextmenu=${(e: MouseEvent) => {
                if (!c.onSolo) return;
                e.preventDefault();
                c.onSolo();
              }}
            >
              ${c.glyph ? glyph(c.glyph) : dot(c.dot)}${c.label}${c.count != null ? html` <span class="num">${c.count}</span>` : nothing}
            </button>`,
        )}
      </div>`;
    case 'toggle':
      return html`<button
        type="button"
        class="switch"
        role="switch"
        aria-checked=${b.value}
        ?disabled=${!!b.disabled}
        title=${b.title ?? nothing}
        @click=${() => b.onChange(!b.value)}
      >
        <span class="tr"></span>${b.label}${b.key ? html` <kbd>${b.key}</kbd>` : nothing}
      </button>`;
    case 'slider':
      return html`<label class="ctl" title=${b.title ?? nothing}>
        <span class="k">${b.label}</span>
        <input
          type="range"
          min=${b.min}
          max=${b.max}
          step=${b.step ?? 1}
          .value=${live(String(b.value))}
          @input=${(e: Event) => b.onInput(+(e.target as HTMLInputElement).value)}
        />
        <span class="val num">${b.valueText ?? b.value}</span>
      </label>`;
    case 'select':
      return html`<label class="ctl" style="grid-template-columns:minmax(70px,auto) 1fr" title=${b.title ?? nothing}>
        <span class="k">${b.label}</span>
        <select @change=${(e: Event) => b.onChange((e.target as HTMLSelectElement).value)}>
          ${b.options.map((o) => html`<option value=${o.value} ?selected=${o.value === b.value}>${o.label}</option>`)}
        </select>
      </label>`;
    case 'segmented':
      return html`<div class="row">
        ${b.label ? html`<span class="muted" style="font-size:12px">${b.label}</span>` : nothing}
        <span class="seg" role="group">
          ${b.options.map(
            (o) =>
              html`<button
                type="button"
                aria-pressed=${o.value === b.value}
                title=${o.title ?? nothing}
                @click=${() => b.onChange(o.value)}
              >
                ${o.label}
              </button>`,
          )}
        </span>
      </div>`;
    case 'search':
      return html`<div class="search">
        ${icon('search')}
        <input
          type="search"
          data-search=${b.id}
          placeholder=${b.placeholder ?? 'Search…'}
          autocomplete="off"
          spellcheck="false"
          .value=${live(b.value)}
          @input=${(e: Event) => b.onInput((e.target as HTMLInputElement).value)}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') b.onEnter?.();
            if (e.key === 'Escape' && (e.target as HTMLInputElement).value) {
              e.stopPropagation();
              b.onInput('');
            }
          }}
        />
        ${b.key && !b.value ? html`<kbd>${b.key}</kbd>` : nothing}
      </div>`;
    case 'meter':
      return html`<div class="meter">
        <span class="val num">${b.value}${b.unit ? html`<small>${b.unit}</small>` : nothing}</span>
        ${b.spark ? spark(b.spark) : nothing}
      </div>`;
    case 'status':
      return html`<div class="status">
        <span class="pill tone-${b.tone}">${STATUS_GLYPH[b.tone]} ${b.text}</span>${
          b.detail ? html`<span class="muted num">${b.detail}</span>` : nothing
        }
      </div>`;
    case 'links':
      return html`<div>
        ${b.title ? html`<div class="lbl" style="margin-bottom:5px">${b.title}</div>` : nothing}
        <div class="links">${b.items.map((it) => link(it, env))}</div>
      </div>`;
    case 'buttons':
      return html`<div class="btns">${b.items.map((it) => button(it, env))}</div>`;
    case 'callout':
      return html`<div class="callout tone-${b.tone}">
        ${b.text}${b.action ? html` <button type="button" @click=${b.action.run}>${b.action.label}</button>` : nothing}
      </div>`;
    case 'textarea':
      return html`<textarea readonly rows=${b.rows ?? 6} .value=${live(b.value)}></textarea>`;
    case 'empty':
    case 'loading':
    case 'error':
      return html`<div class="state ${b.type}">
        ${b.text}${b.retry ? html` <button type="button" class="more" @click=${b.retry}>Retry</button>` : nothing}
      </div>`;
    case 'custom':
      return html`<jv-custom .key=${b.key} .renderFn=${b.render}></jv-custom>`;
  }
}

/** status glyphs: status is never colour alone */
export const STATUS_GLYPH: Record<Tone, string> = { ok: '✓', warn: '!', bad: '!', info: '↑', off: '○' };

export function renderBlocks(blocks: Blocks, env: BlockEnv, key = 'b'): TemplateResult {
  return html`<div class="blocks">${blocks.map((b, i) => (b ? block(b, env, `${key}.${i}`) : nothing))}</div>`;
}

/** a plugin's own UI inside the HUD: render(el) runs once per key, its cleanup when the key changes or it goes */
export class JvCustom extends LitElement {
  static override properties = { key: {}, renderFn: { attribute: false } };
  declare key: string;
  declare renderFn: (el: HTMLElement) => void | (() => void);
  private shown: string | null = null;
  private cleanup: (() => void) | void = undefined;
  protected override createRenderRoot() {
    return this; // light DOM: the plugin owns the content
  }
  protected override updated(): void {
    if (this.shown === this.key) return;
    this.teardown();
    this.shown = this.key;
    try {
      this.cleanup = this.renderFn(this);
    } catch (err) {
      console.error('a custom block failed to render', err);
      this.textContent = `Couldn't draw this (${(err as Error).message})`;
    }
  }
  private teardown(): void {
    try {
      this.cleanup?.();
    } catch (err) {
      console.error(err);
    }
    this.cleanup = undefined;
    this.replaceChildren();
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    // a keyed list moving this element disconnects and reconnects it at once: only tear down if it really went
    queueMicrotask(() => {
      if (this.isConnected) return;
      this.teardown();
      this.shown = null;
    });
  }
}
if (!customElements.get('jv-custom')) customElements.define('jv-custom', JvCustom);
