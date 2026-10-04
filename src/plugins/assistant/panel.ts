// The Assistant panel's content: a Lit element drawn into the dock panel's body (a streaming chat is bespoke UI, so it
// isn't blocks). It only draws the plugin's state (PanelModel) and calls back; the plugin re-renders it on every
// change. The rolling transcript keeps to the bottom unless the person scrolled up (then a "New messages" button);
// tool chips carry a status pill with a glyph and a word (never colour alone) and fly to their subject on click.
// Keys typed in the text box never reach the viewer: the core ignores key events from inputs (src/core/input.ts).
import { LitElement, css, html, nothing, type PropertyValues } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { base } from '../../ui/styles';
import { iconSvg } from '../../ui/icons';
import type { ToolStatus } from '../../../server/src/core/protocol.ts';
import type { Entry, TranscriptState } from './transcript';
import type { ConnState } from './transport';

export type Phase = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

export interface PanelModel {
  transcript: TranscriptState;
  conn: ConnState;
  phase: Phase;
  /** 0-1 microphone level while listening */
  level(): number;
  retryIn(): number | null;
  tts: boolean;
  mock: boolean;
  /** why talking isn't possible (no transcription, offline), or null */
  talkBlocked: string | null;
  /** the hold key's name ('M') */
  talkKey: string;
  send(text: string): boolean;
  /** the talk button went down / up (`ms`: how long it was held) */
  talkPress(): void;
  talkRelease(ms: number): void;
  /** the talk button activated from the keyboard (Enter / Space): start or stop */
  talkToggle(): void;
  stop(): void;
  reset(): void;
  setTts(on: boolean): void;
  retry(): void;
  open(subject: string): void;
}

const TOOL: Record<ToolStatus, { glyph: string; word: string; tone: string }> = {
  running: { glyph: '…', word: 'working', tone: 'info' },
  pending: { glyph: '?', word: 'waiting for OK', tone: 'warn' },
  done: { glyph: '✓', word: 'done', tone: 'ok' },
  refused: { glyph: '✕', word: 'refused', tone: 'bad' },
  error: { glyph: '!', word: 'failed', tone: 'bad' },
};

const PHASE: Record<Phase, { text: string; tone: string }> = {
  idle: { text: 'Ready', tone: 'ok' },
  listening: { text: 'Listening…', tone: 'bad' },
  transcribing: { text: 'Transcribing…', tone: 'info' },
  thinking: { text: 'Thinking…', tone: 'info' },
  speaking: { text: 'Speaking…', tone: 'info' },
};

export class AssistantPanel extends LitElement {
  static override properties = { model: { attribute: false } };
  declare model: PanelModel;
  private stick = true;
  private unseen = false;
  private draft = '';
  private pressedAt = 0;
  private meterRaf = 0;

