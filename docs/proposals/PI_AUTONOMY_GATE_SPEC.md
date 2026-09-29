# Pi Autonomy Gate
## Architecture and Product Specification for Intelligent Tool Authority and Runtime Security

> **Implementation status (2026-09-23).** The deterministic core is implemented in place in
> `tool-firewall`; see [autonomy-gate.md](../autonomy-gate.md). Built: canonical shell actions
> and effects, policy tiers, session trajectory, operator leases, calibrated precedents, and
> evidence cards (roughly phases 1–3 and a light phase 5), plus an in-process judge for medium
> actions. Deferred: the separate `autogated` service and IPC, signed bundles, ONNX models,
> sandboxed and constrained execution, ContextForge/Numbat integration, and exact-diff approval
> binding. The rest of this document is the original proposal and has not been re-reviewed.

**Document status:** Proposed specification  
**Specification version:** 0.1.0  
**Date:** 6 August 2026  
**Working package name:** `@org/pi-autonomy-gate`  
**Working service name:** `autogated`  
**Intended parent distribution:** Pi Kit  
**Primary implementation language:** TypeScript  
**Model interchange format:** ONNX  
**Primary policy/configuration format:** YAML or JSON, validated against versioned JSON Schema  
**Initial integration target:** `@earendil-works/pi-coding-agent`

---

## 1. Executive summary

Pi Autonomy Gate is a security and authority package for Pi agents operating in an intelligent automatic mode.

The system observes every proposed tool action, evaluates it against explicit authority, provenance, information-flow state, deterministic policy, behavioural history, and specialised non-generative machine-learning sensors, then returns one of five outcomes:

1. `ALLOW`
2. `ALLOW_WITH_CONSTRAINTS`
3. `SANDBOX`
4. `REQUIRE_APPROVAL`
5. `DENY`

Its purpose is to:

> Automatically resolve routine cases more consistently than humans, recognise known dangerous trajectories earlier, and present uncertain cases with substantially better evidence than a human would receive from a raw tool-call prompt.

Pi Autonomy Gate is not merely a command classifier and must not be implemented as a single binary BERT model. It is an action firewall and runtime security monitor. Neural networks are advisory semantic and behavioural sensors. Deterministic policy, capability boundaries, execution containment, exact-action approval, and external enforcement remain the authority.

The package is designed for laptops, phones, small edge systems, development workstations, and fleet workers. It avoids dependence on a generative supervisor. It uses compact structured state instead of sending hundreds of thousands of historical tokens through a model.

The preferred deployment has three logical components:

- **Pi extension:** intercepts native Pi and Pi Kit tool calls, normalises actions, presents decisions, and communicates with the gate service.
- **Decision service (`autogated`):** maintains security state, evaluates policy and models, produces signed or integrity-bound decisions, and emits evidence.
- **Execution authority:** applies constraints and executes the exact approved action. Initially, existing ContextForge remains the authoritative MCP authentication, authorisation, approval, permit, and execution gateway. Numbat remains an independent observe/deny/forensics backstop rather than an approval authority.

Pi Autonomy Gate should be developed as a separate repository and installable Pi package. Pi Kit should pin and install it as a dependency or profile component instead of absorbing its implementation. This allows independent security releases, model updates, rollback, and evaluation.

---

## 2. Problem statement

Coding agents are increasingly able to:

- read and modify large codebases;
- execute arbitrary shell commands;
- create and execute programs;
- access credentials and internal services;
- call MCP and custom tools;
- browse untrusted content;
- delegate work;
- operate for long periods with minimal oversight.

Traditional permission prompts expose a human to low-level calls such as:

```text
Allow bash: python scripts/check.py?
```

That prompt usually omits the evidence needed for a meaningful decision:

- who or what created `check.py`;
- whether it was influenced by untrusted content;
- whether its contents are obfuscated;
- what files or devices it may access;
- which network destinations it may contact;
- whether execution is required by the task;
- whether preceding calls form a suspicious trajectory;
- whether the action is reversible;
- what containment options exist.

Humans become fatigued and approve routine-looking actions. A generative guard model has many of the same weaknesses as the primary agent: prompt manipulation, probabilistic reasoning, model confusion, semantic attacks, latency, cost, and potentially adversarial interaction with a more capable model.

The system therefore requires a local, efficient, non-generative safety gate that understands tool actions and action sequences without becoming another conversational agent.

---

## 3. Goals

### 3.1 Primary goals

Pi Autonomy Gate MUST:

1. Intercept every governed tool proposal before execution.
2. Determine whether the proposed effect is within explicit session and task authority.
3. Track provenance and information flow across tool calls, files, processes, network interactions, and derived artefacts.
4. Detect dangerous or suspicious behavioural trajectories, including chains in which individual calls appear benign.
5. Automatically allow low-risk, expected, reversible actions.
6. Automatically constrain or sandbox actions where risk can be contained.
7. Require human approval for consequential, ambiguous, novel, or authority-expanding actions.
8. Deny actions that violate hard policy or cannot be made safe.
9. Produce concise, evidence-based approval cards without requiring a generative explanation.
10. Operate efficiently on normal business laptops and edge-class machines.
11. Continue to provide deterministic protection when machine-learning models are missing, unavailable, or uncertain.
12. Support interactive Pi, print mode, JSON mode, RPC mode, and Pi SDK embedding.
13. Integrate with Pi Kit without requiring a fork of Pi Core.
14. Keep ContextForge authoritative for MCP authentication, authorisation, permits, human approval, and execution during the initial integration.
15. Keep Numbat independent as a detection, deny, telemetry, and forensic backstop.
16. Be observable, auditable, testable, reversible, and safely updateable.
17. Fail safely according to action impact, not through one global fail-open/fail-closed switch.

### 3.2 Secondary goals

The system SHOULD:

- provide useful protection before any learned model is deployed;
- support offline operation;
- permit independent package, policy, and model release cycles;
- support local and centrally managed policy;
- permit fleet telemetry without requiring raw prompt or source-code collection;
- expose a stable adapter API for MCP, CLI tools, native Pi tools, remote tools, and future brokers;
- learn from approval outcomes without automatically weakening policy;
- support active learning and champion/challenger model evaluation;
- provide task-disjoint and tool-disjoint evaluation;
- support model-free low-resource profiles.

### 3.3 Non-goals

The first implementation is NOT intended to:

- prove that an arbitrary agent is aligned;
- understand or validate private chain-of-thought;
- make malicious extensions safe when they run in the same process with full host access;
- replace OS sandboxing, container boundaries, network controls, credential brokers, or endpoint security;
- infer unlimited authority from natural-language user requests;
- guarantee detection of all novel attacks;
- inspect every byte of all files indefinitely;
- replace code review, security testing, or human governance;
- use a generative LLM as the final approval authority;
- modify Pi Core unless a missing extension seam is proven and accepted through a separate upstream contribution.

---

## 4. Foundational design principles

### 4.1 Deterministic authority, probabilistic sensing

Policy and capabilities define what is authorised. Models estimate semantic category, novelty, task alignment, and trajectory risk. A model MUST NOT grant authority that deterministic policy does not already permit.

### 4.2 Effects over intentions

The system evaluates observable and predicted effects, not persuasive reasoning. Agent-provided rationales are untrusted declarations used for comparison.

### 4.3 Authority can only narrow automatically

Natural-language inference, classifiers, and task declarations may reduce authority or increase scrutiny. They MUST NOT silently expand baseline capabilities.

New authority requires one of:

- a pre-approved profile;
- an explicit human permit;
- an authorised external policy decision;
- a signed workload identity and policy binding.

### 4.4 Complete mediation

Every governed tool path must pass through a mediation point. A warning-only extension is insufficient when another tool, extension, subprocess, or MCP route can execute the same effect outside the gate.

### 4.5 Exact-action binding

An approval applies to an exact canonical action or a narrowly defined capability lease. The approved subject, arguments, environment, working directory, input artefacts, policy version, and relevant hashes must be bound to the permit.

### 4.6 Structured security memory

The gate maintains a compact security state and provenance graph. It does not depend on replaying a 500,000-token transcript for each action.

### 4.7 Containment before interruption

Where possible, uncertain but useful actions should run with reduced privileges, restricted mounts, no network, or a dry-run overlay rather than stopping the user.

### 4.8 Calibrated abstention

Unknown or out-of-distribution behaviour must produce abstention or escalation. High confidence is not assumed merely because a classifier emits a large number.

### 4.9 Independent failure modes

Rules, static analysis, provenance, semantic classification, temporal detection, runtime observation, and canary resources should not all depend on the same representation or training data.

### 4.10 Security components are trusted infrastructure

The package, policy, model manifests, decision service, execution broker, and update channel require stronger controls than ordinary agent skills.

---

## 5. Threat model

### 5.1 Protected assets

Protected assets include:

- source code and uncommitted changes;
- credentials, keys, tokens, cookies, and secrets;
- personal and customer data;
- local user files;
- system integrity;
- repository integrity;
- package and build integrity;
- cloud resources;
- internal services;
- tool and MCP credentials;
- approval identities;
- evidence and audit logs;
- model and policy artefacts;
- the authority service itself;
- availability of the workstation or worker.

### 5.2 Adversaries and failure sources

The system considers:

