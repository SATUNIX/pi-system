#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataRoot, parseCliJson, readJsonlTail, readLastChainRecord } from "./ledger.js";

const LEDGER_SCHEMA_VERSION = 1;
const LOCK_TIMEOUT_MS = 5000;
const FIELD_LIMITS = {
  short: 256,
  medium: 2048,
  long: 8192,
  artifact: 262144
};
const TASK_STATUSES = new Set(["candidate", "active", "blocked", "validated", "done"]);

function ensureDirs() {
  for (const dir of ["audit", "checkpoints", "trace", "db"]) {
    fs.mkdirSync(path.join(dataRoot(), dir), { recursive: true });
  }
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)])
  );
}

function stableJson(value) {
  return JSON.stringify(sortJson(value), null, 2);
}

function hashValue(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

async function withFileLock(file, callback) {
  const lockDir = `${file}.lock`;
  const started = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST" || Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new Error(`timed out acquiring file lock for ${file}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await callback();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

async function appendChainedJsonl(file, record) {
  ensureDirs();
  return withFileLock(file, () => {
    const previous = readLastChainRecord(file);
    const chained = {
      schema_version: LEDGER_SCHEMA_VERSION,
      sequence: previous.sequence + 1,
      previous_hash: previous.record_hash,
      ...record
    };
    const finalRecord = {
      ...chained,
      record_hash: hashValue(chained)
    };
    fs.appendFileSync(file, `${JSON.stringify(finalRecord)}\n`, { encoding: "utf8", flag: "a" });
    return finalRecord;
  });
}

function safeId(value, fieldName) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(normalized)) {
    throw new Error(`${fieldName} must be 1-128 chars using letters, digits, dot, colon, underscore, or dash`);
  }
  return normalized;
}

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(2).toString("hex")}`;
}

let db;

function getDb() {
  if (db) return db;
  ensureDirs();
  db = new DatabaseSync(path.join(dataRoot(), "db", "memory-mcp.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS memories (
      memory_id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      content TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(memory_id UNINDEXED, topic, content, tags);
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      active_step TEXT NOT NULL,
      next_step TEXT NOT NULL,
      notes TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_history (
      history_id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_deps (
      task_id TEXT NOT NULL,
      depends_on TEXT NOT NULL,
      PRIMARY KEY (task_id, depends_on)
    );
  `);
  return db;
}

function textAndStructured(text, structuredContent) {
  return {
    content: [{ type: "text", text }],
    structuredContent
  };
}

async function audit(event) {
  return appendChainedJsonl(path.join(dataRoot(), "audit", "audit.jsonl"), {
    timestamp: nowIso(),
    server: "pi-kit-memory-mcp",
    ...event
  });
}

function normalizeTags(tags) {
  return Array.isArray(tags) ? tags.filter((tag) => typeof tag === "string").slice(0, 50) : [];
}

