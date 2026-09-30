/**
 * memory-vault — the on-disk vault: an Obsidian-compatible folder of Markdown notes.
 *
 *   <vault>/MEMORY.md                               index of every memory (regenerated)
 *   <vault>/Memory/<slug>.md                        global memories (apply everywhere)
 *   <vault>/Projects/<project>/<project>.md         project hub: memories + recent recaps
 *   <vault>/Projects/<project>/Memory/<slug>.md     project memories
 *   <vault>/Projects/<project>/Recaps/YYYY-MM-DD.md per-turn recaps, one "## HH:MM — title" each
 *   <vault>/.pi-index/                              search index, lock, error log (hidden from Obsidian)
 *   <vault>/.trash/                                 forgotten notes (Obsidian's own trash folder)
 *
 * Every write is atomic (tmp + rename) under an O_EXCL lock, and the index is re-validated
 * against file mtimes on every read, so concurrent sessions see each other's writes (the old
 * store cached memories.json once per process and rewrote it whole, losing concurrent writes).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bm25, jaccard, passesFloor, termFrequencies, tokenize, type Doc } from "./search.ts";

export const MEMORY_TYPES = ["fact", "decision", "preference", "gotcha", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export type Scope = "global" | "project";

export interface VaultConfig {
  root: string;
  recaps: boolean;
  recapModel?: string;
  autoPromote: boolean;
  recallLimit: number;
  minScore: number;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const off = (v: string | undefined) => /^(0|false|off|no)$/i.test(v?.trim() ?? "");

// Settings: env wins, then <agent dir>/pi-kit/memory.json, then defaults.
export function loadConfig(): VaultConfig {
  const file = readJson(path.join(agentDir(), "pi-kit", "memory.json")) ?? {};
  const num = (env: string | undefined, fromFile: unknown, fallback: number) => {
    const n = Number(env ?? fromFile);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const root = process.env.PI_KIT_VAULT?.trim() || (typeof file.vault === "string" && file.vault.trim()) || path.join(os.homedir(), ".pi", "vault");
  return {
    root: path.resolve(root.replace(/^~(?=$|\/)/, os.homedir())),
    recaps: process.env.PI_KIT_RECAPS !== undefined ? !off(process.env.PI_KIT_RECAPS) : file.recaps !== false,
    recapModel: process.env.PI_KIT_RECAP_MODEL?.trim() || (typeof file.recapModel === "string" ? file.recapModel : undefined),
    autoPromote: process.env.PI_KIT_MEMORY_AUTOPROMOTE !== undefined ? !off(process.env.PI_KIT_MEMORY_AUTOPROMOTE) : file.autoPromote !== false,
    recallLimit: num(process.env.PI_KIT_MEMORY_RECALL_LIMIT, file.recallLimit, 3),
    minScore: num(process.env.PI_KIT_MEMORY_MIN_SCORE, file.minScore, 1.5),
  };
}

export function slugify(text: string, max = 60): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "note";
}

// A project is named after its git root (so every subdirectory shares one project), else cwd.
export function projectName(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return slugify(path.basename(dir));
    const parent = path.dirname(dir);
    if (parent === dir) return slugify(path.basename(path.resolve(cwd)));
    dir = parent;
  }
}

export const projectDir = (root: string, project: string) => path.join(root, "Projects", project);
export const memoryDir = (root: string, scope: Scope, project: string) => (scope === "global" ? path.join(root, "Memory") : path.join(projectDir(root, project), "Memory"));
export const recapFile = (root: string, project: string, date: string) => path.join(projectDir(root, project), "Recaps", `${date}.md`);
const indexDir = (root: string) => path.join(root, ".pi-index");

// --- redaction ---------------------------------------------------------------
// The vault must never hold a secret. Models are told to omit them, but a recap or saved
// memory can still copy one from a tool result, so mask the common shapes before writing.
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b((?:api[_-]?key|secret|token|password|passwd|pwd|auth)["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m, prefix) => (typeof prefix === "string" && m.startsWith(prefix) ? `${prefix}[REDACTED]` : "[REDACTED]"));
  return out;
}

// --- notes -------------------------------------------------------------------

export interface NoteMeta {
  id: string;
  title: string;
  type: MemoryType;
  scope: Scope;
  project?: string;
  tags: string[];
  pinned?: boolean;
  created: string;
  updated: string;
  source: string;
}

export interface Note {
  meta: NoteMeta;
  body: string;
  file: string;
}

function yamlValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => yamlValue(x)).join(", ")}]`;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  const s = String(v ?? "");
  return /^[\w./@+-][\w ./@+:-]*$/.test(s) && !/^(true|false|null|yes|no)$/i.test(s) && !/:\s/.test(s) ? s : JSON.stringify(s);
}

export function serializeNote(meta: NoteMeta, body: string): string {
  const order: Array<keyof NoteMeta> = ["id", "title", "type", "scope", "project", "tags", "pinned", "created", "updated", "source"];
  const lines = order.filter((k) => meta[k] !== undefined && !(k === "pinned" && !meta.pinned)).map((k) => `${k}: ${yamlValue(meta[k])}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}

function parseScalar(raw: string): unknown {
  const v = raw.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    return v
      .slice(1, -1)
      .split(",")
      .map((x) => parseScalar(x))
      .filter((x) => x !== "");
  }
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  if (v === "true" || v === "false") return v === "true";
  return v;
}

export function parseNote(text: string, file: string): Note | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const fm: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = parseScalar(kv[2]);
  }
  const type = MEMORY_TYPES.includes(fm.type as MemoryType) ? (fm.type as MemoryType) : "fact";
  const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : typeof fm.tags === "string" && fm.tags ? [fm.tags] : [];
  const id = typeof fm.id === "string" && fm.id ? fm.id : path.basename(file, ".md");
  return {
    file,
    body: m[2].trim(),
    meta: {
      id,
      title: typeof fm.title === "string" && fm.title ? fm.title : id,
      type,
      scope: fm.scope === "global" ? "global" : "project",
      project: typeof fm.project === "string" ? fm.project : undefined,
      tags,
      pinned: fm.pinned === true,
      created: String(fm.created ?? ""),
      updated: String(fm.updated ?? fm.created ?? ""),
      source: String(fm.source ?? "unknown"),
    },
  };
}

// --- atomic writes + lock ------------------------------------------------------

export function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Serialises read-modify-write sequences (dedupe + write, recap append, hub regeneration)
// across sessions. A lock older than 15 s is presumed abandoned by a crashed process.
export function withLock<T>(root: string, fn: () => T): T {
  const lock = path.join(indexDir(root), "lock");
  fs.mkdirSync(indexDir(root), { recursive: true });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 15_000) fs.rmSync(lock, { force: true });
      } catch {
        /* vanished */
      }
      if (Date.now() > deadline) throw new Error(`memory vault is locked (${lock}); remove it if no pi session is writing`);
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

