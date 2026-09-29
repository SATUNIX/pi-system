// panels.js — renderers for the inspector (stats / todos / lens) and the Config view.
import { clear, el } from "./render.js";
import { formatCost, formatTokens } from "./activity.js";

function kv(rows) {
	const list = el("dl", { class: "kv" });
	for (const row of rows) {
		if (!row) continue;
		if (row.section) {
			list.append(el("div", { class: "kv-section", text: row.section }));
			continue;
		}
		list.append(el("dt", { text: row.k }));
		list.append(el("dd", { class: row.className || "", text: row.v }));
	}
	return list;
}

function contextBar(percent) {
	const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
	const cls = clamped >= 90 ? "high" : clamped >= 70 ? "mid" : "";
	return el("div", { class: "bar" }, [
		el("div", { class: "bar-fill " + cls, style: `width:${clamped}%` }),
	]);
}

/** Session token/cost/context statistics. */
export function renderStats(bodyNode, stats, summary) {
	clear(bodyNode);
	if (!stats) {
		bodyNode.append(el("p", { class: "muted", text: "No statistics yet." }));
		return;
	}
	const tokens = stats.tokens || {};
	const ctx = stats.contextUsage;
	const rows = [
		{
			k: "source",
			v: stats.live ? "live child" : "session file",
			className: stats.live ? "good" : "",
		},
		summary ? { k: "session", v: summary.id } : null,
		summary ? { k: "cwd", v: summary.cwd || "—" } : null,
		{
			k: "model",
			v: stats.model || (summary && summary.model) || "—",
			className: "accent",
		},
		{ k: "provider", v: stats.provider || "—" },
		{ section: "messages" },
		{ k: "user", v: String(stats.userMessages ?? 0) },
		{ k: "assistant", v: String(stats.assistantMessages ?? 0) },
		{ k: "tool calls", v: String(stats.toolCalls ?? 0) },
		{ k: "total", v: String(stats.totalMessages ?? 0) },
		{ section: "tokens" },
		{ k: "input", v: formatTokens(tokens.input) },
		{ k: "output", v: formatTokens(tokens.output) },
		{ k: "cache read", v: formatTokens(tokens.cacheRead) },
		{ k: "cache write", v: formatTokens(tokens.cacheWrite) },
		{ k: "total", v: formatTokens(tokens.total) },
		{ k: "cost", v: formatCost(stats.cost) },
	];
	bodyNode.append(kv(rows));

	if (ctx) {
		bodyNode.append(el("div", { class: "kv-section", text: "context window" }));
		bodyNode.append(
			el("div", { class: "muted mono-sm" }, [
				`${formatTokens(ctx.tokens)} / ${formatTokens(ctx.contextWindow)}  (${ctx.percent ?? "?"}%)`,
			]),
		);
		bodyNode.append(contextBar(ctx.percent));
	}
}

/** Session todo list with progress. */
export function renderTodos(listNode, data) {
	clear(listNode);
	if (!data || !data.exists) {
		listNode.append(
			el("li", { class: "muted", text: "No todo file for this session." }),
		);
		return;
	}
	const todos = data.todos || [];
	const done = todos.filter((t) => t.state === "done").length;
	const pct = todos.length ? Math.round((done / todos.length) * 100) : 0;
	listNode.append(
		el("li", { class: "muted mono-sm", text: `${done}/${todos.length} done` }),
		el("li", {}, [
			el("div", { class: "progress" }, [
				el("div", { class: "progress-fill", style: `width:${pct}%` }),
			]),
		]),
	);
	for (const todo of todos) {
		const mark =
			todo.state === "done" ? "[x]" : todo.state === "active" ? "[~]" : "[ ]";
		listNode.append(
			el("li", { class: `todo-item todo-${todo.state}` }, [
				el("span", { class: "todo-mark", text: mark }),
				el("span", { class: "todo-text", text: todo.text }),
			]),
		);
	}
}

