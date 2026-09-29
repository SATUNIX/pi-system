# Installation

> Already installed and looking to update instead? See [Updates](updates.md).
> For a scripted tool that wraps the commands below, see `packages/core/helpers/README.md`.

pi-system is one package. A **profile** chooses which of its extensions, skills and prompts
load; there are no separate packages per profile. It is delivered from its git repository,
`gitlab.home.internal/lab/pi-system` (the delivery is set in `packages/core/distribution.json`).

## Quick start

```sh
# 1. Install pi globally
npm install -g @earendil-works/pi-coding-agent

# 2. Check git can reach the repository without a password prompt (see "Access" below)
git ls-remote https://gitlab.home.internal/lab/pi-system.git

# 3. Register the newest pi-system release with pi and apply a profile (global scope)
git clone https://gitlab.home.internal/lab/pi-system.git
cd pi-system
node packages/core/install.mjs --channel latest --profile balanced

# 4. Start pi (trust the folder when asked; /login if it reports no models)
pi
```

pi keeps its own copy of the release under `~/.pi/agent/git/gitlab.home.internal/lab/pi-system`,
so the clone from step 3 can be deleted (or kept to develop the kit).

`pi install git:gitlab.home.internal/lab/pi-system@v0.2.1-beta.0` works too: on the first
interactive start the kit applies the `balanced` profile and asks for a `/reload` (set
`PI_KIT_AUTO_PROFILE=<name>` to pick another profile, or `0` to leave the package unfiltered).

## Access to the repository

The repository is private, so pi clones it with your own git credentials, and `/update` checks
it with `git ls-remote`. Check access first; this must not prompt for a password:

```sh
git ls-remote https://gitlab.home.internal/lab/pi-system.git
```

- **HTTPS**: store a GitLab personal access token (scope `read_repository`) in a git credential
  helper, then run one `git ls-remote` that prompts once for your username and the token. Prefer
  the system keyring for this host: `libsecret` on Linux (if your distribution ships
  `git-credential-libsecret`), `osxkeychain` on macOS, `manager` on Windows:

  ```sh
  git config --global credential.https://gitlab.home.internal.helper libsecret
  ```

  `credential.helper store` also works, but keeps the token in plain text in `~/.git-credentials`.
- **Certificate**: the server uses a private certificate authority. If git reports
  `SSL certificate problem` or `self-signed certificate`, get the CA certificate (PEM) from
  whoever runs the server and trust it for this host only:

  ```sh
  git config --global http.https://gitlab.home.internal.sslCAInfo ~/.config/git/ca-bundle-internal.pem
  ```
- **SSH**: add an SSH key to your GitLab account, then tell the kit to use the SSH form (put it
  in `~/.pi/agent/.env` or your shell profile so `/update` uses it too):

  ```sh
  export PI_SYSTEM_GIT_SOURCE=git:git@gitlab.home.internal:lab/pi-system
  ```

The background update check never prompts: without working credentials it quietly reports
that the repository could not be reached.

After cloning, pi runs `npm install --omit=dev` in its copy of the kit (pi does this for every
git package). That reads the public npm registry only; no npm account is involved.

## Channels

Run these from the clone root (`cd pi-system` first); the installer path is relative to the
current working directory.

| Channel | Install | Gets |
| --- | --- | --- |
| `latest` (default) | `node packages/core/install.mjs --channel latest --profile balanced` | The newest release tag (the newest stable one once a stable release exists) |
| `next` | `node packages/core/install.mjs --channel next --profile balanced` | Every commit on `main` |
| pinned | `node packages/core/install.mjs --channel 0.2.1-beta.0 --profile balanced` | Exactly that release (tag `v0.2.1-beta.0`) |

