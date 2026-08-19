#!/usr/bin/env node

// careerrat health — the safe write path for the company-health skill's
// role-scoped rating (M-company-health: the durable persist step SKILL.md
// STEP 5 describes was missing a dedicated verb/CLI until now).
//
// The company-health skill web-searches, scores, and composes a companyHealth
// object; it RECORDS through this helper instead of hand-patching the tracker
// row directly (via `careerrat data app set-fields` / `sourced upsert-batch`)
// so the rating/provenance/asOf/fitDelta validation and the current_base
// privacy guard always run — the same reason `research record` exists instead
// of skills writing workspace/research/*.md by hand.
//
// Usage:
//   node src/cli/health.mjs record <applicationOrSourcedId> --file FILE [--write] [--json]
//   node src/cli/health.mjs --help
//
// `record` is a DRY RUN by default: it validates the companyHealth payload
// (rating/provenance enums, asOf format, fitDelta <= 0, no current_base leak)
// and, when the database workspace already exists, previews which row it
// would land on — committing nothing. Pass --write to commit (one transaction:
// row replace + meta bump + activity event, via the companyHealthSet verb).
//
// This is a DB-backed command only (mirrors `careerrat data`'s fail-closed
// verbs) — a legacy tracker.json-only workspace has no companyHealth verb
// path; --write in that case surfaces a clear "needs the database workspace"
// error instead of hand-editing tracker.json.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dbExists, NO_DATABASE_MESSAGE, openDb } from "../core/db/connection.mjs";
import { companyHealthSet, validateCompanyHealth } from "../core/db/verbs/company-health.mjs";
import { getRow } from "../core/db/verbs/shared.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function parseArgs(argv) {
  const opts = { positional: [], write: false, json: false, root: ROOT, env: process.env };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") opts.write = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--file") opts.file = argv[++i];
    else if (a === "--root") opts.root = argv[++i];
    else opts.positional.push(a);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const pathCtx = { repoRoot: opts.root, env: opts.env };

if (opts.help || opts.positional.length === 0) {
  printHelp();
  process.exit(opts.help ? 0 : 1);
}

const [verb, id] = opts.positional;

try {
  switch (verb) {
    case "record":
      cmdRecord(id);
      break;
    default:
      fail(`unknown command "${verb}". Commands: record. See --help.`);
  }
} catch (err) {
  fail(err?.message || String(err));
}

// ---------------------------------------------------------------------------

function cmdRecord(recordId) {
  if (!recordId) fail("record requires <applicationOrSourcedId>");
  if (!opts.file) fail("record requires --file <rating.json>");

  const companyHealth = readPayload(opts.file);

  let validated;
  try {
    validated = validateCompanyHealth(companyHealth);
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, id: recordId, error: err.message }, null, 2));
    } else {
      console.error(`health: refused, ${err.message}`);
    }
    process.exit(1);
    return;
  }

  if (!opts.write) {
    const preview = previewHost(recordId);
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            dryRun: true,
            id: recordId,
            rating: validated.rating,
            forFunction: validated.forFunction,
            asOf: validated.asOf,
            provenance: validated.provenance,
            fitDelta: validated.fitDelta,
            crossCut: validated.crossCut,
            host: preview,
          },
          null,
          2
        )
      );
    } else {
      console.log(`Proposed companyHealth write for ${recordId}:`);
      console.log(
        `  rating:      ${validated.rating}${validated.forFunction ? ` for ${validated.forFunction}` : ""}`
      );
      console.log(`  asOf:        ${validated.asOf} (${validated.provenance})`);
      console.log(`  fitDelta:    ${validated.fitDelta}`);
      console.log(
        `  crossCut:    ${validated.crossCut.length ? validated.crossCut.join(", ") : "none"}`
      );
      if (preview) console.log(`  target row:  ${preview.table}: ${preview.company || recordId}`);
      else
        console.log(
          `  target row:  not resolved (${preview === null ? "no matching row, or no database yet" : ""})`
        );
      console.log("");
      console.log("Dry run - pass --write to commit.");
    }
    process.exit(0);
    return;
  }

  const result = companyHealthSet({ ...pathCtx, id: recordId, companyHealth: validated });
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, written: true, ...result }, null, 2));
  } else {
    console.log(
      `Recorded companyHealth for ${recordId} (${result.table}): ${result.companyHealth.rating}.`
    );
  }
  process.exit(0);
}

// Read-only preview of which row --write would land on; never opens/creates a
// database (openDb is only called after confirming the file exists), and
// never throws — a missing/absent db here just means "nothing to preview
// yet," not a fatal error, since the dry run itself is the useful signal.
function previewHost(recordId) {
  if (!dbExists(pathCtx)) return null;
  const db = openDb(pathCtx);
  const app = getRow(db, "applications", recordId);
  if (app) return { table: "applications", company: app.company || null, role: app.role || null };
  const sourced = getRow(db, "sourced", recordId);
  if (sourced)
    return { table: "sourced", company: sourced.company || null, role: sourced.role || null };
  return null;
}

function readPayload(file) {
  const path = existsSync(file) ? file : `${opts.root}/${file}`;
  if (!existsSync(path)) fail(`--file not found: ${file}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`--file is not valid JSON: ${err.message}`);
    return undefined; // unreachable; fail() exits the process
  }
}

function fail(msg) {
  if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error(`health: ${msg}`);
  process.exit(1);
}

function printHelp() {
  console.log(`careerrat health: persist the company-health skill's role-scoped rating

Usage:
  node src/cli/health.mjs record <applicationOrSourcedId> --file FILE [--write] [--json]

Commands:
  record    Validate + write a companyHealth object onto an applications[] or
            sourced[] row (resolved by id). DRY RUN by default; --write to commit.

Options:
  --file FILE   The composed companyHealth JSON object to record (required).
  --write       Commit the record (default: dry run).
  --json        Machine-readable output.
  --root DIR    Repo root (default: the careerrat install).

The companyHealth object must carry: rating (healthy|watch|risky), forFunction,
asOf (YYYY-MM-DD), provenance (built-from-data|needs-more-info|stale), dimensions
(object), rationale, and optionally crossCut (array), fitDelta (number <= 0,
defaults to 0), signals (array). It is refused if it names the private
current_base field, or if fitDelta is positive.

This is a database-backed command: ${NO_DATABASE_MESSAGE}`);
}
