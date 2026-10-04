// The HUD's Lit elements: <jv-hud> holds the regions (hud-panels.md §1): the rail, the dock, the inspector, the status
// strip, the legend, toasts, the modal, search and the hover label. Each region draws the controller's state (hud.ts)
// and re-renders only when the controller asks; Lit diffs the DOM, so an open list keeps its scroll and focus.
import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { live } from 'lit/directives/live.js';
import type { ToggleSpec } from '../core/plugin/types';
import { base, blockStyles } from './styles';
import { button, dot, glyph, icon, renderBlocks } from './blocks';
import { iconSvg } from './icons';
import type { Hud, PanelRec, Region } from './hud';
import { setElementEnv } from './elements';

abstract class RegionElement extends LitElement {
  static override properties = { hud: { attribute: false } };
  declare hud: Hud;
  abstract readonly region: Region;
  override connectedCallback(): void {
    super.connectedCallback();
    this.hud?.regions.set(this.region, this);
  }
  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has('hud') && this.hud) this.hud.regions.set(this.region, this);
  }
}

// ------------------------------------------------------------------ rail
export class JvRail extends RegionElement {
  readonly region = 'rail';
  private more = false;
  static override styles = [
    base,
    css`
      .rail {
        position: fixed;
        left: var(--jv-gap);
        top: var(--jv-gap);
        bottom: var(--jv-gap);
        width: var(--jv-rail);
        border-radius: var(--jv-radius);
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 6px 0;
        gap: 4px;
        z-index: 20;
      }
      .sp {
        flex: 1;
      }
      hr {
        width: 22px;
        border: 0;
        border-top: 1px solid var(--jv-border);
        margin: 4px 0;
      }
      .rb {
        position: relative;
        width: 34px;
        height: 34px;
        border-radius: 8px;
        display: grid;
        place-items: center;
        color: var(--jv-text-muted);
        background: none;
        border: 0;
        cursor: pointer;
        padding: 0;
      }
      .rb svg {
        width: 18px;
        height: 18px;
      }
      .rb:hover {
        color: var(--jv-text);
        background: var(--jv-surface-sunken);
      }
      .rb[aria-pressed='true'] {
        background: var(--jv-surface-raised);
        color: var(--jv-text);
        box-shadow: inset 2px 0 0 var(--jv-accent);
      }
      .badge {
        position: absolute;
        right: -4px;
        top: -4px;
        min-width: 16px;
        height: 16px;
        padding: 0 4px;
        border-radius: 8px;
        font-size: 10px;
        font-weight: 700;
        line-height: 16px;
        text-align: center;
        background: var(--jv-badge-fill);
        color: var(--jv-text);
      }
      .badge.tone-bad {
        /* not --jv-bad: white 10px text on that is 3.4:1 */
        background: var(--jv-bad-fill);
        color: #fff;
      }
      .badge.tone-warn {
        background: var(--jv-warn);
        color: #111;
      }
      .menu {
        position: fixed;
        bottom: 70px;
        right: var(--jv-gap);
        border-radius: var(--jv-radius);
        padding: 6px;
        display: flex;
        flex-direction: column;
        min-width: 180px;
        z-index: 30;
      }
      .menu button {
        display: flex;
        gap: 8px;
        align-items: center;
        padding: 8px;
        background: none;
        border: 0;
        text-align: left;
        border-radius: 6px;
        cursor: pointer;
      }
      .menu button:hover {
        background: var(--jv-surface-raised);
      }
      @media (max-width: 719px) {
        .rail {
          top: auto;
          left: var(--jv-gap);
          right: var(--jv-gap);
          bottom: var(--jv-gap);
          width: auto;
          height: 52px;
          flex-direction: row;
          justify-content: space-around;
          padding: 0 6px;
        }
        hr,
        .sp,
        .desk {
          display: none;
        }
        .rb {
          width: 44px;
          height: 44px;
        }
      }
    `,
  ];

  private btn(p: PanelRec): TemplateResult {
    const open = this.hud.open.includes(p.spec.id);
    const badge = p.spec.badge?.();
    const tone = p.spec.badgeTone?.();
    const key = p.spec.key ? ` (${this.hud.keyHint(p.spec.key)})` : '';
    return html`<button
      type="button"
      class="rb"
      data-panel=${p.spec.id}
      aria-pressed=${open}
      aria-label=${p.spec.title}
      title=${`${p.spec.title}${key}`}
      @click=${() => p.handle.toggle()}
    >
      ${unsafeSVG(iconSvg(p.spec.icon))}${
        badge != null && badge !== '' && badge !== 0
          ? html`<span class="badge num ${tone ? `tone-${tone}` : ''}">${badge}</span>`
          : nothing
      }
    </button>`;
  }

  private onKey(e: KeyboardEvent): void {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const bs = [...this.renderRoot.querySelectorAll<HTMLButtonElement>('.rail > button')];
    const i = bs.indexOf(this.renderRoot.querySelector<HTMLButtonElement>('button:focus')!);
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const n =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? bs.length - 1
          : (i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1) + bs.length) % bs.length;
    bs[n].focus();
  }

  override render() {
    const h = this.hud;
    const shown = h.panels.filter((p) => !p.spec.when || p.spec.when());
    const phone = h.small;
    const main = phone ? shown.slice(0, 4) : shown;
    const rest = phone ? shown.slice(4) : [];
    return html`<nav aria-label="HUD">
        <div class="surface rail" role="toolbar" aria-label="Panels" aria-orientation="vertical" @keydown=${this.onKey}>
          <button
            type="button"
            class="rb"
            data-panel="search"
            title="Search ( / )"
            aria-label="Search"
            @click=${() => h.openSearch()}
          >
            ${unsafeSVG(iconSvg('search'))}
          </button>
          <hr />
          ${repeat(
            main,
            (p) => p.spec.id,
            (p) => this.btn(p),
          )}
          <div class="sp"></div>
          ${
            phone
              ? html`<button
                  type="button"
                  class="rb"
                  title="More"
                  aria-label="More"
                  @click=${() => ((this.more = !this.more), this.requestUpdate())}
                >
                  ${unsafeSVG(iconSvg('more'))}
                </button>`
              : nothing
          }
          <button
            type="button"
            class="rb desk"
            data-panel="help"
            title="Keys and help (H)"
            aria-label="Help"
            @click=${() => h.help()}
          >
            ${unsafeSVG(iconSvg('help'))}
          </button>
        </div>
      </nav>
      ${
        this.more && phone
          ? html`<div class="menu surface" role="menu">
              ${rest.map(
                (p) =>
                  html`<button type="button" role="menuitem" @click=${() => ((this.more = false), p.handle.toggle())}>
                    ${icon(p.spec.icon)} ${p.spec.title}
                  </button>`,
              )}
              <button type="button" role="menuitem" @click=${() => ((this.more = false), h.help())}>
                ${icon('help')} Help
              </button>
            </div>`
          : nothing
      }`;
  }
}

