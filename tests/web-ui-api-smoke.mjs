#!/usr/bin/env node
// Offline regression smoke for the web-ui API query string. The server used to call
// handleApi(req, res, { pathname }) with no `search`, so routes.js always saw an empty
// query and `?source=project` was ignored: GET returned the user-level agent and DELETE
// removed the user-level file when a project agent of the same name existed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ui-api-home-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ui-api-proj-"));
const savedEnv = {
  HOME: process.env.HOME,
  PI_CONSOLE_PROJECT_AGENTS: process.env.PI_CONSOLE_PROJECT_AGENTS,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};
let failed = false;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (error) {
    failed = true;
    console.error(`  not ok - ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    writeHead(s) {
      this.statusCode = s;
    },
    end(b) {
      this.body = b;
    },
  };
}

function writeAgent(filePath, description, body) {
  fs.writeFileSync(
    filePath,
    `---\nname: dup\ndescription: ${description}\n---\n\n${body}\n`,
    "utf8",
  );
}

try {
  // config.js captures HOME and the agent dirs at import time, so set every env var
  // before the dynamic import.
  process.env.HOME = homeDir;
  process.env.PI_CONSOLE_PROJECT_AGENTS = projectDir;
  process.env.PI_CODING_AGENT_DIR = path.join(homeDir, ".pi", "agent");
  const { handleApi } = await import("../packages/web-ui/server/routes.js");

  const userAgentPath = path.join(homeDir, ".pi", "agents", "dup.md");
  const projectAgentPath = path.join(projectDir, "dup.md");
  fs.mkdirSync(path.dirname(userAgentPath), { recursive: true });
  writeAgent(userAgentPath, "user-copy", "user body");
  writeAgent(projectAgentPath, "project-copy", "project body");

  // GET must honour ?source=project even when handleApi only receives `pathname`
  // (the old server.js shape).
  const getRes = fakeRes();
  await handleApi(
    { method: "GET", url: "/api/agents/dup?source=project", on() {} },
    getRes,
    { pathname: "/api/agents/dup" },
  );
  check("GET ?source=project selects the project agent", () => {
    assert.equal(getRes.statusCode, 200);
    const { agent } = JSON.parse(getRes.body);
    assert.equal(agent.source, "project");
    assert.equal(agent.description, "project-copy");
  });

  // DELETE must remove the project copy, not the user copy.
  const delRes = fakeRes();
  await handleApi(
    { method: "DELETE", url: "/api/agents/dup?source=project", on() {} },
    delRes,
    { pathname: "/api/agents/dup" },
  );
  check("DELETE ?source=project removes only the project agent", () => {
    assert.equal(delRes.statusCode, 200);
    assert.equal(fs.existsSync(projectAgentPath), false, "project file must be deleted");
    assert.equal(fs.existsSync(userAgentPath), true, "user file must survive");
  });
} finally {
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

if (failed) {
  console.error("web-ui-api smoke: FAIL");
  process.exit(1);
}
console.log("web-ui-api smoke: OK");
