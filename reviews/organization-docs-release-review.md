# Organization, Documentation & Release-Readiness Review

Reviewer C — independent adversarial review, 2026-08-04.

## Verdict

**Not ready for a `v1.0.0` tag.** Two findings are release-blocking:

1. Epic 9.1's required cross-platform **install + verify + eval** profile regression was replaced by a much narrower metadata check, while the roadmap says the epic is complete.
2. `package-lock.json` is not synchronized with `package.json`; a clean reproducible install fails, and the release script neither updates nor stages the lockfile.

The repository has a sensible high-level layout and several useful generated catalogues/checks, but the capstone documentation freeze is not true against HEAD. Multiple MkDocs-nav documents retain pre-implementation claims, the primary lite install examples omit a required dependency-install step, and the documented portable Git install uses a tag that does not exist.

## Scope and method

- Confirmed branch `hardening/production-readiness-plan` and reviewed the last 40 commits.
- Read `LATEST_PLAN_2026-08-04T042958Z.md`, `docs/roadmap.md`, and `docs/improvement-roadmap.md` in full, using each sprint DoD as the acceptance bar.
- Audited every document in `mkdocs.yml` nav. The research documents are clearly proposals/research and were evaluated as such; operational guides and documents claiming current status were checked against HEAD.
- Audited `CHANGELOG.md`, `package.json`, `package-lock.json`, `kit/release.mjs`, both CI workflows, tag state, profiles/surfaces, generated catalogues, and newcomer-facing repository contracts.
- Ran only offline/read-only checks. No live Pi/model/backend invocation, remote request, push, or tag operation occurred.

Commands and actual outcomes relevant to this review:

```text
git branch --show-current
  hardening/production-readiness-plan

git tag -n
  v0.9.0  Release 0.9.0

npm run docs:check
  [docs-nav-check] OK: nav entries exist and internal links resolve.

npm ci --ignore-scripts --offline --dry-run
  EUSAGE: package.json and package-lock.json are not in sync
  Invalid: lock file's @earendil-works/pi-coding-agent@0.79.6
           does not satisfy @earendil-works/pi-coding-agent@0.76.0

git show-ref --verify refs/tags/v0.1.0
  exit 128: not a valid ref
git show-ref --verify refs/tags/v0.9.0
  success
```

## Findings

### Blocking — Epic 9.1's cross-platform profile regression DoD is not implemented

**Evidence**

- The plan requires: “install + verify + eval every profile + lite surface, Windows and Linux” (`LATEST_PLAN_2026-08-04T042958Z.md:110-111`).
- Both CI matrices run only `npm run profile:check -- ${{ matrix.target }}` for each OS/target (`.github/workflows/ci.yml:37-51`; `.gitea/workflows/ci.yml:32-45`). They do not install a selected profile and do not run `npm run verify` or `npm run eval` in the matrix.
- For a profile, `profile-check.mjs` only reads the JSON, resolves names, checks stub/experimental status and firewall ordering, and prints the include count (`kit/profile-check.mjs:34-84`). Only the **lite surface** takes the extra export/package-verify path (`kit/profile-check.mjs:86-100`).
- The script explicitly says a live install is out of scope (`kit/profile-check.mjs:2-11`). That can be a useful supplemental check, but it is not the plan's stated regression.
- Nevertheless, the authoritative roadmap marks Epic 9/`1.0.0` complete (`docs/roadmap.md:7-20`) and `CHANGELOG.md` describes the matrix as the capstone regression (`CHANGELOG.md:12-17`).

**Why blocking**

The capstone is the only planned integration check across profiles and operating systems. Static name resolution cannot reveal installer failures, extension load failures, platform-specific runtime behavior, missing external dependencies, or a profile-specific verify/eval failure. The production-ready claim therefore lacks the acceptance evidence the project itself required.

**Reproduction**

1. Inspect `.github/workflows/ci.yml:37-51` (the Gitea workflow is equivalent).
2. Run `node kit/profile-check.mjs --profile quick` and observe that it reports only resolved extension count/status.
3. Inspect `kit/profile-check.mjs:76-85`: there is no install, verify, or eval invocation for profiles.

**Required disposition before `v1.0.0`**

Implement the promised offline-capable install/verify/eval matrix on both OSes, plus a separately authorized live Pi load/integration smoke before calling the runtime production-ready; or formally revise the release criteria and clearly label the missing live validation as a pre-release limitation. Merely keeping the current metadata checker is insufficient.

### Blocking — the committed npm lockfile is invalid and the release cutter preserves the defect

**Evidence**

