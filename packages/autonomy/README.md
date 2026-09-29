# pi-autonomy

The supervisor, inference relay and container image for unattended improvement runs of this
repository. It's private (not published) and runs from a checkout of `main`.

See the operator documentation at `docs/autonomy.md`: the boundary, how to set up and run,
the run directory and how to review results.

| File | Role |
|---|---|
| `supervisor.mjs` | CLI and runtime: containers, mirroring, gate, tags, merge into `experimental/main`, manager calls. |
| `relay.mjs` | Inference relay: fixed upstream, path and model allowlist, usage metering. |
| `lib/cycle.mjs` | One cycle's control loop (the runtime is injected, so it's testable offline). |
| `lib/triggers.mjs`, `lib/manager.mjs` | When the manager is asked, and validation of its fixed-choice decision. |
| `lib/rpc.mjs` | pi RPC helpers and the auto-operator for extension dialogs. |
| `lib/gitmirror.mjs`, `lib/mirror.mjs` | Host-side git: the integration branch, fast-forward-only ingest and merge, tags, publish, reset. |
| `lib/review.mjs` | The merge review: one model call, `MERGE` or `REJECT`, fail closed. |
| `lib/docker.mjs` | Container arguments (the boundary, checked by `tests/autonomy-smoke.mjs`). |
| `image/` | Dockerfile, entrypoint (roles agent, bundle, setref, gate), gate script, firewall policy. |
| `prompts/cycle.md`, `seed/` | The cycle prompt, and the charter, backlog and handoff the branch is seeded with. |
| `tests/boundary-probe.mjs` | The in-container boundary probe, run before every start and resume. |

Offline tests: `npm run smoke:autonomy`.