// ------------------------------------------------------------------ shared panel / sheet chrome
const sheetCss = css`
  @media (max-width: 719px) {
    .sheet {
      position: fixed !important;
      left: 0 !important;
      right: 0 !important;
      top: auto !important;
      bottom: 64px !important;
      width: auto !important;
      max-height: none !important;
      border-radius: 14px 14px 0 0 !important;
      transition: height var(--jv-motion) ease-out;
    }
    .sheet.peek {
      height: 96px;
    }
    .sheet.half {
      height: 50vh;
    }
    .sheet.full {
      height: calc(100vh - 80px);
    }
    .handle {
      display: block !important;
    }
  }
  .handle {
    display: none;
    height: 18px;
    flex: none;
    cursor: ns-resize;
    touch-action: none;
    position: relative;
  }
  .handle::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 7px;
    width: 40px;
    height: 4px;
    margin-left: -20px;
    border-radius: 2px;
    background: var(--jv-text-faint);
  }
`;

/** drag a bottom sheet's handle between peek, half and full */
function sheetDrag(hud: Hud, region: Region) {
  return (e: PointerEvent) => {
    const y0 = e.clientY;
    const t = e.currentTarget as HTMLElement;
    t.setPointerCapture(e.pointerId);
    const up = (ev: PointerEvent) => {
      t.removeEventListener('pointerup', up);
      const dy = ev.clientY - y0;
      const order = ['peek', 'half', 'full'] as const;
      let i = order.indexOf(hud.sheet);
      if (Math.abs(dy) < 8) i = (i + 1) % 3;
      else i = Math.max(0, Math.min(2, i + (dy < 0 ? 1 : -1) * (Math.abs(dy) > innerHeight * 0.3 ? 2 : 1)));
      hud.sheet = order[i];
      hud.update(region);
    };
    t.addEventListener('pointerup', up);
  };
}

// ------------------------------------------------------------------ dock
export class JvDock extends RegionElement {
  readonly region = 'dock';
  static override styles = [
    base,
    blockStyles,
    sheetCss,
    css`
      .dock {
        position: fixed;
        left: calc(var(--jv-gap) * 2 + var(--jv-rail));
        top: calc(var(--jv-gap) * 2 + var(--jv-strip));
        max-height: calc(100vh - var(--jv-strip) - var(--jv-gap) * 3);
        display: flex;
        flex-direction: column;
        gap: 8px;
        z-index: 15;
      }
      .panel {
        border-radius: var(--jv-radius);
        overflow: hidden;
        display: flex;
        flex-direction: column;
        min-height: 0;
        flex: 0 1 auto;
      }
      .ph {
        display: flex;
        align-items: center;
        gap: 8px;
        height: 38px;
        padding: 0 6px 0 12px;
        background: var(--jv-surface-raised);
        flex: none;
      }
      .ph .ic {
        color: var(--jv-accent);
      }
      .ph h2 {
        font-size: 15px;
        font-weight: 600;
        margin: 0;
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ph .meta {
        font-size: 11px;
        color: var(--jv-text-muted);
        white-space: nowrap;
      }
      .ph .iconbtn[aria-pressed='true'] {
        color: var(--jv-accent);
      }
      .pb {
        padding: 10px 12px 12px;
        overflow: auto;
        min-height: 0;
      }
      .pf {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
        padding: 8px 12px;
        border-top: 1px solid var(--jv-border);
        flex: none;
      }
      .collapsed .pb,
      .collapsed .pf {
        display: none;
      }
      .collapsed .car {
        transform: rotate(-90deg);
      }
      .grip {
        position: absolute;
        right: -6px;
        top: 0;
        bottom: 0;
        width: 8px;
        cursor: ew-resize;
      }
      @media (max-width: 719px) {
        .dock {
          gap: 0;
        }
        .grip {
          display: none;
        }
      }
    `,
  ];

  /** two panels share the height: one that fits in its share keeps its natural height, the other gets the rest */
  protected override updated(): void {
    const dock = this.renderRoot.querySelector<HTMLElement>('.dock');
    if (!dock || this.hud.small) return;
    const ps = [...dock.querySelectorAll<HTMLElement>('.panel')];
    for (const p of ps) p.style.maxHeight = '';
    if (ps.length < 2) return;
    const H = dock.clientHeight > 0 ? parseFloat(getComputedStyle(dock).maxHeight) || innerHeight : innerHeight;
    const natural = ps.map((p) => {
      const body = p.querySelector<HTMLElement>('.pb');
      const rest = p.offsetHeight - (body?.clientHeight ?? 0);
      return rest + (body?.scrollHeight ?? 0);
    });
    const gap = 8 * (ps.length - 1);
    if (natural.reduce((a, b) => a + b, 0) + gap <= H) return;
    const share = (H - gap) / ps.length;
    const small = natural.map((n) => n <= share);
    const left = H - gap - natural.reduce((a, n, i) => a + (small[i] ? n : 0), 0);
    const bigs = small.filter((x) => !x).length;
    ps.forEach((p, i) => (p.style.maxHeight = `${small[i] ? natural[i] : Math.floor(left / bigs)}px`));
  }

