// Adapter for the kit's effort policy. The single source of truth is packages/core/lib/effort.mjs
// (tiers, aliases, clamping); this module only loads it, so a checkout without it fails closed
// with a clear message instead of validating effort against a private copy that could drift.
//
// API used (all from core): normalizeTier(input) -> canonical id | null, clampTier(requested, cap),
// loadEffortPolicy(), tierLimits(id), tierLabel(id). Tests inject an object with the same shape.
export let coreEffort = null;
export let coreEffortError = null;
try {
  coreEffort = await import("../../core/lib/effort.mjs");
} catch (error) {
  coreEffortError = error;
}

/** The effort API to use: an injected one (tests), else core's; null when neither is available. */
export function effortApi(injected) {
  return injected ?? coreEffort;
}

export const EFFORT_UNAVAILABLE = "effort policy unavailable: packages/core/lib/effort.mjs could not be loaded, so the effort tier cannot be validated";
