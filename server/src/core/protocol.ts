// The assistant's WebSocket protocol (`/assistant/ws`): JSON messages with a `type`. The browser plugin
// (src/plugins/assistant) imports these types, so this file must stay dependency-free and type-only at run time.
// See docs/design/voice-assistant.md §2.2 and docs/assistant.md.

/** where a request came from: a screen (the JARVIS panel: the person can see the building and click) or a speaker
 * (voice only, e.g. a future room satellite: no clicks, so confirmations are spoken) */
export type Surface = 'screen' | 'speaker';

/** what the viewer shows when the person speaks (sent with `hello` and each `say`) */
export interface ViewContext {
  /** the walker's room id, if any */
  room?: string | null;
  /** the selected subject ('pins:hvac.air-handler', 'fixture:kitchen.pendant.1', …) */
  selected?: string | null;
  /** the storey shown, if the viewer knows */
  storey?: string | null;
}

// ------------------------------------------------------------------------------------------------ client → server

/** the credential a hello carries (docs/assistant.md, "Authentication"): an access code from the server's clients file
 * (`<name>:<secret>`), or the person's own Home Assistant access token */
export type HelloAuth = { type: 'secret'; secret: string } | { type: 'ha'; token: string };

export interface HelloMsg {
  type: 'hello';
  /** a stable id for this browser tab (so a reconnect keeps its pending confirmations) */
  clientId: string;
  /** checked before anything else; a hello without a good one is answered with an error and the socket closed (4401).
   * The surface (screen / speaker) comes from the server's configuration for this credential, never from the client. */
  auth: HelloAuth;
  /** `viewer`: can run view.command; `tts`: will speak replies */
  capabilities: ('viewer' | 'tts')[];
  view?: ViewContext;
}

export interface SayMsg {
  type: 'say';
  text: string;
  /** typed in the panel, or transcribed from the talk button */
  source: 'typed' | 'voice';
  view?: ViewContext;
}

export interface InterruptMsg {
  type: 'interrupt';
}

export interface ConfirmReplyMsg {
  type: 'confirm.reply';
  id: string;
  approved: boolean;
}

export interface ViewResultMsg {
  type: 'view.result';
  id: string;
  ok: boolean;
  detail?: string;
}

/** start a new conversation (the panel's "New conversation") */
export interface ResetMsg {
  type: 'reset';
}

export type ClientMsg = HelloMsg | SayMsg | InterruptMsg | ConfirmReplyMsg | ViewResultMsg | ResetMsg;

// ------------------------------------------------------------------------------------------------ server → client

export type ToolStatus = 'running' | 'done' | 'refused' | 'pending' | 'error';

/** one line of the rolling transcript */
export type TranscriptEntry =
  | { kind: 'user'; turnId: string; text: string; source: 'typed' | 'voice'; surface: Surface; at: number }
  | { kind: 'assistant'; turnId: string; text: string; at: number }
  | {
      kind: 'tool';
      turnId: string;
      callId: string;
      name: string;
      summary: string;
      status: ToolStatus;
      /** the subject the chip links to, so a replayed chip stays clickable */
      subject?: string;
      at: number;
    }
  | { kind: 'divider'; text: string; at: number };

export interface WelcomeMsg {
  type: 'welcome';
  /** the last turns, so a reload or a second screen catches up */
  transcript: TranscriptEntry[];
  status: AssistantState;
  /** what the server runs (shown in the panel's footer): 'claude-opus-5', 'scripted', … */
  agent: string;
  /** whether POST /assistant/transcribe is configured */
  transcribe: boolean;
  /** 'mock' or 'live' Home Assistant */
  ha: 'mock' | 'live';
  /** who the server took this connection for */
  user: { name: string };
  /** for `Authorization: Bearer <ticket>` on POST /transcribe: bound to this user and connection, dies with the
   * connection or after 10 minutes; a fresh one comes in a `ticket` message before then */
  ticket: string;
}

/** a fresh /transcribe ticket (the last one keeps working until it expires) */
export interface TicketMsg {
  type: 'ticket';
  ticket: string;
}

export type AssistantState = 'idle' | 'thinking' | 'error';

export interface StatusMsg {
  type: 'status';
  state: AssistantState;
  detail?: string;
}

export interface TurnStartMsg {
  type: 'turn.start';
  turnId: string;
  text: string;
  source: 'typed' | 'voice';
  surface: Surface;
}

export interface TextDeltaMsg {
  type: 'text.delta';
  turnId: string;
  delta: string;
}

export interface ToolMsg {
  type: 'tool';
  turnId: string;
  /** the same id for the running → done/refused/… updates of one call */
  callId: string;
  /** the tool's short name: 'ha_act', 'view_fly', 'WebSearch', … */
  name: string;
  /** one human line: "Turning off Kitchen pendants" */
  summary: string;
  status: ToolStatus;
  /** a subject the chip links to (click: fly there), if any */
  subject?: string;
}

export interface ConfirmRequestMsg {
  type: 'confirm.request';
  id: string;
  /** the ha_act call (ToolMsg.callId) this confirmation belongs to, so the panel can tie the dialog to its chip */
  callId?: string;
  /** "Set the Hall thermostat to 72 °F" */
  summary: string;
  /** the exact call: "climate.set_temperature on climate.hall { temperature: 72 }" */
  detail: string;
  risk: 'normal' | 'high';
  /** epoch ms, the server's clock */
  expiresAt: number;
  /** ms left when this was sent: a client counts down from its own receipt time (its clock may be off) */
  ttlMs: number;
}

export interface ConfirmResolvedMsg {
  type: 'confirm.resolved';
  id: string;
  outcome: 'approved' | 'denied' | 'expired' | 'failed';
  detail?: string;
}

export type ViewOp = 'fly' | 'highlight' | 'layer' | 'clear';

export interface ViewCommandMsg {
  type: 'view.command';
  id: string;
  op: ViewOp;
  /** fly: { subject }; highlight: { subjects, seconds }; layer: { layer, on? }; clear: {} */
  args: { subject?: string; subjects?: string[]; seconds?: number; layer?: string; on?: boolean };
}

export interface TurnEndMsg {
  type: 'turn.end';
  turnId: string;
  /** set when the turn failed (rate limit, the agent crashed, interrupted) */
  error?: string;
  interrupted?: boolean;
}

export interface ErrorMsg {
  type: 'error';
  message: string;
}

export type ServerMsg =
  | WelcomeMsg
  | TicketMsg
  | StatusMsg
  | TurnStartMsg
  | TextDeltaMsg
  | ToolMsg
  | ConfirmRequestMsg
  | ConfirmResolvedMsg
  | ViewCommandMsg
  | TurnEndMsg
  | ErrorMsg;

/** WebSocket close codes the server uses: 4401 the credential was refused (don't retry with it), 4429 too many failed
 * logins from this address (retry later) */
export type CloseCode = 4401 | 4429;

/** the reply of POST /assistant/transcribe */
export interface TranscribeReply {
  text: string;
}
