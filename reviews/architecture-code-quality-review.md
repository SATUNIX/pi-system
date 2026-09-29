# Reviewer B — Architecture and Code Quality Review

Date: 2026-08-04
Branch reviewed: `hardening/production-readiness-plan` at `8d3b205`
Scope: the nine production-readiness epics (`c1b5df5..8d3b205`), with emphasis on extensions, vendor code, kit scripts, and tests. This was an independent adversarial review; I did not read either specialist review.

## Overall assessment

The implementation contains substantial real work: strict TypeScript passes, the security tests exercise real event handlers, the catalogue/matrix generators are deterministic on the current tree, and the new eval harness drives extension code without a live model or network. However, the codebase is not ready for a `v1.0.0` tag from the architecture/code-quality lens.

One release blocker prevents a reproducible clean install. Three high-severity safety/correctness problems exist in the newly added memory/dream machinery. In addition, several Epic 5/6/9 definitions of done were narrowed into prompt/scaffold or metadata checks while the tests assert the narrowed substitute rather than the claimed end-to-end behavior. A green `npm run verify` and `npm run eval` therefore overstate what was proven.

## Commands run and actual results

All commands were offline; no Pi CLI, model backend, provider, or remote was invoked.

- `npm run verify` — PASS. TypeScript and all repository checks passed.
- `npm run test:security` — PASS (`tool-firewall` and `secret-guard`).
- `npm run eval` — PASS, 13/13 fixtures. Node also emitted `[DEP0190]`: use of child-process arguments with `shell: true` can be insecure.
- `node tests/epic1-smoke.mjs` — PASS; its temporary Git repository emitted `LF will be replaced by CRLF` for its own `README.md`.
- `node tests/epic2-smoke.mjs` — PASS.
- `node tests/docs-smoke.mjs` — PASS: 13 commands structurally validated, one export run, 10 external lines skipped.
- `npm ci --dry-run --ignore-scripts --offline` — FAIL (`EUSAGE`): lockfile Pi `0.79.6` does not satisfy root devDependency `0.76.0`.
- `npm ls @earendil-works/pi-coding-agent --depth=0` — FAIL (`ELSPROBLEMS`): installed `0.79.6` is invalid against the root's `0.76.0` pin.

## Findings

### Blocking

#### B-01 — `package-lock.json` is stale, and the release script guarantees it stays stale

Evidence:

- Root package version and Pi dev pin are `0.9.0` and `0.76.0`: `package.json:3`, `package.json:31-34`.
- The lockfile still declares the root as `0.1.0`, omits the Pi devDependency, and resolves Pi `0.79.6`: `package-lock.json:3`, `package-lock.json:7-18`, `package-lock.json:20-23`.
- `kit/release.mjs` changes only `package.json` and stages only that file: `kit/release.mjs:55-63`, `kit/release.mjs:77-80`.
- Both CI implementations use `npm install`, which silently repairs/mutates a stale lockfile instead of enforcing it: `.github/workflows/ci.yml:17`, `.github/workflows/ci.yml:34`, `.github/workflows/ci.yml:50`; `.gitea/workflows/ci.yml:15`, `.gitea/workflows/ci.yml:30`, `.gitea/workflows/ci.yml:44`.

Concrete repro:

```text
> npm ci --dry-run --ignore-scripts --offline
npm error `npm ci` can only install packages when package.json and package-lock.json are in sync.
npm error Invalid: lock file's @earendil-works/pi-coding-agent@0.79.6 does not satisfy ...@0.76.0
```

Impact: a normal reproducible clean install fails, the successful local typecheck used the wrong Pi version (`0.79.6`), and cutting `v1.0.0` with the current release script would preserve the broken lock state. This blocks a production tag.

### High

#### B-02 — `skill_archive` accepts traversal and can delete an arbitrary workspace path before throwing

`skill_archive` uses the raw model-provided `skill_name` in source and destination paths, recursively removes the destination, then renames: `extensions/skill-forge/index.ts:206-225`. Unlike `skill_synthesise`, it performs no sanitization or containment check (`extensions/skill-forge/index.ts:160-163` sanitizes only the other tool).

Concrete offline repro against a temporary workspace:

```text
skill_name = "../../victim"
victim_exists=false error=ENOENT
```

With that name, the computed source and destination collapse to the same victim path. `fs.rmSync(..., { recursive: true, force: true })` deletes it, after which `renameSync` throws. The tool is only exposed by the experimental `self-improving` profile, which reduces default exposure, but its manifest marks it `beta` and the operation is model-visible and destructive. The firewall's generic interactive approval is not a substitute for parameter containment.

#### B-03 — Dream-mode runtime allowlist enforcement is bypassable by path substrings and by every shell write

