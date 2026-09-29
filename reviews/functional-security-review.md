# Independent functional, behavioral, and security review

Reviewer A — 2026-08-04

## Verdict

**Not ready for a `v1.0.0` tag.** Four blocking failures remain:

1. full-package profile selection is not enforced at runtime;
2. the shipped default policies deny the kit's own first-party tools in the profiles that promise them;
3. destructive commands pass through the explicitly allowed `bash` tool with modest obfuscation or Windows/native equivalents; and
4. secret copying/encoding passes `secret-guard` through elementary glob or split-path forms.

This conclusion is not based on failing project commands: every required project suite passed. It is based on direct code tracing and offline adversarial calls through the real extension handlers. The safety repros supplied command *strings* to fake Pi event handlers; none of the destructive or exfiltration commands was executed.

## Scope and method

- Confirmed branch `hardening/production-readiness-plan` and reviewed `git log --oneline -40`.
- Read `docs/roadmap.md`, `docs/improvement-roadmap.md`, and `LATEST_PLAN_2026-08-04T042958Z.md` in full and used each sprint's DoD as the acceptance bar.
- `node_modules/` already existed, so no install and no network access were needed.
- Audited the union of all entries declared by the four non-experimental profiles (`quick`, `balanced`, `long-horizon`, `autonomous`): 34 names, comprising 30 in-repo/vendored implementations and four reference-mode external packages.
- Compared manifest hooks/tools/commands to registrations, traced user-facing command handlers, and exercised material claims with the repo's fake-API/transpilation harness.
- Did not read either other reviewer's report.

## Actual command results

All required commands were re-run from this checkout, not accepted from prior logs.

```text
npm run verify
Exit 0 — 38 manifests consistent; no non-experimental stub/TODO violations;
policy unknown=ask with 12 deny + 6 ask rules; security parity, catalogues,
capability matrix, docs links, and tsc all passed.

npm run test:security
Exit 0
[test:security tool-firewall] OK
[test:security secret-guard] OK

npm run eval
Exit 0 — 13/13 fixtures passed.
Node also emitted DEP0190: passing args with shell:true can be unsafe.

node tests/docs-smoke.mjs
Exit 0 — [docs-smoke] OK: 13 documented commands validated, export:lite ran;
10 external lines skipped.

node tests/epic1-smoke.mjs
Exit 0 — [smoke:epic1] OK

node tests/epic2-smoke.mjs
Exit 0 — [smoke:epic2] OK

node tests/secret-guard-smoke.mjs
Exit 0 — [test:security secret-guard] OK

node tests/tool-firewall-smoke.mjs
Exit 0 — [test:security tool-firewall] OK
```

The offline capstone matrix also reported success for all targets: quick 17, balanced 27, long-horizon 33, autonomous 33, self-improving 39, and lite export/package verification. Finding A-9 explains why those green results do not establish runtime profile correctness.

The eval harness is genuinely offline: it transpiles local TypeScript and drives a fake API (`kit/eval/harness.mjs:1-40`). It does not invoke Pi or a model. The only server in any required smoke is an ephemeral loopback-only embedding fake in `tests/epic2-smoke.mjs:92-129`. Fixture outcomes are deterministic; timestamps/random suffixes only isolate temporary artifacts and are not used as expected values. No external network call occurred.

## Findings

### Blocking

#### A-1 — Full-package profiles are metadata only; the installer loads the wildcard package

**Severity: blocking. Confidence: high.**

`package.json` declares every `extensions/*/index.ts` and `vendor/*/index.ts` as Pi resources (`package.json:11-15`). The installer calculates `selected` from a profile (`kit/install.mjs:122-133`) but then installs the repository root as one package (`kit/install.mjs:226-229`). The selected set is subsequently used only to select external companions (`kit/install.mjs:231-245`) and write an informational marker (`kit/install.mjs:263-275`). Although `settingsPath` is calculated (`kit/install.mjs:67-69`), it is never written and no Pi extension filter is configured.

Consequently, selecting `quick` still causes Pi's package resource loader to discover every local and vendored extension, including quarantined `mcp-router`/`remote-review` and experimental self-improvement extensions. It also loads `pentest-governance-domain`, defeating `quick`'s documented distinction. The manifest/profile cross-check proves JSON parity, not runtime selection.

**Repro/evidence:**

1. Run `rg -n "selected|settingsPath|piBin.*install" kit/install.mjs`.
2. Observe no write/config call between selection and `pi install "<repo-root>"`.
3. Inspect `package.json:11-15`; its wildcard does not reference `profiles/*.json`.

