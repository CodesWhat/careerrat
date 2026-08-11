#!/usr/bin/env node

// careerrat strategy-review — stamp the "last reviewed" marker on the tracker.
//
// reevaluate-strategy calls this on completion so the dashboard "review ready" nudge
// self-clears. It records when the review happened (lastReviewedAt) and a snapshot of
// the all-time resolved-outcome count (advances + rejections). The render gate
// (buildStrategyReviewTrigger in dashboard-data.js) then stays quiet until enough NEW
// outcomes accrue past the threshold — without the stamp the banner re-fires on every
// render forever, since the rolling 30-day counts stay above threshold regardless of
// whether a review just ran.
//
// Like `careerrat activity` / `careerrat learnings`, the CLI only WRITES this mechanical
// marker — it makes no strategy judgement (AGENTS.md → capture-is-skills-not-cli). The
// snapshot is computed with buildStrategyReviewStamp, the SAME predicate the render gate
// reads, so the stored count and the live count can never diverge.
//
// Usage:
//   node src/cli/strategy-review.mjs stamp [--at ISO] [--write] [--json]
//   node src/cli/strategy-review.mjs status [--json]
//
// stamp is a DRY RUN by default: it computes the marker and prints it, writing nothing.
// Pass --write to commit. Re-render afterwards (careerrat tracker) so the cleared
// banner shows.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dbExists } from "../core/db/connection.mjs";
import { kvUpsert } from "../core/db/verbs.mjs";
import { displayPath, userPath } from "../core/paths/workspace.mjs";
import { loadCandidateDoc } from "../core/profile/config-store.mjs";
import { buildStrategyReviewStamp } from "../core/tracker/dashboard-data.js";
import { writeTrackerJson } from "../core/tracker/tracker-writer.mjs";

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

if (opts.help || opts.positional.length === 0) {
  printHelp();
  process.exit(opts.help ? 0 : 1);
}

const [verb] = opts.positional;
const pathCtx = { repoRoot: opts.root };
const trackerPath = userPath(pathCtx, "workspace/tracker.json");

switch (verb) {
  case "stamp":
    cmdStamp();
    break;
  case "status":
    cmdStatus();
    break;
  default:
    fail(`unknown command "${verb}". Commands: stamp, status. See --help.`);
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

function cmdStamp() {
  const trackerData = loadTracker();
  const targeting = loadTargeting();
  const at = opts.at || new Date().toISOString();
  const marker = buildStrategyReviewStamp(trackerData, at, targeting);

  if (!opts.write) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, dryRun: true, strategyReview: marker }, null, 2));
    } else {
      console.log("Proposed strategyReview marker for workspace/tracker.json:");
      console.log(`  ${JSON.stringify(marker)}`);
      console.log("");
      console.log("Dry run - pass --write to commit, then re-render (careerrat tracker).");
    }
    process.exit(0);
  }

  if (dbExists(pathCtx)) {
    kvUpsert({ ...pathCtx, key: "strategyReview", value: marker });
  } else {
    trackerData.strategyReview = marker;
    writeTrackerJson(trackerPath, trackerData, { at: marker.lastReviewedAt });
  }
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, written: true, strategyReview: marker }, null, 2));
  } else {
    console.log(
      `Stamped strategyReview at ${marker.lastReviewedAt} (outcomes: ${marker.snapshot.outcomes}).`
    );
    console.log("Re-render to clear the banner: careerrat tracker");
  }
  process.exit(0);
}

function cmdStatus() {
  const trackerData = loadTracker();
  const review = trackerData.strategyReview || null;
  const live = buildStrategyReviewStamp(trackerData, "").snapshot;
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, strategyReview: review, liveSnapshot: live }, null, 2));
    process.exit(0);
  }
  if (!review) {
    console.log(
      "No strategy review recorded yet. Live outcomes (advances + rejections):",
      live.outcomes
    );
    process.exit(0);
  }
  const newOutcomes = Math.max(0, live.outcomes - (review.snapshot?.outcomes ?? 0));
  console.log(`Last reviewed: ${review.lastReviewedAt}`);
  console.log(
    `  at-review outcomes: ${review.snapshot?.outcomes ?? "?"}, now: ${live.outcomes} (${newOutcomes} new)`
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------

function fail(msg) {
  if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error(`strategy-review: ${msg}`);
  process.exit(1);
}

function printHelp() {
  console.log(`careerrat strategy-review — stamp the last-reviewed marker on the tracker

Usage:
  node src/cli/strategy-review.mjs stamp [--at ISO] [--write] [--json]
  node src/cli/strategy-review.mjs status [--json]

Commands:
  stamp   Record a completed strategy review (clears the dashboard "review ready"
          nudge until new outcomes accrue). DRY RUN by default; --write to commit.
  status  Show the last-reviewed marker and how many new outcomes accrued since.

stamp options:
  --at ISO    Review timestamp (default: now).
  --write     Commit (default dry run).  --json  Machine-readable output.
  --root DIR  Repo root (default: the careerrat install).

reevaluate-strategy calls \`stamp --write\` on completion, then re-renders. The marker
is mechanical (timestamp + outcome snapshot); the skill owns the strategy judgement.`);
}
