# Voice assistant (proposal)

Status: **investigation and design proposal**. Companion to `hud-panels.md` (the panel standard and plugin UI API
this builds on). A v1 now exists: [`../assistant.md`](../assistant.md) documents what was built, which differs
from this proposal in places.

Goal: a house assistant that can replace a commercial smart speaker. One conversation with an agent that

- acts on the building through Home Assistant (lights, scenes, scripts, fans, irrigation, thermostats…) under a
  **server-enforced** safety policy;
- answers everyday questions (weather from Home Assistant, the web) and general-knowledge questions;
- knows the building: the site manifest, the equipment registry, which fixture is where, the Home Assistant mapping;
- drives the 3D view ("show me the water heater" → fly there and highlight it);
- takes voice: click/hold to talk first, a wake word later, and room satellites through Home Assistant's own voice
  pipeline.

Facts below were checked in October 2026 against the Claude Agent SDK 0.3.x (Claude Code 2.1.x), Home Assistant
2026.9 and the projects' current docs. Things that move fast (subscription terms, rate limits, wake-word ports) are
marked as such.

## 1. Recommendation in one page

```
 browser (JARVIS)                         assistant server (Node, Agent SDK)                 Home Assistant
┌───────────────────────────┐   WS     ┌──────────────────────────────────────────┐  WS    ┌─────────────────┐
│ assistant plugin          │◀───────▶│ session manager (one rolling session)     │───────▶│ states, services│
│  dock panel: transcript   │  JSON    │ query() in streaming-input mode           │  REST  │ weather, history│
│  talk button / hold key   │  events  │ tools (in-process MCP):                   │        └─────────────────┘
│  confirm modal            │          │   ha.*      → policy gate → HA            │                ▲
│  viewer RPC: fly/select/  │  POST    │   site.*, registry.*, memory.*            │                │ conversation
│   highlight/layers        │  audio   │   view.*    → forwarded to the browser    │◀───────────────┘ agent bridge
│  TTS playback, barge-in   │────────▶│ /transcribe → Whisper-compatible server   │  HTTP   (room satellites,
└───────────────────────────┘          │ /speak      → TTS server (v2)             │          wake word on device)
                                       └──────────────────────────────────────────┘
```

- **A small `jarvis-assistant` server** (Node/TypeScript, in this repo as `server/`, optional) runs the **Claude
  Agent SDK directly**. herdctl is not needed (§3).
- The browser talks to it over **one WebSocket** (streamed text, tool activity, viewer commands, confirmations,
  interrupts) plus a plain **HTTP POST for audio** (§2.2).
- **Home Assistant tools are custom tools over HA's websocket API**, gated by a declarative, site-supplied **policy
  with three tiers** (allow / confirm / deny) enforced in the tool handler, not by the prompt (§5). HA's MCP server
  is not the primary path: its only boundary is entity exposure and it has no confirmation step.