The stable `protected-paths` extension claims to be dream/print-mode's enforcement point (`vendor/protected-paths/extension.json:4`, `vendor/protected-paths/index.ts:13-16`), but:

- allowlisting uses substring matching (`normalized.includes(needle)`), not resolved path containment: `vendor/protected-paths/index.ts:29-35`;
- the hook handles only tools named exactly `write` and `edit`: `vendor/protected-paths/index.ts:38-43`; shell commands and other mutators bypass it entirely.

Concrete offline fake-API repro with `PI_KIT_WRITE_ALLOWLIST=AGENTS.md;.pi/memory;GOAL.yaml`:

```text
src/AGENTS.md.bak              => ALLOW
tmp/.pi/memory-evil/out.txt    => ALLOW
src/app.ts                     => BLOCK
bash: echo changed > src/app.ts => ALLOW
```

This violates Sprint 6.3's requirement that an unattended run modify only allowlisted paths. `kit/dream.mjs` has a stricter internal `guardedWrite`, but the roadmap explicitly relies on `protected-paths` for a future real `pi -p` run (`kit/dream.mjs:5-17`, `kit/dream.mjs:69-81`). The eval tests only one exact allowed path and one ordinary blocked path, so both bypass classes pass unnoticed: `kit/eval/fixtures.mjs:314-323`.

#### B-04 — The “full profile regression” does not install, load, initialize, or evaluate any profile

For profile targets, `kit/profile-check.mjs` only parses include lists, resolves manifest/external names, checks status, and checks one ordering invariant: `kit/profile-check.mjs:34-74`, `kit/profile-check.mjs:76-85`. Export/package verification is performed only for a surface: `kit/profile-check.mjs:86-100`. No profile extension module is imported, registered with a fake API, initialized, or exercised; `npm run eval` is not run per profile.

CI labels this a full Windows/Linux profile regression but calls only that metadata checker: `.github/workflows/ci.yml:37-51`; `.gitea/workflows/ci.yml:32-45`. This is materially narrower than Sprint 9.1's DoD (“install + verify + eval every profile + lite surface”). It can stay green while a profile-only runtime path fails on import, session startup, hook interaction, or platform behavior.

Concrete evidence: `node kit/profile-check.mjs --profile quick` reaches no `import()`, TypeScript transpilation, `registerCommand`, `pi.on`, installer, or eval call anywhere in its profile branch.

#### B-05 — Epic 6's “score” and self-improvement cycle do not evaluate a skill or perform mine → synthesise → score → propose

`skill_score` accepts a `skill_name`, but `evalPassRate` ignores that skill and runs the unchanged kit-wide eval suite: `extensions/skill-forge/index.ts:136-147`, `extensions/skill-forge/index.ts:181-203`. Any two names receive the same score; a broken or absent candidate skill does not affect it. The corresponding fixture does not invoke `skill_score` at all—it only checks that the security eval category returns JSON: `kit/eval/fixtures.mjs:249-259`. That test would still pass if the tool returned a constant or were behaviorally broken.

Similarly, `/improve` directly derives repeated-read/error notes and writes an AGENTS.md proposal: `extensions/self-improvement/index.ts:48-83`, `extensions/self-improvement/index.ts:110-140`. It never calls skill-forge, synthesizes a candidate skill, or scores anything, despite the implementation comment and authoritative Sprint 6.2 sequence (`extensions/self-improvement/index.ts:5-10`).

This is a quiet scope reduction of the “memory/self-improvement” rung, not merely an implementation-style preference. The experimental profile limits immediate blast radius, but Epic 6 cannot be described as fully delivered against its DoD.

#### B-06 — Recovery orchestration produces instructions and a blank report, not the claimed recovery flow

The new extension's runtime work is limited to reading an escalation marker, creating a report scaffold, writing a context contribution containing instructions, and consuming the marker: `extensions/recovery-orchestrator/index.ts:70-121`, `extensions/recovery-orchestrator/index.ts:159-198`. It never calls the subagent tool, forks, collects scout results, ranks causes, selects a plan, delegates a repair, records a trace outcome, or validates the repair. The apparently relevant verifier-board branch is a no-op: `extensions/recovery-orchestrator/index.ts:58-67`, `extensions/recovery-orchestrator/index.ts:130-134`.

The fixture asserts only that a contribution/report exists and that the prompt contains the words `fresh scouts`, `top 10`, and `primary`: `kit/eval/fixtures.mjs:184-216`. Thus it verifies prompt text, not Sprint 5.3's flow or its DoD (“scripted stuck-task fixture drives the flow”). This extension is `beta` in non-experimental `long-horizon` and `autonomous` profiles (`extensions/recovery-orchestrator/extension.json:3-12`), so the narrowed behavior affects advertised production profiles.

