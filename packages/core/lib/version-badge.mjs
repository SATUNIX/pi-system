// The README's version badge (a static shields.io badge). release.mjs rewrites it with the
// version bump, and the docs smoke test fails if it disagrees with package.json.

const BADGE = /(https:\/\/img\.shields\.io\/badge\/version-)((?:[^-_?)\s]|--|__)+)(-[0-9A-Za-z]+)/;

// shields.io static badges use `-` as the field separator: a literal `-` is `--`, `_` is `__`.
const escapeField = (text) => text.replace(/-/g, "--").replace(/_/g, "__");
const unescapeField = (text) => text.replace(/--/g, "-").replace(/__/g, "_");

/** The version the README's badge shows, or null when it has none. */
export function readmeBadgeVersion(readme) {
  const match = readme.match(BADGE);
  return match ? unescapeField(match[2]) : null;
}

/** The README with its version badge set to `version`; unchanged when it has no badge. */
export function setReadmeBadgeVersion(readme, version) {
  return readme.replace(BADGE, (_all, prefix, _old, color) => `${prefix}${escapeField(version)}${color}`);
}