- Root package version is `0.9.0`, and the Pi framework is a pinned `0.76.0` dev dependency (`package.json:2-3`, `package.json:31-34`).
- The lockfile still identifies the root package as `0.1.0`, omits that dev dependency from its root package record, and resolves Pi `0.79.6` (`package-lock.json:2-21`).
- `npm ci --ignore-scripts --offline --dry-run` fails with `EUSAGE`: the lockfile's `0.79.6` does not satisfy the package's `0.76.0` pin.
- CI uses `npm install`, not `npm ci` (`.github/workflows/ci.yml:17,34,50,65`; `.gitea/workflows/ci.yml:15,29,44,57`). That silently repairs/mutates a stale lockfile in the ephemeral runner instead of enforcing reproducibility.
- The release script writes only `package.json` and later stages only `package.json` (`kit/release.mjs:55-63`, `kit/release.mjs:77-80`). It never runs a lockfile-only update and never stages `package-lock.json`.
- The `v0.9.0` tag contains the same `package-lock.json` root version `0.1.0`, so the first scripted/tagged release is already non-reproducible from its committed lock state.

**Why blocking**

A fresh maintainer cannot perform the standard deterministic clean install. The pinned floor claimed by Epic 8 is not represented in the lockfile, and cutting `1.0.0` with the current script would merely change `package.json` again while retaining a stale `0.1.0` lock identity.

**Reproduction**

```powershell
npm ci --ignore-scripts --offline --dry-run
```

It fails before executing any project test. This check was offline and did not modify the worktree.

### High — the primary lite installation instructions are knowingly incomplete

**Evidence**

- `docs/getting-started.md:13-25`, `docs/INSTALL.md:16-29`, and `README.md:32-45` lead with `npm run export:lite` followed directly by `pi install dist/pi-kit-lite`.
- The dedicated surface guide correctly warns that export does **not** vendor `pi-readseek`, `pi install` does **not** install dependencies, and `npm install` inside the generated surface (or `npm run install:lite`) is required (`docs/install-surfaces.md:27-31`). Thus the docs contradict each other on a known clean-install trap.
- The generated surface declares external package dependencies and loads them from `node_modules` (`kit/export-package.mjs:277-305`); export alone does not install them.
- The docs smoke does not catch this. It skips every `pi` command and merely asserts that referenced npm scripts exist; its only executed onboarding action is export (`tests/docs-smoke.mjs:56-83`).

**Impact**

A newcomer following “Getting Started” or the README gets a registered surface with missing external runtime files. This directly contradicts Epic 7.1's “all pass on a clean clone” DoD (`LATEST_PLAN_2026-08-04T042958Z.md:88-91`) and the earlier one-command-install objective.

**Reproduction/evidence path**

1. Read the three two-command examples above.
2. Compare them with the explicit warning in `docs/install-surfaces.md:27-31`.
3. Inspect `tests/docs-smoke.mjs:71-83` to see why the broken combined workflow passes CI.

Use `npm run install:lite` as the canonical path everywhere, or document the explicit `npm install` step between export and registration and exercise the whole flow in a safe installer smoke.

### High — the capstone docs freeze is false against HEAD

**Evidence**

- Epic 9.3 requires both roadmaps to be verified true against HEAD (`LATEST_PLAN_2026-08-04T042958Z.md:112-115`). The roadmap claims that happened and that all nine epics/`1.0.0` landed (`docs/roadmap.md:7-31`). HEAD/package/tag remain `0.9.0`; tagging is intentionally deferred, so the truthful state is “Epic 9.1-9.3 candidate implemented, 9.4 pending independent sign-off,” not “`1.0.0` landed.”
- `docs/improvement-roadmap.md` still says references do not exist (`:68-70`), recovery mode is only a design (`:74-79`), auto mode requires an operator env var (`:80-83`), and no eval harness exists (`:100-106`). All conflict with the same document's status inserts and current files. Sections 3 and 5 and the “do these first” shortlist (`:167-182`) were not closed out.
- `docs/skills-and-efficiency-improvement-plan.md` is in MkDocs nav as a current “Skills & Efficiency Plan,” but its banner says “not yet implemented” and its findings call `trace-ledger` a stub absent from lite (`:1-26`). The same document later says all three phases were done in `0.2.1`–`0.4.0` (`:215-237`), so it contradicts itself and HEAD.
- The recovery design has an implementation banner but still labels the central workflow “to be automated” and the implementation “for a later implementation” (`docs/recovery-orchestration-mode.md:3-11`, `:25`, `:123`). This is less severe in isolation, but contributes to an unclear current-vs-design boundary.
- Security docs label checks as the “1.0.0 capstone” sign-off (`docs/security.md:73-81`) before the release/tag exists.

