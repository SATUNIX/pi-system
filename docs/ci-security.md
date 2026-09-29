# CI Security

What the pipelines check on every change, and where. The repository lives on the private
GitLab, so **`.gitlab-ci.yml` is the pipeline that runs**. The GitHub Actions workflows in
`.github/workflows/` hold the same checks for when the repository is also on GitHub (they are
dormant on GitLab); their npm release workflow is paused. Releasing is described in
[Releasing](releasing.md).

## GitLab pipeline (`.gitlab-ci.yml`)

| Job | Stage | Runs on | What it does |
|---|---|---|---|
| `checks` | test | every pipeline | `npm run check:all`: verify, eval, every smoke test (including delivery, update and package checks), profile checks |
| `gitleaks` | security | every pipeline | Secret scan of the full git history. Blocking |
| `semgrep` | security | every pipeline | SAST, fails on ERROR-severity findings. Blocking |
| `dependencies` | security | every pipeline | Lockfile integrity, `npm audit signatures`, `npm audit --audit-level=high`. Blocking |
| SAST / Secret Detection | test | every pipeline | GitLab's own analyzers (templates); reports for the Security dashboard, not blockers |
| `docs` | docs | every pipeline | Strict MkDocs build |
| `release-preflight` | release | every pipeline except tags | The release path without writing: GitLab CA, fetch of `main`, notes for the current version, read access to the Releases API |
| `gitlab-release` | release | `vX.Y.Z` tags only | Tag matches `package.json` and is on `main`; notes from CHANGELOG; creates the GitLab Release (`packages/core/gitlab-release.mjs`) |

## GitHub workflows (dormant while the repository is GitLab-only)

| Workflow | What it does |
|---|---|
| `ci.yml` | `check:all`, lockfile integrity, strict docs build, every profile on Linux and Windows, pi floor/ceiling compatibility |
| `security.yml` | CodeQL, Semgrep, gitleaks, dependency checks, OSV-Scanner, dependency review, zizmor |
| `scorecard.yml` | OpenSSF Scorecard supply-chain rating |
| `dependabot.yml` | Grouped updates for actions and npm, with a 7-day cooldown |
| `release.yml` | **Paused** npm publishing with provenance (manual dry runs only); see [Releasing](releasing.md#switching-to-npm-delivery) |

## Checks

The checks, wherever they run:

| Area | Tool | Blocks on | Config |
|---|---|---|---|
| SAST | CodeQL, `security-extended` queries, JS/TS and Actions (GitHub only) | Code-scanning alerts (branch protection) | `security.yml` |
| SAST | Semgrep: `p/javascript`, `p/typescript`, `p/nodejs`, `p/secrets`, `p/owasp-top-ten` | ERROR severity | `.semgrepignore` |
| Secrets | gitleaks over the full git history | Any finding | `.gitleaks.toml` (line-level allowlist for synthetic test fixtures only) |
| Secrets | GitLab Secret Detection / GitHub secret scanning and push protection | Reports (GitLab); a push containing a secret (GitHub) | templates / repository settings |
| Dependencies | `npm audit` | High or critical | triage in [Supply Chain](supply-chain.md) |
| Dependencies | `npm audit signatures` | A dependency with a missing or invalid registry signature or attestation | |
| Dependencies | OSV-Scanner (GitHub only) | Known vulnerabilities (OSV database) | |
| Dependencies | Dependency review (GitHub PRs only) | A new dependency with a high-severity advisory or a non-allowlisted license | `security.yml` |
| Lockfile | `packages/core/lockfile-check.mjs` | A package resolved from anywhere but the npm registry, a missing sha512 hash, or an unreviewed install script | allowlist in the script |
| Workflows | zizmor (GitHub workflows) | Template injection, over-broad permissions, credential persistence, cache poisoning, unpinned actions | |
| Package | `packages/core/pack-check.mjs` | A missing required file, a leaked private file, an oversize tarball, a profile that does not resolve from the tarball | |

## Hardening in the GitHub workflows

- Every action is pinned to a full commit SHA (with the version in a comment); Dependabot bumps
  them.
- The default token is read-only (`permissions: contents: read`); jobs that need more ask for it
  per job. Only the publish job gets `id-token: write` (npm trusted publishing) and
  `contents: write` (to create the GitHub Release).
- `actions/checkout` never persists credentials.
- `npm ci --ignore-scripts` everywhere: no dependency lifecycle script runs in CI.
- The publish job has no dependency cache, runs in the protected `npm` environment, and only
  publishes a tag whose commit is on `main` and matches `package.json`.
- Scanner binaries are either pinned container images or downloads verified against a pinned
  SHA-256.

## Running the checks locally

```sh
npm run check:all
npm run security:lockfile
npm audit signatures && npm audit --audit-level=high
gitleaks git --redact .                          # https://github.com/gitleaks/gitleaks
semgrep scan --config p/javascript --config p/typescript --config p/nodejs --config p/secrets --config p/owasp-top-ten
zizmor .github/workflows                          # pipx install zizmor
```

## Adding an allowlist entry

- **gitleaks**: add a regex matching the exact fixture line to `.gitleaks.toml` with a comment
  naming the file. Never allowlist a whole file or path.
- **Semgrep**: prefer an inline `// nosemgrep: <rule-id>` with a comment explaining why the code
  is safe; use `.semgrepignore` only for whole trees that are not shipped code.
- **Install scripts**: read the script, then add the package to `INSTALL_SCRIPT_ALLOWLIST` in
  `packages/core/lockfile-check.mjs` with a one-line summary of what it does.
