// What view_layer may switch: the view's layers (by id or exact label, any case) and a short allow-list of the core's
// own view toggles. Nothing else: a plugin's key can do anything (the Lights plugin's switches a real light), so the
// agent never gets to press one. Pure, so it is unit-tested.

/** the core view toggles view_layer may switch (side-effect free: they only change what is drawn) */
export const VIEW_TOGGLES: Readonly<Record<string, 'cutaway' | 'upper' | 'ghost'>> = Object.freeze({
  cutaway: 'cutaway',
  'upper storey': 'upper',
  'upper floor': 'upper',
  upper: 'upper',
  upstairs: 'upper',
  ghost: 'ghost',
});

export type LayerTarget =
  | { kind: 'layer'; id: string; label: string }
  | { kind: 'toggle'; toggle: 'cutaway' | 'upper' | 'ghost' }
  | { kind: 'none'; detail: string };

const clean = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');

/** the layer or view toggle `name` means, or why there is none */
export function resolveLayer(name: string, layers: readonly { id: string; label: string }[]): LayerTarget {
  const n = clean(typeof name === 'string' ? name : '');
  if (!n || !/[a-z0-9]/.test(n)) return { kind: 'none', detail: 'no layer named' };
  const l = layers.find((x) => clean(x.id) === n || clean(x.label) === n);
  if (l) return { kind: 'layer', id: l.id, label: l.label };
  if (Object.hasOwn(VIEW_TOGGLES, n)) return { kind: 'toggle', toggle: VIEW_TOGGLES[n] };
  const known = [...layers.map((x) => x.id), 'cutaway', 'upper'].join(', ');
  return { kind: 'none', detail: `no layer called "${name.slice(0, 60)}" (there are: ${known})` };
}
