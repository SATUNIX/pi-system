# Releasing

pi-system is delivered from its git repository on the private GitLab,
`gitlab.home.internal/lab/pi-system`. pi installs it directly from there with the user's own
git credentials, so there is no package registry in between:

| Channel | What it is | How users get it |
|---|---|---|
| `next` | Every commit on `main` | Pushing to `main` is enough |
| `latest` | The newest `vX.Y.Z` tag (the newest stable one once a stable release exists; betas until then) | Push a tag |
| `X.Y.Z` | One tag, pinned | Push a tag |

The delivery is one setting, `delivery` in `packages/core/distribution.json` (`git` today). The
installer, `/profile` and `/update` read it, so switching to npm later is a change to that file
plus the npm setup below, not a code change.

## Cutting a release

```sh
# 1. On main, with a clean tree: add a "## [0.2.1-beta.1]" section to CHANGELOG.md and commit it.
# 2. Run the full gate, bump every package.json and the lockfile, commit, tag (local only):
npm run release -- 0.2.1-beta.1
# 3. Review the commit and tag, then push both:
git push origin main --follow-tags
```

`release.mjs` refuses to run on a dirty tree, without a CHANGELOG section, or when the version
does not move forward (prerelease-aware: `0.2.1-beta.0 < 0.2.1-beta.1 < 0.2.1`). It never
pushes. `npm run release -- 0.2.1-beta.1 --dry-run` runs every gate without changing anything.

**The first release** is the version already in `package.json` (`0.2.1-beta.0`). With no `v*`
tags yet, `npm run release -- 0.2.1-beta.0` tags it without a bump.

When the tag reaches GitLab, the pipeline (`.gitlab-ci.yml`):

1. runs the full check suite and every security scan for the tagged commit;
2. checks that the tag matches `package.json` and that its commit is on `main`;
3. writes the release notes (the CHANGELOG section plus install lines, from
   `packages/core/release-notes.mjs`) and creates a GitLab Release for the tag through the
   Releases API (`packages/core/gitlab-release.mjs`).

Every other pipeline runs the same path without writing (`release-preflight`), so a broken
release step shows up on a merge request, not on the tag.

Users on `latest` see the new release the next time `/update` checks (at most a day later, or
straight away with `/update`).

A tag is the release even if the pipeline fails: `/update` reads tags, not GitLab Releases. If
the pipeline fails for a tag, delete the tag (`git push origin :refs/tags/vX.Y.Z` and
`git tag -d vX.Y.Z`), fix the problem, and release again.

## Repository settings (GitLab)

- **Protect `main`**: Settings → Repository → Protected branches. Allowed to merge: Maintainers.
  Allowed to push: no one (or Maintainers, if you commit directly).
- **Protect tags `v*`**: Settings → Repository → Protected tags. Allowed to create: Maintainers.
- **Pipelines must succeed** before merging: Settings → Merge requests → Merge checks.
- **Runner**: the security jobs run container images (gitleaks, semgrep), so the runner needs
  a Docker executor that can pull from `ghcr.io` and Docker Hub.
- **Private certificate authority**: the release jobs call back to GitLab from inside their
  container (`git fetch`, the Releases API), which does not trust a private CA by itself.
  GitLab hands the runner's CA to jobs as `CI_SERVER_TLS_CA_FILE` when the runner has
  `tls-ca-file` set in its `config.toml` (or the CA in its `certs/` directory). If
  `release-preflight` fails with a certificate error, do that, or add a CI/CD variable
  `GITLAB_CA_FILE` of type File holding the CA (Settings → CI/CD → Variables).

## Giving someone access

Everyone who installs the kit needs read access to the repository: the Reporter role on the
project (or its group), plus an HTTPS token with `read_repository` or an SSH key. See
[Installation](INSTALL.md#access-to-the-repository). A deploy token (Settings → Repository →
Deploy tokens, scope `read_repository`) works for a shared machine or a container.

## What a release contains

The whole repository at the tag. pi runs `npm install --omit=dev` in its copy, which links the
workspace packages and installs their few runtime dependencies from the public npm registry.
Companion packages (`pi-lens`, `pi-readseek`, ...) are separate pi packages from npm, registered
by the installer at the kit's reviewed pins.

## Switching to npm delivery

Everything for npm is built and tested but paused: `.github/workflows/release.yml` publishes
`next` from `main` and releases from tags, with npm trusted publishing (OIDC, no stored token)
and provenance. To switch:

1. **npm**: an account with two-factor authentication, and the `satunix` organisation (it owns
   the `@satunix` scope).
2. **GitHub**: the public repository `SATUNIX/pi-system`. npm provenance only verifies public
   GitHub (or GitLab.com) repositories, not a private GitLab. Point `repository`, `homepage` and
   `bugs` in `package.json` at it; the package check (`npm run smoke:package`) enforces this
   once the delivery is `npm`. Add a GitHub environment named `npm`.
3. **Delivery**: set `"delivery": "npm"` in `packages/core/distribution.json`, and restore the
   `push` trigger in `.github/workflows/release.yml`.
4. **First publish**: npm only lets you attach a trusted publisher to a package that exists, so
   publish the first version by hand (`npm login`, then `npm publish --access public`).
5. **Trusted publishing**: on npmjs.com, package settings → Trusted Publisher → GitHub Actions:
   organisation `SATUNIX`, repository `pi-system`, workflow `release.yml`, environment `npm`.
   Then set publishing access to "Require two-factor authentication and disallow tokens".

The npm channels are dist-tags: `next` on every `main` commit (versions like
`0.2.1-beta.0.next.<UTC time>.g<sha>`), `latest` for releases, `beta` for prereleases once a
stable release exists, and `release-X.Y` for maintenance releases
(`packages/core/publish-plan.mjs`).

Existing installs move over by themselves: once they update to a release whose
`distribution.json` says `npm`, `/update kit` offers to move the install to npm, keeping its
channel and profile.

## Local checks

```sh
npm run check:all            # everything CI runs, including the delivery and update tests
npm run security:lockfile    # lockfile integrity
node packages/core/release-notes.mjs 0.2.1-beta.0   # preview the notes for a release
```
