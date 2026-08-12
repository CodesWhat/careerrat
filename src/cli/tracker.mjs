#!/usr/bin/env node
// Rolester tracker CLI — publish the live dashboard, summarize, check follow-ups, verify.
//
// Usage:
//   careerrat tracker                 Publish workspace/tracker.html from the dashboard shell
//   careerrat tracker --summary    Print a plaintext status summary
//   careerrat tracker --followups  List follow-ups due now
//   careerrat tracker --verify     Validate tracker.json against config/tracker.schema.json
//   careerrat tracker --json       Machine-readable output for the current mode
//   careerrat tracker --help
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { displayPath, userPath } from "../core/paths/workspace.mjs";
import { loadModes } from "../core/profile/modes.mjs";
import { formatErrors, validate } from "../core/profile/schema-validator.mjs";
import { parseYaml } from "../core/profile/yaml.mjs";
import { computeFollowUps, rulesFromConfig } from "../core/tracker/cadence.mjs";
import {
  renderTrackerSummaryText,
  stripDemo,
  summarizeTracker,
} from "../core/tracker/dashboard.mjs";
import { loadLibrarySnapshot } from "../core/tracker/library-snapshot.mjs";
import { loadSettingsSnapshot } from "../core/tracker/settings-snapshot.mjs";
import { listSnapshots, snapshotTracker } from "../core/tracker/tracker-snapshot.mjs";

const root = join(fileURLToPath(new URL("../..", import.meta.url)));
const pathCtx = { repoRoot: root };
const TRACKER_PATH = userPath(pathCtx, "workspace/tracker.json");
const OUT_PATH = userPath(pathCtx, "workspace/tracker.html");
const OUT_DATA_PATH = userPath(pathCtx, "workspace/dashboard-data.js");
const OUT_MODES_PATH = userPath(pathCtx, "workspace/modes.json");
const OUT_SETTINGS_PATH = userPath(pathCtx, "workspace/settings.json");
const OUT_LIBRARY_PATH = userPath(pathCtx, "workspace/library.json");
const DASHBOARD_SHELL_PATH = join(root, "src/core/tracker/dashboard-shell.html");
const DASHBOARD_DATA_PATH = join(root, "src/core/tracker/dashboard-data.js");
const SCHEMA_PATH = join(root, "config/tracker.schema.json");
const TARGETING_PATH = userPath(pathCtx, "candidate/targeting.yml");
const TARGETING_DEMO = join(root, "templates/targeting.example.yml");

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
  runDashboard(stripDemo(data));
}
process.exit(exitCode);

// ---------------------------------------------------------------------------

function runDashboard(data) {
  const html = readFileSync(DASHBOARD_SHELL_PATH, "utf8");
  const dataModule = readFileSync(DASHBOARD_DATA_PATH, "utf8");
  const modes = loadModes({ root });
  const modeSnapshot = {
    configured: modes.exists,
    valid: modes.valid,
    usageMode: modes.data.usage_mode,
    applicationMode: modes.data.application_mode,
    errors: modes.errors,
  };
  const settingsSnapshot = loadSettingsSnapshot({ root });
  const librarySnapshot = loadLibrarySnapshot({ root });
  const agentGuidance = loadAgentGuidanceSnapshot();
  modeSnapshot.settings = settingsSnapshot;
  modeSnapshot.agentGuidance = agentGuidance;
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, html);
  writeFileSync(OUT_DATA_PATH, dataModule);
  writeFileSync(OUT_MODES_PATH, `${JSON.stringify(modeSnapshot, null, 2)}\n`);
  writeFileSync(OUT_SETTINGS_PATH, `${JSON.stringify(settingsSnapshot, null, 2)}\n`);
  writeFileSync(OUT_LIBRARY_PATH, `${JSON.stringify(librarySnapshot, null, 2)}\n`);
  try {
    const snap = snapshotTracker(pathCtx);
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
          wrote: [
            displayPath(pathCtx, "workspace/tracker.html"),
            displayPath(pathCtx, "workspace/dashboard-data.js"),
            displayPath(pathCtx, "workspace/modes.json"),
            displayPath(pathCtx, "workspace/settings.json"),
            displayPath(pathCtx, "workspace/library.json"),
          ],
          summary: summarizeTracker(data),
        },
        null,
        2
      )
    );
    return;
  }
  console.log(`Wrote ${displayPath(pathCtx, "workspace/tracker.html")}`);
  console.log(`Wrote ${displayPath(pathCtx, "workspace/dashboard-data.js")}`);
  console.log(`Wrote ${displayPath(pathCtx, "workspace/modes.json")}`);
  console.log(`Wrote ${displayPath(pathCtx, "workspace/settings.json")}`);
  console.log(`Wrote ${displayPath(pathCtx, "workspace/library.json")}`);
  console.log(renderTrackerSummaryText(data));
}

function loadAgentGuidanceSnapshot() {
  const result = spawnSync(process.execPath, [join(root, "src/cli/doctor.mjs"), "--json"], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
  if (result.error || !result.stdout) return null;
  try {
    const data = JSON.parse(result.stdout);
    return data?.agentGuidance ?? null;
  } catch {
    return null;
  }
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
  const targetingPath = existsSync(TARGETING_PATH) ? TARGETING_PATH : TARGETING_DEMO;
  try {
    const targeting = existsSync(targetingPath)
      ? parseYaml(readFileSync(targetingPath, "utf8"))
      : null;
    return rulesFromConfig(targeting?.follow_up);
  } catch {
    return undefined;
  }
}

function printHelp() {
  console.log(`careerrat tracker — dashboard, summary, follow-ups, verify

Usage:
  careerrat tracker                 Publish workspace/tracker.html (also snapshots tracker.json)
  careerrat tracker --summary    Plaintext status summary
  careerrat tracker --followups  Follow-ups due now
  careerrat tracker --verify     Validate against config/tracker.schema.json
  careerrat tracker --snapshots  List rolling tracker.json snapshots (workspace/.snapshots/)
  careerrat tracker --json       Machine-readable output

Reads workspace/tracker.json (seed from templates/tracker.json).
Snapshots: workspace/.snapshots/tracker-<timestamp>.json, newest-20 kept.
Recovery: copy a snapshot back over workspace/tracker.json to restore.`);
}
