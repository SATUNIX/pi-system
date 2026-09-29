# Independent v1.0.0 Production-Readiness Review

Date: 2026-08-04  
Branch: `hardening/production-readiness-plan`  
Reviewed HEAD: `8d3b205`

## Overall verdict

**No — do not tag `v1.0.0` from this state.**

The implementation contains substantial real work, and all required offline suites passed, but the production-ready claim is false in several release-critical ways:

- full-package profiles are not applied to Pi's runtime resource set;
- the default safety-policy composition blocks core first-party tools, especially in headless/autonomous use;
- common supported-platform destructive commands and elementary secret-copy/encoding forms bypass the claimed safety boundary;
- the committed npm lock state cannot produce a clean reproducible install; and
- the capstone profile matrix is a metadata check, not the plan's install + verify + eval regression.

The condition for reconsidering the tag is: fix every blocking finding below, fix the release-gating high findings (path authorization, broken non-experimental tools, recovery behavior, release/install documentation), replace the false-green integration tests, then repeat the full offline suite and an independently reviewed Windows/Linux profile install/load/verify/eval matrix. A provider-independent Pi package-load smoke should be separately authorized and completed before calling the runtime production-ready; it was intentionally not run during this offline review.

**This focused agentic-capability pass does not change that verdict; it strengthens it.** The kit has a real subprocess-delegation primitive, but the shipped configuration does not automatically select a stronger model by task difficulty, complexity scoring produces advisory prompt text rather than an enforced workflow, ordinary stall/failure patterns bypass recovery, compaction continuity is broken, and verification can still produce false completion. The gap is therefore not only release hardening: the claimed small-model capability multiplier is not yet assembled end to end.

## Test and reproduction baseline

Reviewer A re-ran the required commands from this checkout:

```text
npm run verify                 PASS
npm run test:security          PASS
npm run eval                   PASS (13/13 fixtures; Node DEP0190 warning)
node tests/docs-smoke.mjs      PASS
node tests/epic1-smoke.mjs     PASS
node tests/epic2-smoke.mjs     PASS
node tests/secret-guard-smoke.mjs   PASS
node tests/tool-firewall-smoke.mjs  PASS
```

The eval/smoke harness is genuinely offline: it transpiles local TypeScript and drives fake Pi handlers (`kit/eval/harness.mjs:1-40`). Timestamps/random suffixes isolate artifacts but do not affect assertions. The only server used by a required smoke is loopback-only (`tests/epic2-smoke.mjs:92-129`).

The orchestrator independently re-read or reproduced every blocking/high finding. Inert command strings were passed to handlers but never executed. Destructive path testing was confined to fresh OS temporary directories.

## Triaged findings

### Blocking

#### F-01 — Full-package profile selection is metadata only

- **Evidence:** the root Pi package loads every `extensions/*/index.ts` and `vendor/*/index.ts` (`package.json:11-15`). The installer computes `selected` (`kit/install.mjs:122-133`) but registers the same wildcard root package (`kit/install.mjs:226-229`); `selected` is later used only for companion externals and a marker (`kit/install.mjs:231-245,263-275`). `settingsPath` is calculated but never written (`kit/install.mjs:67-69`).
- **Impact:** `--profile quick` still loads quarantined stubs, experimental extensions, and `pentest-governance-domain`. The profile tables, manifest parity check, and trust quarantine do not describe runtime behavior.
- **Raised by:** Reviewer A; independently discovered and confirmed by the orchestrator.
- **Confidence:** very high.
- **Triage:** blocking as raised. This also resolves a reviewer disagreement: Reviewer C judged `remote-review` runtime quarantine resolved from profile metadata, but the wildcard installation proves it is not resolved for full-package installs.

#### F-02 — Shipped policies disable the kit's own promised capabilities

- **Evidence:** the firewall policy recognizes only nine tool names (`extensions/tool-firewall/default-policy.json:6-15`). First-party tools such as `subagent`, `task_create`, `record_verdict`, and `memory_store` therefore become `ask`, then fail closed headlessly (`extensions/tool-firewall/index.ts:200-205,303-307`). `pentest-governance-domain` additionally blocks every non-read-only direct tool unless undocumented `PI_ALLOW_DIRECT_TOOLS=1` is set (`extensions/pentest-governance-domain/index.ts:609-617`).
- **Independent repro:** headless `subagent` returned `approval required ... no interactive UI`; governance returned `MCP-only mode is enabled` for `todo` with default environment.
- **Impact:** the `autonomous` profile cannot use core delegation/task/verdict/memory tools, and `balanced` and above block direct coding tools by default. F-01 can impose the same governance block on `quick`.
- **Raised by:** Reviewer A.
- **Confidence:** very high.
- **Triage:** blocking as raised; this is a direct contradiction of the profile purposes, not a documentation-only issue.

#### F-03 — Common destructive commands bypass the default firewall

