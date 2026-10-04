// npm run bundle-size (after npm run build)
// The gzip size of what the browser downloads from dist/, against the budgets in tools/bundle-budget.json: the initial
// JS (index.html's entry script and the chunks it preloads), the CSS it links, and all the JS (the plugins' lazy
// chunks too). Exits 1 if any is over its budget, or if a built-in plugin's chunk is in the initial JS (a plugin's code
// is downloaded only for a site that enables it). In CI the table also goes to the job summary.
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { BUILTIN_PLUGINS } from '../src/plugins/registry.ts';

const dist = resolve(process.argv[2] || 'dist');
const budget = JSON.parse(readFileSync(new URL('./bundle-budget.json', import.meta.url), 'utf8')) as Record<
  string,
  number
>;
const gz = (file: string) => gzipSync(readFileSync(resolve(dist, file)), { level: 9 }).length;
const html = readFileSync(resolve(dist, 'index.html'), 'utf8');
const refs = (re: RegExp) => [...html.matchAll(re)].map((m) => m[1].replace(/^\.\//, ''));
const initialJs = [
  ...refs(/<script[^>]+type="module"[^>]+src="([^"]+\.js)"/g),
  ...refs(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+\.js)"/g),
];
const css = refs(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+\.css)"/g);
const allJs = readdirSync(resolve(dist, 'assets'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => `assets/${f}`);
if (!initialJs.length) throw new Error(`no entry script found in ${dist}/index.html`);

const sum = (files: string[]) => files.reduce((n, f) => n + gz(f), 0);
const rows = [
  { name: 'initial JS', files: initialJs, key: 'initialJsGzip' },
  { name: 'CSS', files: css, key: 'cssGzip' },
  { name: 'all JS', files: allJs, key: 'allJsGzip' },
].map((r) => {
  if (typeof budget[r.key] !== 'number') throw new Error(`tools/bundle-budget.json has no ${r.key}`);
  return { ...r, size: sum(r.files), max: budget[r.key] };
});

const kB = (n: number) => `${(n / 1000).toFixed(1)} kB`;
const lines = [
  '### Bundle size (gzip)',
  '',
  '| | size | budget | files |',
  '| --- | --: | --: | --: |',
  ...rows.map(
    (r) => `| ${r.size > r.max ? '❌' : '✅'} ${r.name} | ${kB(r.size)} | ${kB(r.max)} | ${r.files.length} |`,
  ),
];
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
const over = rows.filter((r) => r.size > r.max);
for (const r of over)
  console.error(
    `${process.env.CI ? '::error::' : ''}${r.name} is ${kB(r.size)} gzipped, over its ${kB(r.max)} budget (tools/bundle-budget.json)`,
  );
// a plugin chunk preloaded by index.html would be downloaded on every site
const eager = initialJs.filter((f) =>
  Object.keys(BUILTIN_PLUGINS).some((id) => new RegExp(`^assets/${id}-[\\w-]{8}\\.js$`).test(f)),
);
if (eager.length)
  console.error(
    `${process.env.CI ? '::error::' : ''}plugin chunks in the initial JS (${eager.join(', ')}): a plugin's code should download only when a site enables it`,
  );
process.exit(over.length || eager.length ? 1 : 0);
