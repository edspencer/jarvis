// Defence in depth for the agent's tools. The SDK session is already limited (`tools` lists only WebSearch, WebFetch
// and, with a knowledge folder, Read/Grep/Glob; permissionMode 'dontAsk'), and the house tools only reach Home
// Assistant through the policy gate. On top of that every tool call passes this check (canUseTool and a PreToolUse
// hook): house tools by exact name, the web tools, and the file tools only for paths that resolve, through symlinks,
// inside the knowledge folder. Everything else (Bash, Write, Edit, Task, other MCP servers) is refused.
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

export interface GuardOptions {
  /** the full names of the house tools: mcp__house__ha_act, … */
  houseTools: ReadonlySet<string>;
  /** the knowledge folder; null: Read/Grep/Glob are refused */
  knowledgeDir: string | null;
  /** WebSearch / WebFetch (default true) */
  web?: boolean;
}

export type GuardResult = { allow: true } | { allow: false; reason: string };

const deny = (reason: string): GuardResult => ({ allow: false, reason });

/** true if `path` (absolute or relative to root) is root or under it, after resolving symlinks */
export function insideFolder(root: string, path: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  if (typeof path !== 'string' || !path || path.includes('\0')) return false;
  const abs = isAbsolute(path) ? path : resolve(realRoot, path);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return false; // missing files are refused rather than resolved by hand (a dangling symlink could point anywhere)
  }
  return real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
}

/** a glob pattern that can't climb out of the folder it runs in */
const safeGlob = (g: unknown) =>
  g === undefined ||
  (typeof g === 'string' && !isAbsolute(g) && !g.split(/[\\/]/).includes('..') && !g.startsWith('~'));

export function checkToolUse(name: string, input: Record<string, unknown>, opts: GuardOptions): GuardResult {
  if (name.startsWith('mcp__')) return opts.houseTools.has(name) ? { allow: true } : deny(`${name} is not available`);
  if (name === 'WebSearch' || name === 'WebFetch')
    return opts.web === false ? deny('web access is off') : { allow: true };
  if (name === 'Read' || name === 'Grep' || name === 'Glob') {
    const root = opts.knowledgeDir;
    if (!root) return deny('there is no knowledge folder');
    const key = name === 'Read' ? 'file_path' : 'path';
    const p = input[key];
    if (name === 'Read' && (typeof p !== 'string' || !p)) return deny('Read needs a file_path');
    if (p !== undefined && !insideFolder(root, String(p))) return deny(`${name} is limited to the knowledge folder`);
    if (!safeGlob(input.pattern && name === 'Glob' ? input.pattern : undefined) || !safeGlob(input.glob))
      return deny(`${name}: the pattern must stay inside the knowledge folder`);
    return { allow: true };
  }
  return deny(`${name} is not available to the assistant`);
}