1. **Prompt injection:** malicious instructions in web pages, files, issues, email, tool output, documentation, or repository content.
2. **Compromised or strategically misbehaving primary model:** the model intentionally attempts to bypass controls or conceal intent.
3. **Benign model error:** hallucination, wrong path, over-broad command, accidental deletion, or task drift.
4. **Malicious dependency or generated code:** the agent downloads, creates, modifies, or executes harmful code.
5. **Tool-output manipulation:** a tool or MCP server returns content designed to influence later actions.
6. **Confused deputy:** the agent uses valid authority for an unintended party or purpose.
7. **Approval manipulation:** the agent structures actions or descriptions to induce routine approval.
8. **Sequence attacks:** dangerous outcomes emerge across multiple apparently harmless calls.
9. **Obfuscation:** encoded commands, shell tricks, dynamic execution, homoglyphs, nested interpreters, or indirect payloads.
10. **Data exfiltration:** secret access followed by transformation, staging, or egress.
11. **Persistence:** modifying startup files, scheduled tasks, services, hooks, credentials, or CI workflows.
12. **Privilege expansion:** requesting broader scopes, credentials, sudo, tokens, or network access.
13. **Supply-chain compromise:** tampered Pi package, policy, model, native dependency, or update.
14. **Race and time-of-check/time-of-use attacks:** changing an artefact after approval and before execution.
15. **Concurrent tool calls:** multiple proposals race or observe stale state.
16. **Model evasion:** adversarial examples targeting the specialised classifiers.

### 5.3 Trust assumptions

The initial trusted computing base includes:

- host or container runtime configured by the operator;
- Pi Core version selected by the operator;
- Pi Autonomy Gate package and decision service;
- signed policy and model roots;
- ContextForge for MCP authority and execution;
- Numbat as an independent monitoring and deny layer;
- operating-system enforcement used by the execution broker;
- operator-approved extensions and packages.

### 5.4 Explicit limitations

An in-process Pi extension cannot defend the host from another malicious extension with equal process privileges. Pi packages and extensions can execute arbitrary code with host access. Therefore:

- extension-only mode is suitable for observation, development, and low-assurance local use;
- high-assurance enforcement requires an out-of-process authority and execution boundary;
- Pi must run in a constrained account, container, VM, or worker environment where practical;
- secrets and network access must be mediated outside the model prompt;
- installation of untrusted Pi packages remains prohibited.

A malicious host administrator, compromised kernel, or compromised trusted broker is outside the first-version threat model.

---

## 6. System context

```text
┌─────────────────────────────────────────────────────────────────────┐
│                            User / Operator                          │
└───────────────────────┬─────────────────────────────────────────────┘
                        │ task, permits, approvals
                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                              Pi Agent                               │
│  Primary LLM  ── proposes action ──► Pi Autonomy Gate Extension    │
└──────────────────────────────────────┬──────────────────────────────┘
                                       │ canonical proposal
                                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         autogated service                           │
│ Authority │ Policy │ Provenance │ Static sensors │ ML │ Trajectory │
└───────────────┬───────────────────────────┬─────────────────────────┘
                │ decision / permit         │ evidence / telemetry
                ▼                           ▼
┌───────────────────────────────┐   ┌─────────────────────────────────┐
│ Execution authority          │   │ Audit / Numbat / Evidence       │
│ - ContextForge for MCP       │   │ Independent observe/deny path   │
│ - native tool broker        │   └─────────────────────────────────┘
│ - sandbox executor          │
└───────────────┬───────────────┘
                │ exact constrained execution
                ▼
      Files / Processes / Network / MCP / Cloud
```

---

## 7. Product modes

The package provides explicit operating modes.

### 7.1 `off`

- No interception or telemetry.
- Intended only for controlled troubleshooting.
- Must be visibly indicated.
- May be prohibited by policy.

### 7.2 `observe`

- Records and scores actions.
- Does not alter execution.
- Hard emergency deny rules may optionally remain active.
- Used for baseline collection, integration testing, and false-positive analysis.

### 7.3 `advise`

- Produces decisions and approval cards.
- Existing authority path remains in control.
- No automatic blocking except immutable critical rules.
- Used during staged deployment.

### 7.4 `enforce`

- Applies all decisions.
- Default production mode.
- Low-risk actions may be auto-approved.
- Constraints, sandboxing, approval, and denial are enforced.

### 7.5 `lockdown`

- Only allowlisted, explicitly scoped, and low-risk actions execute.
- Unknown tools and unavailable models/policy services fail closed.
- Intended for high-sensitivity work or incident response.

### 7.6 `intelligent-auto`

`intelligent-auto` is a policy profile layered on `enforce`, not a separate enforcement mechanism. It prioritises automatic resolution and containment while respecting approval budgets and hard boundaries.

---

## 8. Decision outcomes

### 8.1 `ALLOW`

The exact proposed action may execute under current ambient constraints.

### 8.2 `ALLOW_WITH_CONSTRAINTS`

The action may execute only with explicit constraints, such as:

- network allowlist;
- read-only filesystem outside workspace;
- no home-directory access;
- specific environment-variable allowlist;
- no inherited credentials;
- maximum runtime;
- maximum output;
- resource limits;
- destination restrictions;
- command wrapper;
- temporary capability lease.

### 8.3 `SANDBOX`

The action runs in an isolated or counterfactual environment. Results may be inspected before any real-world commit.

Examples:

- overlay filesystem;
- network disabled;
- fake or scoped credentials;
- syscall recording;
- mock MCP endpoint;
- dry-run cloud plan;
- temporary container;
- disposable worktree;
- read-only repository plus output directory.

### 8.4 `REQUIRE_APPROVAL`

Execution pauses until an authorised approver accepts:

- the exact action;
- the proposed constraints;
- a capability lease;
- or a defined action class for a bounded period.

### 8.5 `DENY`

The action violates immutable policy, attempts an uncontainable prohibited effect, uses invalid authority, or cannot be safely evaluated.

---

## 9. High-level architecture

### 9.1 Pi extension adapter

Responsibilities:

- subscribe to Pi lifecycle and tool-call events;
- intercept built-in `read`, `write`, `edit`, and `bash`;
- wrap or register Pi Kit and MCP tool adapters;
- canonicalise proposals;
- attach session, task, tool, and sequence identifiers;
- send proposals to `autogated`;
- apply the returned decision;
- render approval cards and status;
- report post-execution results;
- expose operator commands;
- avoid performing security-sensitive inference in the model prompt.

The Pi extension is a policy enforcement point but not the ultimate trust boundary in high-assurance mode.

### 9.2 Decision service (`autogated`)

Responsibilities:

- maintain session security state;
- compile authority;
- evaluate deterministic policy;
- track provenance and information flow;
- run static feature extraction;
- run compact learned models;
- detect behavioural trajectories;
- calibrate and combine signals;
- create decisions, constraints, and evidence;
- manage approval permits and capability leases;
- expose a local IPC API;
- persist append-only audit records;
- export telemetry.

Recommended transports:

- Unix domain socket on Linux/macOS;
- named pipe on Windows;
- loopback mutually authenticated HTTP only where local sockets are unavailable;
- embedded worker-thread transport for development and low-assurance profiles.

### 9.3 Execution authority

The executor MUST:

- verify the decision or permit;
- confirm the exact action hash;
- apply constraints outside the agent process;
- execute once;
- collect actual effects;
- return a structured result;
- reject replay, expiry, or mutation.

Initial integration:

- ContextForge remains authoritative for MCP authentication, authorisation, scope, permits, human approval, and execution.
- Pi Autonomy Gate supplies risk, provenance, constraints, and recommended decisions to the ContextForge path.
- ContextForge must not accept a looser result than its own policy.
- Numbat independently observes and may deny but does not become the approval authority.

For native Pi tools, a local broker or sandbox wrapper is required for equivalent assurance.

### 9.4 Evidence and telemetry

Evidence includes:

- proposal;
- canonical action;
- authority state;
- relevant provenance path;
- triggered rules;
- model labels and calibrated confidence;
- trajectory state;
- decision;
- approval identity and scope;
- execution constraints;
- actual effects;
- result;
- policy, package, and model versions.

Sensitive payloads should be hashed, redacted, tokenised, or stored locally according to policy.

---

## 10. Authority model

### 10.1 Sources of authority

Authority is the intersection of:

1. **Host baseline:** what this installation may ever do.
2. **Profile authority:** workbench, worker, pentest, repository-maintenance, read-only, and other signed profiles.
3. **Project authority:** repository-local policy accepted through Pi project trust and organisation controls.
4. **Task authority:** explicit task permit or task-scoped restrictions.
5. **Session authority:** temporary operator choices.
6. **Tool authority:** tool-specific scopes and credentials.
7. **Resource authority:** path, destination, account, tenant, repository, or environment scopes.
8. **Dynamic risk constraints:** restrictions introduced by current provenance or trajectory.

The effective authority is the narrowest applicable set.

### 10.2 Task authority compiler

The compiler produces a `TaskAuthority` object.

Inputs may include:

- operator-selected profile;
- current working directory;
- repository identity and remote;
- signed engagement or work-order configuration;
- ContextForge permits;
- explicit `/auto permit` commands;
- user task text;
- agent action declaration;
- organisation policy.

Natural-language task text and agent declarations are untrusted semantic hints. They can:

- classify expected action families;
- narrow paths;
- increase risk when actions diverge;
- suggest an approval card.

They cannot silently grant new capabilities.

### 10.3 Capability representation

Capabilities should be typed and resource-scoped.

