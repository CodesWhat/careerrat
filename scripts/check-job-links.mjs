#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { dbExists } from "../src/core/db/connection.mjs";
import { jobLinkCheckLast, jobLinkCheckRecord } from "../src/core/db/verbs/search-liveness.mjs";
import { closedSinceLastCheck } from "../src/core/liveness/closed-since.mjs";
import { checkUrlLiveness } from "../src/core/liveness/job-link-checker.mjs";
import { displayPath, userPath } from "../src/core/paths/workspace.mjs";
import { loadTrackerData } from "../src/core/tracker/tracker-data.mjs";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const pathCtx = { repoRoot: root };
const args = process.argv.slice(2);
const fileArg = valueAfter("--file");
const strict = args.includes("--strict");
let urls = [];

if (fileArg) {
  urls = readFileSync(fileArg, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
} else {
  const trackerPath = userPath(pathCtx, "workspace/tracker.json");
  if (!existsSync(trackerPath)) {
    console.error(
      `Tracker not found at ${displayPath(pathCtx, "workspace/tracker.json")}. Seed one from templates/tracker.json.`
    );
    process.exit(1);
  }
  const data = loadTrackerData(trackerPath);
  urls = [...data.apps, ...data.sourced].map((row) => row.link).filter(Boolean);
}

const keepLedger = dbExists(pathCtx);
const previous = keepLedger ? jobLinkCheckLast(pathCtx) : new Map();
const results = [];
for (const url of urls) {
  const result = await checkUrlLiveness(url);
  results.push(result);
  console.log(`${result.result.padEnd(9)} ${url} - ${result.reason}`);
}

// Codes meaning the check itself never ran (as opposed to a page that was read
// and could not be judged).
const COULD_NOT_RUN_CODES = new Set(["fetch_failed", "timeout", "navigation_error", "unsafe_url"]);
const couldNotRun = results.filter(
  (result) => result.result === "uncertain" && COULD_NOT_RUN_CODES.has(result.code)
);
const live = results.filter((result) => result.result === "active").length;
const expired = results.filter((result) => result.result === "expired").length;
console.log(
  `${results.length - couldNotRun.length} of ${results.length} links could be checked: ` +
    `${live} live, ${expired} closed, ${couldNotRun.length} unreachable.`
);

// Remember only definitive answers, so a network blip never overwrites what we
// last knew, then name the links that closed since the previous run.
if (keepLedger) {
  jobLinkCheckRecord({
    ...pathCtx,
    entries: results.filter((r) => r.result === "active" || r.result === "expired"),
  });
}
const closedSince = closedSinceLastCheck(previous, results);
if (closedSince.length > 0) {
  console.log(`Closed since last check (${closedSince.length}):`);
  for (const url of closedSince) console.log(`  ${url}`);
}

const bad = results.filter(
  (result) => result.result === "expired" || (strict && result.result === "uncertain")
);
if (bad.length > 0) process.exitCode = 1;

// Say how many links could not be checked at all. Without this a dead network
// looks the same as a clean run: one quiet line per link and a zero exit.
const unchecked = results.filter((result) => result.result === "uncertain");
if (results.length > 0) {
  console.log("");
  console.log(
    `Checked ${results.length} link(s): ${results.length - unchecked.length} gave an answer, ${unchecked.length} could not be checked.`
  );
  if (unchecked.length === results.length) {
    console.error(
      `None of the ${results.length} link(s) could be checked. Check your connection and try again.`
    );
    process.exitCode = 1;
  }
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}