  static override styles = [
    base,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: 8px;
        height: min(62vh, 620px);
        min-height: 260px;
      }
      .log {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 2px 2px 4px 0;
        position: relative;
      }
      .empty {
        margin: auto 8px;
        text-align: center;
        color: var(--jv-text-muted);
        font-size: 12.5px;
      }
      .empty kbd {
        border: 1px solid var(--jv-border);
        border-radius: 4px;
        padding: 0 4px;
      }
      .u {
        align-self: flex-end;
        max-width: 86%;
        background: color-mix(in srgb, var(--jv-accent) 16%, var(--jv-surface-raised));
        border-radius: 10px 10px 3px 10px;
        padding: 6px 10px;
        overflow-wrap: anywhere;
      }
      .u .t {
        white-space: pre-wrap;
      }
      .u.pending {
        opacity: 0.6;
      }
      .u .src {
        display: inline-flex;
        vertical-align: -2px;
        margin-right: 5px;
        color: var(--jv-text-muted);
      }
      .u .src svg {
        width: 13px;
        height: 13px;
      }
      .a {
        align-self: flex-start;
        max-width: 96%;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        line-height: 1.45;
      }
      .a.streaming::after {
        content: '▍';
        color: var(--jv-accent);
        animation: blink 1s steps(1) infinite;
      }
      @keyframes blink {
        50% {
          opacity: 0;
        }
      }
      .tool {
        align-self: flex-start;
        display: inline-flex;
        align-items: center;
        gap: 7px;
        max-width: 100%;
        padding: 3px 9px 3px 4px;
        border-radius: 999px;
        border: 1px solid var(--jv-border);
        background: var(--jv-surface-sunken);
        font: 12px var(--jv-font);
        color: var(--jv-text);
        text-align: left;
      }
      button.tool {
        cursor: pointer;
      }
      button.tool:hover {
        background: var(--jv-surface-raised);
        border-color: color-mix(in srgb, var(--jv-accent) 45%, transparent);
      }
      .tool .sum {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .tool .go {
        color: var(--jv-accent);
        display: inline-flex;
      }
      .tool .go svg {
        width: 13px;
        height: 13px;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        height: 18px;
        padding: 0 7px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
        white-space: nowrap;
        flex: none;
        background: color-mix(in srgb, var(--tone, var(--jv-off)) 18%, transparent);
        color: color-mix(in srgb, var(--tone, var(--jv-off)) 55%, white);
      }
      .tone-ok {
        --tone: var(--jv-ok);
      }
      .tone-warn {
        --tone: var(--jv-warn);
      }
      .tone-bad {
        --tone: var(--jv-bad);
      }
      .tone-info {
        --tone: var(--jv-info);
      }
      .tone-off {
        --tone: var(--jv-off);
      }
      .divider {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--jv-text-faint);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .divider::before,
      .divider::after {
        content: '';
        flex: 1;
        border-top: 1px solid var(--jv-border);
      }
      .note {
        font-size: 12px;
        color: var(--jv-text-muted);
        font-style: italic;
      }
      .note.bad {
        color: color-mix(in srgb, var(--jv-bad) 60%, white);
        font-style: normal;
      }
      .newmsg {
        position: sticky;
        bottom: 0;
        align-self: center;
        padding: 2px 10px;
        border-radius: 999px;
        border: 1px solid var(--jv-border);
        background: var(--jv-surface-raised);
        color: var(--jv-accent);
        font-size: 12px;
        cursor: pointer;
      }
      .offline {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 9px;
        border-radius: 6px;
        font-size: 12px;
        background: color-mix(in srgb, var(--jv-off) 12%, transparent);
        border: 1px solid color-mix(in srgb, var(--jv-off) 30%, transparent);
        color: var(--jv-text-muted);
      }
      .offline span {
        flex: 1;
      }
      .state {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 24px;
        font-size: 12px;
        color: var(--jv-text-muted);
      }
      .state .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--tone);
        flex: none;
      }
      .state .txt {
        flex: 1;
      }
      .meter {
        width: 64px;
        height: 6px;
        border-radius: 3px;
        background: var(--jv-surface-sunken);
        overflow: hidden;
      }
      .meter i {
        display: block;
        height: 100%;
        background: var(--jv-bad);
        transition: width 60ms linear;
      }
      .composer {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .composer input {
        flex: 1;
        min-width: 0;
        height: 32px;
        font: inherit;
        color: var(--jv-text);
        background: var(--jv-surface-sunken);
        border: 1px solid var(--jv-border);
        border-radius: var(--jv-radius-ctl);
        padding: 0 10px;
      }
      .composer input:focus {
        outline: none;
        border-color: color-mix(in srgb, var(--jv-accent) 60%, transparent);
      }
      .talk {
        width: 34px;
        height: 34px;
        border-radius: 50%;
        display: inline-grid;
        place-items: center;
        border: 1px solid var(--jv-border);
        background: var(--jv-surface-raised);
        color: var(--jv-text);
        cursor: pointer;
        flex: none;
        touch-action: none;
        user-select: none;
      }
      .talk svg {
        width: 17px;
        height: 17px;
      }
      .talk[aria-pressed='true'] {
        background: var(--jv-bad);
        color: #fff;
        border-color: transparent;
        box-shadow: 0 0 0 4px color-mix(in srgb, var(--jv-bad) 30%, transparent);
      }
      .talk:disabled {
        opacity: 0.45;
        cursor: default;
      }
      .foot {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        font-size: 12px;
        color: var(--jv-text-muted);
      }
      .foot label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
      }
      .foot input {
        accent-color: var(--jv-accent);
        margin: 0;
      }
      .foot .agent {
        margin-left: auto;
        color: var(--jv-text-faint);
        font-size: 11px;
      }
      .mocknote {
        font-size: 11px;
        color: var(--jv-text-faint);
      }
      .btn.sm {
        min-height: 24px;
        padding: 0 9px;
        font-size: 12px;
      }
    `,
  ];

  private get log(): HTMLElement | null {
    return this.renderRoot.querySelector('.log');
  }

  private onScroll(): void {
    const l = this.log;
    if (!l) return;
    this.stick = l.scrollHeight - l.scrollTop - l.clientHeight < 28;
    if (this.stick && this.unseen) {
      this.unseen = false;
      this.requestUpdate();
    }
  }

  private toBottom(): void {
    const l = this.log;
    if (l) l.scrollTop = l.scrollHeight;
    this.stick = true;
    this.unseen = false;
    this.requestUpdate();
  }

  private lastLen = 0;
  private lastText = '';
  protected override willUpdate(_c: PropertyValues): void {
    const es = this.model?.transcript.entries || [];
    const last = es[es.length - 1];
    const sig = last
      ? `${last.id}:${'text' in last ? last.text.length : ''}:${'status' in last ? last.status : ''}`
      : '';
    if ((es.length !== this.lastLen || sig !== this.lastText) && !this.stick) this.unseen = true;
    this.lastLen = es.length;
    this.lastText = sig;
  }

  protected override updated(): void {
    if (this.stick) {
      const l = this.log;
      if (l) l.scrollTop = l.scrollHeight;
    }
    // the level meter moves on its own while listening
    cancelAnimationFrame(this.meterRaf);
    if (this.model?.phase === 'listening') this.meterRaf = requestAnimationFrame(() => this.requestUpdate());
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.stick = true;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    cancelAnimationFrame(this.meterRaf);
  }

  private submit(e: Event): void {
    e.preventDefault();
    const input = this.renderRoot.querySelector<HTMLInputElement>('.composer input');
    const text = (input?.value || '').trim();
    if (!text) return;
    if (this.model.send(text)) {
      if (input) input.value = '';
      this.draft = '';
      this.toBottom();
    }
  }

  private entry(e: Entry) {
    switch (e.kind) {
      case 'user': {
        const voice =
          e.source === 'voice' ? html`<span class="src" title="Spoken">${unsafeSVG(iconSvg('mic'))}</span>` : nothing;
        const room = e.surface === 'speaker' ? html`<span class="src" title="From a room speaker">⌂</span>` : nothing;
        return html`<div class="u ${e.pending ? 'pending' : ''}" data-entry="user">
          ${voice}${room}<span class="t">${e.text}</span>
        </div>`;
      }
      case 'assistant':
        return html`<div class="a ${e.streaming ? 'streaming' : ''}" data-entry="assistant">${e.text}</div>`;
      case 'tool': {
        const t = TOOL[e.status] || TOOL.running;
        const inner = html`<span class="pill tone-${t.tone}" aria-label=${t.word}>${t.glyph} ${t.word}</span
          ><span class="sum">${e.summary}</span>${
            e.subject ? html`<span class="go">${unsafeSVG(iconSvg('forward'))}</span>` : nothing
          }`;
        return e.subject
          ? html`<button
              type="button"
              class="tool"
              data-tool=${e.callId}
              data-status=${e.status}
              title="Show it (${e.name})"
              @click=${() => this.model.open(e.subject!)}
            >
              ${inner}
            </button>`
          : html`<div class="tool" data-tool=${e.callId} data-status=${e.status} title=${e.name}>${inner}</div>`;
      }
      case 'divider':
        return html`<div class="divider" data-entry="divider">${e.text}</div>`;
      case 'note':
        return html`<div class="note ${e.tone}" data-entry="note">${e.text}</div>`;
    }
  }

  override render() {
    const m = this.model;
    if (!m) return nothing;
    const es = m.transcript.entries;
    const busy = m.phase === 'thinking' || m.phase === 'speaking';
    const listening = m.phase === 'listening';
    const online = m.conn === 'connected';
    const ph = online ? PHASE[m.phase] : { text: m.conn === 'connecting' ? 'Connecting…' : 'Offline', tone: 'off' };
    const retry = m.retryIn();
    return html`
      ${
        m.conn === 'offline'
          ? html`<div class="offline" role="status">
              <span
                >Assistant offline: the assistant server isn't
                reachable${retry != null ? `; trying again in ${Math.ceil(retry / 1000)} s` : '; trying again'}.</span
              >
              <button type="button" class="btn sm" @click=${() => m.retry()}>Retry</button>
            </div>`
          : nothing
      }
      <div class="log" role="log" aria-live="polite" aria-label="Conversation" @scroll=${() => this.onScroll()}>
        ${
          es.length
            ? repeat(
                es,
                (e) => e.id,
                (e) => this.entry(e),
              )
            : html`<div class="empty">
                Ask about the building, or have it do something.<br />
                Hold <kbd>${m.talkKey}</kbd> (or the mic button) to talk.
              </div>`
        }
        ${
          this.unseen
            ? html`<button type="button" class="newmsg" @click=${() => this.toBottom()}>↓ New messages</button>`
            : nothing
        }
      </div>
      <div class="state tone-${ph.tone}" data-phase=${online ? m.phase : m.conn}>
        <span class="dot"></span>
        <span class="txt">${ph.text}${listening ? html` · release to send` : nothing}</span>
        ${listening ? html`<span class="meter"><i style="width:${Math.round(m.level() * 100)}%"></i></span>` : nothing}
        ${
          busy
            ? html`<button
                type="button"
                class="btn sm"
                data-action="stop"
                title="Stop (interrupt)"
                @click=${() => m.stop()}
              >
                ${unsafeSVG(iconSvg('stop'))} Stop
              </button>`
            : nothing
        }
      </div>
      <form class="composer" @submit=${(e: Event) => this.submit(e)}>
        <input
          type="text"
          placeholder=${online ? 'Ask or tell the house…' : 'The assistant is offline'}
          aria-label="Message"
          autocomplete="off"
          enterkeyhint="send"
          .value=${this.draft}
          @input=${(e: Event) => (this.draft = (e.target as HTMLInputElement).value)}
        />
        <button type="submit" class="iconbtn" title="Send (Enter)" aria-label="Send" ?disabled=${!online}>
          ${unsafeSVG(iconSvg('send'))}
        </button>
        <button
          type="button"
          class="talk"
          data-action="talk"
          aria-pressed=${listening}
          ?disabled=${!!m.talkBlocked && !listening}
          title=${m.talkBlocked || `Hold to talk, or click to start and click to stop (hold ${m.talkKey} anywhere)`}
          aria-label=${listening ? 'Stop talking' : 'Talk'}
          @pointerdown=${(e: PointerEvent) => {
            if (e.button !== 0) return;
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            this.pressedAt = performance.now();
            m.talkPress();
          }}
          @pointerup=${() => {
            if (!this.pressedAt) return;
            const ms = performance.now() - this.pressedAt;
            this.pressedAt = 0;
            m.talkRelease(ms);
          }}
          @pointercancel=${() => {
            if (!this.pressedAt) return;
            this.pressedAt = 0;
            m.talkRelease(Infinity);
          }}
          @click=${(e: MouseEvent) => {
            if (e.detail === 0) m.talkToggle(); // Enter / Space: no pointer events
          }}
        >
          ${unsafeSVG(iconSvg('mic'))}
        </button>
      </form>
      <div class="foot">
        <label title="Read replies aloud with this browser's voice">
          <input
            type="checkbox"
            .checked=${m.tts}
            @change=${(e: Event) => m.setTts((e.target as HTMLInputElement).checked)}
          />
          Speak replies
        </label>
        <button
          type="button"
          class="btn sm"
          data-action="reset"
          ?disabled=${!online}
          title="Start a new conversation (the assistant forgets this one's context)"
          @click=${() => m.reset()}
        >
          New conversation
        </button>
        ${m.transcript.agent ? html`<span class="agent">${m.transcript.agent}</span>` : nothing}
      </div>
      ${
        m.mock
          ? html`<div class="mocknote">
              Mock assistant (?assistant=mock): scripted replies, nothing leaves the page
            </div>`
          : nothing
      }
    `;
  }
}

if (!customElements.get('jv-assistant-panel')) customElements.define('jv-assistant-panel', AssistantPanel);
