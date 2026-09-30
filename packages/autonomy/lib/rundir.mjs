// Creating a run directory: the supervisor-held files a run is made of. Called once by `start`;
// nothing here is ever writable from a worker container.
//
//   contract.json   the resolved contract (read-only file mode); its hash is checked every tick
//   state.json      the authoritative record (lib/lifecycle.mjs)
//   checks.json     the acceptance check definitions, mounted read-only into gate containers
//   overlay/        held-out acceptance files copied from the operator's paths, mounted read-only
//   public/         what the worker may read (mounted read-only at /run): the sanitised contract, the spec
import fs from "node:fs";
import path from "node:path";
import { workerContract, contractDigest } from "./contract.mjs";
import { newState } from "./lifecycle.mjs";
import { renderBoundary } from "./boundary.mjs";
import { sha256, writeJsonAtomic } from "./fsutil.mjs";
import { RunStore } from "./store.mjs";
import { backlogLines } from "./templates/common.mjs";

/**
 * @param {{ contract: object, authorisation: object, home?: string, effort?: object, now?: () => Date, boundaryEffort?: object }} o
 * @returns {RunStore}
 */
export function createRun({ contract, authorisation, home, effort, now = () => new Date(), boundaryEffort }) {
  const store = new RunStore(contract.run, { home, now });
  if (fs.existsSync(store.p.state)) throw new Error(`run ${contract.run} already exists at ${store.p.root}; use \`resume\`, or choose another run id`);
  const p = store.p;
  for (const d of [p.root, p.control, p.public, p.overlay, p.steps, p.meter, p.bundles, p.gateWork, p.tmp, p.egress, p.deploy, p.results, p.references, p.work, p.agentState]) fs.mkdirSync(d, { recursive: true });
  // The overlay is snapshotted into the run directory, so the check definitions and held-out files a run
  // is judged by cannot change under it, and the operator's originals are never mounted.
  const overlay = contract.acceptance.overlay.map((o) => {
    const dest = path.join(p.overlay, o.target);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(o.source, dest);
    return { ...o, snapshot: dest, sha256: sha256(fs.readFileSync(dest)) };
  });
  const resolved = { ...contract, acceptance: { ...contract.acceptance, overlay: contract.acceptance.overlay.map((o, i) => ({ ...o, sha256: overlay[i].sha256 })) } };
  writeJsonAtomic(p.contract, resolved, { mode: 0o444 });
  writeJsonAtomic(p.checks, { schemaVersion: 1, run: contract.run, checks: contract.acceptance.checks }, { mode: 0o444 });
  writeJsonAtomic(path.join(p.public, "contract.json"), workerContract(contract), { mode: 0o444 });
  fs.writeFileSync(path.join(p.public, "spec.md"), `# ${contract.objective.title}\n\n${contract.objective.spec}\n${contract.objective.backlog.length ? `\n## Backlog\n\n${backlogLines(contract, []).join("\n")}\n` : ""}`, { mode: 0o444 });
  const b = renderBoundary(resolved, { effort: boundaryEffort });
  const state = newState({ contract: resolved, contractDigest: contractDigest(resolved), boundaryDigest: b.digest, authorisation, effort: effort ?? contract.effort, now: now().toISOString() });
  store.writeState(state);
  store.log(`run ${contract.run} created (template ${contract.template}); boundary ${b.digest.slice(0, 12)} authorised ${authorisation.via}${authorisation.by ? ` by ${authorisation.by}` : ""}`);
  return store;
}

/** The contract as the run holds it, with its hash checked against the digest recorded in state. */
export function loadRunContract(store, state) {
  const text = fs.readFileSync(store.p.contract, "utf8");
  const contract = JSON.parse(text);
  const digest = contractDigest(contract);
  return { contract, digest, intact: digest === state.contractDigest };
}
