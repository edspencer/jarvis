// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import '../../src/ui/elements';
import type { JvBlocks } from '../../src/ui/elements';
import type { Blocks } from '../../src/core/plugin/types';

async function mount(blocks: Blocks): Promise<JvBlocks> {
  const el = document.createElement('jv-blocks') as JvBlocks;
  el.blocks = blocks;
  document.body.append(el);
  await el.updateComplete;
  return el;
}
const q = (el: JvBlocks, sel: string) => el.shadowRoot!.querySelector<HTMLElement>(sel)!;

describe('<jv-blocks>', () => {
  it('keeps expanded notes and closed groups per element', async () => {
    const blocks: Blocks = [
      { type: 'note', text: 'word '.repeat(200) },
      { type: 'group', id: 'g', title: 'Group', blocks: [{ type: 'text', text: 'inside' }] },
    ];
    const a = await mount(blocks),
      b = await mount(blocks);

    q(a, 'button.more').click();
    q(a, 'button.grp').click();
    await a.updateComplete;
    b.requestUpdate();
    await b.updateComplete;

    expect(q(a, '.note').classList.contains('open')).toBe(true);
    expect(q(a, 'button.grp').getAttribute('aria-expanded')).toBe('false');
    // the other element, with the same keys, is untouched
    expect(q(b, '.note').classList.contains('open')).toBe(false);
    expect(q(b, 'button.grp').getAttribute('aria-expanded')).toBe('true');

    // and a new element starts fresh
    const c = await mount(blocks);
    expect(q(c, '.note').classList.contains('open')).toBe(false);
  });
});
