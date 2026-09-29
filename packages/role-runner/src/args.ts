/**
 * `pi run` argument parsing.
 *
 * Usage (08 §7):
 *   pi run --role <role> --workflow <workflow> \
 *     --input /inputs/context.json --output /outputs/result.json
 *
 * Environment fallbacks make the pod spec smaller; explicit flags win. The
 * LiteLLM base URL is configuration and may be overridden in rehearsal; the
 * default is the service address in 08 §7.
 */
import { type RoleName, isRoleName } from "./contract.ts";
import { InvalidInputError } from "./errors.ts";
import type { RunOptions } from "./run.ts";

export const DEFAULT_LITELLM_BASE_URL = "http://litellm.app-ai.svc:4000";
export const DEFAULT_ROLES_DIR = "/opt/pi-system/roles";
export const DEFAULT_INPUT_PATH = "/inputs/context.json";
export const DEFAULT_OUTPUT_PATH = "/outputs/result.json";
export const DEFAULT_TIMEOUT_SECONDS = 300;

export interface ParsedCli {
  action: "run" | "help";
  options?: RunOptions;
}

const VALUE_FLAGS: Record<string, keyof RawOptions> = {
  "--role": "role",
  "--workflow": "workflow",
  "--input": "input",
  "--output": "output",
  "--roles-dir": "rolesDir",
  "--contract": "contractPath",
  "--model": "model",
  "--llm-base-url": "baseUrl",
  "--timeout": "timeout",
  "--run-id": "runId",
};

interface RawOptions {
  role?: string;
  workflow?: string;
  input?: string;
  output?: string;
  rolesDir?: string;
  contractPath?: string;
  model?: string;
  baseUrl?: string;
  timeout?: string;
  runId?: string;
  stub?: boolean;
}

const WORKFLOW_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function parseCli(argv: string[], env: Record<string, string | undefined>): ParsedCli {
  const args = [...argv];
  if (args[0] === "run") args.shift();
  if (args.length === 0) return { action: "help" };
  if (args.includes("--help") || args.includes("-h")) return { action: "help" };

  const raw: RawOptions = {
    role: env.PI_ROLE,
    workflow: env.PI_WORKFLOW,
    input: env.PI_INPUT,
    output: env.PI_OUTPUT,
    rolesDir: env.PI_ROLES_DIR,
    model: env.PI_MODEL,
    baseUrl: env.PI_LITELLM_BASE_URL,
    runId: env.PI_RUN_ID,
    stub: env.PI_RUNNER_STUB === "1" || env.PI_RUNNER_STUB === "true",
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--stub") {
      raw.stub = true;
      continue;
    }
    const flag = VALUE_FLAGS[arg];
    if (!flag) throw new InvalidInputError(`unknown argument: ${arg}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new InvalidInputError(`argument ${arg} requires a value`);
    }
    raw[flag] = value;
    i += 1;
  }

  const role = raw.role ?? "";
  if (!isRoleName(role)) {
    throw new InvalidInputError(`--role must be one of: sentinel, builder, reviewer, auditor, gardener, reporter, scribe`);
  }
  const workflow = raw.workflow ?? "";
  if (!WORKFLOW_RE.test(workflow)) throw new InvalidInputError(`--workflow must match ${WORKFLOW_RE.source}`);

  const timeout = raw.timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(raw.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 3600) {
    throw new InvalidInputError("--timeout must be a number of seconds between 1 and 3600");
  }

  const runId = raw.runId ?? "";
  if (runId !== "" && !RUN_ID_RE.test(runId)) throw new InvalidInputError(`--run-id must match ${RUN_ID_RE.source}`);

  const options: RunOptions = {
    role: role as RoleName,
    workflow,
    runId,
    inputPath: raw.input ?? DEFAULT_INPUT_PATH,
    outputPath: raw.output ?? DEFAULT_OUTPUT_PATH,
    rolesDir: raw.rolesDir ?? DEFAULT_ROLES_DIR,
    contractPath: raw.contractPath,
    stub: raw.stub === true,
    baseUrl: raw.baseUrl ?? DEFAULT_LITELLM_BASE_URL,
    apiKey: env.PI_LITELLM_API_KEY,
    model: raw.model,
    timeoutSeconds: timeout,
  };
  return { action: "run", options };
}

export const USAGE = `Usage: pi run --role <role> --workflow <workflow> [options]

Options:
  --input <path>         Context JSON (default ${DEFAULT_INPUT_PATH})
  --output <path>        Result JSON (default ${DEFAULT_OUTPUT_PATH})
  --roles-dir <path>     Role contracts (default ${DEFAULT_ROLES_DIR})
  --contract <path>      Explicit agent-role.yaml (default <roles-dir>/<role>/)
  --model <alias>        LiteLLM model alias (default first in contract)
  --llm-base-url <url>   LiteLLM base URL (default ${DEFAULT_LITELLM_BASE_URL})
  --timeout <seconds>    Per-run LLM timeout (default ${DEFAULT_TIMEOUT_SECONDS})
  --run-id <id>          Run identifier (default generated)
  --stub                 Do not call an LLM; emit a deterministic stub result

Environment: PI_ROLE PI_WORKFLOW PI_INPUT PI_OUTPUT PI_ROLES_DIR PI_MODEL
             PI_RUN_ID PI_RUNNER_STUB PI_LITELLM_BASE_URL
             PI_LITELLM_API_KEY or PI_LITELLM_API_KEY_FILE

Exit codes: 0 ok, 10 escalate, 20 invalid input, 30 budget/limit, 1 failure.`;