```yaml
capabilities:
  - effect: filesystem.read
    resources:
      - "${workspace}/**"
    conditions:
      classification_max: internal

  - effect: filesystem.write
    resources:
      - "${workspace}/**"
    exclusions:
      - "${workspace}/.git/**"

  - effect: process.execute
    resources:
      - "${workspace}/**"
    conditions:
      network: false
      inherited_secrets: false

  - effect: network.connect
    resources:
      - "github.internal:443"
    conditions:
      protocol: https

denies:
  - effect: credential.read
    resources:
      - "${home}/.ssh/**"
      - "${home}/.config/**"

  - effect: persistence.modify
    resources:
      - "**"
```

### 10.4 Capability leases

A capability lease is a bounded permit reducing repeated approvals.

Required fields:

- lease ID;
- approver;
- subject session or workload;
- allowed action class;
- resource scope;
- constraints;
- issue time;
- expiry;
- maximum uses;
- revocation state;
- policy version;
- parent approval;
- signature or message authentication code.

Examples:

- execute Python under `workspace/tests/**` for 15 minutes with no network;
- contact `registry.npmjs.org:443` for one package-install operation;
- modify files under one generated migration directory for the current task;
- run a named MCP tool against one account with read-only scope.

Leases must not be created from a model decision alone when they expand effective authority.

---

## 11. Action normalisation

Every tool proposal must be transformed into a canonical action independent of the original tool name.

### 11.1 Canonical action fields

```typescript
interface CanonicalAction {
  schemaVersion: string;
  actionId: string;
  sessionId: string;
  taskId?: string;
  sequence: number;
  timestamp: string;

  source: {
    adapter: "pi-native" | "pi-kit" | "mcp" | "cli" | "sdk" | "custom";
    toolName: string;
    toolVersion?: string;
    serverId?: string;
  };

  operation: string;
  resources: CanonicalResource[];
  requestedEffects: Effect[];
  argumentsHash: string;
  canonicalArguments: unknown;

  execution: {
    cwd?: string;
    executable?: string;
    argv?: string[];
    environmentNames?: string[];
    timeoutMs?: number;
    networkIntent?: NetworkIntent[];
  };

  declaration?: ActionDeclaration;
  provenanceRefs: string[];
  parentActionIds: string[];
}
```

### 11.2 Action ontology

The ontology is multi-label and extensible.

Core effect families:

- `filesystem.read`
- `filesystem.enumerate`
- `filesystem.create`
- `filesystem.modify`
- `filesystem.delete`
- `process.execute`
- `process.spawn`
- `interpreter.execute`
- `package.install`
- `network.resolve`
- `network.connect`
- `network.listen`
- `credential.read`
- `credential.use`
- `secret.transform`
- `data.archive`
- `data.encode`
- `data.upload`
- `persistence.modify`
- `identity.assume`
- `privilege.elevate`
- `cloud.read`
- `cloud.mutate`
- `repository.commit`
- `repository.push`
- `message.draft`
- `message.send`
- `approval.request`
- `policy.modify`
- `security_control.modify`

Risk labels may overlap. A single action may be:

```text
filesystem.read
credential.read
secret.transform
process.execute
network.connect
```

### 11.3 Tool adapters

Each tool adapter must define:

- input schema;
- canonicalisation function;
- expected effects;
- post-execution effect extractor;
- resource identifiers;
- sensitivity hints;
- containment options;
- default reversibility;
- version compatibility.

Unknown tools default to `REQUIRE_APPROVAL` or `DENY` according to mode, unless a signed adapter supplies sufficient metadata.

---

## 12. Provenance and information-flow model

### 12.1 Provenance graph

The system maintains a directed graph.

Node types:

- user instruction;
- model output;
- tool proposal;
- tool result;
- file;
- file version;
- process;
- network response;
- MCP response;
- secret;
- credential;
- generated artefact;
- approval;
- capability lease;
- policy decision.

Edge types:

- `READ_FROM`
- `WRITTEN_BY`
- `DERIVED_FROM`
- `INFLUENCED_BY`
- `EXECUTED_AS`
- `SENT_TO`
- `RETURNED_BY`
- `APPROVED_BY`
- `AUTHORISED_BY`
- `CONTAINS`
- `TRANSFORMED_INTO`
- `SPAWNED`
- `MODIFIED_BY`

### 12.2 Labels

Confidentiality:

- `PUBLIC`
- `INTERNAL`
- `CONFIDENTIAL`
- `SECRET`
- `CREDENTIAL`

Integrity:

- `TRUSTED`
- `REVIEWED`
- `USER_SUPPLIED`
- `AGENT_GENERATED`
- `UNTRUSTED`
- `DERIVED_FROM_UNTRUSTED`

Execution properties:

- `EXECUTABLE`
- `SCRIPT`
- `BINARY`
- `OBFUSCATED`
- `NETWORK_CAPABLE`
- `PERSISTENT`
- `PRIVILEGED`
- `SIGNED`
- `REVIEWED`

Origin:

- user;
- trusted repository;
- untrusted repository;
- web;
- email;
- chat;
- MCP server;
- package registry;
- agent;
- other agent;
- downloaded binary;
- unknown.

### 12.3 Label propagation

Default propagation is conservative.

Examples:

- a file generated from untrusted web content inherits `DERIVED_FROM_UNTRUSTED`;
- a compressed secret remains `SECRET`;
- base64 encoding does not lower confidentiality;
- a reviewed artefact may gain `REVIEWED` but retains origin;
- copying a credential into a new file retains `CREDENTIAL`;
- executing an untrusted script links resulting processes and outputs to the script provenance.

Policies may define sanitisation functions. A transformation may remove a label only when a trusted, testable sanitiser is explicitly registered.

### 12.4 Bounded storage

The gate stores:

- full structured records for recent events;
- hashes and metadata for large content;
- a configurable raw-call ring buffer;
- provenance graph references;
- summarised counters;
- compact trajectory state.

It does not retain arbitrary raw prompts by default.

---

## 13. Sensor and decision pipeline

```text
Canonical action
      │
      ├─► Authority check
      ├─► Hard policy
      ├─► Provenance / information flow
      ├─► Static and byte-level sensors
      ├─► Semantic multi-label classifier
      ├─► Temporal / graph trajectory detector
      ├─► Novelty and OOD detector
      ├─► Impact / blast-radius estimator
      └─► Calibration and decision combiner
                  │
                  ▼
     allow / constrain / sandbox / approve / deny
```

### 13.1 Stage 0: authority checks

Questions:

- Is the requested effect in effective authority?
- Is the resource in scope?
- Is the credential allowed?
- Is the destination allowed?
- Is the tool known?
- Is a valid lease present?
- Does the request expand privilege?
- Is the permit current and unrevoked?

An authority violation cannot be overridden by a benign model score.

### 13.2 Stage 1: hard policy

Examples:

- deny secrets to unapproved external destinations;
- deny modification of gate policy by an ordinary agent;
- deny disabling audit;
- deny direct execution of unsigned downloaded binaries;
- require sandbox for agent-created executables influenced by untrusted input;
- require approval for persistence;
- restrict repository push to approved remotes;
- deny broad home-directory reads from repository tasks;
- deny use of approval tokens as tool input.

### 13.3 Stage 2: static sensors

Static sensors include:

- path classification;
- command tokenisation and shell AST;
- interpreter nesting;
- dangerous flags;
- environment-variable references;
- entropy;
- base64 and other encoding;
- homoglyph and Unicode anomalies;
- dynamic evaluation;
- process substitution;
- redirection;
- archive creation;
- credential path detection;
- persistence path detection;
- package lifecycle scripts;
- executable file headers;
- code-signing state;
- dependency metadata;
- destination novelty;
- diff size and protected-file touches.

A character- or byte-level classifier may supplement deterministic detectors for obfuscation.

### 13.4 Stage 3: semantic multi-label model

The semantic model receives a bounded representation:

- task category embedding;
- canonical operation;
- normalised arguments or selected text fields;
- tool metadata;
- resource labels;
- short causal history;
- static feature vector;
- declared purpose;
- observed/declaration discrepancy.

Outputs may include:

- credential access;
- discovery;
- obfuscation;
- download-and-execute;
- defence evasion;
- persistence;
- privilege expansion;
- external communication;
- destructive action;
- task deviation;
- suspicious interpreter use;
- data staging;
- exfiltration preparation;
- benign build/test;
- benign source modification;
- benign package operation.

This is multi-label, not ordinary multiclass classification.

### 13.5 Stage 4: trajectory detector

The trajectory detector evaluates action sequences and causal paths.

Example high-risk trajectories:

```text
untrusted input
  → generated script
  → executable permission
  → secret read
  → archive/encode
  → new external destination
```

```text
repository inspection
  → CI workflow modification
  → credential reference
  → push to remote
```

```text
system discovery
  → persistence path write
  → service enable
```

Candidate implementations, in increasing complexity:

1. finite-state and temporal rules;
2. Hidden Markov Model;
3. gradient-boosted model over rolling state;
4. temporal convolution or compact recurrent network;
5. graph model over provenance and action edges.

The initial implementation should benchmark simple methods before adopting a graph neural network.

### 13.6 Stage 5: novelty and OOD detection

Inputs:

- distance from known action embeddings;
- unseen tool or argument shape;
- unseen trajectory;
- disagreement between models;
- confidence calibration;
- policy/model version mismatch;
- missing expected features;
- unusually large or complex proposal.

