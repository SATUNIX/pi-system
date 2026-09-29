# SOURCE

- Upstream: `@earendil-works/pi-coding-agent@0.76.0` — `examples/extensions/notify.ts`
- Date: 2026-06-17
- Changes:
  - Upstream uses `require("child_process")` dynamically; changed to static `import { execFile } from "node:child_process"` for clarity and self-containment compliance
  - Windows notification path unchanged (upstream already handles WT_SESSION)
  - `provenance.origin` set to `"vendored"`