function parseJsonField(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowToMemory(row) {
  if (!row) return null;
  return {
    memory_id: row.memory_id,
    topic: row.topic,
    content: row.content,
    tags: parseJsonField(row.tags_json, []),
    metadata: parseJsonField(row.metadata_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function rowToTask(row) {
  if (!row) return null;
  const deps = getDb().prepare("SELECT depends_on FROM task_deps WHERE task_id = ? ORDER BY depends_on").all(row.task_id).map((dep) => dep.depends_on);
  return {
    task_id: row.task_id,
    title: row.title,
    status: row.status,
    active_step: row.active_step,
    next_step: row.next_step,
    notes: row.notes,
    metadata: parseJsonField(row.metadata_json, {}),
    depends_on: deps,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function upsertMemoryFts(memory) {
  const database = getDb();
  database.prepare("DELETE FROM memories_fts WHERE memory_id = ?").run(memory.memory_id);
  database.prepare("INSERT INTO memories_fts(memory_id, topic, content, tags) VALUES (?, ?, ?, ?)").run(
    memory.memory_id,
    memory.topic,
    memory.content,
    memory.tags.join(" ")
  );
}

const tools = {
  async memory_store(params) {
    const topic = String(params.topic || "").slice(0, FIELD_LIMITS.medium);
    const content = String(params.content || "").slice(0, FIELD_LIMITS.long);
    if (!topic || !content) throw new Error("topic and content are required");
    const memory = {
      memory_id: newId("MEM"),
      topic,
      content,
      tags: normalizeTags(params.tags),
      metadata: params.metadata && typeof params.metadata === "object" ? params.metadata : {},
      created_at: nowIso(),
      updated_at: nowIso()
    };
    const database = getDb();
    database.prepare(`
      INSERT INTO memories(memory_id, topic, content, tags_json, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      memory.memory_id,
      memory.topic,
      memory.content,
      JSON.stringify(memory.tags),
      JSON.stringify(memory.metadata),
      memory.created_at,
      memory.updated_at
    );
    upsertMemoryFts(memory);
    await audit({ event: "memory_stored", memory_id: memory.memory_id, topic: memory.topic });
    return textAndStructured(`Memory stored: ${memory.memory_id}`, memory);
  },

  async memory_search(params) {
    const query = String(params.query || "").trim();
    const limit = Math.max(1, Math.min(Number(params.limit || 5), 50));
    if (!query) throw new Error("query is required");
    const database = getDb();
    let rows = [];
    try {
      rows = database.prepare(`
        SELECT memories.*
        FROM memories_fts
        JOIN memories ON memories.memory_id = memories_fts.memory_id
        WHERE memories_fts MATCH ?
        ORDER BY bm25(memories_fts)
        LIMIT ?
      `).all(query, limit);
    } catch {
      rows = database.prepare(`
        SELECT * FROM memories
        WHERE lower(topic || ' ' || content || ' ' || tags_json) LIKE ?
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(`%${query.toLowerCase()}%`, limit);
    }
    const results = rows.map(rowToMemory).filter(Boolean);
    await audit({ event: "memory_searched", query, count: results.length });
    return textAndStructured(`Memory search: ${results.length} result(s)`, { query, results });
  },

  async memory_update(params) {
    const memoryId = safeId(params.memory_id, "memory_id");
    const database = getDb();
    const current = rowToMemory(database.prepare("SELECT * FROM memories WHERE memory_id = ?").get(memoryId));
    if (!current) throw new Error(`memory not found: ${memoryId}`);
    const updated = {
      ...current,
      topic: params.topic ? String(params.topic).slice(0, FIELD_LIMITS.medium) : current.topic,
      content: params.content ? String(params.content).slice(0, FIELD_LIMITS.long) : current.content,
      tags: params.tags ? normalizeTags(params.tags) : current.tags,
      metadata: params.metadata && typeof params.metadata === "object" ? params.metadata : current.metadata,
      updated_at: nowIso()
    };
    database.prepare(`
      UPDATE memories SET topic = ?, content = ?, tags_json = ?, metadata_json = ?, updated_at = ?
      WHERE memory_id = ?
    `).run(updated.topic, updated.content, JSON.stringify(updated.tags), JSON.stringify(updated.metadata), updated.updated_at, memoryId);
    upsertMemoryFts(updated);
    await audit({ event: "memory_updated", memory_id: memoryId, topic: updated.topic });
    return textAndStructured(`Memory updated: ${memoryId}`, updated);
  },

  async memory_list(params) {
    const limit = Math.max(1, Math.min(Number(params.limit || 20), 100));
    const database = getDb();
    const rows = params.topic
      ? database.prepare("SELECT * FROM memories WHERE topic = ? ORDER BY updated_at DESC LIMIT ?").all(String(params.topic), limit)
      : database.prepare("SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?").all(limit);
    const memories = rows.map(rowToMemory).filter(Boolean);
    return textAndStructured(`Memory list: ${memories.length}`, { memories });
  },

  async task_create(params) {
    const taskId = params.task_id ? safeId(params.task_id, "task_id") : newId("TASK");
    const title = String(params.title || "").slice(0, FIELD_LIMITS.medium);
    if (!title) throw new Error("title is required");
    const status = TASK_STATUSES.has(params.status) ? params.status : "candidate";
    const task = {
      task_id: taskId,
      title,
      status,
      active_step: String(params.active_step || "").slice(0, FIELD_LIMITS.medium),
      next_step: String(params.next_step || "").slice(0, FIELD_LIMITS.medium),
      notes: String(params.notes || "").slice(0, FIELD_LIMITS.long),
      metadata: params.metadata && typeof params.metadata === "object" ? params.metadata : {},
      depends_on: Array.isArray(params.depends_on) ? params.depends_on.map((dep) => safeId(dep, "depends_on")).slice(0, 100) : [],
      version: 1,
      created_at: nowIso(),
      updated_at: nowIso()
    };
    const database = getDb();
    database.prepare(`
      INSERT INTO tasks(task_id, title, status, active_step, next_step, notes, metadata_json, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task.task_id, task.title, task.status, task.active_step, task.next_step, task.notes, JSON.stringify(task.metadata), task.version, task.created_at, task.updated_at);
    for (const dep of task.depends_on) database.prepare("INSERT OR IGNORE INTO task_deps(task_id, depends_on) VALUES (?, ?)").run(task.task_id, dep);
    database.prepare("INSERT INTO task_history(task_id, version, snapshot_json, created_at) VALUES (?, ?, ?, ?)").run(task.task_id, task.version, JSON.stringify(task), nowIso());
    await audit({ event: "task_created", task_id: task.task_id, status: task.status });
    return textAndStructured(`Task created: ${task.task_id}`, task);
  },

  async task_state_read(params) {
    const database = getDb();
    if (params.task_id) {
      const taskId = safeId(params.task_id, "task_id");
      const task = rowToTask(database.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId));
      await audit({ event: "task_state_read", task_id: taskId, found: Boolean(task) });
      return textAndStructured(task ? `Task state: ${taskId}` : `Task state absent: ${taskId}`, { task_id: taskId, task });
    }
    const tasks = database.prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 50").all().map(rowToTask).filter(Boolean);
    await audit({ event: "task_state_index_read", count: tasks.length });
    return textAndStructured(`Task states: ${tasks.length}`, { tasks });
  },

  async task_state_update(params) {
    const taskId = safeId(params.task_id, "task_id");
    const database = getDb();
    const current = rowToTask(database.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId));
    if (!current) throw new Error(`task not found: ${taskId}`);
    const status = params.status && TASK_STATUSES.has(params.status) ? params.status : current.status;
    const task = {
      ...current,
      title: params.title ? String(params.title).slice(0, FIELD_LIMITS.medium) : current.title,
      status,
      active_step: params.active_step !== undefined ? String(params.active_step).slice(0, FIELD_LIMITS.medium) : current.active_step,
      next_step: params.next_step !== undefined ? String(params.next_step).slice(0, FIELD_LIMITS.medium) : current.next_step,
      notes: params.notes !== undefined ? String(params.notes).slice(0, FIELD_LIMITS.long) : current.notes,
      metadata: params.metadata && typeof params.metadata === "object" ? params.metadata : current.metadata,
      depends_on: Array.isArray(params.depends_on) ? params.depends_on.map((dep) => safeId(dep, "depends_on")).slice(0, 100) : current.depends_on,
      version: current.version + 1,
      updated_at: nowIso()
    };
    database.prepare(`
      UPDATE tasks SET title = ?, status = ?, active_step = ?, next_step = ?, notes = ?, metadata_json = ?, version = ?, updated_at = ?
      WHERE task_id = ?
    `).run(task.title, task.status, task.active_step, task.next_step, task.notes, JSON.stringify(task.metadata), task.version, task.updated_at, taskId);
    database.prepare("DELETE FROM task_deps WHERE task_id = ?").run(taskId);
    for (const dep of task.depends_on) database.prepare("INSERT OR IGNORE INTO task_deps(task_id, depends_on) VALUES (?, ?)").run(taskId, dep);
    database.prepare("INSERT INTO task_history(task_id, version, snapshot_json, created_at) VALUES (?, ?, ?, ?)").run(taskId, task.version, JSON.stringify(task), nowIso());
    await audit({ event: "task_state_updated", task_id: taskId, version: task.version, status: task.status });
    return textAndStructured(`Task state updated: ${taskId} v${task.version}`, task);
  },

  async task_complete(params) {
    return tools.task_state_update({ ...params, status: "done" });
  },

  async task_list(params) {
    const status = params.status && TASK_STATUSES.has(params.status) ? params.status : "";
    const limit = Math.max(1, Math.min(Number(params.limit || 50), 100));
    const database = getDb();
    const rows = status
      ? database.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC LIMIT ?").all(status, limit)
      : database.prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?").all(limit);
    const tasks = rows.map(rowToTask).filter(Boolean);
    return textAndStructured(`Task list: ${tasks.length}`, { tasks });
  },

  async checkpoint_append(params) {
    const taskId = safeId(params.task_id, "task_id");
    const record = {
      checkpoint_id: newId("CP"),
      timestamp: nowIso(),
      task_id: taskId,
      summary: String(params.summary || "").slice(0, FIELD_LIMITS.medium),
      current_state: String(params.current_state || "").slice(0, FIELD_LIMITS.long),
      next_step: String(params.next_step || "").slice(0, FIELD_LIMITS.medium),
      blockers: Array.isArray(params.blockers) ? params.blockers.map(String).slice(0, 20) : []
    };
    if (!record.summary) throw new Error("summary is required");
    const chained = await appendChainedJsonl(path.join(dataRoot(), "checkpoints", `${taskId}.jsonl`), record);
    await audit({ event: "checkpoint_appended", task_id: taskId, checkpoint_id: record.checkpoint_id });
    return textAndStructured(`Checkpoint appended: ${record.checkpoint_id}`, chained);
  },

  async trace_append(params) {
    const eventType = String(params.event_type || "").slice(0, FIELD_LIMITS.short);
    if (!eventType) throw new Error("event_type is required");
    const record = await appendChainedJsonl(path.join(dataRoot(), "trace", "trace.jsonl"), {
      timestamp: nowIso(),
      event_type: eventType,
      payload: params.payload && typeof params.payload === "object" ? params.payload : {}
    });
    return textAndStructured(`Trace appended: ${record.sequence}`, record);
  },

  async trace_tail(params) {
    const limit = Math.max(1, Math.min(Number(params.limit || 20), 100));
    const events = readJsonlTail(path.join(dataRoot(), "trace", "trace.jsonl"), limit);
    return textAndStructured(`Trace tail: ${events.length}`, { events });
  },

  async state_summary(params) {
    const maxItems = Math.max(1, Math.min(Number(params.max_items || 5), 20));
    const database = getDb();
    const memories = database.prepare("SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?").all(maxItems).map(rowToMemory).filter(Boolean);
    const tasks = database.prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?").all(maxItems).map(rowToTask).filter(Boolean);
    const traceFile = path.join(dataRoot(), "trace", "trace.jsonl");
    const summary = {
      data_root: dataRoot(),
      counts: {
        memories: database.prepare("SELECT COUNT(*) AS count FROM memories").get().count,
        tasks: database.prepare("SELECT COUNT(*) AS count FROM tasks").get().count,
        trace_events: readLastChainRecord(traceFile).sequence
      },
      latest_hashes: {
        audit: readLastChainRecord(path.join(dataRoot(), "audit", "audit.jsonl")).record_hash,
        trace: readLastChainRecord(traceFile).record_hash
      },
      latest_memory: memories,
      tasks,
      latest_trace: readJsonlTail(traceFile, maxItems)
    };
    await audit({ event: "state_summary_read", max_items: maxItems });
    return textAndStructured(`State summary: ${summary.counts.memories} memories, ${summary.counts.tasks} tasks`, summary);
  }
};

async function callTool(name, params) {
  const tool = tools[name];
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return tool(params || {});
}

async function registerMcpTools(server, z) {
  const anyObject = z.record(z.string(), z.unknown()).optional();
  server.registerTool("memory_store", {
    title: "Store Memory",
    description: "Store durable memory in the general pi-kit memory server.",
    inputSchema: { topic: z.string().min(1).max(FIELD_LIMITS.medium), content: z.string().min(1).max(FIELD_LIMITS.long), tags: z.array(z.string()).optional(), metadata: anyObject }
  }, (params) => callTool("memory_store", params));
  server.registerTool("memory_search", {
    title: "Search Memory",
    description: "Search durable memory using SQLite FTS fallback.",
    inputSchema: { query: z.string().min(1).max(FIELD_LIMITS.medium), limit: z.number().int().min(1).max(50).optional() }
  }, (params) => callTool("memory_search", params));
  server.registerTool("memory_update", {
    title: "Update Memory",
    description: "Update durable memory fields.",
    inputSchema: { memory_id: z.string().min(1).max(FIELD_LIMITS.short), topic: z.string().optional(), content: z.string().optional(), tags: z.array(z.string()).optional(), metadata: anyObject }
  }, (params) => callTool("memory_update", params));
  server.registerTool("memory_list", {
    title: "List Memory",
    description: "List recent memory records.",
    inputSchema: { topic: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }
  }, (params) => callTool("memory_list", params));
  server.registerTool("task_create", {
    title: "Create Task",
    description: "Create a durable task node.",
    inputSchema: { task_id: z.string().optional(), title: z.string().min(1), status: z.enum([...TASK_STATUSES]).optional(), active_step: z.string().optional(), next_step: z.string().optional(), notes: z.string().optional(), depends_on: z.array(z.string()).optional(), metadata: anyObject }
  }, (params) => callTool("task_create", params));
  server.registerTool("task_list", {
    title: "List Tasks",
    description: "List durable task nodes.",
    inputSchema: { status: z.enum([...TASK_STATUSES]).optional(), limit: z.number().int().min(1).max(100).optional() }
  }, (params) => callTool("task_list", params));
  server.registerTool("task_state_read", {
    title: "Read Task State",
    description: "Read a task or task index.",
    inputSchema: { task_id: z.string().optional() }
  }, (params) => callTool("task_state_read", params));
  server.registerTool("task_state_update", {
    title: "Update Task State",
    description: "Update a durable task node.",
    inputSchema: { task_id: z.string().min(1), title: z.string().optional(), status: z.enum([...TASK_STATUSES]).optional(), active_step: z.string().optional(), next_step: z.string().optional(), notes: z.string().optional(), depends_on: z.array(z.string()).optional(), metadata: anyObject }
  }, (params) => callTool("task_state_update", params));
  server.registerTool("task_complete", {
    title: "Complete Task",
    description: "Mark a task done.",
    inputSchema: { task_id: z.string().min(1), notes: z.string().optional() }
  }, (params) => callTool("task_complete", params));
  server.registerTool("checkpoint_append", {
    title: "Append Checkpoint",
    description: "Append a hash-chained checkpoint.",
    inputSchema: { task_id: z.string().min(1), summary: z.string().min(1), current_state: z.string().optional(), next_step: z.string().optional(), blockers: z.array(z.string()).optional() }
  }, (params) => callTool("checkpoint_append", params));
  server.registerTool("trace_append", {
    title: "Append Trace",
    description: "Append a hash-chained trace event.",
    inputSchema: { event_type: z.string().min(1), payload: z.record(z.string(), z.unknown()).optional() }
  }, (params) => callTool("trace_append", params));
  server.registerTool("trace_tail", {
    title: "Tail Trace",
    description: "Read recent trace events.",
    inputSchema: { limit: z.number().int().min(1).max(100).optional() }
  }, (params) => callTool("trace_tail", params));
  server.registerTool("state_summary", {
    title: "State Summary",
    description: "Return compact memory/task/trace recovery state.",
    inputSchema: { max_items: z.number().int().min(1).max(20).optional() }
  }, (params) => callTool("state_summary", params));
}

async function main() {
  const [, , mode, toolName, rawParams] = process.argv;
  if (mode === "--call") {
    const result = await callTool(toolName, parseCliJson(rawParams));
    process.stdout.write(`${JSON.stringify(result.structuredContent ?? result)}\n`);
    return;
  }

  const [{ McpServer }, { StdioServerTransport }, { z }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("zod")
  ]);
  const server = new McpServer({ name: "pi-kit-memory-mcp", version: "0.1.0" });
  await registerMcpTools(server, z);
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
