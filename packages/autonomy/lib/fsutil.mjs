// Small, dependency-free helpers shared by the run engine: atomic JSON files, canonical JSON
// (stable key order, so digests do not depend on how a file was written) and hashing.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** A short unpredictable suffix for temp files, container names and default run ids (crypto, not Math.random: a name that is guessable can be pre-created). */
export const randomSuffix = (chars = 6) => randomBytes(Math.ceil(chars / 2)).toString("hex").slice(0, chars);

/** Atomic JSON write (temp file + rename), so a crash never leaves half a state file. */
export function writeJsonAtomic(file, value, { mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomSuffix(6)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

export function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

/** JSON with object keys sorted recursively; arrays keep their order. */
export function canonicalJson(value) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, walk(v[k])]));
    return v;
  };
  return JSON.stringify(walk(value));
}

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export const isPlainObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Deep merge for configuration: objects merge, arrays and scalars are replaced by `over`. */
export function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

export const clone = (v) => JSON.parse(JSON.stringify(v));
