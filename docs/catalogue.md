# Catalogue

The catalogue is the generated library of extensions, skills and profiles in this repository.

## Generated catalogue

Run:

```sh
npm run catalog
```

This writes `docs/EXTENSIONS.md`, `docs/skills-catalogue.md` and `docs/capability-matrix.md`
(and `docs/registry.json`, which is not committed). `npm run verify` fails when any of them is
stale. See [Extension Catalogue](EXTENSIONS.md) for the current table.

## Package products

The whole catalogue ships as one pi package, delivered from its git repository. Profiles
(`packages/kit/profiles/*.json`) choose what loads, including `lite` for small models. See
[Profiles](profiles.md) and [Releasing](releasing.md). The [Roadmap](roadmap.md) is the current
statement of direction.
