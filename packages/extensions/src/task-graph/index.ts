import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";

// task-graph: a persistent DAG task board shared by the orchestrator and its implementer subagents.
// The planner emits tasks (with dependencies); implementers claim the next unblocked task and mark
// it done. Stored at .pi/task-graph.json so it survives subprocess boundaries and compaction.

type Status = "pending" | "in_progress" | "done" | "blocked";

interface Task {
  id: string;
  title: string;
  description?: string;
  dependsOn: string[];
  status: Status;
  notes?: string;
  createdAt: string;
}

interface Graph {
  tasks: Task[];
}

const VALID_STATUSES: Status[] = ["pending", "in_progress", "done", "blocked"];

// Advisory lock for mutating task-graph operations. An O_EXCL lockfile gives cross-process
// mutual exclusion (parallel implementer subagents are separate processes), and a stale lock
// older than LOCK_STALE_MS is taken over so a crashed holder cannot wedge the graph forever.
const LOCK_STALE_MS = 60_000;

function withGraphLock<T>(cwd: string, operation: () => T): { ok: true; value: T } | { ok: false; reason: string } {
  const lock = path.join(cwd, ".pi", "task-graph.lock");
  let fd: number | undefined;
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    try { fd = fs.openSync(lock, "wx"); } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
      } catch { /* fail closed below */ }
      try { fd = fs.openSync(lock, "wx"); } catch { return { ok: false, reason: "task-graph is busy or unreadable" }; }
    }
    try {
      return { ok: true, value: operation() };
    } finally {
      try { if (fd !== undefined) fs.closeSync(fd); } catch { /* release best effort */ }
      try { fs.rmSync(lock, { force: true }); } catch { /* stale lock is fail-closed */ }
    }
  } catch {
    return { ok: false, reason: "task-graph is unavailable" };
  }
}

function graphPath(cwd: string): string {
  return path.join(cwd, ".pi", "task-graph.json");
}

function load(cwd: string): Graph {
  try {
    const g = JSON.parse(fs.readFileSync(graphPath(cwd), "utf8")) as Graph;
    if (Array.isArray(g.tasks)) {
      // WU-2: a graph may be edited externally or persisted by an older build, so an
      // element may be a non-object or lack dependsOn. Validate on load and repair/drop
      // rather than crashing depStatus/isUnblocked (which read t.dependsOn).
      const tasks: Task[] = [];
      let dropped = 0;
      let repaired = 0;
      for (const raw of g.tasks) {
        if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || raw.id.length === 0) {
          dropped++;
          continue;
        }
        if (!Array.isArray(raw.dependsOn)) {
          raw.dependsOn = [];
          repaired++;
        }
        tasks.push(raw);
      }
      if (dropped > 0 || repaired > 0) {
        process.stderr.write(
          `[task-graph] load: dropped ${dropped} malformed task(s), repaired ${repaired} missing dependsOn in ${graphPath(cwd)}\n`,
        );
      }
      return { tasks };
    }
  } catch {
    /* fall through */
  }
  return { tasks: [] };
}