  private resize(e: PointerEvent): void {
    const x0 = e.clientX,
      w0 = this.hud.dockWidth;
    const t = e.currentTarget as HTMLElement;
    t.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      this.hud.dockWidth = Math.min(480, Math.max(280, w0 + ev.clientX - x0));
      this.requestUpdate();
    };
    const up = () => {
      t.removeEventListener('pointermove', move);
      t.removeEventListener('pointerup', up);
      this.hud.save();
    };
    t.addEventListener('pointermove', move);
    t.addEventListener('pointerup', up);
  }

  private panel(p: PanelRec): TemplateResult {
    const h = this.hud;
    h.ensureRendered(p);
    const id = p.spec.id;
    const closed = h.collapsed.has(id) && !h.small;
    let body: TemplateResult;
    try {
      body = p.fn ? renderBlocks(p.fn(), h.env('dock'), id) : html`${p.el}`;
    } catch (err) {
      console.error(`panel ${id} failed`, err);
      body = html`<div class="state error">This panel failed: ${(err as Error).message}</div>`;
    }
    const actions = p.spec.actions?.() || [];
    const meta = p.spec.meta?.();
    return html`<section
      class="panel surface ${closed ? 'collapsed' : ''} ${h.small ? `sheet ${h.sheet}` : ''}"
      role="region"
      aria-label=${p.spec.title}
      data-panel=${id}
    >
      <div class="handle" @pointerdown=${sheetDrag(h, 'dock')}></div>
      <div class="ph">
        ${icon(p.spec.icon)}
        <h2>${p.spec.title}</h2>
        ${meta ? html`<span class="meta num">${meta}</span>` : nothing}
        <button
          type="button"
          class="iconbtn"
          title=${h.pinned.has(id) ? 'Unpin (another panel may close it)' : 'Pin open'}
          aria-pressed=${h.pinned.has(id)}
          @click=${() => h.togglePin(id)}
        >
          ${unsafeSVG(iconSvg('pinned'))}
        </button>
        <button
          type="button"
          class="iconbtn car"
          title=${closed ? 'Expand' : 'Collapse'}
          aria-expanded=${!closed}
          @click=${() => h.toggleCollapsed(id)}
        >
          ${unsafeSVG(iconSvg('chevron'))}
        </button>
        <button
          type="button"
          class="iconbtn"
          title="Close"
          aria-label="Close ${p.spec.title}"
          @click=${() => p.handle.close()}
        >
          ${unsafeSVG(iconSvg('close'))}
        </button>
      </div>
      <div class="pb">${body}</div>
      ${actions.length ? html`<div class="pf">${actions.map((a) => button(a, h.env('dock')))}</div>` : nothing}
    </section>`;
  }

  override render() {
    const open = this.hud.openPanels();
    if (!open.length) return nothing;
    return html`<div class="dock" style="width:${this.hud.dockWidth}px">
      ${repeat(
        open,
        (p) => p.spec.id,
        (p) => this.panel(p),
      )}
      <div class="grip" title="Drag to resize" @pointerdown=${(e: PointerEvent) => this.resize(e)}></div>
    </div>`;
  }
}

// ------------------------------------------------------------------ inspector
export class JvInspector extends RegionElement {
  readonly region = 'inspector';
  static override styles = [
    base,
    blockStyles,
    sheetCss,
    css`
      .insp {
        position: fixed;
        right: var(--jv-gap);
        top: var(--jv-gap);
        width: var(--jv-inspector);
        max-height: calc(100vh - var(--jv-gap) * 2);
        border-radius: var(--jv-radius);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        z-index: 16;
      }
      .ih {
        padding: 8px 8px 10px 12px;
        background: var(--jv-surface-raised);
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 2px 10px;
        align-items: center;
        flex: none;
      }
      .nav {
        grid-column: 1 / -1;
        display: flex;
        gap: 2px;
        color: var(--jv-text-faint);
        font-size: 12px;
        align-items: center;
        margin-bottom: 2px;
      }
      .crumbs {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin-left: 4px;
      }
      .big {
        width: 34px;
        height: 34px;
        border-radius: 9px;
        display: grid;
        place-items: center;
        font-weight: 800;
        color: #111;
        grid-row: span 2;
        background: var(--jv-surface-sunken);
        color: var(--jv-text);
      }
      .big svg {
        width: 18px;
        height: 18px;
      }
      .big.g {
        font-size: 15px;
        color: #111;
      }
      h2 {
        margin: 0;
        font-size: 17px;
        font-weight: 600;
        line-height: 1.2;
        overflow-wrap: anywhere;
      }
      .type {
        color: var(--jv-text-muted);
        font-size: 12px;
        grid-column: 2;
      }
      .ibody {
        overflow: auto;
        min-height: 0;
      }
      .sec {
        border-top: 1px solid var(--jv-border);
      }
      .sh {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 9px 12px;
        width: 100%;
        background: none;
        border: 0;
        cursor: pointer;
        text-align: left;
      }
      .sh:hover {
        background: var(--jv-surface-sunken);
      }
      .sh .ic {
        width: 14px;
        height: 14px;
        color: var(--jv-accent);
      }
      .sh .t {
        flex: 1;
        font-weight: 600;
      }
      .sh .src {
        font-size: 11px;
        color: var(--jv-text-faint);
      }
      .sh .car {
        width: 12px;
        height: 12px;
        color: var(--jv-text-faint);
        transition: transform var(--jv-motion) ease-out;
      }
      .sec.closed .car {
        transform: rotate(-90deg);
      }
      .sb {
        padding: 0 12px 12px;
      }
      .if {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
        padding: 8px 12px;
        border-top: 1px solid var(--jv-border);
        flex: none;
        flex-wrap: wrap;
      }
    `,
  ];

