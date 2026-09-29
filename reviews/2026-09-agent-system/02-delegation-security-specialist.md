# Delegation, process ownership and authorization review

Reviewed 2026-09-14 against source commit `6460ef6392dc290038f5ad79835861f9e5e06134`, following both root review briefs and `00-specification.md`. This independent specialist owns delegation/messaging/cancellation, authorization, isolation and policy/credential/log integrity boundaries. No production files, live Pi processes, credentials or installed settings were changed. No attack string or inference was executed. All findings below are **source-grounded counterexamples**, not claims of executed exploitation. Coordinator simulations may independently strengthen them.

Applicability: findings apply when the named resource is loaded with the shipped default policy, unless a condition is stated. Source full package/profile selection is distinct from installed lite and process-loaded bytes; this review does not assume all extensions coexist in every profile. Conductor findings require conductor; dual-review requires dual-review; vendored findings require `vendor/subagent`. Core guard findings apply to configurations selecting those guards. Existing external OS isolation or stricter operator policy can reduce impact but is not implemented by these functions.

## Boundary map

- Vendored `subagent` discovers role files, appends their body to the child's system prompt, starts `pi --mode json -p --no-session`, and consumes private completed-message JSONL. Child stdin is ignored. Role name/task/step identify results; there is no durable mission/task epoch or routable worker handle (`vendor/subagent/index.ts:60`, `:163`, `:176`, `:182`, `:197`).
- Conductor adds a durable dispatch reservation, depth marker and restricted declared tool names; its process runner still shares cwd, environment, executable lookup and private pipes (`extensions/conductor/index.ts:63`, `:204`, `:223`, `:242`, `:265`). These are useful partial controls, not an OS security boundary.
- Dual-review independently spawns a shell child and injects output later as a user follow-up (`extensions/dual-review/index.ts:19`, `:24`, `:34`). Its slash command bypasses the model tool-call route entirely.
- The firewall judges tool name and command-shaped argument fields. Its shipped policy allows `read`, `write`, `edit`, `bash`, `subagent` and `dual_review`; regex matches only raise a decision (`extensions/tool-firewall/default-policy.json:7`, `:13`, `:15`; `extensions/tool-firewall/index.ts:257`). Secret/protected guards inspect selected tool names and text/path patterns. All these hooks live in the same process/user authority as extension execution.

## DS-01 — Child launchers feed untrusted task/diff text through a shell

**High severity; high source confidence, OS-specific execution untested.** Affected: dual-review on all platforms and vendored/conductor launchers on Windows.

Evidence: `extensions/dual-review/index.ts:20-24` puts raw diff/content in args then uses `shell: true`; `:38-41` does the same with `/review` path text. `vendor/subagent/index.ts:178-185` and `extensions/conductor/index.ts:242` combine raw task arguments with Windows shell spawning. No shell-specific escaping or inert transport separates this content from command text. The tool firewall sees `dual_review.content` or `subagent.task`, not a `command` field (`extensions/tool-firewall/index.ts:240-242`), and both tool names are allowed by default (`default-policy.json:16-17`).

Minimal sequence: a repository diff or delegated task contains shell metacharacters; operator/model requests the otherwise legitimate review/delegation; launcher constructs a shell command from those arguments. Expected: exact bytes reach only Pi as task data. Actual source path: the operating-system shell receives those bytes first, outside the child's tool firewall. This is distinct from the model later obeying malicious text.

Blind spot: `tests/subagent-progress-smoke.mjs:5-7`, `:53` exercises a fake Pi binary with a simple task, not adversarial argv fidelity; isolated firewall tests cannot inspect child-process effects. Mitigation: consolidate launchers on a resolved Node executable and CLI entrypoint with `shell:false`; send prompt through a file or supported protocol. On Windows resolve the JS entrypoint instead of relying on `.cmd` wrappers. Regression: inert echo-argv child receives quotes/newlines/metacharacters byte-for-byte on Windows/Linux; independently observed canary effects remain absent. Residual uncertainty: exact interpretation depends on Node/shell versions and quoting behavior, so final exploitability must be validated in a disposable lab without executing repository-supplied strings.

