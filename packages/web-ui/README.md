# pi-console

A self-hosted web console for the **Pi coding agent**: list, create, run, and interact with
Pi sessions and the agents defined in your Pi installation — from one browser tab.

- **Zero dependencies, no build step.** Plain Node.js (`node:http`) backend, vanilla JS frontend.
- **Real Pi sessions.** Each open session is backed by a real `pi --mode rpc` child process;
  the console proxies Pi's JSONL protocol and streams events to the browser over SSE.
- **Live sync with the CLI.** Sessions you run in the terminal show up live in the console:
  the server tails their session file and streams the same messages, tool calls and results.
- **Pi owns persistence.** The console only reads Pi's own session files; it never writes them.

## Design

IBM Carbon design language: flat, square corners (no `border-radius` anywhere), 1px borders,
no shadows, no gradients, dense data-forward layout. Scrollbars are hidden throughout
(scrolling still works). Panels collapse with animated, non-snapping transitions.

**Typography**

| Role | Font |
| --- | --- |
| All information (headings, labels, body) | **Helvetica** / **Arial** (system stack) |
| Technical readouts, code, tool output | **JetBrains Mono** |

Sans-serif text uses the system Helvetica Neue / Helvetica / Arial stack, falling back to the
metric-compatible Liberation Sans / Nimbus Sans when absent, so Arial rendering stays consistent
on Linux with no webfont. JetBrains Mono is referenced by family name; install it system-wide or
drop `JetBrainsMono-Regular.woff2` into `public/fonts/` for the intended look.

**Palette (code-marathon-3, expanded)**

| Token | Value | Role |
| --- | --- | --- |
| lime | `#c2fe0c` | primary / interactive |
| violet | `#5200ff` | success · the prompt input border |
| magenta | `#ea027e` | danger / error |
| blue | `#3601fb` | info |
| orange | `#ff5500` | warning · externally-active sessions |
| white | `#ffffff` | text |

Surfaces are **monotone black** (`#000000`) with neutral borders (`#303030`, soft `#101010`);
hover/selection use translucent white overlays so feedback survives on black.

The prompt composer's border is violet `#5200ff` by design.

**Chat messages render markdown** — headings, lists, tables, blockquotes, inline code and
fenced code blocks, with syntax colouring (keywords magenta, strings lime, numbers orange,
comments dim, functions violet). Rendering is done by `public/js/markdown.js`, which builds DOM
nodes directly and never parses HTML from a message, so agent output cannot inject markup;
links are scheme-checked.

**Information lives in exactly one place** (minimalism): session activity is reported only by
the activity wheel in the chat header; server health only in the status bar; the model only by
the chat-header selector (and the Config view); token/cost/context detail only in the inspector.
The three triangles in the top bar toggle the sessions panel, the inspector and the input bar.

## Requirements

- Node.js ≥ 20
- The `pi` CLI on `PATH`
- A configured provider/model in `<pi home>/models.json`
  (defaults to `~/.pi/agent`, overridable with `PI_CODING_AGENT_DIR`)

## Run

```bash
cd pi-console
npm start
```

Then open `localhost:8123` in a browser.

### From pi (recommended)

The `web-console` extension registers the `/console` slash command (alias `/webui`). It launches
this server as a detached process and reports the URL:

```
/console          # start (default) and print the URL
/console open     # start and open in a browser
/console status   # running? pid, root
/console stop     # stop the server /console started
```

Standalone setup, from the repo root:

```sh
npm run install:web   # checks prerequisites, registers the extension, prints how to start
```

Environment overrides:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_CONSOLE_HOST` | `127.0.0.1` | bind address (keep it on loopback) |
| `PI_CONSOLE_PORT` | `8123` | listen port |
| `PI_BIN` | `pi` | path to the pi executable |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi config dir (sessions, models, settings) |

## What you can do

- **Sessions** — browse every Pi session on disk (idle) plus live ones (running), filter them,
  open one, and send prompts. Sessions active in another process are flagged (orange, pulsing).
- **Live sync with the CLI** — run `pi` in a terminal and open the same session here: its
  messages, thinking, tool calls and results stream into the UI as they happen. Prompting such a
  session from the web is refused (409) while another process owns it, so two writers never clash.
- **New session** — choose working directory, agent, provider/model, and thinking level.
- **Agents** — browse, **create, edit, rename and delete** the agents discovered from
  `~/.pi/agents` and the project `.pi/agents`; start a session pre-bound to any of them.
  Agent GET/DELETE/PUT accept `?source=user|project` to disambiguate duplicate names
  (the same name can exist at both levels).
- **Live chat** — assistant replies rendered as **markdown** with coloured code blocks,
  collapsible thinking blocks, tool calls with live output, and tool results.
- **Session controls** — switch model and thinking level mid-session, fork, or reset in place.
- **Inspector** — per-session stats (tokens in/out/cache, cost, context-window usage), the
  session's own todo list, and pi-lens diagnostics for the files it touched.
- **Thinking wheel** — an animated activity readout that rotates through status phrases
  (`Working`, `Triangulating`, …) and switches to concrete labels (`Reading server.js`,
  `Running \`ls\``,`Delegating to a subagent`) as the agent works, plus an elapsed timer.
