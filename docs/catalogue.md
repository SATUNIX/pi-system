# Catalogue

The catalogue is the source library of extensions in this repo.

## Generated Catalogue

Run:

```powershell
npm run catalog
```

```sh
npm run catalog
```

This writes:

- `docs/EXTENSIONS.md`
- `docs/registry.json`

See [Extension Catalogue](EXTENSIONS.md) for the current generated table.

## Package Products

The whole catalogue ships as one pi package, delivered from its git repository. Profiles
(`packages/kit/profiles/*.json`) choose what loads, including `lite` for small models. See
[Profiles](profiles.md) and [Releasing](releasing.md).

## Historical Notes

Older `_consolidation` notes and `docs/PI_KIT_REPO_PLAN.md` remain useful history, but [Roadmap](roadmap.md) is the current source of truth for package direction.