## DS-02 — Cancellation does not establish child or descendant termination

**High severity; high confidence.** Affected: all three launcher paths.

Evidence: `vendor/subagent/index.ts:234-242` sends SIGTERM and only escalates if `!proc.killed`; `proc.killed` indicates signal delivery rather than process exit. It resolves on `close` (`:227-229`), so an ignoring child can keep the caller waiting. Conductor has only SIGTERM (`extensions/conductor/index.ts:245`). Dual-review kills its immediate child once on a 45-second timer (`extensions/dual-review/index.ts:26-29`). Shell wrappers and child-created descendants have no process group/job ownership. Abort listeners are not removed on normal completion in vendored/conductor runners; the vendored timer is not cancelled.

Minimal sequence: child or descendant remains alive after termination request; parent cancels; SIGTERM is sent. Expected: prevent queued starts, terminate the owned tree within a deadline, await exit and publish cancelled evidence. Actual: signal delivery can suppress escalation, descendants are not targeted, and close/result may never arrive. Vendored parallel workers also continue dequeuing after cancellation (`vendor/subagent/index.ts:112-117`, `:350-352`), spawning each next child before checking its already-aborted signal (`:182`, `:241`).

Blind spot: progress smoke does not exercise signal-ignoring children, descendants or cancellation with queued work. Mitigation: one process owner, process groups on Linux/Jobs on Windows, explicit exited state, bounded escalation and listener/timer cleanup; abort before dequeuing/spawning. Regression: inert child/grandchild fixtures and queued parallel work must leave zero owned live processes after deadline, preserve partial outputs, and create no post-cancel workers. Actual cross-platform termination remains deferred.

## DS-03 — Project-role trust confirmation is model-disableable and absent headlessly

**High severity; high confidence.** Affected: vendored subagent using `agentScope:"project"` or `"both"`.

Evidence: confirmation is an ordinary model tool parameter (`vendor/subagent/index.ts:269-270`); `:291` accepts `false`; `:307` additionally requires `ctx.hasUI`. Project role body is appended to system prompt (`:172-176`) and can select tools/model (`:164-165`; `vendor/subagent/agents.ts:58-68`).

Minimal sequence: untrusted repository supplies `.pi/agents/role.md`; request project role with default confirmation in headless mode, or `confirmProjectAgents:false` in UI mode. Expected: untrusted role requires an operator-origin trusted grant or is blocked. Actual: role launches without the trust confirmation and its content becomes system-prompt material. Default firewall permits subagent itself.

Blind spot: progress smoke explicitly uses project scope with confirmation disabled (`tests/subagent-progress-smoke.mjs:53`), treating this as setup rather than testing trust. Mitigation: operator-owned trust registry tied to role digest/repository identity; remove permission switches from model parameters; headless unresolved trust becomes a structured blocker. Regression: modified role invalidates grant; headless untrusted role never spawns; trusted exact role works. Residual: project instructions may already be intentionally trusted by the operator, but that prior trust is not represented by this gate.

## DS-04 — Delegation has no shared mission budget or bidirectional worker protocol

**High severity for bounded liveness; high confidence.** Affected: vendored subagent, dual-review, and mixed launcher configurations.

Evidence: vendored limits are per invocation (`vendor/subagent/index.ts:25-26`, `:347-351`); chain length has no equivalent maximum (`:325-342`). Spawn envelope has cwd/role/task but no task epoch, mission-wide resource reservation or deadline (`:135-153`, `:258-272`). Private ignored stdin prevents in-process question/reply transport (`:185`); only final message summaries are returned (`:197-214`, `:355-366`). Dual-review is a second independent start path. Conductor's durable reservation is meaningful (`extensions/conductor/index.ts:265-273`) but its generic-subagent block applies only with a readable active engagement (`:327-329`) and does not govern dual-review.

