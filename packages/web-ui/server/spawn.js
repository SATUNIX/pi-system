// spawn.js — manage one `pi --mode rpc` child process per session.
//
// Protocol: commands are single JSON objects written to the child's stdin, one per line
// (LF framing). The child answers with `{"type":"response",...}` records and streams
// `{"type":"<event>",...}` records on stdout. We correlate responses by an `id` field and
// fan every event out to subscribers (the SSE hub).
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import { PI_BIN, RUNTIME_DIR, DEFAULT_CWD } from "./config.js";
import { agentBody, resolveAgent } from "./agents.js";

const MAX_REPLAY_EVENTS = 500;
const RESPONSE_TIMEOUT_MS = 15000;

let registry = new Map(); // publicId -> PiRpcProcess

export class PiRpcProcess {
	constructor(config, argv, { cwd, agentFile, agentName }) {
		this.config = config;
		this.agentName = agentName || null;
		this.agentFile = agentFile || null;
		this.cwd = cwd;
		this.startedAt = Date.now();

		this.child = spawn(PI_BIN, argv, {
			cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});

		this.stdoutBuf = "";
		this.stderrBuf = "";
		this.pending = new Map(); // id -> {resolve, reject, timer}
		this.nextId = 1;
		this.subscribers = new Set();
		this.replay = [];
		this.exited = false;
		this.exitCode = null;
		this.piSessionId = null;
		this.sessionFile = null;
		this.status = "running";

		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk) => this._onStdout(chunk));
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk) => {
			this.stderrBuf = (this.stderrBuf + chunk).slice(-4000);
		});
		this.child.on("error", (err) => {
			this._emit({
				type: "lifecycle",
				state: "error",
				message: String(err && err.message),
			});
			this._failPending(new Error(String(err && err.message)));
			this._cleanup();
		});
		this.child.on("exit", (code, signal) => {
			this.exited = true;
			this.exitCode = code;
			this.status = "exited";
			this._failPending(
				new Error(`pi child exited (code=${code}, signal=${signal})`),
			);
			this._emit({
				type: "lifecycle",
				state: "exited",
				code,
				signal,
				message: this.stderrBuf.trim().slice(0, 500) || undefined,
			});
			this._cleanup();
		});
	}

	// ---- stdout framing -------------------------------------------------------
	_onStdout(chunk) {
		this.stdoutBuf += chunk;
		let nl;
		while ((nl = this.stdoutBuf.indexOf("\n")) !== -1) {
			const line = this.stdoutBuf.slice(0, nl).replace(/\r$/, "");
			this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
			if (!line.trim()) continue;
			let obj;
			try {
				obj = JSON.parse(line);
			} catch {
				continue; // ignore non-protocol noise
			}
			if (obj && obj.type === "response") this._onResponse(obj);
			else this._onEvent(obj);
		}
	}

	_onResponse(obj) {
		const id = obj.id !== undefined ? String(obj.id) : null;
		let entry = null;
		if (id !== null && this.pending.has(id)) {
			entry = this.pending.get(id);
			this.pending.delete(id);
		} else {
			// Fall back to the oldest pending entry for this command.
			for (const [key, value] of this.pending) {
				if (value.command === obj.command) {
					entry = value;
					this.pending.delete(key);
					break;
				}
			}
		}
		if (!entry) return;
		if (entry.timer) clearTimeout(entry.timer);
		if (obj.success === false)
			entry.reject(new Error(obj.error || `command failed: ${obj.command}`));
		else entry.resolve(obj.data ?? obj);
	}

	_onEvent(obj) {
		this._emit({ type: "event", data: obj });
	}

	_emit(message) {
		if (message.type === "event") {
			this.replay.push(message);
			if (this.replay.length > MAX_REPLAY_EVENTS) this.replay.shift();
		}
		for (const fn of this.subscribers) {
			try {
				fn(message);
			} catch {
				/* subscriber errors must not break the loop */
			}
		}
	}

	_failPending(err) {
		for (const [, entry] of this.pending) {
			if (entry.timer) clearTimeout(entry.timer);
			entry.reject(err);
		}
		this.pending.clear();
	}

	/** Idempotent teardown: drop the temp agent prompt and deregister the proc. */
	_cleanup() {
		if (this.agentFile) {
			try {
				fs.unlinkSync(this.agentFile);
			} catch {
				/* already gone or never created */
			}
			this.agentFile = null;
		}
		if (this.localId) registry.delete(this.localId);
		if (this.piSessionId) registry.delete(this.piSessionId);
	}

	// ---- command interface ----------------------------------------------------
	/** Send one RPC command; resolves with its response data. */
	send(command, { timeoutMs = RESPONSE_TIMEOUT_MS } = {}) {
		return new Promise((resolve, reject) => {
			if (this.exited) return reject(new Error("pi child has exited"));
			const id = `c${this.nextId++}`;
			const payload = { id, ...command };
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`timeout waiting for response to ${command.type}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer, command: command.type });
			const line = `${JSON.stringify(payload)}\n`;
			try {
				this.child.stdin.write(line);
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(err);
			}
		});
	}

	subscribe(fn) {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}

	/** Register the pi-assigned session id once known and re-key the registry. */
	setPiSessionId(id, file) {
		if (id) this.piSessionId = id;
		if (file) this.sessionFile = file;
		if (this.piSessionId) {
			if (this.localId) registry.delete(this.localId);
			registry.set(this.piSessionId, this);
		}
	}

	get publicId() {
		return this.piSessionId || this.localId;
	}

	get alive() {
		return !this.exited;
	}

	kill() {
		if (this.exited) return;
		try {
			this.child.kill("SIGTERM");
		} catch {
			/* ignore */
		}
		setTimeout(() => {
			if (!this.exited) {
				try {
					this.child.kill("SIGKILL");
				} catch {
					/* ignore */
				}
			}
		}, 3000).unref?.();
	}
}

/** Build the pi argv for a spawn request. */
function buildArgv(config) {
	const argv = ["--mode", "rpc"];
	if (config.resumeSessionFile) {
		// Resuming: let the session's own recorded model/thinking apply unless overridden.
		argv.push("--session", config.resumeSessionFile);
		if (config.provider) argv.push("--provider", config.provider);
		if (config.model) argv.push("--model", config.model);
		if (config.thinking) argv.push("--thinking", config.thinking);
	} else {
		if (config.provider) argv.push("--provider", config.provider);
		if (config.model) argv.push("--model", config.model);
		argv.push("--thinking", config.thinking || "medium");
	}
	// Deliberately no --session-dir: pi then uses its native <sessionDir>/<encoded-cwd>/ layout,
	// which is exactly what sessions.js scans (so spawned sessions appear in the list).
	return argv;
}

/**
 * Spawn a new pi RPC child.
 * config: { cwd, agent, agentSource, provider, model, thinking }
 */
export async function createSession(config) {
	const cwd = config.cwd || DEFAULT_CWD;
	if (!fs.existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);

	const argv = buildArgv(config);
	let agentFile = null;
	let agentName = null;

	if (config.agent) {
		const agent = resolveAgent(config.agent, config.agentSource);
		if (!agent) throw new Error(`unknown agent: ${config.agent}`);
		const body = agentBody(fs.readFileSync(agent.path, "utf8"));
		fs.mkdirSync(RUNTIME_DIR, { recursive: true });
		agentFile = path.join(
			RUNTIME_DIR,
			`agent-${agent.name}-${crypto.randomBytes(4).toString("hex")}.md`,
		);
		fs.writeFileSync(agentFile, body, "utf8");
		agentName = agent.name;
		argv.push("--append-system-prompt", agentFile);
	}

	const proc = new PiRpcProcess(config, argv, { cwd, agentFile, agentName });
	proc.localId = `local-${crypto.randomBytes(6).toString("hex")}`;
	registry.set(proc.localId, proc);

	// Learn the pi session id right away when possible.
	try {
		const state = await proc.send({ type: "get_state" }, { timeoutMs: 6000 });
		proc.setPiSessionId(state && state.sessionId, state && state.sessionFile);
	} catch {
		// get_state may not answer until the session materialises; a lazy link happens later.
	}

	proc.subscribe((msg) => {
		if (msg.type === "event" && msg.data && msg.data.type === "session_meta") {
			proc.setPiSessionId(msg.data.sessionId, msg.data.sessionFile);
		}
	});

	return proc;
}

export function getSession(id) {
	if (registry.has(id)) return registry.get(id);
	for (const proc of registry.values()) {
		if (proc.piSessionId === id || proc.publicId === id) return proc;
	}
	return null;
}

export function listLiveSessions() {
	return [...new Set(registry.values())];
}

export function killAll() {
	for (const proc of registry.values()) proc.kill();
	registry = new Map();
}
