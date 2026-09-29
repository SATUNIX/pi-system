// models.js — expose providers/models from pi's models.json plus the configured default.
import * as fs from "node:fs";
import { MODELS_FILE, SETTINGS_FILE } from "./config.js";

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/** { providers: [{name, models:[{id, contextWindow?, reasoning?}]}], default:{provider,model} } */
export function listModels() {
	const raw = readJson(MODELS_FILE) || {};
	const providers = [];
	for (const [name, cfg] of Object.entries(raw.providers || {})) {
		if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) continue;
		const models = Array.isArray(cfg.models)
			? cfg.models
					.map((m) => {
						if (typeof m === "string") return { id: m };
						if (!m || typeof m !== "object" || Array.isArray(m)) return null;
						return {
							id: m.id,
							contextWindow: m.contextWindow,
							reasoning: m.reasoning,
						};
					})
					.filter((m) => m && m.id)
			: [];
		providers.push({ name, models });
	}
	providers.sort((a, b) => a.name.localeCompare(b.name));

	const settings = readJson(SETTINGS_FILE) || {};
	const fallbackProvider = providers[0]?.name || "ollama";
	const provider = settings.defaultProvider || fallbackProvider;
	const providerEntry = providers.find((p) => p.name === provider);
	const model = settings.defaultModel || providerEntry?.models?.[0]?.id || "";

	return { providers, default: { provider, model } };
}
