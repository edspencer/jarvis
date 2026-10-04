// The audit log: one JSON line per gate decision, per tool call and per login (who, which surface, what they said,
// which tool, what happened), appended to <data>/audit.jsonl. Append-only and synchronous, so lines never interleave
// and nothing is lost to a crash between a decision and its write; the volume is a few lines per turn.
// TODO(open question 6: transcripts and privacy): how long to keep this file; for now it grows until someone rotates
// it (logrotate's copytruncate works, since every write reopens the file).
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AuditRecord {
  /** 'gate' (the policy decided), 'tool' (a tool ran), 'confirm' (a person answered), … */
  kind: string;
  /** who: the authenticated user's name (a clients-file name or the Home Assistant user's) */
  user?: string;
  client?: string;
  surface?: string;
  utterance?: string;
  tool?: string;
  args?: unknown;
  decision?: string;
  detail?: string;
  [k: string]: unknown;
}

export interface Audit {
  write(rec: AuditRecord): void;
}

/** an audit that appends to `file`; null: a no-op (tests) */
export function createAudit(file: string | null, now: () => Date = () => new Date()): Audit {
  if (!file) return { write() {} };
  mkdirSync(dirname(file), { recursive: true });
  let warned = false;
  return {
    write(rec) {
      try {
        appendFileSync(file, JSON.stringify({ at: now().toISOString(), ...rec }) + '\n', { mode: 0o600 });
      } catch (e) {
        if (!warned) console.error(`audit: cannot write ${file}: ${(e as Error).message}`);
        warned = true;
      }
    },
  };
}

/** an audit that keeps records in memory (tests) */
export function memoryAudit(): Audit & { records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  return { records, write: (r) => void records.push(r) };
}
