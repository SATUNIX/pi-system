# goal-core

Explicit goal management with definition-of-done tracking. Stores the active goal in `.pi/GOAL.yaml` and writes a contribution file for context-sieve to inject. /goal sets or clears the current goal, persisting its full text losslessly including line breaks (a multi-line goal additionally writes a JSON-encoded `goal_full:` scalar while `goal:` keeps the first line for the other single-line readers; legacy unquoted `goal:` lines still read back unchanged). goal-core contributes goal context to context-sieve's selection, but context-sieve does not summarise compaction.
