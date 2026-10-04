// The mock assistant (?assistant=mock): an in-page fake server that speaks the real protocol (server/src/core/
// protocol.ts) from a few scripts, so the panel, confirmations, viewer commands and voice flow can be seen and tested
// with no server, no network, no audio and no model. Deterministic: the same words give the same messages with the
// same timings. The e2e test (tests/e2e/assistant.spec.ts) drives the UI through it.
//
// The scripts, by keyword in what was said (matchScript, unit-tested):
//   "unlock the front door"           a refused tool chip and why
//   "set the thermostat to 72"        a pending chip and confirm.request; approve → done, deny → "OK, I won't."
//   "close the garage"                the same
//   "highlight the hvac"              view.command highlight
//   "hide the furniture"              view.command layer
//   "show me / where is the …"        view.command fly to a demo-house subject, waits for view.result, then answers
//   "turn off the kitchen lights"     a tool chip running → done and a streamed answer
//   anything else                     a generic streamed answer
// The subjects are the demo house's (examples/demo-site/registry_pins.json); on another site a fly fails cleanly.
import type {
  ClientMsg,
  ConfirmResolvedMsg,
  HelloMsg,
  ServerMsg,
  ToolStatus,
  ViewCommandMsg,
} from '../../../server/src/core/protocol.ts';
import type { ConnState, Transport } from './transport';

/** things the mock knows where they are (the demo house's registry pins) */
export const MOCK_THINGS: { re: RegExp; subject: string; name: string; where: string }[] = [
  {
    re: /\bair[- ]?handler|\bahu\b|\bfurnace\b/,
    subject: 'pins:hvac.air-handler',
    name: 'Air handler',
    where: 'in the hall',
  },
  {
    re: /\bwater heater|\bhot water|\bboiler\b/,
    subject: 'pins:plumb.water-heater',
    name: 'Water heater',
    where: 'in the kitchen',
  },
  { re: /\bthermostat\b/, subject: 'pins:hvac.thermostat', name: 'Thermostat', where: 'in the hall' },
  {
    re: /\bconsumer unit|\b(electrical|breaker) panel|\bfuse ?box|\bbreakers?\b/,
    subject: 'pins:elec.panel',
    name: 'Consumer unit',
    where: 'in the hall',
  },
  { re: /\brouter\b|\binternet\b/, subject: 'pins:net.router', name: 'Router', where: 'in the study' },
  {
    re: /\bstopcock\b|\bwater main\b|\bshut-?off\b/,
    subject: 'pins:plumb.stopcock',
    name: 'Main stopcock',
    where: 'in the kitchen',
  },
  { re: /\bfridge\b|\bfreezer\b/, subject: 'pins:appliance.fridge', name: 'Fridge-freezer', where: 'in the kitchen' },
  {
    re: /\bsmoke (alarm|detector)/,
    subject: 'pins:safety.smoke.landing',
    name: 'Smoke alarm',
    where: 'on the landing',
  },
  {
    re: /\bkitchen (pendants?|lights?)\b/,
    subject: 'pins:fixture.kitchen-pendants',
    name: 'Kitchen pendants',
    where: 'over the kitchen island',
  },
];

/** the demo house's view layers and the core view toggles (what view_layer can switch: plugin chips are not layers) */
const LAYERS = ['furniture', 'doors', 'pergola', 'roofs', 'roof', 'ceilings', 'cutaway'];

export type MockScript =
  | { kind: 'refuse'; summary: string; reason: string }
  | { kind: 'confirm'; summary: string; detail: string; done: string; risk: 'normal' | 'high' }
  | { kind: 'highlight'; subjects: string[]; names: string[] }
  | { kind: 'layer'; layer: string; on?: boolean }
  | { kind: 'show'; subject: string; name: string; where: string }
  | { kind: 'light'; on: boolean; name: string; subject?: string }
  | { kind: 'generic' };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** which script answers what was said */
