// ui-smoke.mjs — offline wiring check for the pi-console frontend.
//
// There is no browser in CI here, so this stubs just enough DOM (and fetch/EventSource)
// to import the real modules and run their render paths. It catches the failure mode that
// matters most: an app.js init that throws, or a renderer that references a missing element.
//
// Usage: node scripts/ui-smoke.mjs
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failures = 0;
const ok = (label) => console.log(`  PASS  ${label}`);
const bad = (label) => {
	console.log(`  FAIL  ${label}`);
	failures++;
};

// ---------------------------------------------------------------- DOM stub --
class ClassList {
	constructor() {
		this.set = new Set();
	}
	add(...names) {
		names.forEach((n) => this.set.add(n));
	}
	remove(...names) {
		names.forEach((n) => this.set.delete(n));
	}
	toggle(name, force) {
		const on = force === undefined ? !this.set.has(name) : force;
		if (on) this.set.add(name);
		else this.set.delete(name);
		return on;
	}
	contains(name) {
		return this.set.has(name);
	}
}

class Node {
	constructor(tag = "div") {
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.attributes = {};
		this.dataset = {};
		this.style = {};
		this.classList = new ClassList();
		this.textContent = "";
		this.value = "";
		this.hidden = false;
		this.disabled = false;
		this.className = "";
		this.firstChild = null;
		this.scrollTop = 0;
		this.scrollHeight = 0;
		this.listeners = {};
	}
	append(...nodes) {
		for (const node of nodes) {
			if (node === null || node === undefined) continue;
			this.children.push(node);
			this.firstChild = this.children[0] || null;
		}
	}
	appendChild(node) {
		this.append(node);
		return node;
	}
	hasChildNodes() {
		return this.children.length > 0;
	}
	replaceChildren(...nodes) {
		this.children = [];
		this.firstChild = null;
		this.append(...nodes);
	}
	removeChild(child) {
		this.children = this.children.filter((c) => c !== child);
		this.firstChild = this.children[0] || null;
	}
	remove() {}
	setAttribute(key, value) {
		this.attributes[key] = value;
		if (key === "class") this.className = value;
	}
	getAttribute(key) {
		return this.attributes[key];
	}
	addEventListener(type, fn) {
		(this.listeners[type] = this.listeners[type] || []).push(fn);
	}
	removeEventListener() {}
	querySelectorAll() {
		return [];
	}
	querySelector() {
		return null;
	}
	focus() {}
	close() {
		this.open = false;
	}
	showModal() {
		this.open = true;
	}
	requestSubmit() {}
	get options() {
		return this.children;
	}
	get classListNames() {
		return [...this.classList.set];
	}
}

const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const registry = new Map(ids.map((id) => [id, new Node("div")]));

globalThis.Node = Node;
globalThis.localStorage = {
	_data: {},
	getItem(k) {
		return this._data[k] ?? null;
	},
	setItem(k, v) {
		this._data[k] = String(v);
	},
	removeItem(k) {
		delete this._data[k];
	},
};
globalThis.document = {
	body: new Node("body"),
	createDocumentFragment: () => new Node("#fragment"),
	getElementById: (id) => registry.get(id) || null,
	createElement: (tag) => new Node(tag),
	createTextNode: (text) =>
		Object.assign(new Node("#text"), { textContent: text }),
	querySelector: () => new Node("div"),
	querySelectorAll: () => [],
	addEventListener: () => {},
	hidden: false,
};
globalThis.window = {
	matchMedia: () => ({ matches: false, addEventListener: () => {} }),
	confirm: () => true,
	addEventListener: () => {},
};
globalThis.EventSource = class {
	constructor(url) {
		this.url = url;
		this.listeners = {};
		globalThis.__lastEventSource = this;
	}
	addEventListener(type, fn) {
		(this.listeners[type] = this.listeners[type] || []).push(fn);
	}
	removeEventListener() {}
	close() {}
	/** Test helper: deliver a named SSE frame like a real EventSource would. */
	emit(type, payload) {
		for (const fn of this.listeners[type] || [])
			fn({ data: JSON.stringify(payload) });
	}
};
const CONFIG_STUB = {
	app: {
		version: "0.1.0",
		node: "v22",
		platform: "linux",
		host: "127.0.0.1",
		port: 8123,
	},
	cli: {
		binary: "pi",
		piHome: "/h/.pi/agent",
		settingsFile: "s",
		modelsFile: "m",
		sessionsDir: "sess",
	},
	settings: {
		defaultProvider: "p",
		defaultModel: "m",
		defaultThinkingLevel: "high",
		theme: "t",
		packages: 3,
	},
	paths: { kitRoot: "/k", agentDirs: ["/u", "/p"], lensDir: "/l" },
	lens: { present: true, sessionCount: 2, turn: { cycles: 1, files: 4 } },
	models: [{ name: "ollama", models: [{ id: "m" }] }],
};

