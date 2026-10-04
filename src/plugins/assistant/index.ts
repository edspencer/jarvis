// The voice assistant's client (docs/design/voice-assistant.md §2.4, §6.4, §7): a dock panel with the rolling
// conversation, hold M to talk (also while walking with the mouse captured, and with the panel closed), Shift-M for
// the panel, a status item, the standard confirm for actions the server's policy wants approved, and the viewer
// commands the agent sends (fly to a subject, highlight, toggle a layer). The agent, its tools and the Home Assistant
// policy live on the assistant server (server/); this plugin acts on nothing itself.
//
// The server is the site's plugins.assistant.server (no section, no plugin: nothing shows and nothing connects): one
// WebSocket (<server>/ws, protocol in server/src/core/protocol.ts) and POST <server>/transcribe for recorded speech.
// With no server reachable the plugin stays quiet: the status item says "Assistant offline" and the socket retries
// with backoff; the rail button stays and the panel says why.
//
// Login (docs/assistant.md, "Authentication"): the hello carries the person's Home Assistant access token, from the
// home-assistant plugin's `home-assistant.auth` service, or an access code from the server's clients file, typed into
// the panel once and kept with ctx.storage (this site, this browser; "Forget code" drops it). A typed code wins over
// the Home Assistant login (it was entered for this assistant). Without either, or when the server refuses it (4401),
// the panel asks for a code and nothing retries until one is entered. The welcome's ticket authorises /transcribe.
//
// ?assistant=mock swaps the socket for an in-page scripted server (mock.ts): same protocol, no network, no audio, no
// model, no credentials (it takes a made-up one), deterministic. The talk button and M then simulate a transcription
// ("show me the air handler") instead of recording. Only in that mode, window.twin.assistant has test hooks (say,
// transcript, state, views, spoken).
import { definePlugin, type Disposable, type Subject } from '../../plugin-api';
import type { AssistantConfig } from '../../site';
import type {
  ClientMsg,
  ConfirmRequestMsg,
  HelloAuth,
  HelloMsg,
  ServerMsg,
  ViewCommandMsg,
  ViewContext,
} from '../../../server/src/core/protocol.ts';
import { initialTranscript, reduce, type LocalMsg, type TranscriptState } from './transcript';
import { createSocketTransport, clientId, endpoints, type ConnState, type Transport } from './transport';
import { createMockTransport } from './mock';
import { createSpeaker } from './speech';
import { record, recordIfWanted, transcribe, type Recording } from './talk';
import { AssistantPanel, type PanelModel, type Phase } from './panel';
import { resolveLayer } from './layers';

/** what the mock's talk button "hears" */
const MOCK_UTTERANCE = 'show me the air handler';
/** a press shorter than this is a click: click-to-talk (stops on a second click or a second of quiet) */
const CLICK_MS = 400;
/** how long a highlight pulses when the command doesn't say */
const HIGHLIGHT_S = 4;

/** the home-assistant plugin's login service (src/plugins/home-assistant/types.ts, docs/plugins.md) */
interface HomeAssistantAuth {
  accessToken(): Promise<string | null>;
}
/** where the access code is kept (ctx.storage: per site, this browser) */
const CODE_KEY = 'accessCode';

