// stats.js — token/cost/context statistics for a session.
// Live sessions answer via the RPC `get_session_stats` command; idle sessions are
// computed from the assistant usage records already on disk.
import * as fs from "node:fs";
import { listModels } from "./models.js";

function emptyTotals() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		cost: 0,
	};
}

function contextWindowFor(modelId) {
	try {
		for (const provider of listModels().providers) {
			const hit = provider.models.find((m) => m.id === modelId);
			if (hit && hit.contextWindow) return hit.contextWindow;
		}
	} catch {
		/* ignore */
	}
	return null;
}

/** Sum assistant usage records from a session file. */
export function statsFromDisk(sessionFile) {
	const totals = emptyTotals();
	let userMessages = 0;
	let assistantMessages = 0;
	let toolCalls = 0;
	let lastUsage = null;
	let model = null;
	let provider = null;
	let lastTimestamp = null;

	if (sessionFile && fs.existsSync(sessionFile)) {
		const text = fs.readFileSync(sessionFile, "utf8");
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			let entry;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (!entry || typeof entry !== "object" || entry.type !== "message")
				continue;
			const msg = entry.message || {};
			if (msg.timestamp) lastTimestamp = msg.timestamp;
			if (msg.role === "user") userMessages++;
			if (msg.role !== "assistant") continue;
			assistantMessages++;
			if (Array.isArray(msg.content))
				toolCalls += msg.content.filter(
					(p) => p && p.type === "toolCall",
				).length;
			if (msg.model) model = msg.model;
			if (msg.provider) provider = msg.provider;
			const usage = msg.usage;
			if (!usage) continue;
			lastUsage = usage;
			totals.input += usage.input || 0;
			totals.output += usage.output || 0;
			totals.cacheRead += usage.cacheRead || 0;
			totals.cacheWrite += usage.cacheWrite || 0;
			totals.cost += (usage.cost && usage.cost.total) || 0;
		}
		totals.total =
			totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
	}

	const window = contextWindowFor(model);
	const contextTokens = lastUsage
		? (lastUsage.input || 0) + (lastUsage.cacheRead || 0)
		: null;
	const contextUsage =
		window && contextTokens !== null
			? {
					tokens: contextTokens,
					contextWindow: window,
					percent: Math.round((contextTokens / window) * 100),
				}
			: null;

	return {
		live: false,
		userMessages,
		assistantMessages,
		toolCalls,
		totalMessages: userMessages + assistantMessages,
		tokens: totals,
		cost: totals.cost,
		contextUsage,
		model,
		provider,
		lastTimestamp,
	};
}

/** Prefer the live child's own accounting; fall back to the file. */
export async function sessionStats(summary, proc) {
	if (proc && proc.alive) {
		try {
			const data = await proc.send(
				{ type: "get_session_stats" },
				{ timeoutMs: 8000 },
			);
			return {
				live: true,
				...data,
				cost: data.cost ?? (data.tokens && data.tokens.cost) ?? 0,
			};
		} catch {
			/* fall through to disk */
		}
	}
	return statsFromDisk(summary && summary.sessionFile);
}
