// The loading screen: a list of stages with progress (the manifest, the model, its colliders), over a dimmed page.
// Loads after the first walkable frame (extra models, plugins) show as a thin bar in the status strip instead. Plain
// DOM: it is up before anything else loads.
const STAGES: [string, string][] = [
  ['manifest', 'Site manifest'],
  ['model', 'Model'],
  ['colliders', 'Colliders'],
];

export type StageState = 'waiting' | 'active' | 'done';

export interface Loading {
  stage(id: string, s: StageState, pct?: number, label?: string): void;
  error(title: string, url: string, lines: string[], note: string): void;
  hide(): void;
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

export function createLoading(el: HTMLElement): Loading {
  const st: Record<string, { s: StageState; pct?: number }> = Object.fromEntries(
    STAGES.map(([id]) => [id, { s: 'waiting' }]),
  );
  el.innerHTML = `<div class="ld"><div class="ld-title">JARVIS</div><ol class="ld-stages" aria-live="polite"></ol></div>`;
  el.setAttribute('role', 'status');
  const list = el.querySelector('ol')!;
  const draw = () => {
    list.innerHTML = STAGES.map(([id, label]) => {
      const x = st[id];
      const mark = x.s === 'done' ? '✓' : x.s === 'active' ? '…' : '○';
      const pct = x.s === 'active' && x.pct != null ? ` <span class="ld-pct">${x.pct}%</span>` : '';
      return `<li class="ld-${x.s}"><span class="ld-mark">${mark}</span>${label}${pct}${x.s === 'active' && x.pct != null ? `<span class="ld-bar"><span style="width:${x.pct}%"></span></span>` : ''}</li>`;
    }).join('');
  };
  draw();
  return {
    stage(id, s, pct) {
      if (!st[id]) return;
      st[id] = { s, pct };
      draw();
    },
    error(title, url, lines, note) {
      el.classList.add('error');
      el.innerHTML =
        `<div class="ld"><b>${esc(title)}</b>${url ? ` <code>${esc(url)}</code>` : ''}<ul>` +
        lines.map((l) => `<li>${esc(l)}</li>`).join('') +
        `</ul>${note ? `<span class="sub">${esc(note)}</span>` : ''}</div>`;
    },
    hide() {
      el.classList.add('hidden');
    },
  };
}