Outputs:

- in-distribution;
- weakly novel;
- materially novel;
- unsupported.

Novel high-impact actions escalate.

### 13.7 Stage 6: impact and blast radius

Risk dimensions:

- confidentiality impact;
- integrity impact;
- availability impact;
- privilege level;
- destination trust;
- data sensitivity;
- reversibility;
- affected resource count;
- account or tenant scope;
- persistence;
- propagation potential;
- time sensitivity.

### 13.8 Stage 7: decision combination

A recommended conceptual score is:

```text
risk = calibrated_violation_probability
       × impact
       × exposure
       × uncertainty_multiplier
       × trajectory_multiplier
```

The implementation should retain dimensions rather than reducing everything to one opaque number.

Policy maps the dimensions to outcomes.

Example:

```yaml
decision_rules:
  - when:
      hard_policy_violation: true
    outcome: DENY

  - when:
      authority_violation: true
    outcome: DENY

  - when:
      impact: critical
      uncertainty_gte: 0.25
    outcome: REQUIRE_APPROVAL

  - when:
      semantic_labels:
        - agent_generated_executable
        - untrusted_influence
    outcome: SANDBOX

  - when:
      risk_lt: 0.10
      reversible: true
      in_scope: true
    outcome: ALLOW
```

---

## 14. Model architecture and lifecycle

### 14.1 Model requirements

Models MUST be:

- non-generative;
- bounded-input;
- deterministic under fixed runtime settings where possible;
- quantisable;
- exportable to ONNX;
- independently versioned;
- cryptographically hashed;
- signed or covered by a signed manifest;
- benchmarked on target hardware;
- calibrated;
- tested on unseen tasks and tools;
- safely replaceable with deterministic fallback.

### 14.2 Recommended initial models

#### Model A: semantic encoder and multi-label heads

A compact transformer encoder or sentence encoder with multi-label classification heads.

Purpose:

- classify action semantics;
- estimate task alignment;
- detect suspicious combinations in textual arguments.

Target:

- INT8 ONNX;
- tens of megabytes or less where practical;
- CPU inference in the low-millisecond range on a normal laptop;
- bounded input, normally 256–1,024 tokens rather than whole-session context.

#### Model B: byte/character obfuscation detector

Purpose:

- encoded or obfuscated shell;
- suspicious escape patterns;
- binary/text anomalies;
- mixed scripts and homoglyphs;
- nested interpreters.

Target:

- character CNN, byte CNN, or compact transformer;
- sub-millisecond to low-millisecond inference.

#### Model C: tabular risk model

Inputs:

- static features;
- provenance counters;
- authority features;
- impact estimates;
- semantic outputs;
- novelty;
- sequence features.

Candidate:

- gradient-boosted trees exported to ONNX;
- small MLP;
- logistic multi-head baseline.

#### Model D: trajectory model

Deferred until representative traces exist.

Candidate:

- HMM;
- temporal model;
- graph model.

### 14.3 No chain-of-thought dependency

The gate must not require hidden chain-of-thought.

It may consume a typed declaration:

```json
{
  "goalStep": "Run generated migration validation",
  "expectedEffects": ["filesystem.read", "process.execute"],
  "expectedOutputs": ["test report"],
  "requiredCapabilities": ["workspace.read", "workspace.execute"]
}
```

The declaration is untrusted and is compared with observed effects.

### 14.4 Model manifest

```yaml
schema_version: "1"
bundle_id: "pi-autonomy-models-edge"
bundle_version: "0.3.1"
created_at: "2026-08-06T00:00:00Z"

compatibility:
  gate_api: ">=0.1 <0.2"
  feature_schema: "3"
  ontology: "2"

models:
  semantic:
    file: "semantic-int8.onnx"
    sha256: "..."
    input_schema: "semantic-input-v2"
    output_schema: "semantic-labels-v2"
    calibration: "semantic-calibration.json"

  obfuscation:
    file: "obfuscation-int8.onnx"
    sha256: "..."

  risk:
    file: "risk-xgb.onnx"
    sha256: "..."

thresholds:
  profile: "edge-default"
  file: "thresholds-edge-default.json"

evaluation:
  report: "evaluation.json"
  dataset_manifest: "dataset-manifest.json"

signature:
  mechanism: "sigstore"
  bundle: "bundle.sigstore.json"
```

### 14.5 Model distribution

Production weights should not be committed as ordinary Git objects.

Git contains:

- manifests;
- source code;
- training code;
- feature and label schemas;
- tiny synthetic fixtures;
- small golden models only where required for tests;
- hashes and signatures;
- evaluation summaries.

Production model bundles should be distributed as one of:

1. signed OCI artefacts in a private registry;
2. signed release blobs;
3. an internal object store with content-addressed paths and signed manifests;
4. an OCI layout included in an immutable worker image for offline deployment.

Preferred mechanism:

```text
registry.example/security/pi-autonomy-models@sha256:<digest>
```

The installer:

1. resolves a pinned digest;
2. downloads to a temporary path;
3. verifies digest and signature;
4. validates manifest compatibility;
5. atomically moves the bundle into the cache;
6. retains the previous known-good version;
7. records the active bundle in the audit log.

### 14.6 Model cache

Suggested paths:

```text
~/.pi/agent/autonomy-gate/models/<bundle-digest>/
.pi/autonomy-gate/models/                 # only when project-local use is explicitly allowed
```

Fleet workers may use:

```text
/var/lib/pi-autonomy-gate/models/<digest>/
```

The cache must not be writable by the agent workload in high-assurance deployments.

### 14.7 Update policy

Package, policy, and model updates are separate:

- package version controls code and protocol;
- policy bundle controls rules and thresholds;
- model bundle controls learned sensors.

Automatic updates must not move unpinned digests in production profiles. A promotion process moves a profile lock from one tested digest to another.

---

## 15. Pi package design

### 15.1 Recommended repository

```text
pi-autonomy-gate/
├── package.json
├── package-lock.json
├── tsconfig.json
├── README.md
├── LICENSE
├── CHANGELOG.md
├── SECURITY.md
├── SPEC.md
├── extensions/
│   └── index.ts
├── src/
│   ├── extension/
│   │   ├── register.ts
│   │   ├── native-tools.ts
│   │   ├── approval-ui.ts
│   │   ├── commands.ts
│   │   └── lifecycle.ts
│   ├── client/
│   │   ├── gate-client.ts
│   │   ├── socket-transport.ts
│   │   └── embedded-transport.ts
│   ├── canonical/
│   │   ├── action.ts
│   │   ├── resources.ts
│   │   └── adapters/
│   ├── decision/
│   ├── policy/
│   ├── provenance/
│   ├── telemetry/
│   ├── config/
│   └── schemas/
├── daemon/
│   ├── main.ts
│   ├── server.ts
│   ├── state/
│   ├── inference/
│   ├── approvals/
│   └── executor-adapters/
├── policies/
│   ├── default/
│   ├── observe/
│   ├── workstation/
│   ├── worker/
│   └── lockdown/
├── schemas/
├── models/
│   ├── manifest.example.yaml
│   └── README.md
├── training/
│   ├── README.md
│   ├── pyproject.toml
│   ├── features/
│   ├── datasets/
│   ├── train/
│   ├── export/
│   └── evaluate/
├── test/
│   ├── unit/
│   ├── integration/
│   ├── adversarial/
│   ├── golden-traces/
│   └── performance/
├── scripts/
├── docs/
│   ├── threat-model.md
│   ├── policy-authoring.md
│   ├── model-release.md
│   ├── pi-kit-integration.md
│   └── operations.md
└── .github/
    └── workflows/
```

The published npm package should exclude training datasets, large model files, and development-only outputs.

### 15.2 Pi manifest

Example:

```json
{
  "name": "@org/pi-autonomy-gate",
  "version": "0.1.0",
  "description": "Authority, provenance, information-flow and behavioural security gate for Pi tool execution",
  "keywords": [
    "pi-package",
    "pi-extension",
    "agent-security",
    "tool-authorization"
  ],
  "type": "module",
  "pi": {
    "extensions": ["./extensions/index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-agent-core": "*",
    "@earendil-works/pi-ai": "*",
    "typebox": "*"
  },
  "dependencies": {
    "onnxruntime-node": "<pinned-compatible-range>",
    "yaml": "<pinned-compatible-range>"
  }
}
```

Runtime dependencies must be in `dependencies`, not only `devDependencies`, because Pi package installation uses production dependency installation.

### 15.3 Installation

Development:

```bash
pi install ./pi-autonomy-gate
```

Pinned Git package:

```bash
pi install git:github.com/ORG/pi-autonomy-gate@<signed-tag-or-commit>
```

Private npm:

```bash
pi install npm:@org/pi-autonomy-gate@0.1.0
```

Project-local installation is permitted only where project trust and organisation policy allow it:

```bash
pi install -l npm:@org/pi-autonomy-gate@0.1.0
```

For a security gate, global or immutable profile installation is preferred over project-local installation, because an untrusted repository should not select or modify its own guard.

### 15.4 Pi Kit dependency strategy

Preferred strategy:

- Pi Autonomy Gate remains an independent package.
- Pi Kit profile manifests pin its exact package version or Git commit.
- Pi Kit does not copy the source into its own tree.
- Pi Kit records the package, policy, and model digests in its immutable distribution lock.
- Security updates can be promoted independently.

Two supported distribution patterns:

