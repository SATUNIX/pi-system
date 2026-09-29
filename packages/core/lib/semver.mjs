/**
 * Semver precedence for release tooling (no dependency on the `semver` package).
 * Build metadata is ignored; prerelease identifiers compare per the spec
 * (0.2.1-beta.0 < 0.2.1-beta.1 < 0.2.1-beta.10 < 0.2.1).
 */
export const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(v) {
  const m = SEMVER.exec(String(v ?? "").trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? null };
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`not semver: ${!pa ? a : b}`);
  for (const k of ["major", "minor", "patch"]) if (pa[k] !== pb[k]) return pa[k] - pb[k];
  if (!pa.prerelease || !pb.prerelease) return pa.prerelease ? -1 : pb.prerelease ? 1 : 0;
  const xa = pa.prerelease.split(".");
  const xb = pb.prerelease.split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]);
    const nb = /^\d+$/.test(xb[i]);
    if (na && nb && Number(xa[i]) !== Number(xb[i])) return Number(xa[i]) - Number(xb[i]);
    if (na !== nb) return na ? -1 : 1;
    if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}