- **Config view** — how this installation is set up: pi home, settings, models, paths, lens
  status, prompt templates and skills.
- **Panel toggles** — three triangle buttons (top right) show/hide the sessions panel, the
  inspector, and the input bar, with smooth animated transitions (state is remembered).
- **Abort / Stop** — abort the current run, or stop (kill) the session's child process.
- **Mobile friendly** — the sidebar and inspector become drawers on narrow screens.

## Architecture

```
Browser (public/)  ──HTTP──▶  server/server.js  ──JSONL stdin/stdout──▶  pi --mode rpc
        ▲                      REST + SSE hub                                  │
        └────── SSE events ◀─────────── events ───────────────────────────────┘
```

| File | Responsibility |
| --- | --- |
| `server/config.js` | paths, ports, runtime dir |
| `server/agents.js` | discover + parse agent `.md` files (frontmatter + body) |
| `server/agentstore.js` | create/update/delete agent files (path-safe, the only writer) |
| `server/models.js` | providers/models from `models.json` + default from `settings.json` |
| `server/sessions.js` | read-only listing of Pi's session `.jsonl` files |
| `server/spawn.js` | spawn/kill one `pi --mode rpc` child per session; JSONL framing; response correlation; event fan-out |
| `server/tailer.js` | follow a session file written by another process (live CLI sync) |
| `server/stats.js` | token/cost/context stats (live RPC, or computed from the session file) |
| `server/todos.js` | read the kit's per-session todo file |
| `server/lens.js` | pi-lens session diagnostics |
| `server/configinfo.js` | installation config + prompt templates + skills |
| `server/routes.js` | REST endpoints + SSE stream |
| `server/server.js` | HTTP server, static files, shutdown |

The disk readers tolerate malformed persisted entries: non-object JSONL lines in a session file, non-object provider values, and non-object `models` elements in `models.json` are skipped rather than failing the request.

### API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | liveness + uptime |
| GET | `/api/config` | installation configuration (paths, settings, models, lens) |
| GET | `/api/prompts` | prompt templates shipped with the kit |
| GET | `/api/skills` | skills shipped with the kit |
| GET | `/api/agents` | discovered agents + the known tool list |
| GET | `/api/agents/:name` | one agent including its system-prompt body |
| POST | `/api/agents` | create an agent (`name`, `description`, `tools`, `model`, `body`, `source`) |
| PUT | `/api/agents/:name` | update / rename an agent |
| DELETE | `/api/agents/:name` | delete an agent file |
| GET | `/api/models` | providers, models, default |
| GET | `/api/cwds` | candidate working directories |
| GET | `/api/sessions` | disk sessions merged with live children (`status`: running/idle/external) |
| POST | `/api/sessions` | spawn a session (`cwd`, `agent`, `provider`, `model`, `thinking`) |
| GET | `/api/sessions/:id` | one session summary |
| GET | `/api/sessions/:id/stats` | tokens, cost, context usage, message counts |
| GET | `/api/sessions/:id/todos` | this session's todo list |
| GET | `/api/sessions/:id/lens` | pi-lens diagnostics for this session |
| POST | `/api/sessions/:id/prompt` | send a prompt (`message`, optional `streamingBehavior`) |
| POST | `/api/sessions/:id/abort` | abort the current run |
| POST | `/api/sessions/:id/model` | switch model (`provider`, `modelId`) |
| POST | `/api/sessions/:id/thinking` | set thinking level (`level`) |
| POST | `/api/sessions/:id/fork` | fork this session |
| POST | `/api/sessions/:id/new` | start a fresh session in place |
| DELETE | `/api/sessions/:id` | stop (kill) the child process |
| GET | `/api/sessions/:id/events` | SSE: live Pi events, or tailed events for external sessions |

`/api/sessions/:id/events` emits `event: lifecycle` (`running` / `watching` / `exited` / `error`)
plus `event: event` frames (live RPC child) and `event: observed` frames (a session being written
by another process, i.e. the CLI). Observed frames carry `observed_message`,
`observed_compaction`, `observed_model_change` and `observed_thinking_level` payloads.

Sending a prompt to an idle session resumes it by spawning a child bound to its session file.
If another process is actively writing that session, the request is refused with `409` instead
of attaching a second writer.

## Smoke test

```bash
scripts/smoke-test.sh [provider] [model]   # full end-to-end check (server + real pi child)
node scripts/ui-smoke.mjs                  # offline frontend wiring check (no browser needed)
```

`smoke-test.sh` starts the server on an isolated port and an isolated session directory, then
checks: health, discovery endpoints, static serving, a real spawn → prompt → streamed-reply →
stop roundtrip, session stats/todos/lens, live-sync tailing of an externally-written session
file, the agent CRUD roundtrip (including a path-traversal attempt), and finally runs the
offline UI wiring check. It must not touch your real sessions or agents.

## Security

- Binds to **loopback only** by default.
- **No authentication.** Do not expose it to a network or the public internet as-is; put it
  behind an authenticating proxy if you need remote access.
- Static file serving rejects path traversal outside `public/`.
- The UI renders all session/tool data via `textContent` (no HTML injection).
- The console never writes Pi session files — Pi alone owns their lifecycle.

## Status

Early but functional: sessions, agents, live streaming chat, spawn/resume/abort/stop all work
against a real Pi installation.
