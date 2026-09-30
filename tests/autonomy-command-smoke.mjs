#!/usr/bin/env node
// /autonomy (packages/extensions/src/autonomy-run): the operator's way to start autonomous runs
// from inside pi. What must hold:
//   - it is a command and registers NO tool, so a model cannot start, authorise or promote a run;
//   - `start` shows the boundary and needs the person to confirm it on screen; declining starts
//     nothing; accepting records an authorisation bound to the digest and only then starts;
//   - with no screen, `start` refuses unless the contract already carries an authorisation for
//     exactly this boundary (the CLI decides, the extension never widens it);
//   - promote / reconfigure / cancel / resume --approve ask first; a decline changes nothing;
//   - arguments never reach a shell, and a malformed run id is rejected before any process starts;
//   - against the REAL CLI, `templates` and `plan` work end to end (no container engine needed).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePi, isolateKitEnv, loadModule, rmWorkspace, setEnv } from "../packages/core/eval/harness.mjs";

const restoreKit = isolateKitEnv();
const mod = await loadModule("extensions/autonomy-run/index.ts");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

let checks = 0;
const ok = (name) => { checks += 1; console.log(`  ok  ${name}`); };

const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-autonomy-cmd-"));
const LOG = path.join(work, "calls.jsonl");
const AUTH = path.join(work, "authorised");

// A stand-in for cli.mjs that records every call and answers the JSON protocol.
const FAKE = path.join(work, "fake-cli.mjs");
fs.writeFileSync(FAKE, `
import fs from "node:fs";
const args = process.argv.slice(2);
const json = args.includes("--json");
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + "\\n");
const cmd = args[0];
(() => {
const out =(o, code = 0) => { console.log(JSON.stringify(o)); process.exit(code); };
const text = (t, code = 0) => { console.log(t); process.exit(code); };
const authorised = () => fs.existsSync(process.env.FAKE_AUTH);
if (cmd === "plan") {
  const DIGEST = "d1".repeat(32);
  if (args.includes("--authorise")) {
    const shown = args[args.indexOf("--digest") + 1];
    if (args.includes("--digest") && shown !== (process.env.FAKE_NOW_DIGEST || DIGEST)) return out({ ok: false, command: "plan", error: "the boundary changed since it was shown to you", code: "refused" }, 3);
    fs.writeFileSync(process.env.FAKE_AUTH, args.join(" "));
    return out({ ok: true, command: "plan", authorisation: { status: "authorised" } });
  }
  const data = { ok: true, command: "plan", run: "demo-run-1", digest: DIGEST, authorisation: { status: authorised() ? "authorised" : "missing" }, problems: [] };
  if (json) return out(data);
  text("Boundary for run demo-run-1 (template implement)\\ndigest " + (process.env.FAKE_TEXT_DIGEST || data.digest) + "\\nFilesystem\\n  worker writes: /work");
}
if (cmd === "start") {
  if (!authorised()) return out({ ok: false, command: "start", error: "not authorised", code: "refused" }, 3);
  return out({ ok: true, command: "start", run: "demo-run-1", started: true, detached: args.includes("--detach"), pid: 4242, log: "/tmp/demo.log", status: "succeeded" });
}
if (cmd === "promote") {
  if (!args.includes("--yes")) return out({ ok: false, command: "promote", error: "this promotion needs your approval: fast-forward branch pi/demo. Re-run with --yes, or from a terminal.", code: "refused" }, 3);
  return json ? out({ ok: true, command: "promote", status: "done" }) : text("promotion done");
}
if (cmd === "reconfigure") {
  if (!args.includes("--yes")) return out({ ok: false, command: "reconfigure", error: "reconfigure changes the run's effort or budgets, so it needs your confirmation: re-run with --yes", code: "refused" }, 3);
  return json ? out({ ok: true, command: "reconfigure" }) : text("reconfigured");
}
if (json) return out({ ok: true, command: cmd });
text(cmd + " ok");
})();
`);

const restores = [setEnv("PI_AUTONOMY_CLI", FAKE), setEnv("FAKE_LOG", LOG), setEnv("FAKE_AUTH", AUTH)];
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const reset = () => { fs.rmSync(LOG, { force: true }); fs.rmSync(AUTH, { force: true }); };

function session({ hasUI = true, answers = [] } = {}) {
  const pi = fakePi();
  mod.default(pi.api);
  const notes = [];
  const asked = [];
  const queue = [...answers];
  const ctx = {
    hasUI,
    cwd: work,
    ui: {
      notify: (message, level) => notes.push({ message, level }),
      confirm: async (title, body) => { asked.push({ title, body }); return queue.length ? queue.shift() : false; },
    },
  };
  return { pi, ctx, notes, asked, run: (args) => pi.commands.get("autonomy").handler(args, ctx) };
}
const errWrites = [];
const realStderr = process.stderr.write.bind(process.stderr);