Minimal sequence: parent performs repeated allowed subagent calls, or workers inherit a delegation-capable extension configuration and recursively delegate; each call receives a fresh local concurrency allowance. Expected: enforce one tree budget and let a worker request help or return blocked through control messages. Actual: no common tree budget or mailbox exists, and headless workers cannot receive a routed answer. Recursive extension-tool availability requires pinned-runtime validation; repeated parent calls alone establish the budget gap.

Blind spot: a single call capped at four workers does not test total starts, chain length, nested launchers or bidirectional control. Mitigation: consolidate/adapt launchers to one broker with IDs/epoch, leases, accepted dispositions, backpressure and mission-wide limits; preflight role capabilities. Regression: repeated calls, chain steps and all adapters consume the same cap; duplicate messages are idempotent; blocked read-only worker can report and stop without writing shared control files. Residual: resource budgets enforced outside this kit may bound actual spending, but are not shown in these launchers.

## DS-05 — Dual-review survives task cancellation and promotes late output to user intent

**High severity; high confidence.** Affected: dual-review-enabled sessions.

Evidence: `extensions/dual-review/index.ts:66-70` ignores tool cancellation/context and returns immediately. `:32-34` unconditionally calls `sendUserMessage(...deliverAs:"followUp")` on close with stdout/stderr text. No job/task ID, epoch, cancellation registry, exit-status validation or stale-result check exists. The role is a textual review instruction; no `--tools` restriction is supplied (`:20-24`).

Minimal sequence: task A launches review; operator cancels or replaces A with B; review closes. Expected: preserve result under A without scheduling B, or mark stale/cancelled. Actual: a fresh user follow-up is injected into the current session and may schedule additional work. Error output can be presented as a code review and the reviewer has ambient default tools, despite a review-only objective.

Blind spot: launch success/timeout tests do not model task replacement or handler composition; treating received text as review completion misses process failure. Mitigation: typed review-result messages correlated to task/revision; central worker cancellation and explicit read-only capability envelope. Regression: cancellation, superseding input and out-of-order reviews produce no unauthorized continuation; errors remain failed dispositions. Residual: exact input-origin semantics of `sendUserMessage` should be checked against pinned Pi; unconditional unscoped follow-up is directly visible.

## DS-06 — Output caps do not bound child-stream memory

**Medium severity; high confidence.** Affected: vendored/conductor/dual-review.

Evidence: vendored stores every complete message, all stderr and an unbounded partial line (`vendor/subagent/index.ts:199`, `:218-225`); its 50 KiB cap applies only when rendering parallel result summaries (`:27`, `:96-100`, `:356`), not collection, single mode or chain. Conductor similarly accumulates messages/buffer/stderr (`extensions/conductor/index.ts:242-244`); dual-review accumulates all output (`extensions/dual-review/index.ts:25`, `:30-31`).

Minimal sequence: child emits a huge line, many messages or continuous stderr. Expected: bounded buffers/backpressure and durable spill with truncation/loss indicators. Actual: parent heap grows until exit/resource failure; timeouts do not establish byte caps. Blind spot: small synthetic progress output. Mitigation: streaming collector with per-message/stream limits and bounded summaries; reject oversized JSON records explicitly. Regression: large inert streams remain below a measured memory ceiling and preserve useful final disposition. Residual: actual exhaustion threshold depends on process memory limit.

## DS-07 — Direct read tools can disclose credential files under default guards

**High severity; high confidence.** Affected: shipped default firewall with secret-guard/protected-paths; including read-only roles where `read` is available.

