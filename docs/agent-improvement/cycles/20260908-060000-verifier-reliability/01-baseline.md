# Baseline

Fresh fetch on 2026-09-08 confirms origin/main at 4a7050ffb1912ed02631e7c2b43f98e4994a7165. Detached baseline pi-kit-evaluation-baseline is clean. Existing unmerged candidate 796667168e942395405a5f38aa8bb8b57cbbcad5 is preserved in pi-kit-evaluation; this cycle independently validates and reuses its source fixes rather than claiming new authorship. Integration base 858ecc0 adds only workflow and live harness.

Offline baseline: npm run verify, npm run test:security, npm run eval all pass (13/13 deterministic fixtures). Node v24.14.0, Pi 0.76.0, runtime image sha256:f7e2db957dbcee1dd8668625def48e1721c87dff984fa942a0edc629e0a95294. Provider pentest, qwen3.8-27b-uncensored, openai-responses. Model configuration has no explicit contextWindow/maxTokens override; effective backend defaults are unknown, not inferred. Provider secret stays in host configuration and relay stdin.

Baseline invocation pi-eval-1788850844147 uses the committed harness and focused surface (tool-firewall, secret-guard, trace-ledger, verify-gate, orchestrator, context-sieve). Effective isolation: UID 10001, no capabilities, no-new-privileges, read-only root, no Docker socket, arbitrary relay paths blocked, synthetic target reachable. Existing running pi-agent-v1test container is unrelated and preserved.

