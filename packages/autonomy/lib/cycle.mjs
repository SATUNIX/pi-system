// One cycle's control loop. Everything that touches Docker, git, the clock or the manager model
// comes in through `rt` (the runtime), so the loop is tested offline with a fake runtime
// (tests/autonomy-smoke.mjs) and driven for real by lib/engine.mjs through the self-improve template.
//
// rt: {
//   now(), sleep(ms), tickMs,
//   startAgent({ attempt, onEvent }) -> { send(msg), stop(): Promise, exited: Promise<{code}> },
//   headSha(), reportExists(), meterUsd(), totalUsd(), stopRequested(),
//   manager(bundle) -> decision, extras() -> { gitLog, plan, handoff }, gates() -> ["green"|"red"...],
//   resetToLastGood(abandonedSha) -> Promise, publish() -> Promise, log(line),
//   uiPolicy? -> permissions.unattended: dialogs are then answered per the contract and a question ends the cycle as "blocked"
// }
import { evaluate } from "./triggers.mjs";
import { uiResponse, activityLine, isGuardEscalation, operatorDecision } from "./rpc.mjs";

const FOLLOW_UP = [
  "You stopped before the cycle was recorded. Continue from where you are: finish the remaining phases (verify, then record {{DIR}}/report.md, update BACKLOG.md and HANDOFF.md), commit and push.",
  "The cycle report {{DIR}}/report.md is still missing on the branch. Write it now with the honest outcome (partial is fine), update HANDOFF.md, commit and `git push origin HEAD`.",
];

