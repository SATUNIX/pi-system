# tool-capture

Lossless capture of every tool call and its output, for audit and SIEM. Each call becomes a
`call` record (the exact arguments) and a `result` record (the exact content and details the
model saw, including firewall blocks). The two are joined by `toolCallId` and by the
firewall's `actionHash`.

| File | Role |
|---|---|
| `index.ts` | Hooks (`tool_execution_start` / `_end`, session start/shutdown), hashes, secret flagging or redaction, `/capture`. |
| `store.ts` | Per-process segments, lossless value encoding, content-addressed gzip blobs, rotation and compression, disk budget and pruning. |

The log lives in `~/.pi/agent/pi-kit/capture/` (0700), or in `PI_KIT_CAPTURE_DIR`. Values are
stored exact, secrets included and flagged per record; `PI_KIT_CAPTURE_REDACT=1` redacts them
instead. The full description, including the record format, retention and SIEM notes, is in
`docs/tool-capture.md`.
