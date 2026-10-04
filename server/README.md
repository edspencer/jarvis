# jarvis-assistant

The optional voice assistant server for JARVIS (**draft v1**, not released): one Claude Agent SDK session behind one
WebSocket, acting on Home Assistant only through a server-enforced policy (allow / confirm / deny). The browser's
assistant plugin talks to it; the static viewer works without it.

Everything about running it (configuration, the reverse proxy, model credentials and their terms, the policy file) is
in [`docs/assistant.md`](../docs/assistant.md); the design is [`docs/design/voice-assistant.md`](../docs/design/voice-assistant.md).

## Run it without a model

```sh
cd server
npm install
JARVIS_ASSISTANT_AGENT=scripted npm start
```

The scripted agent (keyword rules, no model, no network) over the mock Home Assistant and the demo house with the
example policy, at `ws://127.0.0.1:8787/assistant/ws`. The demo house and `policy.example.yaml` are found from the
server's own files; paths you set are resolved against the working directory (`server/` under `npm start`).

With a model: drop `JARVIS_ASSISTANT_AGENT` and set `ANTHROPIC_API_KEY` (the default). `CLAUDE_CODE_OAUTH_TOKEN` from
`claude setup-token` is for personal use of your own Pro/Max plan only; read
[the caveats](../docs/assistant.md#model-access-and-its-caveats) first. If both are set, the API key silently wins.

`SIGHUP` reloads the policy (an invalid file keeps the old one); `SIGINT` / `SIGTERM` stop cleanly.

## Layout

| Path                    | What                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `src/core/`             | dependency-free (Node built-ins only): protocol, config, hub, gate, policy, tools, knowledge, … |
| `src/agent-sdk.ts`      | the Claude Agent SDK agent                                                                      |
| `src/agent-scripted.ts` | the scripted agent                                                                              |
| `src/server.ts`         | HTTP + WebSocket                                                                                |
| `src/app.ts`, `main.ts` | assembly and start-up                                                                           |
| `policy.example.yaml`   | an example policy for the demo house (not a recommended default)                                |
| `test/`                 | unit tests (also run by the root `npm test`); `test/integration/` needs this package's install  |

```sh
npm run typecheck
npm test
```
