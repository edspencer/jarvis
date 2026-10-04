// The HUD's components as custom elements, for a plugin's own render(el) (hud-panels.md §7): custom elements are a
// browser contract, so a plugin built with any tool, or none, can use them by tag name, with no shared library
// instance. Themed by the --jv-* tokens, which reach into their shadow roots.
//   <jv-blocks>   any standard blocks: el.blocks = [{ type: 'kv', rows: [...] }, …]
//   <jv-meter>    a big value with a unit and a sparkline: <jv-meter value="1210" unit="W">, el.spark = [...]
//   <jv-list>     clickable rows: el.rows = [{ text, secondary, value, dot, subject }, …]
// Links and rows with a subject open it in the inspector, as they do in the HUD's own panels.
import { LitElement, html } from 'lit';
import type { Blocks, ListRow } from '../core/plugin/types';
import { renderBlocks, type BlockEnv } from './blocks';
import { base, blockStyles } from './styles';

let env: BlockEnv | null = null;
// expanded rows and closed groups belong to each element: two <jv-blocks> with the same keys don't share them
const uiState = new WeakMap<LitElement, { open: Set<string>; closedGroups: Record<string, boolean> }>();
/** the HUD hands its environment over at mount (opening subjects, the confirm modal) */
export function setElementEnv(e: BlockEnv): void {
  env = e;
}
function currentEnv(el: LitElement): BlockEnv {
  let ui = uiState.get(el);
  if (!ui) uiState.set(el, (ui = { open: new Set(), closedGroups: {} }));
  const { open, closedGroups } = ui;
  return {
    open: (s) => env?.open(s),
    describe: (s) => env?.describe(s) ?? null,
    confirm: (c) => env?.confirm(c) ?? Promise.resolve(false),
    groupClosed: (id, d) => closedGroups[id] ?? d,
    toggleGroup: (id, d) => ((closedGroups[id] = !(closedGroups[id] ?? d)), el.requestUpdate()),
    isOpen: (k) => open.has(k),
    toggleOpen: (k) => (open.has(k) ? open.delete(k) : open.add(k), el.requestUpdate()),
  };
}

export class JvBlocks extends LitElement {
  static override properties = { blocks: { attribute: false } };
  static override styles = [base, blockStyles];
  declare blocks: Blocks;
  override render() {
    return renderBlocks(this.blocks || [], currentEnv(this), 'el');
  }
}

export class JvMeter extends LitElement {
  static override properties = { value: {}, unit: {}, spark: { attribute: false } };
  static override styles = [base, blockStyles];
  declare value: string;
  declare unit: string;
  declare spark: number[] | undefined;
  override render() {
    return renderBlocks(
      [{ type: 'meter', value: this.value ?? '', unit: this.unit, spark: this.spark }],
      currentEnv(this),
      'm',
    );
  }
}

export class JvList extends LitElement {
  static override properties = { rows: { attribute: false }, empty: {} };
  static override styles = [base, blockStyles];
  declare rows: ListRow[];
  declare empty: string;
  override render() {
    return html`${renderBlocks([{ type: 'list', rows: this.rows || [], empty: this.empty }], currentEnv(this), 'l')}`;
  }
}

for (const [tag, c] of [
  ['jv-blocks', JvBlocks],
  ['jv-meter', JvMeter],
  ['jv-list', JvList],
] as const)
  if (!customElements.get(tag)) customElements.define(tag, c);