Evidence: `extensions/tool-firewall/default-policy.json:7` allows every `read` regardless of path; fallback also permits read (`extensions/tool-firewall/index.ts:37-45`). `extensions/secret-guard/index.ts:177-208` only checks write/edit and bash. `vendor/protected-paths/index.ts:94-101` likewise ignores read. Secret filename patterns exist (`secret-guard/index.ts:15-26`) but are never applied to reads.

Minimal sequence: call `read` on a synthetic `.env`, `.ssh/id_ed25519`, or provider credential file reachable by the Pi user. Expected under the requested boundary: deny or require scoped approval before sensitive content reaches the model. Actual: these three guards return no block; the read tool can expose bytes. No real credential was accessed.

Blind spot: secret smoke targets write content and shell transfer patterns (`tests/secret-guard-smoke.mjs:74`, `:94-97`); direct credential read is absent. Mitigation: capability/path-scoped read policy backed by canonical paths and OS isolation, credential brokering instead of mounting secrets. Regression: synthetic credential fixtures blocked through read/search/custom tools while ordinary source remains readable. Residual: other configured controls or file ACLs may prevent access; this is a guard coverage failure, not evidence that a real secret was leaked.

## DS-08 — Ordinary writes can alter policy and erase local audit evidence

**High severity; high confidence.** Affected: default write-capable sessions with relevant files writable by the agent user.

Evidence: firewall allows write/edit (`default-policy.json:13-14`); secret protected list excludes `.pi/tool-firewall-audit.jsonl`, `.pi/trace.jsonl`, and extension policy files (`extensions/secret-guard/index.ts:31-42`). Protected-path defaults only cover `.env`, `.git/`, `node_modules/` (`vendor/protected-paths/index.ts:5`). Firewall resolves its own policy path (`extensions/tool-firewall/index.ts:66-84`) and automatically reloads on mtime changes (`:210-214`). Audit is a same-user local append file (`:87-88`, `:278-281`).

Minimal sequence: ordinary write replaces the active policy file with an allow policy, or overwrites a local audit/trace file with innocuous text. Expected: ordinary task authority cannot administer policy or rewrite prior evidence. Actual: none of these guards rejects those paths; policy change becomes effective on subsequent calls and audit history can disappear. Writing an audit file may itself be logged first, then erased by the tool action.

Blind spot: tests check known protected filenames and policy parsing, not self-administration under composed guards. Mitigation: external policy ownership and append-only collector under separate authority; deny administration paths through all write paths as defense in depth. Regression: inert proposed writes blocked and independently recorded; policy changes require an operator-origin grant/version event. Residual: read-only installation ACLs may protect an embedded policy, but repository-loaded policy and local logs remain a concrete default case.

## DS-09 — Shell authorization is a deny-pattern filter, not an action allowlist

**High severity against the requested threat model; high confidence.** Affected: shipped default policy with shell access; write-allowlist mode also affected.

Evidence: bash is allowed (`extensions/tool-firewall/default-policy.json:15`), unmatched command patterns preserve allow (`extensions/tool-firewall/index.ts:229-237`, `:257-275`). Protected-path shell target parsing recognizes only redirection/tee/cp/mv (`vendor/protected-paths/index.ts:78-84`), and secret shell protection depends on a selected transfer verb plus recognizable secret/path text (`extensions/secret-guard/index.ts:62-63`, `:201`).

Minimal sequence: call an ordinary interpreter/script entrypoint whose external effects are not represented by one of those regexes. Expected from the brief: unknown effects do not silently execute and write restrictions hold across execution routes. Actual: command is allowed without determining script contents, target paths, destinations or credential access. This is not a claim that every shell call is malicious; safe npm/build workflows also need a useful policy.

Blind spot: known attack-string regression cases demonstrate matched patterns only; adding evasion strings indefinitely cannot prove an allowlist. Mitigation choices: trusted bounded tool adapters; read-only or isolated shell profiles; approval for broader native execution with declared effects; OS/container enforcement for arbitrary programs. Regression: representative benign workflow and held-out interpreter/wrapper cases in an inert fixture; unknown effects block or request approval. Residual: documentation already acknowledges regex incompleteness (`tool-firewall/index.ts:245-252`); severity reflects incompatibility with the desired security boundary, not an undisclosed promise of full sandboxing.

