# pi-autonomy

The bounded autonomous task runner for pi-system: a versioned run contract, a run engine with an
explicit lifecycle, templates (`implement`, `deploy`, `self-improve`), a hardened container runtime,
an inference relay and an egress proxy. Private (not published on npm); it ships with the kit's git
delivery and runs from a checkout or from pi's copy of the kit.

Operator documentation, including the boundary, the contract, the lifecycle and what has and has not
been verified, is `docs/autonomy.md`. From inside pi, use `/autonomy` in the `autonomous` profile.

```sh
node packages/autonomy/cli.mjs templates
node packages/autonomy/cli.mjs init --template implement --out run.json --spec "..." --check unit="npm test"
node packages/autonomy/cli.mjs plan --config run.json        # the boundary and its digest
node packages/autonomy/cli.mjs start --config run.json       # confirm the boundary, then run
```

| Path | Role |
|---|---|
| `cli.mjs` | The operator CLI (`pi-autonomy`); every command accepts `--json`. `supervisor.mjs` is the previous entry point, kept as a thin mapping onto it. |
| `lib/contract.mjs`, `schema/run-contract.schema.json` | The run contract: dependency-free validator and the JSON Schema for other tools. |
| `lib/engine.mjs`, `lib/lifecycle.mjs`, `lib/store.mjs`, `lib/runlock.mjs` | The generic engine, the state machine, the persisted run state and the single-owner lock. |
| `lib/boundary.mjs`, `lib/containment.mjs`, `lib/docker.mjs` | The rendered boundary and its digest, the host-side check of every container argument list, and the argument builders. |
| `lib/runtime.mjs`, `lib/egress-proxy.mjs`, `relay.mjs` | The container runtime, the allowlist egress proxy, and the inference relay. |
| `lib/acceptance.mjs`, `lib/check-runner.mjs`, `lib/review.mjs` | Trusted acceptance evaluation in clean, network-less containers, and the independent review. |
| `lib/recovery.mjs`, `lib/reconfigure.mjs`, `lib/promotion.mjs`, `lib/export.mjs` | Bounded recovery, the only way limits change, promotion, and evidence export. |
| `lib/templates/` | `implement`, `deploy` and `self-improve`. |
| `image/`, `build-image.sh` | The image and the script that builds it from local git objects. |
| `examples/` | Working run contracts. |
| `tests/` | The in-container boundary probe (`boundary-probe.mjs`, manual and run before every start), and the fake runtime and upstream the offline suites use. |

Suites: `npm run smoke:autonomy*` (offline), and `npm run smoke:autonomy-container` on a real engine
(it prints `SKIPPED` and exits 0 when there is none).
