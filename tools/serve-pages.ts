// node tools/serve-pages.ts [port]
// Serves pages/ (npm run build:pages) under /jarvis/, as GitHub Pages serves a project site: the sub-path check in
// tests/pages runs against it. Plain files only: a missing one is a 404 (no fallback to index.html).
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const BASE = '/jarvis/';
const root = resolve(import.meta.dirname, '../pages');
const port = Number(process.argv[2] || process.env.PAGES_PORT || 5193);
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
};

createServer((req, res) => {
  let path = decodeURIComponent((req.url || '/').split('?')[0]);
  if (path === '/jarvis') path = BASE;
  if (!path.startsWith(BASE)) return void res.writeHead(404).end('not under /jarvis/');
  let file = normalize(join(root, path.slice(BASE.length)));
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!file.startsWith(root) || !existsSync(file)) return void res.writeHead(404).end('not found');
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`pages/ at http://localhost:${port}${BASE}`));
