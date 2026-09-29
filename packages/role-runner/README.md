# pi role runner (WP-070)

The non-interactive `pi run` interface required by TLP2-SPEC 08 §7. The
interactive `packages/container` image is the operator's harness and does **not**
implement this contract; this package is the operate-mode role runner.

## Interface

```
pi run --role <role> --workflow <workflow> \
  --input /inputs/context.json --output /outputs/result.json
```

| Concern | Behaviour |
| --- | --- |
| Config | Role contract, SYSTEM prompt and result schema are read from `--roles-dir` (default `/opt/pi-system/roles`); everything else is env. |
| Credentials | `PI_LITELLM_API_KEY` or `PI_LITELLM_API_KEY_FILE` only. The container entrypoint obtains it from OpenBao Kubernetes auth (TTL 15 m); it is never a workflow parameter. |
| LLM | Only through LiteLLM. Base URL from `PI_LITELLM_BASE_URL` (default `http://litellm.app-ai.svc:4000`, 08 §7); model alias from the contract or `--model`. |
| Untrusted input | Every top-level context key is wrapped in `<<<UNTRUSTED:<run-nonce>:<source>>> … <<<END_UNTRUSTED:<run-nonce>>>`. The nonce is random per run. A deterministic detector flags known injection patterns and forces `escalate: true`. |
| Output | `result.json` validated against the role's closed schema; `metrics.prom` written beside it. |
| Logs | One JSON object per line on stderr (run_id, role, tool/model facts, token counts). |

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Valid result, `escalate: false` |
| 10 | Valid result, `escalate: true` |
| 20 | Invalid input: argv, context JSON, contract, prompt or schema |
| 30 | LiteLLM budget/rate limit (HTTP 429); an escalated result is written |
| 1 | Any other failure; an escalated result is written where possible |

`--stub` (or `PI_RUNNER_STUB=1`) emits a deterministic result without an LLM
call, for AGT-01 stub-LLM workflow runs.

## Files

| Path | Purpose |
| --- | --- |
| `src/args.ts` | `pi run` argument parsing and env fallbacks. |
| `src/contract.ts` | Loads and validates `agent-role.yaml`. |
| `src/yaml-lite.ts` | Dependency-free reader for the contract YAML subset. |
| `src/context.ts` | Untrusted-data delimiters and injection detector. |
| `src/prompt.ts` | SYSTEM + user prompt assembly. |
| `src/llm.ts` | LiteLLM client and JSON extraction. |
| `src/schema.ts` | Closed-schema validator for the result schemas. |
| `src/run.ts` | Orchestration and exit-code policy. |
| `src/telemetry.ts` | Structured logs and Prometheus metrics text. |
| `src/cli.ts` | Wiring of filesystem, clock, RNG and LLM client. |
| `bin/pi.mjs` | `pi` shim installed into the image. |
| `Containerfile` | Multi-stage, non-root, zero-dependency image. |

## Tests

`node tests/role-runner-smoke.mjs` (also `npm run smoke:role-runner`) is fully
offline: it parses all seven contracts with `yaml-lite`, exercises the schema
validator, the untrusted-data wrapper and the injection detector, and runs
`runCli --stub` end to end for every role. It asserts exit codes 0/10/20.

## Known limitations / integration

- `yaml-lite` supports the contract grammar only. Replace it with the `yaml`
  package once the workspace lockfile is regenerated; the loader already
  accepts a JSON contract projection.
- The base image is not pinned or signed. `pi-agents` is pending in
  `versions.lock.yaml`; wire the `images.yml` pipeline (WP-081) before build.
- The runner implements the model-facing contract. Kubernetes RBAC, OpenBao
  policies, GitLab bot users and NetworkPolicies are WP-076; workflows are
  WP-072.
