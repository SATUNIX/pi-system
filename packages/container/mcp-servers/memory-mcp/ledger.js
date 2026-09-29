import fs from "node:fs";
import path from "node:path";

function dataRoot() {
  return process.env.PI_KIT_MEMORY_MCP_DATA_ROOT
    || process.env.PI_AGENT_DATA_ROOT
    || path.join(process.cwd(), ".pi", "memory-mcp");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLastChainRecord(file) {
  if (!fs.existsSync(file)) return { sequence: 0, record_hash: "" };
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return { sequence: 0, record_hash: "" };
  const parsed = JSON.parse(lines[lines.length - 1]);
  return {
    sequence: Number(parsed.sequence || 0),
    record_hash: String(parsed.record_hash || "")
  };
}

function readJsonlTail(file, limit) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(isRecord);
}

function parseCliJson(raw) {
  if (raw === undefined || raw === "") return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid --call params JSON: ${error.message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error("invalid --call params JSON: expected a JSON object");
  }
  return parsed;
}

export { dataRoot, parseCliJson, readJsonlTail, readLastChainRecord };