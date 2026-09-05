#!/usr/bin/env node
// This workspace's postinstall used to be the bare string `fumadocs-mdx`,
// which only works because npm normally creates a node_modules/.bin symlink
// for it. CI's strict-mode reinstall (ci-verify.yml's "Run approved install
// scripts": `npm ci --strict-allow-scripts --no-dangerously-allow-all-scripts
// --no-ignore-scripts --no-bin-links`) runs lifecycle scripts with bin links
// still disabled — they're materialized afterward by a separate `npm rebuild
// --ignore-scripts` step, see check-install-scripts.mjs's header comment and
// tests/release-gating-ci.test.mjs for why the reinstall keeps
// --no-bin-links. A bare `fumadocs-mdx` therefore failed with
// command-not-found on every clean CI run, before the rebuild step ever got
// a chance to link it.
//
// Resolving fumadocs-mdx's own declared `bin` entry and running it directly
// with the current Node interpreter needs no bin link at all: node_modules
// resolution finds the package regardless of --no-bin-links, only the
// node_modules/.bin symlink is what's missing.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgJsonPath = fileURLToPath(import.meta.resolve("fumadocs-mdx/package.json"));
const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
const binField = pkg.bin;
const binRelPath = typeof binField === "string" ? binField : binField?.["fumadocs-mdx"];
if (!binRelPath) {
  throw new Error("fumadocs-mdx's package.json declares no bin entry to run (checked package.json#bin)");
}
const binPath = join(dirname(pkgJsonPath), binRelPath);

const result = spawnSync(process.execPath, [binPath], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