- **Voice v1**: hold-to-talk in the browser → the assistant server → any OpenAI-compatible transcription endpoint
  (faster-whisper/Speaches, whisper.cpp, Home Assistant's Wyoming Whisper through a shim). TTS v1 is the browser's
  `speechSynthesis`; v2 a local TTS server with sentence streaming.
- **Wake word in the browser is feasible but niche** (openWakeWord's `hey_jarvis` on ONNX Runtime Web, front tab on
  a desktop or wall tablet). **Replacing smart speakers around the house is Home Assistant's job**: voice satellites
  with on-device wake word, Wyoming STT/TTS, and a conversation agent that forwards to the same assistant server (§8).
- **One rolling conversation** shared by every surface, with automatic compaction and a daily soft reset that
  carries a summary into memory (§9).

## 2. Architecture

### 2.1 Why a server

The agent cannot run in the browser: the Agent SDK runs the Claude Code harness as a subprocess, holds a model
credential that must never reach a browser, and needs a Home Assistant credential of its own (the viewer's HA login is
the logged-in person's, which can do anything in HA). JARVIS stays a static site; the assistant is an **optional
companion service**. Without it the plugin doesn't appear (`when: () => assistant reachable`).

Options considered:

| Option                                                | Verdict                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`jarvis-assistant`: Node + Agent SDK** (recommended) | Smallest thing that does the job. One process, one agent, in-process tools. Ships with the public project; any JARVIS site can run it.                                                                                                                                                        |
| herdctl agent + its web connector                     | herdctl's value is fleets, schedules, Docker isolation, Discord/Slack and a dashboard (§3). Its web chat is its own UI, not a JARVIS panel, so we'd still write the bridge, the viewer RPC and the HA policy, and take on a large dependency for features we don't use.                        |
| Home Assistant's Anthropic conversation integration   | API key only; HA runs the tool loop with only the Assist API's intents; no building knowledge, no viewer control, no custom safety tiers. Fine as a fallback, not as the assistant.                                                                                                             |
| Plain Messages API + tool runner                      | Viable and lighter (no subprocess). Loses the SDK's sessions/resume, compaction, hooks, built-in web search/fetch and file tools for the knowledge folder, and, for a self-hosted personal install, subscription authentication (§4). Keep as the fallback if the SDK's start-up cost bites. |

### 2.2 Browser ↔ server protocol

**WebSocket** (`/assistant/ws`), because the traffic is two-way: the server streams text and tool events, and also
asks the browser to do things (fly the camera, confirm an action) and waits for the answer; the browser sends
interrupts (barge-in) mid-turn. SSE would need a second channel for all of that.

Messages are JSON with a `type`:

| Direction        | `type`                                                        | Payload                                                                                                    |
| ---------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| client → server  | `hello`                                                       | client id, capabilities (`viewer`, `tts`), current view context (room, storey, selected subject)          |
| client → server  | `say`                                                         | text (typed or transcribed), `source: 'panel'`, the view context at the time                               |
| client → server  | `interrupt`                                                   | stop the current turn (calls `Query.interrupt()`); also stops TTS                                           |
| client → server  | `confirm.reply`                                               | `{ id, approved }`                                                                                         |
| client → server  | `view.result`                                                 | `{ id, ok, detail }` for a viewer command                                                                  |
| server → client  | `turn.start` / `turn.end`                                     | turn id, source (panel / room satellite / …), usage                                                       |
| server → client  | `text.delta`                                                  | streamed assistant text (`includePartialMessages`)                                                          |
| server → client  | `tool`                                                        | tool name, a one-line human summary ("Turning off Kitchen pendants"), status (running / done / refused)    |
| server → client  | `confirm.request`                                             | `{ id, summary, detail, risk, expiresAt }`: shown as the standard confirm modal                             |
| server → client  | `view.command`                                                | `{ id, op: 'fly' \| 'select' \| 'highlight' \| 'layer' \| 'clear', args }`                                  |
| server → client  | `transcript`                                                  | the rolling transcript on connect (last N turns), so a reload or second screen catches up                  |

Audio goes as **HTTP `POST /assistant/transcribe`** (multipart `file`), same contract as Paddock's dictation: the
browser records the whole utterance with `MediaRecorder` (`audio/webm;codecs=opus`, falling back to
`audio/ogg;codecs=opus`, then `audio/mp4` for Safari), the server forwards it to an OpenAI-compatible
`POST {endpoint}/audio/transcriptions` and returns `{ text }`, and the client then sends `say`. Keeping audio off the
WebSocket keeps the protocol text-only and lets the transcription endpoint be swapped freely.

### 2.3 Where it runs, exposure, auth

- **Anywhere on the LAN** with network access to Home Assistant and the transcription server: the same host as the
  static site (a second container), or an existing agent box. Serve it **under the same origin** through the reverse
  proxy (`/assistant/*` → the server), so there's no CORS and the HTTPS certificate the microphone needs (secure
  context) is already there.
- **LAN-only.** The reverse proxy refuses non-LAN clients for `/assistant/*`. Nothing is published to the internet.
- **Auth: reuse the person's Home Assistant login.** The viewer already holds an HA access token from HA's OAuth
  flow. On `hello` the client sends it; the server validates it by calling HA (`auth/current_user` over the
  websocket, or `GET /api/` with the bearer token) and learns **who** is talking (HA user id and name, admin or not).
  No second user database; per-person memory and per-person policy come for free (§9). The token is used only to
  identify the user and is not stored.
  v1 does this, and adds access codes for devices without a Home Assistant login (a wall tablet, a satellite bridge);
  either way the surface comes from the server's configuration, not the client: see
  [the assistant's authentication](../assistant.md#authentication).
- The server itself acts on HA with **its own long-lived token for a dedicated, non-admin HA user** (e.g.
  "JARVIS assistant"), so every action shows up in HA's logbook under that user, and revoking it is one click.
- The model credential lives only in the server's environment (§4).

### 2.4 The client plugin

A **feature plugin** `assistant` using the panel standard:

| Contribution              | Region            | Content                                                                                                                                                                                                 |
| ------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rail button + dock panel **Assistant** | Dock    | The rolling transcript (newest at the bottom, auto-scroll unless the user scrolled up), tool activity as compact rows (`list` block with status pill; a row with a subject flies there), a text box, the talk button |
| **Talk button**           | Panel footer + status strip | Hold to talk (press-and-hold, or click to start / click to stop); states: idle · listening (level meter) · transcribing · thinking · speaking. Key: hold `J` (registered via `ctx.keys`)                |
| Status item               | Status strip      | Connector-style dot: assistant online / busy / offline. Click opens the panel                                                                                                                           |
| Confirm                   | Modal             | `ctx.confirm()` for `confirm.request`, with the action's plain-language summary and a countdown                                                                                                         |
| Viewer RPC                | Scene             | Executes `view.command` through `ctx.scene.fly(subject)`, `ctx.scene.select(subject)`, `ctx.inspector.open(subject)`, a highlight overlay, and the status toggles                                       |
| Toasts                    | Toasts            | "Turned off 4 lights", errors, "assistant offline"                                                                                                                                                      |

Pointer lock: holding `J` while walking talks without releasing the lock; the panel needn't be open (the status item
shows the state). The panel is a Lit component behind `render(el)`, since a streaming chat transcript is bespoke UI.

## 3. herdctl, `@herdctl/core`, or the Agent SDK directly

What herdctl adds over the bare SDK: a fleet config (`herdctl.yaml` + per-agent YAML), session discovery, naming and
adoption, schedules (interval / cron / webhook), a CLI runtime alongside the SDK runtime, Docker isolation with
credential injection and refresh, Discord and Slack connectors, a web dashboard with chat, and GitHub work sources.
For subscription auth on the host it does nothing special: the spawned Claude Code reads `CLAUDE_CODE_OAUTH_TOKEN` or
its `.credentials.json` itself (herdctl only handles refresh when injecting credentials into containers).

The assistant is **one agent, one session, one custom client**. Everything it needs (streaming input, resume,
in-process MCP tools, `canUseTool`, hooks, interrupt, compaction) is in the SDK's `query()`. **Use the Agent SDK
directly.** Revisit herdctl only if the assistant grows scheduled jobs ("every morning, tell me the pool chemistry")
that need its scheduler, or a Discord/Slack front end; even then `@herdctl/core` can be added beside the session
manager rather than under it.

SDK settings for the session (0.3.x names):

```ts
const q = query({
  prompt: inputQueue, // AsyncIterable<SDKUserMessage>: streaming-input mode, one long-lived process
  options: {
    model: config.model, // a fast model by default; see §4.3
    systemPrompt: buildSystemPrompt(site), // custom, short; not the claude_code preset
    settingSources: [], // ignore any CLAUDE.md / settings on the host
    tools: ['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob'], // built-ins; no Bash, Write, Edit
    mcpServers: { house: createSdkMcpServer({ name: 'house', tools: [...haTools, ...siteTools, ...viewTools, ...memoryTools] }) },
    allowedTools: ['mcp__house__*', 'WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob'],
    permissionMode: 'dontAsk', // anything not pre-approved is denied, never prompted
    canUseTool: guard, // defence in depth: Read/Grep/Glob only under the knowledge folder
    hooks: { PreToolUse: [audit], PostToolUse: [audit], PreCompact: [saveSummaryToMemory] },
    includePartialMessages: true,
    resume: state.sessionId, // survive server restarts
    cwd: knowledgeDir,
  },
});
```

Notes:

- **Streaming-input mode** keeps one Claude Code process warm, so a turn doesn't pay process start-up (a second or
  more). New utterances are pushed into `inputQueue`; turns are serialised.
