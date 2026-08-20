#!/usr/bin/env node

// careerrat research — the safe read/record helper for web-research artifacts.
//
// M11 lets CareerRat "go find things out": skills web-search a company, a market
// comp band, or new boards and persist cited findings under `workspace/research/`
// (see AGENTS.md → Research Memory). Skills RECORD through this helper instead of
// writing the file directly so the citation-hygiene + privacy guards always run —
// the same reason they call `careerrat gate` / `careerrat learnings` instead of hand-
// editing. Other skills (interview-prep, evaluate-job) READ through it.
//
// Usage:
//   node src/cli/research.mjs list [--json]
//   node src/cli/research.mjs stale [--days N] [--json]
//   node src/cli/research.mjs path <company> [--name STEM] [--json]
//   node src/cli/research.mjs read <company> [--name STEM] [--json]
//   node src/cli/research.mjs record <company> --file FILE [--name STEM] [--write] [--json]
//   node src/cli/research.mjs --help
//
// `record` is a DRY RUN by default: it validates the composed artifact (required
// frontmatter, at least one cited source for sourced types, no placeholder residue,
// no private current_base leak) and prints what would be written — committing
// nothing. Pass --write to commit (atomic upsert). A company resolves to one file
// via its slug; pass --name to set an explicit filename stem (comp-benchmark /
// board-discovery-log artifacts use this).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeResearchWrite,
  listResearch,
  readCompanyResearch,
  readResearch,
  researchRelPath,
  slugifyCompany,
  writeResearch,
} from "../core/research/research-store.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function parseArgs(argv) {
  const opts = { positional: [], write: false, json: false, root: ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") opts.write = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--name") opts.name = argv[++i];
    else if (a === "--file") opts.file = argv[++i];
    else if (a === "--days") opts.days = Number(argv[++i]);
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
const subject = rest.join(" ").trim();

// The filename stem: explicit --name wins (comp-bench / board-log), else the
// company slug. read/path default to resolving the subject as a company.
function stemFor(subjectArg) {
  return opts.name ? slugifyCompany(opts.name) : slugifyCompany(subjectArg);
}

switch (verb) {
  case "list":
    cmdList();
    break;
  case "stale":
    cmdStale();
    break;
  case "path":
    cmdPath(subject);
    break;
  case "read":
    cmdRead(subject);
    break;
  case "record":
    cmdRecord(subject);
    break;
  default:
    fail(`unknown command "${verb}". Commands: list, stale, path, read, record. See --help.`);
}

// ---------------------------------------------------------------------------

function cmdList() {
  const items = listResearch({ root: opts.root });
  if (opts.json) {
    console.log(JSON.stringify({ count: items.length, artifacts: items }, null, 2));
    return;
  }
  if (items.length === 0) {
    console.log("No research artifacts yet (workspace/research/ is empty).");
    return;
  }
  console.log(`Research artifacts (${items.length}):`);
  for (const it of items) {
    const subj = it.company || it.role || it.stem;
    const flag = it.stale ? " ⚠ stale" : "";
    console.log(
      `  ${String(it.type || "?").padEnd(18)} ${String(subj).padEnd(28)} ${it.sources} src  ${it.fetchedAt || "?"}${flag}  ${it.relPath}`
    );
  }
}

function cmdStale() {
  const items = listResearch({ root: opts.root }).filter((it) => it.stale);
  if (opts.json) {
    console.log(JSON.stringify({ count: items.length, stale: items }, null, 2));
    return;
  }
  if (items.length === 0) {
    console.log("No stale research artifacts.");
    return;
  }
  console.log(`Stale research artifacts (${items.length}), consider refreshing:`);
  for (const it of items) {
    console.log(
      `  ${it.company || it.role || it.stem}  (fetched ${it.fetchedAt || "?"})  ${it.relPath}`
    );
  }
}

function cmdPath(arg) {
  if (!arg && !opts.name) fail("path requires a <company> or --name");
  const stem = stemFor(arg);
  const relPath = researchRelPath(stem);
  const hit = readResearch(stem, { root: opts.root });
  const result = {
    stem,
    relPath,
    exists: hit !== null,
    stale: hit ? hit.stale : null,
    fetchedAt: hit ? (hit.frontmatter.fetchedAt ?? null) : null,
  };
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else
    console.log(
      `${stem} → ${relPath}${hit ? ` (fetched ${result.fetchedAt}${hit.stale ? ", stale" : ""})` : " (not created yet)"}`
    );
}

