# Independent observability and integration review

Date: 2026-09-14. Baseline: `6460ef6392dc290038f5ad79835861f9e5e06134`. Scope: telemetry/ECS readiness, footer and operational UX, selected/exported resources, integration fidelity and historical validation. This report is independent of the other specialist reports. No production code, installed settings, live processes or transcript bodies were changed/read; no inference or external security testing was performed.

Runtime evidence below refers to the installed `C:/Users/Anthony Grace/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent`, version 0.76.0. File inspection establishes current bytes, not the bytes held by a pre-existing process. Installed-kit hash comparison belongs to the coordinator. Seven material findings follow; missing release capabilities are distinguished from reproduced defects.

## OI-01 — Footer compatibility shim removes the runtime's built-in footer

**Severity/confidence:** high/high. **Scope:** interactive Pi 0.76.0 with `custom-footer`: quick, balanced, long-horizon, autonomous, self-improving, engagement, lite and full-package loads. Headless runs skip the update and are unaffected by this rendering defect.

**Evidence:** `vendor/custom-footer/index.ts:152` claims there is no public `ui.setFooter` in Pi 0.76 and calls `ui.setFooter(STATUS_KEY, { left, right })` at line 160; clearing repeats the invalid call at line 173. Actual runtime `dist/core/extensions/types.d.ts:106` declares `setFooter(factory)`. `dist/modes/interactive/interactive-mode.js:1452` removes the current footer before calling `factory(...)` at line 1465; its UI adapter at line 1551 forwards only the first argument.

**Sequence/control:** session_start -> kit updateStatus -> runtime setFooter receives string `custom-footer` -> runtime removes built-in footer -> calling string as a function throws -> kit catches it -> kit updates a status entry whose built-in rendering component has already been detached. Expected: retain a visible built-in footer with the status entry, or install a valid component. Actual: no replacement component is attached. `/footer` clearing cannot restore it because it passes the same invalid first argument.

**Executed bounded reproduction:** Node 24 `stripTypeScriptTypes` loaded the actual extension from a data URL. A `new Function` executed the verbatim installed `setExtensionFooter` method, with a fake UI tracking attached components. After session_start and a real-shaped turn_end: `builtinFooterAttached=false`, `attachedComponentCount=0`. This exercises the actual runtime method, not a full terminal render or live Pi session. Initial reproduction invocation had a local JavaScript syntax typo; the corrected invocation exited 0.

**Blind spot:** `tests/epic1-smoke.mjs:202` accepts arbitrary setFooter arguments, and line 209 asserts call count rather than component attachment; therefore it approves the invalid contract. Broad casts in FooterCtx also suppress useful type checking.

**Mitigation/test:** remove the speculative setFooter calls and use the supported setStatus API, or implement a typed factory and restore with `setFooter(undefined)`. Test the real runtime adapter with existing built-in and custom footers, repeated updates, toggle and reload. Acceptance: exactly one attached functional footer throughout; narrow-terminal/manual accessibility checks remain required. Another loaded extension may independently replace the footer, so this is a source-grounded cause of the reported symptom, not proof of the live session's sole cause.

## OI-02 — Usage adapter reads an event shape Pi does not emit

**Severity/confidence:** high/high. **Scope:** same selected profiles as OI-01; affects displayed `/footer status` numbers even if rendering is repaired.

**Evidence:** `vendor/custom-footer/index.ts:125` reads top-level `event.usage`; line 127 recognizes provider-style input aliases, but not Pi's `input`/`output`/`cacheRead`/`cacheWrite`. `dist/core/extensions/types.d.ts:495` defines TurnEndEvent with `message`, not top-level usage. Existing live scoring correctly consumes `event.message.usage` and Pi field names (`kit/eval/live/scoring.mjs:46`). Lines 139 and 210 of the footer substitute/maximize current context occupancy into a cumulative total, conflating two different measures.

