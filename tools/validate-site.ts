// npm run validate-site -- <site folder | site.json>
// Checks a site folder: the manifest against its schema, the files it names, the models against docs/model-format.md.
// Exits 1 if there are errors (warnings alone pass).
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { checkSite } from '../src/site/check-site.ts';

const arg = process.argv[2];
if (!arg || arg === '-h' || arg === '--help') {
  console.log('usage: npm run validate-site -- <site folder | path to site.json>');
  process.exit(arg ? 0 : 2);
}
let path = resolve(arg);
if ((await stat(path).catch(() => null))?.isDirectory()) path = resolve(path, 'site.json');

const read = async (url: string): Promise<Uint8Array | null> => {
  try {
    return new Uint8Array(await readFile(fileURLToPath(url)));
  } catch {
    return null;
  }
};

const r = await checkSite(pathToFileURL(path).href, read);
const tty = process.stdout.isTTY;
const c = (code: number, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
console.log(`${path}${r.site ? `: ${r.site.name} (${r.site.id})` : ''}`);
for (const n of r.notes) console.log(`  ${c(2, '·')} ${n}`);
for (const w of r.warnings) console.log(`  ${c(33, 'warning')} ${w}`);
for (const e of r.errors) console.log(`  ${c(31, 'error')} ${e}`);
console.log(
  r.ok
    ? c(32, `ok${r.warnings.length ? ` (${r.warnings.length} warning${r.warnings.length > 1 ? 's' : ''})` : ''}`)
    : c(31, `${r.errors.length} error${r.errors.length > 1 ? 's' : ''}`),
);
process.exit(r.ok ? 0 : 1);
