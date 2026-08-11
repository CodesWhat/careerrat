#!/usr/bin/env node
// Print or update the current agent handoff. This is intentionally a thin view
// over doctor --json so status text, dashboard state, and manual mode agree.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatAgentGuidanceSummary,
  recordDiscoverySkip,
  SKIPPABLE_DISCOVERY_STEPS,
} from "../core/agent-guidance.mjs";

const root = join(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);
const opts = parseArgs(args);

if (opts.help) {
  printHelp();
  process.exit(0);
}

let skipResult = null;
if (opts.skip) {
  if (!opts.write) {
    console.log(
      `Dry run: would mark ${opts.skip} as skipped for discovery guidance. Re-run with --write to persist.`
    );
  } else {
    skipResult = recordDiscoverySkip({ root, step: opts.skip });
    if (!skipResult.ok) {
      console.error(skipResult.error);
      console.error(`Allowed: ${skipResult.allowed.join(", ")}`);
      process.exit(1);
    }
  }
}

const doctor = readDoctorJson();
if (!doctor.ok) {
  console.error(doctor.error);
  process.exit(1);
}

if (opts.json) {
  console.log(
    JSON.stringify(
      {
        skipped: skipResult,
        agentGuidance: doctor.data.agentGuidance,
      },
      null,
      2
    )
  );
  process.exit(0);
}

if (skipResult) {
  console.log(
    skipResult.added
      ? `Skipped ${opts.skip} for discovery guidance.`
      : `${opts.skip} was already skipped for discovery guidance.`
  );
}

for (const line of formatAgentGuidanceSummary(doctor.data.agentGuidance)) {
  console.log(line);
}

function parseArgs(input) {
  const out = { json: false, skip: null, write: false, help: false };
  for (let i = 0; i < input.length; i++) {
    const arg = input[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--write") out.write = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--skip") out.skip = input[++i] || "";
    else if (arg.startsWith("--skip=")) out.skip = arg.slice("--skip=".length);
    else {
      console.error(`Unknown option: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }
  if (out.skip && !SKIPPABLE_DISCOVERY_STEPS.includes(out.skip)) {
    console.error(`Unknown skippable discovery step: ${out.skip}`);
    console.error(`Allowed: ${SKIPPABLE_DISCOVERY_STEPS.join(", ")}`);
    process.exit(1);
  }
  return out;
}

function readDoctorJson() {
  const result = spawnSync(process.execPath, [join(root, "src/cli/doctor.mjs"), "--json"], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
  if (result.error) return { ok: false, error: result.error.message };
  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch {
    const details = result.stderr || result.stdout || `doctor exited ${result.status}`;
    return { ok: false, error: `Could not read doctor guidance: ${details.trim()}` };
  }
}

function printHelp() {
  console.log(`careerrat next — show the next agent task

Usage:
  careerrat next
  careerrat next --skip research-boards --write
  careerrat next --skip discover-companies --write

Options:
  --json                 Print machine-readable guidance
  --skip <step>          Mark an optional discovery step as intentionally skipped
  --write                Persist the skip marker to workspace/setup-state.json
  --help, -h             Show this help`);
}