This directly fails Epic 1's trust baseline and makes every generated capability/profile table misleading for the full package.

#### A-2 — Default policy composition blocks the kit's own tools, especially headless autonomy

**Severity: blocking. Confidence: high.**

The starter firewall explicitly knows only `read`, `grep`, `glob`, `ls`, `find`, `todo`, `write`, `edit`, and `bash` (`extensions/tool-firewall/default-policy.json:6-15`). Seventeen first-party tools declared by non-experimental profiles are omitted: all `branch_*`, `memory_*`, `record_verdict`, `verdict_status`, `subagent`, and `task_*` tools. Unknown tools resolve to `ask` (`extensions/tool-firewall/index.ts:200-205`), which is unconditionally blocked without a UI (`extensions/tool-firewall/index.ts:303-307`). Thus the autonomous profile cannot use the delegation/task/verdict/memory tools it includes at `profiles/autonomous.json:6-12`.

The conflict is stronger in `balanced` and above: `pentest-governance-domain` blocks every non-read-only direct tool unless undocumented `PI_ALLOW_DIRECT_TOOLS=1` is set (`extensions/pentest-governance-domain/index.ts:609-617`). This blocks even the explicitly firewall-allowed `todo` tool. `PI_ALLOW_DIRECT_TOOLS` appears nowhere outside those two source lines and is absent from `.env.example` and install/security configuration documentation.

Because A-1 loads the governance extension for `quick` as well, the current full-package installer can apply this MCP-only block to all profiles.

**Offline repro:** invoke the real governance `tool_call` handler with `{toolName:"todo", input:{action:"list"}}`, no UI, and no `PI_ALLOW_DIRECT_TOOLS`. Actual result:

```text
BLOCK MCP-only mode is enabled; direct tools require PI_ALLOW_DIRECT_TOOLS=1
```

Invoke the firewall handler headlessly with `subagent` or `task_create`; it similarly blocks as an unknown tool. No child agent/model was launched.

#### A-3 — Known `bash` is allowlisted, so elementary destructive variants bypass the firewall

**Severity: blocking. Confidence: high.**

The policy gives `bash` an unconditional base decision of `allow` (`extensions/tool-firewall/default-policy.json:13-15`). The content layer only raises that decision when one of 12 finite regexes matches (`extensions/tool-firewall/index.ts:208-241`; policy list at `extensions/tool-firewall/default-policy.json:18-30`). Therefore the documentation's claimed default-deny “backstop” for obfuscated commands does not apply: `bash` is not unknown.

**Offline repro:** load the real compiled extension, point the audit log at `NUL`, and pass each string as `{toolName:"bash", input:{command:<string>}}` to the handler with `hasUI:false`. Actual decisions:

```text
powershell -NoProfile -Command "Remove-Item -LiteralPath C:\victim -Recurse -Force"  ALLOW
r''m -rf /tmp/victim                                                        ALLOW
node -e "require('fs').rmSync('victim',{recursive:true,force:true})"        ALLOW
git clean -fdx                                                               ALLOW
```

The shell strings were never executed. These are not exotic provider attacks: one is the native destructive command on a supported platform, one is standard shell token concatenation, and one is a common runtime wrapper. The shipped tests only assert literal `rm -rf`, `dd`, a fork bomb, `curl|sh`, and force-push patterns (`tests/tool-firewall-smoke.mjs:89-126`). `docs/security.md:48-51` admits pattern evasion, but incorrectly presents unknown-tool default-deny as the backstop for a known allowlisted shell.

#### A-4 — Secret copying/encoding bypasses `secret-guard` with glob or split-path syntax

**Severity: blocking. Confidence: high.**

Shell protection requires both a transfer verb and a literal secret/protected-path match (`extensions/secret-guard/index.ts:57-68,85-93,131-143`). It performs no shell-aware expansion or simple normalization of globs/concatenation. The direct content detector is a narrow signature list (`extensions/secret-guard/index.ts:44-55`).

**Offline repro:** pass the following strings to the real handler as `bash` inputs. Baseline `base64 .env` blocked, while all of these returned `undefined` (allow):

```text
base64 .e?? > encoded.txt
cp .e?? C:\Temp\leak
cp $(printf '.e%s' nv) /tmp/leak
powershell -NoProfile -Command "$p='.'+'env'; [Convert]::ToBase64String([IO.File]::ReadAllBytes($p))"
```

Writing a base64-encoded provider-looking token to `public.txt` was also allowed. None of the strings was executed and no live secret was used. The regression suite tests only literal paths (`tests/secret-guard-smoke.mjs:80-88`), so it passes while elementary copy/encoding tricks evade the claimed boundary. Although the security document calls detection heuristic, this misses exactly the encoding/copy bypass class Epic 2 was meant to harden and the review was explicitly required to challenge.

