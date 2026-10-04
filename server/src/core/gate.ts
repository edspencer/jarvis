// The gate: the ONLY place in the server that calls HaBackend.callService or HaBackend.respond (design §5.3). ha_act
// hands it the model's request and the turn's context; the gate reads fresh states, asks the policy (policy.ts) and then
//   - allow:   makes the call(s) and reports done / failed;
//   - confirm: parks the action (confirm.ts), tells the hub through onPending (which shows the dialog on the client the
//              request came from) and resolves when that person answers (reply / spoken) or the TTL passes;
//   - deny:    refuses; nothing reaches HA.
// The model can never approve anything: there is deliberately no API that takes the model's word. Approval comes only
// from reply() (a click in that client's dialog) or spoken() (the server's own whole-utterance match of the person's
// next words; the hub must route only the person's words there, never the assistant's). Data like `confirmed: true` is
// just an unknown key the policy refuses, and a repeated act() parks a new action rather than approving the old one.
// On approval the policy is evaluated again against fresh states (it or the house may have changed meanwhile).
//
// read(): the read-only response services (READ_SERVICES, e.g. weather.get_forecasts) go through their own path: a
// built-in list in this file, not the policy, so a deny-all policy still reads the forecast and no policy file can add
// to the list; only HaBackend.respond, never callService. act() refuses them, and can never ask for a response.
//
// max_minutes: after a timed run (turn_on, open_valve, …) the gate schedules the matching off call. The timer lives in
// this process: a server restart loses it and the thing stays on. TODO: persist timers, or hand them to HA (a timer
// helper / automation owned by the assistant's user).
import type {
  ActContext,
  ActOutcome,
  ActRequest,
  HaBackend,
  HaState,
  PendingAction,
  ReadOutcome,
  Tier,
} from './types.ts';
import type { Surface } from './protocol.ts';
import { createConfirmStore, matchSpoken, DEFAULT_TTL_MS } from './confirm.ts';
import type { Parked } from './confirm.ts';
import { describeCalls, describeRequest, domainOf, evaluatePolicy, requestProblem } from './policy.ts';
import type { Evaluation, Policy, PlannedTimer } from './policy.ts';

/**
 * The read-only response services gate.read may call, and the exact data each takes (every key, one of its values).
 * Built in, deliberately: the policy file has no key for them and no rule widens this list; each returns data and
 * changes nothing (Home Assistant documents weather.get_forecasts as returning forecasts, with no side effects).
 * Adding one is a code change and a review, not a configuration edit.
 */
export const READ_SERVICES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = deepFreeze({
  'weather.get_forecasts': { type: ['daily', 'hourly'] },
});

export type ResolvedOutcome = 'approved' | 'denied' | 'expired' | 'failed';

/** one line of the audit log: every decision the gate makes (writing it somewhere is the caller's job) */
export interface AuditRecord {
  /** ISO time */
  at: string;
  /** act: ha_act's path (the policy); read: a read-only response service (READ_SERVICES) */
  kind: 'act' | 'read';
  clientId: string;
  /** the authenticated user's name */
  user?: string;
  surface: Surface;
  utterance?: string;
  request: ActRequest;
  tier: Tier;
  /** what happened: an ActOutcome status, `pending` when parked, `timer` lines are the max_minutes off calls */
  outcome: ActOutcome['status'] | 'pending';
  reason: string;
  /** the parked action's id, for pending and its resolution */
  pendingId?: string;
  /** the exact call(s) */
  detail?: string;
  /** set on the automatic off call of a timed run */
  timer?: true;
}

export interface GateOptions {
  policy: Policy;
  backend: HaBackend;
  /** how long a confirmation waits (30 s) */
  ttlMs?: number;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** a confirm action was parked: show it to its client */
  onPending(p: PendingAction): void;
  /** a parked action was settled: close the dialog (detail: why it failed / was refused / cancelled) */
  onResolved(id: string, outcome: ResolvedOutcome, detail?: string): void;
  audit?(record: AuditRecord): void;
}

