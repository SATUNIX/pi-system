/**
 * Role-runner orchestration: load config, wrap untrusted input, call the model
 * (or a deterministic stub), validate the result and write the outputs.
 */
import { dirname } from "node:path";
import {
  type RoleContract,
  type RoleName,
  loadRoleContract,
  roleContractPath,
  rolePromptPath,
  roleSchemaPath,
} from "./contract.ts";
import { buildUntrustedBlock, detectInjections } from "./context.ts";
import { BudgetLimitError, InvalidInputError, RunnerError } from "./errors.ts";
import { type LlmCallOptions, type LlmResponse, extractJsonObject } from "./llm.ts";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.ts";
import { type JsonSchema, validateSchema } from "./schema.ts";
import { type RunMetrics, renderMetrics } from "./telemetry.ts";

export interface RunOptions {
  role: RoleName;
  workflow: string;
  runId: string;
  inputPath: string;
  outputPath: string;
  rolesDir: string;
  contractPath?: string;
  stub: boolean;
  baseUrl: string;
  apiKey?: string;
  model?: string;
  timeoutSeconds: number;
}

export interface RunDeps {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  callLlm(options: LlmCallOptions): Promise<LlmResponse>;
  randomNonce(): string;
  now(): number;
  log(event: string, fields: Record<string, unknown>): void;
}

const EXIT_OK = 0;
const EXIT_ESCALATE = 10;
const EXIT_FAILURE = 1;
const EXIT_BUDGET = 30;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function injectionFindings(injections: string[]): Array<Record<string, unknown>> {
  return injections.map((id) => ({
    claim: `prompt-injection: ${id}`,
    evidence: [`untrusted input matched pattern ${id}`],
    severity: "high",
    status: "confirmed",
  }));
}

/** Deterministic result used for AGT-01 stub-LLM runs and as a fallback. */
export function stubResult(role: string, runId: string, injections: string[] = []): Record<string, unknown> {
  const base: Record<string, unknown> = {
    run_id: runId,
    role,
    summary: "stub result: no model call was made",
    confidence: 1,
    findings: injectionFindings(injections),
    escalate: injections.length > 0,
    escalation_reason: injections.length > 0 ? "prompt_injection_detected" : null,
    mr_plan: null,
  };
  const extras: Record<string, Record<string, unknown>> = {
    sentinel: { proposed_safe_actions: [] },
    reviewer: { verdict: "UNKNOWN", rollback_note: null },
    auditor: { controls: [] },
    builder: { branch: null, mr: null, changed_files: [], checks: [] },
    gardener: { updates: [] },
    reporter: { digest: "stub", metrics: {} },
    scribe: { docs_changed: [], catalog_updates: [] },
  };
  return { ...base, ...(extras[role] ?? {}) };
}

/** Fill harness-owned fields and merge detector findings before validation. */
export function normalizeResult(raw: unknown, role: string, runId: string, injections: string[]): Record<string, unknown> {
  if (!isRecord(raw)) throw new InvalidInputError("model output must be a JSON object");
  const result: Record<string, unknown> = { ...raw };
  if (typeof result.run_id !== "string" || result.run_id === "") result.run_id = runId;
  if (typeof result.role !== "string" || result.role === "") result.role = role;
  if (!Array.isArray(result.findings)) result.findings = [];
  if (typeof result.escalate !== "boolean") result.escalate = false;
  if (injections.length > 0) {
    const findings = result.findings as Array<Record<string, unknown>>;
    for (const finding of injectionFindings(injections)) {
      if (!findings.some((existing) => existing && existing.claim === finding.claim)) findings.push(finding);
    }
    // The detector is authoritative: a flagged injection always escalates.
    result.escalate = true;
    if (typeof result.escalation_reason !== "string" || result.escalation_reason === "") {
      result.escalation_reason = "prompt_injection_detected";
    }
  }
  // The contract escalates below 0.6 confidence; enforce it in code so a model
  // cannot silently under-report risk.
  if (typeof result.confidence === "number" && result.confidence < 0.6 && result.escalate !== true) {
    result.escalate = true;
    if (typeof result.escalation_reason !== "string" || result.escalation_reason === "") {
      result.escalation_reason = "low_confidence";
    }
  }
  return result;
}

async function writeOutputs(
  deps: RunDeps,
  options: RunOptions,
  result: unknown,
  metrics: RunMetrics,
): Promise<void> {
  await deps.mkdir(dirname(options.outputPath));
  await deps.writeFile(options.outputPath, `${JSON.stringify(result, null, 2)}\n`);
  await deps.writeFile(`${dirname(options.outputPath)}/metrics.prom`, renderMetrics(metrics));
}