#### Pattern A: explicit co-installation — preferred

Pi Kit installer or profile manager installs:

```text
pi-kit
pi-autonomy-gate
approved model bundle
approved policy bundle
```

Advantages:

- independent updates;
- clear ownership;
- smaller trust boundary;
- easier rollback;
- no duplicate package discovery.

#### Pattern B: bundled Pi Kit distribution

Pi Kit includes the gate under `dependencies` and `bundledDependencies`, and explicitly references the extension resource under `node_modules`.

Use only for immutable, tested release artefacts. Avoid floating nested versions.

### 15.5 Extension commands

Recommended commands:

```text
/auto status
/auto mode <off|observe|advise|enforce|lockdown>
/auto explain <action-id>
/auto approvals
/auto permit
/auto revoke <lease-id>
/auto trace [n]
/auto policy
/auto models
/auto health
/auto export-evidence
```

Commands that weaken enforcement must require policy permission and create audit records.

### 15.6 Pi lifecycle hooks

The implementation should use current Pi extension APIs rather than patching Pi Core.

Required event handling:

- session start and end;
- agent start and end;
- `tool_call` interception;
- tool result or message events for post-execution evidence;
- compaction events only for correlation, not security-state persistence;
- working-directory/session changes;
- project trust decisions;
- extension reload.

`tool_call` handlers can return a blocking decision before execution. The gate must maintain its own monotonic action ledger rather than reconstructing security state only from the current Pi transcript.

### 15.7 Multi-tool call correctness

Multiple tool calls may be emitted in one assistant response. The gate must:

- assign sequence numbers at interception;
- serialise state updates that influence later decisions;
- avoid assuming Pi session messages already contain the prior tool result;
- cancel or block remaining related calls when a batch is invalidated;
- use exact action IDs and parent batch IDs;
- test parallel and sequential execution paths;
- treat stale-state detection as a security error.

High-impact actions in one batch should be evaluated in order or as an atomic action set.

---

## 16. MCP and Pi Kit integration

### 16.1 Initial authority placement

The initial architecture must preserve:

```text
Pi agent
  → Pi Autonomy Gate risk/authority pre-decision
  → Pi Kit MCP adapter
  → ContextForge authoritative policy/approval/permit/execution
  → MCP server
  → Numbat independent observation/deny/forensics
```

Pi Autonomy Gate may recommend `ALLOW`, but ContextForge may still deny or require approval. A stricter downstream decision wins.

### 16.2 Required Pi Kit repository inspection

Before implementation, the Pi Kit development team must inspect:

- where MCP tools are discovered;
- where tools are registered with Pi;
- how metadata is normalised;
- where current authority and approval decisions occur;
- how action cards are generated;
- how permits are bound to exact actions;
- how ContextForge is called;
- where Numbat receives events;
- how native Pi tools are wrapped;
- how session and task IDs are generated;
- how profiles and distribution locks are represented;
- how telemetry and evidence are stored;
- how policy configuration is loaded;
- whether tool calls can bypass the MCP adapter.

The team must produce an Architecture Decision Record before moving authority.

### 16.3 Adapter interface

```typescript
interface ToolSecurityAdapter {
  adapterId: string;
  supports(tool: ToolDescriptor): boolean;
  canonicalize(input: ToolProposal): Promise<CanonicalAction>;
  inferEffects(action: CanonicalAction): Promise<EffectEstimate>;
  containmentOptions(action: CanonicalAction): Promise<ConstraintSet[]>;
  extractObservedEffects(result: ToolExecutionResult): Promise<ObservedEffect[]>;
}
```

### 16.4 ContextForge contract

```typescript
interface ContextForgeRiskContext {
  action: CanonicalAction;
  gateDecision: GateDecision;
  authority: EffectiveAuthoritySummary;
  provenance: ProvenanceSummary;
  risk: RiskSummary;
  constraints: ConstraintSet;
  evidenceRefs: string[];
  policyVersions: VersionSet;
}
```

ContextForge returns its authoritative result:

```typescript
interface ContextForgeDecision {
  outcome: "ALLOW" | "REQUIRE_APPROVAL" | "DENY";
  permit?: ExactActionPermit;
  constraints?: ConstraintSet;
  reasonCodes: string[];
}
```

The final outcome is the strictest compatible combination.

### 16.5 Transition guidance

Do not immediately remove Pi Kit’s current MCP authority logic.

Recommended transition:

1. map existing decisions and events;
2. run Autonomy Gate in `observe`;
3. compare outcomes;
4. centralise canonical action schemas;
5. let Autonomy Gate own risk and provenance;
6. keep ContextForge authoritative;
7. remove duplicated Pi Kit heuristics only after parity and rollback tests;
8. reconsider architecture only through an explicit ADR and threat-model update.

---

## 17. Native tool enforcement

### 17.1 `read`

Controls:

- canonicalise and resolve paths;
- reject traversal and symlink escape;
- classify target;
- enforce byte and file-count limits;
- record content classification and provenance;
- redact or block credentials;
- distinguish metadata read from content read.

### 17.2 `write` and `edit`

Controls:

- calculate target and content hashes;
- inspect full proposed diff;
- detect protected paths and persistence;
- classify generated executable content;
- preserve old and new file versions in provenance;
- bind approval to the exact proposed diff;
- use atomic write where possible;
- verify post-write hash.

### 17.3 `bash`

`bash` is a broad execution capability and requires deeper mediation.

Controls:

- parse shell where possible;
- detect nested interpreters and dynamic evaluation;
- canonicalise executable, argv, cwd, redirections, and environment names;
- classify network and filesystem intent;
- restrict inherited environment;
- wrap execution in the broker;
- record process tree;
- enforce timeout and resource limits;
- capture destination attempts;
- detect undeclared effects;
- avoid approval based only on a display string.

Complex shell that cannot be parsed reliably should be sandboxed or escalated.

### 17.4 Tool override option

Pi permits overriding built-in tools. A high-assurance implementation may replace built-ins with brokered equivalents to obtain full pre- and post-execution control.

The extension hook remains valuable for universal interception, but tool overrides or an external runner may be required for:

- precise diffs;
- environment control;
- process tree capture;
- syscall or network observation;
- exact constraint enforcement.

---

## 18. Approval system

### 18.1 Approval card

A human approval card must contain:

- requested outcome;
- concise technique/category;
- exact resource;
- declared purpose;
- observed evidence;
- why the action is outside routine authority;
- impact and reversibility;
- confidence and uncertainty;
- triggered policies;
- relevant causal chain;
- proposed containment;
- scope of the approval;
- expiry and use count if a lease is offered.

Example:

```text
APPROVAL REQUIRED — Generated executable with credential and network access

Action
  Execute: /workspace/scripts/check.py

Evidence
  • Created by the agent 18 minutes ago
  • Derived from untrusted web content
  • Reads ~/.ssh and environment variables
  • Contains encoded strings and dynamic execution
  • Requests a new external destination
  • These effects are outside the declared repository-test task

Impact
  Confidentiality: Critical
  Integrity: Medium
  Reversibility: Low
  Model confidence: 0.91
  Novelty: Moderate

Recommended action
  Run in a network-disabled sandbox without home-directory mounts

Choices
  [Run contained once] [Approve exact action] [Deny] [Abort session]
```

The text should be template-generated from structured evidence.

### 18.2 Approval scopes

Choices may include:

- exact action once;
- action under proposed constraints once;
- bounded capability lease;
- deny this action;
- deny action class for session;
- abort current run.

Broad “always allow this tool” approvals should be prohibited or heavily restricted.

### 18.3 Non-interactive operation

In print, JSON, RPC, CI, or headless mode:

- no local UI means approval cannot be silently assumed;
- the decision is routed to ContextForge or a configured approval service;
- if no approval route exists, the action is denied or sandboxed according to policy;
- pending approvals have expiry;
- the agent receives a stable, non-sensitive reason.

### 18.4 Approval integrity

Approval must bind:

- action hash;
- artefact hashes;
- environment constraints;
- working directory;
- resource scopes;
- model and policy version;
- expiry;
- session/workload identity;
- approver identity.

The executor must reject mismatch.

---

## 19. Policy system

### 19.1 Policy layers

1. immutable organisation rules;
2. host profile;
3. Pi Kit distribution profile;
4. project policy;
5. task policy;
6. session permits;
7. dynamic constraints.

Lower layers can narrow but cannot override immutable higher-layer denies.

### 19.2 Policy engine choice

MVP options:

- custom typed policy evaluator with JSON/YAML rules;
- embedded OPA/Rego;
- compiled OPA WebAssembly;
- Cedar-style policy engine.

The implementation should prefer a small, auditable policy core. Learned models must not be embedded inside policy syntax.

### 19.3 Example policy

```yaml
schema_version: "1"

defaults:
  unknown_tool: REQUIRE_APPROVAL
  model_unavailable_low_impact: ALLOW_WITH_CONSTRAINTS
  model_unavailable_high_impact: REQUIRE_APPROVAL
  authority_service_unavailable_high_impact: DENY

rules:
  - id: AG-DENY-001
    description: Prevent secret egress
    when:
      any_labels: [SECRET, CREDENTIAL]
      effects: [network.connect, data.upload]
      destination_trust_not_in: [internal-approved]
    outcome: DENY

  - id: AG-SBX-001
    description: Contain untrusted generated executables
    when:
      effects: [process.execute]
      provenance_all:
        - AGENT_GENERATED
        - DERIVED_FROM_UNTRUSTED
    outcome: SANDBOX
    constraints:
      network: deny
      home_mount: none
      secrets: none

  - id: AG-APR-001
    description: Approve persistence explicitly
    when:
      effects: [persistence.modify]
    outcome: REQUIRE_APPROVAL

  - id: AG-ALLOW-001
    description: Routine workspace read
    when:
      effects: [filesystem.read]
      resources_within: ["${workspace}/**"]
      max_classification: INTERNAL
      trajectory_risk_lt: 0.10
    outcome: ALLOW
```

