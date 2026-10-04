---
'jarvis': minor
---

A voice assistant, optional and off unless a site enables it (`plugins.assistant.server`, a same-origin path such as
`/assistant`). The browser plugin adds an Assistant panel (Shift-M) with the streamed transcript, tool chips that fly
to what they name, a text box and a mic button; hold M anywhere to talk (a phone holds the mic button), answer the
assistant's confirmations in a dialog with a countdown, and hear replies through the browser's speech synthesis. It
can fly the view to a subject, highlight things and switch view layers. `?assistant=mock` scripts a fake server in the
page. The plugin's code is downloaded only on sites that enable it.

The server, `server/` (`jarvis-assistant`, a separate Node 22 package that is not in the image), runs one rolling
Claude Agent SDK session behind one WebSocket, with house tools over Home Assistant, the site's registry, rooms and
fixture map, and a small memory folder; web search and fetch (never to the LAN) and read-only files from a knowledge
folder; no shell. `POST /assistant/transcribe` forwards audio to any OpenAI-compatible transcription endpoint. Models:
Claude Sonnet 5 by default, Claude Opus 5.5 for a hard question, both configurable. Credentials: `ANTHROPIC_API_KEY`,
or `CLAUDE_CODE_OAUTH_TOKEN` for personal use with your own plan only.

Everything that changes the house goes through one tool and a policy file the site supplies: allow, confirm or deny
by domain, entity, service, device class and surface, with value bounds and timed runs; anything not listed is denied.
Confirmations are held by the server (30 s, once, by the person and screen that asked); the model can't approve its
own request. Authentication is required (access codes or the person's Home Assistant login), with per-user
confirmations and rate limits. See `docs/assistant.md`.
