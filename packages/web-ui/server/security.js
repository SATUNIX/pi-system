// security.js — access control for pi-console.
//
// Why this exists: the console spawns `pi --mode rpc` children, and a pi child has a shell.
// Anyone who can make an HTTP request to this server can therefore run commands as the
// operator. Loopback binding alone does not stop that, because a web page the operator visits
// can send requests to 127.0.0.1 (CSRF), or rebind its own DNS name to 127.0.0.1 and then read
// the answers (DNS rebinding), and other local users can connect to loopback too.
//
// Layers, cheapest first (evaluateRequest runs them in this order for every request):
//   1. Host allowlist        - defeats DNS rebinding: the Host header must name us.
//   2. Origin / Fetch-Site   - defeats cross-site and cross-port (other localhost) requests.
//   3. Bearer token          - a per-start random secret; the actual access control.
//   4. JSON content type     - state-changing requests must be application/json, which a
//                              cross-origin page cannot send without a CORS preflight, and we
//                              never answer a preflight.
//
// Design choice, credential transport: the token travels in an `Authorization: Bearer`
// header, held by the page in sessionStorage. We deliberately do NOT use a cookie:
//   - cookies are not port-isolated, so a cookie set for 127.0.0.1:8123 is also sent to any
//     other service on 127.0.0.1 and would be attached to requests from any localhost page;
//   - `SameSite` is scheme+host, not port, so `SameSite=Strict` still treats another localhost
//     port as same-site and gives no CSRF protection between local dev servers.
// A header the page attaches itself has no ambient authority: a foreign page cannot make the
// browser add it. The cost is that EventSource cannot set headers, so the client streams SSE
// over fetch() instead (see public/js/sse.js).
//
// The token never appears in a URL query (logs, Referer, history), only in the `#fragment`
// the operator opens once. Fragments are not sent to servers or in Referer, the page strips
// it from the address bar at once, and every response carries `Referrer-Policy: no-referrer`.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";

/** 32 random bytes = 256 bits (the requirement was >= 128). */
export const TOKEN_BYTES = 32;
/** Operator-supplied tokens must be at least 32 characters (128 bits of hex, or more). */
export const TOKEN_RE = /^[A-Za-z0-9._~-]{32,256}$/;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8123;

/** Thrown for configuration the server must refuse to start with. Messages never hold the token. */
export class PolicyError extends Error {
	constructor(message) {
		super(message);
		this.name = "PolicyError";
	}
}

// ------------------------------------------------------------------- token ---
export function generateToken() {
	return crypto.randomBytes(TOKEN_BYTES).toString("hex");
}

/**
 * Constant-time string comparison. Both sides are hashed to a fixed length first, so the
 * comparison neither leaks the length of the secret nor throws on a length mismatch
 * (crypto.timingSafeEqual requires equal-length buffers).
 */
export function constantTimeEqual(a, b) {
	const ha = crypto.createHash("sha256").update(String(a)).digest();
	const hb = crypto.createHash("sha256").update(String(b)).digest();
	return crypto.timingSafeEqual(ha, hb);
}

/** The bearer credential from an Authorization header, or null. */
export function bearerToken(req) {
	const header = req && req.headers ? req.headers.authorization : undefined;
	if (typeof header !== "string") return null;
	const match = /^Bearer ([^\s]+)$/i.exec(header);
	return match ? match[1] : null;
}

export function tokenMatches(presented, expected) {
	if (typeof presented !== "string" || typeof expected !== "string") return false;
	return constantTimeEqual(presented, expected);
}

// -------------------------------------------------------------- host checks ---
/** Lower-case, unbracket an IPv6 literal. */
export function normalizeHost(value) {
	let host = String(value ?? "")
		.trim()
		.toLowerCase();
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	return host;
}

function bracket(host) {
	return net.isIP(host) === 6 ? `[${host}]` : host;
}

/** True for localhost, 127.0.0.0/8, ::1 and IPv4-mapped loopback. */
export function isLoopbackHost(value) {
	const host = normalizeHost(value);
	if (host === "localhost") return true;
	const family = net.isIP(host);
	if (family === 4) return host.split(".")[0] === "127";
	if (family === 6) {
		let canonical;
		try {
			canonical = new URL(`http://[${host}]/`).hostname; // e.g. "[::1]", "[::ffff:7f00:1]"
		} catch {
			return false;
		}
		return canonical === "[::1]" || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(canonical);
	}
	return false;
}

/** 0.0.0.0 and :: bind every interface; they are not names a client can meaningfully use. */
export function isWildcardHost(value) {
	const host = normalizeHost(value);
	if (host === "0.0.0.0") return true;
	if (net.isIP(host) === 6) {
		try {
			return new URL(`http://[${host}]/`).hostname === "[::]";
		} catch {
			return false;
		}
	}
	return false;
}

const AUTHORITY_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?$/;

/** Lower-cased `host[:port]` if `value` is a well-formed authority, else null. */
export function normalizeAuthority(value) {
	if (typeof value !== "string") return null;
	const v = value.trim().toLowerCase();
	return AUTHORITY_RE.test(v) ? v : null;
}