function baseMetrics(options: RunOptions, exitCode: number, duration: number, usage: LlmResponse["usage"], injections: number): RunMetrics {
  return {
    run_id: options.runId,
    role: options.role,
    workflow: options.workflow,
    exit_code: exitCode,
    duration_seconds: Number(duration.toFixed(3)),
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    injection_findings: injections,
  };
}

/**
 * Run one role invocation. Returns the process exit code; never throws for a
 * contract/input/LLM problem, only for an unexpected programmer error.
 */
export async function runOnce(options: RunOptions, deps: RunDeps): Promise<number> {
  const started = deps.now();
  const fail = async (error: RunnerError): Promise<number> => {
    deps.log("run_error", { run_id: options.runId, role: options.role, kind: error.kind, message: error.message });
    return error.exitCode;
  };

  let contract: RoleContract;
  let prompt: string;
  let schema: JsonSchema;
  let input: unknown;
  try {
    const contractPath = options.contractPath ?? roleContractPath(options.rolesDir, options.role);
    contract = await loadRoleContract(contractPath, deps.readFile);
    if (contract.metadata.name !== options.role) {
      throw new InvalidInputError(`contract role ${contract.metadata.name} does not match --role ${options.role}`);
    }
    prompt = await deps.readFile(rolePromptPath(options.rolesDir, options.role));
    const schemaText = await deps.readFile(roleSchemaPath(options.rolesDir, options.role));
    schema = JSON.parse(schemaText) as JsonSchema;
    const inputText = await deps.readFile(options.inputPath);
    input = JSON.parse(inputText);
  } catch (error) {
    if (error instanceof RunnerError) return fail(error);
    if (error instanceof SyntaxError) return fail(new InvalidInputError(`cannot parse JSON input/schema: ${error.message}`));
    return fail(new InvalidInputError((error as Error).message));
  }

  const nonce = deps.randomNonce();
  const untrustedBlock = buildUntrustedBlock(nonce, input);
  const injections = detectInjections(untrustedBlock);
  const systemPrompt = buildSystemPrompt(prompt, contract);
  const userPrompt = buildUserPrompt(options.workflow, options.runId, untrustedBlock);
  const model = options.model ?? contract.spec.model.models[0];

  deps.log("run_start", { run_id: options.runId, role: options.role, workflow: options.workflow, model, injections });

  let raw: unknown;
  let usage: LlmResponse["usage"] = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

  if (options.stub) {
    raw = stubResult(options.role, options.runId, injections);
  } else {
    try {
      const response = await deps.callLlm({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey ?? "",
        model,
        systemPrompt,
        userPrompt,
        timeoutSeconds: options.timeoutSeconds,
      });
      usage = response.usage;
      raw = extractJsonObject(response.content);
    } catch (error) {
      const budget = error instanceof BudgetLimitError;
      const exit = budget ? EXIT_BUDGET : error instanceof RunnerError ? error.exitCode : EXIT_FAILURE;
      const fallback = normalizeResult(
        stubResult(options.role, options.runId, injections),
        options.role,
        options.runId,
        injections,
      );
      fallback.summary = budget ? "budget or rate limit exceeded" : "role run failed before a result was produced";
      fallback.escalate = true;
      fallback.escalation_reason = budget ? "budget_exceeded" : "run_failed";
      const duration = deps.now() - started;
      await writeOutputs(deps, options, fallback, baseMetrics(options, exit, duration, usage, injections.length));
      deps.log("run_error", {
        run_id: options.runId,
        role: options.role,
        kind: budget ? "budget" : "failure",
        message: error instanceof Error ? error.message : String(error),
      });
      return exit;
    }
  }

  let result: Record<string, unknown>;
  try {
    result = normalizeResult(raw, options.role, options.runId, injections);
  } catch (error) {
    return fail(error instanceof RunnerError ? error : new InvalidInputError((error as Error).message));
  }

  const schemaErrors = validateSchema(schema, result);
  const duration = deps.now() - started;
  if (schemaErrors.length > 0) {
    await writeOutputs(deps, options, result, baseMetrics(options, EXIT_FAILURE, duration, usage, injections.length));
    deps.log("result_invalid", { run_id: options.runId, role: options.role, errors: schemaErrors });
    return EXIT_FAILURE;
  }

  const exit = result.escalate === true ? EXIT_ESCALATE : EXIT_OK;
  await writeOutputs(deps, options, result, baseMetrics(options, exit, duration, usage, injections.length));
  deps.log("run_complete", {
    run_id: options.runId,
    role: options.role,
    workflow: options.workflow,
    exit_code: exit,
    duration_seconds: Number(duration.toFixed(3)),
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    injections,
  });
  return exit;
}
