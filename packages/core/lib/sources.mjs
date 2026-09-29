import fs from "node:fs";
import { SOURCES_PATH } from "./paths.mjs";

// Read packages/core/sources.json, or any similarly-shaped file. A missing file, invalid
// JSON, or a value that is not an object with an `external` array all fall back to the empty
// default `{ external: [] }`, so callers can dereference `external` without a shape guard.
export function readSources(file = SOURCES_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.external)) {
      return parsed;
    }
  } catch {
    /* defaults below */
  }
  return { external: [] };
}

export function getExternalByProfile(profile) {
  const { external } = readSources();
  return external.filter(e => e.profiles?.includes(profile));
}
