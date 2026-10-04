// The assistant plugin's pure parts: URL derivation and backoff, the transcript reducer, the sentence splitter and
// Markdown stripper for speech, the recording format choice, the mock's script matcher and the mock server itself
// (driven with fake timers), and the site manifest's assistant section.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMsg, ServerMsg } from '../../server/src/core/protocol.ts';
import { backoff, endpoints, parseServerMsg } from '../../src/plugins/assistant/transport';
import { initialTranscript, reduce, MAX_ENTRIES, type TranscriptState } from '../../src/plugins/assistant/transcript';
import { createSpeaker, speakable, takeSentences } from '../../src/plugins/assistant/speech';
import { fileName, pickMime } from '../../src/plugins/assistant/talk';
import { createMockTransport, matchScript, MOCK_TIMING } from '../../src/plugins/assistant/mock';
import { reservedKeys, validateManifest, type SiteManifest } from '../../src/site';

describe('endpoints', () => {
  it('derives the socket and transcription URLs from the server base, relative to the page', () => {
    expect(endpoints('/assistant', 'https://twin.example.org/viewer/')).toEqual({
      ws: 'wss://twin.example.org/assistant/ws',
      transcribe: 'https://twin.example.org/assistant/transcribe',
    });
    expect(endpoints('/assistant/', 'http://localhost:5173/')).toEqual({
      ws: 'ws://localhost:5173/assistant/ws',
      transcribe: 'http://localhost:5173/assistant/transcribe',
    });
    expect(endpoints('https://box.lan:8787/assistant', 'https://twin.example.org/').ws).toBe(
      'wss://box.lan:8787/assistant/ws',
    );
    expect(endpoints('./assistant', 'https://twin.example.org/viewer/index.html').ws).toBe(
      'wss://twin.example.org/viewer/assistant/ws',
    );
  });

  it('backs off from a second to a minute, with jitter', () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 10].map((a) => backoff(a, mid))).toEqual([1000, 2000, 4000, 8000, 60000]);
    expect(backoff(0, () => 0)).toBe(800);
    expect(backoff(0, () => 1)).toBe(1200);
  });

  it('parses only JSON objects with a type', () => {
    expect(parseServerMsg('{"type":"status","state":"idle"}')).toEqual({ type: 'status', state: 'idle' });
    expect(parseServerMsg('not json')).toBeNull();
    expect(parseServerMsg('{"state":"idle"}')).toBeNull();
    expect(parseServerMsg('[1]')).toBeNull();
    expect(parseServerMsg(new ArrayBuffer(2))).toBeNull();
  });
});