try {
  // 1. A command, and no tool.
  {
    const s = session();
    assert.ok(s.pi.commands.has("autonomy"));
    assert.equal(s.pi.tools.size, 0, "no tool: a model cannot start or authorise a run");
    assert.equal(s.pi.handlers.size, 0, "no hooks either: nothing observes or steers the model");
    ok("/autonomy is a command; the extension registers no tool and no hook");
  }

  // 2. Declined: the boundary is shown, nothing is authorised, nothing starts.
  {
    reset();
    const s = session({ answers: [false] });
    await s.run("start run.json");
    assert.equal(s.asked.length, 1);
    assert.match(s.asked[0].body, /Boundary for run demo-run-1/);
    assert.match(s.asked[0].body, /digest d1d1d1/, "the digest is on the screen the person confirms");
    assert.equal(calls().some((c) => c[0] === "start"), false, "declining starts nothing");
    assert.equal(fs.existsSync(AUTH), false, "declining records no authorisation");
    assert.match(s.notes.at(-1).message, /Not authorised\. Nothing was started/);
    ok("declining the boundary starts nothing and records nothing");
  }

  // 3. Accepted: authorise (bound to the digest, by the person) then start detached.
  {
    reset();
    const s = session({ answers: [true] });
    await s.run("start run.json");
    const seq = calls().map((c) => c[0] + (c.includes("--authorise") ? ":authorise" : ""));
    assert.deepEqual(seq, ["plan", "plan", "plan:authorise", "start"]);
    const start = calls().find((c) => c[0] === "start");
    assert.ok(start.includes("--detach") && start.includes("--yes") && start.includes("--config"));
    assert.ok(path.isAbsolute(start[start.indexOf("--config") + 1]), "the contract path is resolved against the working directory");
    const authorise = calls().find((c) => c.includes("--authorise"));
    assert.ok(authorise.includes("--by") && authorise[authorise.indexOf("--by") + 1] === os.userInfo().username);
    assert.equal(authorise[authorise.indexOf("--digest") + 1], "d1".repeat(32), "the authorisation is bound to the digest that was on screen");
    assert.match(s.notes.at(-1).message, /Run demo-run-1 started \(supervisor pid 4242\)/);
    ok("accepting authorises the shown boundary (by its digest) as the person, then starts the run in the background");
  }

  // 3b. The file changes between the person reading the boundary and the authorisation: nothing is authorised.
  {
    reset();
    const restoreNow = setEnv("FAKE_NOW_DIGEST", "e2".repeat(32));
    try {
      const s = session({ answers: [true] });
      await s.run("start run.json");
      assert.equal(calls().some((c) => c[0] === "start"), false, "no start after a boundary that changed under the person");
      assert.equal(fs.existsSync(AUTH), false, "the changed boundary was not authorised");
      assert.match(s.notes.at(-1).message, /could not record the authorisation: .*changed since it was shown/);
    } finally {
      restoreNow();
    }
    // Two reads of the file that disagree (the text on screen is not the digest that would be authorised): refused before asking.
    reset();
    const restoreText = setEnv("FAKE_TEXT_DIGEST", "e2".repeat(32));
    try {
      const s = session({ answers: [true] });
      await s.run("start run.json");
      assert.equal(s.asked.length, 0, "the person is not asked to confirm a boundary that is not the one that would be authorised");
      assert.equal(calls().some((c) => c[0] === "start" || c.includes("--authorise")), false);
      assert.match(s.notes.at(-1).message, /changed while its boundary was being read/);
    } finally {
      restoreText();
    }
    ok("a boundary that changes between reading and authorising is refused: the authorisation carries the shown digest, and the text and digest must agree");
  }

  // 4. A contract already authorised for this exact boundary is still confirmed on screen; no second authorisation.
  {
    reset();
    fs.writeFileSync(AUTH, "x");
    const s = session({ answers: [true] });
    await s.run("start run.json --foreground");
    assert.equal(calls().some((c) => c.includes("--authorise")), false, "no new authorisation when the contract already carries one");
    assert.equal(calls().find((c) => c[0] === "start").includes("--detach"), false, "--foreground runs in the foreground");
    ok("a pre-authorised contract is still shown and confirmed; --foreground does not detach");
  }

  // 5. No screen: refuse unless the contract already carries the authorisation.
  {
    reset();
    const s = session({ hasUI: false });
    process.stderr.write = (chunk) => { errWrites.push(String(chunk)); return true; };
    try { await s.run("start run.json"); } finally { process.stderr.write = realStderr; }
    assert.equal(calls().some((c) => c[0] === "start"), false, "no start without a screen and without an authorisation");
    assert.match(errWrites.join(""), /no screen to confirm the boundary on/);
    reset();
    fs.writeFileSync(AUTH, "x");
    const s2 = session({ hasUI: false });
    process.stderr.write = (chunk) => { errWrites.push(String(chunk)); return true; };
    try { await s2.run("start run.json"); } finally { process.stderr.write = realStderr; }
    assert.equal(calls().some((c) => c[0] === "start"), true, "a contract authorised for exactly this boundary may start headless");
    ok("headless start needs an existing authorisation for exactly this boundary");
  }

  // 6. Confirm-first commands.
  {
    reset();
    const declined = session({ answers: [false] });
    await declined.run("promote demo-run-1");
    assert.equal(declined.asked.length, 1);
    assert.match(declined.asked[0].body, /fast-forward branch pi\/demo/, "the CLI's own description of the promotion is what is shown");
    assert.equal(calls().some((c) => c[0] === "promote" && c.includes("--yes")), false, "declining promotes nothing");
    const accepted = session({ answers: [true] });
    await accepted.run("promote demo-run-1");
    assert.equal(calls().some((c) => c[0] === "promote" && c.includes("--yes")), true);
    const rc = session({ answers: [false] });
    await rc.run("reconfigure demo-run-1 --effort E5");
    assert.equal(calls().some((c) => c[0] === "reconfigure" && c.includes("--yes")), false, "declining reconfigure changes nothing");
    const cancel = session({ answers: [false] });
    await cancel.run("cancel demo-run-1");
    assert.equal(calls().some((c) => c[0] === "cancel"), false, "declining cancel cancels nothing");
    const approve = session({ answers: [false] });
    await approve.run("resume demo-run-1 --approve");
    assert.equal(calls().some((c) => c[0] === "resume"), false, "declining an approval answers nothing");
    ok("promote, reconfigure, cancel and resume --approve ask first; a decline changes nothing");
  }

  // 7. Arguments: quotes are honoured, a bad run id never spawns anything, no shell is involved.
  {
    assert.deepEqual(mod.splitArgs(`init implement --spec "a b  c" --check unit='npm test' plain`), ["init", "implement", "--spec", "a b  c", "--check", "unit=npm test", "plain"]);
    assert.deepEqual(mod.splitArgs("  a   b "), ["a", "b"]);
    reset();
    const s = session();
    await s.run("status ../../etc/passwd");
    await s.run("steer $(touch /tmp/pwned) hello");
    await s.run("cancel ;rm -rf");
    assert.equal(calls().length, 0, "a malformed run id starts no process");
    await s.run("steer demo-run-1 $(touch /tmp/pwned-by-autonomy) hello");
    const steer = calls().find((c) => c[0] === "steer");
    assert.equal(steer[steer.indexOf("--message") + 1], "$(touch /tmp/pwned-by-autonomy) hello", "the message is one literal argument");
    assert.equal(fs.existsSync("/tmp/pwned-by-autonomy"), false, "nothing is interpreted by a shell");
    ok("quoting is honoured, malformed run ids are rejected before any process, arguments are never shell-interpreted");
  }

  // 8. A missing CLI is a message, not a crash.
  {
    const restore = setEnv("PI_AUTONOMY_CLI", path.join(work, "does-not-exist.mjs"));
    try {
      const s = session();
      await s.run("templates");
      assert.match(s.notes.at(-1).message, /not installed at/);
      assert.equal(s.notes.at(-1).level, "error");
    } finally { restore(); }
    ok("a missing CLI is reported, not thrown");
  }

  // 9. The REAL CLI: templates and plan need no container engine.
  {
    for (const r of restores.splice(0)) r();
    const s = session({ answers: [false] });
    await s.run("templates");
    const listing = s.notes.at(-1).message;
    for (const id of ["implement", "deploy", "self-improve"]) assert.match(listing, new RegExp(`^${id} `, "m"));
    await s.run(`plan ${path.join(ROOT, "packages", "autonomy", "examples", "implement.json")}`);
    const plan = s.notes.at(-1).message;
    assert.match(plan, /Boundary for run todo-api-1/);
    assert.match(plan, /never mounted: your home directory, credential stores, the host root, the container-engine socket/);
    assert.match(plan, /authorisation: missing/);
    // Declining at the real start shows the same boundary and starts no run.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-autonomy-cmd-home-"));
    const restoreHome = setEnv("PI_AUTONOMY_HOME", home);
    try {
      const contract = path.join(work, "implement.json");
      fs.cpSync(path.join(ROOT, "packages", "autonomy", "examples", "implement"), path.join(work, "implement"), { recursive: true });
      fs.copyFileSync(path.join(ROOT, "packages", "autonomy", "examples", "implement.json"), contract);
      const declined = session({ answers: [false] });
      await declined.run(`start ${contract}`);
      assert.match(declined.asked[0].body, /Boundary for run todo-api-1/);
      assert.equal(fs.existsSync(path.join(home, "todo-api-1")), false, "declining leaves no run directory behind");
      const raw = JSON.parse(fs.readFileSync(contract, "utf8"));
      assert.equal(raw.authorisation, undefined, "declining writes no authorisation into the contract");
    } finally { restoreHome(); rmWorkspace(home); }
    ok("against the real CLI: templates and plan work, and declining start leaves no run and no authorisation");
  }
} finally {
  process.stderr.write = realStderr;
  for (const r of restores.splice(0)) r();
  restoreKit();
  rmWorkspace(work);
}

console.log(`[autonomy-command-smoke] OK (${checks} checks)`);
