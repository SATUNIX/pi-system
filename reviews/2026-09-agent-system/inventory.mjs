import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveProfile } from '../../kit/lib/resolve.mjs';
const out = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(out, '../..');
const installed = path.join(os.homedir(), 'Cyber/Development/OffSec/AI Area/misc-agents-pi-kit/dist/pi-kit-lite');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const hash = p => fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null;
const files = [];
for (const tree of ['extensions', 'vendor']) for (const entry of fs.readdirSync(path.join(root, tree))) {
  const relative = `${tree}/${entry}/index.ts`;
  if (fs.existsSync(path.join(root, relative))) files.push(relative);
}
const profiles = Object.fromEntries(fs.readdirSync(path.join(root, 'profiles')).filter(f => f.endsWith('.json')).map(f => {
  const p = read(path.join(root, 'profiles', f));
  return [p.name, resolveProfile(p.include).map(({ name, avenue, path: absolute, source }) => ({ name, avenue, path: absolute ? path.relative(root, absolute).replaceAll('\\', '/') : undefined, source }))];
}));
const settings = read(path.join(os.homedir(), '.pi/agent/settings.json'));
const runtimeBase = path.join(os.homedir(), 'AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent');
const inventory = {
  baseline: '6460ef6392dc290038f5ad79835861f9e5e06134', collectedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  sourceVersion: read(path.join(root, 'package.json')).version,
  lockSha256: hash(path.join(root, 'package-lock.json')),
  localRuntime: read(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json')).version,
  installedCliRuntime: read(path.join(runtimeBase, 'package.json')).version,
  configuredPackages: settings.packages,
  installedArtifact: installed, installedVersion: fs.existsSync(path.join(installed, 'package.json')) ? read(path.join(installed, 'package.json')).version : null,
  installedResourceManifest: fs.existsSync(path.join(installed, 'package.json')) ? read(path.join(installed, 'package.json')).pi : null,
  profiles, lite: read(path.join(root, 'surfaces/lite.json')),
  runtimeHashes: Object.fromEntries(['dist/core/extensions/runner.js', 'dist/core/agent-session.js', 'dist/modes/interactive/interactive-mode.js'].map(f => [f, { installed: hash(path.join(runtimeBase, f)), local: hash(path.join(root, 'node_modules/@earendil-works/pi-coding-agent', f)) }])),
  sourceInstalledComparisons: files.map(relative => {
    const source = hash(path.join(root, relative)), artifact = hash(path.join(installed, relative));
    return { path: relative, source, installed: artifact, relation: artifact === null ? 'absent-from-artifact' : source === artifact ? 'identical' : 'different' };
  }),
  caveat: 'Settings and files on disk are not a receipt of bytes already loaded in live processes. No live process/session body inspection performed.'
};
fs.writeFileSync(path.join(out, 'runtime-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
const prompts = [], execution = [];
for (const file of files) fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/).forEach((line, i) => {
  if (/sendUserMessage|sendMessage\(|systemPrompt:|includeInCompact|registerCommand\(|pi\.on\("input"/.test(line)) prompts.push({ file, line: i + 1, source: line.trim() });
  if (/\b(spawn|execFile|execSync|execFileSync|spawnSync|exec|fork)\(/.test(line)) execution.push({ file, line: i + 1, source: line.trim() });
});
fs.writeFileSync(path.join(out, 'prompt-execution-catalog.json'), JSON.stringify({ prompts, execution, caveat: 'Static source lead index. Dynamic imports, optional external packages and active tool/resource selection require separate validation.' }, null, 2) + '\n');
console.log(JSON.stringify({ files: files.length, profiles: Object.keys(profiles), comparisons: Object.fromEntries(['identical', 'different', 'absent-from-artifact'].map(r => [r, inventory.sourceInstalledComparisons.filter(x => x.relation === r).length])), promptLeads: prompts.length, executionLeads: execution.length }));
