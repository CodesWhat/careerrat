#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
// careerrat gate — the safe write-back helper for gates-as-data.
//
// Persists a gate the user stated mid-flow ("never Palantir", "$190K floor",
// "don't claim Kubernetes") to the canonical candidate config, schema-validated
// and atomically, preserving the file's comments. Skills call this instead of
// hand-editing YAML (see AGENTS.md → Write-back rule).
//
// Usage:
//   careerrat gate <type> <value>            Propose the change (dry run)
//   careerrat gate <type> <value> --write    Commit it
//   careerrat gate exclude-company Palantir --write --confirm
//   careerrat gate --list                    Show gate types
//   careerrat gate --help
//
// Default is a DRY RUN: it prints the target file, the exact line that would
// change, schema validity, and the friction level — and writes nothing. Pass
// --write to commit. A confirm-first gate (broad exclusion, comp-floor change)
// additionally requires --confirm, which the skill passes only after the user
// agrees. A change that would make the file schema-invalid is always refused.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateConfigGet, candidateConfigPatch } from "../core/db/verbs.mjs";
import { displayPath, userPath } from "../core/paths/workspace.mjs";
import { CANDIDATE_FILES } from "../core/profile/candidate-setup.mjs";
import { candidateConfigSource } from "../core/profile/config-store.mjs";
import {
  atomicWriteFile,
  coerceValue,
  computeGateEdit,
  formatErrors,
  GATE_ROUTES,
} from "../core/profile/gate-writer.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function parseArgs(argv) {
  const opts = { positional: [], write: false, confirm: false, json: false, root: ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") opts.write = true;
    else if (a === "--confirm") opts.confirm = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--list") opts.list = true;
    else if (a === "--help" || a === "-h") opts.help = true;
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
if (opts.list) {
  printList(opts.json);
  process.exit(0);
}

const [type, ...rest] = opts.positional;
const value = rest.join(" ").trim();

if (!type || !value) {
  fail(
    "Usage: gate <type> <value> [--write] [--confirm]. See --list for types, --help for details."
  );
}

const route = GATE_ROUTES[type];
if (!route) {
  fail(
    `unknown gate type "${type}". Run --list to see the ${Object.keys(GATE_ROUTES).length} types.`
  );
}

const pathCtx = { repoRoot: opts.root };
if (candidateConfigSource(pathCtx) === "db") {
  handleDbGate(route);
}

const fileEntry = (() => {
  const entry = CANDIDATE_FILES.find((f) => f.name === route.file);
  if (!entry) fail(`no candidate-file mapping for "${route.file}"`);
  return entry;
})();

const candidatePath = userPath(pathCtx, fileEntry.candidatePath);
const candidateDisplay = displayPath(pathCtx, fileEntry.candidatePath);
if (!existsSync(candidatePath)) {
  fail(
    `${candidateDisplay} not found. Run \`careerrat ingest\` to create your candidate config first.`
  );
}
const currentText = readFileSync(candidatePath, "utf8");
const schema =
  fileEntry.schemaPath && existsSync(join(opts.root, fileEntry.schemaPath))
    ? JSON.parse(readFileSync(join(opts.root, fileEntry.schemaPath), "utf8"))
    : null;

let plan;
try {
  plan = computeGateEdit({ type, value, currentText, schema });
} catch (err) {
  fail(err.message);
}

if (!plan.ok) fail(plan.error);

// Build a human diff line.
const diff =
  plan.op === "append"
    ? `  + ${plan.path}: ${plan.value}`
    : `  ~ ${plan.path}: ${plan.previous || "(empty)"} → ${plan.value}`;

const result = {
  type,
  file: candidateDisplay,
  path: plan.path,
  op: plan.op,
  value: plan.value,
  friction: plan.friction,
  changed: plan.changed,
  valid: plan.valid,
  written: false,
};

// No-op: already present / identical.
if (!plan.changed) {
  if (opts.json) console.log(JSON.stringify({ ...result, note: "already present" }, null, 2));
  else console.log(`No change: ${plan.path} already has "${plan.value}" in ${candidateDisplay}.`);
  process.exit(0);
}

// Never write a file the change would invalidate.
if (!plan.valid) {
  if (opts.json) {
    console.log(
      JSON.stringify({ ...result, error: "would invalidate schema", errors: plan.errors }, null, 2)
    );
  } else {
    console.error(
      `Refusing: this change would make ${candidateDisplay} invalid against its schema:`
    );
    console.error(formatErrors(plan.errors));
  }
  process.exit(1);
}

// Confirm-first gates require an explicit --confirm alongside --write.
const needsConfirm = plan.friction === "confirm";

if (!opts.write) {
  if (opts.json) {
    console.log(
      JSON.stringify({ ...result, dryRun: true, requiresConfirm: needsConfirm }, null, 2)
    );
  } else {
    console.log(`Proposed write to ${candidateDisplay} (${plan.label || plan.path}):`);
    console.log(diff);
    console.log(
      `Friction: ${plan.friction === "confirm" ? "confirm-first (get the user's yes, then --write --confirm)" : "write-and-report"}`
    );
    console.log("Dry run - pass --write to commit.");
  }
  process.exit(0);
}

if (needsConfirm && !opts.confirm) {
  if (opts.json) {
    console.log(
      JSON.stringify({ ...result, error: "confirm-first gate requires --confirm" }, null, 2)
    );
  } else {
    console.error(
      `This is a confirm-first gate (${plan.path}). Confirm with the user, then re-run with --write --confirm:`
    );
    console.error(diff);
  }
  process.exit(2);
}

atomicWriteFile(candidatePath, plan.nextText);
result.written = true;

if (opts.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const shown =
    plan.op === "append" ? `${plan.path} += ${plan.value}` : `${plan.path}: ${plan.value}`;
  console.log(`Written to ${candidateDisplay}: ${shown}`);
}
process.exit(0);

// ---------------------------------------------------------------------------

function handleDbGate(route) {
  let plan;
  try {
    plan = computeDbGateEdit({ route, value, pathCtx });
  } catch (err) {
    fail(err.message);
  }
  const result = {
    type,
    file: `sqlite:${route.file}`,
    path: route.path,
    op: route.op,
    value: plan.value,
    friction: route.friction,
    changed: plan.changed,
    valid: true,
    written: false,
  };

  if (!plan.changed) {
    if (opts.json) console.log(JSON.stringify({ ...result, note: "already present" }, null, 2));
    else console.log(`No change - ${route.path} already has "${plan.value}" in SQLite.`);
    process.exit(0);
  }

  const diff =
    route.op === "append"
      ? `  + ${route.path}: ${plan.value}`
      : `  ~ ${route.path}: ${plan.previous ?? "(empty)"} → ${plan.value}`;
  const needsConfirm = route.friction === "confirm";

  if (!opts.write) {
    if (opts.json) {
      console.log(
        JSON.stringify({ ...result, dryRun: true, requiresConfirm: needsConfirm }, null, 2)
      );
    } else {
      console.log(`Proposed write to SQLite candidate config (${route.label || route.path}):`);
      console.log(diff);
      console.log(
        `Friction: ${needsConfirm ? "confirm-first (get the user's yes, then --write --confirm)" : "write-and-report"}`
      );
      console.log("Dry run - pass --write to commit.");
    }
    process.exit(0);
  }

  if (needsConfirm && !opts.confirm) {
    if (opts.json) {
      console.log(
        JSON.stringify({ ...result, error: "confirm-first gate requires --confirm" }, null, 2)
      );
    } else {
      console.error(
        `This is a confirm-first gate (${route.path}). Confirm with the user, then re-run with --write --confirm:`
      );
      console.error(diff);
    }
    process.exit(2);
  }

  try {
    candidateConfigPatch({ ...pathCtx, name: route.file, patch: plan.patch });
  } catch (err) {
    if (opts.json) {
      console.log(
        JSON.stringify({ ...result, error: err.message, errors: err.errors || [] }, null, 2)
      );
    } else {
      console.error(`Refusing: this change would make sqlite:${route.file} invalid:`);
      if (err.errors) console.error(formatErrors(err.errors));
      else console.error(err.message);
    }
    process.exit(1);
  }
  result.written = true;

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const shown =
      route.op === "append" ? `${route.path} += ${plan.value}` : `${route.path}: ${plan.value}`;
    console.log(`Written to SQLite candidate config: ${shown}`);
  }
  process.exit(0);
}

