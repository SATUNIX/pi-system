# guidelines

Publishes project-specific guidelines from a `GUIDELINES.md` file for `context-sieve` to assemble into the agent system prompt.

## How it works

On `session_start`, scans the project's working directory for a guidelines file and writes a context contribution. `context-sieve` is the only extension that injects the final system prompt.

## Search order

1. `PI_KIT_GUIDELINES_PATH` env var (absolute path to any file)
2. `GUIDELINES.md` in the project root
3. `AGENTS.md` in the project root
4. `.pi/GUIDELINES.md` in the project root

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PI_KIT_GUIDELINES_PATH` | (none) | Override the guidelines file location |

## Profiles

Included in: `balanced`, `long-horizon`, `autonomous`, `self-improving`