export function logError(root: string, message: string): void {
  try {
    fs.mkdirSync(indexDir(root), { recursive: true });
    fs.appendFileSync(path.join(indexDir(root), "errors.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* never throw from error logging */
  }
}

// --- index ---------------------------------------------------------------------

interface IndexEntry {
  mtimeMs: number;
  meta: NoteMeta;
  tf: Record<string, number>;
  len: number;
  tokens: string[];
  titleTokens: string[];
}

interface IndexFile {
  version: 1;
  notes: Record<string, IndexEntry>;
}

// A cached entry is only trustworthy if it is shaped like one: a valid JSON file can still
// omit meta/tf/len/tokens or carry a partial meta, and callers read straight into e.meta
// (writeIndexPages dereferences meta.tags.length/.map, meta.title and meta.pinned). Any
// field a consumer reads must be present and the right type, or the entry is re-parsed
// from disk. Keep this a pure type guard.
function isIndexEntry(prior: unknown): prior is IndexEntry {
  if (typeof prior !== "object" || prior === null) return false;
  const e = prior as Record<string, unknown>;
  const meta = e.meta;
  if (typeof meta !== "object" || meta === null) return false;
  const m = meta as Record<string, unknown>;
  return (
    typeof e.mtimeMs === "number" &&
    typeof e.tf === "object" &&
    e.tf !== null &&
    Array.isArray(e.tokens) &&
    Array.isArray(e.titleTokens) &&
    typeof e.len === "number" &&
    typeof m.title === "string" &&
    typeof m.type === "string" &&
    (m.scope === "global" || m.scope === "project") &&
    Array.isArray(m.tags) &&
    m.tags.every((t) => typeof t === "string") &&
    (m.id === undefined || typeof m.id === "string") &&
    (m.project === undefined || typeof m.project === "string") &&
    (m.pinned === undefined || typeof m.pinned === "boolean")
  );
}

function memoryFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) if (e.isFile() && e.name.endsWith(".md")) out.push(path.join(dir, e.name));
  };
  walk(path.join(root, "Memory"));
  let projects: string[] = [];
  try {
    projects = fs.readdirSync(path.join(root, "Projects"));
  } catch {
    /* none yet */
  }
  for (const p of projects) walk(path.join(root, "Projects", p, "Memory"));
  return out;
}

