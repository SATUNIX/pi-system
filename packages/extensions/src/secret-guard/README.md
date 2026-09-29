# secret-guard

Blocks write, edit, and bash operations that target secret files or leak credentials.

## What it blocks

- `write` / `edit` to: `.env`, `.env.*`, `*.key`, `*.pem`, `*.p12`, `*.pfx`, `*credentials*`, `*secret*`, `.ssh/*`, `id_rsa`, `id_ed25519`
- `bash` commands that: `git add *.env`, `cat *.env`, echo/curl with credential-like content

## What it does NOT block

- Reading secret files (read-only inspection is allowed)
- Legitimate usage not matching the patterns above

## Configuration

No env vars. Patterns are hardcoded in `index.ts` (`SECRET_PATTERNS` and `SECRET_BASH_PATTERNS`). To extend, add an extension in your own repo that hooks `tool_call` with your patterns.

## Profiles

Included in: `quick`, `balanced`, `long-horizon`, `autonomous`, `self-improving`