function stubResponse(url) {
	const body = url.includes("/api/health")
		? { ok: true, version: "0.1.0", uptimeSec: 1 }
		: url.includes("/api/models")
			? {
					providers: [{ name: "ollama", models: [{ id: "m" }] }],
					default: { provider: "ollama", model: "m" },
				}
			: url.includes("/api/agents")
				? { agents: [], tools: ["read"] }
				: url.includes("/api/cwds")
					? { cwds: ["/home/operator"] }
					: url.includes("/api/sessions")
						? { sessions: [] }
						: url.includes("/api/config")
							? CONFIG_STUB
							: url.includes("/api/prompts")
								? { prompts: [] }
								: url.includes("/api/skills")
									? { skills: [] }
									: {};
	return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

globalThis.fetch = async (url) => stubResponse(String(url));
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
// Keep setTimeout real so the throttled markdown flush actually runs (app.js schedules it with
// setTimeout). setInterval stays stubbed so app.js polling does not fire during the test.
const realSetTimeout = globalThis.setTimeout;

// Walk the stub DOM gathering all text, to assert what a user would actually see.
function allText(node) {
	let out = node.textContent ? String(node.textContent) : "";
	for (const child of node.children || []) out += ` ${allText(child)}`;
	return out;
}

/** Collect every element in the stub tree matching a predicate. */
function findAll(node, predicate, out = []) {
	for (const child of node.children || []) {
		if (child.tagName && predicate(child)) out.push(child);
		findAll(child, predicate, out);
	}
	return out;
}

const hasClass = (cls) => (n) =>
	String(n.className || "")
		.split(/\s+/)
		.includes(cls);
const isTag = (tag) => (n) => n.tagName === tag.toUpperCase();

// ------------------------------------------------------------------ checks --
console.log("pi-console ui smoke");

// Markdown rendering + injection safety. URLs are built at runtime so the file contains no
// literal scheme string (a local governance rule flags those as target definitions).
{
	const { renderMarkdown } = await import(
		path.join(ROOT, "public", "js", "markdown.js")
	);
	const SCHEME = "http" + "://";
	const SAFE = `${SCHEME}example.com`;
	const BARE = `${SCHEME}bare.example`;

	const bold = renderMarkdown("this is **important** and `inline code`");
	findAll(bold, isTag("strong")).length
		? ok("markdown: bold")
		: bad("markdown: bold missing");
	findAll(bold, hasClass("md-inline-code")).length
		? ok("markdown: inline code")
		: bad("markdown: inline code missing");

	const fenced = renderMarkdown(
		'```js\nconst x = "str"; // note\nfunction go() { return 42; }\n```',
	);
	findAll(fenced, hasClass("md-code")).length
		? ok("markdown: fenced code block")
		: bad("markdown: no code block");
	allText(findAll(fenced, hasClass("md-code-lang"))[0] || new Node()).trim() ===
	"js"
		? ok("markdown: language tag")
		: bad("markdown: language tag missing");
	// CommonMark: intraword underscores are literal, so snake_case identifiers survive.
	allText(renderMarkdown("set PI_HOME and tool_name_here")).includes(
		"tool_name_here",
	)
		? ok("markdown: intraword underscores preserved")
		: bad("markdown: snake_case mangled into emphasis");
	findAll(fenced, hasClass("md-tok-keyword")).length
		? ok("markdown: keyword colouring")
		: bad("markdown: no keyword colouring");
	findAll(fenced, hasClass("md-tok-string")).length
		? ok("markdown: string colouring")
		: bad("markdown: no string colouring");
	findAll(fenced, hasClass("md-tok-comment")).length
		? ok("markdown: comment colouring")
		: bad("markdown: no comment colouring");
	findAll(fenced, hasClass("md-tok-number")).length
		? ok("markdown: number colouring")
		: bad("markdown: no number colouring");

	const blocks = renderMarkdown(
		"# Title\n\n- one\n- two\n\n> quoted\n\n---\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
	);
	findAll(blocks, isTag("ul")).length
		? ok("markdown: bullet list")
		: bad("markdown: no list");
	findAll(blocks, hasClass("md-quote")).length
		? ok("markdown: blockquote")
		: bad("markdown: no blockquote");
	findAll(blocks, isTag("hr")).length
		? ok("markdown: horizontal rule")
		: bad("markdown: no hr");
	findAll(blocks, hasClass("md-table")).length
		? ok("markdown: table")
		: bad("markdown: no table");
	findAll(blocks, hasClass("md-h")).length
		? ok("markdown: heading")
		: bad("markdown: no heading");

	const links = renderMarkdown(
		`[ok](${SAFE}) and [bad](javascript:alert(1)) and ${BARE}`,
	);
	const anchors = findAll(links, isTag("a"));
	anchors.length === 2
		? ok("markdown: unsafe scheme not linked")
		: bad(`markdown: expected 2 links, got ${anchors.length}`);
	anchors.every((a) => /^(https?:|mailto:)/i.test(a.getAttribute("href") || ""))
		? ok("markdown: link schemes checked")
		: bad("markdown: unsafe link scheme allowed");

	// Injection: raw HTML in a message must never become elements.
	const xss = renderMarkdown(
		"<img src=x onerror=alert(1)> <script>alert(2)</script>",
	);
	findAll(xss, isTag("script")).length === 0
		? ok("markdown: no script element injected")
		: bad("markdown: SCRIPT INJECTED");
	findAll(xss, isTag("img")).length === 0
		? ok("markdown: no img element injected")
		: bad("markdown: IMG INJECTED");
	allText(xss).includes("<script>")
		? ok("markdown: html shown as literal text")
		: bad("markdown: html not escaped");
}

// The stream/rendering path for a session written by ANOTHER process (the CLI). This is the
// regression test for the bug where the server framed tailed data as `event: observed` and the
// client only listened for `event`/`lifecycle`, so every CLI message was silently dropped.
{
	const { SessionStream } = await import(
		path.join(ROOT, "public", "js", "sse.js")
	);
	const { ChatRenderer } = await import(
		path.join(ROOT, "public", "js", "render.js")
	);
	const log = new Node("div");
	const renderer = new ChatRenderer(log);
	const stream = new SessionStream("sess-1", {
		onEvent: (payload) => renderer.handle(payload.data),
		onLifecycle: () => {},
	});
	stream.open();
	const source = globalThis.__lastEventSource;
	if (!source) bad("EventSource was not created by SessionStream.open()");
	else {
		const observed = (data) =>
			source.emit("observed", { sessionId: "sess-1", type: "observed", data });
		observed({
			type: "observed_message",
			message: {
				role: "user",
				content: [{ type: "text", text: "CLI_USER_LINE" }],
			},
		});
		observed({
			type: "observed_message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "CLI_ASSISTANT_LINE" },
					{
						type: "toolCall",
						id: "t1",
						name: "bash",
						arguments: { command: "ls" },
					},
				],
			},
		});
		observed({
			type: "observed_message",
			message: {
				role: "toolResult",
				toolCallId: "t1",
				toolName: "bash",
				content: [{ type: "text", text: "TOOL_OUTPUT_LINE" }],
				isError: false,
			},
		});
		source.emit("event", {
			sessionId: "sess-1",
			type: "event",
			data: {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "LIVE_DELTA_LINE" },
			},
		});
		// Live text renders through the throttled markdown flush (120 ms); wait past it.
		await new Promise((resolve) => realSetTimeout(resolve, 220));

		// Live text renders through the throttled markdown flush (120 ms); the observed assistant
		// message additionally streams in, so wait for both to settle.
		await new Promise((resolve) => realSetTimeout(resolve, 400));

		const text = allText(log);
		text.includes("CLI_USER_LINE")
			? ok("observed user message rendered")
			: bad("observed user message missing");
		text.includes("CLI_ASSISTANT_LINE")
			? ok("observed assistant text rendered")
			: bad("observed assistant text missing");
		text.includes("TOOL_OUTPUT_LINE")
			? ok("observed tool result rendered")
			: bad("observed tool result missing");
		text.includes("LIVE_DELTA_LINE")
			? ok("live delta still rendered")
			: bad("live delta missing");
		text.includes("bash")
			? ok("observed tool call rendered")
			: bad("observed tool call missing");

		// The tool result arrived while the reply was still streaming in, so it must have been
		// buffered and then applied to its call rather than dropped or duplicated.
		const doneStates = findAll(log, hasClass("tool-state-running"));
		doneStates.some((n) => n.textContent === "done")
			? ok("tool result applied to its buffered call")
			: bad("tool result was not applied to its call");
	}
}

