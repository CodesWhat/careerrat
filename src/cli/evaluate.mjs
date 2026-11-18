#!/usr/bin/env node
// CareerRat evaluate CLI — run the body-read gate on a saved job posting.
//
// Usage:
//   careerrat evaluate <path-to-job.md>     Emit GATE/FIT/COMP/ACTION
//   careerrat evaluate <path> --json        Full machine-readable verdict
//   careerrat evaluate <path> --write       Also save the verdict on the tracked job (DB workspace)
//   careerrat evaluate --help
//
// Reads candidate/targeting.yml, candidate/profile.yml, candidate/honesty.yml.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { dbExists, openDb } from "../core/db/connection.mjs";
import { deepIngestConfirmedForGeneration } from "../core/db/verbs/index.mjs";
import { evaluateGate, parseSavedJob, renderGateBlock } from "../core/evaluate/gate.mjs";
import {
  EvaluationWriteError,
  hasReadableBody,
  persistEvaluationVerdict,
} from "../core/evaluate/persist.mjs";
import { resolveUserFileArg } from "../core/paths/user-file-arg.mjs";
import { loadCandidateDoc } from "../core/profile/config-store.mjs";
import { loadModes } from "../core/profile/modes.mjs";
import { exitOnUnknownFlags } from "./unknown-flags.mjs";

const root = join(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);
const json = args.includes("--json");
const write = args.includes("--write");

if (args.includes("--help") || args.includes("-h") || args.length === 0) {
  printHelp();
  process.exit(args.length === 0 ? 1 : 0);
}

// 2 is the REVIEW verdict here, so a usage error gets EX_USAGE (64) instead.
exitOnUnknownFlags(args, ["--json", "--write", "--app", "--help", "-h"], "evaluate", 64);

const appFlagAt = args.indexOf("--app");
const explicitAppId = appFlagAt >= 0 ? args[appFlagAt + 1] : undefined;
if (appFlagAt >= 0 && (!explicitAppId || explicitAppId.startsWith("-"))) {
  console.error("--app needs an application id. See: careerrat evaluate --help");
  process.exit(1);
}
if (explicitAppId && !write) {
  console.error("--app only applies with --write.");
  process.exit(1);
}

// Saving needs the database. Say so up front instead of running the whole gate
// and then quietly not saving anything.
if (write && !dbExists({ repoRoot: root })) {
  console.error(
    "--write needs a database workspace, and this one doesn't have one yet, so nothing was saved. Run: careerrat data import"
  );
  process.exit(1);
}

const jobArg = args.find((a, i) => !a.startsWith("-") && (appFlagAt < 0 || i !== appFlagAt + 1));
if (!jobArg) {
  console.error("Provide a saved job markdown path. See: careerrat evaluate --help");
  process.exit(1);
}

const { path: jobPath, tried: jobTried } = resolveUserFileArg(jobArg, { repoRoot: root });
if (!jobPath) {
  console.error(`Job file not found. Looked in:\n  ${jobTried.join("\n  ")}`);
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
if (!job.body) {
  console.error(
    "WARNING: this file has no job text, so the verdict below is scored from the title alone and the cut signals saw nothing."
  );
}
const result = evaluateGate({
  job,
  targeting,
  profile,
  honesty,
  modes: modes.data,
  now: new Date(),
  roleSignals,
});

// Persist before printing so a failed save is never reported next to a verdict
// that looks saved. A job with no readable text is not a real evaluation and
// is never written.
let saved = null;
if (write) {
  if (!hasReadableBody(job)) {
    console.error(
      "Not saved: this job file has no readable job text, so there is no real verdict to save. Capture the full posting first."
    );
    process.exit(1);
  }
  const db = openDb({ repoRoot: root });
  try {
    saved = persistEvaluationVerdict({
      repoRoot: root,
      db,
      explicitId: explicitAppId,
      job,
      result,
      jobPath,
    });
  } catch (error) {
    if (!(error instanceof EvaluationWriteError)) throw error;
    console.error(`Not saved: ${error.message}`);
    process.exit(1);
  }
}

if (json) {
  const out = { job: { frontmatter: job.frontmatter }, result };
  if (saved) out.saved = { saved: true, id: saved.id, gate: saved.gate, status: saved.status };
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(renderGateBlock(result));
  if (result.reasons && result.reasons.length > 1) {
    console.log("");
    console.log("Notes:");
    for (const r of result.reasons) console.log(`- ${r}`);
  }
  if (saved) {
    console.log("");
    console.log(`Saved on ${saved.id} (gate: ${saved.gate}).`);
  }
}

// CUT or REVIEW are non-zero so callers/CI can branch on the gate.
process.exit(result.gate === "KEEP" ? 0 : result.gate === "REVIEW" ? 2 : 1);

// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`careerrat evaluate: run the body-read gate on a saved job

Usage:
  careerrat evaluate <path-to-job.md>     Emit GATE / FIT / COMP / ACTION
  careerrat evaluate <path> --json        Full machine-readable verdict
  careerrat evaluate <path> --write       Also save the verdict on the tracked job
  careerrat evaluate <path> --write --app <id>
                                          Save on a specific application id
  careerrat evaluate --help

--write needs a database workspace. It finds the job's application from the file's
frontmatter (appId, or company and role), saves nothing if the job has no readable
text, and prints the job id and gate it saved.

Exit codes: 0 KEEP, 2 REVIEW, 1 CUT (or error), 64 unknown option.
Inputs: candidate/targeting.yml, candidate/profile.yml, candidate/honesty.yml.`);
}