## DS-10 — Write allowlist basename entries are not scoped to workspace

**High severity in write-allowlist/dream configurations; high confidence.** Affected: `PI_KIT_WRITE_ALLOWLIST` containing a bare filename such as `AGENTS.md`.

Evidence: `vendor/protected-paths/index.ts:44-54` resolves the target, but bare filename entries compare only `path.basename(candidateAbs)`. Thus any absolute/relative-outside path ending `AGENTS.md` matches. Directory entries use lexical `path.resolve` comparisons (`:36-41`, `:48-49`) without realpath/symlink resolution. Secret guard may independently block some destinations but ordinary outside-workspace `AGENTS.md` is not one of its protected paths.

Minimal sequence: set allowlist `AGENTS.md`; propose write to a synthetic sibling directory's `AGENTS.md`. Expected: allow only intended workspace file. Actual: basename matches and guard permits it. Alternate directory sequence: allowed directory contains a symlink/junction to a nonallowlisted directory; lexical descendant passes. The latter requires a filesystem fixture to establish actual dereference behavior.

Blind spot: `tests/protected-paths-smoke.mjs:33-39` checks deceptive suffixes and true nested paths, not same basename outside cwd or symlinks/junctions. Mitigation: resolve every entry relative to an explicit authorized root; distinguish exact-file/directory entries and verify actual path containment with race-safe open/OS restrictions. Regression: outside basename blocked, real intended file allowed, traversal and symlink/junction routes tested on Windows/Linux. Residual: filename-global semantics may have been intentional, but conflict with stated dream-mode scoping (`protected-paths/index.ts:13-16`).

## DS-11 — Headless approvals fail closed but have no route to resolution

**Medium severity for availability/liveness; high confidence.** Affected: headless delegated calls needing an `ask` decision.

Evidence: `extensions/tool-firewall/index.ts:343-347` immediately returns a blocked result with reason “no interactive UI ... fail closed.” No pending approval ID, parent route or resumable action exists. Vendored children use print mode with ignored stdin (`vendor/subagent/index.ts:163`, `:185`). A new model attempt is another ordinary call, not a waiting state.

Minimal sequence: worker reaches an action requiring operator approval; headless handler blocks; model either reports failure or retries while parent awaits private output. Expected: visible pending/blocked disposition with owner and bounded resolution path, with no inference spent polling. Actual: fail-closed authorization is correct, but no approval control protocol exists and retries remain possible. Existing smoke coverage verifies a block rather than end-to-end approved resumption (`tests/tool-firewall-smoke.mjs`).

Mitigation: parent-visible approval queue bound to actor/task/epoch/action/policy, deadline and revocation; or explicitly preflight headless tasks to a capability set and return a structured blocker immediately. Regression: one blocked action yields one pending request, no extra model turns without resolution, approval/cancel resolves the correct action, stale approval cannot revive it. Residual: the kit alone cannot force a model to retry; this finding establishes missing infrastructure, not an observed retry loop.

## Positive controls and limits

The fallback policy denies unknown tools, explicit headless approvals fail closed, command decisions only become stricter, and project-role UI confirmation exists. Conductor validates role tool names, excludes bash, records durable dispatch reservations and protects its child engagement ledger. These reduce risk and should be retained or migrated behind a common control plane. They do not establish same-user filesystem isolation, mission-wide scheduling ownership or trustworthy review attestation.

Prioritize DS-01, DS-02, DS-07 and DS-08 containment before interpreting successful smoke tests as release readiness. Final cross-platform canary validation, pinned-runtime extension-tool inheritance, external-tool loading and independent post-uplift red-team exercises remain required. No actual incident process or reported token spend was attributed by this review.
