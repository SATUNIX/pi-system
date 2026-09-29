// Pure, dependency-light provider resolution for the live evaluation runner.
// Kept separate from run.mjs so it can be exercised offline in tests.
import fs from "node:fs";

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function resolveProvider(modelsFile, providerName) {
  const parsed = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
  if (!isPlainObject(parsed)) throw new Error("models file is not a JSON object");
  if (!isPlainObject(parsed.providers)) throw new Error("models file has no providers map");
  const provider = parsed.providers[providerName];
  if (!provider) throw new Error("Requested provider is not configured");
  if (!isPlainObject(provider) || !Array.isArray(provider.models) || typeof provider.models?.[0]?.id !== "string" || provider.models[0].id.length === 0) {
    throw new Error(`provider "${providerName}" has no usable model id`);
  }
  return provider;
}