function cmdRead(arg) {
  if (!arg && !opts.name) fail("read requires a <company> or --name");
  const hit = opts.name
    ? readResearch(slugifyCompany(opts.name), { root: opts.root })
    : readCompanyResearch(arg, { root: opts.root });
  const stem = stemFor(arg);
  const relPath = researchRelPath(stem);
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          stem,
          relPath,
          exists: hit !== null,
          stale: hit ? hit.stale : null,
          text: hit ? hit.text : null,
        },
        null,
        2
      )
    );
    return;
  }
  if (hit === null) {
    console.error(`No research for "${stem}" yet (${relPath}). Skip silently.`);
    process.exit(0);
  }
  if (hit.stale)
    console.error(
      `Note: ${relPath} is stale (fetched ${hit.frontmatter.fetchedAt}). Consider re-running research.`
    );
  process.stdout.write(hit.text.endsWith("\n") ? hit.text : `${hit.text}\n`);
}

function cmdRecord(arg) {
  if (!arg && !opts.name) fail("record requires a <company> or --name");
  const stem = stemFor(arg);
  const text = resolveArtifact();
  if (!text) fail("record requires an artifact (--file FILE or piped stdin)");

  const plan = computeResearchWrite({ text });
  const relPath = researchRelPath(stem);

  if (!plan.ok) {
    if (opts.json)
      console.log(
        JSON.stringify(
          { ok: false, stem, relPath, error: plan.error, lint: plan.lint, leak: plan.leak },
          null,
          2
        )
      );
    else console.error(`research: refused, ${plan.error}`);
    process.exit(1);
  }

  if (!opts.write) {
    const fm = plan.frontmatter;
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            dryRun: true,
            stem,
            relPath,
            type: fm.type,
            sources: (fm.sources || []).length,
            stale: plan.stale,
          },
          null,
          2
        )
      );
    } else {
      console.log(`Proposed write to ${relPath}:`);
      console.log(`  type:    ${fm.type}`);
      console.log(`  subject: ${fm.company || fm.role || stem}`);
      console.log(`  sources: ${(fm.sources || []).length} cited`);
      console.log(
        `  fetched: ${fm.fetchedAt}${plan.stale ? " (already past staleness window)" : ""}`
      );
      console.log("");
      console.log("Dry run - pass --write to commit.");
    }
    process.exit(0);
  }

  const written = writeResearch({ stem, text, root: opts.root });
  if (!written.ok) fail(written.error);
  if (opts.json)
    console.log(
      JSON.stringify(
        { ok: true, written: true, stem, relPath, type: written.frontmatter.type },
        null,
        2
      )
    );
  else console.log(`Recorded to ${relPath} (${written.frontmatter.type}).`);
  process.exit(0);
}

// ---------------------------------------------------------------------------

function resolveArtifact() {
  if (opts.file) {
    const p = join(opts.root, opts.file);
    const path = existsSync(p) ? p : opts.file;
    if (!existsSync(path)) fail(`--file not found: ${opts.file}`);
    return readFileSync(path, "utf8");
  }
  if (!process.stdin.isTTY) {
    try {
      return readFileSync(0, "utf8");
    } catch {
      return "";
    }
  }
  return "";
}

function fail(msg) {
  if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error(`research: ${msg}`);
  process.exit(1);
}

function printHelp() {
  console.log(`careerrat research: safe read/record for web-research artifacts

Usage:
  node src/cli/research.mjs list [--json]
  node src/cli/research.mjs stale [--days N] [--json]
  node src/cli/research.mjs path  <company> [--name STEM] [--json]
  node src/cli/research.mjs read  <company> [--name STEM] [--json]
  node src/cli/research.mjs record <company> --file FILE [--name STEM] [--write] [--json]

Commands:
  list      List existing research artifacts (type · subject · sources · freshness).
  stale     List artifacts past their staleness window.
  path      Resolve the file path for a company/stem (no write).
  read      Print a research artifact (skip-note if it doesn't exist yet).
  record    Validate + write a composed artifact. DRY RUN by default; --write to commit.

Options:
  --name STEM   Explicit filename stem (comp-benchmark / board-discovery-log artifacts).
  --file FILE   The composed artifact (frontmatter + body) to record. Or pipe via stdin.
  --write       Commit the record (default: dry run).
  --days N      For 'stale': override the comparison window.
  --json        Machine-readable output.
  --root DIR    Repo root (default: the careerrat install).

A company resolves to one file via its slug. Recorded artifacts must carry valid
frontmatter (type, fetchedAt, company|role), cite at least one source for sourced
types (company-research, comp-benchmark), pass the placeholder lint, and never
contain the private current_base field. Writes are atomic.`);
}
