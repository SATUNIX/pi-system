/**
 * Error taxonomy for the role runner.
 *
 * The exit codes are part of the 08 §7 interface contract and are asserted by
 * the offline contract test:
 *   0  ok
 *   10 escalate (a valid result.json with escalate=true was written)
 *   20 invalid input (argv, input file, contract, prompt or schema)
 *   30 budget/limit or LLM rate limit
 *   1  any other failure
 */

export type RunnerErrorKind = "invalid_input" | "budget" | "failure";

const EXIT_CODES: Record<RunnerErrorKind, number> = {
  invalid_input: 20,
  budget: 30,
  failure: 1,
};

export class RunnerError extends Error {
  readonly kind: RunnerErrorKind;
  readonly exitCode: number;
  readonly details: unknown;

  constructor(message: string, kind: RunnerErrorKind, details?: unknown) {
    super(message);
    this.name = "RunnerError";
    this.kind = kind;
    this.exitCode = EXIT_CODES[kind];
    this.details = details ?? null;
  }
}

export class InvalidInputError extends RunnerError {
  constructor(message: string, details?: unknown) {
    super(message, "invalid_input", details);
    this.name = "InvalidInputError";
  }
}

export class BudgetLimitError extends RunnerError {
  constructor(message: string, details?: unknown) {
    super(message, "budget", details);
    this.name = "BudgetLimitError";
  }
}
