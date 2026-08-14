#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsOutput = join(repoRoot, "apps", "docs", "out");
const websiteDocs = join(repoRoot, "apps", "website", "public", "docs");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const result = spawnSync(npm, ["run", "build", "--workspace", "@careerrat/docs"], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(docsOutput)) throw new Error(`Docs build produced no output at ${docsOutput}`);

rmSync(websiteDocs, { recursive: true, force: true });
mkdirSync(websiteDocs, { recursive: true });
cpSync(docsOutput, websiteDocs, { recursive: true });
