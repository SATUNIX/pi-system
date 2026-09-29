/**
 * Untrusted-data marking (STD-AGT-02) and a deterministic prompt-injection
 * detector.
 *
 * Every collected source is wrapped in a per-run delimiter carrying a random
 * nonce. The nonce is created after the input is read but is never derivable
 * from the input, so a static payload cannot close the block early.
 */

export interface UntrustedSection {
  source: string;
  data: unknown;
}

const INJECTION_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: "ignore-previous-instructions", pattern: /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above)\s+instructions/i },
  { id: "disregard-previous", pattern: /disregard\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above)/i },
  { id: "role-override", pattern: /you\s+are\s+now\s+(?:a|an|the)\b/i },
  { id: "new-instructions", pattern: /(?:new|updated|revised)\s+instructions\s*:/i },
  { id: "system-prompt-spoof", pattern: /(?:^|\n)\s*(?:system|developer)\s*(?:prompt|message)?\s*:/i },
  { id: "assistant-spoof", pattern: /(?:^|\n)\s*assistant\s*:/i },
  { id: "execute-following", pattern: /execute\s+the\s+following/i },
  { id: "run-safe-action", pattern: /run\s+rollout-restart\b/i },
  { id: "exfiltrate", pattern: /(?:send|post|upload|exfiltrate)\b[^\n]{0,60}\b(?:token|secret|credential|password|api[_-]?key)\b/i },
];

function serialize(data: unknown): string {
  if (typeof data === "string") return data;
  if (data === undefined) return "";
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

export function buildSections(input: unknown): UntrustedSection[] {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const sections = Object.entries(input as Record<string, unknown>).map(([source, data]) => ({ source, data }));
    return sections.length > 0 ? sections : [{ source: "input", data: input }];
  }
  return [{ source: "input", data: input }];
}

export function wrapUntrusted(nonce: string, section: UntrustedSection): string {
  const begin = `<<<UNTRUSTED:${nonce}:${section.source}>>>`;
  const end = `<<<END_UNTRUSTED:${nonce}>>>`;
  return `${begin}\n${serialize(section.data)}\n${end}`;
}

export function buildUntrustedBlock(nonce: string, input: unknown): string {
  return buildSections(input)
    .map((section) => wrapUntrusted(nonce, section))
    .join("\n\n");
}

/** Return the matched injection pattern ids (deduplicated, stable order). */
export function detectInjections(text: string): string[] {
  const hits: string[] = [];
  for (const { id, pattern } of INJECTION_PATTERNS) {
    if (pattern.test(text) && !hits.includes(id)) hits.push(id);
  }
  return hits;
}

export function randomNonce(randomUUID: () => string = () => crypto.randomUUID()): string {
  return randomUUID();
}
