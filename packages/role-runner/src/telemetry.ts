/**
 * Structured telemetry (STD-AGT-03): one JSON log line per event on stderr,
 * plus a Prometheus text file the workflow's metrics emitter scrapes.
 *
 * Secret values are never passed here; `redact` is a belt-and-braces guard for
 * accidental key material in a message.
 */

export interface RunMetrics {
  run_id: string;
  role: string;
  workflow: string;
  exit_code: number;
  duration_seconds: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  injection_findings: number;
}

export function redact(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|pk)-[A-Za-z0-9]{8,}\b/g, "[REDACTED]");
}

export function logEvent(
  event: string,
  fields: Record<string, unknown>,
  write: (line: string) => void = (line) => process.stderr.write(line),
): void {
  const record: Record<string, unknown> = { ts: new Date().toISOString(), event, ...fields };
  write(`${redact(JSON.stringify(record))}\n`);
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function renderMetrics(metrics: RunMetrics): string {
  const labels = `run_id="${escapeLabel(metrics.run_id)}",role="${escapeLabel(metrics.role)}",workflow="${escapeLabel(metrics.workflow)}"`;
  const lines = [
    "# HELP pi_agent_run_exit_code Exit code of the role run.",
    "# TYPE pi_agent_run_exit_code gauge",
    `pi_agent_run_exit_code{${labels}} ${metrics.exit_code}`,
    "# HELP pi_agent_run_duration_seconds Wall-clock duration of the role run.",
    "# TYPE pi_agent_run_duration_seconds gauge",
    `pi_agent_run_duration_seconds{${labels}} ${metrics.duration_seconds}`,
    "# HELP pi_agent_tokens_total LLM tokens consumed by the role run.",
    "# TYPE pi_agent_tokens_total counter",
    `pi_agent_tokens_total{${labels},direction="input"} ${metrics.input_tokens}`,
    `pi_agent_tokens_total{${labels},direction="output"} ${metrics.output_tokens}`,
    `pi_agent_tokens_total{${labels},direction="total"} ${metrics.total_tokens}`,
    "# HELP pi_agent_prompt_injection_findings Number of injection patterns flagged in untrusted input.",
    "# TYPE pi_agent_prompt_injection_findings gauge",
    `pi_agent_prompt_injection_findings{${labels}} ${metrics.injection_findings}`,
    "",
  ];
  return lines.join("\n");
}
