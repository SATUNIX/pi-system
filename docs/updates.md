# Updates

A pi setup has three parts that update separately:

| Part | What it is | Where it comes from |
|---|---|---|
| **pi** | The agent binary, TUI and session model | `@earendil-works/pi-coding-agent` on npm |
| **pi-system** | This kit: extensions, skills, prompts, profiles, themes | Its git repository (`gitlab.home.internal/lab/pi-system`), on a channel |
| **Linked packages** | Other pi packages in your settings, including the kit's companions (`pi-lens`, `pi-readseek`, ...) | npm |

A **profile** is not a part: it is a setting that chooses what loads from the kit (see
[Profiles](profiles.md)). Updates keep your profile.

## `/update`

The `kit-update` extension, loaded in every profile, checks all three parts.

- **In the background**: at most once a day at session start. It never delays startup and never
  prompts for git credentials. When something can be updated you get one notice, and the status
  bar shows `updates: /update`.
- **On demand**: `/update` checks now and lists what can be updated.

| Command | What it does |
|---|---|
| `/update` | Check now, then pick: everything, pi-system, pi, linked packages, or a channel switch |
| `/update status` | Installed and available versions for every part |
| `/update all` | Update pi-system and linked packages, re-apply your profile, reload; then update pi |
| `/update kit`, `/update pi`, `/update packages` | Update one part |
| `/update channel latest` / `next` / `X.Y.Z` | Follow the other channel, or pin a release |

Everything asks for confirmation first, stops at the first failed step, and only reloads when
every step succeeded. A new pi version needs a restart of pi; everything else reloads in place.

After pi-system updates, your recorded profile is re-applied, so extensions a new release adds to
your profile load, and companions move to the kit's newly reviewed pins.

## Channels

| Channel | Registered in pi as | Gets |
|---|---|---|
| `latest` | `git:gitlab.home.internal/lab/pi-system@v<newest release>` | The newest release tag. Betas count until the first stable release; after that, only stable releases |
| `next` | `git:gitlab.home.internal/lab/pi-system` (no tag) | Every commit on `main` |
| pinned | `git:gitlab.home.internal/lab/pi-system@v0.2.1-beta.0` | Exactly that release, never moved automatically |

`latest` and a pin look the same in pi's settings (a tag). The installer records which one you
chose in `~/.pi/agent/.pi-kit.json`, and `/update` follows that record.

Switch with `/update channel <name>`. The switch keeps your profile. Moving from `next` back to
`latest` can install an older commit than you have now; that is expected.

## Settings

| Variable | Effect |
|---|---|
| `PI_KIT_UPDATE_CHECK=0` | No background check (`/update` still works) |
| `PI_KIT_UPDATE_CHECK_HOURS` | Hours between background checks (default 24) |
| `PI_SYSTEM_GIT_SOURCE` | Git source of the kit, e.g. `git:git@gitlab.home.internal:lab/pi-system` to use SSH |
| `PI_KIT_DELIVERY` | `git` or `npm`: override the kit's delivery on this machine |
| `PI_KIT_NPM_REGISTRY` | Registry to query for pi and linked packages (default `https://registry.npmjs.org`) |
| `PI_OFFLINE` | pi's offline mode: no background check |

## Without the extension

The same updates from a shell:

```sh
pi update --self                                                   # pi
pi install git:gitlab.home.internal/lab/pi-system@v0.2.1-beta.1   # the kit, to a new release (latest or a pin)
pi update git:gitlab.home.internal/lab/pi-system                  # the kit, on next
pi update --extensions                                             # every unpinned package
node ~/.pi/agent/git/gitlab.home.internal/lab/pi-system/packages/core/install.mjs --profile balanced --yes --settings-only
                                                                   # re-apply a profile (and companion pins)
```

To find the newest release tag: `git ls-remote --tags https://gitlab.home.internal/lab/pi-system.git`.

## Checkouts

A **checkout** registered in place for development: `/update kit` runs `git pull --ff-only`,
re-applies the profile and reloads. Uncommitted work blocks nothing: a fast-forward either
applies cleanly or fails without changing anything. It is reported as behind only when its
upstream branch has commits the checkout does not contain.

`/update channel latest` (or `next`) from a checkout registers the released kit instead of the
checkout. The installer keeps exactly one registered copy of the kit: any other copy (another
checkout, the npm package, an old `dist/pi-kit-*` export) would load every extension twice.

## Delivery

Where releases come from is set in `packages/core/distribution.json` (`"delivery": "git"`
today). npm delivery (`@satunix/pi-system` dist-tags) is built but paused; see
[Releasing](releasing.md#switching-to-npm-delivery). When a kit release changes the delivery,
`/update kit` moves each install over, keeping its channel and profile.

### Moving from `root/pi-system`

The kit moved from `gitlab.home.internal/root/pi-system` (now archived, still readable) to
`gitlab.home.internal/lab/pi-system`. An install from the old project keeps working at its pin but
never sees new releases, because its own `distribution.json` still names the old project. Move it
once from a shell, with pi closed:

```sh
pi install git:gitlab.home.internal/lab/pi-system@v0.2.1-beta.0     # or a newer tag
node ~/.pi/agent/git/gitlab.home.internal/lab/pi-system/packages/core/install.mjs --profile balanced --yes --settings-only
```

Use the profile you run (`/profile` shows it). The installer keeps one registered copy of the
kit, so it removes the old `root/pi-system` entry.
