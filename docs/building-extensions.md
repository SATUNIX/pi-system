# Building Extensions

Use the source catalogue when you want to add or change an extension.

## Scaffold

```powershell
npm run new -- my-extension
```

```sh
npm run new -- my-extension
```

This creates `packages/extensions/src/my-extension/`.

## Implement

Edit:

- `packages/extensions/src/my-extension/index.ts`
- `packages/extensions/src/my-extension/extension.json`

Keep the extension self-contained. Runtime code may import Node built-ins and declared package peers, but it must not import from sibling extensions or `packages/core/lib`.

## Verify

```powershell
npm run verify
```

```sh
npm run verify
```

## Update the Catalogue

```powershell
npm run catalog
```

```sh
npm run catalog
```

The generated catalogue appears in [Extension Catalogue](EXTENSIONS.md).

## Add to a Profile

To include an extension in a profile (for example `lite`), add its stable extension name to the
profile's `include` list in `packages/kit/profiles/<profile>.json` and to the `profiles` field
of its `extension.json`, then check:

```sh
npm run verify
npm run profile:check -- --profile lite
npm run smoke:package
```

For the full extension-writing reference, see [Writing Extensions](WRITING_EXTENSIONS.md).
