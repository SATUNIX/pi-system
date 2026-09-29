#!/usr/bin/env node
/**
 * Creates (or updates) the GitLab Release for a tag through the Releases API. The release job in
 * .gitlab-ci.yml runs it with the job token; `--check` is the preflight the other pipelines run:
 * it only reads, proving the API is reachable (TLS included) and the token can see releases.
 *
 * Usage:
 *   node packages/core/gitlab-release.mjs --check
 *   node packages/core/gitlab-release.mjs <tag> --notes <file> [--name <name>]
 *
 * Environment: CI_API_V4_URL and CI_PROJECT_ID (set by GitLab CI), and CI_JOB_TOKEN, or
 * GITLAB_PRIVATE_TOKEN (a token with `api` scope) to run it by hand. A private certificate
 * authority is trusted through NODE_EXTRA_CA_CERTS (Node reads it at startup).
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export function apiConfig(env = process.env) {
  const api = env.CI_API_V4_URL?.replace(/\/+$/, "");
  const project = env.CI_PROJECT_ID;
  if (!api || !project) throw new Error("CI_API_V4_URL and CI_PROJECT_ID must be set");
  const headers = env.GITLAB_PRIVATE_TOKEN
    ? { "PRIVATE-TOKEN": env.GITLAB_PRIVATE_TOKEN }
    : env.CI_JOB_TOKEN
      ? { "JOB-TOKEN": env.CI_JOB_TOKEN }
      : null;
  if (!headers) throw new Error("no token: set CI_JOB_TOKEN (CI) or GITLAB_PRIVATE_TOKEN");
  return { base: `${api}/projects/${encodeURIComponent(project)}/releases`, headers };
}

async function request(fetchImpl, method, url, headers, body) {
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: body ? { ...headers, "Content-Type": "application/json" } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    // fetch hides the TLS reason in `cause` (e.g. SELF_SIGNED_CERT_IN_CHAIN).
    const cause = error?.cause?.code || error?.cause?.message || error?.message || String(error);
    throw new Error(`${method} ${url}: ${cause}`);
  }
  const text = await res.text();
  return { status: res.status, text };
}

/** Preflight: read the project's releases. Throws unless the API answers 200. */
export async function checkAccess(config, fetchImpl = fetch) {
  const { status, text } = await request(fetchImpl, "GET", `${config.base}?per_page=1`, config.headers);
  if (status !== 200) throw new Error(`GET releases: HTTP ${status} ${text.slice(0, 200)}`);
  return JSON.parse(text).length;
}

/** Create the release for `tag`; when it already exists (a re-run), update its name and notes. */
export async function publishRelease(config, { tag, name, description }, fetchImpl = fetch) {
  const created = await request(fetchImpl, "POST", config.base, config.headers, { tag_name: tag, name, description });
  if (created.status === 201) return "created";
  if (created.status !== 409) throw new Error(`create release ${tag}: HTTP ${created.status} ${created.text.slice(0, 200)}`);
  const updated = await request(fetchImpl, "PUT", `${config.base}/${encodeURIComponent(tag)}`, config.headers, { name, description });
  if (updated.status !== 200) throw new Error(`update release ${tag}: HTTP ${updated.status} ${updated.text.slice(0, 200)}`);
  return "updated";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const opt = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  try {
    const config = apiConfig();
    if (args.includes("--check")) {
      const count = await checkAccess(config);
      console.log(`[gitlab-release] OK: Releases API reachable (${count ? "has releases" : "no releases yet"})`);
    } else {
      const tag = args.find((a, i) => !a.startsWith("--") && !["--notes", "--name"].includes(args[i - 1]));
      const notes = opt("--notes");
      if (!tag || !notes) {
        console.error("usage: node packages/core/gitlab-release.mjs --check | <tag> --notes <file> [--name <name>]");
        process.exit(2);
      }
      const result = await publishRelease(config, { tag, name: opt("--name") ?? tag, description: fs.readFileSync(notes, "utf8") });
      console.log(`[gitlab-release] ${result} release ${tag}`);
    }
  } catch (error) {
    console.error(`[gitlab-release] ${error.message}`);
    process.exit(1);
  }
}
