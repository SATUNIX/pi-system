# Improvement charter

This branch (`{{BRANCH}}`, cut from `{{BASE_REF}}` at `{{BASE}}` on {{DATE}}) is improved in
cycles by autonomous runs; every cycle that meets this charter is merged into it, and the next
cycle builds on it. A person reviews it afterwards, and changes reach `{{BASE_REF}}` only
through their merge request. This charter is how every change is judged. A change that does
not meet it is not an improvement, however large it is.

## What counts as an improvement

A change is accepted when all of these hold:

1. **It fixes a real, evidenced problem, or adds clear value.** Examples are a bug reproduced
   by a test, a reliability or security gap shown in the code, a documented behaviour that the
   code doesn't have, or friction that users hit. Cite the evidence (file:line, command
   output, a failing test).
2. **It is tested.** New or changed behaviour has a test that fails without the change and
   passes with it (usually a `tests/*-smoke.mjs` wired into `package.json`, which
   `check:all` picks up by itself).
3. **It is documented.** User-visible behaviour, commands, settings and extension contracts are
   updated in `docs/` or the extension's README in the same change. Docs build with
   `mkdocs --strict`.
4. **The gate is green.** `npm run check:all`, `npm run test:security`,
   `python3 -m mkdocs build --strict` and `gitleaks git` all pass on the pushed head.
5. **It is scoped and reviewable.** It is one logical change per commit, and there is no
   repo-wide reformatting or tidying of unrelated files. The commit message follows the
   repository's convention (a summary line, then finding / root cause / fix / verification).

## Out of bounds

- Weakening, disabling, skipping or deleting security controls (tool-firewall,
  secret-guard, protected-paths, verify-gate) or their tests, or loosening a test so that it
  passes.
- Changing CI secrets, release tags, versions, `CHANGELOG` release entries, or the release
  and publish pipelines' credentials handling.
- Adding or upgrading dependencies. The workspace is offline. If a dependency is warranted,
  write a proposal in the backlog instead.
- Rewriting pushed history. Only fast-forward pushes are accepted.
- Editing `autonomy/CHARTER.md`. Propose charter changes in `autonomy/BACKLOG.md`.

## Priorities

Work in this order, and prefer to finish an item rather than start a new one:

1. A red gate or a broken pushed state.
2. Unfinished items carried over in `HANDOFF.md`.
3. Correctness and reliability bugs in shipped extensions and the installer.
4. Security hardening that keeps behaviour compatible.
5. Tests for untested behaviour, then documentation accuracy.
6. Cleanup: code you can show is dead, duplicated or needlessly complex, simplified without
   changing behaviour.
7. Improvements to existing systems: more capability, functionality, performance, reliability
   or usability. Take these on only when nothing above is open.
8. Evaluations and proposals (write-ups with evidence and a recommendation, committed under
   `autonomy/proposals/`).

## Cycle modes

Items 1–6 are **fix mode** and item 7 is **improve mode**. A cycle fixes while there is
something to fix, and improves only when there isn't. An improvement needs the same evidence
as a fix: a measured baseline, a documented limitation, or a gap you can demonstrate. It also
needs tests and docs, and no new dependencies. The cycle after an improvement starts with a
**consolidation** pass over what changed (bugs, edge cases, missing tests, docs drift,
leftover complexity), because new code is where the next bugs are. So the work cycles: fix →
improve → consolidate → fix.

A cycle whose honest review finds nothing to do records `Outcome: nothing found` instead of
inventing work. Several of those in a row end the run.