describe('the transcript reducer', () => {
  const run = (msgs: Parameters<typeof reduce>[1][], s: TranscriptState = initialTranscript()) =>
    msgs.reduce(reduce, s);

  it('takes the server transcript on welcome', () => {
    const s = run([
      {
        type: 'welcome',
        transcript: [
          { kind: 'user', turnId: 't1', text: 'hi', source: 'typed', surface: 'screen', at: 1 },
          { kind: 'assistant', turnId: 't1', text: 'Hello.', at: 2 },
          { kind: 'tool', turnId: 't1', callId: 'k1', name: 'ha_act', summary: 'x', status: 'done', at: 3 },
          { kind: 'divider', text: 'New day', at: 4 },
        ],
        status: 'idle',
        agent: 'scripted',
        transcribe: true,
        ha: 'mock',
      },
    ]);
    expect(s.entries.map((e) => e.kind)).toEqual(['user', 'assistant', 'tool', 'divider']);
    expect(s).toMatchObject({ agent: 'scripted', transcribe: true, ha: 'mock', turn: null });
  });

  it('confirms a message sent from here in place, streams the answer and puts text after a tool below it', () => {
    let s = run([{ type: 'local.say', text: 'turn off the lights', source: 'typed' }]);
    expect(s.entries[0]).toMatchObject({ kind: 'user', pending: true, turnId: '' });
    const id = s.entries[0].id;
    s = run(
      [
        { type: 'turn.start', turnId: 't1', text: 'turn off the lights', source: 'typed', surface: 'screen' },
        { type: 'text.delta', turnId: 't1', delta: 'One ' },
        { type: 'text.delta', turnId: 't1', delta: 'moment.' },
        {
          type: 'tool',
          turnId: 't1',
          callId: 'k1',
          name: 'ha_act',
          summary: 'Turning off',
          status: 'running',
          subject: 'pins:a',
        },
        { type: 'tool', turnId: 't1', callId: 'k1', name: 'ha_act', summary: 'Turning off', status: 'done' },
        { type: 'text.delta', turnId: 't1', delta: 'Done.' },
      ],
      s,
    );
    expect(s.turn).toBe('t1');
    expect(s.status).toBe('thinking');
    expect(s.entries.map((e) => e.kind)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(s.entries[0]).toMatchObject({ id, turnId: 't1' });
    expect(s.entries[0].kind === 'user' && s.entries[0].pending).toBeFalsy();
    expect(s.entries[1]).toMatchObject({ text: 'One moment.', streaming: true });
    expect(s.entries[2]).toMatchObject({ status: 'done', subject: 'pins:a' }); // the update kept the subject
    s = run([{ type: 'turn.end', turnId: 't1' }], s);
    expect(s.turn).toBeNull();
    expect(s.status).toBe('idle');
    expect(s.entries.filter((e) => e.kind === 'assistant' && e.streaming)).toEqual([]);
  });

  it("shows another surface's turn, says when a turn was stopped or failed, and shows errors", () => {
    const s = run([
      { type: 'turn.start', turnId: 't2', text: 'what time is it', source: 'voice', surface: 'speaker' },
      { type: 'turn.end', turnId: 't2', interrupted: true },
      { type: 'turn.start', turnId: 't3', text: 'and now', source: 'typed', surface: 'screen' },
      { type: 'turn.end', turnId: 't3', error: 'rate limited' },
      { type: 'error', message: 'bad message' },
    ]);
    expect(s.entries.map((e) => [e.kind, 'text' in e ? e.text : ''])).toEqual([
      ['user', 'what time is it'],
      ['note', 'Stopped.'],
      ['user', 'and now'],
      ['note', 'That turn failed: rate limited'],
      ['note', 'bad message'],
    ]);
    expect(s.entries[0]).toMatchObject({ source: 'voice', surface: 'speaker' });
  });

  it('ignores what it has nothing to do with, and keeps a bounded transcript', () => {
    const s0 = initialTranscript();
    expect(reduce(s0, { type: 'view.command', id: 'v', op: 'clear', args: {} })).toBe(s0);
    expect(reduce(s0, { type: 'text.delta', turnId: 't', delta: '' })).toBe(s0);
    let s = s0;
    for (let i = 0; i < MAX_ENTRIES + 20; i++) s = reduce(s, { type: 'local.note', text: `n${i}` });
    expect(s.entries.length).toBe(MAX_ENTRIES);
    expect(s.entries.at(-1)).toMatchObject({ text: `n${MAX_ENTRIES + 19}` });
    expect(new Set(s.entries.map((e) => e.id)).size).toBe(MAX_ENTRIES);
  });
});

describe('speech', () => {
  it('splits complete sentences off the front and waits for the rest', () => {
    expect(takeSentences('Hello there. How are')).toEqual({ sentences: ['Hello there.'], rest: ' How are' });
    expect(takeSentences('Done!')).toEqual({ sentences: [], rest: 'Done!' }); // the next delta may continue it
    expect(takeSentences('It is 72.5 degrees. OK')).toEqual({ sentences: ['It is 72.5 degrees.'], rest: ' OK' });
    expect(takeSentences('Use a filter, e.g. a MERV 13. Then')).toEqual({
      sentences: ['Use a filter, e.g. a MERV 13.'],
      rest: ' Then',
    });
    expect(takeSentences('He said "stop!" and left. Next')).toEqual({
      sentences: ['He said "stop!" and left.'],
      rest: ' Next',
    });
    expect(takeSentences('First line\nSecond? Yes. ')).toEqual({
      sentences: ['First line', 'Second?', 'Yes.'],
      rest: ' ',
    });
    expect(takeSentences('Wait... What? Then')).toEqual({ sentences: ['Wait...', 'What?'], rest: ' Then' });
    expect(takeSentences('Wait... what? X')).toEqual({ sentences: ['Wait... what?'], rest: ' X' });
  });

  it('turns Markdown into something to say', () => {
    expect(speakable('**Done**: set to 72 °F.')).toBe('Done: set to 72 degrees.');
    expect(speakable('- one\n- two')).toBe('one two');
    expect(speakable('## Heading\nSee [the manual](https://x.org/m.pdf) or https://x.org')).toBe(
      'Heading See the manual or a link',
    );
    expect(speakable('Run `ha.act` with *care* and _thought_.')).toBe('Run ha.act with care and thought.');
    expect(speakable('```\ncode\n```\nAfter')).toBe('After');
  });

  it('speaks sentence by sentence as the text streams, flushes at the end, and stops at once', () => {
    const said: string[] = [];
    const pending: (() => void)[] = [];
    const sp = createSpeaker({
      onChange: () => {},
      say: (t, done) => (said.push(t), pending.push(done), () => {}),
    });
    sp.feed('t1', 'The kitchen lights are ');
    expect(said).toEqual([]);
    sp.feed('t1', 'off. The hall is ');
    expect(said).toEqual(['The kitchen lights are off.']);
    expect(sp.speaking).toBe(true);
    sp.flush('t1');
    expect(said).toEqual(['The kitchen lights are off.', 'The hall is']);
    pending.splice(0).forEach((d) => d());
    expect(sp.speaking).toBe(false);
    sp.feed('t2', 'Something. ');
    expect(sp.speaking).toBe(true);
    sp.stop();
    expect(sp.speaking).toBe(false);
    sp.enabled = false;
    sp.feed('t3', 'Silent. ');
    expect(said).toHaveLength(3);
  });
});

describe('recording', () => {
  it('prefers Opus in WebM, then Ogg, then MP4', () => {
    expect(pickMime(() => true)).toBe('audio/webm;codecs=opus');
    expect(pickMime((t) => t.startsWith('audio/ogg'))).toBe('audio/ogg;codecs=opus');
    expect(pickMime((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(pickMime(() => false)).toBe('');
    expect(['audio/webm;codecs=opus', 'audio/ogg', 'audio/mp4', ''].map(fileName)).toEqual([
      'speech.webm',
      'speech.ogg',
      'speech.m4a',
      'speech.bin',
    ]);
  });
});

describe('the mock script matcher', () => {
  it('finds the script for what was said', () => {
    expect(matchScript('Turn off the kitchen lights')).toEqual({
      kind: 'light',
      on: false,
      name: 'Kitchen pendants',
      subject: 'pins:fixture.kitchen-pendants',
    });
    expect(matchScript('turn on the landing lights')).toMatchObject({
      kind: 'light',
      on: true,
      name: 'Landing lights',
    });
    expect(matchScript('lights on')).toMatchObject({ kind: 'light', on: true, name: 'The lights' });
    expect(matchScript('Set the thermostat to 68')).toMatchObject({
      kind: 'confirm',
      summary: 'Set the Hall thermostat to 68 °F',
      risk: 'normal',
    });
    expect(matchScript('close the garage please')).toMatchObject({ kind: 'confirm', risk: 'high' });
    expect(matchScript('open the garage')).toMatchObject({ kind: 'refuse' });
    expect(matchScript('Unlock the front door')).toMatchObject({ kind: 'refuse', summary: 'Unlocking Front door' });
    expect(matchScript('show me the air handler')).toMatchObject({ kind: 'show', subject: 'pins:hvac.air-handler' });
    expect(matchScript('Where is the water heater?')).toMatchObject({
      kind: 'show',
      subject: 'pins:plumb.water-heater',
    });
    expect(matchScript('show me the thermostat')).toMatchObject({ kind: 'show', subject: 'pins:hvac.thermostat' });
    expect(matchScript('highlight the hvac')).toEqual({
      kind: 'highlight',
      subjects: ['pins:hvac.air-handler', 'pins:hvac.thermostat'],
      names: ['Air handler', 'Thermostat'],
    });
    expect(matchScript('highlight the fridge')).toMatchObject({ subjects: ['pins:appliance.fridge'] });
    expect(matchScript('hide the furniture')).toEqual({ kind: 'layer', layer: 'furniture', on: false });
    expect(matchScript('toggle pins')).toEqual({ kind: 'layer', layer: 'pins', on: undefined });
    expect(matchScript("what's the weather like")).toEqual({ kind: 'generic' });
  });
});

describe('the mock server', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const hello = (): ClientMsg & { type: 'hello' } => ({
    type: 'hello',
    clientId: 'c1',
    surface: 'screen',
    capabilities: ['viewer'],
  });
  async function start() {
    const t = createMockTransport({ hello });
    const got: ServerMsg[] = [];
    t.onMessage((m) => got.push(m));
    await vi.advanceTimersByTimeAsync(1);
    return { t, got };
  }
  const types = (ms: ServerMsg[]) => ms.map((m) => m.type);

  it('says hello back with a welcome, and streams a light command: tool running → done, then the text', async () => {
    const { t, got } = await start();
    expect(t.state).toBe('connected');
    expect(got[0]).toMatchObject({ type: 'welcome', agent: 'scripted (mock)', transcribe: true });
    t.send({ type: 'say', text: 'turn off the kitchen lights', source: 'typed' });
    await vi.advanceTimersByTimeAsync(3000);
    const tools = got.filter((m) => m.type === 'tool');
    expect(tools.map((m) => m.type === 'tool' && m.status)).toEqual(['running', 'done']);
    expect(tools[0]).toMatchObject({
      summary: 'Turning off Kitchen pendants',
      subject: 'pins:fixture.kitchen-pendants',
    });
    const deltas = got.filter((m) => m.type === 'text.delta');
    expect(deltas.length).toBeGreaterThan(3);
    expect(deltas.map((m) => m.type === 'text.delta' && m.delta).join('')).toBe(
      "I've turned off the kitchen pendants.",
    );
    expect(types(got).slice(1, 3)).toEqual(['turn.start', 'status']);
    expect(types(got).slice(-2)).toEqual(['turn.end', 'status']);
  });

  it('asks before acting: approve → done; deny → refused; nothing answered → expired', async () => {
    const { t, got } = await start();
    const ask = async (approved: boolean | null) => {
      got.length = 0;
      t.send({ type: 'say', text: 'set the thermostat to 72', source: 'typed' });
      await vi.advanceTimersByTimeAsync(500);
      const req = got.find((m) => m.type === 'confirm.request');
      expect(req).toMatchObject({ summary: 'Set the Hall thermostat to 72 °F', risk: 'normal' });
      expect(got.find((m) => m.type === 'tool')).toMatchObject({ status: 'pending' });
      if (req?.type === 'confirm.request') {
        expect(req.expiresAt).toBeGreaterThan(Date.now() + MOCK_TIMING.confirm - 1000);
        if (approved !== null) t.send({ type: 'confirm.reply', id: req.id, approved });
      }
      await vi.advanceTimersByTimeAsync(approved === null ? MOCK_TIMING.confirm + 3000 : 3000);
      const text = got.map((m) => (m.type === 'text.delta' ? m.delta : '')).join('');
      const resolved = got.find((m) => m.type === 'confirm.resolved');
      const last = got.filter((m) => m.type === 'tool').at(-1);
      return { text, resolved, last };
    };
    let r = await ask(true);
    expect(r.resolved).toMatchObject({ outcome: 'approved' });
    expect(r.last).toMatchObject({ status: 'done' });
    expect(r.text).toBe('Done: the hall thermostat is set to 72 °F.');
    r = await ask(false);
    expect(r.resolved).toMatchObject({ outcome: 'denied' });
    expect(r.last).toMatchObject({ status: 'refused' });
    expect(r.text).toBe("OK, I won't.");
    r = await ask(null);
    expect(r.resolved).toMatchObject({ outcome: 'expired' });
    expect(r.last).toMatchObject({ status: 'refused' });
  });

  it('flies the viewer and waits for its answer before it speaks', async () => {
    const { t, got } = await start();
    t.send({ type: 'say', text: 'show me the air handler', source: 'voice' });
    await vi.advanceTimersByTimeAsync(500);
    const cmd = got.find((m) => m.type === 'view.command');
    expect(cmd).toMatchObject({ op: 'fly', args: { subject: 'pins:hvac.air-handler' } });
    expect(got.some((m) => m.type === 'text.delta')).toBe(false); // waiting
    if (cmd?.type === 'view.command') t.send({ type: 'view.result', id: cmd.id, ok: true });
    await vi.advanceTimersByTimeAsync(3000);
    expect(got.map((m) => (m.type === 'text.delta' ? m.delta : '')).join('')).toMatch(
      /^That's the air handler, in the hall/,
    );
    expect(got.find((m) => m.type === 'turn.start')).toMatchObject({ source: 'voice' });
  });

  it('stops a turn on interrupt (a pending confirmation is denied) and starts over on reset', async () => {
    const { t, got } = await start();
    t.send({ type: 'say', text: 'close the garage', source: 'typed' });
    await vi.advanceTimersByTimeAsync(500);
    t.send({ type: 'interrupt' });
    await vi.advanceTimersByTimeAsync(10);
    expect(got.find((m) => m.type === 'confirm.resolved')).toMatchObject({ outcome: 'denied' });
    expect(got.find((m) => m.type === 'turn.end')).toMatchObject({ interrupted: true });
    got.length = 0;
    t.send({ type: 'reset' });
    await vi.advanceTimersByTimeAsync(10);
    expect(got[0]).toMatchObject({ type: 'welcome', transcript: [{ kind: 'divider', text: 'New conversation' }] });
    t.close();
    expect(t.send({ type: 'say', text: 'hi', source: 'typed' })).toBe(false);
  });
});

describe('the site manifest', () => {
  const site = (assistant: unknown): SiteManifest =>
    ({
      jarvis: 'jarvis-site/1',
      id: 'x',
      name: 'X',
      geo: { lat: 0, lon: 0, timeZone: 'UTC' },
      models: { main: { url: 'm.glb' } },
      viewpoints: [{ name: 'A', at: [0, 0, 0], yaw: 0 }],
      plugins: { assistant },
    }) as SiteManifest;

  it('takes an assistant section with a server, and keeps M off site layers', () => {
    expect(validateManifest(site({ server: '/assistant' })).ok).toBe(true);
    expect(validateManifest(site({ server: 'https://box.lan:8787/assistant', tts: false })).ok).toBe(true);
    expect(validateManifest(site({})).errors[0].path).toBe('plugins.assistant.server');
    expect(validateManifest(site({ server: 'ws://box/assistant' })).errors[0].path).toBe('plugins.assistant.server');
    expect(validateManifest(site({ server: '/a', voice: 1 })).ok).toBe(false);
    expect(reservedKeys({ plugins: { assistant: { server: '/a' } } }).has('M')).toBe(true);
    expect(reservedKeys({ plugins: {} }).has('M')).toBe(false);
  });

  it('warns about a plain-http server elsewhere (an https page, which the microphone needs, cannot reach it)', () => {
    expect(validateManifest(site({ server: 'http://box.lan:8787/assistant' })).warnings.map((w) => w.path)).toEqual([
      'plugins.assistant.server',
    ]);
    expect(validateManifest(site({ server: 'http://localhost:8787/assistant' })).warnings).toEqual([]);
  });
});
