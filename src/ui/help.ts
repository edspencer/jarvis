// The help modal, generated from the key registry: the core's keys, then each running plugin's, grouped. Nothing
// here is hand-written per plugin, so a plugin that isn't loaded isn't listed.
import type { Site } from '../site';
import type { Blocks, KeyEntry } from '../core/plugin/types';
import { keyName } from '../core/plugin/keys';

export function helpBlocks(site: Site, keys: KeyEntry[], touch = false): Blocks {
  const groups = new Map<string, KeyEntry[]>();
  for (const k of keys) {
    if (k.hidden) continue;
    const g = k.group || k.ownerName;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(k);
  }
  const out: Blocks = [];
  const lead = [site.description, 'Doors are shown open; glass is see-through.'].filter(Boolean).join(' ');
  out.push({ type: 'text', text: [{ text: site.name }, { text: lead, muted: true }] });
  if (touch)
    out.push(
      { type: 'label', text: 'Touch' },
      {
        type: 'kv',
        rows: [
          ['Walk / Overview', 'the switch in the strip at the top'],
          ['Thumb-stick', 'move (walking); push further to go faster'],
          ['Drag the view', 'look around (walking); rotate, pinch to zoom (overview)'],
          ['Tap', 'inspect what is under your finger'],
        ],
      },
    );
  for (const [g, list] of groups) {
    out.push({ type: 'label', text: g });
    out.push({
      type: 'kv',
      rows: list.map((k) => [k.display || keyName(k), k.label] as [string, string]),
    });
  }
  out.push({
    type: 'text',
    text: {
      text: 'F6 moves between the rail, the dock, the inspector, the strip and the view. Esc releases the mouse, then closes the innermost panel.',
      muted: true,
    },
  });
  return out;
}
