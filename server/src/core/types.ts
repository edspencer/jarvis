// The contracts between the server's parts: the Home Assistant backend, the policy gate, the tools and the agent.
// Everything under src/core is plain TypeScript with no npm dependencies (Node built-ins only), so the root project's
// unit tests can run it without installing the server; the SDK, ws and yaml are used only outside core/.
import type { HaIdentity } from './auth.ts';
import type { Surface, ViewContext, ViewOp } from './protocol.ts';

// ------------------------------------------------------------------------------------------------ Home Assistant

/** Home Assistant's state object (the shape the viewer's store uses too) */
export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown> & { friendly_name?: string; device_class?: string; area?: string };
  last_changed?: string;
}

export interface HaHistoryPoint {
  state: string;
  /** ISO time */
  at: string;
}

/** Where the assistant reads and acts. Only the gate (core/gate.ts) may call callService. */
export interface HaBackend {
  readonly kind: 'mock' | 'live';
  /** current states; all of them without ids */
  states(ids?: readonly string[]): Promise<HaState[]>;
  history(entityId: string, from: Date, to: Date): Promise<HaHistoryPoint[]>;
  /** one service call; entity_id is always a list of entities in `domain` */
  callService(domain: string, service: string, data: { entity_id: string[] } & Record<string, unknown>): Promise<void>;
  /** who a person's own access token belongs to (the `ha` login, core/auth.ts): null if HA refuses it; throws if HA
   * can't be asked. Never the assistant's own connection or token. */
  currentUser(token: string): Promise<HaIdentity | null>;
  close?(): void;
}

// ------------------------------------------------------------------------------------------------ the gate

/** who and where a request comes from (the turn's) */
export interface ActContext {
  surface: Surface;
  /** the owner key of the tab or satellite the turn came from: its user and client id (confirmations go back to it
   * alone, and only it may answer them) */
  clientId: string;
  /** the authenticated user's name, for the audit log */
  user?: string;
  /** what the person said, for the audit log */
  utterance?: string;
}

/** what the model asked for through ha_act */
export interface ActRequest {
  entity_ids: string[];
  /** 'turn_on', 'set_temperature', … (the domain is each entity's own) */
  service: string;
  data?: Record<string, unknown>;
}

export type Tier = 'allow' | 'confirm' | 'deny';

/** The gate's answer to the model, after the policy (and, for `confirm`, the person) decided. */
export type ActOutcome =
  | { status: 'done'; summary: string }
  | { status: 'refused'; reason: string }
  | { status: 'denied'; summary: string } // the person said no
  | { status: 'expired'; summary: string } // nobody answered within the TTL
  | { status: 'failed'; summary: string; error: string }; // Home Assistant said no

/** a parked `confirm` action, as the hub shows it to the person */
export interface PendingAction {
  id: string;
  clientId: string;
  surface: Surface;
  summary: string;
  detail: string;
  risk: 'normal' | 'high';
  expiresAt: number;
}

// ------------------------------------------------------------------------------------------------ tools

/** a parameter of a tool, in a tiny schema that agent.ts turns into zod (core stays dependency-free) */
export type ParamSpec =
  | { type: 'string'; description: string; optional?: boolean; enum?: readonly string[] }
  | { type: 'number'; description: string; optional?: boolean; min?: number; max?: number }
  | { type: 'boolean'; description: string; optional?: boolean }
  | { type: 'string[]'; description: string; optional?: boolean }
  | { type: 'object'; description: string; optional?: boolean };

/** the turn a tool call belongs to */
export interface TurnInfo {
  turnId: string;
  /** the owner key: `<user key>/<client id>` (hub.ts), so another user can't act as this client */
  clientId: string;
  /** who is talking (the authenticated user's name) */
  user: string;
  surface: Surface;
  text: string;
  view?: ViewContext;
  /** the client can run view commands */
  viewer: boolean;
}

/** what a tool call needs from the hub */
export interface ToolEnv {
  turn: TurnInfo;
  /** send a view command to the turn's client and wait for its result (rejects: no viewer / timeout) */
  view(op: ViewOp, args: Record<string, unknown>): Promise<{ ok: boolean; detail?: string }>;
  /** tell the panel what this call is doing (a chip), and optionally the subject it's about */
  activity(summary: string, status: 'running' | 'done' | 'refused' | 'pending' | 'error', subject?: string): void;
}

export interface ToolSpec {
  /** [a-z_]+; the SDK exposes it as mcp__house__<name> */
  name: string;
  description: string;
  params: Record<string, ParamSpec>;
  /** read-only tools may run in parallel; the SDK annotation */
  readOnly?: boolean;
  /** the result is text for the model (objects are JSON-stringified) */
  run(args: Record<string, unknown>, env: ToolEnv): Promise<string | object>;
}

// ------------------------------------------------------------------------------------------------ the agent

/** what an agent reports while it runs a turn */
export type AgentEvent =
  | { type: 'text'; delta: string }
  /** a built-in tool (WebSearch, Read…) the hub has no ToolSpec for; house tools report through ToolEnv.activity */
  | { type: 'tool'; callId: string; name: string; summary: string; status: 'running' | 'done' | 'error' }
  | { type: 'done'; error?: string; interrupted?: boolean };

/** The house tools, bound to one turn by the hub: each call gets its own ToolEnv (a chip of its own, the turn's
 * client for view commands and confirmations), is audited, and never throws (an error becomes the result text). */
export interface ToolRunner {
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }>;
}

/** One rolling conversation. The hub serialises turns: run() is never called while another turn runs. */
export interface Agent {
  /** 'claude-opus-5' or 'scripted' */
  readonly name: string;
  /** run one turn; `tools` are bound to this turn (their ToolEnv knows the client) */
  run(prompt: string, turn: TurnInfo, emit: (e: AgentEvent) => void, tools: ToolRunner): Promise<void>;
  interrupt(): Promise<void>;
  /** start a new session (the old one's transcript stays in the hub) */
  reset(): Promise<void>;
  close(): Promise<void>;
}
