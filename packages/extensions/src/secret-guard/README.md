# secret-guard

Blocks write, edit, and bash operations that target secret files or leak credentials.

## What it blocks

- `write` / `edit` to: `.env`, `.env.*`, `*.key`, `*.pem`, `*.p12`, `*.pfx`, `*credentials*`, `*secret*`, `.ssh/*`, `id_rsa`, `id_ed25519`
- `bash` commands that: `git add *.env`, `cat *.env`, echo/curl with credential-like content

## What it does NOT block

- Reading secret files (read-only inspection is allowed)
- Legitimate usage not matching the patterns above

## Configuration

No env vars of its own. It also protects the files the firewall trusts: `PI_KIT_FIREWALL_POLICY`,
`PI_KIT_FIREWALL_AUDIT_LOG`, `PI_KIT_FIREWALL_APPROVALS` and the unattended-run contract
(`PI_KIT_UNATTENDED_CONTRACT`) cannot be written by the agent. On load it registers itself in
`globalThis[Symbol.for("pi-kit.protections")]`. Patterns are hardcoded in `index.ts` (`SECRET_PATTERNS` and `SECRET_BASH_PATTERNS`). To extend, add an extension in your own repo that hooks `tool_call` with your patterns.

## Profiles

Included in: `quick`, `balanced`, `long-horizon`, `autonomous`, `self-improving`
