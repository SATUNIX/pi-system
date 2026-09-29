# Tool firewall and auto mode

> Diagrams reflect commit bc0ec11 (branch overhaul/2026-09, 2026-09-23). If the code has changed since, regenerate them.

The `tool-firewall` extension decides, before every tool call runs, whether it may proceed, parsing shell commands and non-shell tools, classifying them into effects and one of four tiers, folding in session history, then either allowing, denying, or asking a human. In `auto` mode with the `coding` policy a small in-process judge decides medium actions, and high actions only when the operator previously allowed something similar. `manual` mode routes medium and high actions to the operator; the `pentest` policy does too, except that in `auto` mode a medium action whose effects are all `read` or `network_read` reaches the judge. Operator requests render as a bounded approval card or, headless, through the human-console broker. Every operator decision and every judge verdict is written to the feedback and judgement logs and distilled in the background into a global profile that only informs the judge. `protected-paths` runs as a separate `tool_call` hook that blocks writes to secrets, control surfaces and firewall state.

## Components and where state lives

The firewall is wired through three `pi.on` hooks (`session_start`, `before_agent_start`, `tool_call`) plus a sibling `protected-paths` hook. Runtime configuration comes from `firewall.json` with environment overrides, the policy comes from `default-policy.json`, and all durable state lives under `~/.pi/agent/pi-kit/` and `<cwd>/.pi/`.

```plantuml
@startuml
rectangle "pi tool_call hook" as A
rectangle "protected-paths hook" as A2
rectangle "CODING_PROTECTED secrets control surfaces firewall state" as PP
rectangle "PENTEST_PROTECTED adds .git/ node_modules/ .pi/agents/ .pi/pentest/ .pi/engagement/ and PI_KIT_PROTECTED_PATHS can only add" as PT
rectangle "PI_KIT_WRITE_ALLOWLIST allowlist mode" as AL
rectangle "block write to protected path" as BL
rectangle "decide in index.ts" as B
rectangle "classifyToolCall and parseShell" as C
rectangle "trajectoryFindings" as D
rectangle "judge runJudge" as E
rectangle "buildCard" as F
rectangle "brokerApproval" as G
rectangle "operator menu or confirm" as H
rectangle "human-console watcher" as H2
rectangle "session grants" as I
rectangle "appendFeedback and appendJudgement" as J
rectangle "distillInBackground" as K
rectangle "global profile" as L
rectangle "default-policy.json" as M
rectangle "firewall.json" as N
rectangle "env overrides PI_KIT_FIREWALL_PROFILE PI_KIT_AUTO_MODE" as O
rectangle "firewall-sessions ROOT.grants.json" as P
rectangle "firewall-sessions SESSION.json" as Q
rectangle "firewall-feedback.jsonl and firewall-judgements.jsonl" as R
rectangle "firewall-profile.json" as S
rectangle "tool-firewall-audit.jsonl" as T
rectangle "human-console pending and resolved" as U
rectangle "root session env PI_KIT_FIREWALL_ROOT_SESSION" as V
rectangle "subagents" as W

A --> B
A2 --> PP
A2 --> PT
A2 --> AL
PP --> BL
PT --> BL
AL --> BL
B --> C
B --> D
B --> E
B --> F
B --> G
F --> H
G --> H2
H2 --> H
B --> I
B --> J
J --> K
K --> L
B --> M
B --> N
N --> O
I --> P
D --> Q
J --> R
L --> S
B --> T
G --> U
V --> I
W --> V
@enduml
```

## Decision pipeline

Inside `decide`, the call is hashed, classified into findings, enriched with operator regex rules and trajectory findings, reduced to a tier, and summarised before any allow or block decision. Low and critical tiers short-circuit to allow and deny; everything else enters the grant/precedent/judge/human path.

```plantuml
@startuml
rectangle "tool_call event" as A
rectangle "toolName and input" as B
rectangle "actionHash sha256" as C
rectangle "classify shell and tools" as D
rectangle "operator regex rules" as E
rectangle "trajectory findings" as F
rectangle "effects recompute" as G
rectangle "effectiveTier" as H
rectangle "summarize and signature" as I
rectangle "tier" as J
rectangle "allow by analyser" as K
rectangle "deny by policy" as L
rectangle "grants precedents judge human" as M

A --> B
B --> C
C --> D
D --> E
E --> F
F --> G
G --> H
H --> I
I --> J
J --> K : low
J --> L : critical
J --> M : medium or high
@enduml
```

## Decision matrix by mode and policy

The effective matrix depends on mode and policy. `manual` never auto-approves a new action above low and the judge is never called; only an exact repeat matching a session grant runs without asking. `auto` with `coding` lets the judge decide medium actions and high actions only when the operator allowed something similar; `pentest` disables learning and session grants and denies high actions when no operator is present.

