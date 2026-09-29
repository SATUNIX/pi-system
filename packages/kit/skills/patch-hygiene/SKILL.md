---
name: patch-hygiene
category: coding-workflow
description: Keep edits scoped, clean, and reviewable. Use whenever you write or edit files, and before finalizing a change, so diffs stay minimal and don't churn unrelated code.
disable-model-invocation: true
triggers: ["minimal diff", "clean diff", "keep the diff", "unrelated changes", "whitespace churn", "don't reformat", "do not reformat", "scoped change", "keep changes scoped"]
---

# Patch Hygiene

A change should read as one intentional diff. Reviewers (and future you) should see exactly
what changed and why, with no noise.

## When to use
- Any time you write or edit files.
- Before declaring a change done — review the diff first.

## Rules
1. **Only the intended files.** If a file isn't part of the task, don't touch it.
2. **Match existing style.** Formatting, indentation, quotes, naming — mirror the file.
   Don't reformat surrounding code.
3. **No metadata churn.** Don't bump versions, reorder imports, or rewrite whitespace
   unless that *is* the task.
4. **Don't revert unrelated changes.** Leave the user's other in-flight edits alone.
5. **Minimal diff.** The smallest edit that achieves the goal; no drive-by refactors.
6. **Review before finalizing.** Read the actual diff, confirm it's only what you intended,
   and verify the behaviour (`verification-loop`).

## Decision heuristics
- Editor auto-reformatted the file? Revert the noise; keep only your lines.
- Tempted to fix an unrelated nit? Note it separately; don't fold it in.
- Large diff for a small goal? Something's wrong — re-scope.

## Anti-patterns
- Mixing a refactor and a fix in one change.
- Whitespace/import churn that hides the real edit.
- Touching files outside the write set you named.

## Done
The diff is minimal, consistent with the file's style, limited to the intended files, and
reviewed against the intended behaviour.
