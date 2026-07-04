#!/usr/bin/env node

// rolester learnings — the safe read/append helper for per-role-family learning files.
//
// Rolester compounds: each role-track gets sharper the more it is run. Durable
// lessons live in `candidate/learnings/<family>.md` (see AGENTS.md → Learning
// Memory). Skills call this instead of re-deriving the family slug in prose and
// hand-appending markdown — the same reason they call `rolester gate` instead of
// hand-editing YAML.
//
// Usage:
//   node src/cli/learnings.mjs list [--json]
//   node src/cli/learnings.mjs path  <role|family> [--family] [--json]
//   node src/cli/learnings.mjs read  <role|family> [--family] [--json]
//   node src/cli/learnings.mjs append <role|family> --title "..." \
//        [--body "..." | --body-file FILE | <stdin>] [--family] [--date YYYY-MM-DD] [--write] [--json]
//   node src/cli/learnings.mjs --help
//
// `<role|family>` is classified into a family slug via candidate/targeting.yml
// (role_families → role_buckets → neutral slug) — the same ladder evaluate-job and
// track-outcomes describe. Pass --family to treat the argument as an explicit slug.
//
// append is a DRY RUN by default: it prints the family, target file, and the exact
// entry that would be written, after checking it for placeholder residue and a
// private comp leak - and writes nothing. Pass --write to commit (atomic append).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCandidateDoc } from "../core/profile/config-store.mjs";
import {
  appendLearning,
  computeAppend,
  countEntries,
  learningsRelPath,
  listLearnings,
  readLearnings,
  resolveFamilySlug,
  slugifyFamily,
} from "../core/profile/learnings.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function parseArgs(argv) {
  const opts = { positional: [], write: false, family: false, json: false, root: ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") opts.write = true;
    else if (a === "--family") opts.family = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--title") opts.title = argv[++i];
    else if (a === "--body") opts.body = argv[++i];
    else if (a === "--body-file") opts.bodyFile = argv[++i];
    else if (a === "--date") opts.date = argv[++i];
    else if (a === "--root") opts.root = argv[++i];
    else opts.positional.push(a);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help || opts.positional.length === 0) {
  printHelp();
  process.exit(opts.help ? 0 : 1);
}

const [verb, ...rest] = opts.positional;

// Load the candidate's targeting taxonomy once (drives slug classification).
function loadTargeting() {
  try {
    return loadCandidateDoc("targeting", { repoRoot: opts.root }) || undefined;
  } catch {
    return undefined;
  }
}

function familyFor(arg) {
  if (!arg) fail("a <role|family> argument is required");
  return opts.family ? slugifyFamily(arg) : resolveFamilySlug(arg, loadTargeting());
}

switch (verb) {
  case "list":
    cmdList();
    break;
  case "path":
    cmdPath(rest.join(" ").trim());
    break;
  case "read":
    cmdRead(rest.join(" ").trim());
    break;
  case "append":
    cmdAppend(rest.join(" ").trim());
    break;
  default:
    fail(`unknown command "${verb}". Commands: list, path, read, append. See --help.`);
}

// ---------------------------------------------------------------------------

function cmdList() {
  const items = listLearnings({ root: opts.root });
  if (opts.json) {
    console.log(JSON.stringify({ count: items.length, families: items }, null, 2));
    return;
  }
  if (items.length === 0) {
    console.log("No learning files yet (candidate/learnings/ is empty).");
    return;
  }
  console.log(`Learning files (${items.length}):`);
  for (const it of items) {
    console.log(
      `  ${it.family.padEnd(20)} ${String(it.entries).padStart(3)} entr${it.entries === 1 ? "y " : "ies"}  ${it.relPath}`
    );
  }
}

function cmdPath(arg) {
  const family = familyFor(arg);
  const relPath = learningsRelPath(family);
  const text = readLearnings(family, { root: opts.root });
  const result = { family, relPath, exists: text !== null, entries: text ? countEntries(text) : 0 };
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else
    console.log(
      `${family} → ${relPath}${result.exists ? ` (${result.entries} entr${result.entries === 1 ? "y" : "ies"})` : " (not created yet)"}`
    );
}

