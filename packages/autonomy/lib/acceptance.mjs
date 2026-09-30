// Trusted acceptance evaluation: the supervisor runs the contract's checks against a commit it
// accepted, in clean, network-less gate containers, from definitions in the run directory
// (never from files in the worker's repository), and records evidence for each. Worker-authored
// tests and reports are inputs to review, never the sole authority.
import fs from "node:fs";
import path from "node:path";
import { canonicalJson, sha256, writeJsonAtomic } from "./fsutil.mjs";

const clip = (text, max) => { const s = String(text ?? ""); return s.length <= max ? s : `${s.slice(0, max / 4)}\n...[${s.length - max} characters cut]...\n${s.slice(-(max * 3) / 4)}`; };

/**
 * Run every check for `sha` and write one evidence file per check.
 * @param {{ rt: object, contract: object, sha: string, step: number, dir: string, runRoot?: string, log?: Function, only?: string[] }} o
 *   dir: where evidence files go; runRoot: the run directory, so evidence paths in state are relative to it
 * @returns {Promise<{ sha: string, step: number, at: string, results: object[], allRequiredPass: boolean }>}
 */
export async function runAcceptance({ rt, contract, sha, step, dir, runRoot, log = () => {}, only }) {
  fs.mkdirSync(dir, { recursive: true });
  const results = [];
  const checks = contract.acceptance.checks.filter((c) => !only || only.includes(c.id));
  // Command checks first (they judge the code), then service health (which judges the deployment).
  const ordered = [...checks.filter((c) => c.type !== "service-health"), ...checks.filter((c) => c.type === "service-health")];
  for (const check of ordered) {
    const started = rt.now();
    let raw;
    try {
      raw = check.type === "service-health" ? await rt.serviceHealth({ check }) : await rt.runCheck({ check, sha });
    } catch (error) {
      raw = { exitCode: 125, timedOut: false, tail: `the check could not run: ${error.message}`, error: true };
    }
    const pass = check.type === "service-health" ? Boolean(raw.ok) : raw.exitCode === 0 && !raw.timedOut && !raw.error;
    const result = {
      id: check.id, type: check.type, required: check.required, sha, step, pass,
      exitCode: raw.exitCode ?? (pass ? 0 : 1), timedOut: Boolean(raw.timedOut),
      seconds: raw.seconds ?? Math.round((rt.now() - started) / 1000),
      definitionDigest: sha256(canonicalJson(check)),
      tail: clip(raw.tail ?? raw.detail ?? "", 4000),
      ...(Array.isArray(raw.steps) ? { steps: raw.steps.slice(0, 20).map((x) => ({ name: String(x.name).slice(0, 60), code: Number(x.code), seconds: Number(x.seconds) || 0 })) } : {}),
      at: new Date(rt.now()).toISOString(),
    };
    const file = path.join(dir, `${check.id}.json`);
    writeJsonAtomic(file, result);
    results.push({ ...result, evidence: path.relative(runRoot ?? path.dirname(path.dirname(path.dirname(dir))), file) });
    log(`check ${check.id}: ${pass ? "PASS" : "FAIL"}${result.timedOut ? " (timed out)" : ""}`);
  }
  const allRequiredPass = contract.acceptance.checks.filter((c) => c.required).every((c) => results.find((r) => r.id === c.id)?.pass === true) && checks.length === contract.acceptance.checks.length;
  return { sha, step, at: new Date(rt.now()).toISOString(), results, allRequiredPass };
}

/** The compact form kept in state.json (the tail stays in the evidence file). */
export function summariseEvaluation(ev) {
  return { sha: ev.sha, step: ev.step, at: ev.at, allRequiredPass: ev.allRequiredPass, results: ev.results.map(({ id, required, pass, exitCode, timedOut, seconds, evidence }) => ({ id, required, pass, exitCode, timedOut, seconds, evidence })) };
}