// Atomic write (temp file + rename): a concurrent reader (e.g. a parallel implementer
// subagent) never observes a partially-written graph. This does not provide true
// cross-process mutual exclusion for two near-simultaneous writers - a real lease system
// (advisory lock + retry) is tracked as forward work in the Capability Engineering
// Roadmap - but it does close the torn-write failure mode within a single write.
function save(cwd: string, g: Graph): void {
  const dir = path.join(cwd, ".pi");
  fs.mkdirSync(dir, { recursive: true });
  const file = graphPath(cwd);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(g, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function nextId(g: Graph): string {
  let n = g.tasks.length + 1;
  while (g.tasks.some((t) => t.id === `t${n}`)) n++;
  return `t${n}`;
}

// AG-03/M-05 fix: task_create previously accepted any depends_on list unchecked - a
// missing task ID or a task depending on itself both silently "succeeded", so the graph
// was not actually a DAG. Validate before insertion. The full cycle walk below is
// defense in depth: today's tool surface only lets depends_on reference already-created
// (i.e. earlier-created) task IDs, so a multi-task cycle isn't constructible through
// task_create/task_update alone - but this keeps the invariant real if a future
// dependsOn-editing capability is ever added, rather than relying on that structural
// accident.
function validateDependencies(g: Graph, taskId: string, dependsOn: string[]): string | null {
  for (const dep of dependsOn) {
    if (dep === taskId) return `depends_on cannot include the task's own id (${taskId})`;
    if (!g.tasks.some((t) => t.id === dep)) return `depends_on references unknown task '${dep}'`;
  }
  // Cycle check: would adding taskId -> dependsOn edges create a cycle reachable back to
  // taskId? Walk the dependency graph (including the new edges) from each declared dep.
  const adjacency = new Map<string, string[]>(g.tasks.map((t) => [t.id, t.dependsOn]));
  adjacency.set(taskId, dependsOn);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function hasCycleFrom(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dep of adjacency.get(id) ?? []) {
      if (hasCycleFrom(dep)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  if (hasCycleFrom(taskId)) return `depends_on would create a dependency cycle involving ${taskId}`;
  return null;
}

function depStatus(g: Graph, t: Task): string {
  if (t.dependsOn.length === 0) return "";
  const parts = t.dependsOn.map((d) => {
    const dep = g.tasks.find((x) => x.id === d);
    return `${d}:${dep?.status ?? "missing"}`;
  });
  return ` (deps ${parts.join(", ")})`;
}

function isUnblocked(g: Graph, t: Task): boolean {
  return t.dependsOn.every((d) => g.tasks.find((x) => x.id === d)?.status === "done");
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: undefined };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "task_create",
    label: "Task: create",
    description: "Create a task in the shared task graph. Returns its id. Use depends_on to order work.",
    parameters: Type.Object({
      title: Type.String({ description: "Task title" }),
      description: Type.Optional(Type.String({ description: "Task detail" })),
      depends_on: Type.Optional(Type.Array(Type.String(), { description: "IDs of prerequisite tasks" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = withGraphLock(ctx.cwd, () => {
        const g = load(ctx.cwd);
        const id = nextId(g);
        const dependsOn = params.depends_on ?? [];
        const error = validateDependencies(g, id, dependsOn);
        if (error) return text(`Cannot create task: ${error}`);
        const task: Task = {
          id,
          title: params.title,
          description: params.description,
          dependsOn,
          status: "pending",
          createdAt: new Date().toISOString(),
        };
        g.tasks.push(task);
        save(ctx.cwd, g);
        return text(`Created ${task.id}: ${task.title}${depStatus(g, task)}`);
      });
      return result.ok ? result.value : text(`Cannot update task graph: ${result.reason}`);
    },
  });

  pi.registerTool({
    name: "task_update",
    label: "Task: update",
    description: "Update a task's status (pending|in_progress|done|blocked) and/or notes.",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID" }),
      status: Type.Optional(Type.String({ description: "pending | in_progress | done | blocked" })),
      notes: Type.Optional(Type.String({ description: "Progress notes" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = withGraphLock(ctx.cwd, () => {
        const g = load(ctx.cwd);
        const t = g.tasks.find((x) => x.id === params.id);
        if (!t) return text(`No such task: ${params.id}`);
        // AG-03 fix: status was cast unchecked - task_update(id, "teleported") silently
        // persisted an invalid value the rest of the graph's logic (isUnblocked,
        // task_next, task_complete) does not understand.
        if (params.status !== undefined) {
          if (!VALID_STATUSES.includes(params.status as Status)) {
            return text(`Invalid status '${params.status}' — must be one of: ${VALID_STATUSES.join(", ")}`);
          }
          if (params.status === "done" && !isUnblocked(g, t)) {
            const unfinished = t.dependsOn.filter((d) => g.tasks.find((x) => x.id === d)?.status !== "done");
            return text(`Cannot complete ${t.id}: unfinished dependencies (${unfinished.join(", ")})`);
          }
          t.status = params.status as Status;
        }
        if (params.notes !== undefined) t.notes = params.notes;
        save(ctx.cwd, g);
        return text(`Updated ${t.id}: ${t.status}`);
      });
      return result.ok ? result.value : text(`Cannot update task graph: ${result.reason}`);
    },
  });

  pi.registerTool({
    name: "task_list",
    label: "Task: list",
    description: "List tasks in the graph, optionally filtered by status.",
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "Filter by status" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const g = load(ctx.cwd);
      const tasks = params.status ? g.tasks.filter((t) => t.status === params.status) : g.tasks;
      if (tasks.length === 0) return text("(no tasks)");
      const lines = tasks.map((t) => `- ${t.id} [${t.status}] ${t.title}${depStatus(g, t)}`);
      return text(lines.join("\n"));
    },
  });

  pi.registerTool({
    name: "task_next",
    label: "Task: next",
    description: "Return the next actionable task: a pending task whose dependencies are all done. Claims it (marks in_progress) so a second call does not hand out the same task twice.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const result = withGraphLock(ctx.cwd, () => {
        const g = load(ctx.cwd);
        const next = g.tasks.find((t) => t.status === "pending" && isUnblocked(g, t));
        if (!next) {
          const remaining = g.tasks.filter((t) => t.status !== "done").length;
          return text(remaining === 0 ? "All tasks done." : "No unblocked task (remaining tasks are waiting on dependencies).");
        }
        // AG-03 fix: task_next previously only READ the next task without claiming it, so
        // two consecutive calls (e.g. two implementer subagents racing to pull work) both
        // received the same task. Mark it in_progress here, in the same load-modify-save
        // cycle, before returning it. The exclusive lock makes claim-vs-claim atomic across
        // processes, so two parallel implementers cannot both win the same task.
        next.status = "in_progress";
        save(ctx.cwd, g);
        return text(`Next: ${next.id} — ${next.title}${next.description ? `\n${next.description}` : ""}`);
      });
      return result.ok ? result.value : text(`Cannot update task graph: ${result.reason}`);
    },
  });

  pi.registerTool({
    name: "task_complete",
    label: "Task: complete",
    description: "Mark a task as done.",
    parameters: Type.Object({ id: Type.String({ description: "Task ID" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = withGraphLock(ctx.cwd, () => {
        const g = load(ctx.cwd);
        const t = g.tasks.find((x) => x.id === params.id);
        if (!t) return text(`No such task: ${params.id}`);
        // AG-03 fix: completion previously ignored dependencies entirely - task_complete(t2)
        // succeeded even while t2 still depended on an unfinished t1.
        if (!isUnblocked(g, t)) {
          const unfinished = t.dependsOn.filter((d) => g.tasks.find((x) => x.id === d)?.status !== "done");
          return text(`Cannot complete ${t.id}: unfinished dependencies (${unfinished.join(", ")})`);
        }
        t.status = "done";
        save(ctx.cwd, g);
        const left = g.tasks.filter((x) => x.status !== "done").length;
        return text(`Completed ${t.id}. ${left} task(s) remaining.`);
      });
      return result.ok ? result.value : text(`Cannot update task graph: ${result.reason}`);
    },
  });
}
