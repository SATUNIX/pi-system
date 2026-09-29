#!/usr/bin/env node
/**
 * Scaffold a new in-repo extension from _template.
 * Usage: node kit/new-extension.mjs <name>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_ROOT, DOCS_DIR, PROFILES_DIR, FIRST_PARTY_DIR, THIRD_PARTY_DIR, SKILLS_DIR, PROMPTS_DIR, THEMES_DIR, SCHEMA_DIR, POLICIES_DIR, SOURCES_PATH, CORE_DIR, ENV_EXAMPLE, extensionRelPath } from "./lib/paths.mjs";

const ROOT = WORKSPACE_ROOT;
const name = process.argv[2];

if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error("Usage: node kit/new-extension.mjs <kebab-case-name>");
  process.exit(1);
}

const src = path.join(FIRST_PARTY_DIR, "_template");
const dst = path.join(FIRST_PARTY_DIR, name);

if (fs.existsSync(dst)) {
  console.error(`extensions/${name} already exists.`);
  process.exit(1);
}

fs.mkdirSync(dst);
for (const file of fs.readdirSync(src)) {
  let content = fs.readFileSync(path.join(src, file), "utf8");
  content = content.replaceAll("_template", name).replaceAll("EXTENSION_NAME", name);
  fs.writeFileSync(path.join(dst, file), content);
}

console.log(`Created extensions/${name}/`);
console.log(`Next: implement index.ts, fill extension.json, run: npm run verify`);