function parseAllowedHosts(raw) {
	const entries = [];
	for (const piece of String(raw ?? "").split(",")) {
		const item = piece.trim().toLowerCase();
		if (!item) continue;
		const match = AUTHORITY_RE.exec(item);
		if (!match) {
			throw new PolicyError(
				`PI_CONSOLE_ALLOWED_HOSTS entry "${item.slice(0, 80)}" is not a bare host or host:port (no scheme, path or wildcard).`,
			);
		}
		const port = match[2] === undefined ? null : Number(match[2]);
		if (port !== null && (port < 1 || port > 65535)) {
			throw new PolicyError(`PI_CONSOLE_ALLOWED_HOSTS entry "${item}" has an invalid port.`);
		}
		entries.push({ name: match[1], port });
	}
	return entries;
}

/**
 * Every `host[:port]` a request may legitimately carry in its Host header (and, for
 * Origin, its authority). Built after listen() so an ephemeral port (0) is the real one.
 */
export function buildAuthorities(policy, actualPort) {
	const set = new Set();
	const add = (name, port) => {
		set.add(port === null ? name : `${name}:${port}`);
		if (port === 80) set.add(name); // browsers omit the default port
	};
	for (const name of ["127.0.0.1", "localhost", "[::1]"]) add(name, actualPort);
	if (!isWildcardHost(policy.host)) add(bracket(policy.host), actualPort);
	for (const entry of policy.allowedHosts) {
		if (entry.port !== null) add(entry.name, entry.port);
		else {
			add(entry.name, actualPort);
			set.add(entry.name); // a TLS-terminating proxy forwards Host without the listen port
		}
	}
	return set;
}

// ----------------------------------------------------------------- policy ---
const TOKEN_HELP = "use 32-256 characters from A-Z a-z 0-9 . _ ~ - (for example: openssl rand -hex 32)";

function checkToken(token, name) {
	if (!TOKEN_RE.test(token)) {
		throw new PolicyError(`${name} is not acceptable: ${TOKEN_HELP}.`);
	}
	return token;
}

function suppliedToken(env) {
	const direct = env.PI_CONSOLE_TOKEN;
	if (direct !== undefined && direct !== "") {
		return { token: checkToken(direct, "PI_CONSOLE_TOKEN"), source: "env", warnings: [] };
	}
	const file = env.PI_CONSOLE_TOKEN_FILE;
	if (file) {
		let text;
		try {
			text = fs.readFileSync(file, "utf8").trim();
		} catch (error) {
			throw new PolicyError(
				`PI_CONSOLE_TOKEN_FILE could not be read (${error && error.code ? error.code : "error"}).`,
			);
		}
		const warnings = [];
		try {
			if (process.platform !== "win32" && (fs.statSync(file).mode & 0o077) !== 0) {
				warnings.push("PI_CONSOLE_TOKEN_FILE is readable by other users; run chmod 600 on it.");
			}
		} catch {
			/* stat failure is not fatal; the read above succeeded */
		}
		return { token: checkToken(text, "PI_CONSOLE_TOKEN_FILE contents"), source: "file", warnings };
	}
	return null;
}

/**
 * Turn the environment into a validated listen/auth policy, or throw PolicyError.
 * Fail closed: every ambiguous or unsafe combination is refused rather than downgraded.
 */
export function resolvePolicy(env = process.env) {
	const host = normalizeHost(env.PI_CONSOLE_HOST) || DEFAULT_HOST;

	const portRaw = String(env.PI_CONSOLE_PORT ?? "").trim();
	const port = portRaw === "" ? DEFAULT_PORT : Number(portRaw);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new PolicyError(`PI_CONSOLE_PORT "${portRaw.slice(0, 20)}" is not a port number (0-65535).`);
	}

	const loopback = isLoopbackHost(host);
	const wildcard = isWildcardHost(host);
	const allowRemote = env.PI_CONSOLE_ALLOW_REMOTE === "1";
	const authRaw = String(env.PI_CONSOLE_AUTH ?? "")
		.trim()
		.toLowerCase();
	if (!["", "token", "off"].includes(authRaw)) {
		throw new PolicyError('PI_CONSOLE_AUTH must be "token" (the default) or "off".');
	}
	const authOff = authRaw === "off";
	const allowedHosts = parseAllowedHosts(env.PI_CONSOLE_ALLOWED_HOSTS);

	if (!loopback && !allowRemote) {
		throw new PolicyError(
			`PI_CONSOLE_HOST=${host} is not a loopback address, and the console can run shell commands as you. ` +
				"Keep PI_CONSOLE_HOST on 127.0.0.1 (use an SSH tunnel for remote access). " +
				"To expose it deliberately, set PI_CONSOLE_ALLOW_REMOTE=1; that requires token authentication " +
				"and, over plain HTTP, TLS termination in front (see the security notes in packages/web-ui/README.md).",
		);
	}
	if (authOff && (!loopback || allowRemote)) {
		throw new PolicyError(
			"PI_CONSOLE_AUTH=off is only permitted for a loopback bind without PI_CONSOLE_ALLOW_REMOTE. " +
				"Remote access always requires the access token.",
		);
	}
	if (allowRemote && wildcard && allowedHosts.length === 0) {
		throw new PolicyError(
			`binding ${host} needs PI_CONSOLE_ALLOWED_HOSTS (comma-separated host names or addresses clients will use), ` +
				"otherwise every request fails the Host check.",
		);
	}

	const warnings = [];
	let token = null;
	let tokenSource = null;
	if (!authOff) {
		const supplied = suppliedToken(env);
		if (supplied) {
			token = supplied.token;
			tokenSource = supplied.source;
			warnings.push(...supplied.warnings);
		} else {
			token = generateToken();
			tokenSource = "generated";
		}
	} else {
		warnings.push(
			"AUTHENTICATION IS DISABLED (PI_CONSOLE_AUTH=off). Any local process, and any page that passes the " +
				"Host/Origin checks, can drive agents with shell access as you. Development use only.",
		);
	}
	if (allowRemote && !loopback) {
		warnings.push(
			"remote access enabled: this server speaks plain HTTP, so the access token crosses the network in " +
				"clear text unless TLS is terminated in front of it (SSH tunnel or a TLS proxy that preserves the Host header). " +
				"A reverse proxy or CORS setting is not authentication; the token is.",
		);
	}

	return {
		host,
		port,
		loopback,
		wildcard,
		allowRemote,
		auth: authOff ? "off" : "token",
		token,
		tokenSource,
		allowedHosts,
		warnings,
	};
}