// The "Project: [[…]]" backlink saveMemory appends is navigation, not content.
const stripBacklink = (body: string) => body.replace(/\n*Project: \[\[[^\]]*\]\]\s*$/, "");

function docTokens(meta: Pick<NoteMeta, "title" | "tags">, body: string): string[] {
  // Title and tags count double: they are the note's own summary of what it is about.
  const head = tokenize(`${meta.title} ${meta.tags.join(" ")}`);
  return [...head, ...head, ...tokenize(stripBacklink(body))];
}

// Load the index, re-reading only notes whose mtime changed. Written back when it changed.
export function loadIndex(root: string): Map<string, IndexEntry> {
  const file = path.join(indexDir(root), "index.json");
  const cached = (readJson(file) as IndexFile | null)?.notes ?? {};
  const current = new Map<string, IndexEntry>();
  let changed = false;
  for (const abs of memoryFiles(root)) {
    const rel = path.relative(root, abs);
    // One open file: the mtime that keys the cache and the text that is indexed describe the same file.
    let mtimeMs: number;
    let text: string | null = null;
    const prior = cached[rel];
    try {
      const fd = fs.openSync(abs, "r");
      try {
        mtimeMs = fs.fstatSync(fd).mtimeMs;
        if (!(isIndexEntry(prior) && prior.mtimeMs === mtimeMs)) text = fs.readFileSync(fd, "utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    if (text === null) {
      current.set(rel, prior as IndexEntry);
      continue;
    }
    changed = true;
    try {
      const note = parseNote(text, abs);
      if (!note) continue;
      const tokens = docTokens(note.meta, note.body);
      current.set(rel, { mtimeMs, meta: note.meta, tf: termFrequencies(tokens), len: tokens.length, tokens: [...new Set(tokens)], titleTokens: [...new Set(tokenize(note.meta.title))] });
    } catch {
      /* unreadable note: skip */
    }
  }
  if (changed || Object.keys(cached).length !== current.size) {
    try {
      writeAtomic(file, JSON.stringify({ version: 1, notes: Object.fromEntries(current) } satisfies IndexFile));
    } catch {
      /* the index is a cache */
    }
  }
  return current;
}

// --- operations ------------------------------------------------------------------

export interface SaveInput {
  title: string;
  body: string;
  type?: MemoryType;
  tags?: string[];
  scope?: Scope;
  project: string;
  pinned?: boolean;
  source?: string;
}

export interface SaveResult {
  action: "created" | "updated";
  file: string;
  rel: string;
  id: string;
}

// A memory duplicates an existing one in the same scope when the titles say the same thing
// (same content words, any order), or when the whole notes overlap strongly AND the titles are
// related. Whole-note overlap alone is not enough: short notes on different topics share
// boilerplate words and were merged ("Concurrent amber memory" into "Concurrent birch memory").
const DUPLICATE_TITLE_SIMILARITY = 0.75;
const DUPLICATE_SIMILARITY = 0.7;
const RELATED_TITLE_SIMILARITY = 0.5;

// Create a memory, or update the existing one it duplicates (same slug in the same scope, or
// a note in the same scope whose title+content overlap strongly). Never creates near-copies.
export function saveMemory(root: string, input: SaveInput): SaveResult {
  const scope: Scope = input.scope === "global" ? "global" : "project";
  const title = redact(input.title.trim()).slice(0, 120) || "Untitled";
  const body = redact(input.body.trim());
  const requestedType = MEMORY_TYPES.includes(input.type as MemoryType) ? (input.type as MemoryType) : undefined;
  const tags = [...new Set((input.tags ?? []).map((t) => slugify(t, 30)).filter(Boolean))];
  const dir = memoryDir(root, scope, input.project);
  const now = new Date().toISOString();
  return withLock(root, () => {
    const index = loadIndex(root);
    const slug = slugify(title);
    let target = path.join(dir, `${slug}.md`);
    let existing: Note | null = fs.existsSync(target) ? parseNote(fs.readFileSync(target, "utf8"), target) : null;
    if (!existing) {
      const mine = docTokens({ title, tags }, body);
      const myTitle = tokenize(title);
      const sameScope = [...index.entries()].filter(([rel]) => path.resolve(root, path.dirname(rel)) === path.resolve(dir));
      let best: { rel: string; sim: number } | null = null;
      for (const [rel, entry] of sameScope) {
        const titleSim = myTitle.length ? jaccard(myTitle, entry.titleTokens ?? []) : 0;
        const noteSim = jaccard(mine, entry.tokens);
        const duplicate = titleSim >= DUPLICATE_TITLE_SIMILARITY || (noteSim >= DUPLICATE_SIMILARITY && titleSim >= RELATED_TITLE_SIMILARITY);
        const sim = Math.max(titleSim, noteSim);
        if (duplicate && (!best || sim > best.sim)) best = { rel, sim };
      }
      if (best) {
        target = path.join(root, best.rel);
        existing = parseNote(fs.readFileSync(target, "utf8"), target);
      }
    }
    const meta: NoteMeta = {
      id: existing?.meta.id ?? slug,
      // A fuzzy match keeps the note's own title: the filename (Obsidian's note name) and any
      // [[links]] to it stay valid; only the content is refreshed.
      title: existing ? existing.meta.title : title,
      // An update keeps the note's type unless a type was given explicitly.
      type: requestedType ?? existing?.meta.type ?? "fact",
      scope,
      project: scope === "project" ? input.project : undefined,
      tags: [...new Set([...(existing?.meta.tags ?? []), ...tags])],
      pinned: input.pinned ?? existing?.meta.pinned,
      created: existing?.meta.created || now,
      updated: now,
      source: input.source ?? existing?.meta.source ?? "agent",
    };
    const link = scope === "project" ? `\n\nProject: [[Projects/${input.project}/${input.project}|${input.project}]]` : "";
    writeAtomic(target, serializeNote(meta, `${body}${link}`));
    writeIndexPages(root, input.project);
    return { action: existing ? "updated" : "created", file: target, rel: path.relative(root, target), id: meta.id };
  });
}

export interface SearchHit {
  rel: string;
  file: string;
  meta: NoteMeta;
  score: number;
  snippet: string;
}

export function searchMemories(
  root: string,
  query: string,
  opts: { project: string; scope?: "project" | "global" | "all"; limit?: number; minScore?: number; gate?: boolean },
): SearchHit[] {
  const index = loadIndex(root);
  const scope = opts.scope ?? "all";
  const docs: Doc[] = [];
  for (const [rel, e] of index) {
    const isGlobal = e.meta.scope === "global" || rel.startsWith(`Memory${path.sep}`);
    const inProject = rel.startsWith(path.join("Projects", opts.project) + path.sep);
    if (scope === "global" ? !isGlobal : scope === "project" ? !inProject : !(isGlobal || inProject)) continue;
    docs.push({ id: rel, tf: e.tf, len: e.len });
  }
  const terms = new Set(tokenize(query)).size;
  const scored = bm25(query, docs).filter((s) => !opts.gate || passesFloor(s, terms, opts.minScore ?? 1.5));
  return scored.slice(0, opts.limit ?? 5).map((s) => {
    const entry = index.get(s.id)!;
    const file = path.join(root, s.id);
    let snippet = "";
    try {
      snippet = parseNote(fs.readFileSync(file, "utf8"), file)?.body.replace(/\n\nProject: \[\[.*$/s, "").slice(0, 400) ?? "";
    } catch {
      /* raced with a delete */
    }
    return { rel: s.id, file, meta: entry.meta, score: s.score, snippet };
  });
}

// Resolve a memory by id, slug or vault-relative path, preferring the current project.
export function findMemory(root: string, ref: string, project: string): { rel: string; meta: NoteMeta } | null {
  const index = loadIndex(root);
  const norm = ref.trim().replace(/\.md$/, "");
  const candidates = [...index.entries()].filter(([rel, e]) => rel.replace(/\.md$/, "") === norm || e.meta.id === norm || path.basename(rel, ".md") === norm);
  candidates.sort(([a], [b]) => Number(b.includes(path.join("Projects", project))) - Number(a.includes(path.join("Projects", project))));
  return candidates[0] ? { rel: candidates[0][0], meta: candidates[0][1].meta } : null;
}

// Forget = move to Obsidian's .trash (recoverable), never a hard delete.
export function forgetMemory(root: string, ref: string, project: string): string | null {
  return withLock(root, () => {
    const hit = findMemory(root, ref, project);
    if (!hit) return null;
    const src = path.join(root, hit.rel);
    const dest = path.join(root, ".trash", `${Date.now()}-${path.basename(hit.rel)}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    writeIndexPages(root, hit.meta.project ?? project);
    return hit.rel;
  });
}

// --- recaps -------------------------------------------------------------------------

export interface Recap {
  title: string;
  did: string;
  next?: string;
  files?: string[];
  decisions?: string[];
}

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function localTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function appendRecap(root: string, project: string, recap: Recap, now = new Date(), session?: string): string {
  const date = localDate(now);
  const file = recapFile(root, project, date);
  const lines = [`## ${localTime(now)} — ${redact(recap.title).replace(/\n/g, " ").slice(0, 100)}`, "", `**Did:** ${redact(recap.did).trim()}`];
  if (recap.next?.trim()) lines.push(`**Next:** ${redact(recap.next).trim()}`);
  if (recap.files?.length) lines.push(`**Files:** ${recap.files.slice(0, 12).map((f) => `\`${f.replace(/`/g, "")}\``).join(", ")}`);
  if (recap.decisions?.length) lines.push("**Decisions:**", ...recap.decisions.slice(0, 6).map((d) => `- ${redact(d).trim()}`));
  const section = `${lines.join("\n")}\n`;
  return withLock(root, () => {
    // The vault lock is held, so nothing else in this process family creates the file between these two steps; "ax" (append,
    // fail if it exists) makes the create atomic even against a writer that is not.
    const header = serializeFrontmatter({ type: "recap-log", project, date, tags: ["recap"] });
    const firstEntry = `${header}\n# ${project} — ${date}\n\nPart of [[Projects/${project}/${project}|${project}]].${session ? ` Session \`${session}\`.` : ""}\n\n${section}`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, firstEntry, { flag: "wx", mode: 0o600 });
      writeIndexPages(root, project);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      fs.appendFileSync(file, `\n${section}`);
    }
    return file;
  });
}

function serializeFrontmatter(fields: Record<string, unknown>): string {
  return `---\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${yamlValue(v)}`)
    .join("\n")}\n---\n`;
}

export interface RecapSection {
  date: string;
  heading: string;
  text: string;
}

// The newest `count` recap sections for a project, newest first.
export function recentRecaps(root: string, project: string, count: number): RecapSection[] {
  const dir = path.join(projectDir(root, project), "Recaps");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse();
  } catch {
    return [];
  }
  const out: RecapSection[] = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const sections = text.split(/\n(?=## )/).filter((s) => s.startsWith("## ")).reverse();
    for (const s of sections) {
      out.push({ date: f.replace(/\.md$/, ""), heading: s.split("\n")[0].replace(/^## /, ""), text: s.trim() });
      if (out.length >= count) return out;
    }
  }
  return out;
}

// --- index pages (MEMORY.md + project hub) -----------------------------------------------

function writeIndexPages(root: string, project: string): void {
  const index = loadIndex(root);
  const byGroup = new Map<string, Array<[string, IndexEntry]>>();
  for (const [rel, e] of index) {
    const group = e.meta.scope === "global" || rel.startsWith(`Memory${path.sep}`) ? "Global" : (e.meta.project ?? rel.split(path.sep)[1] ?? "Other");
    byGroup.set(group, [...(byGroup.get(group) ?? []), [rel, e]]);
  }
  const link = (rel: string, title: string) => `[[${rel.replace(/\.md$/, "").split(path.sep).join("/")}|${title.replace(/[[\]|]/g, "")}]]`;
  const line = ([rel, e]: [string, IndexEntry]) => `- ${link(rel, e.meta.title)} — ${e.meta.type}${e.meta.pinned ? ", pinned" : ""}${e.meta.tags.length ? ` · ${e.meta.tags.map((t) => `#${t}`).join(" ")}` : ""}`;
  const groups = [...byGroup.keys()].sort((a, b) => (a === "Global" ? -1 : b === "Global" ? 1 : a.localeCompare(b)));
  const memory = [
    "# Memory index",
    "",
    "Maintained by pi (memory-vault). Edit the notes themselves, not this page.",
    "",
    ...groups.flatMap((g) => [`## ${g === "Global" ? "Global" : `[[Projects/${g}/${g}|${g}]]`}`, "", ...byGroup.get(g)!.sort((a, b) => a[1].meta.title.localeCompare(b[1].meta.title)).map(line), ""]),
  ].join("\n");
  writeAtomic(path.join(root, "MEMORY.md"), memory);

  const pdir = projectDir(root, project);
  let recapDays: string[] = [];
  try {
    recapDays = fs.readdirSync(path.join(pdir, "Recaps")).filter((f) => f.endsWith(".md")).sort().reverse().slice(0, 14);
  } catch {
    /* none */
  }
  const own = (byGroup.get(project) ?? []).sort((a, b) => Number(b[1].meta.pinned ?? false) - Number(a[1].meta.pinned ?? false) || a[1].meta.title.localeCompare(b[1].meta.title));
  const hub = [
    serializeFrontmatter({ type: "project", project, tags: ["project"] }),
    `# ${project}`,
    "",
    "## Memories",
    "",
    ...(own.length ? own.map(line) : ["_None yet._"]),
    "",
    "## Recent recaps",
    "",
    ...(recapDays.length ? recapDays.map((f) => `- [[Projects/${project}/Recaps/${f.replace(/\.md$/, "")}|${f.replace(/\.md$/, "")}]]`) : ["_None yet._"]),
    "",
    "Back to [[MEMORY]].",
    "",
  ].join("\n");
  writeAtomic(path.join(pdir, `${project}.md`), hub);
}

// --- migration from memory-local -------------------------------------------------------

export function migrateMemoryLocal(root: string, project: string): number {
  const src = path.join(process.env.PI_KIT_MEMORY_DIR?.trim() || path.join(agentDir(), "memory-local"), "memories.json");
  const marker = path.join(indexDir(root), "migrated-memory-local");
  if (fs.existsSync(marker) || !fs.existsSync(src)) return 0;
  const entries = readJson(src);
  let count = 0;
  if (Array.isArray(entries)) {
    for (const e of entries) {
      if (!e || typeof e.text !== "string" || !e.text.trim()) continue;
      const text = e.text.trim();
      saveMemory(root, {
        title: text.split(/[.\n]/)[0].slice(0, 80),
        body: text,
        tags: Array.isArray(e.tags) ? e.tags.map(String) : [],
        scope: "global", // memory-local had no scope; global keeps them reachable everywhere
        project,
        source: "memory-local",
      });
      count++;
    }
  }
  writeAtomic(marker, `${new Date().toISOString()} migrated ${count} from ${src}\n`);
  return count;
}