- **Evidence:** `bash` is explicitly allowed (`extensions/tool-firewall/default-policy.json:13-15`); the content layer raises that decision only for finite regex matches (`extensions/tool-firewall/index.ts:208-241`). The documented unknown-tool backstop therefore does not apply to an allowlisted shell.
- **Independent repro:** literal `rm -rf` blocked, but all of these handler inputs returned allow: PowerShell `Remove-Item -Recurse -Force`, `r''m -rf`, Node `fs.rmSync(...recursive:true...)`, and `git clean -fdx`. No command was executed.
- **Impact:** the universal boundary misses the native destructive primitive on a supported Windows platform and modest, realistic wrappers/obfuscation.
- **Raised by:** Reviewer A.
- **Confidence:** very high.
- **Triage:** blocking as raised. Although `docs/security.md:48-51` admits regex evasion, the missed Windows primitive and false backstop claim are incompatible with the Epic 2 security sign-off.

#### F-04 — Elementary secret copy/encoding forms bypass `secret-guard`

- **Evidence:** shell blocking requires a transfer verb plus a literal protected/secret path match (`extensions/secret-guard/index.ts:57-68,85-93,131-143`). Tests cover literal paths only (`tests/secret-guard-smoke.mjs:80-88`).
- **Independent repro:** literal `base64 .env` blocked, while `base64 .e??`, `cp .e??`, a `printf`-constructed `.env`, and a PowerShell split-path/Base64 read all returned allow. No command or live secret was used.
- **Impact:** this misses the exact copy/encoding bypass class Epic 2 and this review were intended to challenge.
- **Raised by:** Reviewer A.
- **Confidence:** very high.
- **Triage:** blocking as raised. The general heuristic-DLP disclaimer does not make these elementary bypasses acceptable for the claimed hardened boundary.

#### F-05 — The committed lockfile cannot reproduce the package

- **Evidence:** root package/dev pin are `0.9.0` and Pi `0.76.0` (`package.json:3,31-34`), but the lockfile root is `0.1.0` and resolves Pi `0.79.6` (`package-lock.json:3,9,20-23`). CI uses `npm install`, not `npm ci` (`.github/workflows/ci.yml:17,34,50,65`; `.gitea/workflows/ci.yml:15,29,44,57`). The release script changes/stages only `package.json` (`kit/release.mjs:55-63,77-80`).
- **Independent repro:** `npm ci --dry-run --ignore-scripts --offline` failed with `EUSAGE`: lockfile Pi `0.79.6` does not satisfy `0.76.0`.
- **Impact:** a clean deterministic install fails, local typechecking used a different Pi version than the stated dev pin, and the cutter preserves the defect.
- **Raised by:** Reviewers B and C.
- **Confidence:** very high.
- **Triage:** blocking as raised.

#### F-06 — The capstone “full profile regression” is not the required regression

- **Evidence:** Epic 9.1 requires install + verify + eval for every profile and lite on Windows/Linux (`LATEST_PLAN_2026-08-04T042958Z.md:110-111`). For profiles, `profile-check.mjs` only resolves names, maturity, and ordering (`kit/profile-check.mjs:58-85`); only lite is exported/package-verified (`kit/profile-check.mjs:86-100`). Both CI files label this the full profile regression (`.github/workflows/ci.yml:37-51`; `.gitea/workflows/ci.yml:32-45`).
- **Independent repro:** `node kit/profile-check.mjs --profile quick` returned `17 extensions resolve ... OK` without importing, registering, installing, verifying, or evaluating one extension.
- **Impact:** the capstone gate stayed green despite F-01, F-02, H-02, and H-03.
- **Raised by:** Reviewers A and B as high; Reviewer C as blocking.
- **Confidence:** very high.
- **Triage:** upgraded/retained at **blocking** because it is the plan's explicit capstone acceptance gate and its substitution concealed confirmed runtime failures.

### High

#### H-01 — Dream/print-mode write authorization is not a path boundary

- **Evidence:** `protected-paths` uses substring matching (`vendor/protected-paths/index.ts:29-35`) and handles only exact `write`/`edit` tools (`vendor/protected-paths/index.ts:38-43`).
- **Independent repro:** with `AGENTS.md;.pi/memory;GOAL.yaml`, `src/app.ts` blocked but `src/AGENTS.md.backdoor`, `.pi/memory-escape/file.txt`, and a `bash` redirect to `src/app.ts` were allowed.
- **Impact:** the enforcement point cannot guarantee Sprint 6.3's “only allowlisted paths” for a future unattended Pi run.
- **Raised by:** Reviewers A and B.
- **Confidence:** very high.
- **Triage:** high as raised; deduplicates A-5 and B-03.

#### H-02 — Four `branch-lab` tools use the wrong public execute signature

- **Evidence:** `branch_create`, `branch_switch`, `branch_discard`, and `branch_merge` treat argument one as params (`extensions/branch-lab/index.ts:156-167,181-220`) instead of `execute(toolCallId, params, signal, onUpdate, ctx)`. The smoke calls the same incorrect shape (`tests/epic1-smoke.mjs:143-155`).
- **Independent repro:** production-shaped `branch_create.execute("call-1", {taskId:"review-task"}, ...)` failed with `Invalid taskId` before any Git action.
- **Raised by:** Reviewer A.
- **Confidence:** very high.
- **Triage:** high as raised.

#### H-03 — `provider-router` does not route inference

