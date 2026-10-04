import { describe, expect, it, vi } from 'vitest';
import { openPanel, sameSubject, sectionsFor, type SectionRec } from '../../src/ui/model';
import type { SectionProvider, Subject } from '../../src/core/plugin/types';

const subject: Subject = { kind: 'item', id: 'plates:KT-S-A' };
let seq = 0;
const rec = (id: string, order: number | undefined, answer: boolean | 'throw' = true, owner = id): SectionRec => ({
  owner,
  seq: seq++,
  provider: {
    id,
    title: id,
    icon: 'cube',
    order,
    for: () => {
      if (answer === 'throw') throw new Error('boom');
      return answer ? { blocks: [{ type: 'text', text: id }] } : null;
    },
  } as SectionProvider,
});

describe('inspector sections', () => {
  it('asks every provider; keeps the answers ordered by order, then registration', () => {
    const recs = [
      rec('energy', 60),
      rec('ha', 60),
      rec('object', 90, true, 'core'),
      rec('plates', 10),
      rec('pins', 50, false),
      rec('extra', undefined),
    ];
    expect(sectionsFor(recs, subject).map((s) => s.rec.provider.id)).toEqual([
      'plates',
      'extra',
      'energy',
      'ha',
      'object',
    ]);
  });

  it('shows four sections from four plugins for one subject (a plate with a sensor and a switch on it)', () => {
    const recs = [
      rec('ha', 60, true, 'home-assistant'),
      rec('object', 90, true, 'core'),
      rec('energy', 55, true, 'energy'),
      rec('plates', 10, true, 'switches'),
    ];
    const shown = sectionsFor(recs, subject);
    expect(shown.map((s) => s.rec.owner)).toEqual(['switches', 'energy', 'home-assistant', 'core']);
  });

  it('turns a provider that throws into an error section without hiding the others', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const shown = sectionsFor([rec('bad', 10, 'throw'), rec('good', 20)], subject);
    expect(shown.map((s) => s.rec.provider.id)).toEqual(['bad', 'good']);
    expect(shown[0].content).toEqual({ error: 'boom' });
    err.mockRestore();
  });
});

describe('the dock', () => {
  it('opens up to two panels; a third closes the oldest unpinned one', () => {
    let open: string[] = [];
    open = openPanel(open, new Set(), 'nav', 2);
    open = openPanel(open, new Set(), 'sun', 2);
    open = openPanel(open, new Set(), 'pins', 2);
    expect(open).toEqual(['sun', 'pins']);
  });

  it('keeps a pinned panel open', () => {
    expect(openPanel(['nav', 'sun'], new Set(['nav']), 'pins', 2)).toEqual(['nav', 'pins']);
    expect(openPanel(['nav', 'sun'], new Set(['nav', 'sun']), 'pins', 2)).toEqual(['nav', 'sun', 'pins']);
  });

  it('re-opening a panel moves it to the top; phones keep one', () => {
    expect(openPanel(['nav', 'sun'], new Set(), 'nav', 2)).toEqual(['sun', 'nav']);
    expect(openPanel(['nav'], new Set(), 'sun', 1)).toEqual(['sun']);
  });
});

describe('subjects', () => {
  it('compares items by id and objects by node and part', () => {
    const node = {} as never;
    expect(sameSubject({ kind: 'item', id: 'pins:a' }, { kind: 'item', id: 'pins:a' })).toBe(true);
    expect(sameSubject({ kind: 'item', id: 'pins:a' }, { kind: 'item', id: 'pins:b' })).toBe(false);
    expect(sameSubject({ kind: 'object', node }, { kind: 'object', node, part: null })).toBe(true);
    expect(sameSubject({ kind: 'object', node, part: { name: 'x', props: {} } }, { kind: 'object', node })).toBe(false);
    expect(sameSubject(null, null)).toBe(true);
  });
});
