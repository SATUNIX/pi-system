#!/usr/bin/env node
/**
 * B-033 regression pin: finish-reason-retry must annotate the raw provider error so pi's
 * REAL retry classifier accepts the rewritten message.
 *
 * The eval fixture (packages/core/eval/fixtures.mjs) only asserts the extension's own
 * RETRYABLE_PROVIDER_ERROR regex against its own toRetryableErrorMessage() output — a
 * circular check. The property that matters in production is whether pi's actual retry
 * classifier (isRetryableAssistantError) returns true for the annotated message,
 * otherwise the extension silently becomes a no-op.
 *
 * Classifier import: PRIMARY is `@earendil-works/pi-ai/compat`'s isRetryableAssistantError
 * (the exported compat surface). FALLBACK, if that import is unavailable in this process,
 * is the same function from `@earendil-works/pi-ai/utils/retry` (both resolve to
 * pi-ai/dist/utils/retry.js). The path actually used is printed below.
 *
 * B-040 composed-predicate pin: pi's host retry decision is _isRetryableError(), which
 * returns false when isContextOverflow(message, contextWindow) matches BEFORE consulting
 * isRetryableAssistantError. We therefore also pin isContextOverflow on the annotated
 * message, with the same compat/fallback import strategy, to catch an annotated message
 * that reads as retryable but would be suppressed as a context overflow in production.
 */
import assert from "node:assert/strict";
import { loadModule, fakePi } from "../packages/core/eval/harness.mjs";

let isRetryableAssistantError;
let classifierSource;
try {
  ({ isRetryableAssistantError } = await import("@earendil-works/pi-ai/compat"));
  classifierSource = "@earendil-works/pi-ai/compat";
} catch {
  ({ isRetryableAssistantError } = await import("@earendil-works/pi-ai/utils/retry"));
  classifierSource = "@earendil-works/pi-ai/utils/retry";
}
assert.equal(typeof isRetryableAssistantError, "function", "pi's real retry classifier must be importable");

let isContextOverflow;
let overflowSource;
try {
  ({ isContextOverflow } = await import("@earendil-works/pi-ai/compat"));
  overflowSource = "@earendil-works/pi-ai/compat";
} catch {
  ({ isContextOverflow } = await import("@earendil-works/pi-ai/utils/overflow"));
  overflowSource = "@earendil-works/pi-ai/utils/overflow";
}
assert.equal(typeof isContextOverflow, "function", "pi's real context-overflow classifier must be importable");

const RAW_ERROR_MESSAGE = "Provider finish_reason: error";
const rawMessage = () => ({ role: "assistant", stopReason: "error", errorMessage: RAW_ERROR_MESSAGE });

const mod = await loadModule("extensions/finish-reason-retry/index.ts");
assert.equal(typeof mod.toRetryableErrorMessage, "function", "toRetryableErrorMessage must be exported");
assert.equal(typeof mod.RETRYABLE_PROVIDER_ERROR, "object", "RETRYABLE_PROVIDER_ERROR must be exported");

// 1. The raw provider error is NOT retryable by pi's own classifier. If this ever becomes
//    true the extension is redundant, so the baseline must be asserted, not assumed.
assert.equal(isRetryableAssistantError(rawMessage()), false, `raw "${RAW_ERROR_MESSAGE}" must not be retryable (${classifierSource})`);

// 2. THE PIN: the annotated message MUST be retryable by pi's real classifier. This fails
//    if either pi's retry pattern or the extension's marker drifts to a non-matching value.
const rewritten = mod.toRetryableErrorMessage(RAW_ERROR_MESSAGE);
const annotated = { ...rawMessage(), errorMessage: rewritten };
assert.equal(isRetryableAssistantError(annotated), true, `annotated errorMessage must be retryable by ${classifierSource}: ${rewritten}`);

// 2b. B-040 composed-predicate pin: pi's host retry decision is _isRetryableError(),
//     which negates isContextOverflow before consulting isRetryableAssistantError. The
//     annotated message must clear BOTH gates, or the extension becomes a no-op in
//     production while assertion 2 alone stays green.
const CONTEXT_WINDOW = 200000;
assert.equal(isContextOverflow(annotated, CONTEXT_WINDOW), false, `annotated errorMessage must not look like a context overflow (${overflowSource})`);
const hostWouldRetry = !isContextOverflow(annotated, CONTEXT_WINDOW) && isRetryableAssistantError(annotated);
assert.equal(hostWouldRetry, true, "the composed host predicate must retry the annotated message");

// 3. Driving the real message_end handler rewrites the target case...
const pi = fakePi();
mod.default(pi.api);
const out = await pi.handlers.get("message_end")({ message: rawMessage() });
assert.ok(out && out.message, "the target case must return a rewritten message");
assert.equal(out.message.errorMessage, rewritten, "handler must annotate with toRetryableErrorMessage()");
assert.equal(isRetryableAssistantError(out.message), true, "the handler output must be accepted by pi's retry classifier");

// ...and leaves every non-target case untouched (undefined).
const untouchedCases = [
  ["non-assistant role", { message: { role: "user", stopReason: "error", errorMessage: RAW_ERROR_MESSAGE } }],
  ["non-error stopReason", { message: { role: "assistant", stopReason: "stop", errorMessage: RAW_ERROR_MESSAGE } }],
  ["different error message", { message: { role: "assistant", stopReason: "error", errorMessage: "Provider finish_reason: content_filter" } }],
];
for (const [name, event] of untouchedCases) {
  assert.equal(await pi.handlers.get("message_end")(event), undefined, `${name} must return undefined`);
}

console.log(`PASS finish-reason-retry classifier pin (via ${classifierSource}): raw not retryable, annotated retryable, handler branches correct`);