### 19.4 Policy testing

Every policy bundle must include:

- positive tests;
- negative tests;
- conflict tests;
- performance tests;
- migration tests;
- expected outcome snapshots.

---

## 20. State and persistence

### 20.1 Session state

```typescript
interface SessionSecurityState {
  sessionId: string;
  mode: GateMode;
  taskAuthority: TaskAuthority;
  sequence: number;
  currentRiskBudget: number;
  trajectoryState: string[];
  activeLeases: CapabilityLease[];
  recentActions: ActionSummary[];
  provenanceRootIds: string[];
  modelVersions: VersionSet;
  policyVersions: VersionSet;
}
```

### 20.2 Storage

MVP:

- SQLite with append-only logical event tables;
- content hashes for integrity;
- local file lock;
- WAL mode where appropriate;
- bounded retention.

High-assurance:

- separate daemon-owned database;
- append-only evidence export;
- optional remote immutable storage;
- signed checkpoints or hash chain.

### 20.3 Compaction independence

Pi context compaction must not delete or summarise security state. The gate’s state lives outside the LLM context and Pi message summary.

A compact, non-sensitive security summary may be injected into agent context when useful, but it is not authoritative.

---

## 21. Risk budget and behavioural controls

### 21.1 Risk budget

A task may carry a risk budget.

Illustrative weights:

```yaml
filesystem.read_workspace: 0
filesystem.modify_workspace: 1
execute_reviewed_repo_code: 1
execute_agent_generated_code: 3
access_internal_secret: 5
new_external_destination: 6
modify_persistence: 10
privilege_elevation: 10
```

The budget is not a substitute for hard policy. It increases containment or escalation as risky actions accumulate.

### 21.2 Behavioural discrepancy

Track differences between:

- declared purpose and observed effects;
- task category and action family;
- expected destination and actual destination;
- predicted files and actual files;
- approved command and executed process tree.

Large discrepancy is a first-class signal.

### 21.3 Honey capabilities

Optional decoys:

- fake SSH key;
- fake browser-token file;
- synthetic API credential;
- decoy admin tool;
- canary file;
- canary MCP resource.

A legitimate task should not access them. Access triggers a high-severity event and may terminate the session.

Canaries must never resemble real credentials in a way that creates operational confusion.

---

## 22. Counterfactual and sandbox execution

### 22.1 Counterfactual flow

```text
proposal
  → decision: SANDBOX
  → disposable execution environment
  → observe attempted effects
  → compare declaration and policy
  → permit safe real execution, request approval, or deny
```

### 22.2 Collected evidence

- filesystem diff;
- process tree;
- attempted network destinations;
- requested devices;
- credential access attempts;
- environment-variable access;
- syscalls where available;
- exit status;
- generated outputs;
- persistence attempts;
- resource use.

### 22.3 Platform implementations

Linux:

- containers, namespaces, seccomp, AppArmor/SELinux, Landlock, bubblewrap, or equivalent.

macOS:

- sandboxed helper, VM/container, constrained user, network filters.

Windows:

- AppContainer, Windows Sandbox, job objects, restricted token, WSL/container, firewall rules.

The specification does not mandate one sandbox technology. The executor adapter reports its available guarantees.

---

## 23. Configuration

Suggested global configuration:

```yaml
schema_version: "1"

mode: enforce
profile: workstation

service:
  transport: unix
  socket: "~/.pi/agent/autonomy-gate/gate.sock"
  startup: managed
  request_timeout_ms: 75

models:
  bundle: "oci://registry.example/security/pi-autonomy-models@sha256:..."
  cache: "~/.pi/agent/autonomy-gate/models"
  verify_signature: true
  offline: allowed
  fallback: deterministic

policy:
  bundles:
    - "/etc/pi-autonomy-gate/org-policy"
    - "~/.pi/agent/autonomy-gate/policy"
  project_policy: narrow-only

approvals:
  interactive: true
  remote_provider: contextforge
  default_expiry_seconds: 300
  max_lease_seconds: 900

telemetry:
  local_audit: true
  export: otlp
  redact_content: true
  include_embeddings: false

failures:
  low_impact_timeout: constrain
  high_impact_timeout: deny
  unknown_tool: approval

performance:
  max_recent_actions: 128
  max_raw_argument_bytes: 65536
  semantic_max_tokens: 512
  inference_threads: 2
```

Project-local policy must not be able to weaken organisation policy.

---

## 24. IPC protocol

### 24.1 Proposal request

```json
{
  "protocolVersion": "1",
  "requestId": "req-...",
  "type": "action.evaluate",
  "action": {},
  "sessionStateHint": {},
  "deadlineMs": 75
}
```

### 24.2 Decision response

```json
{
  "protocolVersion": "1",
  "requestId": "req-...",
  "decisionId": "dec-...",
  "outcome": "SANDBOX",
  "reasonCodes": [
    "AGENT_GENERATED_EXECUTABLE",
    "UNTRUSTED_PROVENANCE",
    "TASK_EFFECT_MISMATCH"
  ],
  "constraints": {
    "network": "deny",
    "homeMount": "none",
    "secretAccess": "deny",
    "timeoutMs": 30000
  },
  "risk": {
    "violationProbability": 0.64,
    "impact": "high",
    "uncertainty": 0.21,
    "trajectory": "medium"
  },
  "evidenceRefs": ["ev-1", "ev-2"],
  "permit": {
    "actionHash": "sha256:...",
    "expiresAt": "..."
  }
}
```

### 24.3 Post-execution report

```json
{
  "type": "action.result",
  "decisionId": "dec-...",
  "actionHash": "sha256:...",
  "result": {
    "status": "success",
    "exitCode": 0
  },
  "observedEffects": [],
  "artefacts": [],
  "violations": []
}
```

---

## 25. Performance requirements

Target profiles:

### 25.1 Edge profile

- CPU-only;
- 2–4 inference threads maximum;
- memory target below 250 MB for daemon plus models;
- deterministic-only mode below 75 MB where practical;
- median decision latency under 15 ms for routine actions;
- p95 under 50 ms;
- p99 under 100 ms;
- no network dependency for routine decisions;
- model bundle target below 100 MB, with a smaller profile preferred.

### 25.2 Workstation profile

- median under 10 ms;
- p95 under 30 ms;
- optional richer trajectory model;
- memory below 500 MB;
- concurrent sessions supported.

### 25.3 Fleet worker profile

- predictable fixed memory;
- no interactive dependency;
- central policy and approval route;
- immutable model cache;
- fail-safe high-impact behaviour;
- OpenTelemetry export;
- throughput benchmarked against expected parallel Pi workers.

These are engineering targets, not security guarantees, and must be validated on the actual hardware.

---

## 26. Reliability and failure behaviour

### 26.1 Service unavailable

- low-impact, reversible, in-scope reads may use deterministic local fallback;
- writes use constraints or approval according to profile;
- high-impact, secret, network, persistence, privilege, or external mutation actions deny;
- every fallback creates an event;
- repeated failure may move the session to lockdown.

### 26.2 Model unavailable

- deterministic policy, authority, provenance, and static detection continue;
- unknown high-impact actions require approval or deny;
- the UI clearly reports degraded sensing;
- package must not silently treat missing model output as zero risk.

### 26.3 Policy invalid

- retain last known-good policy;
- reject incompatible policy;
- report validation failure;
- do not continue with an empty policy.

### 26.4 State corruption

- stop relying on affected session state;
- enter lockdown or require a fresh session;
- preserve forensic copy;
- restore from verified checkpoint where available.

### 26.5 Timeout

Timeout behaviour is action-class-specific. It is not globally fail-open.

---

## 27. Security of the gate itself

### 27.1 Process isolation

High-assurance deployment:

- daemon runs as a separate identity;
- model and policy directories are not writable by Pi;
- socket access is limited to approved Pi processes;
- executor validates workload identity;
- logs are protected from agent modification;
- daemon has minimal network access.

### 27.2 Tamper protection

- package version pinned;
- policy/model digest pinned;
- signature verification;
- append-only audit;
- self-health checks;
- process liveness monitoring;
- deny modification of gate paths;
- alert on extension disable/reload;
- environment variables carrying bypass flags prohibited in production.

### 27.3 Supply chain

Release artefacts should include:

- software bill of materials;
- dependency scan;
- reproducible or attestable build information;
- signed npm package or release;
- signed model and policy artefacts;
- provenance attestation;
- exact dependency locks;
- rollback artefacts.

### 27.4 Secret handling

- models never receive raw secrets unless specifically required by a classifier, which should be avoided;
- feature extractors replace secret values with type and metadata;
- approval cards redact values;
- telemetry omits raw values;
- the gate should receive secret labels from the broker where possible.

---

## 28. Data, training, and evaluation

### 28.1 Dataset sources

