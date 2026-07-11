#!/usr/bin/env node
// Rolester tracker CLI — snapshot tracker.json, summarize, check follow-ups, verify.
//
// The legacy static-HTML dashboard publish step (workspace/tracker.html +
// workspace/dashboard-data.js/modes.json/settings.json/library.json) has been
// retired — the live product is the React SPA at /app (src/cli/tracker-dev.mjs),
// which reads the sqlite-backed GET /api/data/dashboard view model directly.
// The default (no-flag) action here still snapshots tracker.json, since many
// skills rely on `rolester tracker` as their durable-backup checkpoint.
//
// Usage:
//   rolester tracker                 Snapshot workspace/tracker.json, print a summary
//   rolester tracker --summary    Print a plaintext status summary
//   rolester tracker --followups  List follow-ups due now
//   rolester tracker --verify     Validate tracker.json against config/tracker.schema.json
//   rolester tracker --json       Machine-readable output for the current mode
//   rolester tracker --help
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { displayPath, userPath } from "../core/paths/workspace.mjs";
import { loadCandidateDoc } from "../core/profile/config-store.mjs";
import { formatErrors, validate } from "../core/profile/schema-validator.mjs";
import { computeFollowUps, rulesFromConfig } from "../core/tracker/cadence.mjs";
import {
  renderTrackerSummaryText,
  stripDemo,
  summarizeTracker,
} from "../core/tracker/dashboard.mjs";
import { listSnapshots, snapshotTracker } from "../core/tracker/tracker-snapshot.mjs";

const root = join(fileURLToPath(new URL("../..", import.meta.url)));
const pathCtx = { repoRoot: root };
const TRACKER_PATH = userPath(pathCtx, "workspace/tracker.json");
const SCHEMA_PATH = join(root, "config/tracker.schema.json");

const args = process.argv.slice(2);
const json = args.includes("--json");

if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

const data = loadTracker();
if (!data) {
  console.error(
    `No ${displayPath(pathCtx, "workspace/tracker.json")} yet. Seed one from templates/tracker.json.`
  );
  process.exit(1);
}

let exitCode = 0;
if (args.includes("--verify")) {
  // --verify validates the raw file as-stored; never strip the demo seed here.
  exitCode = runVerify(data);
} else if (args.includes("--snapshots")) {
  runSnapshots();
} else if (args.includes("--summary")) {
  runSummary(stripDemo(data));
} else if (args.includes("--followups")) {
  runFollowUps(stripDemo(data));
} else {
  runSnapshot(stripDemo(data));
}
process.exit(exitCode);

// ---------------------------------------------------------------------------

function runSnapshot(data) {
  let snapshot = null;
  try {
    const snap = snapshotTracker(pathCtx);
    snapshot = snap;
    if (snap.wrote) {
      console.log(
        `Snapshot: ${displayPath(pathCtx, `workspace/.snapshots/${snap.wrote.split(/[\\/]/).pop()}`)}`
      );
    } else if (snap.skipped) {
      console.log(`Snapshot: skipped (${snap.reason})`);
    } else if (!snap.ok) {
      console.error(`Snapshot warning: ${snap.error}`);
    }
  } catch (err) {
    console.error(`Snapshot warning: ${err?.message ?? String(err)}`);
  }
  if (json) {
    console.log(
      JSON.stringify(
        {
          snapshot,
          summary: summarizeTracker(data),
        },
        null,
        2
      )
    );
    return;
  }
  console.log(renderTrackerSummaryText(data));
}

function runSummary(data) {
  if (json) {
    console.log(JSON.stringify(summarizeTracker(data), null, 2));
    return;
  }
  console.log(renderTrackerSummaryText(data));
}

function runFollowUps(data) {
  const now = new Date();
  const items = computeFollowUps(data, { now, rules: loadFollowUpRules() });
  if (json) {
    console.log(JSON.stringify({ count: items.length, items }, null, 2));
    return;
  }
  if (items.length === 0) {
    console.log("No follow-ups due.");
    return;
  }
  console.log(`Follow-ups due (${items.length}):`);
  for (const it of items) {
    const overdue = it.overdueDays > 0 ? ` (${it.overdueDays}d overdue)` : "";
    console.log(`- [${it.kind}] ${it.company || ""} ${it.role || ""}${overdue} — ${it.reason}`);
  }
}

function runVerify(data) {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const result = validate(data, schema);
  if (json) {
    console.log(JSON.stringify({ valid: result.valid, errors: result.errors }, null, 2));
    return result.valid ? 0 : 1;
  }
  if (result.valid) {
    console.log("tracker.json is valid against config/tracker.schema.json.");
    return 0;
  }
  console.log("tracker.json is invalid:");
  console.log(formatErrors(result.errors));
  return 1;
}

function runSnapshots() {
  const snaps = listSnapshots(pathCtx);
  if (json) {
    console.log(
      JSON.stringify({ count: snaps.length, snapshots: snaps.map((s) => s.name) }, null, 2)
    );
    return;
  }
  if (snaps.length === 0) {
    console.log("No snapshots found. Run without flags to create the first snapshot.");
    return;
  }
  console.log(`Tracker snapshots (${snaps.length}, newest first):`);
  for (const s of snaps) {
    console.log(`  ${s.name}`);
  }
}

function loadTracker() {
  if (!existsSync(TRACKER_PATH)) return null;
  try {
    return JSON.parse(readFileSync(TRACKER_PATH, "utf8"));
  } catch (err) {
    console.error(
      `Could not parse ${displayPath(pathCtx, "workspace/tracker.json")}: ${err.message}`
    );
    process.exit(1);
  }
}

// Per-kind follow-up cadence rules from the candidate's `follow_up:` config
// block (targeting.yml), falling back to the example template so the seeded
// demo still reflects the feature. Returns undefined when no block is set, so
// the cadence engine uses its domain-neutral defaults (every kind on).
function loadFollowUpRules() {
  try {
    const targeting = loadCandidateDoc("targeting", { ...pathCtx, fallbackToTemplate: true });
    return rulesFromConfig(targeting?.follow_up);
  } catch {
    return undefined;
  }
}

function printHelp() {
  console.log(`rolester tracker — snapshot, summary, follow-ups, verify

Usage:
  rolester tracker                 Snapshot workspace/tracker.json, print a summary
  rolester tracker --summary    Plaintext status summary
  rolester tracker --followups  Follow-ups due now
  rolester tracker --verify     Validate against config/tracker.schema.json
  rolester tracker --snapshots  List rolling tracker.json snapshots (workspace/.snapshots/)
  rolester tracker --json       Machine-readable output

Reads workspace/tracker.json (seed from templates/tracker.json).
Snapshots: workspace/.snapshots/tracker-<timestamp>.json, newest-20 kept.
Recovery: copy a snapshot back over workspace/tracker.json to restore.`);
}