**Sequence:** assistant finishes with `message.usage={input:1000,output:500,cacheRead:200,cacheWrite:0,totalTokens:1700}` -> turn_end -> footer reads missing top-level usage -> input/output/cache counts stay zero; context usage is treated as total. Expected: observed usage counted exactly once, context occupancy separately, missing pricing/usage marked unknown. Actual bounded reproduction with context tokens 42 displayed `input 0 | output 0 | total 42 | est $0.00`. Defaults also label unknown configured pricing as zero-cost local-model pricing.

**Blind spot:** `tests/epic1-smoke.mjs:212` supplies `{usage:{input_tokens:1000,output_tokens:500}}`, an invented extension event. The historical evaluation-integrity scoring improvements do not repair this separate UI consumer.

**Mitigation/test:** share a typed Pi usage adapter, aggregate completed assistant messages with deduplication and scope identity, keep context occupancy and observed cumulative consumption separate, preserve unknown usage/pricing. Test multiple turns, cache fields, compaction, session switch, missing usage, repeated command refresh and child accounting. This review makes no claim about the operator's reported seven-million-token provider total or actual billing.

## OI-03 — Tool ledger cannot reconstruct agent ownership or the authorization/execution lifecycle

**Severity/confidence:** high/high (source-confirmed coverage gap). **Scope:** every selected profile includes trace-ledger; parent and children sharing cwd are particularly affected.

**Evidence:** `extensions/trace-ledger/index.ts:18` records only ts, turn, kind, tool, target, argsHash and optional status. Hooks at lines 115 and 136 record tool_call/tool_result; line 121 omits the runtime tool-call ID. `.pi/trace.jsonl` is cwd-scoped; each extension instance starts its own turn counter at zero. `extensions/tool-firewall/index.ts:325` and `:338` emit separate decision/hash records, without a shared unique call/agent identity. Actual runtime `dist/core/extensions/runner.js:593` stops dispatch on the first blocking tool_call handler at line 604, so a later logger cannot observe that attempted call. No ECS version, event identity, process ownership, replay sequence or model-request lifecycle exists in this entry schema.

**Sequence:** parent and child both execute the same tool/arguments at their own turn 0 -> identical action digest and overlapping records -> one is blocked or fails -> analyst cannot uniquely relate records to actor, call instance and execution. Expected: distinguish authorization from execution and correlate every attempted/start/end/cancel event to a durable agent and task. Actual: repeated action hashes are semantic fingerprints, not instance identities; earlier blocking handlers can skip the trace hook entirely. This is a static counterexample, not a claim about actual installed extension ordering.

**Blind spot:** `tests/trace-ledger-bound-smoke.mjs` uses one extension instance with synthetic events and only verifies line count. Independent logger tests cannot establish whole-run coverage. ECS-shaped output alone would not solve absent ownership or event delivery.

**Mitigation/test:** collect intent and final policy disposition at the authoritative dispatch boundary, assign call and agent IDs before authorization, and correlate process/model/shell/approval events. Pin and schema-test ECS separately from a documented Pi namespace. Run two instances with identical actions plus blocked, failed and cancelled calls; require complete unambiguous joins and explicit missing-event detection. External direct execution remains a separate coverage problem requiring process/control integration.

## OI-04 — Action details are neither safely redacted nor explicitly truncated

**Severity/confidence:** medium/high (source-confirmed behavior; no real secret used). **Scope:** all profiles containing trace-ledger.

**Evidence:** `extensions/trace-ledger/index.ts:44` chooses path/pattern/command/query and line 49 silently slices it to 200 characters. `appendEntry` at line 60 serializes this raw string. The firewall audit supplies a digest rather than human-readable execution detail (`extensions/tool-firewall/index.ts:325`). No redaction or truncation flag appears in Entry.