export function matchScript(said: string): MockScript {
  const t = ` ${said
    .toLowerCase()
    .replace(/[^\w\s°'-]/g, ' ')
    .replace(/\s+/g, ' ')} `;
  const things = MOCK_THINGS.filter((x) => x.re.test(t));
  if (/\b(unlock|disarm)\b/.test(t)) {
    const what = /\bdoor\b/.test(t) ? `${/\bback\b/.test(t) ? 'Back' : 'Front'} door` : 'Alarm';
    return {
      kind: 'refuse',
      summary: `${/\bdisarm\b/.test(t) ? 'Disarming' : 'Unlocking'} ${what}`,
      reason: `I can't do that: ${/\bdisarm\b/.test(t) ? 'disarming the alarm' : 'unlocking doors'} is never allowed from the assistant, whoever asks. Home Assistant itself still can.`,
    };
  }
  if (/\bopen (the )?garage\b/.test(t))
    return {
      kind: 'refuse',
      summary: 'Opening Garage door',
      reason: "I can't open the garage: the house's policy only lets me close it, and only with your OK.",
    };
  if (/\bthermostat\b|\bheating\b|\btemperature\b/.test(t) && /\b(set|make|turn (it )?(up|down)|to \d)/.test(t)) {
    const deg = Number(/\b(\d{2})\b/.exec(t)?.[1] ?? 72);
    return {
      kind: 'confirm',
      summary: `Set the Hall thermostat to ${deg} °F`,
      detail: `climate.set_temperature on climate.hall_thermostat { temperature: ${deg} }`,
      done: `Done: the hall thermostat is set to ${deg} °F.`,
      risk: 'normal',
    };
  }
  if (/\bclose (the )?garage\b/.test(t))
    return {
      kind: 'confirm',
      summary: 'Close the Garage door',
      detail: 'cover.close_cover on cover.garage_door',
      done: 'Done: the garage door is closing.',
      risk: 'high',
    };
  if (/\bhighlight\b/.test(t)) {
    const hit = things.length ? things : MOCK_THINGS.filter((x) => x.subject.startsWith('pins:hvac.'));
    return { kind: 'highlight', subjects: hit.map((x) => x.subject), names: hit.map((x) => x.name) };
  }
  const layer = new RegExp(`\\b(hide|toggle|show)( the)? (${LAYERS.join('|')})\\b`).exec(t);
  if (layer)
    return {
      kind: 'layer',
      layer: layer[3],
      on: layer[1] === 'hide' ? false : layer[1] === 'show' ? true : undefined,
    };
  if (things.length && /\b(show|where|find|fly|take me|locate|go to)\b/.test(t)) return { kind: 'show', ...things[0] };
  if (/\b(lights?|lamps?|pendants?)\b/.test(t) && /\b(on|off)\b/.test(t)) {
    const on = /\bon\b/.test(t) && !/\boff\b/.test(t);
    const room = /\b(?:the )?([a-z]+) (?:lights?|lamps?|pendants?)\b/.exec(t)?.[1];
    const kitchen = room === 'kitchen';
    const name = kitchen
      ? 'Kitchen pendants'
      : room && !['the', 'all', 'on', 'off'].includes(room)
        ? `${cap(room)} lights`
        : 'The lights';
    return { kind: 'light', on, name, subject: kitchen ? 'pins:fixture.kitchen-pendants' : undefined };
  }
  return { kind: 'generic' };
}

class Cancelled extends Error {}

interface Run {
  cancelled: boolean;
  cancels: Set<() => void>;
}

/** milliseconds between streamed words, a tool's work, and how long a view command is waited for */
export const MOCK_TIMING = { word: 22, think: 120, tool: 320, view: 5000, confirm: 30_000 };

export interface MockServer {
  /** every message the page sent, in order (tests) */
  received: ClientMsg[];
}

