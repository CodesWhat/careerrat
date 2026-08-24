#!/usr/bin/env node
// apps/desktop/scripts/stage.mjs — builds staging/careerrat, the tree
// electron-builder's `extraResources` embeds into the packaged app's
// Resources/careerrat (see ../electron-builder.yml). The script itself uses
// only Node built-ins and mirrors
// this repo's `npm run tracker:dev` build discipline: read the truth
// (package.json's `files` allowlist — the same list `npm pack` ships) rather
// than hand-maintaining a second copy that can drift.
//
// What ships, and why:
//   - Every entry in the root package.json `files[]` array EXCEPT the
//     individual per-skill `.agents/skills/<name>/SKILL.md` paths
//     (collapsed below into a single copy of the real `.agents/skills/`
//     directory). The broad examples/ entry is narrowed to the fictional
//     examples/demo-workspace fixture required by `data init --demo`.
//   - A synthesized runtime `package.json` plus lock copied from the committed
//     runtime-dependencies manifest. The root package's version is applied to
//     both staged files, then `npm ci` installs the exact locked tree. The
//     isolated manifest has no workspaces and contains only dependencies the
//     packaged engine needs. It intentionally excludes the proprietary Claude
//     Agent SDK: packaged AI work is driven by the user's selected installed
//     CLI instead.
// scripts/*.mjs referenced by a shipped SKILL.md are already covered: this
// repo's tests/release-safety.test.mjs enforces that every script an agent
// can reach from a skill is present in package.json `files[]`, so reusing
// that list transitively reuses that guarantee.
//
// Explicitly excluded regardless of `files[]`: workspace/, candidate/,
// .internal/, .careerrat/, node_modules, tests, site/docs apps, and non-demo
// examples. Those are not in `files[]` in the first place, except examples,
// which is narrowed above. Runtime docs stay because doctor and skills consume
// the exact files selected by the root package allowlist.
//
// Idempotent: staging/ is removed and rebuilt from scratch every run.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { npmInvocation } from "./npm-invocation.mjs";
import { compileSingleStarGlob } from "../../../src/core/fs/single-star-glob.mjs";

const desktopDir = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const repoRoot = join(desktopDir, "../..");
const stagingRoot = join(desktopDir, "staging", "careerrat");
const webDistIndex = join(repoRoot, "apps/web/dist/index.html");
const runtimeDependenciesRoot = join(desktopDir, "runtime-dependencies");

const ENTRY_OVERRIDES = new Map([["examples", "examples/demo-workspace"]]);
const SKILL_PREFIX = ".agents/skills/";

function log(msg) {
  process.stdout.write(`[stage] ${msg}\n`);
}

function readRootPackageJson() {
  return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
}

// Reduce package.json's `files[]` (the npm-pack allowlist) down to what a
// packaged desktop app needs at runtime, collapsing the per-skill SKILL.md
// entries into one real-directory copy.
function resolveEntries(pkg) {
  const entries = new Set();
  for (const sourceEntry of pkg.files || []) {
    const entry = ENTRY_OVERRIDES.get(sourceEntry) || sourceEntry;
    if (entry.startsWith(SKILL_PREFIX)) {
      entries.add(".agents/skills");
      continue;
    }
    entries.add(entry);
  }
  return [...entries];
}

// The two config globs in files[] ("config/*.schema.json",
// "config/*.example.*") are the only glob entries — expand them by hand
// (zero-dep: no glob package, and Node's own fs.glob is too new to lean on
// here) rather than building a general globber for two known shapes.
function expandGlobEntry(entry) {
  const starAt = entry.indexOf("*");
  if (starAt === -1) return null;
  const dir = entry.slice(0, entry.lastIndexOf("/", starAt));
  const pattern = entry.slice(entry.lastIndexOf("/", starAt) + 1);
  const regex = compileSingleStarGlob(pattern);
  const absDir = join(repoRoot, dir);
  if (!existsSync(absDir)) return [];
  return readdirSync(absDir)
    .filter((name) => regex.test(name))
    .map((name) => `${dir}/${name}`);
}

