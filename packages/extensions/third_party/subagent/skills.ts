/**
 * Subagent — skill resolution for role/workflow skill preloading.
 *
 * A role (or workflow step) can name skills whose SKILL.md bodies are appended to the child's
 * system prompt, so the child starts with the runbook instead of having to discover and read it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentDir } from "./config.ts";

const SUBAGENT_DIR = path.dirname(fileURLToPath(import.meta.url));

// Search order: project, user, then the kit's shipped skills.
export function skillSearchDirs(cwd: string): string[] {
	const dirs = [
		path.join(cwd, ".pi", "skills"),
		path.join(cwd, ".agents", "skills"),
		path.join(agentDir(), "skills"),
		path.join(os.homedir(), ".agents", "skills"),
		path.resolve(SUBAGENT_DIR, "..", "..", "..", "kit", "skills"),
	];
	const extra = process.env.PI_KIT_SKILL_DIRS?.split(path.delimiter).filter(Boolean) ?? [];
	return [...extra.map((d) => path.resolve(d)), ...dirs];
}

export function resolveSkillFile(name: string, cwd: string): string | null {
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return null;
	for (const dir of skillSearchDirs(cwd)) {
		const file = path.join(dir, name, "SKILL.md");
		if (fs.existsSync(file)) return file;
	}
	return null;
}

function stripFrontmatter(text: string): string {
	return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

// Returns the preload block and the names that could not be resolved.
export function skillPreamble(names: string[] | undefined, cwd: string): { text: string; missing: string[] } {
	const missing: string[] = [];
	const blocks: string[] = [];
	for (const name of names ?? []) {
		const file = resolveSkillFile(name, cwd);
		if (!file) {
			missing.push(name);
			continue;
		}
		try {
			const body = stripFrontmatter(fs.readFileSync(file, "utf8"));
			blocks.push(`<skill name="${name}" location="${file}">\nRelative references in this skill resolve against ${path.dirname(file)}.\n\n${body}\n</skill>`);
		} catch {
			missing.push(name);
		}
	}
	return { text: blocks.length ? `\n\n# Preloaded skills\n\n${blocks.join("\n\n")}` : "", missing };
}