**Sequence:** an allowed command contains sensitive argument material, or meaningful command suffix occurs after character 200 -> ledger receives raw prefix -> sensitive prefix can be persisted while the suffix disappears without an indicator. Expected: redacted readable action/working directory with explicit truncation and a protected detail reference. Actual: reviewers cannot tell whether a recorded command is complete, and the logger itself supplies no redaction protection. Other extensions might block some secret-shaped inputs before this hook; that does not establish general log redaction coverage.

**Blind spot:** trace bounds tests exercise short file paths, not accepted synthetic credentials or long commands. No executed exfiltration test is claimed.

**Mitigation/test:** structured argument redaction before any collector write, explicit original length/truncated markers and access-controlled non-secret detail artifacts; minimize stored free-form content. Test synthetic secret canaries in accepted arguments and commands sharing the first 200 characters; require redacted records with distinguishable full-action references.

## OI-05 — Rolling ledger rewrites discard evidence and hide collector failures

**Severity/confidence:** high/high for explicit deletion/silent error handling; medium confidence for concurrent lost updates until reproduced. **Scope:** all trace-ledger profiles, aggravated by concurrent children in one cwd and long sessions.

**Evidence:** `extensions/trace-ledger/index.ts:70` reads the whole file and line 76 rewrites only its last 500 lines; session_start line 112 and turn_end line 162 both trigger this. append failures are swallowed at line 65; trim failures at line 77; malformed lines/read failures at lines 91/96 are skipped or returned as an empty list. No loss counter, collection health state, retained archive or tombstone is emitted.

**Sequence:** long run exceeds 500 records -> a turn ends -> earlier records disappear. With two processes: A reads N records -> B appends result -> A writes its previously read tail -> B's new record can disappear. Disk-full/permission failure -> append throws -> swallowed -> UI reports no collection fault. Expected: bounded storage with explicit retention and detectable loss, preserving required review evidence outside an ordinary agent's authority. Actual: silent deletion and silent failed writes; logs are mutable by the same OS principal.

**Blind spot:** `tests/trace-ledger-bound-smoke.mjs` explicitly rewards <=500 retained lines and never checks dropped-event accounting, interleaved writers or failed storage. The previous AG-10 change addresses in-session size growth, not durable audit integrity.

**Mitigation/test:** replace read-modify-rewrite with single-writer collection and controlled rotation, sequence IDs, retention metadata and visible collector health; define risk-dependent behavior during local collection failure independently of remote Elastic outages. Force append failure and controlled interleaving; require a visible gap/loss alarm and preservation of retained records. Same-user application hashes are not independent tamper evidence. No concurrent filesystem race was executed in this review.

## OI-06 — Child progress and plan tools do not provide the required operational view

**Severity/confidence:** medium/high (capability gap, not a claim that every UI is broken). **Scope:** vendored subagent and todo in all reviewed profiles/surface. Optional external UI/delegation may differ and must be inventoried before claiming coverage.

**Evidence:** `vendor/subagent/index.ts:163` launches `--mode json -p --no-session`; line 185 uses private stdout/stderr. Lines 197 and 214 produce parent updates from completed messages with role/stop reason/turn count, not a browsable durable tool execution stream. `vendor/todo/index.ts:12` selects one cwd TODO file; line 32 writes basic done/text entries; `/todos` at line 91 only reports the path. Footer `vendor/custom-footer/index.ts:202` displays usage/model/git/context, not agent/shell/approval state. Headless firewall at `extensions/tool-firewall/index.ts:344` returns a blocked result rather than creating an operator-routable approval request.

**Sequence:** child starts a long tool or needs authorization while parent awaits subagent -> no completed child message yet -> operator needs actor, command, pending approval owner and resolution path. Expected: navigable agent/tool/shell timeline and explicit waiting/blocked state, current task plan with dependencies and appropriate scoped controls. Actual kit path offers eventual message summaries, a TODO file and a blocked result; no unified operational contract is demonstrated. Missing approval dialog is correct fail-closed behavior in headless mode, but lacks the requested recovery route.