// ------------------------------------------------------- request evaluation ---
const SAFE_METHODS = new Set(["GET", "HEAD"]);

export function isStateChanging(method) {
	const m = String(method || "GET").toUpperCase();
	return !SAFE_METHODS.has(m) && m !== "OPTIONS";
}

/** The bare media type of a Content-Type header, lower-cased. */
export function mediaType(header) {
	return String(header ?? "")
		.split(";")[0]
		.trim()
		.toLowerCase();
}

function originAllowed(origin, authorities) {
	if (typeof origin !== "string" || origin === "null") return false;
	let url;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	// An Origin is scheme://host[:port] only; anything more is not a browser-generated Origin.
	if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
		return false;
	}
	return authorities.has(url.host.toLowerCase());
}

function deny(status, code, message, extra) {
	return { ok: false, status, code, message, headers: extra || {} };
}

/**
 * Decide whether a request may proceed.
 * @returns {{ok:true}|{ok:false,status:number,code:string,message:string,headers:object}}
 */
export function evaluateRequest(req, { pathname, authorities, policy }) {
	const headers = req.headers || {};

	// 1. Host allowlist (DNS rebinding). Applies to static files too: a rebound page must not
	//    even be able to load the UI shell from our origin.
	const host = normalizeAuthority(headers.host);
	if (!host || !authorities.has(host)) {
		return deny(403, "host_not_allowed", "host not allowed");
	}

	if (!pathname.startsWith("/api/")) return { ok: true };

	// 2. Cross-origin. Checked before authentication so a hostile page learns nothing
	//    about whether it guessed anything right.
	if (headers.origin !== undefined && !originAllowed(headers.origin, authorities)) {
		return deny(403, "cross_origin", "cross-origin request refused");
	}
	const site = headers["sec-fetch-site"];
	if (site !== undefined && site !== "same-origin" && site !== "none") {
		return deny(403, "cross_site", "cross-site request refused");
	}

	// 3. Token. /api/health stays open so the launcher and the login page can tell the server
	//    is up and whether a token is needed; it reveals nothing about sessions.
	const method = String(req.method || "GET").toUpperCase();
	const open = method === "GET" && pathname === "/api/health";
	if (policy.auth === "token" && !open) {
		if (!tokenMatches(bearerToken(req), policy.token)) {
			return deny(401, "unauthorized", "access token required", {
				"WWW-Authenticate": 'Bearer realm="pi-console"',
			});
		}
	}

	// 4. Content type. Every state-changing request must declare JSON, even when bodiless.
	if (isStateChanging(method) && mediaType(headers["content-type"]) !== "application/json") {
		return deny(415, "unsupported_media_type", "Content-Type must be application/json");
	}
	return { ok: true };
}

// ---------------------------------------------------------------- headers ---
/** No inline script; styles come from our own stylesheet only (the UI sets style via CSSOM). */
export const CONTENT_SECURITY_POLICY = [
	"default-src 'none'",
	"script-src 'self'",
	"style-src 'self'",
	"img-src 'self'",
	"font-src 'self'",
	"connect-src 'self'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
	"object-src 'none'",
].join("; ");

/** Headers for every response. Deliberately no Access-Control-* header: there is no CORS. */
export function applySecurityHeaders(res, { api }) {
	res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Referrer-Policy", "no-referrer");
	res.setHeader("X-Frame-Options", "DENY");
	res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
	res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
	res.setHeader("Cache-Control", api ? "no-store" : "no-cache");
}
