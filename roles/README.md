# Operate-mode role contracts (WP-071)

Each directory holds one agent role:

| File | Purpose |
| --- | --- |
| `agent-role.yaml` | Declarative contract (`lab.tcd/v1`, `kind: AgentRole`) validated by CTL-034. |
| `SYSTEM.md` | The reviewed system prompt. Versioned and reviewed like code (H-13). |
| `result.schema.json` | Closed JSON Schema for the `result.json` the role emits. |

The `tools` list is the complete set exposed to the model. Runtime credential
acquisition (OpenBao Kubernetes auth, LiteLLM virtual key, GitLab token) is
separate from the model tool set and is never baked into the contract.

The image reference is deliberately `PENDING_SIGNED_DIGEST`: `pi-agents` is
`pending` in `gitops/versions.lock.yaml`, so no image tag or digest is invented
here. The role runner (`packages/role-runner`) implements the §8.7
`pi run --role … --workflow … --input … --output …` interface; the interactive
`packages/container` image does not.

## CTL-034 validation

`python3 validate.py` performs the offline subset of CTL-034 with PyYAML:

- identity: `kind`, `metadata.name`, service account and OpenBao auth role all
  match the directory name;
- tools: unique, drawn from the registered catalog, and free of `k8s.write*` /
  `secret.*`;
- egress: unique, drawn from the registered destination catalog, and always
  includes `litellm` and `openbao`;
- entry: exactly the §8.7 invocation for the role;
- result schema: parses, is a closed object, and carries the mandatory fields.

`lab-contract validate roles/<role>/agent-role.yaml` is the shared cross-repo
check. CI must additionally render each role's NetworkPolicy from `egress` and
diff it against the cluster manifest (WP-076) before deployment.