  override render() {
    const h = this.hud;
    const s = h.subject;
    if (!s) return nothing;
    const info = h.describe(s) || { title: '?' };
    const env = h.env('inspector');
    const shown = h.shownSections();
    const actions = shown.flatMap((x) => ('blocks' in x.content && x.content.actions) || []);
    return html`<aside class="insp surface ${h.small ? `sheet ${h.sheet}` : ''}" role="region" aria-label="Inspector">
      <div class="handle" @pointerdown=${sheetDrag(h, 'inspector')}></div>
      <div class="ih">
        <div class="nav">
          <button type="button" class="iconbtn" title="Back (Alt-←)" ?disabled=${h.hi <= 0} @click=${() => h.back()}>
            ${unsafeSVG(iconSvg('back'))}
          </button>
          <button
            type="button"
            class="iconbtn"
            title="Forward (Alt-→)"
            ?disabled=${h.hi >= h.history.length - 1}
            @click=${() => h.forward()}
          >
            ${unsafeSVG(iconSvg('forward'))}
          </button>
          <span class="crumbs">${(info.crumbs || []).join(' · ')}</span>
          <button
            type="button"
            class="iconbtn"
            id="inspector-close"
            title="Close (Esc)"
            aria-label="Close the inspector"
            @click=${() => h.closeInspector()}
          >
            ${unsafeSVG(iconSvg('close'))}
          </button>
        </div>
        ${
          info.glyph
            ? html`<div class="big g" style="background:${info.glyph.colour}">${info.glyph.letter}</div>`
            : html`<div class="big">${unsafeSVG(iconSvg(info.icon || 'cube'))}</div>`
        }
        <h2>${info.title}</h2>
        <div class="type">${info.type || ''}</div>
      </div>
      <div class="ibody">
        ${repeat(
          shown,
          (x) => x.rec.provider.id,
          (x) => {
            const p = x.rec.provider;
            const closed = h.sectionIsClosed(p);
            const c = x.content;
            return html`<section class="sec ${closed ? 'closed' : ''}" data-section=${p.id}>
              <button type="button" class="sh" aria-expanded=${!closed} @click=${() => h.toggleSection(p)}>
                ${icon(p.icon)}<span class="t">${p.title}</span><span class="src">${x.rec.owner}</span
                ><span class="ic car">${unsafeSVG(iconSvg('chevron'))}</span>
              </button>
              ${
                closed
                  ? nothing
                  : html`<div class="sb">
                      ${
                        'error' in c
                          ? html`<div class="state error">This section failed: ${c.error}</div>`
                          : 'blocks' in c
                            ? renderBlocks(c.blocks, env, p.id)
                            : html`<jv-custom .key=${c.key} .renderFn=${c.render}></jv-custom>`
                      }
                    </div>`
              }
            </section>`;
          },
        )}
      </div>
      ${
        actions.length || h.deps.canFly(s)
          ? html`<div class="if">
              ${
                h.deps.canFly(s)
                  ? html`<button type="button" class="btn" @click=${() => h.deps.flyTo(s)}>Fly to</button>`
                  : nothing
              }
              ${actions.map((a) => button(a, env))}
            </div>`
          : nothing
      }
    </aside>`;
  }
}

// ------------------------------------------------------------------ status strip
export class JvStatus extends RegionElement {
  readonly region = 'status';
  private cut = new Set<string>();
  private sig = '';
  private menu: string | null = null; // a chip's id, or 'more'
  static override styles = [
    base,
    css`
      .strip {
        position: fixed;
        top: var(--jv-gap);
        left: calc(var(--jv-gap) * 2 + var(--jv-rail));
        right: var(--right, calc(var(--jv-gap) * 2 + var(--jv-inspector)));
        height: var(--jv-strip);
        display: flex;
        justify-content: center;
        pointer-events: none;
        z-index: 18;
      }
      .bar {
        pointer-events: auto;
        border-radius: 999px;
        height: var(--jv-strip);
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 0 6px 0 12px;
        white-space: nowrap;
        max-width: 100%;
        min-width: 0;
        position: relative;
      }
      .place {
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 0 1 auto;
        min-width: 40px;
      }
      .place b {
        font-weight: 600;
      }
      .place span {
        color: var(--jv-text-muted);
      }
      .sep {
        width: 1px;
        height: 18px;
        background: var(--jv-border);
        margin: 0 4px;
        flex: none;
      }
      .seg {
        display: inline-flex;
        background: var(--jv-surface-sunken);
        border-radius: 999px;
        padding: 2px;
        flex: none;
      }
      .seg button {
        padding: 2px 10px;
        border-radius: 999px;
        color: var(--jv-text-muted);
        font-size: 12px;
        background: none;
        border: 0;
        cursor: pointer;
      }
      .seg button[aria-pressed='true'] {
        background: var(--jv-surface-raised);
        color: var(--jv-text);
      }
      .chips {
        display: flex;
        gap: 4px;
        overflow: hidden;
        min-width: 0;
        flex: none;
        align-items: center;
        height: 100%;
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 24px;
        padding: 0 8px;
        border-radius: 999px;
        font-size: 12px;
        color: var(--jv-text-muted);
        border: 1px solid var(--jv-border);
        background: none;
        cursor: pointer;
        flex: none;
      }
      .chip:hover {
        color: var(--jv-text);
      }
      .chip[aria-pressed='true'] {
        color: #0e1116;
        background: var(--jv-accent);
        border-color: transparent;
        font-weight: 600;
      }
      .chipwrap {
        display: inline-flex;
        flex: none;
      }
      .chipwrap .chip.main:not(:only-child) {
        border-radius: 999px 0 0 999px;
        padding-right: 6px;
      }
      .chipwrap .chip.var {
        border-radius: 0 999px 999px 0;
        padding: 0 5px;
        min-width: 24px;
        border-left: 0;
      }
      .chip.var svg {
        width: 10px;
        height: 10px;
      }
      .item {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--jv-text-muted);
        padding: 0 6px;
        background: none;
        border: 0;
        height: 26px;
        border-radius: 999px;
        flex: none;
      }
      button.item {
        cursor: pointer;
      }
      button.item:hover {
        color: var(--jv-text);
        background: var(--jv-surface-sunken);
      }
      .item b {
        color: var(--jv-text);
        font-weight: 600;
      }
      .item .ic {
        width: 13px;
        height: 13px;
      }
      .menu {
        position: absolute;
        top: calc(var(--jv-strip) + 6px);
        right: 0;
        border-radius: var(--jv-radius);
        padding: 6px;
        display: flex;
        flex-direction: column;
        min-width: 220px;
        z-index: 40;
      }
      .menu button {
        display: flex;
        gap: 8px;
        align-items: center;
        padding: 6px 8px;
        background: none;
        border: 0;
        text-align: left;
        border-radius: 6px;
        cursor: pointer;
        font-size: 12.5px;
      }
      .menu button:hover {
        background: var(--jv-surface-raised);
      }
      .menu .chk {
        width: 14px;
        color: var(--jv-accent);
      }
      .menu kbd {
        margin-left: auto;
      }
      .prog {
        position: absolute;
        left: 16px;
        right: 16px;
        bottom: 2px;
        height: 2px;
        border-radius: 1px;
        overflow: hidden;
        background: var(--jv-surface-sunken);
      }
      .prog span {
        display: block;
        height: 100%;
        background: var(--jv-accent);
        transition: width 200ms;
      }
      .prog.ind span {
        width: 30%;
        animation: ind 1.2s linear infinite;
      }
      @keyframes ind {
        from {
          transform: translateX(-100%);
        }
        to {
          transform: translateX(340%);
        }
      }
      @media (max-width: 719px) {
        .strip {
          left: var(--jv-gap);
          right: var(--jv-gap);
        }
        .seg,
        .chips,
        .sep,
        .item.opt {
          display: none;
        }
      }
    `,
  ];