export default definePlugin<AssistantConfig>({
  id: 'assistant',
  name: 'Assistant',
  // the Home Assistant login is under way by then (the hello may carry it)
  after: ['home-assistant'],
  async setup(ctx) {
    const mock = ctx.url.get('assistant') === 'mock';
    const urls = endpoints(ctx.config.server || '/assistant', document.baseURI);
    let tts = ctx.storage.get<boolean>('tts', ctx.config.tts !== false);
    /** the access code typed into the panel, if any */
    let code = ctx.storage.get<string | null>(CODE_KEY, null);
    /** what the last hello carried (null: nothing to carry) */
    let used: HelloAuth['type'] | null = null;
    /** the welcome's (or the latest renewal's) /transcribe ticket, and whom the server took us for */
    let ticket: string | null = null;
    let user: string | null = null;

    // ------------------------------------------------------------------ state
    let ts: TranscriptState = initialTranscript();
    let conn: ConnState = 'connecting';
    /** local phases: the microphone and the transcription; thinking / speaking come from the server and TTS */
    let local: 'listening' | 'transcribing' | null = null;
    let rec: Recording | null = null;
    /** the recording is click-to-talk (stops on a second click or silence), not held */
    let toggleMode = false;
    let starting = false;
    /** stopTalk was asked for while the microphone was starting: send what was said, or drop it */
    let stopWanted: 'submit' | 'cancel' | null = null;
    /** the plugin was disposed (a pending getUserMedia must then let go of the microphone) */
    let disposed = false;
    let transcribing: AbortController | null = null;
    /** the view commands run (mock mode keeps them for tests) */
    const viewLog: { op: string; args: ViewCommandMsg['args']; ok: boolean; detail?: string }[] = [];
    const spoken: string[] = [];

    const speaker = createSpeaker({
      onChange: () => changed(),
      // mock mode: no audio; the sentences are recorded for the tests
      say: mock ? (text, done) => (spoken.push(text), queueMicrotask(done), () => {}) : undefined,
    });
    speaker.enabled = tts;

    const phase = (): Phase =>
      local ?? (ts.turn || ts.status === 'thinking' ? 'thinking' : speaker.speaking ? 'speaking' : 'idle');

    // ------------------------------------------------------------------ the view context (sent with hello and say)
    const viewContext = (): ViewContext => {
      const cur = ctx.inspector.current();
      const st = ctx.site.storeys;
      const z = ctx.three.toPlan(ctx.three.camera.position).Z;
      let storey = st[0]?.name ?? null;
      for (let i = 1; i < st.length; i++) if (z > st[i].from) storey = st[i].name;
      return {
        room: ctx.view.state.mode === 'walk' ? ctx.view.here() : null,
        selected: cur ? ctx.inspector.refOf(cur) : null,
        storey,
      };
    };
    /** the credential for the next hello: the mock's made-up one, a typed access code, or the HA login */
    const credential = async (): Promise<HelloAuth | null> => {
      if (mock) return { type: 'secret', secret: 'mock:mock' };
      if (code) return { type: 'secret', secret: code };
      const token = await ctx.services
        .get<HomeAssistantAuth>('home-assistant.auth')
        ?.accessToken()
        .catch(() => null);
      return token ? { type: 'ha', token } : null;
    };
    // (no surface: the server knows it from the credential)
    const hello = async (): Promise<HelloMsg | null> => {
      const auth = await credential();
      used = auth?.type ?? null;
      if (!auth) return null;
      return {
        type: 'hello',
        clientId: clientId(),
        auth,
        capabilities: tts ? ['viewer', 'tts'] : ['viewer'],
        view: viewContext(),
      };
    };

    // ------------------------------------------------------------------ the transport
    const transport: Transport & { server?: unknown } = mock
      ? createMockTransport({ hello })
      : createSocketTransport({ url: urls.ws, hello });
    ctx.own(() => transport.close());
    transport.onState((s) => {
      conn = s;
      if (s !== 'connected') {
        ticket = null;
        user = null;
        // a turn in flight is lost with the connection; the server's welcome brings the transcript back
        ts = { ...ts, turn: null, status: 'idle' };
        for (const c of confirms.values()) c.close(false);
      }
      changed();
    });
    transport.onMessage((m) => onServer(m));

    const send = (m: ClientMsg): boolean => transport.send(m);

    // ------------------------------------------------------------------ the HUD: panel, key, status item
    let el: AssistantPanel | null = null;
    let raf = 0;
    const changed = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        el?.requestUpdate();
        ctx.hud.invalidate();
      });
    };
    ctx.own(() => cancelAnimationFrame(raf));
    // the offline countdown in the panel
    const tick = setInterval(() => conn === 'offline' && panel.isOpen && changed(), 1000);
    ctx.own(() => clearInterval(tick));

    const talkBlocked = (): string | null => {
      if (conn === 'unauthorised') return 'Sign in to the assistant first (the Assistant panel)';
      if (conn !== 'connected') return 'The assistant is offline';
      if (!mock && !ts.transcribe) return 'The assistant server has no transcription configured: type instead';
      return null;
    };

    const model: PanelModel = {
      get transcript() {
        return ts;
      },
      get conn() {
        return conn;
      },
      get phase() {
        return phase();
      },
      level: () => (mock ? 0.35 + 0.25 * Math.sin(performance.now() / 120) : (rec?.level() ?? 0)),
      retryIn: () => transport.retryIn(),
      get tts() {
        return tts;
      },
      get auth() {
        return {
          refused: conn === 'unauthorised' && used !== null,
          via: used,
          hasCode: !!code && !mock,
          user,
        };
      },
      setCode: (c) => {
        const v = c.trim();
        if (!v) return;
        code = v;
        ctx.storage.set(CODE_KEY, v);
        transport.retry();
        changed();
      },
      forgetCode: () => {
        code = null;
        ctx.storage.remove(CODE_KEY);
        // a session the code opened ends with it (the next try uses the Home Assistant login, if any)
        transport.restart();
        changed();
      },
      mock,
      get talkBlocked() {
        return talkBlocked();
      },
      talkKey: 'M',
      send: (text) => say(text, 'typed'),
      talkPress: () => {
        if (local === 'listening' && toggleMode) return void stopTalk(true);
        toggleMode = false;
        void startTalk();
      },
      talkRelease: (ms) => {
        if (ms < CLICK_MS && (local === 'listening' || starting)) toggleMode = true;
        else if (!toggleMode) void stopTalk(true);
      },
      talkToggle: () => {
        if (local === 'listening' || starting) return void stopTalk(true);
        toggleMode = true;
        void startTalk();
      },
      stop: () => interrupt(),
      reset: () => {
        interrupt();
        if (send({ type: 'reset' })) apply({ type: 'local.divider', text: 'New conversation' });
      },
      setTts: (on) => {
        tts = on;
        speaker.enabled = on;
        if (!on) speaker.stop();
        ctx.storage.set('tts', on);
        changed();
      },
      retry: () => transport.retry(),
      open: (subject) => {
        if (!ctx.inspector.resolve(subject)) {
          ctx.toast({ text: `Can't find ${subject} in this building`, tone: 'warn' });
          return;
        }
        ctx.view.flyTo(subject);
        ctx.inspector.open(subject);
      },
    };

    const panel = ctx.hud.addPanel({
      id: 'assistant',
      title: 'Assistant',
      icon: 'mic',
      order: 45,
      key: { code: 'KeyM', shift: true, label: 'Assistant panel: the conversation, type or talk' },
      meta: () =>
        conn === 'connected'
          ? phase() === 'idle'
            ? null
            : `${phase()}…`
          : conn === 'offline'
            ? 'offline'
            : conn === 'unauthorised'
              ? 'sign in'
              : null,
      badge: () => (confirms.size ? confirms.size : null),
      badgeTone: () => (confirms.size ? 'warn' : null),
      render: (body) => {
        el = document.createElement('jv-assistant-panel') as AssistantPanel;
        el.model = model;
        body.el.append(el);
        return () => {
          el?.remove();
          el = null;
        };
      },
    });
    // (a panel's `key` is only its tooltip's hint: the core doesn't bind it, so the binding is ours)
    ctx.keys.add({ code: 'KeyM', shift: true, label: 'Assistant panel: the conversation', run: () => panel.toggle() });
    ctx.keys.add({
      code: 'KeyM',
      label: 'Hold to talk to the assistant (also while walking)',
      run: () => {
        toggleMode = false;
        void startTalk();
      },
      release: () => void stopTalk(true),
    });

    ctx.status.addItem({
      id: 'assistant',
      order: 190,
      render: () => {
        const p = phase();
        if (conn === 'offline')
          return {
            dot: 'off',
            text: 'Assistant offline',
            title: `${urls.ws} isn't reachable; retrying. Click for the panel.`,
          };
        if (conn === 'unauthorised')
          return {
            dot: 'warn',
            text: 'Assistant · sign in',
            title: 'The assistant needs a login: a Home Assistant login or an access code. Click for the panel.',
          };
        if (conn === 'connecting') return { dot: 'warn', text: 'Assistant · connecting…', title: urls.ws };
        return {
          dot: p === 'listening' ? 'bad' : p === 'idle' ? 'ok' : 'info',
          text: p === 'idle' ? `Assistant${mock ? ' · mock' : ''}` : `Assistant · ${p}`,
          title: `Assistant: ${p === 'idle' ? 'ready' : p}. Hold M to talk; Shift-M or click for the conversation.`,
        };
      },
      onClick: () => panel.open(),
    });

    // ------------------------------------------------------------------ messages from the server
    const apply = (m: ServerMsg | LocalMsg) => {
      const next = reduce(ts, m);
      if (next !== ts) {
        ts = next;
        changed();
      }
    };

    function onServer(m: ServerMsg): void {
      apply(m);
      switch (m.type) {
        case 'turn.start':
          speaker.stop(); // a new turn (from any surface) cuts off the last answer
          break;
        case 'text.delta':
          if (tts) speaker.feed(m.turnId, m.delta);
          break;
        case 'turn.end':
          if (tts && !m.interrupted) speaker.flush(m.turnId);
          if (m.error && !panel.isOpen) ctx.toast({ text: `Assistant: ${m.error}`, tone: 'warn' });
          break;
        case 'confirm.request':
          openConfirm(m);
          break;
        case 'confirm.resolved':
          confirms.get(m.id)?.close(true);
          break;
        case 'view.command':
          runView(m);
          break;
        case 'welcome':
          ticket = m.ticket ?? null;
          user = m.user?.name ?? null;
          break;
        case 'ticket':
          ticket = m.ticket;
          break;
        case 'status':
        case 'tool':
        case 'error':
          break;
      }
      changed();
    }

    // ------------------------------------------------------------------ saying and stopping
    function say(text: string, source: 'typed' | 'voice'): boolean {
      const t = text.trim();
      if (!t) return false;
      if (!send({ type: 'say', text: t, source, view: viewContext() })) {
        ctx.toast({ text: 'The assistant is offline', tone: 'warn' });
        return false;
      }
      apply({ type: 'local.say', text: t, source });
      return true;
    }

    /** barge-in: stop speaking, and stop the turn if one is running */
    function interrupt(): void {
      speaker.stop();
      if (ts.turn || ts.status === 'thinking') send({ type: 'interrupt' });
      changed();
    }

    // ------------------------------------------------------------------ talking
    async function startTalk(): Promise<void> {
      if (local || starting) return;
      const why = talkBlocked();
      if (why) {
        ctx.toast({ text: why, tone: 'warn' });
        return;
      }
      if (phase() === 'thinking' || phase() === 'speaking') interrupt();
      else speaker.stop();
      if (mock) {
        local = 'listening';
        changed();
        // click-to-talk "hears" a second of quiet after a while
        setTimeout(() => toggleMode && local === 'listening' && void stopTalk(true), 1500);
        return;
      }
      starting = true;
      stopWanted = null;
      changed();
      let r: Recording | null;
      try {
        // gone, or cancelled, while the microphone was starting (the permission prompt): it is let go of at once
        r = await recordIfWanted(
          () => record({ onSilence: () => toggleMode && void stopTalk(true), onMax: () => void stopTalk(true) }),
          () => !disposed && stopWanted !== 'cancel',
        );
      } catch (err) {
        starting = false;
        changed();
        if (!disposed) ctx.toast({ text: (err as Error).message, tone: 'warn' });
        return;
      }
      starting = false;
      if (!r) {
        if (!disposed) changed();
        return;
      }
      rec = r;
      local = 'listening';
      changed();
      if (stopWanted) await stopTalk(true); // released while the microphone was starting
    }

    /** stop recording; `submit`: transcribe and send it (else drop it) */
    async function stopTalk(submit: boolean): Promise<void> {
      if (starting) {
        // a cancel wins over a submit asked for meanwhile
        stopWanted = submit && stopWanted !== 'cancel' ? 'submit' : 'cancel';
        return;
      }
      if (local !== 'listening') return;
      toggleMode = false;
      if (mock) {
        local = 'transcribing';
        changed();
        await new Promise((r) => setTimeout(r, 250));
        local = null;
        changed();
        if (submit) say(MOCK_UTTERANCE, 'voice');
        return;
      }
      const r = rec;
      rec = null;
      local = 'transcribing';
      changed();
      const audio = await r?.stop();
      if (disposed) return;
      if (!submit || !audio) {
        local = null;
        changed();
        if (submit && !audio)
          ctx.toast({ text: 'Too short: hold M (or the mic button) while you speak', timeout: 2500 });
        return;
      }
      transcribing?.abort();
      const ac = (transcribing = new AbortController());
      try {
        const text = await transcribe(urls.transcribe, audio.blob, audio.mime, ticket, ac.signal);
        if (ac.signal.aborted) return;
        local = null;
        if (text) say(text, 'voice');
        else ctx.toast({ text: "Didn't catch that", timeout: 2500 });
      } catch (err) {
        if (ac.signal.aborted) return;
        local = null;
        ctx.toast({ text: `Couldn't transcribe: ${(err as Error).message}`, tone: 'warn' });
      } finally {
        if (transcribing === ac) transcribing = null;
        changed();
      }
    }
    ctx.own(() => {
      disposed = true;
      rec?.cancel();
      transcribing?.abort();
      speaker.stop();
    });

    // ------------------------------------------------------------------ confirmations
    // ctx.confirm() can't be closed from outside, so a request that expires or is answered elsewhere would leave a
    // stale dialog: this is the same standard dialog (the core's confirm is a modal with Cancel / OK), built on
    // ctx.modal, which can be closed and refreshed (the countdown).
    const confirms = new Map<string, { close(resolved: boolean): void }>();
    function openConfirm(m: ConfirmRequestMsg): void {
      confirms.get(m.id)?.close(true);
      let answered = false;
      const reply = (approved: boolean) => {
        if (answered) return;
        answered = true;
        send({ type: 'confirm.reply', id: m.id, approved });
      };
      // counted from this page's receipt time: the server's clock (expiresAt) may not agree with ours
      const deadline = Date.now() + (Number.isFinite(m.ttlMs) ? m.ttlMs : m.expiresAt - Date.now());
      const left = () => Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      const h = ctx.modal({
        title: m.risk === 'high' ? 'The assistant asks: are you sure?' : 'The assistant asks',
        blocks: () => [
          { type: 'text', text: m.summary },
          { type: 'kv', rows: [['Action', { text: m.detail, mono: true }]] },
          m.risk === 'high' && {
            type: 'callout',
            tone: 'warn',
            text: 'This one matters: check it before you allow it.',
          },
          { type: 'text', text: { text: `Expires in ${left()} s (then nothing is done).`, muted: true } },
        ],
        actions: () => [
          { label: "Don't", onClick: () => (reply(false), h.close()) },
          { label: 'Allow', kind: m.risk === 'high' ? 'danger' : 'primary', onClick: () => (reply(true), h.close()) },
        ],
        // Esc or the close button: no
        onClose: () => {
          clearInterval(countdown);
          confirms.delete(m.id);
          reply(false);
          changed();
        },
      });
      const countdown = setInterval(() => {
        if (Date.now() >= deadline + 1000) {
          answered = true; // the server has expired it itself
          h.close();
        } else h.refresh();
      }, 1000);
      confirms.set(m.id, {
        close: (resolved) => {
          if (resolved) answered = true; // answered elsewhere, expired: nothing to send
          h.close();
        },
      });
      changed();
    }
    ctx.own(() => {
      for (const c of [...confirms.values()]) c.close(true);
    });

    // ------------------------------------------------------------------ viewer commands
    const highlights: Disposable[] = [];
    const clearHighlights = () => {
      for (const d of highlights.splice(0)) d.dispose();
    };
    ctx.own(clearHighlights);

    /** a box pulsing around a model object for a few seconds (items like pins pulse themselves when selected) */
    function pulse(s: Subject, seconds: number): Disposable | null {
      if (s.kind !== 'object') return null;
      const { THREE, scene } = ctx.three;
      const box = new THREE.Box3().setFromObject(s.node);
      if (box.isEmpty()) return null;
      box.expandByScalar(0.05);
      const helper = new THREE.Box3Helper(box, new THREE.Color(0x7cc4ff));
      const mat = helper.material as import('three').LineBasicMaterial;
      mat.transparent = true;
      mat.depthTest = false;
      helper.renderOrder = 999;
      scene.add(helper);
      const t0 = performance.now();
      const frame = ctx.events.on('frame', ({ now }) => {
        mat.opacity = 0.35 + 0.65 * Math.abs(Math.sin(((now - t0) / 1000) * Math.PI * 1.5));
      });
      let gone = false;
      const d = {
        dispose: () => {
          if (gone) return;
          gone = true;
          clearTimeout(timer);
          frame.dispose();
          scene.remove(helper);
          helper.dispose();
        },
      };
      const timer = setTimeout(() => d.dispose(), seconds * 1000);
      return d;
    }

    const title = (s: string) => ctx.inspector.describe(s)?.title || s;

    /** a view layer, or one of the core's view toggles (layers.ts); never a plugin's key (those can act on the house) */
    function setLayer(name: string, on: boolean | undefined): { ok: boolean; detail: string } {
      const t = resolveLayer(name, ctx.view.layers());
      if (t.kind === 'none') return { ok: false, detail: t.detail };
      if (t.kind === 'layer') {
        const shown = !ctx.view.state.hidden[t.id];
        if (on === undefined || on !== shown) ctx.view.toggleLayer(t.id);
        return { ok: true, detail: `${t.label} ${(on ?? !shown) ? 'shown' : 'hidden'}` };
      }
      // the core's toggles have no setter in the view API: press the core's own key, whose state the view tells
      const core = {
        cutaway: { code: 'KeyX', label: 'Cutaway', get: () => ctx.view.state.cutaway },
        upper: { code: 'KeyU', label: 'Upper storey', get: () => !ctx.view.state.upperHidden },
        ghost: { code: 'KeyG', label: 'Ghost', get: () => ctx.view.state.ghost },
      }[t.toggle];
      const k = ctx.keys
        .list()
        .find((x) => x.owner === 'core' && x.code === core.code && x.run && !x.shift && !x.alt && !x.release);
      if (!k) return { ok: false, detail: `no ${core.label.toLowerCase()} toggle here` };
      if (on === undefined || on !== core.get()) k.run!(new KeyboardEvent('keydown', { code: core.code }));
      return { ok: true, detail: `${core.label} ${core.get() ? 'on' : 'off'}` };
    }

    function runView(m: ViewCommandMsg): void {
      let r: { ok: boolean; detail?: string };
      try {
        r = execView(m);
      } catch (err) {
        r = { ok: false, detail: (err as Error).message };
      }
      viewLog.push({ op: m.op, args: m.args, ...r });
      if (viewLog.length > 50) viewLog.shift();
      send({ type: 'view.result', id: m.id, ...r });
    }

    function execView(m: ViewCommandMsg): { ok: boolean; detail?: string } {
      const a = m.args || {};
      switch (m.op) {
        case 'fly': {
          const s = a.subject && ctx.inspector.resolve(a.subject);
          if (!s) return { ok: false, detail: `unknown subject ${a.subject ?? '(none)'}` };
          ctx.view.flyTo(s);
          ctx.inspector.open(s);
          return { ok: true, detail: `showing ${title(a.subject!)}` };
        }
        case 'highlight': {
          const refs = a.subjects?.length ? a.subjects : a.subject ? [a.subject] : [];
          const found = refs.map((ref) => [ref, ctx.inspector.resolve(ref)] as const).filter(([, s]) => s);
          const missing = refs.filter((ref) => !found.some(([f]) => f === ref));
          if (!found.length)
            return { ok: false, detail: `unknown subject${refs.length > 1 ? 's' : ''} ${refs.join(', ') || '(none)'}` };
          clearHighlights();
          const secs = Math.min(30, Math.max(1, a.seconds ?? HIGHLIGHT_S));
          for (const [, s] of found) {
            const d = pulse(s!, secs);
            if (d) highlights.push(d);
          }
          // the first one in the inspector (a pin pulses while it's selected)
          ctx.inspector.open(found[0][1]!);
          return {
            ok: true,
            detail: `highlighted ${found.map(([ref]) => title(ref)).join(', ')}${missing.length ? `; unknown: ${missing.join(', ')}` : ''}`,
          };
        }
        case 'layer':
          if (!a.layer) return { ok: false, detail: 'no layer named' };
          return setLayer(a.layer, a.on);
        case 'clear':
          clearHighlights();
          ctx.inspector.close();
          return { ok: true, detail: 'cleared' };
        default:
          return { ok: false, detail: `unknown op ${(m as { op: string }).op}` };
      }
    }

    // ------------------------------------------------------------------ test hooks (mock mode only)
    if (mock)
      ctx.expose(
        'assistant',
        Object.freeze({
          say: (text: string, source: 'typed' | 'voice' = 'typed') => say(text, source),
          transcript: () => structuredClone(ts.entries),
          state: () => ({ conn, phase: phase(), turn: ts.turn, status: ts.status, confirms: confirms.size }),
          views: () => structuredClone(viewLog),
          spoken: () => [...spoken],
          received: () => structuredClone((transport.server as { received: ClientMsg[] }).received),
        }),
      );
  },
});
