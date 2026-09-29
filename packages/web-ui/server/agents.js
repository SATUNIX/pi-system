// agents.js — discover pi agent definitions (.md with YAML frontmatter).
// Read-only. User-level agents take precedence over project-level of the same name.
import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_DIRS } from "./config.js";

/** Parse the leading `---\n...\n---` block into a flat string map. */
function parseFrontmatter(text) {
  const out = {};
  if (!text.startsWith("---")) return out;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return out;
  const block = text.slice(3, end);
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    out[key] = value;
  }
  return out;
}

/** Body after the frontmatter block, or the whole file when there is none. */
export function agentBody(text) {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text;
  return text.slice(text.indexOf("\n", end + 4) + 1).trim();
}

function readAgentFile(filePath, source) {
  const text = fs.readFileSync(filePath, "utf8");
  const fm = parseFrontmatter(text);
  const fallbackName = path.basename(filePath, ".md");
  const tools = (fm.tools || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    name: fm.name || fallbackName,
    description: fm.description || "",
    tools,
    source,
    path: filePath,
  };
}

/** List every agent file across the configured directories. */
export function listAgents() {
  const seen = new Map(); // name -> agent (first source wins: user before project)
  for (let index = 0; index < AGENT_DIRS.length; index++) {
    const dir = AGENT_DIRS[index];
    const source = index === 0 ? "user" : "project";
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // directory may not exist
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      try {
        const agent = readAgentFile(path.join(dir, entry.name), source);
        if (!seen.has(agent.name)) seen.set(agent.name, agent);
      } catch {
        // skip unreadable/invalid files
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve one agent by name (user-level first, then project-level). */
export function resolveAgent(name, source) {
  if (source === "user" || source === "project") {
    // listAgents() de-duplicates by name (user wins), so a project-level agent that
    // shares a name with a user-level one is absent from that list. Scan the requested
    // directory directly so `?source=` can still disambiguate duplicate names.
    const index = source === "project" ? 1 : 0;
    const dir = AGENT_DIRS[index];
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      try {
        const agent = readAgentFile(path.join(dir, entry.name), source);
        if (agent.name === name) return agent;
      } catch {
        // skip unreadable/invalid files
      }
    }
    return null;
  }
  if (source) return null; // unknown source must not fall through to user precedence
  return listAgents().find((a) => a.name === name) || null;
}
