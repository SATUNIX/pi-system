import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// pi's built-in auto-retry (settings.retry.enabled/maxRetries/baseDelayMs, see
// docs/settings.md "Retry") only retries an errored assistant message when its
// errorMessage matches a fixed regex in agent-session.js's _isRetryableError
// (overloaded, rate limit, 5xx, network/connection errors, timeouts, ...).
//
// OpenAI-completions-style providers (node_modules/@earendil-works/pi-ai's
// openai-completions.js mapStopReason) turn any finish_reason they don't
// recognize into stopReason "error" with errorMessage `Provider finish_reason:
// ${reason}`. OpenRouter (and other proxies) emit finish_reason "error" when the
// underlying model provider glitches mid-generation while still returning a 200 -
// a genuinely transient hiccup - but "Provider finish_reason: error" doesn't match
// any pattern in the built-in regex, so it surfaces as a hard failure that needs a
// manual "continue" instead of being retried.
//
// This rewrites just that one errorMessage so the existing regex matches, handing
// it to pi's own retry system - same exponential backoff, same attempt cap, and
// the counter already resets to 0 on the next successful assistant message
// (agent-session.js), so a run that errors again a few prompts later gets a fresh
// set of attempts rather than inheriting a used-up counter.
//
// Deliberately narrow: only the exact "error" finish_reason. content_filter and
// other unmapped finish_reasons are left alone - those are real terminal states,
// not glitches, and blindly retrying them could mask a genuine problem.
const TARGET_ERROR_MESSAGE = "Provider finish_reason: error";

// The literal the annotated message must contain for pi's `_isRetryableError` to
// classify it as retryable. Mirrors the `provider.?returned.?error` alternative in
// node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js's regex.
// The old annotation ("transient provider error") matched none of the alternatives,
// so this extension was a no-op: pi retried nothing.
const RETRYABLE_MARKER = "provider returned error";
export const RETRYABLE_PROVIDER_ERROR = /provider.?returned.?error/i;

/** Annotate the target error so pi's retry regex actually matches it. Exported for tests. */
export function toRetryableErrorMessage(errorMessage: string): string {
  return `${errorMessage} (${RETRYABLE_MARKER} — transient, retryable)`;
}

export default function (pi: ExtensionAPI) {
  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return undefined;
    if (event.message.stopReason !== "error") return undefined;
    if (event.message.errorMessage !== TARGET_ERROR_MESSAGE) return undefined;
    const errorMessage = toRetryableErrorMessage(event.message.errorMessage);
    // Guard: never hand pi a message its own retry regex will not match (that was the
    // original bug). If the annotation ever drifts, stay a no-op instead of lying.
    if (!RETRYABLE_PROVIDER_ERROR.test(errorMessage)) return undefined;
    return { message: { ...event.message, errorMessage } };
  });
}
