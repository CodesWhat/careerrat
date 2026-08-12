#!/usr/bin/env node
// Make Rolester's skills discoverable by whatever agent pulled the repo down.
//
// The single source of truth is `.agents/skills/<name>/SKILL.md` (the
// CLI-agnostic convention the AGENTS.md router references). Different agents
// discover skills differently:
//
//   - Claude Code  -> needs `.claude/skills/<name>/SKILL.md`. We shim it to the
//                     source via a symlink (or a copied tree where symlinks are
//                     unavailable, e.g. Windows without developer mode).
//   - Codex / other agents that read AGENTS.md natively -> no install needed;
//                     the router + `.agents/skills/` are already in the clone.
//
// Run modes:
//   node scripts/install-skills.mjs           install/repair the shim, then verify
//   node scripts/install-skills.mjs --check    verify only, no mutation (exit 1 if not installed)
//   node scripts/install-skills.mjs --json      machine-readable result
//
// Idempotent: a correct existing symlink is left untouched.

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const asJson = args.has("--json");
const soft = args.has("--soft"); // never exit non-zero (safe for npm postinstall)

const SOURCE_DIR = join(root, ".agents", "skills");
const CLAUDE_DIR = join(root, ".claude");
const CLAUDE_SKILLS = join(CLAUDE_DIR, "skills");

const log = (msg) => {
  if (!asJson) console.log(msg);
};

function listSkills(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(dir, name, "SKILL.md")))
    .sort();
}

function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

// Does `.claude/skills` already resolve to the source skills?
function shimState() {
  if (!existsSync(CLAUDE_SKILLS)) return "missing";
  let st;
  try {
    st = lstatSync(CLAUDE_SKILLS);
  } catch {
    return "missing";
  }
  if (st.isSymbolicLink()) {
    try {
      const target = join(dirname(CLAUDE_SKILLS), readlinkSync(CLAUDE_SKILLS));
      return statSync(target).isDirectory() && statSync(target).ino === statSync(SOURCE_DIR).ino
        ? "symlink-ok"
        : "symlink-wrong";
    } catch {
      return "symlink-broken";
    }
  }
  if (st.isDirectory()) return "copy"; // real dir (copied tree, or a legacy layout)
  return "unknown";
}

function installShim() {
  const state = shimState();
  if (state === "symlink-ok") return { action: "noop", mode: "symlink" };

  // Clear anything stale before (re)creating.
  if (state !== "missing") rmSync(CLAUDE_SKILLS, { recursive: true, force: true });
  mkdirSync(CLAUDE_DIR, { recursive: true });

  const relTarget = relative(CLAUDE_DIR, SOURCE_DIR); // ../.agents/skills
  try {
    symlinkSync(relTarget, CLAUDE_SKILLS, "dir");
    return { action: state === "missing" ? "created" : "repaired", mode: "symlink" };
  } catch {
    // Symlinks unavailable (Windows w/o dev mode): fall back to a copied tree.
    copyTree(SOURCE_DIR, CLAUDE_SKILLS);
    return { action: state === "missing" ? "created" : "repaired", mode: "copy" };
  }
}

// ---- run ----
const source = listSkills(SOURCE_DIR);
if (source.length === 0) {
  const msg = `No skills found at .agents/skills/ (looked in ${SOURCE_DIR}). Are you in the repo root?`;
  if (asJson) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error(msg);
  process.exit(soft ? 0 : 1);
}

let result;
if (checkOnly) {
  const state = shimState();
  const installed = listSkills(CLAUDE_SKILLS);
  const missing = source.filter((s) => !installed.includes(s));
  const ok = (state === "symlink-ok" || state === "copy") && missing.length === 0;
  result = { ok, mode: "check", shim: state, skills: source, missing };
} else {
  const shim = installShim();
  const installed = listSkills(CLAUDE_SKILLS);
  const missing = source.filter((s) => !installed.includes(s));
  result = {
    ok: missing.length === 0,
    mode: shim.mode,
    action: shim.action,
    skills: source,
    missing,
  };
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok || soft ? 0 : 1);
}

log("careerrat install-skills");
log("=======================");
log("");
if (checkOnly) {
  if (result.ok) {
    log(`✓ ${result.skills.length} skills discoverable via .claude/skills (${result.shim}).`);
  } else {
    log(`✗ Skills not installed for Claude Code (state: ${result.shim}).`);
    log("  Run: npm run install-skills");
    if (result.missing.length) log(`  Missing: ${result.missing.join(", ")}`);
  }
} else {
  const verb = { noop: "Already installed", created: "Installed", repaired: "Repaired" }[
    result.action
  ];
  log(`${verb}: ${result.skills.length} skills → .claude/skills (${result.mode}).`);
  if (result.mode === "copy") {
    log("  (Copied tree — symlinks unavailable. Re-run install-skills after updating skills.)");
  }
  for (const s of result.skills) log(`  • ${s}`);
  log("");
  log("Codex and other agents that read AGENTS.md need no install — the router");
  log("and .agents/skills/ are already present in the clone.");
}
process.exit(result.ok || soft ? 0 : 1);
