# jarvis-assistant

The optional voice assistant server for JARVIS: one Claude Agent SDK session behind one WebSocket, acting on Home
Assistant only through a server-enforced policy (allow / confirm / deny). The browser's assistant plugin talks to it;
the static viewer works without it. Design: [`docs/design/voice-assistant.md`](../docs/design/voice-assistant.md);
configuration and operation: [`docs/assistant.md`](../docs/assistant.md).

## Run it without a model

```sh
npm install --prefix server
JARVIS_ASSISTANT_AGENT=scripted \
JARVIS_ASSISTANT_POLICY=server/policy.example.yaml \
  npm --prefix server start
```

That serves `ws://127.0.0.1:8787/assistant/ws` with the **scripted agent** (keyword rules, no model, no network: "turn
on the kitchen pendants", "set the thermostat to 72", "show me the water heater") over the **mock Home Assistant** and
the demo site. Run it from the repository root: paths are relative to the working directory.

With a model: drop `JARVIS_ASSISTANT_AGENT` and set `ANTHROPIC_API_KEY` (API billing, the default). For your own
personal use only, `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` uses your own Pro/Max plan instead; if both are
set, the API key silently wins and the server warns at start-up.

Home Assistant is the mock unless `JARVIS_HA_MODE=live` (with `JARVIS_HA_URL` and a long-lived token of a dedicated
**non-admin** HA user in `JARVIS_HA_TOKEN`). Without a policy file every action is refused.

It binds 127.0.0.1: put it behind the site's reverse proxy at `/assistant/*` (same origin as the viewer, LAN only).

## Configuration

Environment variables (or a JSON file of the same keys in `JARVIS_ASSISTANT_CONFIG`; the environment wins). The full
table is in `docs/assistant.md`.

| Variable                                           | Default                             |
| -------------------------------------------------- | ----------------------------------- |
| `JARVIS_ASSISTANT_HOST` / `_PORT` / `_BASE`        | `127.0.0.1` / `8787` / `/assistant` |
| `JARVIS_ASSISTANT_ORIGINS`                         | empty: same host only               |
| `JARVIS_SITE_DIR`                                  | `examples/demo-site`                |
| `JARVIS_ASSISTANT_POLICY`                          | `<site>/assistant-policy.yaml`      |
| `JARVIS_ASSISTANT_DATA`                            | `./data`                            |
| `JARVIS_ASSISTANT_KNOWLEDGE`                       | none (Read/Grep/Glob off)           |
| `JARVIS_ASSISTANT_AGENT` / `_MODEL` / `_EFFORT`    | `sdk` / `claude-opus-5` / `low`     |
| `JARVIS_HA_MODE` / `_URL` / `_TOKEN`               | `mock`                              |
| `JARVIS_STT_URL` / `_MODEL` / `_KEY` / `_LANGUAGE` | none (transcription off)            |

`SIGHUP` reloads the policy (an invalid file keeps the old one); `SIGINT` / `SIGTERM` stop cleanly.

## Layout

| Path                    | What                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `src/core/`             | dependency-free (Node built-ins only): protocol, config, hub, gate, policy, tools, knowledge, … |
| `src/agent-sdk.ts`      | the Claude Agent SDK agent                                                                      |
| `src/agent-scripted.ts` | the scripted agent                                                                              |
| `src/server.ts`         | HTTP + WebSocket                                                                                |
| `src/app.ts`, `main.ts` | assembly and start-up                                                                           |
| `test/`                 | unit tests (also run by the root `npm test`); `test/integration/` needs this package's install  |

```sh
npm --prefix server run typecheck
npm --prefix server test
```
