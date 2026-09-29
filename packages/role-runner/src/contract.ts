/**
 * Role-contract loading and validation (08 §3).
 *
 * The runner reads the same `agent-role.yaml` that CTL-034 validates. Loading
 * fails closed (exit 20) on anything the runner would otherwise have to guess
 * about. The contract is configuration, not a secret: no credential value is
 * ever read from it, only the *path* at which a credential is obtained.
 */
import { InvalidInputError } from "./errors.ts";
import { parseYaml } from "./yaml-lite.ts";

export interface ModelBudget {
  daily_usd: number;
  per_run_tokens: number;
}

export interface ModelSpec {
  litellmKey: string;
  models: string[];
  budget: ModelBudget;
}

export interface RoleContract {
  apiVersion: string;
  kind: string;
  metadata: { name: string };
  spec: {
    image: string;
    entry: string;
    prompt: string;
    resultSchema: string;
    workTypes: string[];
    model: ModelSpec;
    kubernetes: {
      serviceAccount: string;
      clusterRole: string | null;
      namespaces: string[];
    };
    openbao: { authRole: string; tokenTTL: string; policy: string };
    gitlab: { user: string; tokenPath: string | null };
    tools: string[];
    egress: string[];
    escalation: { notifyOperatorOn: string[] };
    limits: { maxRuntime: string; maxConcurrent: number };
  };
}

export const ROLE_NAMES = [
  "sentinel",
  "builder",
  "reviewer",
  "auditor",
  "gardener",
  "reporter",
  "scribe",
] as const;

export type RoleName = (typeof ROLE_NAMES)[number];

const RUNTIME_EGRESS = ["litellm", "openbao"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRoleName(value: string): value is RoleName {
  return (ROLE_NAMES as readonly string[]).includes(value);
}

function requireObject(value: unknown, where: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new InvalidInputError(`${where} must be a mapping`);
  return value;
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidInputError(`${where} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new InvalidInputError(`${where} must be an array of strings`);
  }
  return value as string[];
}

/** Validate a parsed contract and narrow it to RoleContract. Throws exit-20. */
export function parseRoleContract(data: unknown): RoleContract {
  const root = requireObject(data, "agent-role contract");
  if (root.apiVersion !== "lab.tcd/v1") throw new InvalidInputError("apiVersion must be lab.tcd/v1");
  if (root.kind !== "AgentRole") throw new InvalidInputError("kind must be AgentRole");

  const metadata = requireObject(root.metadata, "metadata");
  const name = requireString(metadata.name, "metadata.name");
  if (!isRoleName(name)) throw new InvalidInputError(`unknown role in contract: ${name}`);

  const spec = requireObject(root.spec, "spec");
  requireString(spec.image, "spec.image");
  requireString(spec.entry, "spec.entry");
  requireString(spec.prompt, "spec.prompt");
  requireString(spec.resultSchema, "spec.resultSchema");

  const tools = requireStringArray(spec.tools, "spec.tools");
  if (new Set(tools).size !== tools.length) throw new InvalidInputError("spec.tools contains duplicates");
  if (tools.some((tool) => tool.startsWith("k8s.write") || tool.startsWith("secret."))) {
    throw new InvalidInputError("spec.tools contains a forbidden tool");
  }

  const egress = requireStringArray(spec.egress, "spec.egress");
  if (new Set(egress).size !== egress.length) throw new InvalidInputError("spec.egress contains duplicates");
  for (const endpoint of RUNTIME_EGRESS) {
    if (!egress.includes(endpoint)) throw new InvalidInputError(`spec.egress must include ${endpoint}`);
  }

  const workTypes = requireStringArray(spec.workTypes, "spec.workTypes");
  if (workTypes.length === 0) throw new InvalidInputError("spec.workTypes must not be empty");

  const model = requireObject(spec.model, "spec.model");
  requireString(model.litellmKey, "spec.model.litellmKey");
  const models = requireStringArray(model.models, "spec.model.models");
  if (models.length === 0) throw new InvalidInputError("spec.model.models must not be empty");
  const budget = requireObject(model.budget, "spec.model.budget");
  if (typeof budget.daily_usd !== "number" || typeof budget.per_run_tokens !== "number") {
    throw new InvalidInputError("spec.model.budget requires numeric daily_usd and per_run_tokens");
  }

  const kubernetes = requireObject(spec.kubernetes, "spec.kubernetes");
  const serviceAccount = requireString(kubernetes.serviceAccount, "spec.kubernetes.serviceAccount");
  if (serviceAccount !== `agent-${name}`) {
    throw new InvalidInputError(`serviceAccount must be agent-${name}`);
  }
  const openbao = requireObject(spec.openbao, "spec.openbao");
  if (openbao.authRole !== `agent-${name}`) throw new InvalidInputError(`OpenBao authRole must be agent-${name}`);
  if (openbao.tokenTTL !== "15m") throw new InvalidInputError("OpenBao tokenTTL must be 15m");

  const limits = requireObject(spec.limits, "spec.limits");
  requireString(limits.maxRuntime, "spec.limits.maxRuntime");
  if (typeof limits.maxConcurrent !== "number") throw new InvalidInputError("spec.limits.maxConcurrent must be a number");

  return root as unknown as RoleContract;
}

export function roleContractPath(rolesDir: string, role: string): string {
  return `${rolesDir.replace(/\/$/, "")}/${role}/agent-role.yaml`;
}

export function rolePromptPath(rolesDir: string, role: string): string {
  return `${rolesDir.replace(/\/$/, "")}/${role}/SYSTEM.md`;
}

export function roleSchemaPath(rolesDir: string, role: string): string {
  return `${rolesDir.replace(/\/$/, "")}/${role}/result.schema.json`;
}

/**
 * Read and parse a contract from disk. JSON is accepted as a pre-parsed
 * projection; YAML uses the built-in reader.
 */
export async function loadRoleContract(
  path: string,
  readFile: (file: string) => Promise<string> = (file) => import("node:fs/promises").then((fs) => fs.readFile(file, "utf8")),
): Promise<RoleContract> {
  let text: string;
  try {
    text = await readFile(path);
  } catch (error) {
    throw new InvalidInputError(`cannot read role contract ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = path.endsWith(".json") || text.trimStart().startsWith("{") ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    throw new InvalidInputError(`cannot parse role contract ${path}: ${(error as Error).message}`);
  }
  return parseRoleContract(parsed);
}
