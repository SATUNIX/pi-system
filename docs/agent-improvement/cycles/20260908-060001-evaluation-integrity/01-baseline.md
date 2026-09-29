# Baseline

Cycle: 20260908-060001-evaluation-integrity. Integration base and harness: 858ecc0a1dd085efd61c4372aac75769a5c9738c. Latest merged main resolved by coordinator: 4a7050ffb1912ed02631e7c2b43f98e4994a7165. The integration base bootstraps the existing live harness; this is a measurement improvement, not a new live model competence claim. Worktree started clean on improvement/pi/20260908-060001-evaluation-integrity.

Runtime for deterministic probes: v24.14.0, win32. Model/provider, image digest and token settings: not applicable to offline probes. Existing live runtime is documented by the coordinator; this cycle must obtain a serialized backend slot before live calls. No runtime or production configuration is modified.

Baseline checks: npm ci --ignore-scripts, npm run verify, npm run test:security, npm run eval. Outcomes will be captured under 03-evidence before implementation. Existing live harness source is the evidence baseline.
