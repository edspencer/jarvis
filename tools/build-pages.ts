// npm run build:pages
// The live demo (GitHub Pages, .github/workflows/pages.yml): the built viewer (dist/, so run `npm run build` first)
// with the demo house next to it, in pages/. Served from a sub-path (https://<owner>.github.io/jarvis/): every URL the
// viewer makes is relative to the page (Vite's base './', site.json next to index.html, the KTX2 transcoder next to its
// loader), so the folder works at any path.
//
// There is no Home Assistant behind the demo: index.html gains a tiny script that adds ?ha=mock to the address when the
// visitor hasn't chosen an ?ha= mode, before the app starts, so the lights, the faults and the controls run on the mock.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const site = join(root, 'examples/demo-site');
const out = join(root, 'pages');

if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/index.html not found: run npm run build first');
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
cpSync(site, out, { recursive: true });
cpSync(dist, out, { recursive: true }); // the app wins over a site file of the same name, as in the container

const MOCK = `<script>
// the live demo has no Home Assistant: play the mock unless the address picks a mode (?ha=off, ?ha=mock)
(function () {
  var u = new URL(location.href);
  if (!u.searchParams.has('ha')) { u.searchParams.set('ha', 'mock'); history.replaceState(history.state, '', u); }
})();
</script>
`;
const index = join(out, 'index.html');
const html = readFileSync(index, 'utf8');
if (!html.includes('</head>')) throw new Error('dist/index.html has no </head>');
writeFileSync(index, html.replace('</head>', `${MOCK}</head>`));
console.log(`wrote ${out}: the viewer and the demo house, mock Home Assistant by default`);
