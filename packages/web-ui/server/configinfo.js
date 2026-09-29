// configinfo.js — expose how this pi installation is configured (read-only).
// Powers the web UI's Config view: what the CLI is using, where things live, and
// which prompt templates / skills are available.
import * as fs from "node:fs";
import * as path from "node:path";
import {
	AGENT_DIRS,
	HOST,
	KIT_ROOT,
	MODELS_FILE,
	PI_BIN,
	PI_HOME,
	PORT,
	PROMPTS_DIR,
	PUBLIC_DIR,
	RUNTIME_DIR,
	SESSIONS_DIR,
	SETTINGS_FILE,
	SKILLS_DIR,
} from "./config.js";
import { listAgents } from "./agents.js";
import { KNOWN_TOOLS } from "./agentstore.js";
import { listModels } from "./models.js";
import { lensStatus, LENS_DIR } from "./lens.js";

const VERSION = "0.1.0";

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function parseFrontmatter(text) {
	const out = {};
	if (!text.startsWith("---")) return out;
	const end = text.indexOf("\n---", 3);
	if (end === -1) return out;
	for (const rawLine of text.slice(3, end).split("\n")) {
		const line = rawLine.trim();
		const idx = line.indexOf(":");
		if (!line || line.startsWith("#") || idx === -1) continue;
		out[line.slice(0, idx).trim()] = line
			.slice(idx + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
	}
	return out;
}

/** Everything the Config view needs about this installation. */
export function configInfo() {
	const settings = readJson(SETTINGS_FILE) || {};
	const models = listModels();
	return {
		app: {
			version: VERSION,
			node: process.version,
			platform: process.platform,
			host: HOST,
			port: PORT,
			publicDir: PUBLIC_DIR,
			runtimeDir: RUNTIME_DIR,
		},
		cli: {
			binary: PI_BIN,
			piHome: PI_HOME,
			settingsFile: SETTINGS_FILE,
			modelsFile: MODELS_FILE,
			sessionsDir: SESSIONS_DIR,
			sessionFormat: "jsonl (json lines) per cwd-encoded directory",
		},
		settings: {
			defaultProvider: settings.defaultProvider || models.default.provider,
			defaultModel: settings.defaultModel || models.default.model,
			theme: settings.theme || null,
			defaultThinkingLevel: settings.defaultThinkingLevel || null,
			packages: Array.isArray(settings.packages) ? settings.packages.length : 0,
		},
		paths: {
			agentDirs: AGENT_DIRS,
			kitRoot: KIT_ROOT,
			promptsDir: PROMPTS_DIR,
			skillsDir: SKILLS_DIR,
			lensDir: LENS_DIR || null,
		},
		models: models.providers,
		agentCount: listAgents().length,
		tools: KNOWN_TOOLS,
		lens: lensStatus(),
	};
}

/** Prompt templates shipped in the kit. */
export function listPrompts() {
	const prompts = [];
	try {
		for (const name of fs.readdirSync(PROMPTS_DIR)) {
			if (!name.endsWith(".md")) continue;
			const file = path.join(PROMPTS_DIR, name);
			let description = "";
			try {
				const text = fs.readFileSync(file, "utf8");
				const fm = parseFrontmatter(text);
				description =
					fm.description ||
					text.split("\n").find((l) => l.trim() && !l.startsWith("---")) ||
					"";
			} catch {
				/* ignore */
			}
			prompts.push({
				name: name.replace(/\.md$/, ""),
				file,
				description: description.slice(0, 200),
			});
		}
	} catch {
		/* directory may not exist */
	}
	return prompts.sort((a, b) => a.name.localeCompare(b.name));
}

/** Skills shipped in the kit (directories containing SKILL.md). */
export function listSkills() {
	const skills = [];
	let entries = [];
	try {
		entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
	} catch {
		return skills;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const file = path.join(SKILLS_DIR, entry.name, "SKILL.md");
		if (!fs.existsSync(file)) continue;
		let description = "";
		try {
			description =
				parseFrontmatter(fs.readFileSync(file, "utf8")).description || "";
		} catch {
			/* ignore */
		}
		skills.push({
			name: entry.name,
			file,
			description: description.slice(0, 240),
		});
	}
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}