**Impact**

These are not stylistic nits: a newcomer cannot tell which work is complete, deferred, or merely designed, and the authoritative status document overstates release state. This also fails Epic 7.2's “no doc contradicts `roadmap.md`” DoD (`LATEST_PLAN_2026-08-04T042958Z.md:92-93`).

Resolve by giving historical plans explicit completed/superseded banners and moving remaining work into an actual current backlog; make `roadmap.md` report the pre-tag candidate state until the tag is created.

### High — the documented portable Git install points to a nonexistent tag

**Evidence**

- README's Git install path uses `@v0.1.0` (`README.md:10-15`). The Install reference repeats `@v0.1.0` as the clean-machine Git mode (`docs/INSTALL.md:57-65`).
- The repository has only `v0.9.0`; `git show-ref --verify refs/tags/v0.1.0` exits 128 while `refs/tags/v0.9.0` resolves.
- The roadmap says the no-tag problem is resolved by `v0.9.0` (`docs/roadmap.md:22-27`), but the canonical examples were not updated to that first real tag.

**Impact**

One of the four top-level install choices is guaranteed to fail. This is high because tag-based installation is the reproducible/portable release path that Epic 8 was intended to establish.

### High — the release cutter does not enforce the capstone gate and is unsafe as a versioning primitive

**Evidence**

- The script's “full gate” runs verify, security tests, eval, and docs smoke (`kit/release.mjs:65-75`) but not `npm run profile:check` for profiles/surfaces, the Epic 9 matrix, or an actual MkDocs build.
- It accepts any digit-only `X.Y.Z` and checks only tag collision (`kit/release.mjs:19-21`, `:51-59`). It does not require the target version to be greater than the current version, so an untagged downgrade such as `0.1.0` is accepted.
- Its clean-tree check explicitly ignores any dirty `package.json`, not merely an expected version-field change (`kit/release.mjs:42-49`), and it commits all of that file (`:77-80`).
- The script has no branch/HEAD provenance guard and no release-candidate/CI-success attestation. No release procedure in `CONTRIBUTING.md` tells a maintainer which branch, CI result, or review is required (`CONTRIBUTING.md:3-7`, `:33-39`).

**Impact**

Even after fixing the lockfile, `npm run release -- 1.0.0` can create the stable tag without the capstone profile evidence. A typo can create a downgrade tag, and pre-existing unrelated package-manifest edits can be swept into the release commit. Treat this as a high release-engineering gap, not a reason to delete the useful script.

### Medium — CHANGELOG backfill misses a real semver release and overstates `1.0.0`

**Evidence**

- `git log -p -- package.json` shows a real `0.1.0 -> 0.2.0` version bump in commit `d5fb689`, followed by `0.2.0 -> 0.2.1` in `62e3cb1`.
- `CHANGELOG.md` has headings for `0.1.0` and `0.2.1` but none for `0.2.0` (`CHANGELOG.md:121-131`). This fails Epic 8.1's explicit DoD that every prior semver bump have an entry (`LATEST_PLAN_2026-08-04T042958Z.md:97-100`).
- The file presents `1.0.0` as a dated release section and calls it the “First stable release” (`CHANGELOG.md:12-25`) even though `package.json` and tags remain `0.9.0`. A staged unreleased entry should be clearly marked pending or remain under Unreleased until cut.

### Medium — actual MkDocs build coverage was replaced by a link checker

**Evidence**

- Epic 3.3 requires `python -m mkdocs build` to succeed (`LATEST_PLAN_2026-08-04T042958Z.md:57-58`).
- `docs-nav-check.mjs` explicitly calls itself an offline stand-in (`kit/docs-nav-check.mjs:1-9`) and checks file existence plus a simple Markdown-link regex (`:27-90`). It does not parse MkDocs configuration or render Markdown.
- Both CI workflows run `npm run docs:check` but never install `requirements-docs.txt` or run `npm run docs:build` (`.github/workflows/ci.yml:9-25`; `.gitea/workflows/ci.yml:8-22`).
- `docs/roadmap.md:29-31` acknowledges this substitution as though MkDocs were not implementable under offline constraints. That may explain the earlier implementation session, but CI already installs npm packages over the network and can install the pinned docs requirements; the release criterion remains untested.

**Impact**

Broken MkDocs YAML/theme/rendering behavior can pass every current CI job. Keep the fast offline checker, but add a real strict build job before stable release.

### Medium — generated extension documentation advertises quarantined stubs as real capabilities

