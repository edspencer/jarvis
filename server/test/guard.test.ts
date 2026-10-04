// The tool guard behind canUseTool / PreToolUse: house tools by name, the web, and file tools inside the knowledge
// folder only (no '..', no absolute paths elsewhere, no symlink escapes).
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkToolUse, hostOf, insideFolder, webFetchProblem } from '../src/core/guard.ts';

const base = mkdtempSync(join(tmpdir(), 'jarvis-guard-'));
const kb = join(base, 'kb');
mkdirSync(join(kb, 'manuals'), { recursive: true });
writeFileSync(join(kb, 'manuals', 'heater.txt'), 'manual');
writeFileSync(join(base, 'secret.txt'), 'secret');
symlinkSync(join(base, 'secret.txt'), join(kb, 'link-out.txt'));
symlinkSync(base, join(kb, 'dir-out'));
symlinkSync(join(kb, 'manuals', 'heater.txt'), join(kb, 'link-in.txt'));

const opts = { houseTools: new Set(['mcp__house__ha_act', 'mcp__house__ha_find']), knowledgeDir: kb };
const allowed = (name: string, input: Record<string, unknown> = {}, o = opts) => checkToolUse(name, input, o).allow;

describe('guard', () => {
  it('allows the house tools by exact name, nothing else over MCP', () => {
    expect(allowed('mcp__house__ha_act')).toBe(true);
    expect(allowed('mcp__house__ha_call_service')).toBe(false);
    expect(allowed('mcp__other__ha_act')).toBe(false);
  });

  it('allows the web unless switched off', () => {
    expect(allowed('WebSearch', { query: 'x' })).toBe(true);
    expect(allowed('WebFetch', { url: 'https://example.org' })).toBe(true);
    expect(allowed('WebSearch', {}, { ...opts, web: false } as typeof opts)).toBe(false);
    expect(allowed('WebFetch', { url: 'https://example.org' }, { ...opts, web: false } as typeof opts)).toBe(false);
  });

  it('WebFetch: public http(s) only, never the LAN, this machine or Home Assistant', () => {
    const fetchOk = (url: unknown, blocked: string[] = []) => webFetchProblem(url, blocked) === null;
    for (const url of [
      'https://example.org/manual.pdf',
      'http://www.example.com:8080/x?y=1',
      'https://8.8.8.8/',
      'https://[2606:4700:4700::1111]/',
      'https://172.32.0.1/',
      'https://100.128.0.1/',
      'https://192.169.0.1/',
    ])
      expect(fetchOk(url), url).toBe(true);
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.org/x',
      'javascript:alert(1)',
      'data:text/html,hi',
      'not a url',
      '',
      undefined,
      'https://user:pw@example.org/',
      // loopback, private, CGNAT, link-local, unspecified, multicast
      'http://127.0.0.1:8787/assistant/health',
      'http://127.9.9.9/',
      'http://10.0.0.1/',
      'http://172.16.5.4/',
      'http://172.31.255.255/',
      'http://10.0.0.5/',
      'http://100.64.0.1/',
      'http://100.127.255.255/',
      'http://169.254.169.254/latest/meta-data/',
      'http://0.0.0.0/',
      'http://224.0.0.1/',
      // other notations of the same addresses, normalised by URL parsing
      'http://2130706433/',
      'http://0x7f000001/',
      'http://0x7f.1/',
      'http://017700000001/',
      'http://127.1/',
      'http://167772165/', // 10.0.0.5
      'http://[::1]/',
      'http://[::]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:a00:5]/', // 10.0.0.5
      'http://[64:ff9b::a00:1]/',
      'http://[fc00::1]/',
      'http://[fd12:3456::1]/',
      'http://[fe80::1]/',
      // names that only mean something here
      'http://localhost:8123/',
      'http://LOCALHOST./',
      'http://foo.localhost/',
      'http://homeassistant:8123/',
      'http://nas/',
      'http://printer.local/',
      'http://router.lan/',
      'http://ha.home.arpa/',
      'http://db.internal/',
      'http://nas.localdomain/',
    ])
      expect(fetchOk(url), String(url)).toBe(false);
    // the configured Home Assistant's host, whatever its name
    expect(fetchOk('https://ha.example.org/api/states', ['ha.example.org'])).toBe(false);
    expect(fetchOk('https://HA.example.org./api/states', ['ha.example.org'])).toBe(false);
    expect(fetchOk('https://example.org/', ['ha.example.org'])).toBe(true);
    const o = { ...opts, blockedHosts: ['ha.example.org'] };
    expect(checkToolUse('WebFetch', { url: 'https://ha.example.org/' }, o)).toEqual({
      allow: false,
      reason: 'WebFetch: the assistant may not fetch addresses on the local network',
    });
    expect(allowed('WebFetch', { url: 'http://172.20.0.1/' })).toBe(false);
    expect(hostOf('https://ha.example.org:8123/x')).toBe('ha.example.org');
    expect(hostOf('http://[fd00::5]:8123')).toBe('fd00::5');
    expect(hostOf(undefined)).toBeNull();
  });

  it('refuses everything that writes or runs', () => {
    for (const t of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Task', 'Agent', 'KillShell', 'Skill'])
      expect(allowed(t, { command: 'ls', file_path: join(kb, 'x') })).toBe(false);
  });

  it('Read: only files inside the knowledge folder', () => {
    expect(allowed('Read', { file_path: join(kb, 'manuals/heater.txt') })).toBe(true);
    expect(allowed('Read', { file_path: 'manuals/heater.txt' })).toBe(true);
    expect(allowed('Read', { file_path: join(kb, 'link-in.txt') })).toBe(true);
    expect(allowed('Read', { file_path: join(base, 'secret.txt') })).toBe(false);
    expect(allowed('Read', { file_path: join(kb, '../secret.txt') })).toBe(false);
    expect(allowed('Read', { file_path: '../secret.txt' })).toBe(false);
    expect(allowed('Read', { file_path: '/etc/passwd' })).toBe(false);
    expect(allowed('Read', { file_path: join(kb, 'link-out.txt') })).toBe(false);
    expect(allowed('Read', { file_path: join(kb, 'dir-out/secret.txt') })).toBe(false);
    expect(allowed('Read', { file_path: join(kb, 'missing.txt') })).toBe(false);
    expect(allowed('Read', {})).toBe(false);
  });

  it('Grep / Glob: paths and patterns stay inside', () => {
    expect(allowed('Grep', { pattern: 'filter' })).toBe(true);
    expect(allowed('Grep', { pattern: 'filter', path: join(kb, 'manuals') })).toBe(true);
    expect(allowed('Grep', { pattern: 'x', path: base })).toBe(false);
    expect(allowed('Grep', { pattern: 'x', glob: '../**' })).toBe(false);
    expect(allowed('Glob', { pattern: '**/*.txt' })).toBe(true);
    expect(allowed('Glob', { pattern: '../*' })).toBe(false);
    expect(allowed('Glob', { pattern: '/etc/*' })).toBe(false);
    expect(allowed('Glob', { pattern: '*', path: join(kb, 'dir-out') })).toBe(false);
  });

  it('without a knowledge folder the file tools are off', () => {
    expect(
      allowed('Read', { file_path: join(kb, 'manuals/heater.txt') }, { ...opts, knowledgeDir: null as never }),
    ).toBe(false);
  });

  it('insideFolder', () => {
    expect(insideFolder(kb, kb)).toBe(true);
    expect(insideFolder(kb, `${kb}-other`)).toBe(false);
    expect(insideFolder(kb, 'a\0b')).toBe(false);
    expect(insideFolder(join(base, 'nope'), 'x')).toBe(false);
  });
});