### Medium

#### B-07 — Sprint 5.2 explicitly substituted first-principles guesses for required trace calibration

The plan requires tuning against real `.pi/trace.jsonl` sessions. The shipped documentation says the values are first-principles defaults and that no live-session trace corpus was used: `docs/efficiency-and-loops.md:63-79`. `progress-guard` retains repeat `3`, stall `6`, oscillation `3`, and escalation `2` as environment-backed constants: `extensions/progress-guard/index.ts:25-37`.

The offline constraint prohibited live model runs; it did not convert scripted threshold examples into empirical calibration. The implementation is transparent about the deferral, but the roadmap's claim that Epic 5 is complete overstates this sprint.

#### B-08 — Verdict bookkeeping duplicates a shared contract and fails open/silently on corruption or I/O errors

`verify-gate` reimplements the verifier-board file contract and swallows every read/write error: `extensions/verify-gate/index.ts:18-37`. `orchestrator` independently parses the same file and treats malformed/unreadable state as “not blocked”: `extensions/orchestrator/index.ts:108-122`. Writes are non-atomic read-modify-write operations, so concurrent board writers can lose entries. The result is a fragile definition-of-done boundary: verification can succeed while its verdict was not recorded, and a corrupt board permits mission completion without a visible failure.

Self-containment explains why code cannot import across extension directories, but it does not justify silent failure. A small versioned file-contract helper copied/generated into consumers, atomic replacement, and explicit degraded status would make the behavior consistent.

#### B-09 — The skills catalogue silently drops any typoed/unknown category despite claiming it cannot

The generator comment promises that an unknown/missing category is surfaced under “Uncategorised”: `kit/skills-catalogue.mjs:20-33`. Missing categories are normalized, but unknown category strings are kept unchanged: `kit/skills-catalogue.mjs:55-65`. Rendering iterates only the fixed `CATEGORY_ORDER`, so an unknown category is never emitted: `kit/skills-catalogue.mjs:70-98`. The verify lint checks only that `category:` is nonempty, not that its value is allowed: `kit/verify.mjs:420-439`.

Repro: assign a skill `category: efficency`, regenerate, and both the generated doc and drift check accept a catalogue that omits that skill. This diverges from the existing registry's simpler “include every manifest” pattern (`kit/registry.mjs:20-29`, `kit/registry.mjs:51-59`).

#### B-10 — Several green tests assert scaffolding or “did not crash,” leaving the stated DoD unprotected

Beyond B-04 through B-06:

- The dream fixture checks one source file and two direct `write` events, not path-confusion variants or shell mutators: `kit/eval/fixtures.mjs:294-329`.
- The recovery fixture checks prompt keywords/report count, not orchestration: `kit/eval/fixtures.mjs:184-216`.
- The score fixture never invokes the tool: `kit/eval/fixtures.mjs:249-259`.
- `tests/docs-smoke.mjs` structurally validates command names but skips ten environment/external lines and executes only one export: `tests/docs-smoke.mjs:35-78`, `tests/docs-smoke.mjs:81-85`. It does not establish Sprint 7.1's “all pass on a clean clone.”
- `tests/epic1-smoke.mjs` tests selected extensions but not back-to-back export with a stale read-only artifact or the install failure path: `tests/epic1-smoke.mjs:262-268`.

The issue is not that unit tests use fakes; the fake API is appropriate offline. The problem is that the fixtures encode the reduced implementation as success, so regressions in the claimed end-to-end capability remain invisible.

#### B-11 — Invalid firewall regex rules are silently discarded instead of failing the policy closed

`compileCommandRules` catches an invalid regular expression and simply continues: `extensions/tool-firewall/index.ts:113-134`. A syntactically valid JSON policy with a typo in a destructive-command rule therefore loads successfully with that protection missing, with no audit/notification. Because a policy may explicitly allow `bash`, this can become fail-open for the affected command. Policy validation should reject the policy or surface a loud load error and use the built-in fail-closed fallback.

#### B-12 — Release dry-run logs the gates but skips all of them

The documented `--dry-run` mode calls `run(...)`, but `run` executes nothing when `dryRun` is true unless an unused `always` option is supplied: `kit/release.mjs:19-30`. Consequently verify, security, eval, docs smoke, exports, commit, and tag are all merely printed: `kit/release.mjs:65-80`. A release dry-run is therefore not a safe preflight; it gives no evidence that the release gates or exports work. This is especially misleading in combination with B-01.

### Low

#### B-13 — Critical event boundaries discard much of strict TypeScript's value

