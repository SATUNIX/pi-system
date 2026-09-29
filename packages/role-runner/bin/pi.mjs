#!/usr/bin/env node
/**
 * `pi` shim for the role-runner image.
 *
 * The interactive pi package is not installed in this image; the only
 * subcommand is `pi run` from the 08 §7 contract. Node 22.18+ strips the
 * TypeScript types in ../src, so no build step or dependencies are required.
 */
import { runCli } from "../src/cli.ts";

runCli(process.argv.slice(2), process.env)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error?.stack ?? String(error)}\n`);
    process.exitCode = 1;
  });
