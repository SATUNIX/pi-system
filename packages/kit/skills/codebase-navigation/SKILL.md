---
name: codebase-navigation
category: coding-workflow
description: Orient in a repository and find/read code with the fewest tool calls. Use when entering an unfamiliar repo or area, or whenever you need to locate a symbol, file, route or config — search first, read narrow ranges, read once.
disable-model-invocation: true
triggers: ["unfamiliar repo", "unfamiliar codebase", "new codebase", "explore the repo", "explore the codebase", "how is this repo structured", "how is the codebase structured", "get oriented", "re:\\bwhere (is|are)\\b.{0,60}\\b(defined|implemented|declared|configured|handled)\\b"]
---

# Codebase Navigation

Build the minimum map this task needs, then locate and read with as few calls as possible.
The failure this prevents is burning dozens of calls reading whole files, re-reading them,
and stalling.

## Orient (once, when the repo or area is new)
1. **Read the instructions first.** CLAUDE.md, AGENTS.md or README: project rules and
   entry points, before any source.
2. **Sketch the layout** from one directory listing plus the package/build files: what kind
   of project it is, and where source and tests live.
3. **Note the validation path**: how this area is built and tested.

## Locate and read (any time)
1. **Search before reading.** Find the symbol, route or config with `grep`, or a structural
   map / AST search if `pi-readseek` is available. Don't open files to look around.
2. **Read ranges, not whole files.** Read around the line numbers. Only read a whole file
   when it's small (under ~40 lines) or you really need all of it.
3. **Read once.** An unchanged file you've already read is still in context. Use it.
4. **Batch independent lookups** into one round of calls.
5. **Record the fact you needed** (path, symbol, line) so you never have to reopen the file.

## Heuristics
- Symbol location unknown: search, don't browse.
- One function in a 1,000-line file: range-read around it.
- Third read of the same file: stop. Act on what you have, or delegate the lookup.
- The same search with small variations: change strategy, don't repeat.

## Done
You can name the files you'll touch, how to validate them, and the local conventions, and
you read nothing twice.
