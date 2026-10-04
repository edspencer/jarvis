// The tool guard behind canUseTool / PreToolUse: house tools by name, the web, and file tools inside the knowledge
// folder only (no '..', no absolute paths elsewhere, no symlink escapes).
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkToolUse, insideFolder } from '../src/core/guard.ts';

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