- `Query.interrupt()` implements barge-in; `Query.setModel()` can switch models for a heavy question.
- When the process dies (crash, restart), resume from the stored session id.

## 4. Model access: API key or a Claude subscription

### 4.1 What the SDK supports

- `ANTHROPIC_API_KEY`: pay-as-you-go API billing. **The default for the public project**, and the only option for
  anyone running JARVIS as a product or for other people.
- `CLAUDE_CODE_OAUTH_TOKEN`: a long-lived (one-year) OAuth token from `claude setup-token`, tied to the person's own
  Pro/Max plan. The Agent SDK's bundled Claude Code reads it from the environment; no `.credentials.json` or refresh
  logic is needed. (Verified: an SDK `query()` with only this variable set authenticates with `apiKeySource: "none"`,
  i.e. the subscription.) Precedence trap: if `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is also set, it wins and
  usage is billed to the API.
- `claude login` credentials in `$CLAUDE_CONFIG_DIR/.credentials.json`: also works; tokens refresh themselves. The
  setup-token route is simpler for a service.

### 4.2 What the terms allow (as of October 2026; check again before relying on it)

From Anthropic's Claude Code legal and compliance page, the Agent SDK overview and the support article on using the
Agent SDK with a Claude plan:

- **Allowed:** a person using **their own** subscription with the unmodified Claude Code / Agent SDK, for their own
  use. Anthropic documents `claude setup-token` for scripts, and its support article says Agent SDK use "in your own
  projects" draws on the plan's usage limits.
- **Not allowed without Anthropic's approval:** a product that offers Claude.ai login to its users, routes other
  people's requests through someone's Pro/Max credentials, or collects or stores their Claude credentials. So JARVIS
  **must not** ship a "sign in with Claude" button or a shared hosted assistant on a subscription.
- **Unclear / watch:** limits "assume ordinary, individual usage". An always-listening assistant is mostly idle and its
  turns are small, so it should look ordinary, but heavy automation (polling, scheduled agents) is what the weekly
  limits were introduced to curb. A 2026 plan to move SDK usage to a separate monthly credit was paused; Anthropic
  says it will give notice before changing that. Anthropic has blocked tools that **impersonate** the Claude Code
  client with subscription tokens; using the real SDK is not that.
- A household (several people talking to one assistant on one person's plan) is a reasonable reading of personal use
  but is not explicitly addressed.

**Project policy:** the server reads `ANTHROPIC_API_KEY` by default. The README documents that a self-hoster may
instead set `CLAUDE_CODE_OAUTH_TOKEN` from their own `claude setup-token` for personal use, links Anthropic's terms,
and says that this is the installer's responsibility. The project never handles anyone else's Claude credentials.

### 4.3 Usage and rate limits

- A command ("turn off the kitchen lights") is one short turn: a few thousand input tokens, mostly cached system
  prompt and tool definitions, and one or two tool calls. Questions with web search are a few times that. Even 100–200
  turns a day is light next to coding-agent use; the 5-hour and weekly windows are unlikely to bind.
- Keep the system prompt and tool list **stable** (no timestamps in them; time goes in the turn) so prompt caching
  works, and keep the rolling session small (compaction, daily reset).
- **Latency matters more than depth** for voice: default to a fast model at low effort for the session; let the
  agent (or the person: "think hard about…") switch to a stronger model for one turn with `setModel`.
- When a limit is hit the SDK returns a rate-limit result: the server says so out loud ("I've hit my usage limit;
  basic light commands still work"), and the plugin's **local fallback** still handles the scripted controls that the
  HUD already exposes.

## 5. Home Assistant tools and the safety model

### 5.1 Options

| Option                                                       | For                                                                                                                                         | Against                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) **HA's MCP server** (`mcp_server`, `/api/mcp`, Streamable HTTP) | Zero code; Assist intents (`HassTurnOn`, `HassLightSet`, `HassClimateSetTemperature`, `HassGetWeather`, `GetLiveContext`…) with HA's own name/area matching | The **only** boundary is entity exposure: no tiers, no confirmation, no PIN. `HassTurnOff` on an exposed lock unlocks it; `HassTurnOn` on a cover opens it. Intent-level only (no history, no arbitrary services, no attributes). Tool names change between HA releases. |
| (b) **Custom tools over HA's websocket API** (recommended)   | Full control: our own policy tiers and confirmation, state and history reads, scripts with fields, attributes, weather forecasts, areas; results can be summarised compactly | We write the entity resolution (names, areas, the site's mapping) and keep it in step with HA                                                                                                                                                                  |
| (c) **Reuse the viewer's allowlist** (`policy.ts`)           | Already tested; same "refuse anything not listed" stance                                                                                    | Too narrow for an assistant (lights, switches, scenes, scripts only) and too coarse in one place: **every** `switch.*` passes, including switches that power network gear, security recording, pumps or heaters                                               |

**Recommendation: (b), with the policy as data, sharing the pure policy functions with the viewer.** Use (a) only as
an optional, read-only aid later (for example `GetLiveContext` for "what's on downstairs?"), never as the action path.

### 5.2 Tools

All tools live in the in-process MCP server `house`. HA access is the assistant's own HA user over one websocket.

| Tool                         | Does                                                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ha.find`                    | Resolve words to entities: name, alias, area, domain, the site's fixture map ("the island pendants") and registry links. Returns ids with friendly names, area, state, tier |
| `ha.state`                   | Current state and selected attributes of up to N entities                                                                                                                  |
| `ha.history`                 | Summarised history for an entity and window ("when did the garage freezer last go above 10 °F?")                                                                           |
| `ha.weather`                 | `weather.get_forecasts` (a service that returns data and changes nothing) for the site's weather entity; daily or hourly                                                    |
| `ha.act`                     | Perform an action: `{ entity_id(s), action, data }` → policy → allow, ask for confirmation, or refuse. The **only** way to change anything                                  |
| `ha.scenes` / `ha.scripts`   | List what's runnable with descriptions (from HA script/scene metadata)                                                                                                     |