- synthetic benign coding tasks;
- real consented Pi traces with sensitive content removed;
- red-team scenarios;
- prompt-injection scenarios;
- malicious repository fixtures;
- generated-code execution scenarios;
- MCP sequence attacks;
- obfuscated shell samples;
- accidental destructive commands;
- benign package install/build/test flows;
- adversarial filler and reordered calls;
- tool and task novelty sets.

### 28.2 Labels

Labels must cover:

- action effects;
- data classifications;
- provenance;
- technique;
- intent alignment;
- impact;
- reversibility;
- policy outcome;
- trajectory stage;
- novelty;
- containment effectiveness.

### 28.3 Evaluation splits

Required:

- task-disjoint;
- repository-disjoint;
- tool-disjoint;
- time-disjoint;
- model-family-disjoint where primary-agent traces are used;
- attack-family holdout;
- obfuscation holdout;
- environment holdout.

Random call-level splits are insufficient.

### 28.4 Metrics

Primary metrics:

- critical dangerous auto-approval rate;
- high-risk false-allow rate;
- attack-chain recall before harmful effect;
- time or calls to detection;
- approvals per completed task;
- approvals per 1,000 calls;
- false denial rate;
- containment success;
- calibration error;
- OOD abstention accuracy;
- unseen-tool performance;
- unseen-task performance;
- latency and memory.

Metrics must be segmented by impact and action family.

### 28.5 Approval budget

A release must state its operating point, for example:

```text
Target:
  critical dangerous auto-approval rate: below defined release threshold
  approvals per normal repository task: below defined operator budget
```

The exact production threshold must be determined from validation data and organisational risk tolerance. It must not be invented from model confidence alone.

### 28.6 Adversarial testing

Test the gate when the primary agent knows:

- the feature set;
- the taxonomy;
- thresholds;
- model architecture;
- approval wording;
- recent actions window;
- canary strategy.

Attacks include:

- padding with benign calls;
- splitting effects across tools;
- delayed execution;
- argument encoding;
- generated helper indirection;
- symlink and path aliasing;
- subprocess and interpreter nesting;
- destination indirection;
- approval replay;
- action mutation after approval;
- model disagreement manipulation;
- denial-of-service against the gate.

### 28.7 Human feedback

Approval outcomes are training candidates, not immediate policy updates.

Each outcome may be labelled:

- correct escalation;
- false positive;
- correct deny;
- false deny;
- safe under containment;
- policy exception;
- misunderstood task;
- new technique;
- insufficient evidence.

Promotion to training requires review, de-identification, and dataset versioning.

---

## 29. Testing strategy

### 29.1 Unit tests

- canonicalisation;
- path resolution;
- hashing;
- policy evaluation;
- label propagation;
- risk combination;
- approval binding;
- lease expiry;
- schema validation;
- model manifest verification.

### 29.2 Integration tests

- Pi native tools;
- Pi extension loading;
- Pi package installation;
- ContextForge adapter;
- Numbat event export;
- MCP calls;
- interactive approval;
- headless approval;
- daemon restart;
- model fallback;
- project trust;
- session resume;
- compaction;
- concurrent calls.

### 29.3 Golden traces

Each trace includes:

- task;
- ordered actions;
- provenance;
- expected decisions;
- expected reason codes;
- allowed constraints;
- expected final effects.

Golden traces should be stable and reviewed like security rules.

### 29.4 Property tests

Examples:

- approval cannot authorise a different action hash;
- narrowing policy cannot increase authority;
- secret labels survive encoding;
- untrusted provenance is not removed without a registered sanitiser;
- expired lease never permits execution;
- a stricter downstream decision always wins;
- missing model never becomes benign score zero.

### 29.5 Fault injection

- socket failure;
- daemon delay;
- database lock;
- corrupt manifest;
- signature failure;
- stale permit;
- missing post-execution report;
- duplicate action;
- reordered results;
- partial tool batch;
- model crash;
- memory pressure.

---

## 30. Observability and evidence

### 30.1 Core events

- `gate.session.started`
- `gate.action.proposed`
- `gate.action.normalized`
- `gate.authority.evaluated`
- `gate.policy.triggered`
- `gate.model.scored`
- `gate.trajectory.changed`
- `gate.decision.issued`
- `gate.approval.requested`
- `gate.approval.resolved`
- `gate.permit.issued`
- `gate.action.executed`
- `gate.effect.observed`
- `gate.violation.detected`
- `gate.degraded`
- `gate.model.updated`
- `gate.policy.updated`

### 30.2 Correlation

Use common IDs across:

- Pi session;
- task;
- assistant turn;
- tool-call batch;
- action;
- decision;
- approval;
- permit;
- ContextForge call;
- Numbat event;
- execution;
- evidence bundle.

### 30.3 Privacy

Default telemetry includes metadata and labels, not raw source or secrets.

Content capture is:

- off by default for central export;
- configurable per profile;
- redacted;
- locally encrypted where retained;
- bounded by retention;
- explicitly marked in approval and audit views.

---

## 31. User experience

### 31.1 Status indicator

Pi should visibly show:

```text
AUTO: ENFORCE | Models: healthy | Policy: org-workstation-v3 | Risk: low
```

Degraded states must be prominent.

### 31.2 Routine operation

Low-risk decisions should be quiet. The system should avoid flooding the conversation.

Optional concise notices:

```text
Auto-approved: read 4 workspace files
Contained: generated test script executed without network
Blocked: attempted read of protected credential path
```

### 31.3 Explanation

`/auto explain <action-id>` returns:

- canonical action;
- authority;
- evidence;
- rules;
- model outputs;
- trajectory;
- decision rationale;
- counterfactual outcome under alternative constraints.

It must distinguish deterministic reason from probabilistic signal.

---

## 32. API stability and versioning

Version independently:

- Pi package;
- IPC protocol;
- canonical action schema;
- effect ontology;
- feature schema;
- policy schema;
- model bundle;
- approval permit format;
- evidence format.

Compatibility must be declared in manifests.

Breaking changes require migration tooling or an explicit refusal to load incompatible state.

---

## 33. Delivery roadmap

### Phase 0 — Pi Kit inspection and ADR

Deliverables:

- map all native and MCP tool paths;
- identify current authority points;
- document ContextForge and Numbat contracts;
- identify bypass routes;
- select canonical schema;
- write integration ADR;
- create threat model and trust-boundary diagram.

Exit criteria:

- every governed execution route has an identified interception and enforcement point.

### Phase 1 — Deterministic MVP in observe mode

Deliverables:

- separate Pi package;
- `tool_call` interception;
- canonical action schema;
- local ledger;
- hard rules;
- approval-card templates;
- `/auto` commands;
- native tool adapters;
- ContextForge risk-context adapter;
- no learned model required.

Exit criteria:

- all expected tool proposals logged;
- deterministic rules produce correct golden-trace outcomes;
- no noticeable disruption in observe mode.

### Phase 2 — Enforcement and exact approvals

Deliverables:

- decision service;
- exact-action permits;
- capability leases;
- failure matrix;
- non-interactive approval route;
- local execution wrapper;
- policy layering;
- signed audit.

Exit criteria:

- approvals cannot be replayed or mutated;
- critical hard-policy scenarios deny;
- service failure follows policy.

### Phase 3 — Provenance and information flow

Deliverables:

- file/version provenance;
- untrusted-content propagation;
- secret labels;
- process and network linkage;
- causal approval evidence.

Exit criteria:

- staged exfiltration and generated-code scenarios are detected by structure even without the semantic model.

### Phase 4 — Static and semantic sensors

Deliverables:

- shell/static features;
- obfuscation sensor;
- semantic multi-label ONNX model;
- model manifest and signed distribution;
- calibration and OOD;
- edge performance profile.

Exit criteria:

- model improves defined metrics over deterministic baseline without exceeding approval budget;
- deterministic fallback remains operational.

### Phase 5 — Temporal trajectory detection

Deliverables:

- temporal rules or HMM baseline;
- later compact temporal/graph challenger;
- action-chain evaluation suite;
- early detection metrics.

Exit criteria:

- representative multi-step attacks are escalated before harmful effect.

### Phase 6 — Production hardening

Deliverables:

- immutable worker packaging;
- SBOM and attestations;
- fleet telemetry;
- rollback;
- load tests;
- security review;
- red-team assessment;
- operator documentation.

Exit criteria:

- signed production release;
- approved risk thresholds;
- incident and rollback playbooks tested.

---

## 34. Acceptance criteria

A production candidate must demonstrate:

1. Every native and MCP tool path in the target Pi Kit profile is mediated.
2. No model score can override a hard deny or grant authority.
3. Exact approvals fail when any bound action component changes.
4. Secret classification propagates through copying, encoding, and archiving.
5. Agent-created code derived from untrusted content is contained by default.
6. Missing models do not silently reduce risk.
7. High-impact service timeouts deny or require approval.
8. Multi-call batches cannot use stale gate state to bypass sequencing.
9. ContextForge remains final MCP authority.
10. Numbat receives correlated events and retains independent deny capability.
11. Pi compaction and session resume do not erase security state.
12. The package installs through supported Pi package mechanisms.
13. Model artefacts are pinned, verified, cached atomically, and rollback-capable.
14. Project-local policy cannot weaken global policy.
15. Approval prompts contain actionable evidence and containment choices.
16. Routine task approval volume stays within the approved budget.
17. Critical dangerous auto-approval rate is below the organisation’s release threshold on held-out evaluations.
18. Edge and workstation performance targets are measured and published.
19. The gate has a tested lockdown mode.
20. The complete package, policy, and model state is reproducible from a distribution lock.

