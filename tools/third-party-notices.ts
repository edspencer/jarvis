// npm run notices [-- --check]
// Writes THIRD_PARTY_NOTICES.md: the licence of every third-party package whose code ends up in dist/ (found from the
// build's source maps, so run `npm run build` first), and of the libraries three.js vendors that the build pulls in.
// --check: exit 1 if the committed file differs from what would be written (CI runs it; see .github/workflows/licences.yml).
// Versions are left out on purpose, so a dependency bump alone doesn't make the file stale; a new package does.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const assets = join(root, 'dist/assets');
const out = join(root, 'THIRD_PARTY_NOTICES.md');

interface Notice {
  name: string;
  licence: string;
  url: string;
  /** what of it ships, and where */
  what: string;
  texts: string[];
}

// Files three.js vendors from other projects, under their own licences (three's LICENSE covers three's own code).
const VENDORED: Record<string, Omit<Notice, 'texts'> & { files: string[] }> = {
  'three/examples/jsm/libs/meshopt_decoder.module.js': {
    name: 'meshoptimizer (decoder)',
    licence: 'MIT',
    url: 'https://github.com/zeux/meshoptimizer',
    what: 'the meshopt geometry decoder, vendored by three.js',
    files: ['meshoptimizer-LICENSE.txt'],
  },
  'three/examples/jsm/libs/ktx-parse.module.js': {
    name: 'KTX-Parse',
    licence: 'MIT',
    url: 'https://github.com/donmccurdy/KTX-Parse',
    what: 'the KTX2 container parser, vendored by three.js',
    files: ['ktx-parse-LICENSE.txt'],
  },
  'three/examples/jsm/libs/zstddec.module.js': {
    name: 'zstddec (with Zstandard)',
    licence: 'MIT AND BSD-3-Clause',
    url: 'https://github.com/donmccurdy/zstddec',
    what: 'the Zstandard decoder (WebAssembly build of Zstandard) for KTX2 supercompression, vendored by three.js',
    files: ['zstddec-LICENSE.txt'],
  },
};
// Assets emitted as files, not modules (no source map): matched by file name.
const ASSETS: Record<string, Omit<Notice, 'texts'> & { files: string[] }> = {
  basis_transcoder: {
    name: 'Basis Universal (transcoder)',
    licence: 'Apache-2.0',
    url: 'https://github.com/BinomialLLC/basis_universal',
    what: 'basis_transcoder.js and basis_transcoder.wasm, the KTX2 / Basis texture transcoder, vendored by three.js',
    files: ['basis-universal-NOTICE.txt', 'basis-universal-LICENSE.txt'],
  },
};

const text = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n').trimEnd();
const licenceFile = (dir: string) =>
  readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f)) ?? null;
const repoUrl = (pkg: { repository?: string | { url?: string }; homepage?: string }, name: string) => {
  const r = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!r) return pkg.homepage || `https://www.npmjs.com/package/${name}`;
  return r
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^github:/, 'https://github.com/');
};

function collect(): Notice[] {
  if (!existsSync(assets)) throw new Error('dist/assets not found: run npm run build first');
  const files = readdirSync(assets);
  const packages = new Set<string>();
  const vendored = new Set<string>();
  for (const f of files.filter((f) => f.endsWith('.js.map'))) {
    const map = JSON.parse(readFileSync(join(assets, f), 'utf8')) as { sources: string[] };
    for (const s of map.sources) {
      const i = s.lastIndexOf('node_modules/');
      if (i < 0) continue;
      const path = s.slice(i + 'node_modules/'.length);
      const parts = path.split('/');
      packages.add(parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]);
      if (VENDORED[path]) vendored.add(path);
    }
  }
  const notices: Notice[] = [...packages].sort().map((name) => {
    const dir = join(root, 'node_modules', name);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const lf = licenceFile(dir);
    if (!lf) throw new Error(`${name}: no licence file in node_modules/${name}`);
    return {
      name,
      licence: pkg.license,
      url: repoUrl(pkg, name),
      what: 'bundled into dist/assets/*.js',
      texts: [text(join(dir, lf))],
    };
  });
  const extra = [
    ...[...vendored].sort().map((p) => VENDORED[p]),
    ...Object.entries(ASSETS)
      .filter(([prefix]) => files.some((f) => f.startsWith(prefix)))
      .map(([, v]) => v),
  ];
  for (const { files: fs, ...v } of extra)
    notices.push({ ...v, texts: fs.map((f) => text(join(root, 'tools/notices', f))) });
  return notices;
}

function render(notices: Notice[]): string {
  const lines = [
    '# Third-party notices',
    '',
    'JARVIS is MIT-licensed (see LICENSE). The built viewer (`dist/`, the release tarball, the container image and the',
    'live demo) also contains the third-party code below, under the licences that follow. This file is generated by',
    '`npm run notices` from the build; do not edit it by hand.',
    '',
    '| Component | Licence | What ships |',
    '| --- | --- | --- |',
    ...notices.map((n) => `| [${n.name}](${n.url}) | ${n.licence} | ${n.what} |`),
    '',
  ];
  for (const n of notices) {
    lines.push(`## ${n.name}`, '', `${n.licence}: ${n.url}`, '');
    for (const t of n.texts) lines.push('```text', t, '```', '');
  }
  return lines.join('\n');
}

const md = render(collect());
if (process.argv.includes('--check')) {
  const old = existsSync(out) ? readFileSync(out, 'utf8') : '';
  if (old !== md) {
    console.error('THIRD_PARTY_NOTICES.md differs from what the build bundles: npm run build && npm run notices');
    process.exit(1);
  }
  console.log('THIRD_PARTY_NOTICES.md is up to date');
} else {
  writeFileSync(out, md);
  console.log(`wrote ${out}`);
}
