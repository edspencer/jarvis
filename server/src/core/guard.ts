// Defence in depth for the agent's tools. The SDK session is already limited (`tools` lists only WebSearch, WebFetch
// and, with a knowledge folder, Read/Grep/Glob; permissionMode 'dontAsk'), and the house tools only reach Home
// Assistant through the policy gate. On top of that every tool call passes this check (canUseTool and a PreToolUse
// hook): house tools by exact name, the web tools (WebFetch only to public http(s) addresses: never the LAN, this
// machine or Home Assistant), and the file tools only for paths that resolve, through symlinks, inside the knowledge
// folder. Everything else (Bash, Write, Edit, Task, other MCP servers) is refused.
import { realpathSync } from 'node:fs';
import { isIPv4, isIPv6 } from 'node:net';
import { isAbsolute, resolve, sep } from 'node:path';

export interface GuardOptions {
  /** the full names of the house tools: mcp__house__ha_act, … */
  houseTools: ReadonlySet<string>;
  /** the knowledge folder; null: Read/Grep/Glob are refused */
  knowledgeDir: string | null;
  /** WebSearch / WebFetch (default true) */
  web?: boolean;
  /** host names WebFetch may never reach besides the private ones (Home Assistant's) */
  blockedHosts?: readonly string[];
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

// ------------------------------------------------------------------------------------------------ WebFetch

/** an IPv4 address as 4 bytes (already in dotted form: WHATWG URL normalises 2130706433, 0x7f.1, 017700000001) */
const v4 = (h: string) => h.split('.').map(Number);

function privateV4(h: string): boolean {
  const [a, b] = v4(h);
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT, 100.64/10
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // 192.0.0/24 (IETF), 192.0.2/24 (docs)
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

/** an IPv6 address as 8 numbers (null if it isn't one) */
function v6Groups(h: string): number[] | null {
  let s = h;
  const tail: number[] = [];
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s); // a trailing dotted IPv4
  if (m) {
    const [a, b, c, d] = v4(m[2]);
    tail.push((a << 8) | b, (c << 8) | d);
    s = m[1].endsWith('::') ? m[1] : m[1].slice(0, -1);
  }
  const [head, rest] = s.split('::');
  const hex = (x: string) => (x ? x.split(':').map((g) => parseInt(g, 16)) : []);
  const left = hex(head);
  const right = rest === undefined ? [] : hex(rest);
  const fill = 8 - tail.length - left.length - right.length;
  if (fill < 0 || (rest === undefined && fill !== 0)) return null;
  const all = [...left, ...new Array<number>(fill).fill(0), ...right, ...tail];
  return all.some((g) => !(g >= 0 && g <= 0xffff)) ? null : all;
}

function privateV6(h: string): boolean {
  const g = v6Groups(h);
  if (!g) return true; // can't read it: refuse
  if (g.slice(0, 7).every((x) => x === 0)) return true; // :: and ::1
  const embedded = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  // IPv4-mapped ::ffff:a.b.c.d, the old IPv4-compatible ::a.b.c.d, and NAT64 64:ff9b::a.b.c.d carry an IPv4 address
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return privateV4(embedded(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return privateV4(embedded(g[6], g[7]));
  return (
    (g[0] & 0xfe00) === 0xfc00 || // unique local, fc00::/7
    (g[0] & 0xffc0) === 0xfe80 || // link-local, fe80::/10
    (g[0] & 0xffc0) === 0xfec0 || // the old site-local, fec0::/10
    (g[0] & 0xff00) === 0xff00 // multicast
  );
}

/** names that only mean something on a LAN */
const LOCAL_SUFFIX = /(^|\.)(localhost|local|lan|home|internal|intranet|corp|private|localdomain|home\.arpa)$/;

/**
 * Why WebFetch may not fetch `raw`, or null. Only http(s) to public addresses: no loopback, private, CGNAT or
 * link-local IP (in any notation WHATWG URL parsing normalises: decimal, hex, octal, IPv4-mapped IPv6), no localhost,
 * single-label or LAN-only names (.local, .lan, .home.arpa, .internal, …), and none of `blocked` (Home Assistant's host).
 * TODO: a public name that resolves to a private address (DNS rebinding, or a LAN name in public DNS) isn't caught:
 * that needs the fetch itself pinned to a checked address, which Claude Code's WebFetch doesn't offer.
 */
export function webFetchProblem(raw: unknown, blocked: readonly string[] = []): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'WebFetch needs a url';
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return 'not a URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `only http(s) pages, not ${u.protocol}`;
  if (u.username || u.password) return 'no credentials in the URL';
  const host = u.hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.+$/, '');
  const lan = 'the assistant may not fetch addresses on the local network';
  if (!host) return 'no host';
  if (blocked.some((b) => b.toLowerCase().replace(/\.+$/, '') === host)) return lan;
  if (isIPv4(host)) return privateV4(host) ? lan : null;
  if (isIPv6(host) || host.includes(':')) return privateV6(host) ? lan : null;
  if (!host.includes('.') || LOCAL_SUFFIX.test(host)) return lan;
  return null;
}

/** the host name of a URL, or null */
export function hostOf(url: string | undefined): string | null {
  try {
    return url ? new URL(url).hostname.replace(/^\[(.*)\]$/, '$1') : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ the check

export function checkToolUse(name: string, input: Record<string, unknown>, opts: GuardOptions): GuardResult {
  if (name.startsWith('mcp__')) return opts.houseTools.has(name) ? { allow: true } : deny(`${name} is not available`);
  if (name === 'WebSearch' || name === 'WebFetch') {
    if (opts.web === false) return deny('web access is off');
    const why = name === 'WebFetch' ? webFetchProblem(input.url, opts.blockedHosts) : null;
    return why ? deny(`WebFetch: ${why}`) : { allow: true };
  }
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
