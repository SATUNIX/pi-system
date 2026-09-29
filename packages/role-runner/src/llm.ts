/**
 * LiteLLM client.
 *
 * The runner never talks to a model provider directly; provider keys live only
 * in LiteLLM (08 §7). The virtual key for the role is obtained by the container
 * entrypoint via OpenBao Kubernetes auth and exposed to the runner as an
 * environment variable or a file, never as a workflow parameter.
 *
 * The base URL is configuration, not a secret. The default is the address in
 * 08 §7; an override is required in rehearsal before the platform DNS exists.
 */
import { BudgetLimitError, InvalidInputError, RunnerError } from "./errors.ts";

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface LlmResponse {
  content: string;
  model: string;
  usage: LlmUsage;
}

export interface LlmCallOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  timeoutSeconds?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_SECONDS = 300;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export async function callLiteLlm(options: LlmCallOptions): Promise<LlmResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), (options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        max_tokens: 4096,
        messages: [
          { role: "system", content: options.systemPrompt },
          { role: "user", content: options.userPrompt },
        ],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new RunnerError(`LLM request failed: ${(error as Error).message}`, "failure");
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 429) {
    throw new BudgetLimitError("LiteLLM rate limit or budget exceeded (HTTP 429)");
  }
  if (!response.ok) {
    throw new RunnerError(`LLM request failed with HTTP ${response.status}`, "failure");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new RunnerError(`LLM response was not JSON: ${(error as Error).message}`, "failure");
  }
  const record = asRecord(body);
  const choices = record?.choices;
  const first = Array.isArray(choices) ? asRecord(choices[0]) : null;
  const message = asRecord(first?.message);
  const content = message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new RunnerError("LLM response did not contain message content", "failure");
  }
  const usage = asRecord(record?.usage);
  return {
    content,
    model: typeof record?.model === "string" ? record.model : options.model,
    usage: {
      input_tokens: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : 0,
      output_tokens: typeof usage?.completion_tokens === "number" ? usage.completion_tokens : 0,
      total_tokens: typeof usage?.total_tokens === "number" ? usage.total_tokens : 0,
    },
  };
}

/**
 * Extract the JSON object from a model reply. Models sometimes wrap JSON in a
 * prose sentence or a fenced code block; accept both but require a single
 * object.
 */
export function extractJsonObject(content: string): unknown {
  const trimmed = content.trim();
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(trimmed);
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // try the next candidate
    }
  }
  throw new RunnerError("model output did not contain a JSON object", "failure");
}

export function resolveApiKey(env: Record<string, string | undefined>, readFileSync: (path: string) => string): string {
  const inline = env.PI_LITELLM_API_KEY;
  if (inline && inline.trim() !== "") return inline.trim();
  const file = env.PI_LITELLM_API_KEY_FILE;
  if (file && file.trim() !== "") {
    let value: string;
    try {
      value = readFileSync(file).trim();
    } catch (error) {
      throw new InvalidInputError(`cannot read PI_LITELLM_API_KEY_FILE: ${(error as Error).message}`);
    }
    if (value !== "") return value;
  }
  throw new InvalidInputError("no LiteLLM key: set PI_LITELLM_API_KEY or PI_LITELLM_API_KEY_FILE");
}