Although `tsconfig.json` enables `strict`, safety-critical handlers use `any` for event, context, and shell input (`extensions/tool-firewall/index.ts:221-223`, `extensions/tool-firewall/index.ts:251-253`, `extensions/tool-firewall/index.ts:263-280`; `extensions/secret-guard/index.ts:150-152`). The code then supports ad hoc aliases (`toolName`/`name`, `command`/`cmd`/`script`) without a shared typed normalization layer. This is consistent with some older kit code, so it is not a release blocker, but it makes API drift and unhandled tool shapes harder for the compiler to expose.

#### B-14 — New test infrastructure and parsers duplicate rather than consolidate

TypeScript transpilation, fake Pi APIs, environment restoration, and temp-workspace logic are duplicated across `tests/epic1-smoke.mjs`, `tests/epic2-smoke.mjs`, `tests/tool-firewall-smoke.mjs`, and `tests/secret-guard-smoke.mjs`, while `kit/eval/harness.mjs:12-85` now supplies essentially the same machinery. Frontmatter parsing is separately approximated in `kit/skills-catalogue.mjs:35-45` and by regex in `kit/verify.mjs:424-438`.

This increases maintenance drift and already contributes to uneven coverage. A shared offline extension-test harness and one frontmatter parser/schema would be closer to the kit's established generator pattern.

### Nice-to-have

#### B-15 — `verify.mjs` has become an oversized, source-text-coupled gate

`kit/verify.mjs` is now 480 lines and uses regex/string extraction of TypeScript arrays to enforce security parity (`kit/verify.mjs:359-415`). The parity goal is valuable, but source-text parsing is brittle under harmless refactors and duplicates policy data in three forms. Moving checks into focused modules and representing shared security patterns as validated data copied into self-contained packages would improve clarity without weakening the self-containment rule.

## Pattern reuse and house-style assessment

The skills catalogue does follow the broad `kit/registry.mjs` pattern—filesystem collection followed by deterministic Markdown generation—and adds a useful `--check` mode. It diverges by hardcoding a closed category taxonomy without validating it (B-09). Capability-matrix generation is similarly straightforward and deterministic on the current repository.

The extension implementations generally respect the house convention of a default registration function, public `ExtensionAPI`, context-sieve contribution files instead of direct system-prompt injection, and Node-built-in self-containment. The weakest architectural choice is repeated file-contract logic with broad silent catches. “Best effort” is appropriate for cosmetic status contributions, but not for verdict integrity, path authorization, destructive archive tools, or policy compilation.

## Positive observations

- `tool-firewall` now has a real shipped policy, a deny-unknown fallback, content-aware shell rules, auditable action hashes, and meaningful headless/interactive tests (`extensions/tool-firewall/index.ts:33-47`, `extensions/tool-firewall/index.ts:263-330`; `tests/tool-firewall-smoke.mjs:78-126`).
- `secret-guard` tests both positive and negative behavior rather than merely checking registration (`tests/secret-guard-smoke.mjs:62-95`).
- Extension/profile metadata drift and stub quarantine are materially improved and enforced (`kit/verify.mjs:216-325`).
- Generated catalogue and capability documents are deterministic and drift-checked on HEAD.
- The eval harness is genuinely offline and drives real transpiled extension handlers. Its primary weakness is scenario scope, not hidden model/network dependency.

## Prioritized implementation recommendations

1. Regenerate and commit `package-lock.json`; make release update/stage it; switch CI's canonical install to `npm ci`.
2. Add strict kebab-case validation plus resolved-root containment to every skill-forge path; never recursively remove a destination until source/destination are proven distinct and contained.
3. Rebuild write allowlisting around resolved path boundaries and cover every mutating tool, especially shell execution; add bypass fixtures.
4. Replace the profile metadata matrix with offline load/register/session smoke plus profile-scoped eval on both OSes; retain live-model exclusion.
5. Either implement actual candidate-sensitive scoring and the full self-improvement sequence or explicitly defer/relabel Epic 6 and its extensions.
6. Add an executable recovery state machine or relabel the current extension as recovery guidance/scaffolding; test scout/fork/synthesis/delegation/outcome transitions.
7. Make verdict writes atomic and errors visible; treat malformed verdict state as blocked/degraded rather than pass.
8. Consolidate the fake Pi/transpilation test harness and add negative/adversarial cases that map directly to each DoD.

## Constraint confirmation

No remote push, tag creation/move, live Pi CLI invocation, live agent/model run, or model-provider/network call occurred. The only repository file intentionally created by this reviewer is this report. The pre-existing untracked `HANDOFF_PROMPT_FOR_V1_HARDENING.md` was preserved.