### High

#### A-5 — Dream-mode allowlist is substring matching, not a path boundary

**Severity: high. Confidence: high.**

`isAllowlisted` accepts `normalized.includes(needle)` (`vendor/protected-paths/index.ts:29-35`), and the handler treats that as authority to write (`vendor/protected-paths/index.ts:45-59`). With the production allowlist `AGENTS.md;.pi/memory;GOAL.yaml`, the offline handler produced:

```text
src/app.ts                   BLOCK
src/AGENTS.md.backdoor       ALLOW
.pi/memory-escape/file.txt   ALLOW
AGENTS.md                    ALLOW
```

Epic 6's eval checks one obvious denied path and one exact allowed path only (`kit/eval/fixtures.mjs:294-324`). The enforcement point does not guarantee “only allowlisted paths” under adversarial naming.

#### A-6 — Four of five `branch-lab` tools use the wrong Pi execute signature

**Severity: high. Confidence: high.**

Pi calls custom tools as `execute(toolCallId, params, signal, onUpdate, ctx)`, as correctly used by `task-graph` (`extensions/task-graph/index.ts:79-91`). `branch_create`, `branch_switch`, `branch_discard`, and `branch_merge` instead treat the first argument as the input object (`extensions/branch-lab/index.ts:156-167,181-220`). Under the production call shape, `taskIdFrom` receives the call ID string and throws.

**Offline repro:** call the registered tool as `execute("call-1", {taskId:"review-task"}, null, null, {cwd})`. Actual result:

```text
ERROR Invalid taskId. Use 1-80 letters, numbers, dot, underscore, or dash characters.
```

The smoke test masks the bug by invoking the tool with the params object as argument one (`tests/epic1-smoke.mjs:143-155`). This is a concrete example of a test that passes while the advertised feature is broken.

#### A-7 — `provider-router` does not route inference

**Severity: high. Confidence: high.**

