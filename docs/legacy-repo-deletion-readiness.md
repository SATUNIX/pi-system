# Predecessor repo deletion readiness

Last verified: 2026-09-16.

This record answers one question: **is everything useful now in `pi-system`, so the
predecessor repo (`pi-pentest-project`) can be deleted?**

Short answer: **yes for the tracked working tree at its latest commit; two classes of
content exist *only* in that repo's git objects and are preserved out-of-band (see
"Only in the predecessor's history").** Delete only after the bundle below is stored
somewhere durable.

## 1. Ported — nothing outstanding at the latest commit

Verified by path-level comparison against the predecessor's `main` at `85e67c8`
("feat(pi-kit): add /profile to switch kit profiles from the TUI"), the newest commit
there.

| Area | Predecessor | Here | Status |
| --- | --- | --- | --- |
| Extensions (first-party + vendored) | 92 + 42 dirs | `packages/extensions/src/<name>` + `third_party/<name>` | ported; this tree additionally carries the hardening added since |
| Kit resources | skills 43, prompts 26, themes 17, profiles 6 | `packages/kit/{skills,prompts,themes,profiles}` | ported 1:1 |
| Core tooling | `kit/*.mjs` (33) | `packages/core/` | ported and retargeted to the monorepo layout |
| Tests | 43 | `tests/` | ported; more here |
| Container capability | `fleet-capability-pi-agent/` (58) | `packages/container/` | ported except per-subproject CI scaffolding (below) |
| Web UI | `pi-console/` (32) | `packages/web-ui/` | ported 1:1 |
| Docs | 140 files | `docs/` | ported; this tree adds `SUPERSESSION.md`, `npm-publishing.md`, `proposals/npm-distribution.md` |
| Review records | `reviews/` (32) | `reviews/` | ported 2026-09-16 |
| Archive (handoffs, plans) | `docs/archive/` (13) | `docs/archive/` | ported 2026-09-16, including `Pi RAIA.txt`, the five Conductor-phase handoffs, `LATEST_PLAN_2026-08-04T042958Z.md`, `HANDOFF_PROMPT_FOR_V1_HARDENING.md` |
| Historical repo plan | `docs/PI_KIT_REPO_PLAN.md` | `docs/PI_KIT_REPO_PLAN.md` | ported 2026-09-16 (its superseded banner intact) |
| Improvement cycle records | `docs/agent-improvement/cycles/**` (82 files, 2 cycles) | same path | ported 2026-09-16; kept so the `/pi-improve` evidence layout has real worked examples |
| Root agent docs | `AGENTS.md`, `CLAUDE.md`, `.env.example` | same | ported |
| GitLab pipeline | root `.gitlab-ci.yml` | `.gitlab-ci.yml` | adapted: it is the pipeline that actually ran for this project, since GitLab does not execute `.github/workflows/`. Rebuilt self-contained around `npm run check:all`, which enumerates every check from `package.json` instead of the predecessor's hardcoded list |

Deliberately **not** ported, with reasons:

- **Per-subproject CI/editor scaffolding** (`fleet-capability-pi-agent/.gitea/workflows/ci.yml`,
  its `.gitlab-ci.yml`, `.gitattributes`, `.gitignore`, `CODEOWNERS`). This monorepo has
  one CI surface (`.gitlab-ci.yml`, plus the `.github/workflows/` kept for GitHub) and one
  set of root dotfiles; the fleet `CODEOWNERS` content was folded into
  `packages/container/CONTRIBUTING.md` and `SECURITY.md`. Porting them would create a
  second, dead CI directory. (The predecessor's *root* `.gitlab-ci.yml` is a different
  case and was adapted — see the table above.)
- **Root `HANDOFF.md`** — superseded session handoff; also folded into the archive copy.
- **`PLAN.md`** (uncommitted in the predecessor at the time of porting) — the working plan
  for the npm-distribution assessment, whose result is already
  `docs/proposals/npm-distribution.md`. Its content is a subset of that proposal.
- **`.pi/` runtime state** — `ctx-contributions/{caveman,memory-local,sieve-budget}.json`,
  `task-classification.json`, `todos/<uuid>.md`, `tool-firewall-audit.jsonl`, `trace.jsonl`,
  `verdicts.json`, `verify-report.md`. These are per-session artefacts written by the
  extensions themselves (`context-sieve`, `memory-local`, `caveman`, `orchestrator`,
  `provider-router`, `trace-ledger`, `tool-firewall`, `verifier-board`) and regenerated at
  runtime. The checked-in copies were one machine's session record — `task-classification.json`
  is a single classification with a timestamp, `sieve-budget.json` a one-line budget
  snapshot — so no configuration is lost by leaving them behind. No `.pi/` file is tracked
  in this monorepo; the directories are created on demand.