function computeDbGateEdit({ route, value, pathCtx }) {
  const coerced = coerceValue(route, value);
  const config = candidateConfigGet(pathCtx);
  const doc = route.file === "form-defaults" ? config["form-defaults"] : config[route.file];
  const parts = route.path.split(".");
  const previous = getPath(doc, parts);

  if (route.op === "append") {
    const current = Array.isArray(previous) ? previous : [];
    const changed = !current.some((item) => String(item) === String(coerced));
    const next = changed ? [...current, coerced] : current;
    return {
      value: coerced,
      previous,
      changed,
      patch: buildPatch(parts, next),
    };
  }

  const changed = previous !== coerced;
  return {
    value: coerced,
    previous,
    changed,
    patch: buildPatch(parts, coerced),
  };
}

function getPath(obj, parts) {
  let cursor = obj;
  for (const part of parts) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function buildPatch(parts, value) {
  let out = value;
  for (let i = parts.length - 1; i >= 0; i--) {
    out = { [parts[i]]: out };
  }
  return out;
}

function fail(msg) {
  if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error(`gate: ${msg}`);
  process.exit(1);
}

function printList(asJson) {
  if (asJson) {
    console.log(JSON.stringify(GATE_ROUTES, null, 2));
    return;
  }
  console.log("Gate types (type → file#path · friction):");
  for (const [type, r] of Object.entries(GATE_ROUTES)) {
    console.log(
      `  ${type.padEnd(18)} ${r.file}#${r.path}  · ${r.friction === "confirm" ? "confirm-first" : "write-and-report"}`
    );
  }
}

function printHelp() {
  console.log(`careerrat gate: safe, schema-validated gate write-back

Usage:
  node src/cli/gate.mjs <type> <value>             Propose (dry run; writes nothing)
  node src/cli/gate.mjs <type> <value> --write     Commit a write-and-report gate
  node src/cli/gate.mjs <type> <value> --write --confirm   Commit a confirm-first gate
  node src/cli/gate.mjs --list [--json]            List gate types
  node src/cli/gate.mjs --help

Options:
  --write     Commit the change (default: dry run)
  --confirm   Required to --write a confirm-first gate (after the user agrees)
  --json      Machine-readable output
  --root DIR  Repo root (default: the careerrat install)

The change is patched into the file's TEXT (comments preserved), validated against
the file's schema, and committed atomically. A change that would invalidate the
file is refused. Idempotent: appending a value already present is a no-op.`);
}
