// A small argument parser for cli.mjs: `--flag value`, `--flag=value`, repeated flags, booleans.
// Unknown flags are errors, so a typo never silently changes what a command does.

/**
 * @param {string[]} argv arguments after the command
 * @param {{ values?: string[], lists?: string[], flags?: string[] }} spec
 *   values: flags taking one value; lists: flags that may repeat; flags: booleans
 * @returns {{ opts: object, rest: string[] }}
 */
export function parseArgs(argv, { values = [], lists = [], flags = [] }) {
  const opts = {};
  const rest = [];
  const known = new Set([...values, ...lists, ...flags]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { rest.push(a); continue; }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq > 0 ? eq : undefined);
    if (!known.has(name)) throw Object.assign(new Error(`unknown option --${name}${suggest(name, known)}`), { code: "usage" });
    if (flags.includes(name)) {
      if (eq > 0) { const v = a.slice(eq + 1); opts[name] = !["false", "0", "no"].includes(v); } else opts[name] = true;
      continue;
    }
    let value;
    if (eq > 0) value = a.slice(eq + 1);
    else { value = argv[++i]; if (value === undefined || (value.startsWith("--") && value.length > 2)) throw Object.assign(new Error(`--${name} needs a value`), { code: "usage" }); }
    if (lists.includes(name)) (opts[name] ??= []).push(value); else opts[name] = value;
  }
  return { opts, rest };
}

function suggest(name, known) {
  const close = [...known].filter((k) => k.startsWith(name.slice(0, 3)) || name.startsWith(k.slice(0, 3)));
  return close.length ? ` (did you mean ${close.slice(0, 3).map((k) => `--${k}`).join(", ")}?)` : "";
}

export const num = (v, name) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw Object.assign(new Error(`--${name} must be a number (got ${JSON.stringify(v)})`), { code: "usage" });
  return n;
};