  private chip(t: ToggleSpec, hidden: boolean): TemplateResult {
    const h = this.hud;
    const on = t.get();
    const key = t.key ? h.keyHint(t.key) : '';
    const label = (on && t.text?.()) || t.label;
    const main = html`<button
      type="button"
      class="chip main"
      data-chip=${t.id}
      aria-pressed=${on}
      title=${`${t.title || t.label}${key ? ` (${key})` : ''}`}
      @click=${() => h.setToggle(t, !on)}
    >
      ${label}${key ? html`<kbd>${key}</kbd>` : nothing}
    </button>`;
    if (!t.variants?.length)
      return html`<span class="chipwrap" data-id=${t.id} data-on=${on} ?hidden=${hidden}>${main}</span>`;
    return html`<span class="chipwrap" data-id=${t.id} data-on=${on} ?hidden=${hidden}
      >${main}<button
        type="button"
        class="chip var"
        aria-pressed=${on}
        aria-haspopup="menu"
        title="More ${t.label} options"
        @click=${() => ((this.menu = this.menu === t.id ? null : t.id), this.requestUpdate())}
      >
        ${unsafeSVG(iconSvg('chevron'))}
      </button></span
    >`;
  }

  private menuFor(t: ToggleSpec): TemplateResult {
    const h = this.hud;
    const row = (label: string, on: boolean, key: string, set: () => void) =>
      html`<button
        type="button"
        role="menuitemcheckbox"
        aria-checked=${on}
        @click=${() => ((this.menu = null), set(), h.update('status', 'legend'))}
      >
        <span class="chk">${on ? '✓' : ''}</span>${label}${key ? html`<kbd>${key}</kbd>` : nothing}
      </button>`;
    return html`<div class="menu surface" role="menu">
      ${row(t.label, t.get(), t.key ? h.keyHint(t.key) : '', () => h.setToggle(t, !t.get()))}
      ${(t.variants || []).map((v) => row(v.label, v.get(), v.key ? h.keyHint(v.key) : '', () => v.set(!v.get())))}
    </div>`;
  }

  protected override updated(): void {
    // the strip never wraps: chips that don't fit go into the ⋯ menu, those that are off first, from the end
    // (re-measured when the chips or the window change)
    const box = this.renderRoot.querySelector<HTMLElement>('.chips');
    if (!box) return;
    const ws = [...box.children] as HTMLElement[];
    const items = [...this.renderRoot.querySelectorAll<HTMLElement>('.item')].map((i) => i.textContent).join('|');
    const sig = `${innerWidth}|${this.hud.subject ? 1 : 0}|${items}|${ws.map((w) => `${w.dataset.id}:${w.dataset.on}:${w.textContent}`).join('|')}`;
    if (sig === this.sig) return;
    if (this.cut.size) {
      this.cut = new Set();
      this.requestUpdate();
      return; // measure with everything shown
    }
    this.sig = sig;
    const bar = this.renderRoot.querySelector<HTMLElement>('.bar')!;
    const strip = this.renderRoot.querySelector<HTMLElement>('.strip')!;
    let over = bar.scrollWidth - strip.clientWidth;
    if (over <= 0) return;
    const order = [
      ...ws.filter((w) => w.dataset.on !== 'true').reverse(),
      ...ws.filter((w) => w.dataset.on === 'true').reverse(),
    ];
    const hide = new Set<string>();
    for (const w of order) {
      if (over <= 0) break;
      hide.add(w.dataset.id!);
      over -= w.getBoundingClientRect().width + 4;
    }
    this.cut = hide;
    this.requestUpdate();
  }

  private onResize = () => {
    this.sig = '';
    this.requestUpdate();
  };
  // a click anywhere else closes an open menu
  private onPointer = (e: PointerEvent) => {
    if (this.menu && !e.composedPath().includes(this)) this.closeMenu();
  };
  private ro: ResizeObserver | null = null;
  override connectedCallback(): void {
    super.connectedCallback();
    addEventListener('resize', this.onResize);
    addEventListener('pointerdown', this.onPointer);
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    removeEventListener('resize', this.onResize);
    removeEventListener('pointerdown', this.onPointer);
    this.ro?.disconnect();
    this.ro = null;
  }
  protected override firstUpdated(): void {
    // the status items change width too (a connector's text, the time): measure again when the bar does
    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(() => this.onResize());
      const bar = this.renderRoot.querySelector('.strip');
      if (bar) this.ro.observe(bar);
    }
  }

  override render() {
    const h = this.hud;
    const mode = h.deps.mode();
    const all = h.toggles.filter((t) => !t.spec.when || t.spec.when()).map((t) => t.spec);
    // a rarely used chip lives in ⋯ (its key still works)
    const chips = all.filter((t) => !t.overflow);
    const tucked = all.filter((t) => t.overflow);
    const before = h.items.filter((i) => (i.spec.order ?? 100) < 50);
    const after = h.items.filter((i) => (i.spec.order ?? 100) >= 50);
    const over = [...chips.filter((t) => this.cut.has(t.id)), ...tucked];
    const item = (i: (typeof h.items)[number]) => {
      const v = i.spec.render();
      if (!v) return nothing;
      const inner = html`${v.dot ? dot(v.dot) : nothing}${icon(v.icon)}${v.strong ? html`<b>${v.strong}</b>` : nothing}<span
          >${v.text}</span
        >`;
      return i.spec.onClick
        ? html`<button
            type="button"
            class="item ${i.spec.id === 'core.place' ? '' : 'opt'}"
            data-item=${i.spec.id}
            title=${v.title ?? nothing}
            @click=${() => i.spec.onClick!()}
          >
            ${inner}
          </button>`
        : html`<span
            class="item ${i.spec.id === 'core.place' ? 'place' : 'opt'}"
            data-item=${i.spec.id}
            title=${v.title ?? nothing}
            >${inner}</span
          >`;
    };
    const prog = h.progress[0];
    const right = h.subject && !h.small ? 'calc(var(--jv-gap) * 2 + var(--jv-inspector))' : 'var(--jv-gap)';
    return html`<div class="strip" style="--right:${right}">
      <div class="bar surface" role="region" aria-label="Status">
        ${before.map(item)}
        <span class="sep"></span>
        <span class="seg" role="group" aria-label="Mode (Tab)">
          <button
            type="button"
            aria-pressed=${mode === 'walk'}
            data-mode="walk"
            title="Walk (Tab)"
            @click=${() => h.deps.setMode('walk')}
          >
            Walk
          </button>
          <button
            type="button"
            aria-pressed=${mode === 'orbit'}
            data-mode="orbit"
            title="Overview (Tab)"
            @click=${() => h.deps.setMode('orbit')}
          >
            Overview
          </button>
        </span>
        <span class="sep"></span>
        <span class="chips"
          >${repeat(
            chips,
            (t) => t.id,
            (t) => this.chip(t, this.cut.has(t.id)),
          )}</span
        >
        <button
          type="button"
          class="chip"
          data-chip="more"
          title="More"
          aria-haspopup="menu"
          @click=${() => ((this.menu = this.menu === 'more' ? null : 'more'), this.requestUpdate())}
        >
          ⋯
        </button>
        ${after.length ? html`<span class="sep"></span>` : nothing} ${after.map(item)}
        ${
          prog
            ? html`<div class="prog ${prog.pct == null ? 'ind' : ''}" title=${prog.label}>
                <span style=${prog.pct == null ? '' : `width:${prog.pct}%`}></span>
              </div>`
            : nothing
        }
        ${
          this.menu === 'more'
            ? html`<div class="menu surface" role="menu">
                ${over.map(
                  (t) =>
                    html`<button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked=${t.get()}
                      @click=${() => h.setToggle(t, !t.get())}
                    >
                      <span class="chk">${t.get() ? '✓' : ''}</span
                      >${t.label}${t.key ? html`<kbd>${h.keyHint(t.key)}</kbd>` : nothing}
                    </button>`,
                )}
                ${
                  h.small
                    ? html`${chips.map(
                        (t) =>
                          html`<button
                            type="button"
                            role="menuitemcheckbox"
                            aria-checked=${t.get()}
                            @click=${() => h.setToggle(t, !t.get())}
                          >
                            <span class="chk">${t.get() ? '✓' : ''}</span>${t.label}
                          </button>`,
                      )}`
                    : nothing
                }
                ${h.progress.map((p) => html`<button type="button" disabled><span class="chk">…</span>${p.label}${p.pct != null ? ` ${p.pct}%` : ''}</button>`)}
                <button type="button" @click=${() => ((this.menu = null), h.help())}>
                  <span class="chk"></span>Keys and help<kbd>H</kbd>
                </button>
              </div>`
            : this.menu
              ? (() => {
                  const t = chips.find((c) => c.id === this.menu);
                  return t ? this.menuFor(t) : nothing;
                })()
              : nothing
        }
      </div>
    </div>`;
  }

  closeMenu(): boolean {
    if (!this.menu) return false;
    this.menu = null;
    this.requestUpdate();
    return true;
  }
}