- **Evidence:** it returns `{model}` from the post-selection `model_select` event (`extensions/provider-router/index.ts:45-62`). Pi has already set/persisted the model before emitting that notification and ignores the return (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1083-1109`). The cast at source line 55 hides the contract mismatch.
- **Independent repro:** the handler returned `{model:"gemma4:latest"}`; runtime source confirms that value has no consumer.
- **Impact:** a non-experimental-profile extension advertised as routing inference is notification-only stub behavior.
- **Raised by:** Reviewer A.
- **Confidence:** very high.
- **Triage:** high as raised.

#### H-04 — `git-checkpoint` clears restore points before a later fork can use them

- **Evidence:** refs are recorded at `turn_start` and read at `session_before_fork`, but the map is cleared on `agent_end` (`vendor/git-checkpoint/index.ts:12-18,20-38`).
- **Independent repro:** simulated `tool_result → turn_start → agent_end → session_before_fork`; only `git stash create` occurred, never `git stash apply`.
- **Impact:** the advertised prior-point restoration and the recovery workflow's checkpoint step are broken.
- **Raised by:** Reviewer A.
- **Confidence:** high.
- **Triage:** high as raised.

#### H-05 — `skill_archive` permits path traversal and destructive destination aliasing

- **Evidence:** raw `skill_name` is joined into source/destination paths, the destination is recursively removed, and then the source is renamed (`extensions/skill-forge/index.ts:206-225`). Unlike synthesis (`:160-163`), archive has no validation/containment.
- **Independent repro:** in a fresh temp workspace, `skill_name="../../victim"` normalized source and destination to the same temp victim; the tool deleted it, then threw `ENOENT`.
- **Impact:** a model-visible beta tool can delete an arbitrary reachable path. Exposure is limited to the experimental profile, but the operation itself is unsafe.
- **Raised by:** Reviewer B.
- **Confidence:** very high.
- **Triage:** high as raised.

#### H-06 — Recovery orchestration is guidance/scaffolding, not the promised flow

- **Evidence:** runtime writes instructions and a blank report, then consumes the marker (`extensions/recovery-orchestrator/index.ts:70-121,169-197`). It never spawns scouts, forks, collects/ranks causes, delegates a repair, or validates the outcome. The fixture asserts report presence and prompt keywords only (`kit/eval/fixtures.mjs:184-216`).
- **Impact:** Epic 5.3's “scripted stuck-task fixture drives the flow” was narrowed, yet the extension is beta in non-experimental long-horizon/autonomous profiles.
- **Raised by:** Reviewer A as medium; Reviewer B as high.
- **Confidence:** very high.
- **Triage:** **high**. The manifest carefully says “steers,” but the authoritative DoD and production roadmap claim an implemented recovery mode, so the narrowed substitute is material.

#### H-07 — Canonical install documentation contains guaranteed-failure paths

- **Evidence:** README, Getting Started, and Install tell users to export lite then immediately `pi install` (`README.md:32-45`; `docs/getting-started.md:13-25`; `docs/INSTALL.md:16-29`), while the surface guide states the generated dependency must first be installed (`docs/install-surfaces.md:27-31`). README/Install also point portable Git installs at nonexistent `v0.1.0` (`README.md:10-15`; `docs/INSTALL.md:57-65`); only `v0.9.0` exists.
- **Independent verification:** `refs/tags/v0.1.0` did not resolve; `refs/tags/v0.9.0` did.
- **Impact:** both the primary lite workflow and the advertised portable release path can fail for a newcomer.
- **Raised by:** Reviewer C (two high findings).
- **Confidence:** very high.
- **Triage:** high; deduplicated into one onboarding/install correctness finding.

#### H-08 — The release cutter is not a safe or complete capstone gate

- **Evidence:** it omits the profile matrix and real MkDocs build (`kit/release.mjs:65-75`), accepts any digit-only version without monotonicity (`:19-21,51-59`), ignores arbitrary dirty `package.json` content in its cleanliness check (`:42-49`), and commits that file (`:77-80`). Dry-run logs but skips every gate because `run` executes only when `!dryRun` (`:27-30`). It also omits lockfile maintenance (F-05).
- **Impact:** a downgrade or incompletely verified tag can be created, unrelated manifest edits can be swept in, and dry-run provides no preflight evidence.
- **Raised by:** Reviewer C (high) and Reviewer B (dry-run medium).
- **Confidence:** very high.
- **Triage:** high; B-12 is folded into this broader release-control finding.

#### H-09 — The capstone documentation freeze is not true against HEAD

- **Evidence:** `docs/roadmap.md:7-31` says all nine epics/`1.0.0` landed while package/tag remain `0.9.0`. `docs/improvement-roadmap.md:68-106,167-182` retains obsolete claims about missing references, design-only recovery, env-only auto mode, and no eval harness. `docs/skills-and-efficiency-improvement-plan.md:1-26` says “not yet implemented” while later claiming completion. `docs/security.md:73-81` and `CHANGELOG.md:12-25` present a 1.0.0 sign-off/release before the tag.
- **Impact:** current, historical, implemented, and deferred states are indistinguishable, directly failing Epic 7.2/9.3 truthfulness DoDs.
- **Raised by:** Reviewer C.
- **Confidence:** very high.
- **Triage:** high as raised.

### Medium

#### M-01 — Test coverage encodes narrowed or fake contracts

- Branch-lab tests use the wrong execute shape (`tests/epic1-smoke.mjs:143-155`).
- Provider-router tests assert an ignored event return (`tests/epic2-smoke.mjs:133-150`).
- Recovery tests assert prompt words, not transitions (`kit/eval/fixtures.mjs:184-216`).
- Security eval repeats literal happy paths (`kit/eval/fixtures.mjs:23-65`).
- Docs smoke skips external/Pi commands and executes only export (`tests/docs-smoke.mjs:35-85`).
- **Raised by:** Reviewers A and B as high/medium.
- **Confidence:** very high.
- **Triage:** downgraded from A's high to medium as a standalone finding because the concrete escaped failures already carry blocking/high severity; this remains the systemic reason green suites overstated confidence.

#### M-02 — Epic 6 scoring/self-improvement is not candidate-sensitive or end-to-end

`skill_score` ignores the named skill and returns the unchanged kit-wide eval pass rate (`extensions/skill-forge/index.ts:136-147,181-203`); its fixture never calls the tool (`kit/eval/fixtures.mjs:249-259`). `/improve` mines repeated-read/error notes directly and never synthesizes or scores (`extensions/self-improvement/index.ts:48-83,110-140`).

- **Raised by:** Reviewer B as high.
- **Confidence:** very high.
- **Triage:** downgraded to medium because these tools are confined to the explicitly experimental profile and their manifests now describe narrower behavior; the roadmap's claim that Epic 6 fully delivered remains false.

#### M-03 — Progress-guard calibration was explicitly deferred

The plan required real trace calibration, but docs state the thresholds remain first-principles defaults with no live-session corpus (`docs/efficiency-and-loops.md:63-79`; `extensions/progress-guard/index.ts:25-37`).

- **Raised by:** Reviewer B.
- **Confidence:** high.

#### M-04 — Verdict integrity fails open and duplicates a fragile file contract

`verify-gate` silently swallows board I/O errors (`extensions/verify-gate/index.ts:18-37`); `orchestrator` treats malformed/unreadable state as not blocked (`extensions/orchestrator/index.ts:108-122`). Writes are non-atomic and duplicated across extensions.

- **Raised by:** Reviewer B.
- **Confidence:** high.

#### M-05 — Additional model/profile contract gaps remain

- `pi-lean-ctx` absence is only announced as “disabled”; no disabling occurs (`extensions/session-helpers/index.ts:104-120`; `kit/sources.json:13-19`).
- external profile metadata is not parity-checked; `pi-subagents` claims autonomous/self-improving membership but neither includes it (`kit/sources.json:39-46`; `kit/verify.mjs:267-298`).
- `task-graph` accepts missing/self/cyclic dependencies, so it is not a DAG invariant (`extensions/task-graph/index.ts:61-92`).
- **Raised by:** Reviewer A.
- **Confidence:** high for in-repo behavior; external runtime was not downloaded or invoked.

#### M-06 — Generator/policy validation has silent omission modes

Unknown skill categories are retained but never rendered because generation iterates a fixed taxonomy, and verify checks only non-emptiness (`kit/skills-catalogue.mjs:55-98`; `kit/verify.mjs:420-439`). Invalid firewall regex rules are silently discarded (`extensions/tool-firewall/index.ts:113-134`) instead of rejecting the custom policy or loudly falling back.

- **Raised by:** Reviewer B.
- **Confidence:** high.

#### M-07 — Release/docs completeness has further gaps

- `CHANGELOG.md` omits the real `0.2.0` bump and presents `1.0.0` as released (`CHANGELOG.md:12-25,121-131`).
- CI substitutes a link checker for the required real MkDocs build (`kit/docs-nav-check.mjs:1-9`; `.github/workflows/ci.yml:9-25`).
- generated `docs/EXTENSIONS.md` omits status and advertises quarantined stubs; `docs/install-surfaces.md:7-18` still claims lite includes MCP router.
- seven extensions lack the README required by `CONTRIBUTING.md:9-16`.
- **Raised by:** Reviewer C.
- **Confidence:** high.

#### M-08 — The original plan omitted stable-release evidence and lifecycle criteria

The plan did not require a provider-independent installed-package load smoke, post-tag artifact verification, rollback/deprecation/migration criteria, or a defined level of SBOM/provenance/signing/license evidence. `docs/supply-chain.md:7-38` equates exact versions plus a non-blocking audit with maturity, while vendored provenance such as `vendor/caveman/SOURCE.md` lacks a commit SHA.

- **Raised by:** Reviewer C.
- **Confidence:** medium-high.
- **Triage:** medium; not every listed supply-chain control must block an internal Git-distributed v1, but the chosen guarantees must be explicit.

### Low

#### L-01 — Strict TypeScript value is weakened at critical boundaries

Safety handlers use broad `any` and ad hoc event aliases (`extensions/tool-firewall/index.ts:221-280`; `extensions/secret-guard/index.ts:150-152`). Test harness/transpilation and frontmatter parsing are duplicated across scripts instead of using the new shared harness.

- **Raised by:** Reviewer B.
- **Confidence:** high.

#### L-02 — Current profile requirement wording is stale

`profiles/self-improving.json:3-4` still says Epic 6 machinery “lands across Epics 6+”; README/install wording makes Docker/second-model dependencies sound universal rather than specific to optional experimental components.

- **Raised by:** Reviewer C.
- **Confidence:** high.

### Nice-to-have

#### N-01 — Clarify documentation lifecycle and reduce maintenance concentration

Separate current guides, active roadmap, completed plans, research, and specifications in nav; distinguish `building-extensions.md` from `WRITING_EXTENSIONS.md`; consider splitting the 480-line, source-text-coupled `kit/verify.mjs` into focused checks backed by shared validated data.

- **Raised by:** Reviewers B and C.
- **Confidence:** high.

## Agentic Capability & Long-Horizon Engineering

This section is the focused second-pass triage. It builds on the established findings above rather than re-litigating them. `vendor/subagent` is a real primitive: it launches isolated `pi --mode json -p --no-session` subprocesses in single, bounded-parallel, and chain modes, passes configured per-role `--model` and `--tools`, and Pi consumes both (`vendor/subagent/index.ts:131-249,268-360`; `vendor/subagent/agents.ts:26-74`; `node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js:40-42,85-90`; `node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:83-135`). The findings below concern the missing controller, defaults, invariants, and reliability loops around that primitive.

### Blocking

No new standalone blocking ID is added. The focused trace confirms that existing **F-02** is also a direct agentic blocker: in headless `autonomous`/`long-horizon` composition, `subagent` is an unknown firewall tool and is blocked before `subagent.execute`; `pentest-governance-domain` supplies a second default direct-tool block (`extensions/tool-firewall/default-policy.json:3-15`; `extensions/tool-firewall/index.ts:200-205,279-307`; `extensions/pentest-governance-domain/index.ts:603-617`). Independent reproduction returned `approval required for subagent, but no interactive UI is available — fail closed`. This is folded into F-02 rather than duplicated under an `AG-` ID.

### High

#### AG-01 — No shipped path selects a stronger model from task difficulty

**Extends H-03.** The unsupported `model_select` return remains discarded, but the strong route also lacks a production input and the child roles do not supply an alternative:

- `provider-router` reads `task_type` only from `goal-core.json` (`extensions/provider-router/index.ts:34-61`), while `goal-core` never writes `task_type`, only prompt-contribution fields (`extensions/goal-core/index.ts:27-44`). The synthetic task type exists only in the smoke (`tests/epic2-smoke.mjs:133-150`).
- None of `planner`, `implementer`, `reviewer`, or `scout` has `model:` frontmatter (`extensions/orchestrator/agents/*.md:1-7`). Without `--model`, child Pi falls back to the operator's saved/default model (`vendor/subagent/index.ts:158-164`; Pi SDK `:83-112`).
- **Independent repro:** setting a real goal to `Implement cross-file auth review` produced a goal contribution with no task type; the router chose `gemma4:latest` (hot path). Pi would discard even that result per H-03.

**Impact:** out of the box, difficulty changes neither the parent model nor any child model. Operator-authored roles with `model:` work, so this is a missing adaptive policy/controller—not a claim that per-agent CLI model selection is fake.

**Triage:** high as raised by Reviewer D; very high confidence.

#### AG-02 — Complexity scoring is prompt steering, not executable orchestration

The scorer and directive injection are real (`extensions/orchestrator/index.ts:39-101,158-179`; `extensions/context-sieve/index.ts:66-103`), but `orchestrator` never invokes `subagent`, creates/leases work, parses structured child results, enforces planner → implementer → reviewer order, retries a failed review, or dispatches into worktrees. It registers no tool and only `/orchestrate` (`extensions/orchestrator/index.ts:125-205`). The documented `/orchestrate-plan` and `/orchestrate-implement-review` entry points do not exist (`docs/agent-orchestration.md:43-46`).

**Independent repro:** a complex fake-Pi input created the directive, but the extension registered `tools=0`, sent `steers=0`, and exposed only `commands=orchestrate`. The eval likewise asserts only directive-file presence (`kit/eval/fixtures.mjs:332-359`).

**Extends H-02/H-04:** four `branch-lab` public tools remain unreachable through the correct execute signature, and no controller connects worktree creation to `subagent.tasks[].cwd`. Shared-directory subprocess fan-out works for read-only or genuinely disjoint work; harness-managed create → dispatch → verify → merge/rollback does not (`extensions/branch-lab/index.ts:156-220`; `vendor/subagent/index.ts:252-266,337-344`).

**Impact:** the small parent model must correctly execute the entire orchestration protocol from prose—the burden the harness was meant to remove. This is high, not blocking, because manual/configured `subagent` use is real once F-02 is fixed.

**Triage:** high as raised by Reviewer D; very high confidence.

#### AG-03 — Goal/task/verdict state does not enforce a multi-step completion invariant

**Extends M-04 and M-05.** `task-graph` is not merely cycle-permissive: `task_next` does not claim a task, completion ignores dependencies, status accepts arbitrary strings, and every operation is an uncoordinated JSON read/modify/write (`extensions/task-graph/index.ts:30-44,61-63,69-160`). `goal-core` is manually set and unbound to the graph/verdict set (`extensions/goal-core/index.ts:47-89`). `verifier-board` accepts caller assertions under arbitrary source names, while the orchestrator checks only already-present `pass:false` values and ignores remaining tasks, required verdict sources, and goal existence (`extensions/verifier-board/index.ts:50-76`; `extensions/orchestrator/index.ts:108-122`).

**Independent repro:** two consecutive `task_next` calls both returned `t1`; `task_complete(t2)` succeeded while `t2` still depended on unfinished `t1`; and `task_update(t1, "teleported")` persisted the invalid state. Parallel subprocesses additionally risk lost updates because there is no cross-process lease/lock/atomic transaction.

**Impact:** state files are useful notes, but they cannot prevent duplicate work, out-of-order completion, lost updates, or an all-PASS/absent board coexisting with unfinished tasks.

**Triage:** high as raised by Reviewer D. This upgrades the focused end-to-end invariant gap while retaining the individual file/I/O defects at M-04/M-05.

#### AG-04 — Verification can pass without a check or race completion

**Materially sharpens M-04.** `verifier-board` treats an empty board as FAIL (`extensions/verifier-board/index.ts:38-43`), but `missionCompleteBlocked` treats a missing file, malformed schema/JSON, or any read failure as unblocked (`extensions/orchestrator/index.ts:108-122`). `/verify` runs `npm run verify --if-present`, so a project without that exact script executes no check and returns success (`extensions/verify-gate/index.ts:9-15,53-61`). Automatic verification is opt-in, spawns asynchronously, and deliberately does not await the child (`:65-93`); Pi awaits `turn_end` handlers and then emits `agent_end`, allowing the gate to read an absent/stale board before the close callback writes the current verdict (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:351-376`). Verdict writes are non-atomic and errors are swallowed (`extensions/verify-gate/index.ts:22-37`).

**Independent repro:** in the existing `infra/memory-mcp` package, which has no `verify` script, `npm run verify --if-present` exited `0`. Direct calls to `missionCompleteBlocked` returned `{blocked:false}` for missing, malformed, and stale-PASS boards.

**Impact:** a many-hour run can visibly report PASS or completion without running the repository's tests/build, or while its current check is still failing. Verification is the critical backstop for a weaker model; fail-open completion is high severity.

**Triage:** high as raised by Reviewer E; very high confidence.

#### AG-05 — Goal-aware compaction instructions are discarded by Pi

**Extends M-05 and mirrors H-03's producer/consumer disconnect.** Ordinary `before_agent_start` contribution injection is consumed and works. The compaction path does not: `context-sieve` mutates `event.customInstructions` and returns `undefined` (`extensions/context-sieve/index.ts:106-128`), but the public result contract accepts only `cancel` or a complete `compaction` (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:424-430,772-775`). The runner retains only returned session-before results (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:516-551`). Manual compaction later passes the original local `customInstructions`; automatic compaction passes literal `undefined` (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1288-1319,1521-1559`).

**Independent hand trace:** automatic compaction emits a temporary event with `customInstructions: undefined`; `context-sieve` mutates it; no result is retained; Pi calls `compact(..., undefined, ...)`. The promised goal/current-step/pending-verdict/handoff preservation template never reaches the summarizer.

**Impact:** persistent goal contributions can reappear after compaction, but the hard-earned working history and verifier/recovery state remain subject to default summarization—the exact continuity a small model needs most.

**Triage:** high as raised by Reviewer E; not blocking because Pi still performs default compaction.

#### AG-06 — Ordinary read stalls and failed-edit cycles bypass deep recovery

**Sharpens M-03 and H-06.** Exact repeated arguments and strict A→B→A oscillation can nudge/escalate, but the read-stall signature embeds the changing count (`stall:6`, `stall:7`, …), so no one signature reaches the default two-action escalation threshold (`extensions/progress-guard/index.ts:159-181,230-257`). Any write-like `tool_call` resets progress state before its result is known, and the extension has no `tool_result` handler (`:207-227`). Varied reads/commands/edits evade exact hashes and strict two-signature alternation.

**Independent repro:** 12 distinct reads produced a nudge but no escalation. Four cycles of five distinct reads plus a distinct attempted edit produced neither nudge nor escalation, because each attempted edit reset state without any successful result. An exact repeat fares only slightly better: recovery then writes the already-established H-06 instruction/report scaffold rather than executing scouts, fork, repair, checkpoint, or validation (`extensions/recovery-orchestrator/index.ts:169-197`).

**Impact:** the common small-model failure mode—over-read, attempt a failing variation, repeat—can run until context exhaustion or the autonomous loop's 20 follow-ups. The advertised automatic bridge either never fires or hands prose back to the same stuck model.

**Triage:** high as raised by Reviewer E; very high confidence.

### Medium

#### AG-07 — Context budgeting governs snippets, not the long-horizon context

`context-sieve` genuinely sorts contribution snippets by priority and enforces an approximate global character cap (`extensions/context-sieve/index.ts:66-103`). It does not budget base prompt, conversation history, tool/subagent output, or file reads; declared per-contribution `budgetTokens` is unused; whole contributions are dropped rather than truncated; invalid budget input can become `NaN`; and compaction contributions are unsorted/unbudgeted (`:5-10,71-90,106-127`). This is medium because the narrow contribution mechanism is real, while the broader context-governor claim is not.

#### AG-08 — Persistent notes exist, but capability does not compound across sessions

**Extends M-02.** `memory-local` is a real manually invoked store/search tool, but it has no automatic task-scoped recall/injection hook (`extensions/memory-local/index.ts:20-28,170-240`) and F-02 blocks it headlessly by default. The improvement chain stops at heuristic artifacts: traces lack goal/outcome/verifier data; synthesis is manually invoked; `skill_score` is candidate-insensitive; no promotion/revert path exists; `/improve` and dream mode bypass synthesis/scoring and append static repeated-read notes (`extensions/skill-forge/index.ts:54-83,85-125,136-203`; `extensions/self-improvement/index.ts:48-140`; `kit/dream.mjs:58-108`). There is no current mechanism that demonstrates improved hard-task success across sessions.

#### AG-09 — Subagent JSON streaming is not observable by the parent

Child JSONL is parsed incrementally and execution modes/failure propagation are real, but `_onUpdate` is unused, accumulated model/usage/cost/turn metadata is discarded, parallel outputs are capped only after full accumulation, and there is no child timeout beyond parent abort (`vendor/subagent/index.ts:96-121,182-249,279-358`). A long local worker is a silent tool call until completion. Medium: final delegated output still works, but supervision and targeted recovery do not.

### Low

#### AG-10 — Trace retention is bounded only at the next session start

`trace-ledger` trims to 500 lines only at `session_start`; a multi-hour session appends without an in-session bound, and the next session then discards early evidence (`extensions/trace-ledger/index.ts:13-16,60-80,111-151`). Disk impact is small, but the retention point is poorly aligned with later recovery/learning.

### Nice-to-have

#### AG-11 — Record outcome-bearing transitions, not only tool activity

Add stable goal/work-unit IDs and explicit transitions for attempted mutation, actual file delta, verifier delta/generation, checkpoint, recovery entry/exit, model/skill selection, stop reason, and final outcome. This would let routing, recovery, memory, and candidate scoring share evidence rather than infer progress from tool names and counts.

## Reviewer-angle synthesis

### Functional and security

The source-level default-allow regression is genuinely fixed: unknown tools ask/deny, shipped rules exist, local manifest/profile metadata is consistent, and the offline suites are real. The production claim nevertheless fails because profiles are not applied at runtime, policies conflict with first-party tools, common destructive/secret-exfiltration variants bypass the guards, and several shipped tools are behaviorally broken despite passing tests.

### Architecture and code quality

The code generally follows the ExtensionAPI registration style, self-containment rule, deterministic generation pattern, and context-sieve contribution convention. Weaknesses cluster at safety-critical boundaries: unvalidated paths, silent catches/fail-open state, duplicate file contracts, fake public API shapes in tests, and DoDs narrowed into prompt/scaffold checks. The stale lockfile independently blocks reproducibility.

### Organization, documentation, and release

The high-level `extensions/`, `vendor/`, `skills/`, `profiles/`, `surfaces/`, `kit/`, and `docs/` organization is understandable, and generated catalogues are a real improvement. Release readiness is not established: onboarding paths are contradictory or invalid, docs overstate 1.0 completion, the lockfile/release script are unsafe, profile CI is mislabeled, and an actual MkDocs build is absent.

## Disagreements and severity resolutions

- **Runtime stub quarantine:** Reviewer C marked it resolved from profile JSON; Reviewer A found the installer wildcard. Direct package/installer evidence resolves this in A's favor (F-01).
- **Profile regression:** A/B rated high, C blocking. It is blocking because it is the explicit capstone DoD and it concealed confirmed runtime failures (F-06).
- **Recovery orchestration:** A rated medium, B high. It remains high because it is beta in non-experimental profiles and the authoritative flow DoD was not delivered (H-06).
- **Test-quality umbrella:** A rated high. It is medium after deduplication because each escaped production fault already carries its own higher severity (M-01).
- **Epic 6 scoring:** B rated high. It is medium because exposure is experimental and manifests describe narrower behavior, though roadmap closure remains false (M-02).
- **Part A corrections:** local metadata/status/catalogue work is real, but #2 runtime quarantine is undone by F-01; #4 is only partial because portable docs use a nonexistent tag; #8 is only partial because the lock contradicts the pin. The roadmap's “all eight resolved” statement is not supportable.
- **Autonomous delegation block:** Reviewer D raised a new blocker. The consequence is confirmed, but it is folded into existing F-02 because the same default policy root cause blocks `subagent` before execution; duplicating it would double-count severity.
- **Ignored hook returns:** Reviewer D found H-03 is isolated as a Pi hook-contract misuse. `before_agent_start`, `tool_call`, and session-before returns are consumed. The broader systemic issue is producer-only/advisory wiring without an end-to-end execution assertion (AG-01/AG-02), not universal return-value loss.
- **Agentic primitives versus controller:** `vendor/subagent` and role tool allowlists are real; claims that delegation itself is wholly fake were rejected. AG-01/AG-02 remain high because shipped roles do not select models and the complexity layer does not execute or verify the workflow.
- **Recovery severity:** H-06 remains high, now sharpened by AG-06: ordinary read stalls cannot reach escalation and failed write attempts reset progress before results. This is a separate detection/control-path defect, not merely stronger wording for the scaffold finding.
- **Verification severity:** M-04 remains medium as the duplicated file/I/O design defect, while AG-04 is high for its demonstrated end-to-end consequence: no-op PASS, stale/absent state, and an async completion race.
- **Compaction:** AG-05 is retained high. Pi's default compaction prevents a total outage, but direct runtime tracing proves the dedicated continuity instructions never reach it.
- No blocking/high assertion was dropped as unverified. All were reproduced or confirmed directly; overlapping assertions were merged.

## Capability Engineering Roadmap

The two focused reviewers' investment lists converge on four moves, ranked by expected improvement to hard-task performance rather than implementation convenience:

1. **Build a durable executable orchestration/recovery controller.** Persist typed task and failure states; classify the request; invoke planner/scouts/workers through real APIs; validate the DAG; atomically lease work; dispatch isolated worktrees; collect structured results; checkpoint; retry bounded failures; choose backup/rollback; and survive restarts. Include first-party policy compatibility so the autonomous profile can call the controller's tools.
2. **Route models at a supported pre-inference decision point.** Produce task/role classification from the actual request, resolve availability, and ship explicit model/tool/thinking budgets (for example strong planner/reviewer, cheap scout/implementer where appropriate) with operator overrides, fallback, and child-result confirmation. Retire the post-selection notification return.
3. **Make verification a fail-closed completion protocol.** Declare required checks per task/repository, reject empty/missing/malformed boards and absent scripts, bind verdicts to the current file/task generation, write atomically, await the current check before completion, and prevent completion until required evidence passes.
4. **Make context and learning outcome-aware.** Preserve goal/plan/verdict/recovery state through a supported compaction contract; record task IDs, model/skill choice, file/verifier deltas, recovery transitions, and final outcomes; recall memory automatically but task-scope it; score candidate skills enabled versus disabled on representative held-out tasks; promote only measured gains and revert regressions.

## Prioritized implementation pass

1. Make `--profile`/`--only` produce or configure an actual profile-scoped Pi resource set; prove stubs/experimental extensions do not load.
2. Define a composable first-party tool policy and reconcile MCP-only governance with quick/balanced/autonomous intent, including headless behavior.
3. Redesign the shell/secret boundary for supported platforms and add adversarial fixtures for native commands, wrappers, globbing, concatenation, variables, PowerShell, and encoded staging.
4. Regenerate/commit the lockfile, switch canonical CI to `npm ci`, and make release maintain/stage/verify the lock.
5. Implement the actual Windows/Linux per-profile and lite install/load/verify/eval capstone matrix.
6. Fix canonical path containment for dream writes and `skill_archive`; cover every mutating tool and prevent source/destination aliasing.
7. Make verification fail closed: require real repository checks, reject empty/malformed/stale boards, atomically persist verdict generations, await checks before completion, and test absent-script/I/O/race cases.
8. Build the executable orchestration/recovery controller and move model routing to a supported pre-inference API with explicit shipped role policy.
9. Replace task/worktree/checkpoint hints with validated DAG transitions, atomic leases, correct `branch-lab` signatures, child-cwd dispatch, merge/rollback, and durable `git-checkpoint` state.
10. Fix the anti-loop signal model and compaction continuity: use tool results, file/verifier deltas and stable failure signatures; persist recovery attempts; prove the compactor receives goal/plan/verdict/handoff state.
11. Add outcome-rich tracing, automatic task-scoped memory recall, and candidate-sensitive enabled/disabled skill evaluation; otherwise keep self-improvement explicitly experimental.
12. Harden remaining policy/generator errors, replace producer-only tests with installed-runtime/fake-child end-to-end contracts, correct install/tag/roadmap/changelog/security/catalogue wording, add a strict MkDocs build, and document release/supply-chain guarantees.

## Constraint and mutation confirmation

- No remote push occurred.
- No tag was created, moved, or deleted.
- No live Pi agent, live model/backend, or model-provider call occurred.
- No external network request was made by this review.
- No production file was intentionally modified. The only new repository deliverables are the four files under `reviews/`.
- The pre-existing untracked `HANDOFF_PROMPT_FOR_V1_HARDENING.md` was preserved untouched.

### Focused pass addendum (agentic capability and long-horizon engineering)

- No remote push occurred, and no remote operation was attempted.
- Tag state remained unchanged (`v0.9.0` only); no tag was created, moved, or deleted.
- No live Pi agent, model/backend, or model-provider call occurred. No real `pi` CLI was invoked.
- No external network request occurred. Verification used installed source, cached offline harness modules, fake handlers, and temporary OS state; the no-op npm reproduction ran only a local missing script. The final `npm run eval` deterministically refreshed ignored generated files under `node_modules/.cache/pi-kit-eval`; no source/production file changed.
- The only repository deliverables intentionally created or changed in this focused pass are `reviews/agentic-delegation-orchestration-review.md`, `reviews/long-horizon-reliability-review.md`, and this updated `reviews/FINAL-review.md`. No production file was changed.
- Pre-existing untracked `HANDOFF_PROMPT_FOR_V1_HARDENING.md` and `Pi RAIA.txt` were preserved untouched.
