#!/usr/bin/env node

// careerrat outcomes: honest outcome rates from the tracker, no web app needed.
//
// In-flight applications stay out of the rate, nothing prints as a percentage below
// the sample floor (5 resolved outcomes), and the rate is split by fit score band so
// you can see whether higher scores actually get answered. Read-only.
//
// Usage:
//   node src/cli/outcomes.mjs [--json] [--root DIR]

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { displayPath, userPath } from "../core/paths/workspace.mjs";
import { buildOutcomeRates, formatOutcomeRates } from "../core/tracker/outcome-rates.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const opts = { json: false, root: ROOT };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--json") opts.json = true;
  else if (argv[i] === "--root") opts.root = argv[++i];
  else if (argv[i] === "--help" || argv[i] === "-h") opts.help = true;
}

if (opts.help) {
  console.log(`careerrat outcomes: honest outcome rates (read-only)

Usage:
  node src/cli/outcomes.mjs [--json] [--root DIR]

In-flight applications are not counted. A percentage appears only once there are
5 resolved outcomes. Rates are also split by fit score band.`);
  process.exit(0);
}

const pathCtx = { repoRoot: opts.root };
const trackerPath = userPath(pathCtx, "workspace/tracker.json");
if (!existsSync(trackerPath)) {
  const msg = `no tracker at ${displayPath(pathCtx, "workspace/tracker.json")}`;
  if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
  else console.error(`outcomes: ${msg}`);
  process.exit(1);
}
let data;
try {
  data = JSON.parse(readFileSync(trackerPath, "utf8"));
} catch (err) {
  const msg = `could not parse tracker.json: ${err.message}`;
  if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
  else console.error(`outcomes: ${msg}`);
  process.exit(1);
}
const rates = buildOutcomeRates(data.applications || []);
if (opts.json) console.log(JSON.stringify({ ok: true, ...rates }, null, 2));
else console.log(formatOutcomeRates(rates));