- **`docs/agent-improvement/cycles/**/03-evidence/*.log|*.jsonl`** — *not* skipped:
  these were carried across too, so the cycle records stay self-consistent.

## 2. Only in the predecessor's history (act before deleting)

These are reachable **only** through the predecessor repo's git objects. They are not in
this monorepo's history — `git cat-file -t 6daf815` fails here — so deleting that repo
without preserving them loses them permanently.

### 2a. The Pi Coder corpus at `6daf815`

`SUPERSESSION.md` names five candidates from the pre-supersession corpus that have no
counterpart here:

- `harness/corpus/current/extensions/post-tool-use.ts` — per-write Python/JSON/YAML validation.
- `harness/corpus/current/extensions/file-trigger.ts` — file-watching triggers.
- `infra/judge-api/` — a scoring service (the eval harness is the only scoring path here).
- `lm-model-manager.sh` — LM Studio lifecycle management.
- the corpus `harness/` train/val/eval **held-out split and lineage tracking**.

### 2b. `origin/fix/bonsai-model` — 31 commits not merged into `main`

A development stream that exists only on that branch. Two kinds of content:

- **Transferable agent rules** (relevant to any future system, not just the old one):
  e.g. `PRM-020` "Extend faithfully; ignore false lints" (coding protocol) and `PRM-019`
  "Verify it fires, not just loads — a guard/lint/check must flag a known-bad input, not
  merely load clean" (coding protocol + testing).
- **`auto-verify.ts` fixes** (`EXT-030`, `EXT-042`): merging tsc stdout+stderr before
  filtering; masking shell arithmetic before unquoted-expansion checks. Only relevant if
  that extension is revived, but the *lessons* generalise to the kit's own verify paths.

Recommendation: harvest the rules (2b) into `packages/kit/skills/` guidance if they are
not already covered — "verify it fires, not just loads" in particular is the same failure
class as a smoke suite that only checks that a guard loads. `docs/future-work.md` tracks
the wider review; the rules themselves are small enough to port deliberately rather than
by copying the branch.

### 2c. Unmerged local branches

`fix/pi-kit-installer-and-smoke-harness`, `pi-kit/finish-reason-retry` — both already
merged into `main` by content (their fixes are in this tree: installer/full-checkout
eviction, finish-reason retry). `origin/import/*` and `origin/release/pi-agent-main`
contain no commits that are not in `main`.

## 3. Preservation performed

An offline bundle of the **entire** predecessor repository was created — all refs,
including the corpus history, `fix/bonsai-model` and the working stash:

```
/home/ms01/pi-workspace/legacy-archive/pi-pentest-project-2026-09-16.bundle   (1.5 MB)
/home/ms01/pi-workspace/legacy-archive/SHA256SUMS
```

```
sha256  207e2eb2d0df7042432172553bcc8d547e4edf778e271c51567d4d9b7fa075a3
```

Verified on 2026-09-16: `git bundle verify` reports "The bundle records a complete
history"; a clone from the bundle reproduces `HEAD = 13828ba`, and the objects
`6daf815:harness/corpus/current/extensions/file-trigger.ts`, the `fix/bonsai-model` tip
`743543f` and the stash commit `acd83463` are all present.

Restore or inspect it with:

```sh
git clone /home/ms01/pi-workspace/legacy-archive/pi-pentest-project-2026-09-16.bundle pi-legacy
cd pi-legacy
git log --oneline -1 743543f                    # the unmerged bonsai stream
git show 6daf815:harness/corpus/current/extensions/file-trigger.ts
```

### Where to keep it

The bundle is deliberately **outside** this monorepo. It contains the predecessor's
complete history — every blob ever committed there — so it must not be committed to a tree
that is expected to be published (npm surfaces are excluded from `packages/*` today, but a
root-level blob of that kind is a latent leak of whatever is in that history).

Recommended, in order:

1. **Archive the predecessor GitLab project read-only** instead of deleting it. This keeps
   every branch and all history server-side with no extra work, and is reversible.
2. Store the bundle somewhere durable and independent of this workstation (another host,
   a backup target, or the archived project's release assets once it is read-only).
3. Only then delete the project.

## 4. Deletion checklist

- [ ] Bundle exists and its SHA-256 matches the value above (or a newer bundle's).
- [ ] Bundle stored on at least one target other than this workstation.
- [ ] The 31 `fix/bonsai-model` commits reviewed for transferable rules.
- [ ] The five corpus candidates in §2a either ported or explicitly waived.
- [ ] Predecessor GitLab project archived (recommended) or deleted.
- [ ] `docs/SUPERSESSION.md` updated to point at the bundle instead of "use a clone of the
      predecessor repository" — that instruction stops being actionable after deletion.
