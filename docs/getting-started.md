# Getting Started

pi-system is one package: install it once, then pick a **profile** to choose which of its
extensions load. It is delivered from its git repository, `gitlab.home.internal/lab/pi-system`:
releases are `vX.Y.Z` tags, and `next` follows `main`.

## 1. Install pi

```sh
npm install -g @earendil-works/pi-coding-agent
```

## 2. Check git can reach the kit

pi clones the kit with your own git credentials. This must list the repository's branches
without asking for a password:

```sh
git ls-remote https://gitlab.home.internal/lab/pi-system.git
```

If it prompts, set up a credential helper for `gitlab.home.internal`, or use SSH: add an SSH key
to your GitLab account and export `PI_SYSTEM_GIT_SOURCE=git:git@gitlab.home.internal:lab/pi-system`
before the next step. See [Installation](INSTALL.md#access-to-the-repository).

If it fails with `SSL certificate problem` or `self-signed certificate`, your machine does not
trust the certificate authority the GitLab server uses yet. Get its CA certificate (a PEM file)
from whoever runs the server and tell git to use it for this host only:

```sh
git config --global http.https://gitlab.home.internal.sslCAInfo ~/.config/git/ca-bundle-internal.pem
```

pi and `/update` run git with your git settings, so this covers them too.

## 3. Install pi-system

Clone the repository once and let its installer register the newest release with pi and apply
a profile:

```sh
git clone https://gitlab.home.internal/lab/pi-system.git
cd pi-system
node packages/core/install.mjs --channel latest --profile balanced
```

pi keeps its own copy of the release (under `~/.pi/agent/git/`), so the clone is only needed
for the installer. Delete it afterwards, or keep it to develop the kit.

To follow `main` instead of releases, use `--channel next`. To pin a release, use
`--channel 0.2.1-beta.0`.

If you already know the release tag, pi can install it directly. On the first start the kit
applies the `balanced` profile and asks for a `/reload`:

```sh
pi install git:gitlab.home.internal/lab/pi-system@v0.2.1-beta.0
```

## 4. Choose a profile

| Profile | Good for |
|---|---|
| `quick` | Basic safety, todo, checkpoints, memory, and status bar |
| `balanced` | Daily coding with verification and context helpers (the default) |
| `long-horizon` | Multi-hour work with task graph and branch lab |
| `autonomous` | Long-running sessions after live validation |
| `pentest` | Security engagements: strict firewall policy, pentest governance, the Conductor root orchestrator |
| `self-improving` | Full research setup with Docker-backed memory |
| `lite` | Small local models and low-context sessions |

Switch at any time inside pi with `/profile` (a picker) or `/profile <name>`. The switch is
applied in place and pi reloads; nothing is reinstalled. See [Profiles](profiles.md).

## 5. Start pi

```sh
pi
```

The first time pi starts in a folder it asks whether to trust it (pi's own prompt: trusting lets
the project's `.pi/` settings and extensions load). If pi warns `No models available`, run
`/login` to sign in to a model provider or add an API key; the kit works with any provider pi
supports.

Use `/kit` for the command cheatsheet and `/footer status` to confirm the status bar is active.

## Staying up to date

Once a day the kit checks in the background whether pi, pi-system or a linked package can be
updated, and tells you. Run `/update` to apply updates. See [Updates](updates.md).

## Working on the kit itself

To develop pi-system, register a checkout in place instead: edits take effect on `/reload`.

```sh
git clone https://gitlab.home.internal/lab/pi-system.git && cd pi-system
npm ci --ignore-scripts
node packages/core/install.mjs --profile balanced --yes
```

The installer keeps exactly one copy of the kit registered, so registering a checkout replaces
a release install and the other way round.
