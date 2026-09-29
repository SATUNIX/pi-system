#!/usr/bin/env node
/**
 * Offline checks for packages/core/gitlab-release.mjs, the GitLab Release step of a tag
 * pipeline and the preflight of every other pipeline. A fake fetch stands in for the Releases
 * API, so nothing here touches the network.
 */
import assert from "node:assert/strict";
import { apiConfig, checkAccess, publishRelease } from "../packages/core/gitlab-release.mjs";

const ENV = { CI_API_V4_URL: "https://git.example/api/v4/", CI_PROJECT_ID: "lab/pi-system", CI_JOB_TOKEN: "job" };
const BASE = "https://git.example/api/v4/projects/lab%2Fpi-system/releases";

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { status: next.status, text: async () => next.body ?? "" };
  };
  return { impl, calls };
}

let checks = 0;
async function check(name, fn) {
  await fn();
  checks++;
  console.log(`  OK: ${name}`);
}

await check("config: project path is encoded, job token used in CI, private token wins", () => {
  const ci = apiConfig(ENV);
  assert.equal(ci.base, BASE);
  assert.deepEqual(ci.headers, { "JOB-TOKEN": "job" });
  assert.deepEqual(apiConfig({ ...ENV, GITLAB_PRIVATE_TOKEN: "pat" }).headers, { "PRIVATE-TOKEN": "pat" });
  assert.throws(() => apiConfig({ ...ENV, CI_JOB_TOKEN: "" }), /no token/);
  assert.throws(() => apiConfig({ CI_JOB_TOKEN: "job" }), /CI_API_V4_URL/);
});

await check("preflight only reads, and reports a TLS failure by its cause", async () => {
  const ok = fakeFetch([{ status: 200, body: "[]" }]);
  assert.equal(await checkAccess(apiConfig(ENV), ok.impl), 0);
  assert.deepEqual(ok.calls.map((c) => c.method), ["GET"]);

  const tls = fakeFetch([Object.assign(new TypeError("fetch failed"), { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } })]);
  await assert.rejects(checkAccess(apiConfig(ENV), tls.impl), /SELF_SIGNED_CERT_IN_CHAIN/);
  const denied = fakeFetch([{ status: 401, body: '{"message":"401 Unauthorized"}' }]);
  await assert.rejects(checkAccess(apiConfig(ENV), denied.impl), /HTTP 401/);
});

await check("a new tag creates its release with the notes", async () => {
  const f = fakeFetch([{ status: 201 }]);
  const release = { tag: "v0.2.1-beta.0", name: "pi-system v0.2.1-beta.0", description: "notes" };
  assert.equal(await publishRelease(apiConfig(ENV), release, f.impl), "created");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, "POST");
  assert.equal(f.calls[0].url, BASE);
  assert.deepEqual(f.calls[0].body, { tag_name: "v0.2.1-beta.0", name: "pi-system v0.2.1-beta.0", description: "notes" });
});

await check("a re-run updates the existing release instead of failing", async () => {
  const f = fakeFetch([{ status: 409 }, { status: 200 }]);
  assert.equal(await publishRelease(apiConfig(ENV), { tag: "v0.2.1-beta.0", name: "n", description: "d" }, f.impl), "updated");
  assert.deepEqual(f.calls.map((c) => [c.method, c.url]), [["POST", BASE], ["PUT", `${BASE}/v0.2.1-beta.0`]]);
});

await check("any other API answer fails the job", async () => {
  const f = fakeFetch([{ status: 403, body: "forbidden" }]);
  await assert.rejects(publishRelease(apiConfig(ENV), { tag: "v1.0.0", name: "n", description: "d" }, f.impl), /HTTP 403/);
});

console.log(`\n[gitlab-release-smoke] all ${checks} checks passed`);
