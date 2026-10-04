// The panel's transcript as a pure reducer: server messages (and the few things the page adds itself: a message being
// sent, a local note) in, a new state out. No DOM, so it is unit-tested; the panel only draws it.
import type {
  AssistantState,
  ServerMsg,
  Surface,
  ToolStatus,
  TranscriptEntry,
} from '../../../server/src/core/protocol.ts';

export type Entry =
  | {
      kind: 'user';
      id: string;
      /** '' while it's only been sent (no turn.start yet) */
      turnId: string;
      text: string;
      source: 'typed' | 'voice';
      surface: Surface;
      pending?: boolean;
    }
  | { kind: 'assistant'; id: string; turnId: string; text: string; streaming: boolean }
  | {
      kind: 'tool';
      id: string;
      turnId: string;
      callId: string;
      name: string;
      summary: string;
      status: ToolStatus;
      subject?: string;
    }
  | { kind: 'divider'; id: string; text: string }
  | { kind: 'note'; id: string; text: string; tone: 'bad' | 'off' };

export interface TranscriptState {
  entries: Entry[];
  /** the turn being answered, or null */
  turn: string | null;
  status: AssistantState;
  /** from welcome: what the server runs, whether it transcribes, mock or live Home Assistant */
  agent: string;
  transcribe: boolean;
  ha: 'mock' | 'live' | null;
  /** id counter for local entries */
  seq: number;
}

/** what the page adds itself */
export type LocalMsg =
  | { type: 'local.say'; text: string; source: 'typed' | 'voice' }
  | { type: 'local.note'; text: string; tone?: 'bad' | 'off' }
  | { type: 'local.divider'; text: string };

/** the most entries kept (the server keeps the real history) */
export const MAX_ENTRIES = 400;

export const initialTranscript = (): TranscriptState => ({
  entries: [],
  turn: null,
  status: 'idle',
  agent: '',
  transcribe: false,
  ha: null,
  seq: 0,
});

function fromServer(e: TranscriptEntry, i: number): Entry {
  const id = `w${i}`;
  switch (e.kind) {
    case 'user':
      return { kind: 'user', id, turnId: e.turnId, text: e.text, source: e.source, surface: e.surface };
    case 'assistant':
      return { kind: 'assistant', id, turnId: e.turnId, text: e.text, streaming: false };
    case 'tool':
      return {
        kind: 'tool',
        id,
        turnId: e.turnId,
        callId: e.callId,
        name: e.name,
        summary: e.summary,
        status: e.status,
        subject: e.subject,
      };
    default:
      return { kind: 'divider', id, text: e.text };
  }
}

const cap = (es: Entry[]) => (es.length > MAX_ENTRIES ? es.slice(es.length - MAX_ENTRIES) : es);

/** apply one message; returns the same object when nothing changed */
export function reduce(s: TranscriptState, m: ServerMsg | LocalMsg): TranscriptState {
  const nextId = () => `l${s.seq + 1}`;
  const push = (e: Entry, extra: Partial<TranscriptState> = {}): TranscriptState => ({
    ...s,
    ...extra,
    seq: s.seq + 1,
    entries: cap([...s.entries, e]),
  });
  const replace = (i: number, e: Entry, extra: Partial<TranscriptState> = {}): TranscriptState => {
    const entries = s.entries.slice();
    entries[i] = e;
    return { ...s, ...extra, entries };
  };
  switch (m.type) {
    case 'welcome':
      return {
        ...s,
        entries: cap(m.transcript.map(fromServer)),
        turn: null,
        status: m.status,
        agent: m.agent,
        transcribe: m.transcribe,
        ha: m.ha,
      };
    case 'status':
      return m.state === s.status ? s : { ...s, status: m.state };
    case 'turn.start': {
      // a message this page sent shows at once (pending); its turn.start confirms it in place
      const i = s.entries.findIndex((e) => e.kind === 'user' && e.pending && e.text.trim() === m.text.trim());
      const user: Entry = {
        kind: 'user',
        id: i >= 0 ? s.entries[i].id : nextId(),
        turnId: m.turnId,
        text: m.text,
        source: m.source,
        surface: m.surface,
      };
      if (i >= 0) return replace(i, user, { turn: m.turnId, status: 'thinking' });
      if (s.entries.some((e) => e.kind === 'user' && e.turnId === m.turnId)) return { ...s, turn: m.turnId };
      return m.text ? push(user, { turn: m.turnId, status: 'thinking' }) : { ...s, turn: m.turnId };
    }
    case 'text.delta': {
      if (!m.delta) return s;
      // text after a tool chip starts a new paragraph below it; otherwise it grows the turn's last paragraph
      const last = s.entries.length - 1;
      const e = s.entries[last];
      if (e && e.kind === 'assistant' && e.turnId === m.turnId)
        return replace(last, { ...e, text: e.text + m.delta, streaming: true });
      return push({ kind: 'assistant', id: nextId(), turnId: m.turnId, text: m.delta, streaming: true });
    }
    case 'tool': {
      const i = s.entries.findIndex((e) => e.kind === 'tool' && e.callId === m.callId);
      const e: Entry = {
        kind: 'tool',
        id: i >= 0 ? s.entries[i].id : nextId(),
        turnId: m.turnId,
        callId: m.callId,
        name: m.name,
        summary: m.summary,
        status: m.status,
        subject: m.subject ?? (i >= 0 ? (s.entries[i] as Extract<Entry, { kind: 'tool' }>).subject : undefined),
      };
      return i >= 0 ? replace(i, e) : push(e);
    }
    case 'turn.end': {
      const entries = s.entries.map((e) =>
        e.kind === 'assistant' && e.turnId === m.turnId && e.streaming ? { ...e, streaming: false } : e,
      );
      const next: TranscriptState = { ...s, entries, turn: s.turn === m.turnId ? null : s.turn, status: 'idle' };
      const note = m.interrupted ? 'Stopped.' : m.error ? `That turn failed: ${m.error}` : '';
      if (!note) return next;
      return {
        ...next,
        seq: s.seq + 1,
        entries: cap([...entries, { kind: 'note', id: nextId(), text: note, tone: m.interrupted ? 'off' : 'bad' }]),
      };
    }
    case 'error':
      return push({ kind: 'note', id: nextId(), text: m.message, tone: 'bad' });
    case 'local.say':
      return push({
        kind: 'user',
        id: nextId(),
        turnId: '',
        text: m.text,
        source: m.source,
        surface: 'screen',
        pending: true,
      });
    case 'local.note':
      return push({ kind: 'note', id: nextId(), text: m.text, tone: m.tone || 'off' });
    case 'local.divider':
      return push({ kind: 'divider', id: nextId(), text: m.text });
    default:
      // confirm.*, view.command: handled by the plugin, not the transcript
      return s;
  }
}