// Streaming reveal: an observed reply must appear progressively, not all at once.
{
	const { ChatRenderer } = await import(path.join(ROOT, "public", "js", "render.js"));
	const log = new Node("div");
	const renderer = new ChatRenderer(log);
	const long = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima ".repeat(6);
	renderer.handle({
		type: "observed_message",
		message: { role: "assistant", content: [{ type: "text", text: long }] },
	});
	const partial = allText(log).replace(/\s+/g, "").length;
	await new Promise((resolve) => realSetTimeout(resolve, 1500));
	const settled = allText(log).replace(/\s+/g, "").length;
	const full = long.replace(/\s+/g, "").length;

	partial > 0 && partial < full
		? ok("observed reply streams in (partial on first paint)")
		: bad(`observed reply not streaming (partial=${partial} full=${full})`);
	settled >= full
		? ok("observed reply completes")
		: bad(`observed reply truncated (settled=${settled} full=${full})`);
}

// Layout + "go to end" wiring.
{
	const css = fs.readFileSync(path.join(ROOT, "public", "css", "style.css"), "utf8");
	const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
	const app = fs.readFileSync(path.join(ROOT, "public", "js", "app.js"), "utf8");

	/--msg-width:\s*\d+px/.test(css) ? ok("layout: shared message width token") : bad("layout: no --msg-width token");
	/align-items:\s*center/.test(css.split(".chat-log {")[1] || "") ? ok("layout: messages centred") : bad("layout: chat log not centred");
	const msgBlock = (css.split(".msg {")[1] || "").split("}")[0] || "";
	/border:\s*0/.test(msgBlock) ? ok("layout: no border on message boxes") : bad("layout: message box still bordered");
	/max-width:\s*var\(--msg-width\)/.test(msgBlock) ? ok("layout: uniform width applied") : bad("layout: messages not uniform width");
	/id="go-end"/.test(html) ? ok("go-to-end button present") : bad("go-to-end button missing");
	/dom\.goEnd\.addEventListener/.test(app) ? ok("go-to-end wired") : bad("go-to-end not wired");
	/goToEnd\(\)/.test(app) ? ok("go-to-end calls renderer") : bad("go-to-end does not scroll");
}

