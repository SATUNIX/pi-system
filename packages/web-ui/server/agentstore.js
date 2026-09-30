// agentstore.js — create / read / update / delete agent definition files.
//
// Agents are YAML-frontmatter markdown files. This module is the ONLY place that writes
// them, and it refuses any path that escapes the configured agent directories.
import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_DIRS } from "./config.js";
import { agentBody, resolveAgent } from "./agents.js";
import { HttpError } from "./validate.js";

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Directory for a source ("user" = first configured dir, "project" = second). */
export function agentDirFor(source) {
	const index = source === "project" ? 1 : 0;
	return AGENT_DIRS[index];
}

function assertName(name) {
	if (typeof name !== "string" || !NAME_RE.test(name) || name.length > 64) {
		throw new HttpError(
			400,
			"invalid agent name (use lowercase letters, digits, dot, dash, underscore)",
		);
	}
}

/** Resolve the on-disk path for an agent name, refusing escapes. */
function agentPath(name, source) {
	assertName(name);
	const dir = path.resolve(agentDirFor(source));
	const resolved = path.resolve(dir, `${name}.md`);
	if (!resolved.startsWith(dir + path.sep))
		throw new HttpError(400, "invalid agent path");
	return resolved;
}

function frontmatterLine(key, value) {
	// Keep values on one line so the frontmatter stays trivially parseable.
	return `${key}: ${String(value)
		.replace(/\s*\n\s*/g, " ")
		.trim()}`;
}

function serialize({ name, description, tools, model, body }) {
	const lines = ["---", frontmatterLine("name", name)];
	if (description) lines.push(frontmatterLine("description", description));
	if (Array.isArray(tools) && tools.length)
		lines.push(frontmatterLine("tools", tools.join(", ")));
	if (model) lines.push(frontmatterLine("model", model));
	lines.push("---", "", (body || "").trim(), "");
	return lines.join("\n");
}

/** Full agent record including the raw system-prompt body. */
export function getAgent(name, source) {
	const known = resolveAgent(name, source);
	if (!known) return null;
	const text = fs.readFileSync(known.path, "utf8");
	return { ...known, body: agentBody(text) };
}

/** Create a new agent file. Fails if one already exists at that name+source. */
export function createAgent(input) {
	const source = input.source === "project" ? "project" : "user";
	const filePath = agentPath(input.name, source);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const doc = serialize({
		name: input.name,
		description: input.description,
		tools: input.tools,
		model: input.model,
		body: input.body,
	});
	try {
		// "wx": created only if it does not exist, in one step (no window between the check and the write).
		fs.writeFileSync(filePath, doc, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if (error && error.code === "EEXIST")
			throw new HttpError(409, `agent already exists: ${input.name}`);
		throw error;
	}
	return getAgent(input.name, source);
}

/**
 * Update an existing agent. Pass `previousName` to rename; the old file is removed only
 * after the new one is written successfully.
 */
export function updateAgent(name, input) {
	const source = input.source === "project" ? "project" : "user";
	const existing = resolveAgent(name, source);
	if (!existing) throw new HttpError(404, `agent not found: ${name}`);
	const renameTo = input.name && input.name !== name ? input.name : null;
	const targetSource = input.moveTo || source;
	const targetPath = agentPath(renameTo || name, targetSource);
	const doc = serialize({
		name: renameTo || name,
		description: input.description ?? existing.description,
		tools: input.tools ?? existing.tools,
		model: input.model ?? existing.model,
		body: input.body ?? agentBody(fs.readFileSync(existing.path, "utf8")),
	});
	fs.mkdirSync(path.dirname(targetPath), { recursive: true });
	if (targetPath !== existing.path && fs.existsSync(targetPath)) {
		throw new HttpError(409, `cannot rename: ${input.name} already exists`);
	}
	fs.writeFileSync(targetPath, doc, "utf8");
	if (targetPath !== existing.path) fs.unlinkSync(existing.path);
	return getAgent(input.name || name, targetSource);
}

export function deleteAgent(name, source) {
	const existing = resolveAgent(name, source);
	if (!existing) throw new HttpError(404, `agent not found: ${name}`);
	const resolved = path.resolve(existing.path);
	const allowed = AGENT_DIRS.map((d) => path.resolve(d));
	if (!allowed.some((dir) => resolved.startsWith(dir + path.sep))) {
		throw new HttpError(400, "refusing to delete outside the agent directories");
	}
	fs.unlinkSync(resolved);
	return { deleted: true, name, source: existing.source };
}

/** Tool names offered in the agent editor (built-ins + kit extras). */
export const KNOWN_TOOLS = [
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"find",
	"ls",
	"todo",
	"subagent",
	"verify_completion",
	"memory_store",
	"memory_search",
];
