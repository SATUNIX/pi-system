/**
 * CLI entrypoint for `pi run` (08 §7).
 *
 * Wires the filesystem, clock, RNG and LiteLLM client into `runOnce`. Kept
 * small so the offline contract test can call `runCli` with `--stub` and no
 * network.
 */
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { USAGE, type ParsedCli, parseCli } from "./args.ts";
import { InvalidInputError } from "./errors.ts";
import { callLiteLlm, resolveApiKey } from "./llm.ts";
import { runOnce } from "./run.ts";
import { logEvent, redact } from "./telemetry.ts";

export interface CliOverrides {
  randomUUID?: () => string;
  fetchImpl?: typeof fetch;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export async function runCli(
  argv: string[],
  env: Record<string, string | undefined>,
  overrides: CliOverrides = {},
  cwdReadFile: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<number> {
  const stdout = overrides.stdout ?? ((line: string) => void process.stdout.write(line));
  const stderr = overrides.stderr ?? ((line: string) => void process.stderr.write(line));

  let parsed: ParsedCli;
  try {
    parsed = parseCli(argv, env);
  } catch (error) {
    stderr(`${redact((error as Error).message)}\n`);
    return error instanceof InvalidInputError ? error.exitCode : 1;
  }
  if (parsed.action === "help" || !parsed.options) {
    stdout(`${USAGE}\n`);
    return 0;
  }

  const options = parsed.options;
  if (options.runId === "") options.runId = (overrides.randomUUID ?? (() => crypto.randomUUID()))();
  if (!options.stub) {
    try {
      options.apiKey = resolveApiKey(env, (path) => readFileSync(path, "utf8"));
    } catch (error) {
      stderr(`${redact((error as Error).message)}\n`);
      return error instanceof InvalidInputError ? error.exitCode : 1;
    }
  }

  return runOnce(options, {
    readFile: cwdReadFile,
    writeFile: (path, data) => writeFile(path, data),
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    callLlm: (callOptions) => callLiteLlm({ ...callOptions, fetchImpl: overrides.fetchImpl }),
    randomNonce: overrides.randomUUID ?? (() => crypto.randomUUID()),
    now: () => Date.now(),
    log: (event, fields) => logEvent(event, fields, stderr),
  });
}
