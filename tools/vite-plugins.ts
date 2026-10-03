// Vite plugin for the viewer: serve a site folder (the model and its data files) next to the app.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { Connect, Plugin } from 'vite';

const MIME: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ktx2': 'image/ktx2',
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
  '.md': 'text/markdown; charset=utf-8',
};

// Serves files under `root` at the app's base URL, if they exist; anything else falls through to Vite.
function staticFrom(root: string): Connect.NextHandleFunction {
  const abs = resolve(root);
  return (req, res, next) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = normalize(join(abs, url));
    if (!file.startsWith(abs) || !existsSync(file) || !statSync(file).isFile()) return next();
    res.setHeader('Content-Type', MIME[extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    createReadStream(file).pipe(res);
  };
}

/** The site folder (model + data), served by `vite` and `vite preview`; never bundled into dist/. */
export function siteFolder(dir: string): Plugin {
  return {
    name: 'jarvis:site-folder',
    configureServer(server) {
      if (!existsSync(dir)) server.config.logger.warn(`site folder ${dir} not found: the viewer will have no model`);
      server.middlewares.use(staticFrom(dir));
    },
    configurePreviewServer(server) {
      server.middlewares.use(staticFrom(dir));
    },
  };
}
