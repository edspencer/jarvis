// npm run build-plugin -- <plugin.ts> <out.js>
// Bundles a plugin into one self-contained ES module that a site loads as an external plugin
// (`"plugins": { "<id>": { "module": "plugins/<id>.js" } }`, docs/plugins.md). `jarvis/plugin` is inlined (its run-time
// exports are definePlugin, which returns its argument, and constants), and so is any other package the plugin imports, except
// three.js: the viewer's own is `ctx.three.THREE`, so a run-time import of `three` is an error (type imports are fine).
// Any other bundler does the same job (docs/plugins.md shows esbuild); this one needs nothing beyond JARVIS's own tools.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, type Rollup } from 'vite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** the bundled module's source */
export async function buildPlugin(entry: string): Promise<string> {
  const out = await build({
    configFile: false,
    logLevel: 'warn',
    publicDir: false,
    resolve: { alias: { 'jarvis/plugin': resolve(ROOT, 'src/plugin-api.ts') } },
    build: {
      write: false,
      target: 'es2022',
      minify: false,
      lib: { entry: resolve(entry), formats: ['es'], fileName: 'plugin' },
      rollupOptions: { external: (id) => /^three($|\/)/.test(id) },
    },
  });
  const chunks = (Array.isArray(out) ? out : [out as Rollup.RollupOutput])
    .flatMap((o) => o.output)
    .filter((c): c is Rollup.OutputChunk => c.type === 'chunk');
  if (chunks.length !== 1) throw new Error(`${entry}: expected one module, got ${chunks.length} (no dynamic imports)`);
  const [chunk] = chunks;
  if (chunk.imports.length)
    throw new Error(
      `${entry} imports ${chunk.imports.join(', ')} at run time: use ctx.three.THREE (import three's types with "import type")`,
    );
  return chunk.code;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [entry, outFile] = process.argv.slice(2);
  if (!entry || !outFile) {
    console.log('usage: npm run build-plugin -- <plugin.ts> <out.js>');
    process.exit(2);
  }
  const code = await buildPlugin(entry);
  mkdirSync(dirname(resolve(outFile)), { recursive: true });
  writeFileSync(outFile, code);
  console.log(`${outFile}: ${(code.length / 1000).toFixed(1)} kB`);
}
