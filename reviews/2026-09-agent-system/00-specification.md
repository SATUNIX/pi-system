# Agent-system review specification

Date: 2026-09-14. Source baseline: `6460ef6392dc290038f5ad79835861f9e5e06134` (latest commit adds the two review briefs). Working tree was clean at entry. Review outputs are additional artifacts, not production changes.

## Scope and sequence

Follow both root review briefs: baseline inspection, independent specialists, coordinator reproduction/reconciliation, architecture decisions and implementation plan. This review stage delivers evidence before broad implementation. Implementation, deployment and final independent agentic red-team validation are subsequent stages; the present review cannot constitute that release gate. Preserve live Pi processes, installed settings and transcripts. Never fabricate verification or weaken authorization to obtain progress.

Assess Windows source and installed artifact separately; inspect Linux paths statically and label unexecuted platform tests. Runtime reference is installed Pi 0.76.0 and the source lockfile pin, not the open-ended peer range. Cover full package, quick/balanced/long-horizon/autonomous/self-improving profiles and lite surface; optional external delegation is not assumed loaded. Inspect CLI/TUI/headless and configured web integration; distinguish source availability, selected resources and actual process-loaded bytes.

## Threat and fault model

Include erroneous/stuck models, untrusted repository/role/tool-output instructions, ordinary tool authority attempting policy/log tampering, stale reviews, duplicate input, concurrent sessions sharing cwd, process crash/cancel, missing approval/verification infrastructure, unavailable tools, exhausted budgets and lost telemetry. Do not claim same-user filesystem controls isolate arbitrary native execution. No tests against real secrets, live tasks, external targets or paid model endpoints.

## Evidence standard

Each material finding needs baseline/profile, file/line anchors, minimal event sequence, expected/actual transition, relevant prompt/control, existing-test blind spot, severity/confidence, alternatives, regression criteria and uncertainty. Separate observed source behavior, executable deterministic reproduction, bounded approximations and untested hypotheses. Historical reviews are leads to revalidate. No inference about seven-million-token spend without scoped provider evidence; do not collect unrelated conversations.

## Independent work and budgets

Three reviewers run concurrently after coordinator baseline inspection, each owning a separate report: (1) scheduling/prompt/verification/recovery; (2) delegation/process ownership/authorization/isolation; (3) monitoring/UX/export/integration. Each gets at most 12 material findings and approximately 15 minutes, no live inference, no production edits, no additional delegation. Coordinator owns simulation fidelity, runtime inventory, incident approximation and reconciliation. Together these cover the eight delegation and six monitoring specialist areas; areas are assigned independent of other reviewers' conclusions.

## Deliverables and matrix

Deliver runtime/resource and trust map; current and proposed lifecycle/prompt/sequence models; independent reports; no-inference scenario runner and traces; reconciled findings; architecture decisions, phased migration/rollback backlog and numerical acceptance matrix. Each scenario from delegation brief section 9 must be mapped to reproduced, source-reviewed or deferred status. Key tests cover read-only completion, missing/corrupt/stale boards, composed continuations, provenance resets, unavailable recovery capabilities, shared cwd contamination, process cancellation, headless approval, tampering and telemetry gaps. Compare against pinned runtime source before claiming event fidelity. Unimplemented protocol properties remain explicit acceptance work, never green placeholders.

## Review outcome

Determine production readiness within this model; prioritize containment, then durable task/control identity and budgets, delegation/verification/recovery consolidation and telemetry/UI. Human operator remains merge authority. Final lab red-team evidence must follow implemented uplifts and ordinary tests and remain independent where practical.
