# Archive

This directory contains material relocated out of the live docs set for historical
reasoning trails only. Nothing in the live docs set or CI links here unless a document
says otherwise; treat these as non-current and see `docs/roadmap.md` and `CHANGELOG.md`
for the authoritative current state.

## Ported here

- `DELEGATION_LIVENESS_REVIEW_BRIEF.md` — **not superseded.** An open review brief
  (10 September 2026) on coherent multi-agent execution, delegation and recovery, written
  for a fresh session to expand into a full review. It states its own status as an open
  handoff; no completed review is recorded against it in this repository.
- `MONITORING_SECURITY_UX_REVIEW_BRIEF.md` — **not superseded.** An open review brief
  (10 September 2026) covering monitoring, security, agent control and usability, and
  explicitly a release gate. Read together with the delegation/liveness brief above. See
  its "Status in this repository" section for the evidence currently satisfying — or not
  satisfying — that gate.
- `Pi RAIA.txt` — a standalone architecture vision note ("Recursive Agent Improvement
  Architecture") for a continuously-improving agent ecosystem layered over a stable
  execution agent. Not a handoff and not marked superseded; it grounds the
  `docs/agent-improvement/` design.
- `HANDOFF_20260805T044056Z.md`, `HANDOFF_20260805T050705Z.md` and
  `HANDOFF_PROMPT_FOR_V1_HARDENING.md` — the `0.4.1 → 1.0.0` production-readiness pass.
  Superseded in full by the shipped release; `CHANGELOG.md` is authoritative.
- `LATEST_PLAN_2026-08-04T042958Z.md` — the 9-epic production-readiness plan. Superseded;
  `docs/roadmap.md` and `CHANGELOG.md` are authoritative and its corrections are resolved
  in code.
- `HANDOFF_20260826T025711Z.md` … `HANDOFF_20260827T004424Z.md` — Conductor Phases 1–5
  handoffs. Superseded by the shipped `packages/extensions/src/conductor/` and the
  conductor smoke suites.

The five Conductor-phase handoffs and the two 0.4.1→1.0.0 handoffs were ported on
2026-09-16, when the predecessor repository was being prepared for deletion — leaving them
"in the predecessor repository's history" would not have survived that. They are readable
history, not current state.

## Related records outside this directory

- `docs/PI_KIT_REPO_PLAN.md` — the original repo-design plan, also superseded.
- `docs/agent-improvement/cycles/` — two complete improvement-cycle records, ported for
  the same reason: they are worked examples of the six-phase evidence layout.
- `reviews/` — the predecessor's full review records.
- `docs/legacy-repo-deletion-readiness.md` — what is accounted for before the predecessor
  repository is deleted, including material that exists only in its git history.
