// Path globs for `permissions.writeAreas`. A deliberately small dialect: `**` matches any
// number of path segments (including none), `*` matches within one segment, `?` one character.
// Everything else is literal. Paths are repository-relative and use `/`.

const SPECIAL = /[.+^${}()|[\]\\]/g;

export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more whole segments; a trailing `**` matches the rest.
        if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(SPECIAL, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Why a glob is not acceptable as a write area, or null. */
export function globProblem(glob) {
  if (typeof glob !== "string" || !glob.trim()) return "must be a non-empty string";
  if (glob.length > 200) return "is longer than 200 characters";
  if (glob.startsWith("/") || /^[A-Za-z]:/.test(glob)) return "must be relative to the workspace";
  if (glob.includes("\\")) return "must use / as the separator";
  if (glob.split("/").includes("..")) return 'must not contain ".." segments';
  if (/[\0-\x1f]/.test(glob)) return "must not contain control characters";
  if (glob === ".git" || glob.startsWith(".git/")) return "must not target .git";
  return null;
}

export const normaliseRepoPath = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "");

/** Paths (repository-relative) that no glob in `areas` allows. */
export function pathsOutsideAreas(paths, areas) {
  const res = areas.map(globToRegExp);
  return paths.map(normaliseRepoPath).filter((p) => !res.some((re) => re.test(p)));
}
