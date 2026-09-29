# Third-party extensions

Extensions under `third_party/` are adapted from upstream projects. Each directory contains a
`SOURCE.md` recording the origin, the upstream license, and what was changed. They are vendored
rather than referenced from npm because the kit carries local modifications that upstream does
not publish.

The vendored set composes with the first-party extensions in `../src/`. Profiles reference them
by name only, so the distinction is a provenance and maintenance concern, not an install-time one.

When updating a vendored extension, keep `SOURCE.md` accurate and re-run `npm run verify`.
