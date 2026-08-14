#!/usr/bin/env node
// CareerRat evaluate CLI — run the body-read gate on a saved job posting.
//
// Usage:
//   careerrat evaluate <path-to-job.md>     Emit GATE/FIT/COMP/ACTION
//   careerrat evaluate <path> --json        Full machine-readable verdict
//   careerrat evaluate --help
//
// Reads candidate/targeting.yml, candidate/profile.yml, candidate/honesty.yml.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { dbExists } from "../core/db/connection.mjs";
import { deepIngestConfirmedForGeneration } from "../core/db/verbs/index.mjs";
import { evaluateGate, parseSavedJob, renderGateBlock } from "../core/evaluate/gate.mjs";
import { loadCandidateDoc } from "../core/profile/config-store.mjs";
import { loadModes } from "../core/profile/modes.mjs";

const root = join(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);
const json = args.includes("--json");

if (args.includes("--help") || args.includes("-h") || args.length === 0) {
  printHelp();
  process.exit(args.length === 0 ? 1 : 0);
}

const jobArg = args.find((a) => !a.startsWith("-"));
if (!jobArg) {
  console.error("Provide a saved job markdown path. See: careerrat evaluate --help");
  process.exit(1);
}

const jobPath = isAbsolute(jobArg) ? jobArg : join(process.cwd(), jobArg);
if (!existsSync(jobPath)) {
  console.error(`Job file not found: ${jobPath}`);
  process.exit(1);
}

const targeting = loadCandidateDoc("targeting", { repoRoot: root });
const profile = loadCandidateDoc("profile", { repoRoot: root });
const honesty = loadCandidateDoc("honesty", { repoRoot: root }) || {};
const modes = loadModes({ root });
if (!targeting || !profile) {
  console.error("Need candidate/targeting.yml and candidate/profile.yml. Run: npm run ingest");
  process.exit(1);
}
if (!modes.valid) {
  console.error("candidate/modes.yml is invalid:");
  for (const e of modes.errors) console.error(`- ${e.path || "(root)"}: ${e.message}`);
  process.exit(1);
}

// DB-backed workspaces fold confirmed role-signal rows into the gate; YAML-only
// workspaces are unchanged (evaluateGate treats no rows as a no-op).
let roleSignals;
if (dbExists({ repoRoot: root })) {
  try {
    roleSignals = deepIngestConfirmedForGeneration({ repoRoot: root }).roleSignals;
  } catch {
    roleSignals = undefined;
  }
}

const job = parseSavedJob(readFileSync(jobPath, "utf8"));
const result = evaluateGate({
  job,
  targeting,
  profile,
  honesty,
  modes: modes.data,
  now: new Date(),
  roleSignals,
});

if (json) {
  console.log(JSON.stringify({ job: { frontmatter: job.frontmatter }, result }, null, 2));
} else {
  console.log(renderGateBlock(result));
  if (result.reasons && result.reasons.length > 1) {
    console.log("");
    console.log("Notes:");
    for (const r of result.reasons) console.log(`- ${r}`);
  }
}

// CUT or REVIEW are non-zero so callers/CI can branch on the gate.
process.exit(result.gate === "KEEP" ? 0 : result.gate === "REVIEW" ? 2 : 1);

// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`careerrat evaluate — run the body-read gate on a saved job

Usage:
  careerrat evaluate <path-to-job.md>     Emit GATE / FIT / COMP / ACTION
  careerrat evaluate <path> --json        Full machine-readable verdict
  careerrat evaluate --help

Exit codes: 0 KEEP, 2 REVIEW, 1 CUT (or error).
Inputs: candidate/targeting.yml, candidate/profile.yml, candidate/honesty.yml.`);
}