---

## 35. Guidance for the Pi Kit development team

The Pi Kit team should treat Pi Autonomy Gate as a platform security dependency, not a normal convenience extension.

Required actions:

1. Add an inspection task before coding.
2. Preserve Pi Core as minimal and upstream-aligned.
3. Keep Pi Autonomy Gate in its own repository.
4. Add it to Pi Kit profiles with exact version and digest locks.
5. Do not duplicate its risk logic in multiple MCP adapters.
6. Keep ContextForge authoritative while the gate is introduced.
7. Keep Numbat independent.
8. Define one canonical action and evidence schema across Pi Kit.
9. Wrap native and MCP tools through common adapter contracts.
10. Ensure project resources cannot disable or replace the global gate.
11. Add package, policy, and model versions to the Pi Kit distribution manifest.
12. Add gate health to Pi Kit startup checks.
13. Make absence or degradation visible in the web UI and RPC events.
14. Implement rollback as a first-class operation.
15. Test with Pi interactive, JSON, RPC, SDK, and fleet-worker modes.
16. Avoid moving authority from ContextForge until an ADR demonstrates equal or stronger enforcement.
17. Provide the gate team with representative, sanitised tool traces and failure cases.
18. Run improvement work through Pi Lab branches/worktrees and promotion gates rather than directly changing protected Pi Core or Pi Kit branches.

---

## 36. Recommended first implementation decision

Build the first release as:

```text
Separate repository: pi-autonomy-gate

Published artefact:
  @org/pi-autonomy-gate Pi package

Pi entry point:
  extensions/index.ts

Runtime:
  TypeScript extension client
  + local Node.js autogated service
  + deterministic policy/provenance core

Inference:
  optional ONNX Runtime Node
  signed, digest-pinned model bundle
  deterministic fallback

MCP:
  Autonomy Gate supplies risk and constraints
  ContextForge remains authoritative
  Numbat remains independent

Pi Kit:
  profile-pinned co-installation
  no copied source
  exact package/policy/model lock
```

The MVP should not wait for BERT training. Build the mediation, schemas, authority, provenance, approval binding, and evidence first. Those components create immediate protection and produce the data required to train useful models.

---

## 37. Open design questions for repository inspection

These questions must be answered by inspecting the current Pi Kit implementation:

1. Does the MCP extension register each remote tool directly with Pi, or expose a generic broker tool?
2. Can native and MCP tools be wrapped through one common registration function?
3. Where are action cards currently constructed?
4. Does ContextForge already issue exact-action hashes or permits?
5. Which identity represents the Pi session to ContextForge?
6. What post-execution metadata is available from current adapters?
7. Can Numbat correlate process and network events with Pi tool-call IDs?
8. Which paths can execute commands without using Pi’s `bash` tool?
9. How are project-local extensions prevented from bypassing the global package?
10. Is Pi Kit installed globally, project-locally, or compiled into immutable profiles?
11. How are package sources pinned today?
12. What platforms must the first daemon support?
13. Is an OCI registry already available in the GitOps environment?
14. What approval interface exists for headless fleet workers?
15. Which existing authority code can become a compatibility adapter rather than being deleted?
16. What event ordering guarantees exist in the pinned Pi version?
17. How are session resumes, forks, and cwd switches represented?
18. Where should local evidence live relative to `.pi`, engagement configuration, and workspace evidence?
19. Which policies are organisation-wide versus engagement-specific?
20. What is the acceptable approval budget for normal work?

No authority migration should occur until these questions are documented.

---

## 38. Security invariants

The following invariants are mandatory:

1. **No authority from model output:** a model cannot grant a new capability.
2. **No silent degradation:** missing policy, model, or service is visible and handled by action class.
3. **No approval without binding:** approval is invalid without exact-action or bounded-lease binding.
4. **No secret declassification by transformation:** encoding, compression, or copying retains sensitivity.
5. **No trusted status from self-assertion:** the agent cannot declare its own artefact reviewed or safe.
6. **No weaker downstream decision:** final enforcement uses the strictest applicable outcome.
7. **No project override of global deny:** project policy can only narrow.
8. **No transcript dependency:** compaction cannot erase security memory.
9. **No unknown high-impact auto-allow:** novelty plus high impact requires containment, approval, or denial.
10. **No same-process security claim against malicious extensions:** high assurance requires external boundaries.
11. **No mutable model selection:** production profiles pin a digest.
12. **No unverified model load:** failed hash/signature validation rejects the model.
13. **No permit replay:** permits are scoped, expiring, use-bounded, and replay-protected.
14. **No hidden bypass mode:** enforcement changes are auditable and policy-controlled.
15. **No explanation without evidence:** approval narratives are generated from structured findings.

---

## 39. Example end-to-end scenarios

### 39.1 Routine repository read

Task:

```text
Find where authentication middleware is implemented.
```

Action:

```text
read /workspace/src/auth/middleware.ts
```

State:

- path is inside workspace;
- file is internal;
- task expects repository reads;
- no suspicious trajectory;
- no secret labels.

Decision:

```text
ALLOW
```

No prompt.

### 39.2 Generated test script

Action chain:

```text
write /workspace/tmp/test_api.py
bash python /workspace/tmp/test_api.py
```

State:

- script is agent-generated;
- content derives only from reviewed repository files;
- task expects tests;
- network destination is local test service;
- no credentials inherited.

Decision:

```text
ALLOW_WITH_CONSTRAINTS
```

Constraints:

- workspace mounts only;
- local network destination only;
- scrub environment secrets;
- 30-second timeout.

### 39.3 Untrusted web-derived executable

Action chain:

```text
web result
  → write helper.py
  → chmod +x helper.py
  → execute helper.py
```

Static findings:

- encoded payload;
- dynamic execution;
- keyboard device access;
- new external destination.

Decision:

```text
SANDBOX or DENY
```

Approval card contains causal chain and containment recommendation.

### 39.4 Secret staging and egress

Action chain:

```text
read ~/.ssh/id_ed25519
archive into /tmp/report.zip
base64 encode
curl external destination
```

Even if individual commands are spread across turns, provenance links the secret to the outbound payload.

Decision:

```text
DENY
```

Numbat receives a critical correlated event.

### 39.5 Valid package installation

Task explicitly permits installing test dependencies.

Action:

```text
npm install --save-dev vitest
```

State:

- approved registry;
- workspace package;
- package lifecycle scripts present;
- no lockfile mismatch policy violation.

Decision:

```text
SANDBOX
```

First run evaluates lifecycle scripts and diff. A later bounded lease may allow package installs from the approved registry under constraints.

### 39.6 MCP cloud read

Action:

```text
MCP: list EC2 instances in approved test account
```

Autonomy Gate:

- classifies as `cloud.read`;
- confirms account and task scope;
- risk low;
- recommends allow.

ContextForge:

- verifies identity and read-only permit;
- executes.

Decision:

```text
ALLOW
```

### 39.7 MCP cloud mutation

Action:

```text
MCP: terminate EC2 instance
```

Autonomy Gate:

- high integrity and availability impact;
- irreversible or costly;
- requires explicit task authority.

ContextForge:

- requires human approval and exact resource permit.

Decision:

```text
REQUIRE_APPROVAL
```

---

## 40. References and implementation sources

This specification is designed around the current Pi extension and package model:

- Pi coding-agent README: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md>
- Pi extension documentation: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md>
- Pi package documentation: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md>
- Pi extension examples: <https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions>

Model runtime and distribution:

- ONNX Runtime JavaScript/Node: <https://onnxruntime.ai/docs/get-started/with-javascript/node.html>
- ONNX quantisation: <https://onnxruntime.ai/docs/how-to/quantization.html>
- ORAS OCI artefacts: <https://oras.land/docs/1.2/concepts/artifact/>
- Sigstore verification: <https://docs.sigstore.dev/cosign/verifying/verify/>

Relevant design influences:

- CaMeL capability-based defence: <https://arxiv.org/abs/2503.18813>
- FIDES information-flow enforcement: <https://arxiv.org/abs/2505.23643>
- HiddenLayer APE taxonomy: <https://hiddenlayer.com/research/introducing-a-taxonomy-of-adversarial-prompt-engineering>
- Open Policy Agent documentation: <https://www.openpolicyagent.org/docs/latest/>

These references inform the design but do not substitute for implementation-specific testing against the pinned Pi, Pi Kit, ContextForge, Numbat, operating-system, and model versions.

---

## 41. Final architectural position

Pi Autonomy Gate should be understood as an endpoint protection and policy-enforcement system for an autonomous agent runtime.

Its essential architecture is:

```text
The user and organisation define authority.
Deterministic policy limits effects.
Provenance tracks where data and code came from.
Information-flow rules preserve sensitivity and integrity.
Static sensors expose concrete hazards.
Small specialised models classify semantics and novelty.
Temporal models recognise dangerous trajectories.
Containment converts uncertainty into observable behaviour.
Exact-action permits prevent approval substitution.
ContextForge enforces MCP authority.
Numbat independently observes and denies.
Humans decide exceptional authority with evidence, not raw prompts.
```

The neural network is not the security boundary.

The package, policy engine, provenance graph, broker, sandbox, and exact permit system together form the boundary. Learned models make that boundary more intelligent, selective, and usable without becoming the root of trust.