```plantuml
@startuml
rectangle "tier low" as S
rectangle "allow" as A1
rectangle "tier critical" as C
rectangle "deny" as D1
rectangle "tier medium" as M
rectangle "exact session grant" as MG
rectangle "allow without asking" as MA
rectangle "mode and policy" as Q
rectangle "ask human for new action" as H1
rectangle "judge" as J1
rectangle "effects only read or network_read" as R1
rectangle "judge may allow" as J2
rectangle "ask human" as H2
rectangle "tier high" as H3
rectangle "exact session grant" as HG
rectangle "allow without asking" as HA
rectangle "mode and policy" as Q2
rectangle "ask human for new action" as H4
rectangle "exact grant or learned exact action allows" as G1
rectangle "else judge only if similar allowed before" as N1
rectangle "judge block goes back to human" as N2
rectangle "ask human" as H5
rectangle "headless pentest denied" as H6

S --> A1
C --> D1
M --> MG
MG --> MA
M --> Q
Q --> H1 : manual
Q --> J1 : auto coding
Q --> R1 : pentest
R1 --> J2 : yes
R1 --> H2 : no
H3 --> HG
HG --> HA
H3 --> Q2
Q2 --> H4 : manual
Q2 --> G1 : auto coding
G1 --> N1
N1 --> N2
Q2 --> H5 : pentest
H5 --> H6
@enduml
```

## A typical run

This sequence shows the common auto-mode path: a medium action reaches the judge with its inputs, every newly computed verdict is recorded as a judgement before the allow or block branch, and a block is returned to the agent with its reason. In `manual` mode the judge is never called; high, unavailable-judge and non-judged cases fall through to the operator.

```plantuml
@startuml
participant "Agent" as Agent
participant "Tool firewall" as FW
participant "Judge" as Judge
participant "Operator" as Op
participant "State files" as Files

Agent -> FW : tool_call
FW -> Files : read firewall.json and grants
FW -> Files : read .pi/GOAL.yaml goal
FW -> FW : parse classify trajectory tier
alt low
  FW -> Files : audit one combined tool_seen allow
  FW --> Agent : allow
else critical
  FW -> Files : audit one combined tool_seen deny
  FW --> Agent : block
else manual medium or high
  FW -> Files : audit tool_seen ask
  FW -> Op : approval card
  Op --> FW : allow or deny
  FW -> Files : appendFeedback and grants and session
  FW --> Agent : allow or block
else auto judged medium or high
  FW -> Files : audit tool_seen ask
  FW -> Judge : request goal precedents grants profile high
  Judge --> FW : verdict JSON
  FW -> Files : appendJudgement for the new verdict
  alt judge allows
    FW --> Agent : allow
  else judge blocks medium
    FW --> Agent : block with reason
  else judge blocks high or judge unavailable
    FW -> Op : approval card
    Op --> FW : allow or deny
    FW -> Files : appendFeedback and grants and session
    FW --> Agent : allow or block
  end
end
@enduml
```

## Approval cards, the broker, grants and recording

A headless request is written as a pending JSON file and answered by the human-console watcher, which presents the same menu and writes a resolved file. A session allow becomes a grant stored under the root session id, so subagents inherit it; every operator decision appends feedback and can trigger background distillation.

```plantuml
@startuml
participant "Subagent" as Sub
participant "Tool firewall" as FW
participant "Human console" as HC
participant "Operator" as Op
participant "Grants and feedback" as Store

Sub -> FW : tool_call
FW -> HC : pending approval json
HC -> Op : menu allow once allow session deny deny and tell
Op --> HC : choice
HC --> FW : resolved json
FW -> Store : addGrant under root session
FW -> Store : appendFeedback
Store -> Store : distillInBackground updates profile
note over Sub, Store : root session grants shared with siblings and parent
Sub -> FW : identical tool_call
FW -> Store : readGrants root session
Store --> FW : exact hash match
FW --> Sub : allow by grant
@enduml
```

## Key files

- `packages/extensions/src/tool-firewall/index.ts` — hooks, `decide`, decision matrix, grants, judge gate, card and broker branching, audit.
- `packages/extensions/src/tool-firewall/config.ts` — modes, policies, config file, state paths, known hosts, workspace root.
- `packages/extensions/src/tool-firewall/classify.ts` — effects, tiers, path classes, per-command handlers, signatures and families.
- `packages/extensions/src/tool-firewall/shell.ts` — tokenizer and parser feeding the classifier.
- `packages/extensions/src/tool-firewall/trajectory.ts` — per-session state, trajectory findings, grants, root-session sharing.
- `packages/extensions/src/tool-firewall/judge.ts` — judge prompt, in-process model call, verdict parsing, timeout.
- `packages/extensions/src/tool-firewall/card.ts` — bounded card, choices, detail view.
- `packages/extensions/src/tool-firewall/feedback.ts` — feedback record, redaction, learning thresholds, precedents.
- `packages/extensions/src/tool-firewall/profile.ts` — judgements, distillation stats, global profile and its lock.
- `packages/extensions/src/tool-firewall/default-policy.json` — shipped tools and pentest command rules.
- `packages/extensions/src/human-console/index.ts` — pending/resolved broker, approval menu, `ask_human`.
- `packages/extensions/third_party/protected-paths/index.ts` — protected lists, allowlist mode, path matching.
- `docs/autonomy-gate.md` — prose description of the same decision gate.
