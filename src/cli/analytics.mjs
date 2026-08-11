#!/usr/bin/env node

// careerrat analytics — refresh and inspect the persisted outcome-analytics block.
//
// The analytics block (tracker.json#analytics) is a DERIVED rollup: byStatus, per-family
// rejection/advancement counts, and a reevaluation-due signal. It is written here and
// read by the dashboard; no other code recomputes it. Because it is derived data (not a
// user data change), it NEVER bumps the freshness stamp — the "last updated" pill must
// only move on real data writes. The write goes through the storage adapter
// (defaultAdapter().writeTracker) with { stamp: false }, same underlying
// writeTrackerJson stamping semantics.
//
// Usage:
//   node src/cli/analytics.mjs refresh [--at ISO] [--write] [--json] [--root DIR]
//   node src/cli/analytics.mjs status [--json] [--root DIR]
//
// refresh is a DRY RUN by default: it computes the analytics block and prints it,
// writing nothing. Pass --write to persist. Thresholds come from
// candidate/targeting.yml#reevaluation (rejection_total, rejection_per_family);
// defaults are 7 and 3 respectively.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { displayPath, userPath } from "../core/paths/workspace.mjs";
import { loadCandidateDoc } from "../core/profile/config-store.mjs";
import { defaultAdapter } from "../core/storage/storage-adapter.mjs";
import { buildReevaluationAnalytics } from "../core/tracker/outcome-analysis.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function parseArgs(argv) {
  const opts = { positional: [], write: false, json: false, root: ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") opts.write = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--at") opts.at = argv[++i];
    else if (a === "--root") opts.root = argv[++i];
    else opts.positional.push(a);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  printHelp();
  process.exit(0);
}

// Default verb to "refresh" when flags are present but no positional verb was given,
// so `careerrat analytics --write` works without an explicit "refresh" positional.
if (opts.positional.length === 0 && process.argv.length > 2) {
  opts.positional.push("refresh");
}

if (opts.positional.length === 0) {
  printHelp();
  process.exit(1);
}

const [verb] = opts.positional;
const pathCtx = { repoRoot: opts.root };
const trackerPath = userPath(pathCtx, "workspace/tracker.json");

switch (verb) {
  case "refresh":
    cmdRefresh();
    break;
  case "status":
    cmdStatus();
    break;
  default:
    fail(`unknown command "${verb}". Commands: refresh, status. See --help.`);
}

// ---------------------------------------------------------------------------

function loadTracker() {
  if (!existsSync(trackerPath)) {
    fail(`no tracker at ${displayPath(pathCtx, "workspace/tracker.json")}`);
  }
  try {
    return JSON.parse(readFileSync(trackerPath, "utf8"));
  } catch (err) {
    fail(`could not parse tracker.json: ${err.message}`);
  }
}

function loadTargeting() {
  try {
    return loadCandidateDoc("targeting", pathCtx) || undefined;
  } catch {
    return undefined;
  }
}

function resolveThresholds(targeting) {
  const reeval = targeting?.reevaluation || {};
  return {
    rejectionTotal: reeval.rejection_total ?? 7,
    rejectionPerFamily: reeval.rejection_per_family ?? 3,
  };
}

function cmdRefresh() {
  const data = loadTracker();
  const targeting = loadTargeting();
  const thresholds = resolveThresholds(targeting);
  const now = opts.at ? new Date(opts.at) : new Date();

  const analytics = buildReevaluationAnalytics({
    apps: data.applications || [],
    targeting,
    strategyReview: data.strategyReview || null,
    thresholds,
    now,
  });

  if (!opts.write) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, dryRun: true, analytics }, null, 2));
    } else {
      console.log("Proposed analytics block for workspace/tracker.json:");
      console.log(JSON.stringify(analytics, null, 2));
      console.log("");
      console.log("Dry run - pass --write to persist (does not bump the freshness stamp).");
    }
    process.exit(0);
  }

  data.analytics = analytics;
  defaultAdapter(opts.root).writeTracker(data, { stamp: false });

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, written: true, analytics }, null, 2));
  } else {
    const due = analytics.reevaluation?.due;
    console.log(
      `Analytics refreshed at ${analytics.updatedAt} (reevaluation due: ${due ? "YES" : "no"}).`
    );
    if (due && analytics.reevaluation?.dueReasons?.length) {
      for (const reason of analytics.reevaluation.dueReasons) {
        console.log(`  reason: ${reason}`);
      }
    }
  }
  process.exit(0);
}

function cmdStatus() {
  const data = loadTracker();
  const analytics = data.analytics || null;
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, analytics }, null, 2));
    process.exit(0);
  }
  if (!analytics) {
    console.log("No analytics block yet. Run: node src/cli/analytics.mjs refresh --write");
    process.exit(0);
  }
  console.log(`Analytics last refreshed: ${analytics.updatedAt || "unknown"}`);
  console.log(`  Rejected total: ${analytics.rejected?.total ?? "?"}`);
  console.log(`  Advanced total: ${analytics.advanced?.total ?? "?"}`);
  const due = analytics.reevaluation?.due;
  console.log(`  Reevaluation due: ${due ? "YES" : "no"}`);
  if (due && analytics.reevaluation?.dueReasons?.length) {
    for (const reason of analytics.reevaluation.dueReasons) {
      console.log(`    reason: ${reason}`);
    }
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------

function fail(msg) {
  if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error(`analytics: ${msg}`);
  process.exit(1);
}

function printHelp() {
  console.log(`careerrat analytics — refresh and inspect the persisted outcome-analytics block

Usage:
  node src/cli/analytics.mjs refresh [--at ISO] [--write] [--json] [--root DIR]
  node src/cli/analytics.mjs status  [--json]   [--root DIR]

Commands:
  refresh  Compute the analytics block from workspace/tracker.json and print it.
           DRY RUN by default; pass --write to persist. Does NOT bump the freshness stamp.
  status   Print the current persisted analytics block (or "none yet").

refresh options:
  --at ISO    Override "now" timestamp (ISO 8601; default: current time).
  --write     Persist the computed block to tracker.json (stamp: false - no freshness bump).
  --json      Machine-readable output.
  --root DIR  Repo root (default: the careerrat install).

Thresholds come from candidate/targeting.yml#reevaluation:
  rejection_total:      <n>   Reevaluation fires when this many rejections accrue since last review (default 7).
  rejection_per_family: <n>   Reevaluation fires when any one family hits this count (default 3).`);
}