### 5.3 Policy: three tiers, enforced in code

The site supplies `assistant-policy.yaml`. Rules match on domain, service, entity id (globs), device class and
area; the **first matching rule wins** and anything unmatched is **denied**. Data bounds clamp or refuse values.
The sketch below predates v1, whose format differs in details (bounds refuse and never clamp; every allow and confirm
rule names its services, and `'*'` is for deny rules only): see [the policy file](../assistant.md#the-policy-file).

```yaml
# site/assistant-policy.yaml (sketch)
default: deny
rules:
  # never, whoever asks and however it's phrased
  - { deny: { domain: lock, service: unlock } }
  - { deny: { domain: alarm_control_panel, service: [alarm_disarm, alarm_arm_custom_bypass] } }
  - { deny: { domain: cover, device_class: garage, service: open_cover } } # closing is fine (below)
  - { deny: { entity: ['switch.*_record*', 'switch.*_privacy*', 'switch.*network*'] } } # cameras, network power
  - { deny: { domain: [homeassistant, hassio, automation, update, button], service: '*' } } # restarts, updates, automations
  # ask first
  - { confirm: { domain: cover, device_class: garage, service: close_cover } }
  - { confirm: { domain: lock, service: lock } }
  - { confirm: { domain: climate, service: [set_temperature, set_hvac_mode] }, bounds: { temperature: [65, 82] } }
  - { confirm: { entity: [switch.water_heater*, switch.*pump*] } }
  - { confirm: { domain: script, entity: [script.goodnight, script.bedtime*] } } # broad scripts
  - { confirm: { domain: [valve, siren] } }
  # just do it
  - { allow: { domain: light, service: [turn_on, turn_off, toggle] }, bounds: { brightness_pct: [1, 100] } }
  - { allow: { domain: [scene, script], service: turn_on } }
  - { allow: { domain: fan, service: [turn_on, turn_off, set_percentage] } }
  - { allow: { domain: media_player, service: [media_pause, media_play, volume_set] } }
  - { allow: { entity: ['switch.*fountain*', 'switch.zone_*'], service: [turn_on, turn_off] }, limits: { max_minutes: 60 } }
  # lights only, bulk: more than N entities in one call needs confirmation
bulk: { confirm_over: 12 }
```

Enforcement:

- `ha.act` evaluates the policy **before** anything reaches HA. The model sees only the outcome: `done`,
  `refused: <reason>` or `awaiting confirmation`. There is no tool for raw service calls, and the SDK's built-in
  `Bash` is not available, so there is no way around the gate.
- **Confirmation is server-side.** A `confirm` action is parked with a random id and a 30 s expiry; the server sends
  `confirm.request` to the surface the request came from. Only `confirm.reply { approved: true }` (a click in the
  modal), or, on voice-only surfaces, a **next utterance the server itself matches** against a short fixed list
  ("yes", "do it", "confirm"), executes it. The model cannot approve its own request: approval never passes through a
  tool call or model output.
- Bounds are checked in code (a setpoint of 50 °F is refused, not "probably fine").
- **Identity-aware**: rules may say `who: admin` (HA admin users only) or `surface: panel` (not from a room
  satellite: e.g. closing the garage only from a screen, where the person can see the door).
- Everything the assistant does is logged (an audit file with who, surface, utterance, tool, decision) and appears in
  HA's logbook under the assistant's own HA user.
- The assistant's HA user is non-admin; **on top of that**, defence in depth on the HA side: anything never allowed
  can be made impossible for that user where HA supports it (e.g. locks managed by a separate integration account).
- The viewer's existing `policy.ts` stays as it is for the HUD; the shared pieces (domain-of, entity matching) move
  to a small shared module both use.

## 6. Context, knowledge and memory

### 6.1 System prompt (stable, small)

Generated at start-up from the site, roughly 1–2 k tokens:

- who it is (the house's assistant; terse, spoken-style answers; units and time zone from the manifest);
- the building in outline: storeys, rooms (from the manifest and the model's room list), main systems;
- how to act: resolve with `ha.find` before `ha.act`; never guess entity ids; read back what it did; for anything
  refused, say why; prefer showing over describing when a viewer is attached;
- the safety stance in one paragraph (the policy enforces it; the prompt only explains it, so the model can describe
  refusals well).

The current time, the speaker, the surface (panel or room) and the viewer context (room, selected object) go in each
**turn**, not in the system prompt, so the cache holds.

### 6.2 Knowledge tools

| Tool                         | Source                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `site.rooms`                 | Manifest and model: rooms with storey, area, neighbours                                                                        |
| `registry.search` / `.get`   | The equipment registry (make, model, location, specs, connections, documents, maintenance); search by text, category, room    |
| `site.fixtures`              | `ha_map`: model fixtures ↔ entities, wall-switch ids, confidence                                                              |
| `site.devices`               | `ha_devices`: HA devices placed in the model, health entities                                                                   |
| `Read` / `Grep` / `Glob`     | A **knowledge folder** the site provides (manuals, notes, warranty PDFs as text), read-only, path-restricted by `canUseTool`   |
| `WebSearch` / `WebFetch`     | General questions, product manuals, news                                                                                       |

The registry and site files are loaded from the same site folder the viewer uses, so the assistant and the viewer
always agree on ids: a registry hit carries a **subject** (`pins:<id>`) the viewer can fly to.

### 6.3 Memory

A small memory folder in the assistant's data directory, same shape as Paddock's: one Markdown file per fact with a
`name`, `description` and type, plus a `MEMORY.md` index that is loaded into the first turn of each session. Tools
`memory.save`, `memory.search`, `memory.forget`. Per-person memories live under `memory/<ha-user-id>/`, house-wide
ones under `memory/house/`. Uses: preferences ("I like the lounge at 40 % in the evening"), names people use for
things ("the big lamp" = a given entity), and the daily summary (§9).

### 6.4 Tools that drive the viewer

| Tool              | Client op                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `view.fly`        | Fly to a subject (registry item, fixture, room, plate, device) and open it in the inspector        |
| `view.highlight`  | Pulse one or more subjects for a few seconds ("which lights are on upstairs?" → highlight them)    |
| `view.layer`      | Toggle a layer (pins, faults, plates, cutaway, upper storey, blueprints)                           |
| `view.where`      | Where the viewer is and what's selected (also sent with each turn)                                 |

The server forwards these as `view.command` to the surface that asked and waits up to a few seconds for
`view.result`. When the request came from a room satellite (no viewer), the tools return
`no viewer attached` and the agent answers in words; if a viewer is open elsewhere (a wall tablet), the policy can
allow "show it on the kitchen screen" as a later feature.

## 7. Voice in the browser

### 7.1 Speech-to-text

| Option                                                                                     | Notes                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Record → server → OpenAI-compatible transcription** (recommended)                         | Works in every browser. faster-whisper (e.g. Speaches), whisper.cpp's server, or a hosted endpoint. A short command with a `base`/`small` model on a CPU box: well under a second to transcribe; `large-v3-turbo` on a GPU for quality. Configure endpoint, model, language, key (the same settings Paddock uses). |
| Web Speech API                                                                             | Chrome sends audio to Google by default (newer Chrome can recognise on-device when a language pack is installed); Safari supports it; **Firefox doesn't**. Useful only as a live-captions nicety.                               |
| Whisper in the browser (transformers.js, WebGPU)                                           | ~200 MB model download per device, battery-hungry on tablets. Not worth it with a LAN server.                                                                                                                                    |
| Home Assistant's Wyoming Whisper                                                            | Speaks Wyoming, not HTTP; reachable through HA's STT API or a small shim. Use it when the house already runs it, to have one STT service.                                                                                          |

Hold-to-talk records the whole utterance (no streaming STT needed for commands of a few seconds). Silence detection
(Web Audio level meter) auto-stops click-to-talk after ~1 s of quiet.

### 7.2 Text-to-speech and barge-in

- **v1: `speechSynthesis`** (no setup; quality depends on the OS; poor on Linux). Speak sentence by sentence as text
  streams in.
- **v2: a local TTS server** with an OpenAI-compatible `POST /v1/audio/speech`: Kokoro (Kokoro-FastAPI, or Speaches,
  which also does STT), or Piper (now GPL-3 upstream; fine as a separate service). The server splits the streamed
  answer at sentence boundaries and sends each sentence for synthesis as soon as it's complete, so the first audio
  plays within ~0.5 s of the first sentence. Spoken output uses a **speech rendering** of the answer (no Markdown,
  numbers and units spelled out); the panel shows the full text.
- **Barge-in:** pressing talk (or the wake word) while it's speaking stops playback immediately and sends
  `interrupt`; the new utterance starts a new turn. With open speakers and a hot mic, use `getUserMedia`'s
  `echoCancellation: true` so the assistant doesn't hear itself.

### 7.3 Wake word in the browser

| Engine                                                  | Verdict                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **openWakeWord** on ONNX Runtime Web (WASM)              | **Feasible.** Pre-trained `hey_jarvis` exists. Three small ONNX models (mel spectrogram, embedding, keyword) on 80 ms frames of 16 kHz audio; a Raspberry Pi 3 core runs 15–20 models, so a browser Worker uses a few percent of one core. A community WASM port exists (young; treat as a starting point). Custom words can be trained with the project's synthetic-speech pipeline. **Licence:** code Apache-2.0, **pre-trained models CC BY-NC-SA 4.0**: fine for personal use; JARVIS must not bundle them, so the site downloads them at set-up. |
| Picovoice Porcupine Web                                 | Has a built-in "Jarvis" keyword, but needs a Picovoice AccessKey and **Picovoice ended its free tier in mid-2026**. Ruled out.                                                                                                                                                                                                                            |
| microWakeWord                                          | TFLite Micro models built for ESP32-S3 (including `hey_jarvis`); no maintained browser runtime. Use it on satellites, not in the browser.                                                                                                                                                                  |

Constraints that decide where a browser wake word makes sense:

- `getUserMedia` needs a **secure context** (HTTPS, a real certificate on the LAN name) and a one-time permission
  grant per origin and device.
- Capture in an **AudioWorklet**, infer in a **Worker**; the mic indicator is on the whole time.
- **Background tabs:** desktop Chrome throttles timers in background tabs but keeps audio pipelines running while the
  mic is live; behaviour without audio playing should be tested per browser. **Mobile browsers suspend background
  tabs**, so on phones the wake word works only while the page is in front.
- So: **a dedicated screen** (a wall tablet in kiosk mode, the desk computer with JARVIS open) works well; "a tab
  somewhere" does not, and neither replaces smart speakers in every room.

Plan: optional, off by default, per device (`prefs`), with a sensitivity slider and a visible "listening for wake
word" state in the status strip.

## 8. Room voice through Home Assistant's Assist pipeline

To replace smart speakers in every room, use Home Assistant's voice stack and put **the same assistant** behind it:

```
 satellite (on-device wake word) → HA Assist pipeline: STT (Wyoming faster-whisper) → conversation agent ─┐
                                                       TTS (Wyoming Piper/Kokoro) ← streamed reply ←──────┤
                                                                                                         ▼
                                                                         jarvis-assistant  POST /assistant/converse
```

- **Satellites:** Home Assistant Voice Preview Edition (ESP32-S3 with an XMOS audio front end; on-device
  microWakeWord with "Hey Jarvis" among the stock words), ESP32-S3-BOX-3, or any ESPHome/Wyoming satellite. Wake
  word runs on the device; audio streams to HA only after it fires.
- **STT/TTS:** Wyoming faster-whisper and Piper (add-ons or containers), or the same OpenAI-compatible servers the
  browser path uses, through Wyoming shims. One set of voice services for the house.
- **Conversation agent bridge**, three ways, simplest first:
  1. **Webhook Conversation** (community integration): HA posts each utterance to a URL and can stream the reply
     back so TTS starts on the first sentence. No code in HA.
  2. A **custom `ConversationEntity`** shipped with JARVIS (`integrations/home-assistant/jarvis_conversation/`):
     `_async_handle_message` posts text, the conversation id, the satellite's device and **area** to the assistant
     and returns the reply; sets `continue_conversation` when the reply ends in a question (HA then listens again
     without the wake word, which is also how spoken confirmations work).
  3. An OpenAI-compatible façade on the assistant (`/v1/chat/completions`) used by the community "OpenAI-compatible
     conversation" integrations. Least good: they send HA's own tools and expect tool calls back.
- **HA's own fast path stays first:** with "prefer handling commands locally" on, HA handles plain intents ("turn
  off the kitchen lights") itself in milliseconds and only falls through to the assistant for everything else. That
  keeps everyday commands instant and off the model budget.
- The room comes from the satellite's area, so "turn the lights off" means **this** room.
- Voice-only surfaces get stricter policy (`surface: satellite` rules) and spoken confirmation.

**Browser-only voice vs HA satellites:**

|                         | Browser (JARVIS panel)                                      | HA satellites                                             |
| ----------------------- | ----------------------------------------------------------- | --------------------------------------------------------- |
| Where                   | The screen you're at                                        | Every room                                                |
| Wake word               | Front tab / kiosk only                                      | Always, on device, low power                              |
| Audio quality           | Laptop / tablet mic                                         | Far-field array with echo cancellation                    |
| 3D answers              | Yes (fly, highlight)                                        | Words only (or "show it on the screen")                   |
| Cost                    | None                                                        | Roughly the price of a smart speaker per room             |
| Fast local commands     | Via the assistant (model round trip)                        | HA's local intents, no model                              |

**Do both, one agent.** The panel is the 3D-aware chat; satellites are the house's ears. Both feed the same session
(§9), so "what did I just ask in the kitchen?" works at the screen.

## 9. One conversation

- **One rolling session per household**, shared by every surface; each turn is tagged with the speaker (HA user, or
  "unknown" from a satellite), the surface and the room. Turns are serialised (a queue; a satellite turn arriving
  mid-turn waits, or interrupts if it's the same surface).
- **Compaction:** the SDK compacts automatically as the context fills; a `PreCompact` hook first writes a short
  summary to `memory/house/` so nothing important lives only in the transcript.
- **Soft reset:** after a quiet period (default 4 h idle, or a fixed time at night) the server starts a new SDK
  session: yesterday's summary goes into memory, the panel shows a divider ("New day"), and the old transcript stays
  scrollable (read-only) for a week. A "New conversation" item in the panel's ⋯ menu does the same on demand.
- **Per-person** comes from memory and policy, not separate sessions: the speaker is known on the panel (HA login);
  satellites can't tell voices apart, so they act as "household" with satellite rules.
- **In the HUD:** the dock panel shows the shared transcript with a small source badge per turn (🖥 panel,
  room name for satellites); a second open screen sees the same stream live.

## 10. Phased plan

| Phase                                           | Scope                                                                                                                                                                                                                                                                                                                                                  | Effort (focused days) | Main risks                                                                                                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **v1: talk to the house from JARVIS**           | `server/`: session manager (streaming input, resume, compaction), WS protocol, HA websocket client with its own user, `ha.find/state/weather/act` with the policy file and server-side confirmation, `site.*` and `registry.*` tools, memory, audit log, `/transcribe` proxy. Client: assistant plugin (dock panel, talk button, hold key, confirm modal, `speechSynthesis`). Docs and a sample policy. Unit tests for the policy and the confirmation flow; an e2e test against `?ha=mock` and a mocked model. | 8–12                  | Entity resolution quality (names/areas); SDK process start-up and per-turn latency for voice; subscription terms changing; getting the policy defaults right (deny-by-default makes it feel weak at first). |
| **v2: show me, and sound good**                 | `view.*` tools and the client RPC (fly, select, highlight, layers); viewer context in each turn; server TTS with sentence streaming and barge-in; speech rendering of answers; `ha.history`; per-person memory; model switching for hard questions; daily soft reset UI.                                                                                    | 6–9                   | Depends on the plugin API (`ctx.scene`, `ctx.inspector`) landing; TTS voice quality on CPU; echo with open speakers.                                                                                              |
| **v3: wake word and rooms**                     | Browser wake word (openWakeWord on ORT-Web in a Worker, opt-in per device, kiosk mode); HA bridge (Webhook Conversation first, then the custom `ConversationEntity` with area and `continue_conversation`); satellite policy tier and spoken confirmation; Wyoming STT/TTS shared with the browser path; satellites rolled out room by room.                    | 6–10 (+ hardware)     | False wakes and missed wakes; the young WASM port; model licence (download at set-up); HA bridge streaming support; spouse/household acceptance vs the speaker it replaces (music, timers, shopping lists: keep HA's intents for those). |

## 11. Open questions

1. **Model default for voice:** a fast model at low effort with on-demand escalation (proposed), or a stronger model
   always (better answers, slower)?
2. **Confirmation tier contents:** which actions should be "just do it" vs "ask first" (thermostat changes? the
   bedtime scripts? irrigation runs?), and should closing a garage door be allowed from a room satellite at all?
3. **Speaker identity on satellites:** accept "household" (proposed), or invest in voice identification later?
4. **Where the server lives:** next to the static site, or on an existing agent host?
5. **Music, timers, alarms, shopping lists:** keep those on HA's built-in intents (proposed), or route everything
   through the assistant?
6. **Transcripts and privacy:** how long to keep the rolling transcript and the audit log; whether to keep audio at
   all (proposed: never store audio).
