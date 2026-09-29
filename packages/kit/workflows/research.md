---
name: research
description: Three parallel scouts investigate a question from different angles, a planner synthesises, and durable findings are saved to memory.
inputs:
  question:
    description: What you want to understand about the codebase or system
    required: true
vault: true
steps:
  - id: investigate
    parallel:
      - id: code
        agent: scout
        task: |
          Question: {{inputs.question}}
          Angle: the implementation. Find the code paths involved and explain how they work,
          citing path:line.
      - id: tests
        agent: scout
        task: |
          Question: {{inputs.question}}
          Angle: tests, fixtures and CI. What is covered, what isn't, and what the tests
          reveal about intended behaviour.
      - id: history
        agent: scout
        task: |
          Question: {{inputs.question}}
          Angle: history and docs. Use git log/blame and the docs to find why it is the way
          it is, including past decisions and known issues.
  - id: synthesise
    agent: planner
    task: |
      Question: {{inputs.question}}

      Findings from three independent investigations:
      {{steps.investigate.output}}

      Write a clear answer: what is true (with path:line evidence), where the investigations
      disagree, and open questions. End with a "Durable facts" list: facts worth remembering
      in future sessions (non-obvious decisions and gotchas only).
  - id: remember
    skill: memory
    tools: [read, memory_save]
    extensions: [memory-vault]
    task: |
      Save each item from the "Durable facts" list below with memory_save (type decision
      or gotcha, scope project). Skip anything already obvious from the code. If the list is
      empty, save nothing.

      {{steps.synthesise.output}}
    continue_on_error: true
---

# research

A read-only investigation. The three scouts work independently, so they can disagree. The
planner reconciles them. Durable findings go to the memory vault, and the whole run
directory is copied to the vault (`vault: true`) under
`Projects/<project>/Workflows/<run-id>/`.