export interface Gate {
  /** evaluate, then: allow → call HA; confirm → park, notify via onPending, and resolve when the person answers or the
   * TTL passes; deny → refused */
  act(req: ActRequest, ctx: ActContext): Promise<ActOutcome>;
  /** a read-only response service from READ_SERVICES, whatever the policy says: its response, or refused / failed */
  read(req: ActRequest, ctx: ActContext): Promise<ReadOutcome>;
  /** dry run (no side effects): the tier and reason, for ha_find to show and for tests */
  evaluate(req: ActRequest, ctx: ActContext): Promise<{ tier: Tier; reason: string; summary: string }>;
  /** a click in the confirm dialog: only the client the request was sent to, only once, only before expiry */
  reply(id: string, clientId: string, approved: boolean): { ok: true } | { ok: false; reason: string };
  /** a server-matched spoken yes/no for that client's pending action (only when exactly one is pending for it); true
   * if consumed */
  spoken(clientId: string, text: string): boolean;
  /** interrupt / disconnect: deny the client's pending actions (all, without a client id) */
  cancel(clientId?: string): void;
  pending(clientId?: string): PendingAction[];
  setPolicy(p: Policy): void;
}

interface ParkedAction {
  req: ActRequest;
  ctx: ActContext;
  summary: string;
  detail: string;
  risk: 'normal' | 'high';
  resolve(o: ActOutcome): void;
}

/** a scheduled off call; entities drop out when something else switches them meanwhile */
interface OffTimer {
  plan: PlannedTimer;
  ids: Set<string>;
  handle: unknown;
  ctx: ActContext;
}