// ------------------------------------------------------------------ legend
export class JvLegend extends RegionElement {
  readonly region = 'legend';
  static override styles = [
    base,
    css`
      .legends {
        position: fixed;
        bottom: var(--jv-gap);
        display: flex;
        flex-direction: column;
        gap: 6px;
        align-items: flex-end;
        z-index: 12;
      }
      .legend {
        border-radius: var(--jv-radius);
        padding: 8px 10px;
        font-size: 11.5px;
        min-width: 200px;
      }
      .lt {
        font-weight: 600;
        font-size: 12px;
        margin-bottom: 6px;
        display: flex;
        justify-content: space-between;
        gap: 12px;
      }
      .lt span {
        color: var(--jv-text-faint);
        font-weight: 400;
      }
      .row {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .row > span {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .ring {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        box-shadow: inset 0 0 0 1.5px var(--jv-text-muted);
        display: inline-block;
      }
      @media (max-width: 719px) {
        .legends {
          display: none;
        }
      }
    `,
  ];
  override render() {
    const h = this.hud;
    const on = h.legends.filter((l) => {
      try {
        return l.when();
      } catch {
        return false;
      }
    });
    if (!on.length) return nothing;
    const right = h.subject ? 'calc(var(--jv-gap) * 2 + var(--jv-inspector))' : 'var(--jv-gap)';
    return html`<div class="legends" style="right:${right}" role="region" aria-label="Legend">
      ${on.map(
        (l) =>
          html`<div class="legend surface" data-legend=${l.id}>
            <div class="lt">${l.title}${l.hint ? html`<span>${l.hint}</span>` : nothing}</div>
            <div class="row">
              ${l
                .items()
                .map(
                  (it) =>
                    html`<span
                      >${
                        it.glyph
                          ? glyph(it.glyph)
                          : it.hollow
                            ? html`<i class="ring"></i>`
                            : it.colour
                              ? html`<span class="dot" style="background:${it.colour}"></span>`
                              : dot(it.tone)
                      }${it.label}</span
                    >`,
                )}
            </div>
          </div>`,
      )}
    </div>`;
  }
}

// ------------------------------------------------------------------ toasts
export class JvToasts extends RegionElement {
  readonly region = 'toasts';
  static override styles = [
    base,
    css`
      .toasts {
        position: fixed;
        left: 50%;
        bottom: 18px;
        transform: translateX(-50%);
        display: flex;
        flex-direction: column;
        gap: 6px;
        align-items: center;
        z-index: 50;
        pointer-events: none;
      }
      .toast {
        pointer-events: auto;
        border-radius: 8px;
        padding: 8px 8px 8px 12px;
        display: flex;
        gap: 10px;
        align-items: center;
        font-size: 12.5px;
        max-width: min(560px, 90vw);
      }
      .toast button.a {
        color: var(--jv-accent);
        font-weight: 600;
        background: none;
        border: 0;
        cursor: pointer;
      }
      @media (max-width: 719px) {
        .toasts {
          bottom: 72px;
        }
      }
    `,
  ];
  override render() {
    const h = this.hud;
    const list = (assertive: boolean) =>
      repeat(
        h.toasts.filter((t) => (t.spec.tone === 'bad') === assertive),
        (t) => t.id,
        (t) =>
          html`<div class="toast surface" data-tone=${t.spec.tone || 'info'}>
            ${t.spec.tone ? dot(t.spec.tone) : nothing}<span>${t.spec.text}</span>
            ${(t.spec.actions || []).map((a) => html`<button type="button" class="a" @click=${a.run}>${a.label}</button>`)}
            <button
              type="button"
              class="iconbtn"
              aria-label="Dismiss"
              @click=${() => ((h.toasts = h.toasts.filter((x) => x !== t)), clearTimeout(t.timer), h.update('toasts'))}
            >
              ${unsafeSVG(iconSvg('close'))}
            </button>
          </div>`,
      );
    return html`<div class="toasts">
      <div role="status" aria-live="polite">${list(false)}</div>
      <div role="alert" aria-live="assertive">${list(true)}</div>
    </div>`;
  }
}

