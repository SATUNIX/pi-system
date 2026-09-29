# Supersession of the Pi Coder corpus

**Decision date:** 2026-09-14
**Decided by:** repository owner (authoritative)
**Status:** in force
**Porting status relative to `pi-system`:** decision and inventory carried into this
monorepo; the inventory's unresolved rows are flagged below. Nothing is claimed as
ported that is not present in this tree.

## Decision

The pi kit (`misc-agents-pi-kit/`) and the fleet capability
(`fleet-capability-pi-agent/`) are now the main, latest version of this repository.
They replace the previous "Pi Coder — Complete Agent Corpus" that lived on `main` until
this change.

This is final for now. It does not wait on the assessment below. That assessment decides
what to carry forward from the previous system. It does not decide whether the new system
replaces it.

The previous tree is not lost in the predecessor repository. It is the second parent of
the merge commit that introduced that layout, and the pre-supersession `main` is at commit
`6daf815` **in the predecessor history**:

```sh
git show 6daf815:README.md
git ls-tree -r --name-only 6daf815
git checkout 6daf815 -- harness/corpus/current/extensions/auto-verify.ts   # restore one file for study
```

Those objects are **not present in this monorepo's history** (verified: `git cat-file -t
6daf815` fails here). In `pi-system`, that predecessor history was folded in through the
reverse-merge adoption commit `6acf985` over the GitLab initial commit `90fe445`. To study
a pre-supersession file, use the offline bundle of the predecessor repository recorded in
`docs/legacy-repo-deletion-readiness.md` — not this tree, and no longer a clone of the
predecessor project itself, which is being retired:

```sh
git clone <bundle> pi-legacy
git -C pi-legacy show 6daf815:harness/corpus/current/extensions/file-trigger.ts
```

## Agent behaviour conflicts must be assessed

The two systems make different choices about how an agent behaves. Where they conflict,
the difference must be assessed, not silently resolved in favour of whichever one is
loaded.

The previous environment had genuine strengths that were noted in practice. The new push
brings many benefits of its own: install profiles, a fail-closed verify gate, the tool
firewall and policy classifier, trace ledger, governed pentest domain, fleet packaging,
and themes. Neither side wins by default on any single behaviour.

For each conflict, record:

1. **The behaviour.** For example: when checkpoints are taken, what happens on model
   failure, or whether writes are allowed headless.
2. **What each system does,** with the file that implements it.
3. **Evidence.** A benchmark, eval run, incident or observed session, not preference.
4. **Outcome.** Keep the new behaviour, port the old one, or combine them.

## Carry positives forward by integrating them

Any part of the previous system that genuinely looks like a positive should be added to
the new system and integrated properly. That means porting it into the kit's structure
through normal changes: an extension under `packages/extensions/src/` (or
`packages/extensions/third_party/` for adapted upstream code), a profile entry, a skill, a
test, and a changelog line. It does not mean copying the old corpus back alongside the new
one.

Many of these will likely be found by the auto-update and auto-improvement cycles
(`docs/agent-improvement/`). This requirement stands whether a cycle finds them or a
person does.

### Assessment inventory

Starting list from a name-level comparison on 2026-09-14. "Counterpart" means a kit
component with the same or similar purpose. That is a lead for the assessment, not a
finding that the two are equivalent. Counterparts are now realized in this monorepo under
`packages/extensions/src/<name>/` (first-party) and
`packages/extensions/third_party/<name>/` (vendored); verify per-row before treating any
pair as equivalent.

| Previous component | Kit counterpart | Notes |
| --- | --- | --- |
| `extensions/auto-verify.ts` (syntax + pytest every turn) | `verify-gate`, `verifier-board` (partial) | Assess per-turn test injection vs gate-at-completion. |
| `extensions/model-fallback.ts` (switch model on API failure, auto-recover) | `provider-router` (partial) | Assess automatic recovery behaviour. |
| `extensions/post-tool-use.ts` (validate Python/JSON/YAML after each write) | none found | Candidate to port. |
| `extensions/context-monitor.ts` (50/70/85% thresholds) | `custom-footer`, `context-sieve` (partial) | Assess threshold notifications. |
| `extensions/permission-modes.ts` (plan/auto/acceptEdits, headless detection) | `tool-firewall`, `vendor/plan-mode` (partial) | Behaviour conflict: headless write policy. |
| `extensions/ralph-loop.ts` | `autonomous-loop` | Compare loop termination and guard rails. |
| `extensions/turn-end-checkpoint.ts` | `vendor/git-checkpoint` | Compare checkpoint timing. |
| `extensions/plan-persist.ts` | `spec-plan`, `task-graph` (partial) | |
| `extensions/file-trigger.ts` | none found | Candidate to port. |
| `extensions/secret-guard.ts`, `protected-paths.ts`, `dirty-repo-guard.ts`, `dual-review.ts`, `todo.ts`, `subagent.ts`, `handoff.ts`, `notify.ts`, `trigger-compact.ts`, `custom-compaction.ts`, `auto-commit-on-exit.ts`, `git-checkpoint.ts`, `plan-mode-*` | same-named kit/vendor components | Diff the implementations; the kit versions are newer but not verified as strict supersets. |
| `rules/*.md` (core principles, coding protocol, testing, small-model, model tuning, tool usage, git workflow, hook authoring, context management) | `guidelines`, `packages/kit/skills/*` | Compare guidance. The small-model rules were tuned against local models. |
| `skills/{coder,reviewer,debugger,planner}.md` | `packages/kit/skills/*`, `packages/kit/agents/*` | |
| `harness/` evolutionary corpus: generations, lineage, runner, coding and pentest scorers, train/val/eval splits, `goals.yaml` | `packages/core/eval`, `self-improvement`, `docs/agent-improvement/` (partial) | The held-out split and lineage tracking are strong candidates to keep — **still unported**. |
| `infra/judge-api/` (scoring service) | none found | Assess against the kit's eval harness. **Still unported.** |
| `infra/pi-coder/` container and `pi-wrapper.sh` | `packages/container/` | Compare provider/key handling. |
| `dag-runner.py` (task decomposition + parallel execution) | `task-graph`, `orchestrator`, `conductor` | |
| `lm-model-manager.sh` (LM Studio management) | none found | Only if LM Studio is still in use. **Still unported.** |
| `AUDIT.md` (import audit log and inspection process) | `docs/supply-chain.md`, `SECURITY.md` | Keep an audit trail for every external import. |

### Still-unported candidates

Verified against this monorepo on 2026-09-16. These have no counterpart here and remain
open port candidates; they are not implemented by this port. They are reachable only
through the predecessor repository's history — see
`docs/legacy-repo-deletion-readiness.md` for the preserved bundle, and delete that
repository only once the bundle is stored durably.

- **Per-tool-use write validation** (`extensions/post-tool-use.ts`) — no after-write
  Python/JSON/YAML validation extension found.
- **File-trigger extension** (`extensions/file-trigger.ts`) — no file-watching trigger
  extension found.
- **`infra/judge-api/` scoring service** — no counterpart; the eval harness under
  `packages/core/eval/` is the only scoring path.
- **`lm-model-manager.sh`** — no counterpart; only relevant if LM Studio is still in use.
- **Held-out train/val/eval split and lineage tracking** — no persistent held-out split or
  generation/lineage tracking found. The live runner
  (`packages/core/eval/live/`) and `tests/live-evaluation-integrity.test.mjs` contain
  per-case holdout assertions, but that is not the predecessor's split/lineage system.

## Pending: search for additional functionality

A search is required for further functionality worth adding to the new system. The first
item named is a **sanitiser system**, for example input and output sanitisation of tool
results, retrieved content and model output. The kit already has related pieces to build
on: `secret-guard` redaction, the `save` snapshot redaction, and the `tool-firewall`.

This is not part of this change. The search and any sanitiser work land in a later commit.

## CI

The monorepo's pipelines are the GitHub Actions workflows in `.github/workflows/`
(`ci.yml`, `security.yml`, `release.yml`, `scorecard.yml`) and the root `.gitlab-ci.yml`; see
[CI Security](ci-security.md). The predecessor subprojects' own CI files (the kit's
`.github/`, the fleet `.gitlab-ci.yml`, `.gitea/`) were removed during the internal 1.1.0
monorepo reorganization. See
`docs/archive/CHANGELOG-internal.md` § Removed.
