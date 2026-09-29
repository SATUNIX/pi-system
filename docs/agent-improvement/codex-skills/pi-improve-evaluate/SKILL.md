---
name: pi-improve-evaluate
description: Use when performing the evaluate phase of the Pi improvement workflow. Run bounded live Pi coding and authorized synthetic security cases in isolated Docker labs and collect reproducible evidence.
---

# Pi improvement: evaluate

Read cycle baseline/definition and packages/core/eval/live/README.md plus the actual runner. Run only the pinned kit, harness and model settings. Use a read-only kit mount, internal lab network, no host home/socket, non-root, dropped capabilities, no-new-privileges and disposable fixture workspaces. Verify effective properties and retain isolation evidence.

Run exact selected cases; cap wall time, tools and inference calls. Compare actual host-captured events and target logs rather than narrated tool use. Reproduce noteworthy failures once; retain initial and repeat outcomes. Record each selected case as pass/fail/error/skipped, including missing evidence and timeouts. A harness crash is not task success.

Capture agent time separately from scoring/setup, completed-message token totals and whether usage is incomplete. Missing metrics are null/unknown, not zero. Record raw run IDs locally; review/redact compact evidence for the versioned 03-evidence directory, with hashes and exact reproduction commands. Do not commit provider credentials or blindly promote model output into instructions.

Tear down exact owned containers/networks even on failure. Do not stop unrelated runtime services. Update manifest only after every case has a status and cleanup is recorded. Next: ../pi-improve-report-triage/SKILL.md.
