# branch-lab

Worktree and branch manager for isolated pi sessions. Provides tools to create, list, switch, discard, and merge git branches so risky or experimental tasks run in isolation from the main working tree.

Leases are stored in `PI_KIT_BRANCH_LEASES_FILE` or `.pi/branch-leases.json`. `PI_KIT_MAX_BRANCHES` overrides the maximum number of concurrent branches. Worktrees are created under the system temp directory in `pi-branch-lab/`.

Tools:

- `branch_create({ taskId, baseBranch? })`
- `branch_list({})`
- `branch_switch({ taskId })`
- `branch_discard({ taskId })`
- `branch_merge({ taskId, strategy? })`

`taskId` accepts 1-80 letters, numbers, dots, underscores, or dashes. `baseBranch`
accepts a real git ref or commit (for example `origin/main`, `feature/my-branch`,
`release/1.2`, or a 40-char SHA): it may contain `/` and `.` inside components, but
must be at most 200 characters, may not start with `-`, contain whitespace or any of
`~ ^ : ? * [ \`, contain `..` or `//`, end with `/`, `.`, or `.lock`, or use a path
component that starts or ends with `.`.