function copyEntry(relPath) {
  const src = join(repoRoot, relPath);
  if (!existsSync(src)) {
    log(`skip (not found): ${relPath}`);
    return;
  }
  const dest = join(stagingRoot, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

// A from-scratch manifest, not a copy of the root's — see the header comment
// for why. Only the fields the staged runtime actually needs: `version` is
// read back by tracker-dev.mjs's PACKAGE_VERSION; `type` must stay "module"
// for the ESM sources to load; no `workspaces`, `scripts`, or
// `devDependencies` — none of those apply to (or are safe inside) a staged
// runtime copy.
function writeStagedPackageFiles(pkg) {
  const runtimePackage = JSON.parse(
    readFileSync(join(runtimeDependenciesRoot, "package.json"), "utf8")
  );
  const runtimeLock = JSON.parse(
    readFileSync(join(runtimeDependenciesRoot, "package-lock.json"), "utf8")
  );
  const stagedPackage = {
    name: pkg.name,
    version: pkg.version,
    private: true,
    type: pkg.type,
    dependencies: runtimePackage.dependencies,
  };
  runtimeLock.name = pkg.name;
  runtimeLock.version = pkg.version;
  runtimeLock.packages[""] = {
    ...runtimeLock.packages[""],
    name: pkg.name,
    version: pkg.version,
  };
  writeFileSync(
    join(stagingRoot, "package.json"),
    `${JSON.stringify(stagedPackage, null, 2)}\n`
  );
  writeFileSync(
    join(stagingRoot, "package-lock.json"),
    `${JSON.stringify(runtimeLock, null, 2)}\n`
  );
}

function stageFiles() {
  const pkg = readRootPackageJson();
  const entries = resolveEntries(pkg);

  for (const entry of entries) {
    if (entry.includes("*")) {
      for (const expanded of expandGlobEntry(entry)) copyEntry(expanded);
      continue;
    }
    copyEntry(entry);
  }

  log(`staged ${entries.length} allowlist entr${entries.length === 1 ? "y" : "ies"} → ${stagingRoot}`);
}

function assertWebDistBuilt() {
  if (existsSync(webDistIndex)) return;
  throw new Error(
    "apps/web/dist/index.html is missing. Run `npm run app:build` before staging the desktop runtime."
  );
}

// `npm ci`, not a fresh resolver run. The committed isolated lock makes the
// staged dependency tree reproducible on both macOS arm64 and Windows x64.
function installRuntimeDependencies() {
  const runtimeInstall = npmInvocation([
    "ci",
    "--prefix",
    stagingRoot,
    "--omit=dev",
    "--ignore-scripts",
  ]);
  log(`npm ci from the committed desktop runtime lock into ${stagingRoot} …`);
  execFileSync(runtimeInstall.file, runtimeInstall.args, {
    cwd: stagingRoot,
    stdio: "inherit",
  });
}

function assertNoProprietarySdk() {
  const sdkPath = join(stagingRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  if (existsSync(sdkPath)) {
    throw new Error("proprietary Claude Agent SDK must not be present in desktop staging");
  }
}

function installChromium() {
  const playwrightCli = join(stagingRoot, "node_modules/playwright/cli.js");
  if (!existsSync(playwrightCli)) {
    throw new Error("staged Playwright CLI is missing after dependency installation");
  }
  log("installing hermetic Playwright Chromium into staged node_modules …");
  execFileSync(process.execPath, [playwrightCli, "install", "chromium", "--no-shell"], {
    cwd: stagingRoot,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" },
    stdio: "inherit",
  });
  rmSync(join(stagingRoot, "node_modules/playwright-core/.local-browsers", ".links"), {
    recursive: true,
    force: true,
  });
}

function main() {
  assertWebDistBuilt();

  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true });

  const pkg = readRootPackageJson();
  stageFiles();
  writeStagedPackageFiles(pkg);
  installRuntimeDependencies();
  assertNoProprietarySdk();
  installChromium();

  log("done.");
}

main();
