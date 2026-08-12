#!/usr/bin/env node
// careerrat modes - safe read/write helper for optional mode switches.
//
// Defaults are safe when candidate/modes.yml is absent:
//   usage_mode: standard
//   application_mode: balanced

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { displayPath, userPath } from "../core/paths/workspace.mjs";
import { atomicWriteFile } from "../core/profile/gate-writer.mjs";
import {
  computeAllows,
  computeModeEdit,
  formatErrors,
  loadModes,
  loadModesSchema,
  MODE_ROUTES,
  MODES_REL_PATH,
  MODES_TEMPLATE_PATH,
} from "../core/profile/modes.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function parseArgs(argv) {
  const opts = { positional: [], write: false, json: false, root: ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") opts.write = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--root") opts.root = argv[++i];
    else if (a === "--help" || a === "-h") opts.help = true;
    else opts.positional.push(a);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const pathCtx = { repoRoot: opts.root };
const modesDisplay = () => displayPath(pathCtx, MODES_REL_PATH);
const cmd = opts.positional[0] || "status";

if (opts.help) {
  printHelp();
  process.exit(0);
}

if (cmd === "status") {
  const modes = loadModes({ root: opts.root });
  if (opts.json) {
    console.log(JSON.stringify({ ok: modes.valid, ...modes }, null, 2));
  } else if (!modes.valid) {
    console.error(`${modes.path} is invalid:`);
    console.error(formatErrors(modes.errors));
    process.exit(1);
  } else {
    const source = modes.exists ? modes.path : `defaults (no ${modesDisplay()})`;
    console.log(`Modes (${source}):`);
    console.log(`  usage_mode: ${modes.data.usage_mode}`);
    console.log(`  application_mode: ${modes.data.application_mode}`);
  }
  process.exit(modes.valid ? 0 : 1);
}

if (cmd === "allows") {
  const operation = opts.positional[1];
  if (!operation) fail("Usage: modes allows <operation>");
  const modes = loadModes({ root: opts.root });
  if (!modes.valid) {
    if (opts.json) {
      console.log(
        JSON.stringify({ ok: false, error: "invalid modes config", errors: modes.errors }, null, 2)
      );
    } else {
      console.error(`${modes.path} is invalid:`);
      console.error(formatErrors(modes.errors));
    }
    process.exit(1);
  }
  const verdict = computeAllows(operation, modes.data);
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, ...verdict }, null, 2));
  } else {
    console.log(`${operation}: ${verdict.decision} (${verdict.reason})`);
  }
  process.exit(0);
}

if (cmd !== "set") {
  fail(`unknown command "${cmd}". Use status or set.`);
}

const type = opts.positional[1];
const value = opts.positional[2];
if (!type || !value) {
  fail("Usage: modes set <usage|application> <value> [--write]");
}
if (!MODE_ROUTES[type]) {
  fail(`unknown mode type "${type}". Use usage or application.`);
}

const candidatePath = userPath(pathCtx, MODES_REL_PATH);
const currentText = existsSync(candidatePath)
  ? readFileSync(candidatePath, "utf8")
  : readFileSync(join(opts.root, MODES_TEMPLATE_PATH), "utf8");
const schema = loadModesSchema({ root: opts.root });
const plan = computeModeEdit({ type, value, currentText, schema });

if (!plan.ok) fail(plan.error);
if (!plan.valid) {
  if (opts.json) {
    console.log(
      JSON.stringify({ ok: false, error: "would invalidate schema", errors: plan.errors }, null, 2)
    );
  } else {
    console.error(`Refusing: this change would make ${modesDisplay()} invalid:`);
    console.error(formatErrors(plan.errors));
  }
  process.exit(1);
}

const result = {
  ok: true,
  file: modesDisplay(),
  path: plan.path,
  value: plan.value,
  changed: plan.changed,
  written: false,
};

if (!plan.changed) {
  if (opts.json) console.log(JSON.stringify({ ...result, note: "already set" }, null, 2));
  else console.log(`No change - ${plan.path} is already "${plan.value}".`);
  process.exit(0);
}

if (!opts.write) {
  if (opts.json) {
    console.log(JSON.stringify({ ...result, dryRun: true }, null, 2));
  } else {
    console.log(`Proposed write to ${modesDisplay()}:`);
    console.log(`  ~ ${plan.path}: ${plan.previous || "(empty)"} -> ${plan.value}`);
    if (!existsSync(candidatePath)) {
      console.log(
        `  note: ${modesDisplay()} does not exist yet; --write will create it from the template first.`
      );
    }
    console.log("Dry run - pass --write to commit.");
  }
  process.exit(0);
}

mkdirSync(dirname(candidatePath), { recursive: true });
atomicWriteFile(candidatePath, plan.nextText);
result.written = true;

if (opts.json) console.log(JSON.stringify(result, null, 2));
else console.log(`Written to ${modesDisplay()}: ${plan.path}: ${plan.value}`);

// ---------------------------------------------------------------------------

function fail(message) {
  if (opts.json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(`modes: ${message}`);
  process.exit(1);
}

function printHelp() {
  console.log(`careerrat modes - safe mode-switcher read/write helper

Usage:
  careerrat modes status [--json]
  careerrat modes allows <operation> [--json]
  careerrat modes set usage <lean|standard|full> [--write]
  careerrat modes set application <selective|balanced|high-volume> [--write]

Options:
  --write     Commit the change (default: dry run)
  --json      Machine-readable output
  --root DIR  Repo root (default: the careerrat install)

Absent candidate/modes.yml means usage_mode=standard and application_mode=balanced.
Writes are schema-validated and atomic. Mode switches never relax honesty, privacy,
consent, comp, or application-limit gates.`);
}