/** pi-lens diagnostics for this session. */
export function renderLens(bodyNode, lens) {
	clear(bodyNode);
	if (!lens || !lens.available) {
		bodyNode.append(
			el("p", {
				class: "muted",
				text: "No pi-lens state recorded for this session yet.",
			}),
		);
		return;
	}
	const totals = lens.totals || {};
	bodyNode.append(
		kv([
			{
				k: "captured",
				v: lens.savedAt ? new Date(lens.savedAt).toLocaleTimeString() : "—",
			},
			{ k: "files", v: String((lens.files || []).length) },
			{ section: "diagnostics" },
			{
				k: "blocking",
				v: String(totals.blocking || 0),
				className: totals.blocking ? "warn" : "good",
			},
			{
				k: "errors",
				v: String(totals.errors || 0),
				className: totals.errors ? "warn" : "good",
			},
			{
				k: "warnings",
				v: String(totals.warnings || 0),
				className: totals.warnings ? "warn" : "good",
			},
			{ section: "cache" },
			{
				k: "quality files",
				v: String((lens.cache && lens.cache.qualityWarnings) || 0),
			},
			{ k: "findings", v: String((lens.cache && lens.cache.findings) || 0) },
		]),
	);

	const dirty = (lens.files || []).filter(
		(f) => f.blocking || f.errors || f.warnings,
	);
	if (dirty.length) {
		bodyNode.append(
			el("div", { class: "kv-section", text: "files with findings" }),
		);
		const list = el("ul", { class: "todo-list" });
		for (const file of dirty.slice(0, 40)) {
			list.append(
				el("li", { class: "todo-item" }, [
					el("span", { class: "todo-mark", text: `${file.errors || 0}E` }),
					el("span", {
						class: "todo-text",
						text: `${file.filePath.split("/").slice(-2).join("/")}  (${file.warnings || 0}W)`,
					}),
				]),
			);
		}
		bodyNode.append(list);
	}
}

/** Installation configuration cards. */
export function renderConfig(gridNode, config) {
	clear(gridNode);
	if (!config) return;
	const card = (title, rows) => {
		const body = el("div", { class: "config-card" }, [
			el("h3", { text: title }),
		]);
		for (const [key, value] of rows) {
			body.append(
				el("div", { class: "mono-sm" }, [
					el("span", { class: "muted", text: `${key}: ` }),
					el("span", { text: String(value ?? "—") }),
				]),
			);
		}
		return body;
	};

	gridNode.append(
		card("console", [
			["version", config.app.version],
			["node", config.app.node],
			["platform", config.app.platform],
			["listening", `${config.app.host}:${config.app.port}`],
		]),
		card("pi cli", [
			["binary", config.cli.binary],
			["home", config.cli.piHome],
			["settings", config.cli.settingsFile],
			["models", config.cli.modelsFile],
			["sessions", config.cli.sessionsDir],
		]),
		card("defaults", [
			["provider", config.settings.defaultProvider],
			["model", config.settings.defaultModel],
			["thinking", config.settings.defaultThinkingLevel],
			["theme", config.settings.theme],
			["packages", config.settings.packages],
		]),
		card("paths", [
			["kit root", config.paths.kitRoot],
			["user agents", config.paths.agentDirs[0]],
			["project agents", config.paths.agentDirs[1]],
			["lens", config.paths.lensDir],
		]),
		card("pi-lens", [
			["present", config.lens.present ? "yes" : "no"],
			["session files", config.lens.sessionCount],
			["turn cycles", config.lens.turn ? config.lens.turn.cycles : "—"],
			["tracked files", config.lens.turn ? config.lens.turn.files : "—"],
		]),
		card(
			"models",
			config.models.map((p) => [p.name, p.models.length]),
		),
	);
}

/** Prompt templates / skills list. */
export function renderResourceList(listNode, items) {
	clear(listNode);
	if (!items || !items.length) {
		listNode.append(el("li", { class: "muted", text: "None found." }));
		return;
	}
	for (const item of items) {
		listNode.append(
			el("li", {}, [
				el("div", { class: "resource-name", text: item.name }),
				item.description
					? el("div", { class: "resource-desc", text: item.description })
					: null,
			]),
		);
	}
}