**Evidence**

- `docs/EXTENSIONS.md` omits a Status column (`:7-8`). It describes `mcp-router` as providing routing/failover and `remote-review` as performing reviewer escalation (`:15`, `:23`), with only an empty Profiles cell indicating quarantine.
- Their manifests explicitly mark them `stub`, with no profiles (`extensions/mcp-router/extension.json`; `extensions/remote-review/extension.json:3-25`).
- `docs/install-surfaces.md` goes further and still says the lite surface includes “MCP router” (`docs/install-surfaces.md:7-18`), while `surfaces/lite.json:7-22` contains no `mcp-router`.

**Impact**

Epic 1 correctly removed stubs from runtime profiles, but the user-facing catalogue still presents their aspirational summaries without the status needed to interpret them. Add status to the generated table and make stub summaries explicitly say unavailable/quarantined; remove the false lite bullet.

### Medium — repository contribution contract requires README files that seven extensions lack

**Evidence**

- `CONTRIBUTING.md:9-16` says every extension has a `README.md` explaining behavior and requirements.
- Filesystem audit found no README for: `autonomous-loop`, `context-sieve`, `dual-review`, `memory-local`, `memory-mem0`, `orchestrator`, and `verify-gate`.
- `verify.mjs` enforces manifests and source constraints but does not enforce this documented README contract (`docs/WRITING_EXTENSIONS.md:38-57`).

**Impact**

The overall `extensions/skills/vendor/profiles/kit/docs` split is understandable, but extension-level documentation is inconsistent precisely for several central mechanisms. Either enforce the stated contract or relax it and ensure the generated catalogue/manifests contain all required operator information.

### Medium — production-readiness plan omitted key runtime and supply-chain release evidence

This is a gap in the plan itself, not merely its implementation:

- Most core value is implemented through Pi hooks/commands, yet the plan allowed the capstone to close without a real installed-package load smoke. Offline fixtures are valuable but cannot establish API/lifecycle integration. This gap is exposed by the Epic 9 substitution above.
- Supply-chain work is limited to exact external package versions and non-blocking `npm audit` (`docs/supply-chain.md:7-38`). It does not require an SBOM, artifact hashes/attestation, license inventory, tag/commit signing, or immutable provenance for all vendored sources. For example, `vendor/caveman/SOURCE.md` names a GitHub repository and date but no commit SHA.
- The plan contains no rollback/deprecation/migration criteria for a stable public extension/profile contract and no release artifact verification after tagging.

For an internal Git-distributed package these need not all block `1.0.0`, but the release plan should explicitly choose which guarantees are in scope rather than equating a non-blocking audit with complete supply-chain maturity.

### Low — several current profile descriptions retained pre-Epic-6 wording

- `profiles/self-improving.json:3-4` says skill-forge/self-improvement “require external services or land across Epics 6+,” although both are now `beta` implementations and Epic 6 is claimed complete.
- README and install docs imply the whole self-improving profile “needs Docker” (`README.md:58`; `docs/getting-started.md:47`; `docs/INSTALL.md:38-51`), while the actual Docker/mem0 requirement belongs to the experimental `memory-mem0` component and the deterministic skill-forge/self-improvement paths do not need it.

Clarify required versus optional/experimental services so a newcomer does not assume all T4 features depend on Docker or a second model.

### Nice-to-have — reduce navigation ambiguity between current guides and historical/design material

The top-level folder organization is sound, and grouping MkDocs into Guides / Design & Roadmap / Reference is an improvement. The remaining ambiguity is lifecycle labeling:

- `docs/building-extensions.md` and `docs/WRITING_EXTENSIONS.md` overlap but serve different depths; make that short-guide/reference distinction explicit in titles.
- Historical `PI_KIT_REPO_PLAN.md` is correctly bannered and nav-labeled superseded (`docs/PI_KIT_REPO_PLAN.md:1-9`, `mkdocs.yml`), but the old skills plan is not similarly labeled.
- Consider separating active roadmap, completed plans, research, and specifications into explicit nav groups so “design,” “historical,” and “current behavior” are visually unmistakable.

## Part A corrections — item-by-item result