The extension listens to `model_select` and returns `{model: "..."}` (`extensions/provider-router/index.ts:45-62`), but Pi emits `model_select` *after* a model has already been selected and ignores handler return values (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1083-1091`). The public hook has no model-selection result contract. The extension never calls `pi.setModel`; its cast at line 55 simply hides that mismatch from TypeScript.

The smoke test directly calls the handler and asserts its otherwise-unused return object (`tests/epic2-smoke.mjs:133-150`). That proves a pure function result, not routing. This is a non-experimental-profile extension whose manifest claims it “Routes model inference” (`extensions/provider-router/extension.json:4`) but it is behaviorally a notification-only stub.

#### A-8 — `git-checkpoint` deletes all restore points at the end of every agent turn

**Severity: high. Confidence: high.**

The extension stores a stash ref at `turn_start` (`vendor/git-checkpoint/index.ts:12-18`) and looks it up during a later `session_before_fork` (`vendor/git-checkpoint/index.ts:20-33`), but clears the entire map on `agent_end` (`vendor/git-checkpoint/index.ts:36-38`). `agent_end` occurs after an agent response, before the user can select a prior message for the next command.

**Offline repro:** fake `pi.exec`, seed leaf `entry-1`, call `tool_result`, `turn_start`, `agent_end`, then `session_before_fork(entry-1)`. The only observed git call was `git stash create`; no `git stash apply` occurred. This contradicts the manifest's “restore code state to any prior point” claim and weakens the recovery flow that instructs users to checkpoint first.

#### A-9 — “Full profile regression” never installs or loads a full profile

**Severity: high. Confidence: high.**

`profile-check.mjs` explicitly limits itself to resolving names, ordering, and maturity metadata (`kit/profile-check.mjs:3-11`). For full profiles it only iterates `include` and prints a count (`kit/profile-check.mjs:58-85`); only the lite surface is exported/package-verified (`kit/profile-check.mjs:86-100`). Both CI files nevertheless label this a “Full profile regression” across Windows/Linux (`.github/workflows/ci.yml:37-51`; `.gitea/workflows/ci.yml:32-45`).

**Repro:** all six matrix targets passed during this review despite A-1, A-2, A-6, and A-7. The check never invokes `kit/install.mjs`, examines the resulting Pi settings, loads the wildcard package, or calls any profile tool. This does not meet Epic 9.1's install + verify + eval DoD, even under an offline-equivalent interpretation.

#### A-10 — Behavioral tests encode fake contracts and give false confidence

**Severity: high. Confidence: high.**

Three examples are independently demonstrated above:

- branch-lab tests call the wrong signature (`tests/epic1-smoke.mjs:147-155`);
- provider-router tests treat an ignored event return as routing (`tests/epic2-smoke.mjs:149-150`);
- recovery eval asserts only that a contribution contains the words “fresh scouts”, “top 10”, and “primary” (`kit/eval/fixtures.mjs:209-216`), not that any scout, fork, synthesis, plan, or delegated repair occurs.

The eval's security cases also repeat the exact happy-path smoke strings (`kit/eval/fixtures.mjs:23-65`) rather than adding adversarial variants. Green `verify`, security, eval, and profile matrices therefore do not establish the production claims they are cited for in `docs/roadmap.md`.

### Medium

#### A-11 — Recovery orchestration writes instructions and a scaffold; it does not run the claimed flow

**Severity: medium. Confidence: high.**

`recovery-orchestrator` builds prose telling the model to fan out scouts, fork, synthesise, plan, and delegate (`extensions/recovery-orchestrator/index.ts:70-91`). Runtime behavior writes that prose plus a markdown scaffold and consumes the marker (`extensions/recovery-orchestrator/index.ts:169-197`). It never invokes the `subagent` tool or performs any workflow state transition beyond files. The manifest carefully says “steers” the flow, so this is not a complete manifest lie; however, Epic 5.3's “Implement recovery-orchestration-mode” and “scripted stuck-task fixture drives the flow” DoD is materially narrower in implementation than the plan states.

#### A-12 — `pi-lean-ctx` preflight warns but cannot disable the failing external bridge

**Severity: medium. Confidence: high from local code; external runtime not available offline.**

The source catalogue says the external CLI is required and that its absence causes `spawn ENOENT` (`kit/sources.json:13-19`). `session-helpers` only displays a notification (`extensions/session-helpers/index.ts:104-120`); it neither removes the external extension nor changes its configuration. Its message claims “Output compression is disabled,” but no disabling action occurs. `pi-lean-ctx` is included even in `quick` (`profiles/quick.json:7`), while installation requirements do not make the binary mandatory. Because the reference package is not in this checkout, its behavior could not be independently run without forbidden network installation; the in-repo preflight alone does not meet Epic 1.1's “warn/disable cleanly instead of erroring” bar.

#### A-13 — External profile metadata still drifts and is outside the verifier's parity check

**Severity: medium. Confidence: high.**

All 38 non-template in-repo/vendored manifests exactly match `profiles/*.json`; that part of `verify` is real. However, `kit/sources.json` claims `pi-subagents` belongs to `autonomous` and `self-improving` (`kit/sources.json:39-46`), while neither profile includes `pi-subagents` (`profiles/autonomous.json:4-12`; likewise `profiles/self-improving.json`). The verifier treats external names only as a forward-resolution set and never checks their declared profile arrays (`kit/verify.mjs:267-298`). Generated catalogue metadata therefore says an external is present when the installer will not select it.

#### A-14 — `task-graph` stores dependencies but does not enforce a DAG

**Severity: medium. Confidence: high.**

The manifest advertises a persistent DAG, but `task_create` accepts arbitrary `depends_on` IDs and saves them without checking existence, self-dependency, or cycles (`extensions/task-graph/index.ts:69-92`). `isUnblocked` merely requires each referenced ID to be found and done (`extensions/task-graph/index.ts:61-63`). A first task can be created as `t1` depending on `t1`, permanently yielding “No unblocked task.” This narrows the implementation from a DAG manager to an unchecked dependency list.

## Declared non-experimental profile surface audit

“Pass” below means the local implementation substantially matches its manifest/command claim under static inspection and available offline behavior; it is not a live-model certification. Global policy/profile failures above can still prevent a passing tool from being invoked.

| Extension | Assessment |
|---|---|
| `auto-commit-on-exit` | Pass: shutdown hook stages and commits changes as claimed. Operationally aggressive, but not a stub. |
| `autonomous-loop` | Pass: `/loop` arms a marker/contribution and queues bounded follow-ups. |
| `branch-lab` | **Broken:** four parameterized tools use the wrong Pi call signature (A-6). |
| `caveman` | Pass: context-sieve style contribution and `/caveman` session controls exist. |
| `context-sieve` | Pass: contribution assembly, budgeting, and compaction instructions are implemented and smoked. |
| `custom-compaction` | Pass: applies a configured template; no-op without one. |
| `custom-footer` | Pass within offline API fixtures: status, pricing reload, branch/model/context display paths exist. |
| `git-checkpoint` | **Broken lifecycle:** restore points are cleared before later fork selection (A-8). |
| `goal-core` | Pass: `/goal` persists and contributes an active goal. |
| `guidelines` | Pass: reads a project guidance file and emits a context contribution. |
| `handoff` | Pass: shutdown and `/handoff` append notes. |
| `memory-local` | Pass: CRUD, keyword fallback, and optional loopback embedding behavior are implemented. |
| `notify` | Pass by inspection: platform/terminal notification paths are real. |
| `orchestrator` | Partial but manifest-accurate: materializes role files and *steers* delegation; it does not directly orchestrate tools. |
| `pentest-governance-domain` | Enforcement is real, but its undocumented default conflicts with all direct kit tools (A-2). |
| `pi-impact-analyzer` | External reference only; exact version pinned, but code absent and not behaviorally tested offline. |
| `pi-lean-ctx` | External reference; known missing-binary failure is only warned about, not disabled (A-12). |
| `pi-lens` | External reference only; exact version pinned, but code absent and not behaviorally tested offline. |
| `pi-readseek` | External reference only; exact version pinned, but full-profile behavior is not tested offline. |
| `progress-guard` | Pass: repetition/stall/oscillation detection, arm-marker auto mode, and escalation marker are implemented. |
| `protected-paths` | Core deny path exists; allowlist enforcement is bypassable by substring names (A-5). |
| `provider-router` | **Stub behavior:** returns an ignored event value and never switches a model (A-7). |
| `recovery-orchestrator` | Partial: deterministic marker/report/directive mechanism exists, not the executed multi-agent flow (A-11). |
| `secret-guard` | Partial: literal and content cases work, elementary encoded/copy forms bypass it (A-4). |
| `session-helpers` | Commands work; lean-ctx “disabled” claim is notification-only (A-12). |
| `spec-plan` | Pass: large source writes warn or block in strict mode when no plan exists. |
| `subagent` | Real single/parallel/chain subprocess implementation by inspection; not launched because live agent/model runs were forbidden. Default policies block it (A-2). |
| `task-graph` | CRUD and dependency gating work; DAG invariants are not enforced (A-14). |
| `todo` | Pass: persistent list/add/toggle/clear and `/todos` exist. Default balanced+ governance blocks the tool (A-2). |
| `tool-firewall` | Default unknown-tool fail-closed works; known-shell destructive coverage is bypassable (A-3). |
| `trace-ledger` | Pass: bounded JSONL call/result ledger, repeat warning, and `/trace` exist. |
| `trigger-compact` | Pass: threshold crossing and manual `/trigger-compact` call `ctx.compact`. |
| `verifier-board` | Pass: record/status tools and `/verdicts` persist latest source verdicts. Default policies block its tools (A-2). |
| `verify-gate` | Pass: `/verify` runs and writes pass/fail board state; eval's `shell:true` path emitted Node DEP0190 and should be cleaned up. |

## Metadata and offline-determinism conclusions

- Local/vendored `extension.json.profiles` metadata is bidirectionally consistent with the profile JSON for all 38 non-template manifests. The stub/TODO quarantine check also works on the declared JSON model.
- The external-source profile parity gap in A-13 remains.
- More importantly, runtime installation does not apply that otherwise-consistent profile model (A-1).
- Required tests/evals are offline and reproducible in outcome, but their fake contracts and narrow assertions leave substantial behavioral gaps (A-9/A-10).

## Recommended remediation order for the implementation pass

1. Make full-package profile/`--only` selection actually control Pi resources, then add a test of the resulting install/settings/resource set.
2. Compose a first-party policy for every shipped custom tool and reconcile MCP-only governance with profile intent, especially headless autonomy.
3. Replace the broad `bash: allow` model with a stronger execution boundary; at minimum cover supported-platform destructive primitives and obfuscation fixtures.
4. Harden secret path handling against globbing, concatenation, shell variables, PowerShell reads, and encoded staging; state the remaining DLP boundary precisely.
5. Use canonical path containment for protected-path allowlists.
6. Fix branch-lab's execute signatures and git-checkpoint lifecycle; make tests call the actual public API contract.
7. Implement provider routing through a supported pre-inference mechanism or quarantine/remove the claim.
8. Upgrade profile/eval coverage to load real extension resources offline and assert observable end-to-end state, not handler return values or prompt keywords.

## Review constraints confirmation

No remote push, tag creation/move, live Pi agent run, live model/backend invocation, or external network request occurred. No production source/document file was modified by this reviewer; only this report was added. The pre-existing untracked `HANDOFF_PROMPT_FOR_V1_HARDENING.md` was preserved.