**Blind spot:** `tests/subagent-progress-smoke.mjs:19` emits completed message_end events and checks progress callbacks; it cannot validate tool-start/update timing, navigation, approval routing or shell ownership. Footer tests do not render a terminal. Installed `npm:@jmfederico/pi-web` contents and user accessibility were not assessed here; configured presence does not prove this missing integration is supplied.

**Mitigation/test:** consolidate status over durable control events, make child tools/approvals and shell ownership navigable without changing active work, and project scoped plans with stale/dependency state. Test long-running tool before first message_end, headless approval, child crash, reconnect and narrow terminal/keyboard navigation. Do not conflate model activity with progress or advertise pause as stopping an external process.

## OI-07 — Export/install metadata cannot identify the reviewed artifact

**Severity/confidence:** medium/high (provenance gap, not proof an export currently differs). **Scope:** lite export plus local installs; full source also exposes an open peer range.

**Evidence:** `kit/export-package.mjs:149` records source package name/version and generation timestamp at line 150; generated version at line 291 inherits root version 1.0.0. Line 262 removes and recreates the same output path; package writing at line 306 has no source revision/content manifest. `kit/install.mjs` records source/profile/names/time in its final marker, but no hashes or runtime-resolved entry inventory. `package.json` pins dev runtime 0.76.0 while allowing peer `>=0.76.0`. The companion brief reports the installed settings point at the different OffSec checkout; coordinator owns current parity confirmation.

**Sequence:** review source A -> export/install A -> edit source/export B at same path/version -> inspect settings/version or existing process -> cannot distinguish A from B or recover which selected files a prior process loaded. Expected: reviewed immutable artifact identity plus actual load receipt. Actual metadata supplies mutable location and repeated version only. This makes source tests insufficient deployment evidence.

**Blind spot:** manifest/name/type checks and install profile filtering verify package structure/selection, not runtime-loaded byte provenance. The real footer incompatibility demonstrates why typed manifest presence is insufficient.

**Mitigation/test:** immutable content-addressed or revisioned exports with file digests, recorded dependency lock and runtime version, selected extension inventory, and startup load receipts; compare before activation. Test source/export mutation preserving version and verify drift is detected. Avoid rewriting an installed export used by existing sessions during review. Runtime-process attestation limits must remain explicit.

## Coverage and historical evidence

All five requested named profiles plus engagement and lite were source-inspected. Each selects custom-footer, trace-ledger, todo and vendored subagent; therefore OI-01 through OI-06 are not confined to the autonomous tier. Full-package wildcards also select these components. Profiles and surfaces are not interchangeable: lite has 16 kit extensions plus required pi-readseek and optional pi-lens; long-horizon/autonomous/self-improving select additional recovery/task/verifier resources. Autonomous and self-improving also select optional-reference pi-subagents; external installation/actual registration requires separate confirmation. `kit/install.mjs:155` distinguishes profile filtering from full/surface loads, and lines 267 onward apply resolved filtering after registration. This is a meaningful previous fix, not evidence of live-byte equivalence.

Read historical `docs/agent-improvement/cycles/20260908-060000-verifier-reliability/05-findings.json` and `20260908-060001-evaluation-integrity/05-findings.json` as claims/leads, without opening referenced transcript bodies. The first explicitly leaves coding competence and cyber report accuracy inconclusive and names shell-only edit tracking as follow-up. The second distinguishes observed usage from complete consumption; current `kit/eval/live/scoring.mjs:46` and `tests/live-evaluation-integrity.test.mjs:132` reflect that stronger accounting contract. These are useful improvements but do not validate the footer or composed production runtime. No historical PASS was promoted to a current full-system result.

Bounded footer contract reproduction was executed on Windows only. Full TUI rendering, Linux execution, ECS ingestion/mappings, dashboards, collector outage/tamper tests, web integration, provider token reconciliation and final independent lab red-team validation remain unexecuted acceptance work. The ECS readiness finding is absence of an end-to-end event contract, not an assertion that these custom records purport to comply with a particular ECS version.