`/update channel <name>` switches later. See [Updates](updates.md#channels).

## Profiles

Exact per-profile extension lists and counts are generated in the
[capability matrix](capability-matrix.md) (do not hand-count — it drifts). Requirements:

| Profile | Requirements |
| --- | --- |
| `quick` | Node, git, pi |
| `balanced` | Node, git, pi |
| `long-horizon` | Node, git, pi |
| `autonomous` | Node, git, pi, live-session validation before unattended use |
| `pentest` | Node, git, pi |
| `self-improving` | Node, git, pi, Docker for mem0/memory services, optional second model (experimental tier) |
| `lite` | Node, git, pi. For small local coding models and low-context sessions |

```sh
# Run from the clone root (cd pi-system first)

# Small-model profile
node packages/core/install.mjs --channel latest --profile lite

# Full research profile (requires Docker for mem0/memory services)
node packages/core/install.mjs --channel latest --profile self-improving

# Project scope (.pi/settings.json in the current repository) instead of global
node packages/core/install.mjs --channel latest --profile balanced --scope project
```

Inside pi, `/profile` switches profile in place. See [Profiles](profiles.md).

## Install modes

| Mode | Command | When |
| --- | --- | --- |
| Release (git, default) | `node packages/core/install.mjs --channel <latest\|next\|X.Y.Z> --profile <name>` | Normal use; pi keeps its own copy, `/update` keeps it current |
| Direct from pi | `pi install git:gitlab.home.internal/lab/pi-system@vX.Y.Z` | Same, when you know the tag; the profile is applied on first start |
| Local checkout (editable) | `node packages/core/install.mjs --profile <name> --yes` | Developing the kit: pi loads the checkout in place, edit and `/reload` |
| Project auto-install | Ship `.pi/settings.json` in a repo | pi auto-installs on first trusted startup |
| npm (paused) | `npx @satunix/pi-system --profile <name>` | Once npm delivery is switched on ([Releasing](releasing.md#switching-to-npm-delivery)) |

The installer keeps exactly one registered copy of the kit: registering a checkout replaces a
release install and the other way round.

### From a checkout

```sh
git clone https://gitlab.home.internal/lab/pi-system.git && cd pi-system
npm ci --ignore-scripts
node packages/core/install.mjs --profile balanced --yes

# Specific extensions only
node packages/core/install.mjs --only secret-guard,memory-local,verify-gate --yes
```

## After install

1. Run `pi` to start the agent
2. Use `/reload` to apply extension changes without restarting
3. Check active extensions with `pi list`

## Web console (Pi Console)

The repo ships a self-hosted web UI in `packages/web-ui` (zero dependencies, no build step).
It is driven by the `web-console` extension, which registers the `/console` (alias `/webui`)
slash command in the `balanced`, `long-horizon`, `autonomous`, `self-improving` and
`pentest` profiles.

```sh
# Standalone setup (checks prerequisites, registers the extension, prints how to start)
npm run install:web

# Or, once a kit profile that includes web-console is installed, from inside pi:
/console          # start (default) and print the URL
/console open     # start and open in a browser
/console status   # running? pid, root
/console stop     # stop the server /console started
```

The server binds `127.0.0.1:8123` by default (override with `PI_CONSOLE_PORT`, `PI_CONSOLE_HOST`)
and has **no authentication** - keep it on loopback. It reads Pi's own sessions/agents and never
writes them. See `packages/web-ui/README.md`.

## Uninstall

```sh
# Removes the kit and the companions the installer registered (from the clone root):
node packages/core/install.mjs --uninstall
```

The command auto-detects the install state marker: a project marker at
`<current dir>/.pi/.pi-kit.json` wins if it exists, otherwise the global marker at
`~/.pi/agent/.pi-kit.json` is used. Pass `--scope project` or `--scope global` to force one.
After a project-scope install, run it from the repo root (or the directory you installed from)
so the project marker is found and `pi remove ... -l` runs with the matching scope. A project
uninstall deletes only the project marker; the global marker is left untouched.

The same precedence is used by the runtime readers that resolve install state (`/update`,
`/profile`, `/console`) and by the standalone web-ui installer: the project marker at
`<cwd>/.pi/.pi-kit.json` wins when it exists, otherwise the global marker at
`~/.pi/agent/.pi-kit.json` is used.

## Memory backends (`self-improving` profile — experimental)

The kit ships a Qdrant vector store for the memory MCP backend:

```sh
# Start the Qdrant vector store (memory-mcp backend)
docker compose -f packages/container/mcp-servers/memory-mcp/docker-compose.yml up -d
```

`memory-mem0` (an **experimental** extension in the `self-improving` profile) additionally
needs an external mem0 REST server, which this repo does not ship. Point it at your own mem0
instance:

```sh
# Set env var (add to ~/.pi/agent/.env) — only if you run your own mem0 server
MEM0_API_URL=http://localhost:8000
```

## Environment variables

| Var | Extension | Default | Purpose |
| --- | --- | --- | --- |
| `PI_KIT_GUIDELINES_FILE` | guidelines | `GUIDELINES.md` | Path to guidelines file |
| `PI_KIT_TODO_FILE` | todo | `TODO.md` | Path to todo file |
| `PI_KIT_PROTECTED_PATHS` | protected-paths | — | Semicolon-separated protected paths (denylist) |
| `PI_KIT_WRITE_ALLOWLIST` | protected-paths | — | Semicolon-separated allowlist; blocks writes outside it (dream/print mode) |
| `PI_KIT_FIREWALL_POLICY` | tool-firewall | shipped default-deny policy | Path to a custom firewall policy JSON |
| `PI_KIT_MEMORY_DIR` | memory-local | `~/.pi/agent/memory-local` | Memory store directory |
| `PI_KIT_COMPACT_THRESHOLD_TOKENS` | trigger-compact | `100000` | Token count that triggers auto-compaction; locks out `/compact-threshold` when set. Without it, `/compact-threshold <amount>` (e.g. `500k`) persists to `~/.pi/agent/pi-kit/trigger-compact.json` |
| `PI_KIT_VERIFY_ON_TURN` | verify-gate | `0` | Set to `1` to run the check command after successful write/edit tools when the assistant finishes its tool sequence; projects without a verify script are skipped |
| `PI_KIT_VERIFY_CMD` | verify-gate | unset | Check command for `/verify`; overrides `scripts.verify` |
| `PI_KIT_VERIFY_REVIEW` | verify-gate | on | `0` turns off the independent completion reviewer in `/verify` and `verify_completion` |
| `PI_KIT_VERIFY_REVIEW_MODEL` | verify-gate | current model | Reviewer model as `provider/id` |
| `PI_KIT_VERIFY_REVIEW_TIMEOUT_MS` | verify-gate | `900000` | Reviewer timeout |
| `MEM0_API_URL` | memory-mem0 | — | mem0 REST service URL |
| `MEM0_API_KEY` | memory-mem0 | — | mem0 API key (if auth enabled) |
| `MEM0_USER_ID` | memory-mem0 | `pi-agent` | mem0 user/agent ID |
| `DUAL_REVIEW_MODEL` | dual-review | — | Second model name for reviewer agent |
| `PI_KIT_COST_INPUT_PER_MTOK` | custom-footer | — | Override input-token dollars per million tokens |
| `PI_KIT_COST_OUTPUT_PER_MTOK` | custom-footer | — | Override output-token dollars per million tokens |
| `PI_KIT_COST_CACHE_READ_PER_MTOK` | custom-footer | — | Optional cache-read dollars per million tokens |
| `PI_KIT_COST_CACHE_WRITE_PER_MTOK` | custom-footer | — | Optional cache-write dollars per million tokens |
| `PI_KIT_TIPS` | custom-footer | on | `0` hides usage tips on the working line |
| `PI_KIT_TODO_WIDGET` | custom-footer | on | `0` hides the todo checklist widget |

See `status-bar-and-costs.md` for `.pi-kit/costs.json`, fallback user config, and `/footer` commands.