function cmdRead(arg) {
  const family = familyFor(arg);
  const relPath = learningsRelPath(family);
  const text = readLearnings(family, { root: opts.root });
  if (opts.json) {
    console.log(JSON.stringify({ family, relPath, exists: text !== null, text }, null, 2));
    return;
  }
  if (text === null) {
    console.error(`No learnings for "${family}" yet (${relPath}). Skip silently.`);
    process.exit(0);
  }
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function cmdAppend(arg) {
  const family = familyFor(arg);
  const title = (opts.title || "").trim();
  const body = resolveBody();
  const date = opts.date || isoToday();

  if (!title) fail("append requires --title");
  if (!body) fail("append requires a body (--body, --body-file, or stdin)");

  const relPath = learningsRelPath(family);
  const currentText = readLearnings(family, { root: opts.root });
  const plan = computeAppend({ family, date, title, body, currentText });

  if (!plan.ok) {
    if (opts.json)
      console.log(
        JSON.stringify(
          { ok: false, family, relPath, error: plan.error, lint: plan.lint, leak: plan.leak },
          null,
          2
        )
      );
    else console.error(`learnings: refused — ${plan.error}`);
    process.exit(1);
  }

  if (!opts.write) {
    if (opts.json) {
      console.log(
        JSON.stringify(
          { ok: true, dryRun: true, family, relPath, created: plan.created, entry: plan.entry },
          null,
          2
        )
      );
    } else {
      console.log(`Proposed append to ${relPath}${plan.created ? " (new file)" : ""}:`);
      console.log("");
      console.log(
        plan.entry
          .replace(/\n$/, "")
          .split("\n")
          .map((l) => `  | ${l}`)
          .join("\n")
      );
      console.log("");
      console.log("Dry run - pass --write to commit.");
    }
    process.exit(0);
  }

  const written = appendLearning({ family, date, title, body, root: opts.root });
  if (!written.ok) fail(written.error);
  if (opts.json)
    console.log(
      JSON.stringify(
        { ok: true, written: true, family, relPath, created: written.created },
        null,
        2
      )
    );
  else
    console.log(
      `Written to ${relPath}: ## ${date} — ${title}${written.created ? " (created)" : ""}`
    );
  process.exit(0);
}

// ---------------------------------------------------------------------------

function resolveBody() {
  if (typeof opts.body === "string") return opts.body.trim();
  if (opts.bodyFile) {
    const p = join(opts.root, opts.bodyFile);
    const path = existsSync(p) ? p : opts.bodyFile;
    if (!existsSync(path)) fail(`--body-file not found: ${opts.bodyFile}`);
    return readFileSync(path, "utf8").trim();
  }
  // Fall back to stdin when piped (not a TTY).
  if (!process.stdin.isTTY) {
    try {
      return readFileSync(0, "utf8").trim();
    } catch {
      return "";
    }
  }
  return "";
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function fail(msg) {
  if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error(`learnings: ${msg}`);
  process.exit(1);
}

function printHelp() {
  console.log(`rolester learnings — safe read/append for per-role-family learning files

Usage:
  node src/cli/learnings.mjs list [--json]
  node src/cli/learnings.mjs path  <role|family> [--family] [--json]
  node src/cli/learnings.mjs read  <role|family> [--family] [--json]
  node src/cli/learnings.mjs append <role|family> --title "..." \\
       [--body "..." | --body-file FILE | <stdin>] [--family] [--date YYYY-MM-DD] [--write] [--json]

Commands:
  list      List existing learning files (family · entry count).
  path      Resolve the family slug + file path for a role title (no write).
  read      Print a family's learning file (empty/note if it doesn't exist yet).
  append    Append a dated entry. DRY RUN by default; pass --write to commit.

Options:
  --family       Treat the argument as an explicit family slug (skip classification).
  --title TEXT   Entry heading (required for append).
  --body TEXT    Entry body markdown. Or --body-file FILE, or pipe via stdin.
  --date YMD     ISO date for the entry (default: today).
  --write        Commit the append (default: dry run).
  --json         Machine-readable output.
  --root DIR     Repo root (default: the rolester install).

Role titles are classified to a family via candidate/targeting.yml (role_families →
role_buckets → neutral slug). Appended entries are checked for placeholder residue
and refused if they would leak a private comp input (current_base). Writes are atomic.`);
}