export function createGate(opts: GateOptions): Gate {
  let policy = opts.policy;
  const { backend } = opts;
  const now = opts.now ?? Date.now;
  const setT = opts.setTimeout ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clearT = opts.clearTimeout ?? ((h: unknown) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));
  const offTimers = new Map<string, OffTimer>(); // entity → its pending off call

  const audit = (r: Omit<AuditRecord, 'at' | 'kind'> & { kind?: AuditRecord['kind'] }) => {
    try {
      opts.audit?.({ at: new Date(now()).toISOString(), kind: 'act', ...r });
    } catch {
      // the audit sink failing must not change what happens
    }
  };

  const store = createConfirmStore<ParkedAction>({
    ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
    now,
    setTimeout: setT,
    clearTimeout: clearT,
    onExpire: (e) =>
      finish(e, 'expired', { status: 'expired', summary: e.value.summary }, 'confirm', 'nobody answered'),
  });

  /** settle a parked action: tell the hub, log, and answer the waiting act() */
  function finish(e: Parked<ParkedAction>, how: ResolvedOutcome, o: ActOutcome, tier: Tier, why: string) {
    const { req, ctx, detail } = e.value;
    try {
      opts.onResolved(e.id, how, how === 'approved' ? undefined : why);
    } catch {}
    audit({ ...who(ctx), request: req, tier, outcome: o.status, reason: why, pendingId: e.id, detail });
    e.value.resolve(o);
  }

  const who = (ctx: ActContext) => ({
    clientId: ctx.clientId,
    ...(ctx.user ? { user: ctx.user } : {}),
    surface: ctx.surface,
    utterance: ctx.utterance,
  });

  /** read fresh states and ask the current policy */
  async function decide(
    req: ActRequest,
    ctx: ActContext,
  ): Promise<{ ev: Evaluation; summary: string; states: Map<string, HaState> }> {
    const states = new Map<string, HaState>();
    const problem = contextProblem(ctx) ?? requestProblem(req) ?? readServiceProblem(req);
    if (problem) return { ev: refusal(problem), summary: 'Invalid request', states };
    let ev: Evaluation;
    try {
      for (const s of await backend.states(req.entity_ids))
        if (s && typeof s.entity_id === 'string') states.set(s.entity_id, s);
      ev = evaluatePolicy(policy, req, { surface: ctx.surface, states });
    } catch (err) {
      ev = refusal(`couldn't read Home Assistant states: ${message(err)}`);
    }
    return { ev, summary: describeRequest(req, states, sharedMinutes(ev)), states };
  }

  /** make the planned calls (stopping at the first failure), then schedule the timed runs' off calls */
  async function run(ev: Evaluation, summary: string, ctx: ActContext): Promise<ActOutcome> {
    const tried = new Set<string>();
    let error: string | null = null;
    for (const c of ev.calls) {
      for (const id of c.data.entity_id) tried.add(id);
      try {
        await backend.callService(c.domain, c.service, { ...c.data, entity_id: [...c.data.entity_id] });
      } catch (err) {
        error = message(err);
        break;
      }
      for (const id of c.data.entity_id) unschedule(id);
    }
    // every entity a call was attempted on gets its off call, whatever the outcome: a call that failed or timed out
    // may still have switched it on, and an off call on something that is off is harmless
    for (const t of ev.timers) {
      const ids = t.entity_ids.filter((id) => tried.has(id));
      if (ids.length) schedule({ ...t, entity_ids: ids }, ctx);
    }
    return error === null ? { status: 'done', summary } : { status: 'failed', summary, error };
  }

  function unschedule(id: string) {
    const t = offTimers.get(id);
    if (!t) return;
    offTimers.delete(id);
    t.ids.delete(id);
    if (!t.ids.size) clearT(t.handle);
  }

  function schedule(plan: PlannedTimer, ctx: ActContext) {
    for (const id of plan.entity_ids) unschedule(id); // the new run's timer replaces any earlier one
    const t: OffTimer = { plan, ids: new Set(plan.entity_ids), handle: undefined, ctx };
    t.handle = setT(() => void fire(t), plan.minutes * 60_000);
    for (const id of plan.entity_ids) offTimers.set(id, t);
  }

  async function fire(t: OffTimer) {
    const ids = [...t.ids];
    for (const id of ids) offTimers.delete(id);
    if (!ids.length) return;
    const { domain, service, minutes } = t.plan;
    const request: ActRequest = { entity_ids: ids, service };
    const detail = `${domain}.${service} on ${ids.join(', ')}`;
    const base = { ...who(t.ctx), request, tier: 'allow' as Tier, detail, timer: true as const };
    try {
      await backend.callService(domain, service, { entity_id: ids });
      audit({ ...base, outcome: 'done', reason: `max_minutes: ${minutes} min are up` });
    } catch (err) {
      audit({ ...base, outcome: 'failed', reason: `max_minutes off call failed: ${message(err)}` });
    }
  }

  async function approved(e: Parked<ParkedAction>) {
    // the person said yes to what they saw; the policy (and the house) get a fresh say before anything happens
    const { req, ctx } = e.value;
    let ev: Evaluation;
    let summary = e.value.summary;
    try {
      ({ ev, summary } = await decide(req, ctx));
    } catch (err) {
      ev = refusal(message(err));
    }
    if (ev.tier === 'deny') {
      const reason = `no longer allowed: ${ev.reason}`;
      return finish(e, 'failed', { status: 'refused', reason }, 'deny', reason);
    }
    const o = await run(ev, summary, ctx);
    if (o.status === 'done') finish(e, 'approved', o, ev.tier, 'approved by the person');
    else finish(e, 'failed', o, ev.tier, o.status === 'failed' ? o.error : 'failed');
  }

  const gate: Gate = {
    async act(req, ctx) {
      // a snapshot: what is approved later is exactly what was evaluated and shown, whatever the caller's object does
      const snap = snapshot(req);
      const { ev, summary } = await decide(snap, ctx);
      const detail = describeCalls(ev.calls, ev.timers);
      const base = { ...who(ctx), request: snap, tier: ev.tier, detail };
      if (ev.tier === 'deny') {
        audit({ ...base, outcome: 'refused', reason: ev.reason });
        return { status: 'refused', reason: ev.reason };
      }
      if (ev.tier === 'allow') {
        const o = await run(ev, summary, ctx);
        audit({ ...base, outcome: o.status, reason: o.status === 'failed' ? o.error : ev.reason });
        return o;
      }
      return new Promise<ActOutcome>((resolve) => {
        const e = store.park(ctx.clientId, { req: snap, ctx: { ...ctx }, summary, detail, risk: ev.risk, resolve });
        audit({ ...base, outcome: 'pending', reason: ev.reason, pendingId: e.id });
        try {
          opts.onPending(toPending(e));
        } catch {}
      });
    },

    async read(req, ctx) {
      const snap = snapshot(req);
      const base = { ...who(ctx), kind: 'read' as const, request: snap };
      const refuse = (reason: string): ReadOutcome => {
        audit({ ...base, tier: 'deny', outcome: 'refused', reason });
        return { status: 'refused', reason };
      };
      const problem = contextProblem(ctx) ?? requestProblem(snap) ?? readProblem(snap);
      if (problem) return refuse(problem);
      const domain = domainOf(snap.entity_ids[0]);
      const known = new Set<string>();
      try {
        for (const s of await backend.states(snap.entity_ids))
          if (s && typeof s.entity_id === 'string') known.add(s.entity_id);
      } catch (err) {
        return refuse(`couldn't read Home Assistant states: ${message(err)}`);
      }
      const unknown = snap.entity_ids.filter((id) => !known.has(id));
      if (unknown.length) return refuse(`${unknown.join(', ')}: not a known entity`);
      const data = { ...snap.data, entity_id: [...snap.entity_ids] };
      const detail = describeCalls([{ domain, service: snap.service, data }]);
      const reason = `read-only service ${domain}.${snap.service}`;
      try {
        const response = await backend.respond(domain, snap.service, data);
        audit({ ...base, tier: 'allow', outcome: 'done', reason, detail });
        return { status: 'done', response };
      } catch (err) {
        audit({ ...base, tier: 'allow', outcome: 'failed', reason: message(err), detail });
        return { status: 'failed', error: message(err) };
      }
    },

    async evaluate(req, ctx) {
      const { ev, summary } = await decide(snapshot(req), ctx);
      return { tier: ev.tier, reason: ev.reason, summary };
    },

    reply(id, clientId, approve) {
      const r = store.take(id, clientId);
      if (!r.ok) return r;
      if (approve === true) void approved(r.entry);
      else
        finish(
          r.entry,
          'denied',
          { status: 'denied', summary: r.entry.value.summary },
          'confirm',
          'the person said no',
        );
      return { ok: true };
    },

    spoken(clientId, text) {
      const m = matchSpoken(text);
      if (!m) return false;
      const mine = store.list(clientId);
      if (mine.length !== 1) return false; // none, or several: don't guess which one the yes is for
      return gate.reply(mine[0].id, clientId, m === 'yes').ok;
    },

    cancel(clientId) {
      for (const e of store.drain(clientId))
        finish(e, 'denied', { status: 'denied', summary: e.value.summary }, 'confirm', 'cancelled');
    },

    pending(clientId) {
      return store.list(clientId).map(toPending);
    },

    setPolicy(p) {
      policy = p;
    },
  };
  return gate;
}