// ------------------------------------------------------------------ modal
export class JvModal extends RegionElement {
  readonly region = 'modal';
  private lastTop = -1;
  static override styles = [
    base,
    blockStyles,
    css`
      .scrim {
        position: fixed;
        inset: 0;
        background: rgba(5, 7, 10, 0.45);
        display: grid;
        place-items: center;
        z-index: 60;
      }
      .modal {
        border-radius: 12px;
        width: min(460px, 92vw);
        max-height: 90vh;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .modal.wide {
        width: min(680px, 94vw);
      }
      .mh {
        display: flex;
        align-items: center;
        padding: 12px 10px 10px 16px;
        background: var(--jv-surface-raised);
      }
      .mh h2 {
        font-size: 22px;
        font-weight: 600;
        margin: 0;
        flex: 1;
      }
      .mb {
        padding: 14px 16px;
        overflow: auto;
        min-height: 0;
      }
      .mf {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 10px 16px;
        border-top: 1px solid var(--jv-border);
      }
    `,
  ];

  private onKey(e: KeyboardEvent): void {
    const top = this.hud.modals.at(-1);
    if (!top) return;
    e.stopPropagation(); // keys in a modal never walk
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) e.preventDefault();
    if (e.key === 'Escape') {
      e.preventDefault();
      this.hud.closeModal(top, false);
    } else if (e.key === 'Tab') {
      // focus stays in the modal
      const ms = this.renderRoot.querySelectorAll<HTMLElement>('.modal');
      const f = [
        ...(ms[ms.length - 1]?.querySelectorAll<HTMLElement>(
          '.mb, button, input, select, textarea, a[href], jv-custom [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ].filter((x) => !(x as HTMLButtonElement).disabled);
      if (!f.length) return;
      const active = this.renderRoot instanceof ShadowRoot ? this.renderRoot.activeElement : null;
      const i = f.indexOf(active as HTMLElement);
      if (e.shiftKey && i <= 0) {
        e.preventDefault();
        f[f.length - 1].focus();
      } else if (!e.shiftKey && i === f.length - 1) {
        e.preventDefault();
        f[0].focus();
      }
    }
  }

  /** what had focus before the first modal opened: it gets it back when the last one closes */
  private returnTo: HTMLElement | null = null;
  protected override updated(): void {
    const top = this.hud.modals.at(-1);
    if (top && this.lastTop === -1) {
      let a = document.activeElement as HTMLElement | null;
      while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement as HTMLElement;
      this.returnTo = a && a !== document.body ? a : null;
    }
    if (!top && this.lastTop !== -1 && this.returnTo?.isConnected) this.returnTo.focus();
    if (!top) this.returnTo = null;
    if (top && top.id !== this.lastTop) {
      this.lastTop = top.id;
      const m = this.renderRoot.querySelectorAll<HTMLElement>('.modal');
      const last = m[m.length - 1];
      (
        last?.querySelector<HTMLElement>('.mf .btn.primary, .mf .btn.danger') ||
        last?.querySelector<HTMLElement>('button')
      )?.focus();
    }
    if (!top) this.lastTop = -1;
  }

  override render() {
    const h = this.hud;
    if (!h.modals.length) return nothing;
    return html`${repeat(
      h.modals,
      (m) => m.id,
      (m) => {
        const env = h.env('modal');
        const acts = m.spec.actions?.() || [];
        let body: TemplateResult;
        try {
          body = m.spec.blocks
            ? renderBlocks(m.spec.blocks(), env, `m${m.id}`)
            : m.spec.render
              ? html`<jv-custom .key=${`m${m.id}`} .renderFn=${m.spec.render}></jv-custom>`
              : html``;
        } catch (err) {
          body = html`<div class="state error">${(err as Error).message}</div>`;
        }
        return html`<div
          class="scrim"
          @keydown=${this.onKey}
          @click=${(e: Event) => e.target === e.currentTarget && h.closeModal(m, false)}
        >
          <div
            class="modal surface ${m.spec.wide ? 'wide' : ''}"
            role="dialog"
            aria-modal="true"
            aria-label=${m.spec.title}
          >
            <div class="mh">
              <h2>${m.spec.title}</h2>
              <button type="button" class="iconbtn" aria-label="Close" @click=${() => h.closeModal(m, false)}>
                ${unsafeSVG(iconSvg('close'))}
              </button>
            </div>
            <div class="mb" tabindex="0">${body}</div>
            ${acts.length ? html`<div class="mf">${acts.map((a) => button(a, env))}</div>` : nothing}
          </div>
        </div>`;
      },
    )}`;
  }
}

// ------------------------------------------------------------------ search
export class JvSearch extends RegionElement {
  readonly region = 'search';
  private sel = 0;
  private wasOpen = false;
  static override styles = [
    base,
    blockStyles,
    css`
      .scrim {
        position: fixed;
        inset: 0;
        z-index: 55;
      }
      .box {
        position: fixed;
        left: calc(var(--jv-gap) * 2 + var(--jv-rail));
        top: var(--jv-gap);
        width: min(440px, calc(100vw - 80px));
        border-radius: var(--jv-radius);
        padding: 8px;
        z-index: 56;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
      }
      .res {
        overflow: auto;
        margin-top: 6px;
      }
      .li.cur {
        background: var(--jv-surface-raised);
      }
      @media (max-width: 719px) {
        .box {
          left: var(--jv-gap);
          right: var(--jv-gap);
          width: auto;
        }
      }
    `,
  ];
  protected override updated(): void {
    const h = this.hud;
    if (h.searchOpen && !this.wasOpen) this.renderRoot.querySelector<HTMLInputElement>('input')?.focus();
    this.wasOpen = h.searchOpen;
  }
  override render() {
    const h = this.hud;
    if (!h.searchOpen) return nothing;
    const groups = h.results();
    const flat = groups.flatMap((g) => g.hits);
    if (this.sel >= flat.length) this.sel = 0;
    let n = 0;
    return html`<div class="scrim" @click=${() => h.closeSearch()}></div>
      <div class="box surface" role="search">
        <div class="search">
          ${icon('search')}
          <input
            type="search"
            data-search="global"
            placeholder="Find rooms, equipment, plates, devices…"
            autocomplete="off"
            spellcheck="false"
            .value=${live(h.query)}
            @input=${(e: Event) => ((h.query = (e.target as HTMLInputElement).value), (this.sel = 0), this.requestUpdate())}
            @keydown=${(e: KeyboardEvent) => {
              e.stopPropagation();
              if (e.key === 'Escape') h.closeSearch();
              else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                this.sel = (this.sel + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % Math.max(1, flat.length);
                this.requestUpdate();
              } else if (e.key === 'Enter' && flat[this.sel]) h.pickHit(flat[this.sel]);
            }}
          />
        </div>
        <div class="res" role="listbox">
          ${groups.map(
            (g) =>
              html`<div class="lbl" style="margin:8px 6px 2px">${g.provider.label}</div>
                ${g.hits.map((hit) => {
                  const i = n++;
                  return html`<button
                    type="button"
                    class="li act ${i === this.sel ? 'cur' : ''}"
                    role="option"
                    aria-selected=${i === this.sel}
                    @click=${() => h.pickHit(hit)}
                  >
                    <span class="lead">${hit.glyph ? glyph(hit.glyph) : icon(hit.icon || 'cube')}</span>
                    <span class="m"
                      ><div class="p">${hit.text}</div>
                      ${hit.secondary ? html`<div class="s">${hit.secondary}</div>` : nothing}</span
                    >
                    <span class="v">›</span>
                  </button>`;
                })}`,
          )}
          ${h.query.trim() && !flat.length ? html`<div class="state">Nothing matches</div>` : nothing}
        </div>
      </div>`;
  }
}

// ------------------------------------------------------------------ hover label + walking hint
export class JvHover extends RegionElement {
  readonly region = 'hover';
  static override styles = [
    base,
    css`
      .hover {
        position: fixed;
        transform: translateX(-50%);
        background: var(--jv-surface);
        border: 1px solid var(--jv-border);
        border-radius: 6px;
        padding: 3px 8px;
        font-size: 12px;
        white-space: nowrap;
        display: flex;
        gap: 6px;
        align-items: center;
        pointer-events: none;
        z-index: 10;
      }
      .hover b {
        font-weight: 600;
      }
      .hover span {
        color: var(--jv-text-muted);
      }
      .hint {
        position: fixed;
        left: 50%;
        bottom: 18px;
        transform: translateX(-50%);
        font-size: 12px;
        color: var(--jv-text-muted);
        border-radius: 999px;
        padding: 4px 12px;
        pointer-events: none;
        z-index: 9;
      }
      .hint kbd {
        color: var(--jv-text);
        opacity: 1;
      }
    `,
  ];
  override render() {
    const h = this.hud;
    const l = h.hoverLabel;
    const locked = h.deps.locked();
    return html`${
      l
        ? html`<div
            class="hover"
            id="hover"
            style=${l.at ? `left:${l.at.x}px;top:${l.at.y + 18}px` : 'left:50%;top:calc(50% + 22px)'}
          >
            <b>${l.title}</b>${l.line ? html`<span>· ${l.line}</span>` : nothing}
          </div>`
        : nothing
    }
    ${
      locked && !h.toasts.length
        ? html`<div class="hint surface">Walking · <kbd>Esc</kbd> to use the panels · <kbd>H</kbd> keys</div>`
        : nothing
    }`;
  }
}

// ------------------------------------------------------------------ the root
export class JvHud extends LitElement {
  static override properties = { hud: { attribute: false } };
  declare hud: Hud;
  static override styles = css`
    :host {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 5;
    }
    :host > * {
      pointer-events: auto;
    }
    :host(.locked) jv-dock,
    :host(.locked) jv-inspector,
    :host(.locked) jv-rail,
    :host(.locked) jv-status {
      opacity: 0.85;
      pointer-events: none;
    }
  `;
  override render() {
    const h = this.hud;
    return html`<jv-hover .hud=${h}></jv-hover>
      <jv-rail .hud=${h}></jv-rail>
      <jv-status .hud=${h}></jv-status>
      <jv-dock .hud=${h}></jv-dock>
      <jv-inspector .hud=${h}></jv-inspector>
      <jv-legend .hud=${h}></jv-legend>
      <jv-toasts .hud=${h}></jv-toasts>
      <jv-search .hud=${h}></jv-search>
      <jv-modal .hud=${h}></jv-modal>`;
  }
  /** F6: rail → dock → inspector → status → the view */
  cycle(back = false): void {
    const order = ['jv-rail', 'jv-dock', 'jv-inspector', 'jv-status'];
    const root = this.renderRoot as ShadowRoot;
    const els = order.map((t) => root.querySelector(t) as LitElement | null);
    const active = els.findIndex((el) => el?.shadowRoot?.activeElement);
    const firstIn = (el: LitElement | null) =>
      el?.shadowRoot?.querySelector<HTMLElement>('button, input, select, [tabindex]');
    for (let k = 1; k <= order.length + 1; k++) {
      const i = (active + (back ? -k : k) + order.length + 1) % (order.length + 1);
      if (i === order.length) {
        (document.activeElement as HTMLElement | null)?.blur();
        (document.querySelector('canvas') as HTMLElement | null)?.focus();
        return;
      }
      const f = firstIn(els[i]);
      if (f) {
        f.focus();
        return;
      }
    }
  }
  /** focus is inside the HUD (a control has it) */
  hasFocus(): boolean {
    return document.activeElement === this;
  }
  closeMenus(): boolean {
    const st = (this.renderRoot as ShadowRoot).querySelector('jv-status') as JvStatus | null;
    return !!st?.closeMenu();
  }
}

const define = (tag: string, c: CustomElementConstructor) => {
  if (!customElements.get(tag)) customElements.define(tag, c);
};
define('jv-rail', JvRail);
define('jv-dock', JvDock);
define('jv-inspector', JvInspector);
define('jv-status', JvStatus);
define('jv-legend', JvLegend);
define('jv-toasts', JvToasts);
define('jv-modal', JvModal);
define('jv-search', JvSearch);
define('jv-hover', JvHover);
define('jv-hud', JvHud);

/** put the HUD on the page */
export function mountHud(hud: Hud, parent: HTMLElement = document.body): JvHud {
  setElementEnv(hud.env('dock')); // the public elements (<jv-blocks>, <jv-meter>, <jv-list>) open subjects like the HUD
  const el = document.createElement('jv-hud') as JvHud;
  el.hud = hud;
  parent.appendChild(el);
  return el;
}
