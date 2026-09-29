#!/usr/bin/env node
/**
 * Package-contents gate for the single published package, @satunix/pi-system.
 *
 * Packs the repository exactly as `npm publish` would (`npm pack --json`, no registry,
 * no credentials), unpacks the tarball into a scratch directory and proves the installed
 * copy works on its own:
 *
 *   1. Allowlist holds: every extension, profile, skill, prompt, theme, agent and workflow
 *      is present, and nothing private leaks (tests/, docs/, reviews/, .pi/, dist/, .env
 *      files other than the template, node_modules, the extension _template).
 *   2. Every glob in the `pi` manifest matches at least one packed file, so `pi install
 *      npm:@satunix/pi-system` loads the same resources a checkout does.
 *   3. Every profile resolves against the UNPACKED copy (not the checkout), and the
 *      installer's modules import from it, so `/profile` works after an npm install.
 *   4. Size stays under budget, so an accidental large file fails the build.
 *
 * Usage:
 *   node packages/core/pack-check.mjs            # check
 *   node packages/core/pack-check.mjs --keep     # also print the scratch dir and keep it
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WORKSPACE_ROOT } from "./lib/paths.mjs";
import { readDistribution } from "./lib/distribution.mjs";

const ROOT = WORKSPACE_ROOT;
const keep = process.argv.includes("--keep");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const MAX_UNPACKED_BYTES = 8 * 1024 * 1024;

let errors = 0;
const fail = (m) => {
  console.error(`  FAIL: ${m}`);
  errors++;
};
const ok = (m) => console.log(`  OK: ${m}`);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
if (pkg.name !== "@satunix/pi-system") fail(`package name is ${pkg.name}, expected @satunix/pi-system`);
if (pkg.private) fail("root package.json is private; it is the published package");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? "")) fail(`version "${pkg.version}" is not semver`);
if (pkg.publishConfig?.access !== "public") fail("publishConfig.access must be public for a scoped package");
// npm provenance only verifies against a public GitHub (or GitLab.com) repository, so the npm
// delivery needs repository.url to point there; git delivery only needs it set.
const delivery = readDistribution().delivery;
if (!pkg.repository?.url) fail("repository.url is not set");
else if (delivery === "npm" && !pkg.repository.url.includes("github.com/")) fail("npm delivery: repository.url must point at the public GitHub repo (npm provenance checks it)");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-system-pack-"));
try {
  console.log("[pack-check] npm pack");
  const out = execFileSync(npmCmd, ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  const info = JSON.parse(out)[0];
  const files = info.files.map((f) => f.path.replace(/\\/g, "/"));
  const fileSet = new Set(files);
  console.log(`  ${info.name}@${info.version}: ${files.length} files, ${info.size} bytes packed, ${info.unpackedSize} unpacked`);

  // 1. Allowlist.
  console.log("\n[pack-check] contents");
  const required = ["package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "CHANGELOG.md", "packages/core/install.mjs", "packages/core/sources.json", "packages/core/distribution.json", "packages/core/.env.example"];
  for (const dir of ["packages/extensions/src", "packages/extensions/third_party"]) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (name.startsWith("_") || !fs.existsSync(path.join(ROOT, dir, name, "index.ts"))) continue;
      required.push(`${dir}/${name}/index.ts`, `${dir}/${name}/extension.json`);
    }
  }
  for (const [dir, test] of [
    ["packages/kit/profiles", (f) => f.endsWith(".json")],
    ["packages/kit/prompts", (f) => f.endsWith(".md")],
    ["packages/kit/themes", (f) => f.endsWith(".json")],
    ["packages/kit/agents", (f) => f.endsWith(".md")],
    ["packages/kit/workflows", (f) => f.endsWith(".md")],
    ["packages/core/lib", (f) => f.endsWith(".mjs")],
  ]) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).filter(test)) required.push(`${dir}/${f}`);
  }
  for (const skill of fs.readdirSync(path.join(ROOT, "packages/kit/skills"))) {
    if (fs.existsSync(path.join(ROOT, "packages/kit/skills", skill, "SKILL.md"))) required.push(`packages/kit/skills/${skill}/SKILL.md`);
  }
  const missing = required.filter((f) => !fileSet.has(f));
  if (missing.length) fail(`missing from the tarball: ${missing.join(", ")}`);
  else ok(`${required.length} required files present`);

  const forbidden = [
    [/^tests\//, "tests"],
    [/^docs\//, "docs"],
    [/^reviews\//, "review records"],
    [/^dist\//, "build output"],
    [/(^|\/)\.pi\//, "pi runtime state"],
    [/(^|\/)node_modules\//, "node_modules"],
    [/(^|\/)\.env(?!\.example$)(\.|$)/, "an env file"],
    [/^packages\/extensions\/src\/_template\//, "the extension template"],
    [/^packages\/container\//, "the container package"],
    [/^packages\/core\/eval\//, "the eval harness"],
    [/^packages\/autonomy\//, "the autonomy runner"],
    [/\.(log|jsonl|pem|key|p12|tgz)$/, "logs, keys or archives"],
  ];
  const leaked = files.filter((f) => forbidden.some(([re]) => re.test(f)));
  if (leaked.length) {
    for (const f of leaked.slice(0, 20)) fail(`should not be published (${forbidden.find(([re]) => re.test(f))[1]}): ${f}`);
  } else ok("no private or build files");

  if (info.unpackedSize > MAX_UNPACKED_BYTES) fail(`unpacked size ${info.unpackedSize} exceeds the ${MAX_UNPACKED_BYTES} byte budget`);
  else ok(`unpacked size within ${MAX_UNPACKED_BYTES / 1024 / 1024} MB budget`);

  // 2. Every pi manifest glob matches something that was packed.
  console.log("\n[pack-check] pi manifest");
  const globToRe = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);
  for (const [kind, globs] of Object.entries(pkg.pi ?? {})) {
    for (const glob of globs) {
      if (glob.startsWith("!")) continue;
      const re = globToRe(glob);
      const count = files.filter((f) => re.test(f)).length;
      if (count === 0) fail(`pi.${kind} glob "${glob}" matches no packed file`);
      else ok(`pi.${kind} ${glob}: ${count}`);
    }
  }

  // 3. The unpacked copy resolves every profile on its own.
  console.log("\n[pack-check] installed copy");
  execFileSync("tar", ["-xzf", path.join(scratch, info.filename), "-C", scratch]);
  const installed = path.join(scratch, "package");
  const lib = (name) => pathToFileURL(path.join(installed, "packages", "core", "lib", name)).href;
  const [{ resolveProfile }, { listProfiles, loadProfileDef, excludedSkills, normalizeOverrides }, paths] = await Promise.all([
    import(lib("resolve.mjs")),
    import(lib("profiles.mjs")),
    import(lib("paths.mjs")),
  ]);
  if (paths.WORKSPACE_ROOT !== installed) fail(`installed copy resolves its root to ${paths.WORKSPACE_ROOT}, not ${installed}`);
  const profilesDir = path.join(installed, "packages", "kit", "profiles");
  const profiles = listProfiles(profilesDir);
  for (const name of profiles) {
    try {
      const def = loadProfileDef(name, profilesDir);
      const resolved = resolveProfile(def.include ?? []);
      const inPackage = resolved.filter((r) => r.avenue !== "external");
      const absent = inPackage.filter((r) => !fs.existsSync(r.path) || !r.path.startsWith(installed));
      if (absent.length) fail(`profile ${name}: extensions not in the installed copy: ${absent.map((r) => r.name).join(", ")}`);
      excludedSkills(def, normalizeOverrides({}));
      ok(`profile ${name}: ${inPackage.length} extensions + ${resolved.length - inPackage.length} companions resolve from the package`);
    } catch (error) {
      fail(`profile ${name}: ${error.message}`);
    }
  }
  const help = execFileSync(process.execPath, ["--check", path.join(installed, "packages", "core", "install.mjs")], { encoding: "utf8" });
  if (help.trim()) console.log(help.trim());
  ok("installer parses in the installed copy");
  if (pkg.bin && !Object.values(pkg.bin).every((b) => fileSet.has(b.replace(/^\.\//, "")))) fail("a bin entry is not in the tarball");
} catch (error) {
  fail(error?.stderr?.toString?.() || error?.message || String(error));
} finally {
  if (keep) console.log(`\n[pack-check] scratch kept at ${scratch}`);
  else fs.rmSync(scratch, { recursive: true, force: true });
}

if (errors) {
  console.error(`\n[pack-check] FAILED with ${errors} error(s)`);
  process.exit(1);
}
console.log("\n[pack-check] OK");