/** a Transport whose other end is the scripted server above, in this page */
export function createMockTransport(opts: { hello(): HelloMsg }): Transport & { server: MockServer } {
  let state: ConnState = 'connecting';
  const msgFns: ((m: ServerMsg) => void)[] = [];
  const stateFns: ((s: ConnState) => void)[] = [];
  const server: MockServer = { received: [] };
  let closed = false;
  let seq = 0;
  let current: Run | null = null;
  let queue: Promise<void> = Promise.resolve();
  const confirms = new Map<string, (v: 'approved' | 'denied' | 'expired') => void>();
  const views = new Map<string, (v: { ok: boolean; detail?: string }) => void>();

  // replies arrive asynchronously, as from a socket
  const emit = (m: ServerMsg) =>
    queueMicrotask(() => {
      if (!closed) for (const f of msgFns) f(m);
    });

  const until = <T>(run: Run, start: (done: (v: T) => void) => () => void): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (run.cancelled) return reject(new Cancelled());
      let stop = () => {};
      const cancel = () => (stop(), reject(new Cancelled()));
      run.cancels.add(cancel);
      stop = start((v) => {
        run.cancels.delete(cancel);
        stop();
        resolve(v);
      });
    });
  const sleep = (run: Run, ms: number) =>
    until<void>(run, (done) => {
      const t = setTimeout(() => done(), ms);
      return () => clearTimeout(t);
    });

  async function stream(run: Run, turnId: string, text: string): Promise<void> {
    for (const w of text.match(/\S+\s*/g) || []) {
      await sleep(run, MOCK_TIMING.word);
      emit({ type: 'text.delta', turnId, delta: w });
    }
  }

  async function turn(run: Run, said: string, source: 'typed' | 'voice'): Promise<void> {
    const turnId = `t${++seq}`;
    const tool = (callId: string, name: string, summary: string, status: ToolStatus, subject?: string) =>
      emit({ type: 'tool', turnId, callId, name, summary, status, subject });
    const view = async (op: ViewCommandMsg['op'], args: ViewCommandMsg['args']) => {
      const id = `v${++seq}`;
      emit({ type: 'view.command', id, op, args });
      return until<{ ok: boolean; detail?: string }>(run, (done) => {
        views.set(id, done);
        const t = setTimeout(() => done({ ok: false, detail: 'no answer from the viewer' }), MOCK_TIMING.view);
        return () => (clearTimeout(t), views.delete(id));
      });
    };
    emit({ type: 'turn.start', turnId, text: said, source, surface: 'screen' });
    emit({ type: 'status', state: 'thinking' });
    let pendingConfirm: string | null = null;
    let callId = '';
    try {
      await sleep(run, MOCK_TIMING.think);
      const s = matchScript(said);
      callId = `k${++seq}`;
      switch (s.kind) {
        case 'refuse':
          tool(callId, 'ha_act', `${s.summary}: not allowed`, 'refused');
          await stream(run, turnId, s.reason);
          break;
        case 'confirm': {
          tool(callId, 'ha_act', `${s.summary}: waiting for your OK`, 'pending');
          const id = `c${++seq}`;
          pendingConfirm = id;
          emit({
            type: 'confirm.request',
            id,
            callId,
            summary: s.summary,
            detail: s.detail,
            risk: s.risk,
            expiresAt: Date.now() + MOCK_TIMING.confirm,
            ttlMs: MOCK_TIMING.confirm,
          });
          const answer = await until<'approved' | 'denied' | 'expired'>(run, (done) => {
            confirms.set(id, done);
            const t = setTimeout(() => done('expired'), MOCK_TIMING.confirm);
            return () => (clearTimeout(t), confirms.delete(id));
          });
          pendingConfirm = null;
          emit({ type: 'confirm.resolved', id, outcome: answer } satisfies ConfirmResolvedMsg);
          if (answer === 'approved') {
            tool(callId, 'ha_act', s.summary, 'running');
            await sleep(run, MOCK_TIMING.tool);
            tool(callId, 'ha_act', s.summary, 'done');
            await stream(run, turnId, s.done);
          } else {
            tool(callId, 'ha_act', `${s.summary}: ${answer === 'denied' ? 'not confirmed' : 'expired'}`, 'refused');
            await stream(
              run,
              turnId,
              answer === 'denied' ? "OK, I won't." : 'That request expired, so I left it alone.',
            );
          }
          break;
        }
        case 'highlight': {
          tool(callId, 'view_highlight', `Highlighting ${s.names.join(', ')}`, 'running');
          const r = await view('highlight', { subjects: s.subjects, seconds: 4 });
          tool(callId, 'view_highlight', `Highlighting ${s.names.join(', ')}`, r.ok ? 'done' : 'error');
          await stream(
            run,
            turnId,
            r.ok
              ? `There: ${s.names.join(' and ').toLowerCase()}, pulsing for a few seconds.`
              : `I couldn't highlight those here (${r.detail || 'no reason given'}).`,
          );
          break;
        }
        case 'layer': {
          const verb = s.on === false ? 'Hiding' : s.on === true ? 'Showing' : 'Toggling';
          tool(callId, 'view_layer', `${verb} ${cap(s.layer)}`, 'running');
          const r = await view('layer', { layer: s.layer, on: s.on });
          tool(callId, 'view_layer', `${verb} ${cap(s.layer)}`, r.ok ? 'done' : 'error');
          await stream(
            run,
            turnId,
            r.ok
              ? `Done${r.detail ? `: ${r.detail}` : ''}.`
              : `I couldn't change that layer (${r.detail || 'no reason given'}).`,
          );
          break;
        }
        case 'show': {
          tool(callId, 'view_fly', `Showing ${s.name}`, 'running', s.subject);
          const r = await view('fly', { subject: s.subject });
          tool(callId, 'view_fly', `Showing ${s.name}`, r.ok ? 'done' : 'error', s.subject);
          await stream(
            run,
            turnId,
            r.ok
              ? `That's the ${s.name.toLowerCase()}, ${s.where}. It's open in the inspector.`
              : `I couldn't show that here (${r.detail || 'no reason given'}).`,
          );
          break;
        }
        case 'light': {
          const summary = `Turning ${s.on ? 'on' : 'off'} ${s.name}`;
          tool(callId, 'ha_act', summary, 'running', s.subject);
          await sleep(run, MOCK_TIMING.tool);
          tool(callId, 'ha_act', summary, 'done', s.subject);
          await stream(
            run,
            turnId,
            `I've turned ${s.on ? 'on' : 'off'} the ${s.name.replace(/^The /, '').toLowerCase()}.`,
          );
          break;
        }
        default:
          await stream(
            run,
            turnId,
            `This is the mock assistant, so I only know a few scripted phrases. Try "turn off the kitchen lights", "set the thermostat to 72", "show me the air handler", "highlight the hvac" or "unlock the front door".`,
          );
      }
      emit({ type: 'turn.end', turnId });
    } catch (err) {
      if (!(err instanceof Cancelled)) throw err;
      if (pendingConfirm) {
        emit({ type: 'confirm.resolved', id: pendingConfirm, outcome: 'denied', detail: 'interrupted' });
        tool(callId, 'ha_act', 'Interrupted before it was confirmed', 'refused');
      }
      emit({ type: 'turn.end', turnId, interrupted: true });
    }
    emit({ type: 'status', state: 'idle' });
  }

  const interrupt = () => {
    if (!current) return;
    current.cancelled = true;
    for (const c of [...current.cancels]) c();
  };

  function receive(m: ClientMsg): void {
    server.received.push(m);
    switch (m.type) {
      case 'hello':
        emit({
          type: 'welcome',
          transcript: [],
          status: 'idle',
          agent: 'scripted (mock)',
          transcribe: true,
          ha: 'mock',
        });
        break;
      case 'say': {
        const text = m.text.trim();
        if (!text) return;
        // one turn at a time, like the server: a message sent mid-turn waits for it
        queue = queue
          .then(async () => {
            const run: Run = { cancelled: false, cancels: new Set() };
            current = run;
            await turn(run, text, m.source);
            if (current === run) current = null;
          })
          .catch((err) => console.error('[assistant] mock turn failed', err));
        break;
      }
      case 'interrupt':
        interrupt();
        break;
      case 'confirm.reply':
        confirms.get(m.id)?.(m.approved ? 'approved' : 'denied');
        break;
      case 'view.result':
        views.get(m.id)?.({ ok: m.ok, detail: m.detail });
        break;
      case 'reset':
        interrupt();
        queue = queue.then(() =>
          emit({
            type: 'welcome',
            transcript: [{ kind: 'divider', text: 'New conversation', at: Date.now() }],
            status: 'idle',
            agent: 'scripted (mock)',
            transcribe: true,
            ha: 'mock',
          }),
        );
        break;
    }
  }

  setTimeout(() => {
    if (closed) return;
    state = 'connected';
    for (const f of stateFns) f(state);
    receive(opts.hello());
  }, 0);

  return {
    server,
    send(m) {
      if (closed || state !== 'connected') return false;
      receive(m);
      return true;
    },
    onMessage: (fn) => void msgFns.push(fn),
    onState: (fn) => void stateFns.push(fn),
    get state() {
      return state;
    },
    retryIn: () => null,
    retry() {},
    close() {
      closed = true;
      interrupt();
    },
  };
}