| Part A item | Result against HEAD | Evidence / qualification |
|---|---|---|
| 1. Firewall default allow-all | **Resolved in source** | Built-in fallback denies; shipped policy defaults unknown to ask (`extensions/tool-firewall/index.ts:35-38`; `extensions/tool-firewall/default-policy.json:4`). Functional bypass resistance belongs to Reviewer A. |
| 2. `remote-review` stub shipped | **Runtime quarantine resolved; docs incomplete** | Manifest is `stub`, profiles empty, no profile/surface references. Generated catalogue still advertises the capability without status (`docs/EXTENSIONS.md:23`). |
| 3. Manifest/profile drift | **Resolved/enforced** | Bidirectional check at `kit/verify.mjs:221-298`; generated capability matrix matches manifests/profiles. |
| 4. No tags/CHANGELOG | **Partially resolved** | `v0.9.0` and changelog exist, but docs point to nonexistent `v0.1.0`, historical tags remain absent, and changelog omits actual `0.2.0`. |
| 5. Uncalibrated status | **Resolved for shipped profiles** | Stable/beta used in non-experimental profiles; experimental/stub confined to experimental self-improving or no profiles. Catalogue should expose status. |
| 6. Regex-only secret guard | **Source/docs indicate resolved** | Content patterns and transfer verbs exist (`extensions/secret-guard/index.ts:46-62`). Behavioral robustness belongs to Reviewer A. |
| 7. Skills catalogue drift framing | **Resolved/enforced** | Generated banner and drift check exist (`kit/skills-catalogue.mjs:81-128`; `kit/verify.mjs:422-445`). |
| 8. Untested Pi range | **Only partially credible** | Floor/ceiling workflow exists (`.github/workflows/ci.yml:53-67`), but the committed lockfile contradicts the floor pin and `npm ci` fails. Peer range remains open-ended (`package.json:27-34`), so “ceiling” is tested, not enforced for consumers. |

The statement “All eight resolved” in `docs/roadmap.md:22-27` should therefore be changed: #4 and #8 remain incomplete as release guarantees, and #2 retains a documentation defect.

## Per-angle synthesis

### Organization

The main split—`extensions/`, `vendor/`, `skills/`, `profiles/`, `surfaces/`, `kit/`, and `docs/`—is understandable and scales reasonably. Generated skills and capability catalogues reduce drift. Weak points are lifecycle labeling of old plans, inconsistent per-extension READMEs, and a generated extension catalogue that does not surface maturity/status.

### Documentation

Navigation and relative links pass the lightweight checker, and several core references (`ARCHITECTURE`, `MODULARITY`, `WRITING_EXTENSIONS`, security limitations) are usefully structured. Truthfulness is not at release quality: the capstone roadmap overstates completion, two roadmap/plan pages contain obsolete current-state claims, the lite onboarding path is internally contradictory, and stub capabilities remain advertised as real.

### Release readiness

There is now a local annotated tag, a changelog, duplicate GitHub/Gitea CI definitions, a version-compatibility matrix, and a release script that deliberately never pushes. Those are good foundations. They do not yet constitute a reliable release: clean install is broken by the lockfile; the cutter does not maintain it or enforce the capstone; the profile matrix is not the promised regression; actual docs rendering is absent; and the documented portable tag does not exist.

## Recommended fix order for the implementation pass

1. Synchronize and commit `package-lock.json`; change CI to `npm ci`; make the release script update/stage the lockfile and fail if a clean install is not reproducible.
2. Implement the actual Epic 9.1 per-profile/per-surface install + verify + eval matrix on Windows and Linux. Retain `profile-check` as a fast metadata precheck, not the regression itself.
3. Add an authorized, non-provider-dependent Pi extension-load smoke and require its evidence (plus independent review) before `v1.0.0`.
4. Make every lite install path use `npm run install:lite` or include the missing surface `npm install`; strengthen docs smoke to test the combined safe workflow.
5. Correct roadmap/security/changelog wording to “1.0.0 candidate; tag pending” until release. Close or explicitly defer every stale improvement item; mark the old skills plan completed/historical.
6. Update portable Git examples to the first real tag/current stable tag and add the missing `0.2.0` changelog entry.
7. Harden `release.mjs`: monotonic semver, exact expected file changes, branch/HEAD policy, capstone/profile gate, lockfile handling, and a documented maintainer release procedure.
8. Add a real `mkdocs build --strict` CI job in addition to the fast offline link checker.
9. Add Status to generated `EXTENSIONS.md`, label/quarantine stubs visibly, remove the false MCP-router lite claim, and update profile requirement copy.
10. Enforce or revise the per-extension README contract, then decide and document the intended stable-release supply-chain assurances (SBOM/provenance/signing/licensing/rollback).

## Constraint confirmation

No remote push occurred. No tag was created, moved, or deleted. No live Pi agent, model backend, provider, or network call was invoked. Only this report was added by this reviewer; the pre-existing untracked `HANDOFF_PROMPT_FOR_V1_HARDENING.md` was preserved.