const toPending = (e: Parked<ParkedAction>): PendingAction => ({
  id: e.id,
  clientId: e.clientId,
  surface: e.value.ctx.surface,
  summary: e.value.summary,
  detail: e.value.detail,
  risk: e.value.risk,
  expiresAt: e.expiresAt,
});

const refusal = (reason: string): Evaluation => ({
  tier: 'deny',
  reason,
  risk: 'normal',
  entities: [],
  calls: [],
  timers: [],
});

function contextProblem(ctx: ActContext): string | null {
  if (!ctx || typeof ctx.clientId !== 'string' || !ctx.clientId) return 'no client';
  if (ctx.surface !== 'screen' && ctx.surface !== 'speaker') return 'unknown surface';
  return null;
}

const readKey = (domain: string, service: string) => {
  const k = `${domain}.${service}`;
  return Object.hasOwn(READ_SERVICES, k) ? k : null;
};

/** act(): a read-only service is never an action (whatever the policy allows) */
function readServiceProblem(req: ActRequest): string | null {
  for (const d of new Set(req.entity_ids.map(domainOf))) {
    const k = readKey(d, req.service);
    if (k) return `${k} returns data and changes nothing: use the read tool for it, not ha_act`;
  }
  return null;
}

/** read(): null if this is a READ_SERVICES call with exactly its data, else why not (the request is well formed) */
function readProblem(req: ActRequest): string | null {
  const domain = domainOf(req.entity_ids[0]);
  const k = readKey(domain, req.service);
  if (!k) return `${domain}.${req.service} is not a read-only service (only ${Object.keys(READ_SERVICES).join(', ')})`;
  const other = req.entity_ids.find((id) => domainOf(id) !== domain);
  if (other) return `${other} is not in ${domain}`;
  const spec = READ_SERVICES[k];
  const data = req.data ?? {};
  for (const key of Object.keys(data))
    if (!Object.hasOwn(spec, key)) return `${key} is not allowed in the data for ${k}`;
  for (const [key, values] of Object.entries(spec)) {
    const v = data[key];
    if (typeof v !== 'string' || !values.includes(v))
      return `${k} needs ${key}: ${values.join(' or ')} (got ${typeof v === 'string' ? JSON.stringify(v) : v === undefined ? 'none' : typeof v})`;
  }
  return null;
}

/** the minutes of a timed run, when every timed entity shares them (for the summary) */
function sharedMinutes(ev: Evaluation | undefined): number | undefined {
  const ms = new Set(ev?.timers.map((t) => t.minutes));
  return ms.size === 1 ? [...ms][0] : undefined;
}

/** a deep, frozen copy of the request's plain data (anything that isn't JSON-able fails validation anyway) */
function snapshot(req: ActRequest): ActRequest {
  try {
    return deepFreeze(structuredClone(req));
  } catch {
    return { entity_ids: [], service: '' };
  }
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