export async function runCycle({ n, cfg, rt, prompt, restartBriefing, cycleDir }) {
  const NN = String(n).padStart(2, "0");
  const DIR = cycleDir ?? `autonomy/cycles/${NN}`;
  const startMeter = await rt.meterUsd();
  const s = {
    startedAt: rt.now(), lastEventAt: rt.now(), lastCommitAt: null, costUsd: 0, extendedMinutes: 0,
    managerCalls: 0, exited: null, redGatesInARow: consecutiveRed(await rt.gates()), guardEscalations: 0,
    softReviewed: false, handled: new Set(),
  };
  const decisions = [];
  const activity = [];
  let head = await rt.headSha();
  let attempt = 0;
  let agent = null;
  let settled = false;
  let followUps = 0;
  let pendingTrigger = null;
  let blocker = null;

  const onEvent = (ev) => {
    s.lastEventAt = rt.now();
    if (ev.type === "agent_start") settled = false;
    if (ev.type === "agent_settled") settled = true;
    if (ev.type === "extension_ui_request") {
      if (rt.uiPolicy) {
        const d = operatorDecision(ev, rt.uiPolicy);
        if (d.action === "reply") { agent?.send(d.reply); rt.onAutoAnswer?.(ev); }
        else if (d.action === "block" && !blocker) blocker = d.blocker;
      } else {
        const reply = uiResponse(ev);
        if (reply) agent?.send(reply);
      }
    }
    if (isGuardEscalation(ev)) s.guardEscalations++;
    const line = activityLine({ ...ev, at: rt.now() });
    if (line) { activity.push(line); if (activity.length > 200) activity.shift(); }
  };

  const launch = (text) => {
    attempt++;
    settled = false;
    s.exited = null;
    agent = rt.startAgent({ attempt, onEvent });
    agent.exited.then((e) => { s.exited = e; settled = true; });
    agent.send({ type: "prompt", message: text });
  };
  // A message from the "operator": steer a running agent, or prompt an idle one.
  const say = (message) => agent.send(settled ? { type: "prompt", message } : { type: "steer", message });

  const close = async (outcome, reason) => {
    await agent?.stop();
    await rt.publish();
    rt.log(`cycle ${NN} closed: ${outcome} (${reason})`);
    return { outcome, reason, attempts: attempt, decisions, costUsd: s.costUsd, head: await rt.headSha(), ...(blocker ? { blocker } : {}) };
  };

  launch(restartBriefing ? `${restartBriefing}\n\n${prompt}` : prompt);

  for (;;) {
    await rt.sleep(rt.tickMs);
    const now = rt.now();
    await rt.publish();
    const sha = await rt.headSha();
    if (sha !== head) { head = sha; s.lastCommitAt = now; }
    s.costUsd = (await rt.meterUsd()) - startMeter;

    if (blocker) return close("blocked", "a question needs a person");
    if (rt.stopRequested() || (await rt.totalUsd()) >= cfg.budget.totalUsd) return close("aborted", "run stop (a control command, a signal or the total budget)");

    // The agent finished its turn: done if the report is on the branch, otherwise ask it to finish.
    if (settled && !s.exited && !pendingTrigger) {
      if (await rt.reportExists()) return close("completed", "report recorded");
      if (followUps < FOLLOW_UP.length) {
        say(FOLLOW_UP[followUps++].replaceAll("{{DIR}}", DIR));
        settled = false;
        continue;
      }
      pendingTrigger = "settled_without_report";
    }
    if (s.exited && s.exited.code === 0) {
      if (await rt.reportExists()) return close("completed", "report recorded");
      if (!pendingTrigger) pendingTrigger = `exited_without_report:${attempt}`;
    }

    const { stop, triggers } = evaluate(s, now, cfg);
    if (stop) return close("partial", stop);
    if (pendingTrigger && !s.handled.has(pendingTrigger)) triggers.push(pendingTrigger);
    if (!triggers.length) continue;

    // Ask the manager once for everything that fired, then execute its single decision.
    s.managerCalls++;
    for (const t of triggers) s.handled.add(t);
    if (triggers.includes("soft_limit")) s.softReviewed = true;
    pendingTrigger = null;
    let d;
    try {
      d = await rt.manager({
        run: cfg.run, cycle: n, cycles: cfg.cycles, triggers, limits: cfg.limits, budget: cfg.budget,
        elapsedMinutes: (now - s.startedAt) / 60_000, extendedMinutes: s.extendedMinutes,
        costUsd: s.costUsd, totalCostUsd: await rt.totalUsd(), managerCalls: s.managerCalls - 1,
        previousDecisions: decisions, idleMinutes: (now - s.lastEventAt) / 60_000,
        sinceCommitMinutes: s.lastCommitAt ? (now - s.lastCommitAt) / 60_000 : null,
        gates: await rt.gates(), activity: activity.join("\n"), ...(await rt.extras()),
      });
    } catch (error) {
      // No usable decision: the least disruptive safe default, recorded like any other.
      d = triggers.some((t) => t.startsWith("crash")) && attempt < 3
        ? { decision: "RESTART_SESSION", reason: `manager unavailable (${error.message}); default after a crash`, message: "The previous session ended unexpectedly. Re-read autonomy/HANDOFF.md and the cycle files, then continue the cycle." }
        : { decision: "CONTINUE", reason: `manager unavailable (${error.message}); default`, extendMinutes: 15 };
    }
    decisions.push({ at: new Date(now).toISOString(), triggers, ...d });
    rt.log(`cycle ${NN} manager: ${d.decision} (${d.reason}) on ${triggers.join(",")}`);

    switch (d.decision) {
      case "CONTINUE":
        s.extendedMinutes += d.extendMinutes;
        break;
      case "NUDGE":
        if (s.exited) launch(`${d.message}\n\n${prompt}`);
        else say(d.message);
        break;
      case "RESTART_SESSION":
        await agent.stop();
        launch(`${d.message}\n\n${prompt}`);
        break;
      case "NEW_CYCLE":
        return close("partial", `manager: ${d.reason}`);
      case "RESET_TO_LAST_GOOD":
        await agent.stop();
        await rt.resetToLastGood(await rt.headSha());
        return close("reset", `manager: ${d.reason}`);
      case "ABORT_RUN":
        return close("aborted", `manager: ${d.reason}`);
    }
  }
}

function consecutiveRed(gates) {
  let n = 0;
  for (let i = gates.length - 1; i >= 0 && gates[i] === "red"; i--) n++;
  return n;
}