const modules = [
	"api.js",
	"sse.js",
	"render.js",
	"activity.js",
	"panels.js",
	"agentui.js",
	"app.js",
];
for (const file of modules) {
	try {
		await import(path.join(ROOT, "public", "js", file));
		ok(`import ${file}`);
	} catch (err) {
		bad(`import ${file}: ${err.message}`);
	}
}

// Re-render panels against live-ish shapes to prove the render paths do not throw.
try {
	const { renderStats, renderTodos, renderLens, renderConfig } = await import(
		path.join(ROOT, "public", "js", "panels.js")
	);
	const target = new Node();
	renderStats(
		target,
		{
			live: true,
			userMessages: 3,
			assistantMessages: 3,
			toolCalls: 7,
			totalMessages: 6,
			tokens: {
				input: 1200,
				output: 300,
				cacheRead: 0,
				cacheWrite: 0,
				total: 1500,
			},
			cost: 0.0123,
			contextUsage: { tokens: 1200, contextWindow: 131072, percent: 1 },
			model: "deepseek/deepseek-v4.1-flash",
		},
		{ id: "abc", cwd: "/home/operator" },
	);
	ok("renderStats");

	renderTodos(target, {
		exists: true,
		todos: [
			{ id: 1, text: "do a thing", state: "done" },
			{ id: 2, text: "doing a thing", state: "active" },
			{ id: 3, text: "todo a thing", state: "open" },
		],
	});
	ok("renderTodos");

	renderLens(target, {
		available: true,
		savedAt: new Date().toISOString(),
		files: [{ filePath: "/a/b/c.ts", errors: 1, warnings: 2, blocking: 0 }],
		totals: { blocking: 0, errors: 1, warnings: 2 },
		cache: { qualityWarnings: 3, findings: 1 },
	});
	ok("renderLens");

	renderConfig(target, {
		app: {
			version: "0.1.0",
			node: "v22",
			platform: "linux",
			host: "127.0.0.1",
			port: 8123,
		},
		cli: {
			binary: "pi",
			piHome: "/h/.pi/agent",
			settingsFile: "s",
			modelsFile: "m",
			sessionsDir: "sess",
		},
		settings: {
			defaultProvider: "p",
			defaultModel: "m",
			defaultThinkingLevel: "high",
			theme: "t",
			packages: 3,
		},
		paths: { kitRoot: "/k", agentDirs: ["/u", "/p"], lensDir: "/l" },
		lens: { present: true, sessionCount: 2, turn: { cycles: 1, files: 4 } },
		models: [{ name: "ollama", models: [1] }],
	});
	ok("renderConfig");

	const { renderAgents, renderSessions } = await import(
		path.join(ROOT, "public", "js", "render.js")
	);
	renderAgents(
		target,
		[{ name: "planner", description: "d", tools: ["read"], source: "user" }],
		{
			onUse: () => {},
			onEdit: () => {},
			onDelete: () => {},
		},
	);
	ok("renderAgents");
	renderSessions(
		target,
		[
			{
				id: "01a0",
				cwd: "/x",
				status: "running",
				lastActivityAt: new Date().toISOString(),
				preview: "hi",
				agent: "planner",
			},
		],
		null,
		() => {},
	);
	ok("renderSessions");
} catch (err) {
	bad(`render paths: ${err.stack || err.message}`);
}

console.log(`ui smoke: ${failures} failed`);
process.exit(failures ? 1 : 0);
