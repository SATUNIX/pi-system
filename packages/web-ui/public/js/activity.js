// activity.js — the "thinking wheel": rotating activity labels + an elapsed timer.
//
// Mirrors the CLI footer's behaviour: while the agent works it rotates through a phrase
// list, but switches to a concrete label when it knows what is happening (which tool is
// running, whether it is thinking or writing). Falls back to phases when idle.

const PHRASES = [
	"Working",
	"Thinking it through",
	"Connecting the dots",
	"Checking assumptions",
	"Planning the next step",
	"Weighing the options",
	"Following the thread",
	"Cross-referencing",
	"Tracing the logic",
	"Gathering context",
	"Mapping the terrain",
	"Untangling",
	"Triangulating",
	"Recalibrating",
	"Crunching",
	"Pondering",
	"Sifting through details",
	"Lining things up",
	"Double-checking",
	"Piecing it together",
];

const ROTATE_MS = 2600;

function baseName(p) {
	if (typeof p !== "string" || !p) return "";
	const parts = p.split("/");
	return parts[parts.length - 1] || p;
}

function clip(text, max = 40) {
	const value = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Human label for a tool invocation, matching the kit's footer wording. */
export function toolLabel(name, args) {
	const tool = String(name || "tool");
	switch (tool) {
		case "read":
			return `Reading ${baseName(args && args.path) || "a file"}`;
		case "edit":
			return `Editing ${baseName(args && args.path) || "a file"}`;
		case "write":
			return `Writing ${baseName(args && args.path) || "a file"}`;
		case "bash":
			return args && args.command
				? `Running \`${clip(args.command)}\``
				: "Running a command";
		case "grep":
		case "find":
		case "ls":
			return "Searching the workspace";
		case "subagent":
		case "dispatch_specialist":
		case "dispatch_validator":
			return "Delegating to a subagent";
		case "todo":
			return "Updating the todo list";
		case "verify_completion":
			return "Verifying completion";
		default:
			return /^memory/.test(tool) ? "Consulting memory" : `Using ${tool}`;
	}
}

/**
 * Drives a wheel element: `<span class="wheel"><span class="wheel-dot"></span><span>label</span></span>`.
 */
export class ActivityWheel {
	constructor(labelNode, wheelNode) {
		this.label = labelNode;
		this.wheel = wheelNode;
		this.phraseIndex = Math.floor(Math.random() * PHRASES.length);
		this.timer = null;
		this.startedAt = null;
		this.override = null;
		this.overrideUntil = 0;
		this.busy = false;
	}

	setLabel(text, busy = true) {
		this.label.textContent = text;
		this.wheel.classList.toggle("is-busy", busy);
		this.wheel.classList.remove("is-error");
	}

	start() {
		if (this.busy) return;
		this.busy = true;
		this.startedAt = Date.now();
		this.override = null;
		this.setLabel(`${PHRASES[this.phraseIndex++ % PHRASES.length]}…`, true);
		this.timer = setInterval(() => {
			if (Date.now() < this.overrideUntil) return;
			this.setLabel(`${PHRASES[this.phraseIndex++ % PHRASES.length]}…`, true);
		}, ROTATE_MS);
	}

	/** Show a concrete activity for a short window, then resume rotating. */
	note(text, holdMs = 3200) {
		this.override = text;
		this.overrideUntil = Date.now() + holdMs;
		this.setLabel(`${text}…`, true);
	}

	stop(reason = "idle") {
		this.busy = false;
		this.startedAt = null;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.override = null;
		this.overrideUntil = 0;
		this.wheel.classList.remove("is-busy");
		this.wheel.classList.remove("is-error");
		this.label.textContent = reason;
	}

	fail(message) {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.busy = false;
		this.wheel.classList.remove("is-busy");
		this.wheel.classList.add("is-error");
		this.label.textContent = message;
	}
}

/** mm:ss since a timestamp. */
export function formatElapsed(sinceMs) {
	if (!sinceMs) return "—";
	const secs = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
	const m = Math.floor(secs / 60);
	const s = secs % 60;
	return `${m}:${String(s).padStart(2, "0")}`;
}

/** Compact token counts: 4123456 -> 4.1M */
export function formatTokens(n) {
	const value = Number(n) || 0;
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

export function formatCost(n) {
	const value = Number(n) || 0;
	if (!value) return "$0.00";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}
