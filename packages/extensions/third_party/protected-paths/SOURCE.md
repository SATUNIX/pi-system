# SOURCE

- Upstream: `@earendil-works/pi-coding-agent@0.76.0` — `examples/extensions/protected-paths.ts`
- Date: 2026-06-17
- Changes:
  - Changed from hardcoded array to env-var `PI_KIT_PROTECTED_PATHS` (colon-separated on Unix, semicolon on Windows)
  - Added `path.normalize` for Windows path comparison
  - Added `node:path` import (not needed upstream since it used string includes)
  - `provenance.origin` set to `"vendored"` in extension.json
