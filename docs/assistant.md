# The voice assistant

> **Status: draft.** This is v1 for review, not a release: nothing here is in a published image or tarball yet, and
> any of it may change. Most open questions in the design
> ([`design/voice-assistant.md` §11](design/voice-assistant.md#11-open-questions)) are still undecided, so some
> defaults below are **placeholders**: the contents of the example policy are there to make it run, not
> recommendations. The model default is decided ([Models](#models)). See [Not in v1](#not-in-v1-and-open-questions).

A house assistant you talk to from the viewer: "turn off the kitchen pendants", "set the thermostat to 72", "where is
the water heater?", "what's the weather tomorrow?". One conversation with a Claude agent that reads and acts on Home
Assistant under a **policy enforced on the server** (allow / confirm / deny), knows the building from the same site
folder the viewer uses, and can drive the 3D view. It is optional: the static viewer works without it, and without a
reachable server the plugin only shows "Assistant offline". Everyone who talks to it logs in: with their own Home
Assistant login, or with an access code ([Authentication](#authentication)).

```
browser: assistant plugin ──── one WebSocket (/assistant/ws) ────▶ jarvis-assistant (Node)
  dock panel, hold M to talk                                        ├─ one Agent SDK session (Claude)
  confirm dialog, viewer commands                                   ├─ house tools (ha_*, site_*, view_*, memory_*)
  speech synthesis                                                  ├─ policy gate ──▶ Home Assistant (websocket,
        │                                                           │                   its own non-admin user)
        └── POST /assistant/transcribe (audio) ───────────────────▶ └─ ──▶ any OpenAI-compatible
                                                                          /audio/transcriptions endpoint
```

- The **browser plugin** (`src/plugins/assistant/`) acts on nothing itself and holds no credential of the server's.
  It logs in with the person's Home Assistant login or an access code, shows the conversation, records speech, asks
  you to confirm, and runs the viewer commands the agent sends.
- The **`jarvis-assistant` server** (`server/`) runs one Claude Agent SDK session. The agent's only way to change
  anything is the `ha_act` tool, and `ha_act` goes through the policy gate before anything reaches Home Assistant.
- Speech goes as a plain HTTP upload; the server forwards it to a transcription server you run (faster-whisper via
  Speaches, whisper.cpp, a hosted API) and never stores it. Replies are spoken by the browser's `speechSynthesis`.

## Running the server

Node 22.18 or newer. From the repository, with an access code for yourself:

```sh
cd server
npm install
echo 'clients:' > clients.yaml
npm run --silent new-client-secret -- me >> clients.yaml   # shows your access code (me:…); appends its hash
JARVIS_ASSISTANT_AGENT=scripted JARVIS_ASSISTANT_AUTH=secret JARVIS_ASSISTANT_CLIENTS=clients.yaml npm start
```

That runs the **scripted agent** (keyword rules, no model, no network: "turn on the kitchen pendants", "set the
thermostat to 72", "run good night", "show me the water heater", "is the pond pump on?", "remember …") over the
**mock Home Assistant** and the demo house, with the example policy, and lets in whoever has the access code. It
listens on `http://127.0.0.1:8787/assistant/ws` and writes its data under `server/data/`. A viewer with
[the plugin enabled](#the-browser-plugin) asks for the code once; with `JARVIS_ASSISTANT_AUTH=ha` the mock Home
Assistant takes made-up `mock-user:<name>` tokens instead (list them under `ha_users`, or set
`JARVIS_ASSISTANT_HA_USERS_ONLY=false`; the server warns in a box that anyone can then be anyone,
[Authentication](#authentication)). A client that isn't a
browser sends an `Origin` the server allows: with no `JARVIS_ASSISTANT_ORIGINS`, the server's own,
`http://127.0.0.1:8787`.

The defaults find the demo house (`examples/demo-site`) from the server's own files, so this works from any folder;
as the default site, the demo house gets [`server/policy.example.yaml`](../server/policy.example.yaml), which is
written for it. Paths you set are resolved against the working directory.

For the real agent, leave out `JARVIS_ASSISTANT_AGENT` and set a model credential
([below](#model-access-and-its-caveats)). **For the first live trial, set `JARVIS_ASSISTANT_WEB=off`**
([why](#what-the-agent-can-use)): web content the agent fetches can carry instructions, and the agent can carry out
allow-tier actions without asking anyone.

For your own Home Assistant, set `JARVIS_HA_MODE=live`, `JARVIS_HA_URL` and `JARVIS_HA_TOKEN`: a long-lived token of
a **dedicated, non-admin** Home Assistant user (e.g. "JARVIS assistant"), so every action shows in Home Assistant's
logbook under that user and revoking it is one click. Never give it an admin's token.

The server checks its whole configuration at start-up and refuses to start with a list of every problem, including a
missing `JARVIS_ASSISTANT_AUTH` (there is no anonymous mode) and any problem in the clients file. For a site of your
own (`JARVIS_SITE_DIR`) with no policy file at the default path it starts but refuses **every** action, and says so in
a box.

`npm run dev` restarts on changes; `npm run typecheck` and `npm test` check it (the root `npm test` runs the unit tests
too).

### Configuration

Environment variables, optionally under a JSON file named by `JARVIS_ASSISTANT_CONFIG` whose keys are the same names
(the environment wins; an unknown key is an error). Paths you set are relative to the working directory.

| Variable                             | Default                               | What                                                                                                                                                                                                                                                                 |
| ------------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JARVIS_ASSISTANT_HOST`              | `127.0.0.1`                           | Address to bind. Keep it local behind a reverse proxy; `0.0.0.0` in a container. Off loopback, `JARVIS_ASSISTANT_ORIGINS` is required                                                                                                                                |
| `JARVIS_ASSISTANT_PORT`              | `8787`                                | Port                                                                                                                                                                                                                                                                 |
| `JARVIS_ASSISTANT_BASE`              | `/assistant`                          | URL prefix: `{base}/ws`, `{base}/transcribe`, `{base}/health`                                                                                                                                                                                                        |
| `JARVIS_ASSISTANT_ORIGINS`           | empty: loopback pages only            | Comma-separated origins (exact scheme, host and port: `https://jarvis.example.lan`) allowed to open the WebSocket and to POST `/transcribe`; a request without an `Origin` is refused. May be empty only when bound to loopback ([below](#behind-the-reverse-proxy)) |
| `JARVIS_SITE_DIR`                    | the repository's `examples/demo-site` | The site folder (`site.json`, model, registry, Home Assistant maps), the same one the viewer serves                                                                                                                                                                  |
| `JARVIS_ASSISTANT_POLICY`            | `<site>/assistant-policy.yaml`        | The policy file. When set, a missing file is an error; at the default path, a missing file means every action refused. The demo house as the default site: `server/policy.example.yaml`                                                                              |
| `JARVIS_ASSISTANT_DATA`              | `data`                                | Writable folder: `session.json`, `memory/`, `audit.jsonl`                                                                                                                                                                                                            |
| `JARVIS_ASSISTANT_KNOWLEDGE`         | none                                  | A read-only folder of manuals and notes; without it Read / Grep / Glob are off                                                                                                                                                                                       |
| `JARVIS_ASSISTANT_AGENT`             | `sdk`                                 | `sdk` (Claude through the Agent SDK) or `scripted` (no model)                                                                                                                                                                                                        |
| `JARVIS_ASSISTANT_MODEL`             | `claude-sonnet-5`                     | The model every turn starts on ([Models](#models))                                                                                                                                                                                                                   |
| `JARVIS_ASSISTANT_EFFORT`            | `low`                                 | Its effort: `low`, `medium`, `high`, `xhigh` or `max`                                                                                                                                                                                                                |
| `JARVIS_ASSISTANT_ESCALATION_MODEL`  | `claude-opus-5-5`                     | The model a turn switches to for hard questions ([Models](#models)); `off` or empty: no escalation                                                                                                                                                                   |
| `JARVIS_ASSISTANT_ESCALATION_EFFORT` | `high`                                | Its effort (set explicitly: Opus 5.5's own default is `medium`); same values as above                                                                                                                                                                                |
| `JARVIS_ASSISTANT_WEB`               | `on`                                  | `off` takes WebSearch and WebFetch away from the agent (and from its prompt). Recommended for the first live trial ([why](#what-the-agent-can-use))                                                                                                                  |
| `JARVIS_ASSISTANT_TURN_TIMEOUT_S`    | `180`                                 | A turn still running after this many seconds is ended with an error and the agent's session restarted                                                                                                                                                                |
| `JARVIS_ASSISTANT_AUTH`              | none: **required**                    | Who may log in: `ha` (people's own Home Assistant logins), `secret` (access codes from the clients file) or `ha,secret` ([Authentication](#authentication))                                                                                                          |
| `JARVIS_ASSISTANT_CLIENTS`           | none                                  | The clients file (YAML or JSON): access-code hashes with each client's surface, and per-HA-user surfaces. Required with `secret`                                                                                                                                     |
| `JARVIS_ASSISTANT_HA_SURFACE`        | `screen`                              | The surface of a person logged in with Home Assistant, unless the clients file's `ha_users` says otherwise                                                                                                                                                           |
| `JARVIS_ASSISTANT_HA_USERS_ONLY`     | `true`                                | `true`: only the Home Assistant users listed in the clients file's `ha_users` may log in. `false`: any valid Home Assistant user may, with `JARVIS_ASSISTANT_HA_SURFACE` unless listed                                                                               |
| `JARVIS_ASSISTANT_HELLO_TIMEOUT_S`   | `10`                                  | A connection that hasn't sent its `hello` after this many seconds is closed (4401)                                                                                                                                                                                   |
| `JARVIS_ASSISTANT_TRUSTED_PROXY`     | none                                  | Comma-separated IP addresses of reverse proxies whose `X-Forwarded-For` names the client ([below](#behind-the-reverse-proxy)). Without it every client counts as the TCP peer                                                                                        |
| `JARVIS_ASSISTANT_RATE_SAY`          | `6/20`                                | Messages per user: `burst/perMinute` (6 at once, then 20 a minute); over it, "slow down"                                                                                                                                                                             |
| `JARVIS_ASSISTANT_RATE_TRANSCRIBE`   | `6/20`                                | Recordings per user (`POST /transcribe`), the same way; over it, 429                                                                                                                                                                                                 |
| `JARVIS_HA_MODE`                     | `mock`                                | `mock` (an in-process fake of the demo house) or `live`                                                                                                                                                                                                              |
| `JARVIS_HA_URL`                      | none                                  | Home Assistant's URL (`https://ha.example.lan:8123`) or its websocket URL; required when live                                                                                                                                                                        |
| `JARVIS_HA_TOKEN`                    | none                                  | Long-lived token of the assistant's own non-admin Home Assistant user; required when live                                                                                                                                                                            |
| `JARVIS_STT_URL`                     | none: transcription off               | OpenAI-compatible base URL; the server POSTs to `{url}/audio/transcriptions` (e.g. `http://speaches:8000/v1`)                                                                                                                                                        |
| `JARVIS_STT_MODEL`                   | `whisper-1`                           | The transcription model name the endpoint expects                                                                                                                                                                                                                    |
| `JARVIS_STT_KEY`                     | none                                  | Bearer key for the endpoint, if it needs one                                                                                                                                                                                                                         |
| `JARVIS_STT_LANGUAGE`                | none: the endpoint detects it         | Language hint (`en`)                                                                                                                                                                                                                                                 |
| `JARVIS_ASSISTANT_CONFIG`            | none                                  | A JSON file holding any of the variables above                                                                                                                                                                                                                       |

The model credential (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`) is read from the environment only, never from
the JSON file. The Claude Code process the SDK starts gets the server's environment **without** any `JARVIS_*` variable,
so the Home Assistant token, the clients file's path and the STT key never reach the agent's side. Without
transcription, `POST /transcribe` answers 503 and the panel offers typing only.

Signals: `SIGHUP` re-reads the policy and the clients file (an invalid file is reported and the old one stays) and
closes the connections whose login the new clients file no longer allows ([Expiry and
revocation](#expiry-and-revocation)); `SIGINT` / `SIGTERM` stop cleanly. `GET {base}/health` answers `{ ok, agent, ha, transcribe }`.

### Behind the reverse proxy

Serve the assistant **under the same origin as the viewer**, at `/assistant/`, through the web server that already
serves the site: no CORS, and the HTTPS the microphone needs is already there. Added to the server block of
[`deploy/nginx.conf`](../deploy/nginx.conf) (or your own):

```nginx
location /assistant/ {
    # LAN only: nothing of the assistant is published to the internet
    allow 192.168.0.0/16; allow 10.0.0.0/8; allow 172.16.0.0/12; allow 127.0.0.1;
    deny all;

    proxy_pass http://127.0.0.1:8787;      # no URI part: /assistant/… is passed on as it is
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;  # the WebSocket at /assistant/ws
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $http_host;        # with the port (only used when JARVIS_ASSISTANT_ORIGINS is empty)
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;  # who the client is (JARVIS_ASSISTANT_TRUSTED_PROXY)
    proxy_read_timeout 1h;                   # an idle conversation stays open (the server pings every 30 s)
    client_max_body_size 11m;                # recorded speech (the server takes up to 10 MB)
    add_header Cache-Control "no-store" always;
}
```

With the image, run the assistant as a second container on the same network, set `JARVIS_ASSISTANT_HOST=0.0.0.0` and
`JARVIS_ASSISTANT_ORIGINS` to the viewer's origin (`https://jarvis.example.lan`; required whenever the viewer has a
non-loopback name), point `proxy_pass` at it (`http://jarvis-assistant:8787`) and mount the edited `nginx.conf` over
`/etc/nginx/conf.d/default.conf`. Mount the site folder into both.

**Name the proxy** in `JARVIS_ASSISTANT_TRUSTED_PROXY` (its address as the assistant sees it: `127.0.0.1` on the same
machine, the nginx container's address on a Docker network). Then, and only for connections from that address, the
server takes the client's address from `X-Forwarded-For`: the right-most entry that isn't a trusted proxy (the part to
the left of it is whatever the client sent, so a client can't choose its address). The failed-login limit and the cap
on connections waiting to log in then count each device in the house separately; without it they count the whole
house as one address (the proxy's). Never list an address that clients can reach the server from directly.

The plugin's `server` must be a **same-origin path** through this proxy (`/assistant`). Cross-origin isn't supported
in v1: the server speaks plain HTTP and sends no CORS headers, so a page on another origin (or an `https://` page
pointing at `http://host:8787`) can't reach it.

- **LAN only.** Everyone logs in ([Authentication](#authentication)), but keep the assistant off the internet all the
  same: behind the proxy's `allow` / `deny`, a VPN, or the proxy's authentication, as [SECURITY.md](../SECURITY.md)
  advises for the viewer.
- **HTTPS.** Browsers allow the microphone only in a secure context: HTTPS with a certificate the device trusts (or
  `http://localhost`). Over plain HTTP on the LAN the panel still works for typing.
- **Origins.** `{base}/ws` and `{base}/transcribe` require an `Origin` header, and it must be one of
  `JARVIS_ASSISTANT_ORIGINS`, exactly (scheme, host and port), so no other web page can drive the assistant or spend
  your transcription credit. Browsers send one on a WebSocket and on a POST like this; a client that isn't a browser
  (a script, a satellite bridge) must send an allowed one itself, and a request **without** an `Origin` is refused
  (403). The list may be empty **only when the server binds to loopback** (`127.0.0.0/8`, `::1`, `localhost`): then
  the page must be the server's own, by a loopback name (`Origin` equal to `Host`, and that host `localhost`,
  `127.x.x.x` or `[::1]`), which also refuses a DNS-rebinding page. A viewer served under another name, e.g. through
  the reverse proxy, therefore needs the list. Off loopback the server refuses to start without it. The `Origin` only
  says which page is asking; who is asking is the login.

## Authentication

Every connection logs in with its first message, `hello`, before anything else is accepted; there is no anonymous
mode. `JARVIS_ASSISTANT_AUTH` (required) says which credentials the server takes:

- **`ha`: the person's own Home Assistant login.** The viewer already holds their Home Assistant access token (the
  home-assistant plugin's login); the assistant plugin sends it with `hello`, and the server asks Home Assistant whose
  it is (a one-off websocket with that token: `auth`, `auth/current_user`, close; 5 s at most). The token is never
  written anywhere or used for anything else, and never on the assistant's own connection; the server keeps the latest
  one in memory for the life of the connection, to check the login again ([below](#expiry-and-revocation)). A token
  of the **assistant's own** Home Assistant user is refused, whatever its string (the server asks Home Assistant who it
  is itself when it connects). A good answer is remembered for a minute under the token's hash, so a reconnecting tab
  doesn't ask every time. By default (`JARVIS_ASSISTANT_HA_USERS_ONLY=true`) only the users listed under the clients
  file's `ha_users` may log in; `false` lets in anyone with a valid Home Assistant login. With the **mock** Home
  Assistant (`JARVIS_HA_MODE=mock`) the tokens are made up: `mock-user:<name>` is the user `<name>` (id
  `mock-<name>`), anything else is refused (never in live mode). Anyone can then log in as anyone, so the server says
  so in a box at start-up: for trying it out only.
- **`secret`: an access code**, for a device or person without a Home Assistant login (a wall tablet, a satellite
  bridge, a guest). The code is `<name>:<random>`; `npm run new-client-secret -- <name> [screen|speaker]` (in
  `server/`) prints a fresh one and the line for the clients file, which holds only the code's SHA-256 (compared in
  constant time), never the code. The panel asks for the code once and keeps it in that browser for that site.

The clients file (`JARVIS_ASSISTANT_CLIENTS`, YAML or JSON) is checked strictly at start-up and on `SIGHUP`: unknown
keys, a name used twice, the same hash twice, a hash that isn't 64 hex digits or a missing surface stop the server (or,
on `SIGHUP`, keep the old file).

```yaml
clients: # access codes: name, the SHA-256 of `<name>:<secret>`, and where it talks from
  - { name: hall-tablet, secret_sha256: 3b4c…(64 hex digits), surface: screen }
  - { name: kitchen-bridge, secret_sha256: 9f20…, surface: speaker }
ha_users: # the Home Assistant users who may log in (JARVIS_ASSISTANT_HA_USERS_ONLY), and their surface
  - { id: 8c1f0e2d4b6a49c7a1e3f5d7b9c2e4f6, surface: screen } # Ed
  - { id: 2b4d6f8a0c1e43579bdf02468ace1357, surface: speaker } # the guest room's tablet login
```

- **List Home Assistant users by `id`** (Settings → People → Users → the user: the id is in the address, or
  `auth/current_user` in the developer tools). `name` works too, but names aren't unique and any user can be renamed,
  so an entry by name lets in whoever has that name; the server warns at start-up for each one. An `id` entry wins over
  a `name` entry for the same person.
- **A shared login is one person.** If the viewer logs in to Home Assistant as one dedicated user for everyone (as
  [SECURITY.md](../SECURITY.md) suggests), everyone using it is the same assistant user: one name in
  the audit log, one rate limit, and their confirmations are each other's. Give people their own logins where who did
  what matters, or an access code per device.
- **The surface comes from the server**, never from the client: a `speaker` credential gets the speaker's policy
  rules (and spoken confirmations) whatever its `hello` says. For Home Assistant logins it is the user's `ha_users`
  entry, or `JARVIS_ASSISTANT_HA_SURFACE` (`screen` by default) for an unlisted user when
  `JARVIS_ASSISTANT_HA_USERS_ONLY=false`.
- **Refused** (no credential, a wrong code, a token Home Assistant doesn't know, a user not on `ha_users`, a kind the
  server doesn't take): the server sends `error` "not authorised" and closes the socket with code **4401**; the panel
  says so, asks for a code and doesn't retry on its own. **Couldn't check** (Home Assistant unreachable or too busy):
  code **4503**, which the panel retries with its usual backoff, so an outage doesn't log everyone out.
- **Failed logins are limited per address**: after 5 (then 5 a minute) the address's tries are refused without a check
  (close code 4429). An access code is cheap to check, so it is checked first and the limit applies only when it is
  wrong: a guessing script can't lock out a right code. A Home Assistant token is expensive to check (a round trip to
  Home Assistant), so the limit comes first: its token is taken before the check (and given back when the login is
  good), at most 2 checks run at once per address and 4 in all, and a check that fails because Home Assistant is down
  counts too. Behind the reverse proxy, set `JARVIS_ASSISTANT_TRUSTED_PROXY` so the address is each client's
  ([above](#behind-the-reverse-proxy)); without it the whole house shares the proxy's address.
- **Before the login** a connection may send exactly one message, the `hello`, of at most 8 KB, within
  `JARVIS_ASSISTANT_HELLO_TIMEOUT_S` (10 s; else 4401). Anything more (a second message while the hello is being
  checked, a bigger one) cuts the connection off without a closing handshake. At most 8 connections per address and 64
  in all may be waiting to log in; more get a 503 on the upgrade. A connection the server closes is cut off if it
  hasn't gone a second later, and its later messages are ignored.
- **The ticket.** `welcome` carries the user's name and a **ticket**: random, bound to that user and that connection,
  dead when the connection closes and after 10 minutes (a fresh one arrives in a `ticket` message every 5; a connection
  has at most two live, the newest and the one before). Recorded speech goes to `POST {base}/transcribe` with
  `Authorization: Bearer <ticket>`; without a live ticket it is 401.
- **Rate limits per user**: `say`, `interrupt` and `reset` share one token bucket (`JARVIS_ASSISTANT_RATE_SAY`), and
  `/transcribe` has its own (`JARVIS_ASSISTANT_RATE_TRANSCRIBE`), both `burst/perMinute`, default `6/20`. Over it: an
  `error` "slow down" (and nothing happens) for the messages, 429 for `/transcribe`. After the login, a connection with
  more than 50 messages waiting is closed (1008).
- **Confirmations belong to the login.** A parked action records the user and the client id it came from; only a
  connection logged in as the same user with the same client id can answer it (click or spoken yes). Another user who
  sends that client id gets "not your pending action". Someone else's `interrupt` stops the running turn but leaves its
  confirmation to its owner (unanswered, it expires).
- The audit log records each login (who, or why not), each connection closed for its login, and every decision with
  the user's name.

### Expiry and revocation

- **Access codes and `ha_users`**: edit the clients file and send the server `SIGHUP` (`kill -HUP <pid>`,
  `docker kill -s HUP jarvis-assistant`). Every logged-in connection is checked against the new file: one whose access
  code is gone (or whose Home Assistant user is no longer listed, with `JARVIS_ASSISTANT_HA_USERS_ONLY`) is closed with
  4401; one whose surface changed is closed with 1012 and logs in again with the new surface. The others stay.
- **Home Assistant logins** are checked again with Home Assistant every 10 minutes. A Home Assistant access token
  lasts 30 minutes, so the panel sends the server a fresh one (an `auth` message) every 5, and the check uses the
  latest. A definite no (the user was removed, deactivated, or its tokens revoked in Home Assistant) closes the
  connection with 4401; Home Assistant unreachable keeps it and tries again a minute later. The one-minute cache of
  good answers applies here too, so revoking someone takes effect within about 11 minutes.
- A `/transcribe` ticket dies with its connection, so a closed login can't keep uploading.

## Models

Decided (design §11.1): a fast model for every turn, and a stronger one when a question needs it.

- **Every turn starts on `claude-sonnet-5` at `low` effort** (`JARVIS_ASSISTANT_MODEL`, `JARVIS_ASSISTANT_EFFORT`):
  house commands, lookups and small talk should be quick.
- **Escalation: `claude-opus-5-5` at `high` effort** (`JARVIS_ASSISTANT_ESCALATION_MODEL`,
  `JARVIS_ASSISTANT_ESCALATION_EFFORT`). A turn switches to it in two ways:
  - **the person asks explicitly**: "think hard" / "harder" / "carefully", "take your time", "think it through",
    "really think", "use Opus", "your best" / "strongest model", "deep dive". The server matches these on the words
    (not "I think the hall light is on") and switches before the model sees the message;
  - **the model asks**: the house tool `think_harder { reason }`, which the model is told to call first for careful
    multi-step reasoning, calculations, planning or troubleshooting, and not for house commands or simple lookups. The
    rest of that turn runs on the escalation model.

  Either way the panel shows a **Thinking harder (`<model>`)** chip, the log gets one line
  (`assistant: escalated to <model> (<effort>): explicit ask | think_harder`), and when the turn ends the session
  switches back to the default model and effort before the next turn starts. If switching back fails, that is logged
  and the next turn restarts the Claude Code process (resuming the conversation) on the defaults, rather than
  quietly staying on the stronger model.

- `JARVIS_ASSISTANT_ESCALATION_MODEL=off` (or empty) turns escalation off: `think_harder` answers that it is off, and
  the system prompt doesn't mention it. The scripted agent never escalates.
- Both models are plain configuration, so a newer one (a Sonnet 5.5, say) is a config change only. The escalation
  effort is set explicitly because Opus 5.5's own default is `medium`. Opus 5.5's thinking can't be disabled, so the
  server never sets thinking off (it passes no `thinking` option at all).

## Model access and its caveats

The agent runs the Claude Agent SDK, which needs a credential in the server's environment (design §4). It never
reaches the browser.

- **`ANTHROPIC_API_KEY`** (pay-as-you-go API billing) is the **default**, and the **only option** for anyone running
  the assistant for other people or as part of a product.
- **`CLAUDE_CODE_OAUTH_TOKEN`**, a long-lived token from `claude setup-token`, uses **your own** Claude Pro or Max plan.
  It is for **personal use with your own plan only**. Whether that fits your use is governed by Anthropic's terms
  ([Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)), and checking it is **the
  installer's responsibility**, not this project's. A `claude login` credentials file on the server's host is used the
  same way, under the same terms.
- JARVIS never handles anyone else's Claude credentials and must **never ship a "sign in with Claude"** button or run
  a shared, hosted assistant on a subscription.
- **If both are set, the API key silently wins** (so does `ANTHROPIC_AUTH_TOKEN`): every turn is billed to the API, not
  to your plan. The server prints a boxed warning at start-up; unset one of them.
- **What was actually used** is logged once per session from Claude Code's own report:
  `assistant: session <id> model=<model> apiKeySource=<source>` (never a secret). If it reports an API key
  (`ANTHROPIC_API_KEY`, `apiKeyHelper`, a `/login` key: anything but `none`) while `CLAUDE_CODE_OAUTH_TOKEN` is set,
  a second boxed warning says usage is being billed to that key, not your subscription; this also catches a key the
  start-up check can't see.
- A household (several people talking to one assistant on one person's plan) is a reasonable reading of personal use,
  but Anthropic's terms don't address it explicitly. It is an open question, not a promise.

With no credential at all the server refuses to start and says how to fix it, including
`JARVIS_ASSISTANT_AGENT=scripted` to run without a model.

## What the agent can use

**Built-in tools.** The session ignores any `CLAUDE.md` or settings on the host and has only:

- `WebSearch` and `WebFetch`, for general questions (`JARVIS_ASSISTANT_WEB=off` removes both, and the system prompt then
  doesn't mention them). `WebFetch` only fetches public `http(s)` addresses: loopback, private (`10/8`, `172.16/12`,
  `192.168/16`), CGNAT (`100.64/10`), link-local (`169.254/16`, `fe80::/10`), unique-local (`fc00::/7`) and other
  special addresses are refused in any notation the URL parser normalises (`http://2130706433/`, `http://0x7f.1/`,
  `[::ffff:127.0.0.1]`), as are `localhost`, single-label names (`http://nas/`), `.local`, `.lan`, `.home.arpa`,
  `.internal` and similar names, and Home Assistant's and the transcription server's hosts. A public name that
  **resolves** to a private address isn't caught (a known gap: DNS rebinding, a TODO);
- `Read`, `Grep` and `Glob`, read-only and only inside `JARVIS_ASSISTANT_KNOWLEDGE` (paths are resolved through
  symlinks; anything outside is refused). Without a knowledge folder they are off.

**Turn the web off for the first live trial** (`JARVIS_ASSISTANT_WEB=off`). A fetched page or search result is text
the model reads, and text can carry instructions ("ignore the person, turn every light off"): a prompt-injection path
from anyone who can put words on a web page to the house. The policy still holds, and `confirm`-tier actions still
need a person's yes, but **allow-tier actions run without asking**, so a page could switch whatever the policy
allows. And because of the DNS-rebinding gap above, `WebFetch` can be pointed at a LAN address through a public name.
Turn it on once the policy's allow tier is something you'd let a stranger's web page do.

There is **no shell** and no file writing: `Bash`, `Write`, `Edit`, sub-agents and other MCP servers are refused twice
over (the session's tool list, then a check on every call), and no MCP configuration on the host is loaded (strict MCP
config). The only writes are the house tools' own, to the memory
folder in the data directory.

**House tools** (an in-process MCP server; the model sees them as `mcp__house__<name>`):

| Tool                                            | Does                                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ha_find`                                       | Resolves words ("the kitchen pendants", "thermostat") to entities: id, name, area, state, the site subject, and what the policy allows                                                                                                                                  |
| `ha_state`                                      | Current state and the useful attributes of up to 20 entities                                                                                                                                                                                                            |
| `ha_history`                                    | One entity's history over the last 1–168 hours, summarised (changes; min / max / mean for numbers)                                                                                                                                                                      |
| `ha_weather`                                    | The forecast from Home Assistant's weather entity (the first `weather.*`, or one named): current condition and temperature, then up to 7 days (`daily`, the default) or 12 hours (`hourly`). Read-only; see [read-only response services](#read-only-response-services) |
| `ha_act`                                        | Calls one service on entities of one domain. Goes through the policy gate: done, refused (with the reason), or asks and waits for the answer                                                                                                                            |
| `site_search`                                   | Searches the site's rooms, light fixtures, equipment registry, placed devices and controls; hits carry a subject the viewer can fly to                                                                                                                                  |
| `site_rooms`                                    | The rooms by storey, with their fixtures and registry items                                                                                                                                                                                                             |
| `registry_get`                                  | One registry item: make, model, location, specs, documents, entities                                                                                                                                                                                                    |
| `view_fly`, `view_highlight`, `view_layer`      | Fly the asking screen's view to a subject, pulse subjects, show or hide a view layer or the cutaway / upper-storey toggle ("no viewer attached" on a speaker). The viewer refuses any other name: plugin chips (whose keys can switch real things) are never pressed    |
| `view_where`                                    | Where the person is in the view and what is selected (also given with each turn)                                                                                                                                                                                        |
| `memory_save`, `memory_search`, `memory_forget` | House-wide notes ("the big lamp" is a given light; preferences) in `<data>/memory/house/`, at most 200                                                                                                                                                                  |
| `think_harder`                                  | Switches the rest of the turn to the escalation model and effort ([Models](#models)); says so when escalation is off                                                                                                                                                    |

There is deliberately no tool for raw service calls.

## The policy file

The policy says which Home Assistant service calls the assistant may make on its own (**allow**), which need a person
to say yes first (**confirm**), and which it never makes (**deny**). It is data, read by the server
(`server/src/core/policy.ts`), and enforced in code before anything reaches Home Assistant. The model sees only the
outcome. It is parsed strictly: an unknown key, a bad value or a `default` other than `deny` stops the server (or, on
reload, keeps the old policy), so a typo can't widen it.

### Format

| Key                          | Meaning                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                    | Required: `1`                                                                                                                                                             |
| `default`                    | Optional; only `deny` is accepted. Anything no rule matches is refused                                                                                                    |
| `bulk.confirm_over`          | A call on more than this many entities asks first, even when each is allowed                                                                                              |
| `rules`                      | The list of rules, in order                                                                                                                                               |
| `allow` / `confirm` / `deny` | Exactly one per rule: the tier, holding the rule's **matcher**                                                                                                            |
| `reason`                     | Shown when the rule refuses or asks ("Unlocking is never done by the assistant")                                                                                          |
| `bounds`                     | Numeric data keys and their inclusive `[min, max]`: `{ temperature: [60, 85] }`. Outside the range is refused, never clamped                                              |
| `data`                       | Data keys allowed without bounds, with string or true / false values: `[hvac_mode]`                                                                                       |
| `max_minutes`                | A timed run: the server calls the matching off service afterwards (`turn_on` → `turn_off`, `open_valve` → `close_valve`, …). The request may ask for fewer with `minutes` |
| `risk`                       | `high` makes the confirm dialog warn; `normal` by default                                                                                                                 |

Matcher keys; every key present must match, and a list matches any of its items:

| Key            | Matches                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `domain`       | The entity's domain (`light`, `climate`)                                                                    |
| `entity`       | Entity ids, with `*` matching any run of characters (`switch.*network*`)                                    |
| `service`      | Service names. **Required** on `allow` and `confirm` rules; `'*'` (any service) only on `deny` rules        |
| `device_class` | The entity's `device_class` attribute (`garage`)                                                            |
| `surface`      | Where the request came from: `screen` (the JARVIS panel) or `speaker` (voice only, e.g. a future satellite) |

How a call is decided:

- **Each entity on its own:** its **first matching rule wins**. No match: denied.
- **The strictest entity decides the call** (deny > confirm > allow); one denied entity refuses the whole call.
- **Data must be named** by the matching rule, in `bounds` or `data`. Any other key is refused, including `entity_id`,
  `area_id` and anything like `confirmed: true`; `minutes` only on a `max_minutes` rule.
- An `allow` or `confirm` rule must name a `domain` or an `entity`, **and** its services (never `'*'`): without them,
  `allow: { domain: script }` would let the model run any script with any service. A service always runs in the
  entity's own domain, so the generic `homeassistant.*` services can't be reached at all.
- An entity Home Assistant doesn't know is refused.

### Read-only response services

Some Home Assistant services return data instead of changing anything (`weather.get_forecasts`, `calendar.get_events`,
…). The server knows a fixed, **built-in** list of these and the exact data each takes, and only `ha_weather` uses it:
today just `weather.get_forecasts` with `type: daily` or `type: hourly`.

- The list is **not configurable**: the policy file has no key for it (`read:` or `respond:` is an unknown key, so the
  file is refused), and no rule widens it: an `allow` rule naming `weather.get_forecasts` or `calendar.get_events`
  doesn't let anything else be read. Adding a service is a code change and a review, because "returns data and
  changes nothing" has to be checked per service, and some response services do change things.
- It is **outside the policy** on purpose: a forecast reveals nothing about the house and changes nothing, so it works
  even with a deny-everything policy.
- It is checked as strictly as an action: the service must be on the list, every entity in its domain and known to
  Home Assistant, and the data exactly as listed (`twice_daily`, other keys or `return_response` are refused).
- `ha_act` can't reach it: an action naming a listed service is refused (use the read tool) whatever the policy
  allows, and an action can never ask for a response (`return_response` is refused as data, and no rule may name it).
- Reads are audited like actions, as `kind: read`.

### An example for the demo house

Shortened from [`server/policy.example.yaml`](../server/policy.example.yaml), which runs against the mock Home
Assistant. It shows the features; it is not a recommended default.

```yaml
version: 1
default: deny
bulk: { confirm_over: 8 } # "turn off every light" asks first

rules:
  # never, however it's asked
  - deny: { domain: lock, service: unlock }
    reason: Unlocking is never done by the assistant
  - deny: { domain: cover, device_class: garage, service: open_cover }
    reason: The assistant doesn't open the garage door
  - deny: { entity: ['switch.*network*', 'switch.*camera*'] }
    reason: That switch powers the network or a camera

  # ask first; closing the garage door only from a screen, where the person can see it
  - confirm: { domain: cover, device_class: garage, service: close_cover, surface: screen }
    reason: Closing the garage door; make sure nothing is in the way
    risk: high
  - deny: { domain: cover, device_class: garage }
    reason: The garage door can only be closed from a screen
  - confirm: { domain: climate, service: [set_temperature, set_hvac_mode] }
    bounds: { temperature: [60, 85] }
    data: [hvac_mode]
  - confirm: { entity: script.goodnight, service: turn_on }
    reason: Good night turns off every light in the house
  - confirm: { domain: valve, service: [open_valve, close_valve] }
    max_minutes: 30 # irrigation never runs longer than 30 minutes

  # just do it
  - allow: { domain: light, service: [turn_on, turn_off, toggle] }
    bounds: { brightness_pct: [1, 100], color_temp_kelvin: [2000, 6500] }
  # a script or a scene can do anything (a scene sets locks, covers, the alarm…): only harmless ones, by name
  - allow: { entity: [script.film_night, scene.evening], service: turn_on }
  - allow: { entity: switch.pond_pump, service: [turn_on, turn_off] }
    max_minutes: 60

  # any other script or scene asks first
  - confirm: { domain: [script, scene], service: turn_on }
```

Put your own at `<site>/assistant-policy.yaml`, or anywhere with `JARVIS_ASSISTANT_POLICY`. After editing it, send the
server `SIGHUP` (`kill -HUP <pid>`, `docker kill -s HUP jarvis-assistant`) to reload it without dropping the
conversation.

### Confirmation

A `confirm` action is held **on the server**, not by the model:

- it is parked under a random id with a **30 s** expiry, and the dialog goes only to the client the request came from
  (it counts down from the time left when it was sent, `ttlMs`, so a client whose clock is off still shows it right);
- it runs only on that client's **Allow** click (`confirm.reply`), **once**: a second reply, a replay, another
  client's reply (including another user's connection sending the same client id, or the same user in another tab)
  or a reply after expiry is rejected. **Don't**, Esc, closing the dialog, Stop or the 30 s running out
  leave the house as it is, and so does closing the page (when a client's last connection goes, its waiting actions are
  cancelled; a reload doesn't get them back);
- on a voice-only `speaker` surface the answer is the person's next utterance, matched by the server, as a whole,
  against a fixed list ("yes", "yes please", "yeah", "yep", "do it", "confirm", "confirmed", "go ahead"; and "no",
  "cancel", "never mind"…), and only when exactly one action is waiting. "Yes, and turn the lights on" is not a yes:
  it goes to the agent as a new request and the action stays pending;
- before running, the policy is evaluated again against fresh states;
- **the model can't approve**: no tool or model output reaches the confirmation, and asking again parks a new action
  rather than approving the old one.

### The audit log

Every gate decision (allowed, refused, pending, approved, declined, expired, failed, the `max_minutes` off calls, and
read-only service reads, as `kind: read`) is appended to `<data>/audit.jsonl` as one JSON line: time, the user's
name, client, surface, the person's words, the request, the tier, the outcome and the exact call; so is every login,
accepted or refused. Actions also appear in Home Assistant's logbook under the assistant's own user. The file grows
until you rotate it (`logrotate` with `copytruncate` works); how long to keep it is an open question.

## The browser plugin

It runs only on a site whose `site.json` has a `plugins.assistant` section: without one nothing shows and nothing
connects. The demo house (`examples/demo-site`, and the live demo on GitHub Pages) has none, since no assistant server
runs with it; the e2e test adds the section itself. Enable it on your site (field reference in the
[schema](../schema/site.schema.json)):

```json
"plugins": {
  "assistant": { "server": "/assistant", "tts": true }
}
```

| Field    | Meaning                                                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server` | Required. The server's base URL relative to the page, on its origin: `/assistant` behind the same-origin proxy. WebSocket at `<server>/ws`, speech to `<server>/transcribe` |
| `tts`    | Speak replies with the browser's speech synthesis (default `true`); the panel's toggle overrides it per browser                                                             |

- **Hold M** to talk, also while walking with the mouse captured and with the panel closed; release to send. A short
  press starts click-to-talk, which stops on a second press or after a second of quiet.
- **Shift+M** (or the rail button, or the status item) opens the **Assistant** panel: the rolling conversation, tool
  activity as chips (a chip with a subject flies there), a text box, the **talk button**, Stop, New conversation and
  the speech toggle.
- The **status item** shows ready / listening / transcribing / thinking / speaking, or "Assistant offline" while the
  socket retries.
- **Confirm dialog:** the action in plain words, the exact call, a warning for `risk: high`, a countdown, and
  **Don't** / **Allow**. It closes itself when the request expires or is answered.
- Without transcription configured on the server, the talk button is disabled and you type instead.
- **Logging in.** When this browser is logged in to Home Assistant (the home-assistant plugin, live), the plugin sends
  that login; otherwise the panel asks for an **access code**, kept in this browser for this site (**Forget code** in
  the panel's footer drops it and signs out). A typed code wins over the Home Assistant login. Refused, the panel says
  so and waits for another code (or Retry) instead of trying again by itself. If the Home Assistant login is still under
  way when the assistant starts, it tries again as soon as the Home Assistant connector's state changes. Home Assistant
  unreachable from the server is not a refusal: the panel shows "offline" and retries. The panel's footer shows whom
  the server took you for.
- `server` must be on the viewer's own origin (a path such as `/assistant`): a server elsewhere would be sent the
  person's Home Assistant login, so the plugin refuses it with an error and stays off.

To try the panel without any server, open the viewer with **`?assistant=mock`** (on a site with the section): an in-page
fake server, which needs no login, speaks the same protocol from a few scripts (turn off the kitchen lights, set the
thermostat to 72, close the garage, unlock the front door, show me the air handler, highlight the HVAC, hide the
furniture). No network, audio or model; M and the talk button simulate a transcription. The subjects are the demo
house's.

## Mock and real

|                | Mock                                                                                     | Real                                                                            |
| -------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Home Assistant | `JARVIS_HA_MODE=mock` (default): an in-process fake of the demo house's entities         | `JARVIS_HA_MODE=live`: HA's websocket API as the assistant's own non-admin user |
| Agent          | `JARVIS_ASSISTANT_AGENT=scripted`: keyword rules, real tools, gate and confirmations     | `sdk` (default): a Claude Agent SDK session; needs a credential                 |
| Client         | `?assistant=mock`: an in-page fake server, no network                                    | `plugins.assistant.server`: the real server over the WebSocket                  |
| Speech to text | Off (`JARVIS_STT_URL` unset): type only; in `?assistant=mock`, a simulated transcription | `JARVIS_STT_URL`: any OpenAI-compatible transcription endpoint                  |

The server's mocks can be mixed: the scripted agent against a live Home Assistant exercises the real policy with no
model; the real agent against the mock tries the model without touching the house.

## The protocol

One WebSocket at `{base}/ws` carries JSON messages with a `type`; the types are in
[`server/src/core/protocol.ts`](../server/src/core/protocol.ts), which the plugin imports.

| Direction       | `type`                                 | Carries                                                                                                                                                            |
| --------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| client → server | `hello`                                | First message: client id, `auth` (`{ type: 'secret', secret }` or `{ type: 'ha', token }`), capabilities (`viewer`, `tts`), view. No surface: the server's         |
| client → server | `say`                                  | Text, `source: typed \| voice`, the view at the time                                                                                                               |
| client → server | `interrupt`                            | Stop the current turn (anyone's: barge-in), drop this client's waiting ones, and cancel this client's confirmations (and the running turn's, if it is this user's) |
| client → server | `confirm.reply`                        | `{ id, approved }`                                                                                                                                                 |
| client → server | `view.result`                          | `{ id, ok, detail }` for a `view.command`                                                                                                                          |
| client → server | `reset`                                | Start a new conversation                                                                                                                                           |
| client → server | `auth`                                 | `{ auth }`: a fresh copy of the login's credential (a refreshed Home Assistant token), for the server's re-check                                                   |
| server → client | `welcome`                              | The recent transcript, status, the agent's name, whether transcription is on, mock or live HA, the user's name, a `/transcribe` ticket                             |
| server → client | `ticket`                               | A fresh `/transcribe` ticket (every 5 minutes; the last one works until it expires)                                                                                |
| server → client | `status`                               | `idle`, `thinking` or `error`                                                                                                                                      |
| server → client | `turn.start` / `turn.end`              | A turn from any surface (every client sees it); `turn.end` carries an error or `interrupted`                                                                       |
| server → client | `text.delta`                           | Streamed reply text                                                                                                                                                |
| server → client | `tool`                                 | A tool call: one human line, status (running, done, refused, pending, error), a subject                                                                            |
| server → client | `confirm.request` / `confirm.resolved` | A pending action (summary, exact call, risk, `expiresAt` on the server's clock and `ttlMs` left) and how it ended                                                  |
| server → client | `view.command`                         | `fly`, `highlight`, `layer` or `clear`, to the client whose turn it is                                                                                             |
| server → client | `error`                                | A message the client got wrong                                                                                                                                     |

Anything before a good `hello` is refused and the socket closed with **4401** (4429: too many failed logins from this
address; 4503: the login couldn't be checked right now, try again). A login that stops being good is closed with 4401,
one whose surface changed with 1012, a flood with 1008. The client gives up only on 4401; everything else is retried
with backoff. Speech is `POST {base}/transcribe` with `Authorization: Bearer <ticket>` and a multipart `file` (`audio/*`,
up to 10 MB; larger gets a 413), answered with `{ text }`; the client then sends `say`. The same Origin check as the
WebSocket applies; no live ticket is 401, over the rate limit 429.

Turns run one at a time. One still running after `JARVIS_ASSISTANT_TURN_TIMEOUT_S` (180 s) is ended with an error,
its confirmations are cancelled and the agent's session is restarted, so a stuck turn can't hold up the queue or
**New conversation** for ever.

## Not in v1 and open questions

Decided in the design but not built, or not decided at all (the design's
[§11](design/voice-assistant.md#11-open-questions) and the `TODO`s in the code):

- **What the policy should say** (§11.2): which actions are allow vs confirm (thermostats, bedtime scripts, irrigation),
  and whether a garage door may be closed from a room speaker. The example policy is only an example, used for the
  demo house when it is the default site; a site of your own without `assistant-policy.yaml` refuses everything.
- **Household use of one person's plan** with `CLAUDE_CODE_OAUTH_TOKEN`: not explicitly addressed by Anthropic's terms.
- **Where the server runs** (§11.4): next to the static site or on an existing agent host.
- **Per-person memory and policy** (§9, §5.3): the server now knows who is talking ([Authentication](#authentication)),
  but there are no `who:` policy rules or per-person memories yet (memory is house-wide), and rules can't match on
  area.
- **Room satellites through Home Assistant's voice pipeline** (§8, §11.3), and with them spoken confirmation in real
  use (the `speaker` surface exists in the protocol, the policy and the gate, but nothing connects as one yet).
- **Retention** (§11.6): how long to keep the audit log and transcripts. The transcript is in memory only (the last
  200 entries) and is lost on restart, though the agent's session resumes; audio is never stored.
- **Server-side TTS** with sentence streaming (§7.2): v1 uses the browser's voice.
- **Wake word** in the browser (§7.3): not in v1; hold M or click.
- Also from the code: no compaction summary into memory or daily soft reset yet (§9); `max_minutes` off timers live in
  the server process, so a restart during a timed run leaves the thing on.
