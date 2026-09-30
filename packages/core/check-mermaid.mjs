#!/usr/bin/env node
/**
 * Validate every Mermaid diagram in the repository's Markdown.
 *
 * GitHub renders ```mermaid fences, so a diagram with a syntax error shows up as a red box on the
 * page that was meant to explain something. This parses each fenced block with Mermaid's own
 * parser (the same one the renderer uses), so a broken diagram fails the gate instead. It checks
 * syntax, not layout: it does not render.
 *
 * Mermaid needs a DOM only for label sanitising, so a jsdom window is installed before it loads.
 *
 * Usage:
 *   node packages/core/check-mermaid.mjs          # check every .md file
 *   node packages/core/check-mermaid.mjs --list   # list the diagrams found, parse nothing
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".claude", ".cache", "dist", "site", "coverage", ".pi"]);

/** Every Markdown file under `root`, repo-relative and sorted. */
export function listMarkdown(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/** The ```mermaid blocks of one document: `{ line, code }`, `line` being the line of the opening fence. */
export function extractDiagrams(markdown) {
  const diagrams = [];
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)(`{3,}|~{3,})\s*mermaid\b/i.exec(lines[i]);
    if (!open) continue;
    const fence = open[2];
    const body = [];
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(lines[j])) body.push(lines[j++]);
    diagrams.push({ line: i + 1, code: body.join("\n"), closed: j < lines.length });
    i = j;
  }
  return diagrams;
}

async function loadMermaid() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  const mermaid = (await import("mermaid")).default;
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
  return mermaid;
}

/**
 * Parse every diagram in `files` (repo-relative, read from `root`).
 * @returns {Promise<{ checked: number, problems: string[] }>}
 */
export async function checkFiles(files, root = ROOT, mermaid = null) {
  const parser = mermaid ?? (await loadMermaid());
  let checked = 0;
  const problems = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    for (const diagram of extractDiagrams(text)) {
      checked++;
      if (!diagram.closed) {
        problems.push(`${file}:${diagram.line}: the mermaid fence is never closed`);
        continue;
      }
      if (!diagram.code.trim()) {
        problems.push(`${file}:${diagram.line}: the mermaid block is empty`);
        continue;
      }
      try {
        await parser.parse(diagram.code);
      } catch (error) {
        const detail = String(error?.message ?? error).split("\n").slice(0, 3).join(" | ");
        problems.push(`${file}:${diagram.line}: ${detail}`);
      }
    }
  }
  return { checked, problems };
}

async function main() {
  const files = listMarkdown();
  if (process.argv.includes("--list")) {
    for (const file of files) {
      for (const d of extractDiagrams(fs.readFileSync(path.join(ROOT, file), "utf8"))) console.log(`${file}:${d.line}`);
    }
    return;
  }
  const { checked, problems } = await checkFiles(files);
  for (const problem of problems) console.error(`  FAIL: ${problem}`);
  if (problems.length) {
    console.error(`[check-mermaid] ${problems.length} of ${checked} diagram(s) failed`);
    process.exit(1);
  }
  console.log(`[check-mermaid] OK: ${checked} diagram(s) in ${files.length} Markdown file(s) parse`);
  process.exit(0);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
