import fs from "node:fs";
import path from "node:path";

function dataRoot() {
  return process.env.PI_AGENT_DATA_ROOT || process.env.PENTEST_DATA_ROOT || "/srv/data/pi-system";
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonlTail(file, limit) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(isRecord);
}

function countJsonl(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).length;
}

function latestTaskSnapshots(limit) {
  const tasksDir = path.join(dataRoot(), "tasks");
  if (!fs.existsSync(tasksDir)) return [];
  return fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(tasksDir, entry.name), "utf8"));
      } catch {
        return undefined;
      }
    })
    .filter((task) => isRecord(task) && Object.keys(task).length > 0)
    .sort((left, right) => String(right.updated_at || "").localeCompare(String(left.updated_at || "")))
    .slice(0, limit)
    .map((task) => ({
      task_id: task.task_id,
      title: task.title,
      status: task.status,
      active_step: task.active_step,
      next_step: task.next_step,
      version: task.version,
      updated_at: task.updated_at
    }));
}

export { dataRoot, readJsonlTail, countJsonl, latestTaskSnapshots };
