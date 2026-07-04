#!/usr/bin/env node
// apps/desktop/scripts/stage.mjs — builds staging/rolester, the tree
// electron-builder's `extraResources` embeds into the packaged app's
// Resources/rolester (see ../electron-builder.yml). Zero-dep node, mirrors
// this repo's `npm run tracker:dev` build discipline: read the truth
// (package.json's `files` allowlist — the same list `npm pack` ships) rather
// than hand-maintaining a second copy that can drift.
//
// What ships, and why:
//   - Every entry in the root package.json `files[]` array EXCEPT docs/* and
//     examples/ (those are developer/marketing surfaces, not runtime — the
//     packaged app never reads them) and the individual per-skill
//     `.agents/skills/<name>/SKILL.md` paths (collapsed below into a single
//     copy of the real `.agents/skills/` directory). After that copy lands,
//     staging materializes a real `.claude/skills` mirror too, so packaged
//     runtimes that still probe Claude's historical lookup path work without
//     depending on a symlink inside a signed app bundle.
//   - A MINIMAL, synthesized `package.json` (not in `files[]` — npm never
//     lists its own manifest there — but the staged copy needs one so
//     `npm install` below has somewhere to resolve into, and so the packaged
//     runtime can read its own version). Deliberately NOT a byte-for-byte
//     copy of the root manifest: the root's `workspaces` field, matching
//     `name`, and pre-listed `@anthropic-ai/claude-agent-sdk` devDependency
//     all confused npm into treating `staging/rolester` as nested inside the
//     real repo's workspace tree — the SDK install below silently resolved
//     against the ALREADY-installed root devDependency instead of writing
//     its own node_modules here, and (worse) that same confusion made a
//     bare `npm install` write straight into the real repo's root
//     package-lock.json. A from-scratch manifest with no `workspaces` field
//     plus an explicit `--prefix` on the install (belt and suspenders) keeps
//     this install fully isolated.
// scripts/*.mjs referenced by a shipped SKILL.md are already covered: this
// repo's tests/release-safety.test.mjs enforces that every script an agent
// can reach from a skill is present in package.json `files[]`, so reusing
// that list transitively reuses that guarantee.
//
// Explicitly excluded regardless of `files[]`: workspace/, candidate/,
// .internal/, .rolester/, node_modules, tests, website, examples, docs — none
// of those are in `files[]` in the first place except docs/examples, which
// are filtered out above.
//
// Idempotent: staging/ is removed and rebuilt from scratch every run.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const repoRoot = join(desktopDir, "../..");
const stagingRoot = join(desktopDir, "staging", "rolester");
const webDistIndex = join(repoRoot, "apps/web/dist/index.html");

const EXCLUDE_EXACT = new Set(["examples"]);
const EXCLUDE_PREFIXES = ["docs/"];
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
  for (const entry of pkg.files || []) {
    if (EXCLUDE_EXACT.has(entry)) continue;
    if (EXCLUDE_PREFIXES.some((prefix) => entry.startsWith(prefix))) continue;
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
  const regex = new RegExp(`^${pattern.replace(/[.]/g, "\\.").replace(/\*/g, ".*")}$`);
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
function writeStagedPackageJson(pkg) {
  const minimal = {
    name: pkg.name,
    version: pkg.version,
    private: true,
    type: pkg.type,
    dependencies: {},
  };
  writeFileSync(join(stagingRoot, "package.json"), `${JSON.stringify(minimal, null, 2)}\n`);
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

function mirrorClaudeSkills() {
  const src = join(stagingRoot, ".agents/skills");
  if (!existsSync(src)) {
    throw new Error("staged .agents/skills is missing; cannot mirror .claude/skills");
  }
  const dest = join(stagingRoot, ".claude/skills");
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
  log("mirrored .agents/skills → .claude/skills");
}

// Install ONLY the SDK's own dependency tree into staging/rolester's own
// node_modules — the packaged runtime resolves `@anthropic-ai/claude-agent-sdk`
// from there. The core npm package stays zero-dep; this install is scoped to
// the staged copy only and never touches the repo root's node_modules or
// lockfile (--no-save --no-package-lock).
function installSdk(pkg) {
  const version = pkg.devDependencies?.["@anthropic-ai/claude-agent-sdk"];
  if (!version) {
    throw new Error("root package.json is missing the @anthropic-ai/claude-agent-sdk devDependency");
  }
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  log(`npm install @anthropic-ai/claude-agent-sdk@${version} into ${stagingRoot} …`);
  // --prefix pins the install root explicitly (on top of the from-scratch,
  // workspaces-free manifest above) so this can never resolve against, or
  // write into, the real repo's root node_modules/package-lock.json — see
  // the header comment for the failure mode this guards against.
  execFileSync(
    npmCmd,
    [
      "install",
      "--prefix",
      stagingRoot,
      "--no-save",
      "--no-package-lock",
      "--omit=dev",
      `@anthropic-ai/claude-agent-sdk@${version}`,
    ],
    { cwd: stagingRoot, stdio: "inherit" }
  );
}

function main() {
  assertWebDistBuilt();

  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true });

  const pkg = readRootPackageJson();
  stageFiles();
  mirrorClaudeSkills();
  writeStagedPackageJson(pkg);
  installSdk(pkg);

  log("done.");
}

main();
