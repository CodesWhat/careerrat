#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
// careerrat automation — opt-in browser-automation config (status + safe write-back).
//
// Authenticated browser automation is OPT-IN and DEFAULTS OFF. This CLI shows the
// capability/platform/consent matrix and toggles individual switches, never running
// a browser itself. In DB workspaces it writes candidate_automation; in legacy
// workspaces it patches candidate/automation.yml.
//
// Usage:
//   node src/cli/automation.mjs status [--json]
//   node src/cli/automation.mjs consent <platform>            (dry run)
//   node src/cli/automation.mjs consent <platform> --write
//   node src/cli/automation.mjs revoke  <platform> --write
//   node src/cli/automation.mjs enable  <capability> [platform] --write
//   node src/cli/automation.mjs disable <capability> [platform] --write
//   node src/cli/automation.mjs --list
//   node src/cli/automation.mjs --help
//
// Default is a DRY RUN: it prints the target line + the resulting "is it live?"
// verdict and writes nothing. Pass --write to commit. The first write scaffolds
// candidate/automation.yml from the template. Edits are schema-validated and
// comment-preserving in legacy mode; an invalid change is refused.
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTOMATION_FILE,
  AUTOMATION_SCHEMA,
  AUTOMATION_TEMPLATE,
  atomicWriteFile,
  automationStatus,
  CAPABILITIES,
  CAPABILITY_KEYS,
  defaultAutomation,
  ensureAutomationFile,
  isCapability,
  isPlatform,
  loadAutomation,
  mayRun,
  PLATFORMS,
  planAutomationEdit,
  planSessionEdit,
  resolveEditPath,
} from "../core/automation/consent.mjs";
import { PROVIDER_PREFERENCE, PROVIDERS, resolveSession } from "../core/automation/session.mjs";
import { candidateConfigPatch } from "../core/db/verbs.mjs";
import { displayPath, userPath } from "../core/paths/workspace.mjs";
import { candidateConfigSource } from "../core/profile/config-store.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function parseArgs(argv) {
  const opts = { positional: [], write: false, json: false, root: ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") opts.write = true;
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

const [verb, ...rest] = opts.positional;

if (!verb || verb === "status") {
  printStatus(opts.json);
  process.exit(0);
}

if (verb === "session") {
  handleSession(rest[0]);
  process.exit(0); // handleSession always exits; this is a belt-and-suspenders guard
}

const WRITE_VERBS = {
  consent: { kind: "consent", value: true },
  revoke: { kind: "consent", value: false },
  enable: { kind: "capability-or-platform", value: true },
  disable: { kind: "capability-or-platform", value: false },
};

const spec = WRITE_VERBS[verb];
if (!spec) {
  fail(
    `unknown command "${verb}". Try: status | enable | disable | consent | revoke (see --help).`
  );
}

// Resolve the edit target from the verb + positionals.
let kind, capability, platform;
if (spec.kind === "consent") {
  kind = "consent";
  platform = rest[0];
  if (!platform) fail(`Usage: ${verb} <platform>. Platforms: ${PLATFORMS.join(", ")}.`);
  if (!isPlatform(platform))
    fail(`unknown platform "${platform}". Known: ${PLATFORMS.join(", ")}.`);
} else {
  capability = rest[0];
  platform = rest[1] || null;
  if (!capability)
    fail(`Usage: ${verb} <capability> [platform]. Capabilities: ${CAPABILITY_KEYS.join(", ")}.`);
  if (!isCapability(capability))
    fail(`unknown capability "${capability}". Known: ${CAPABILITY_KEYS.join(", ")}.`);
  if (platform && !CAPABILITIES[capability].platforms.includes(platform)) {
    fail(
      `${capability} does not apply to "${platform}". It applies to: ${CAPABILITIES[capability].platforms.join(", ")}.`
    );
  }
  kind = platform ? "platform" : "capability";
}

const pathCtx = { repoRoot: opts.root };
if (candidateConfigSource(pathCtx) === "db") {
  handleDbAutomationEdit({ command: verb, kind, capability, platform, value: spec.value });
}

const candidatePath = userPath(pathCtx, AUTOMATION_FILE);
const automationDisplay = displayPath(pathCtx, AUTOMATION_FILE);
const templatePath = join(opts.root, AUTOMATION_TEMPLATE);
const schemaPath = join(opts.root, AUTOMATION_SCHEMA);
const schema = existsSync(schemaPath) ? JSON.parse(readFileSync(schemaPath, "utf8")) : null;

const fileExists = existsSync(candidatePath);
const baseText = readFileSync(fileExists ? candidatePath : templatePath, "utf8");

let plan;
try {
  plan = planAutomationEdit({
    kind,
    capability,
    platform,
    value: spec.value,
    currentText: baseText,
    schema,
  });
} catch (err) {
  fail(err.message);
}
if (!plan.ok) fail(plan.error);

const label = (() => {
  try {
    return resolveEditPath({ kind, capability, platform }).label;
  } catch {
    return plan.path;
  }
})();

const result = {
  command: verb,
  file: automationDisplay,
  path: plan.path,
  label,
  value: plan.value,
  previous: plan.previous,
  changed: plan.changed,
  valid: plan.valid,
  willCreate: !fileExists,
  written: false,
};

// No-op: already at the target value.
if (!plan.changed) {
  if (opts.json) console.log(JSON.stringify({ ...result, note: "already set" }, null, 2));
  else console.log(`No change — ${plan.path} is already ${plan.value} in ${automationDisplay}.`);
  process.exit(0);
}

// Never write a change the schema would reject.
if (!plan.valid) {
  if (opts.json)
    console.log(
      JSON.stringify({ ...result, error: "would invalidate schema", errors: plan.errors }, null, 2)
    );
  else {
    console.error(
      `Refusing: this change would make ${automationDisplay} invalid against its schema:`
    );
    for (const e of plan.errors) console.error(`  ${e.path || "(root)"}: ${e.message}`);
  }
  process.exit(1);
}

const diff = `  ~ ${plan.path}: ${plan.previous} → ${plan.value}`;

// The post-edit "is it live?" verdict (the three-part AND), so the user sees what
// else is still required for this to actually run. Only meaningful for a
// capability+platform edit (a bare consent or global toggle has no single pair).
const verdict = kind === "platform" ? mayRun({ capability, platform, data: nextData() }) : null;

if (!opts.write) {
  if (opts.json) {
    console.log(JSON.stringify({ ...result, dryRun: true, verdict }, null, 2));
  } else {
    if (!fileExists)
      console.log(`(first write will create ${automationDisplay} from the template)`);
    console.log(`Proposed change to ${automationDisplay} (${label}):`);
    console.log(diff);
    printVerdict(verdict, capability, platform);
    console.log("Dry run - pass --write to commit.");
  }
  process.exit(0);
}

// Commit: scaffold from template if absent, then patch the real file atomically.
const created = ensureAutomationFile({ root: opts.root }).created;
const actualText = readFileSync(candidatePath, "utf8");
let writePlan = plan;
if (actualText !== baseText) {
  writePlan = planAutomationEdit({
    kind,
    capability,
    platform,
    value: spec.value,
    currentText: actualText,
    schema,
  });
  if (!writePlan.ok || !writePlan.valid)
    fail(writePlan.error || "post-scaffold edit became invalid");
}
atomicWriteFile(candidatePath, writePlan.nextText);
result.written = true;
result.created = created;

if (opts.json) {
  console.log(JSON.stringify({ ...result, verdict }, null, 2));
} else {
  if (created) console.log(`Created ${automationDisplay} from the template.`);
  console.log(`Written to ${automationDisplay}: ${plan.path} = ${plan.value}`);
  printVerdict(verdict, capability, platform);
}
process.exit(0);

// ---------------------------------------------------------------------------

// The config as it WOULD be after this edit (for the live-verdict preview).
function nextData() {
  const data = loadAutomation({ root: opts.root }).data;
  if (kind === "consent") {
    data.consent = data.consent || {};
    data.consent[platform] = spec.value;
  } else if (kind === "capability") {
    data.capabilities = data.capabilities || {};
    data.capabilities[capability] = data.capabilities[capability] || {};
    data.capabilities[capability].enabled = spec.value;
  } else if (kind === "platform") {
    data.capabilities = data.capabilities || {};
    data.capabilities[capability] = data.capabilities[capability] || {};
    data.capabilities[capability].platforms = data.capabilities[capability].platforms || {};
    data.capabilities[capability].platforms[platform] = spec.value;
  }
  return data;
}

// `session <auto|extension|orca|playwright>` — change WHICH provider drives the session
// browser. Distinct from the capability/consent toggles: it's a string, not a
// boolean, and it never affects mayRun() (provider is HOW a session runs, not
// WHETHER a capability is allowed). Same safety as the toggles: dry-run by
// default, schema-validated, comment-preserving, atomic; first --write scaffolds.
function handleSession(provider) {
  if (!provider) {
    fail(
      `Usage: session <provider>. Providers: ${PROVIDER_PREFERENCE.join(", ")} (auto recommended).`
    );
  }
  if (!PROVIDERS[provider]) {
    fail(`unknown session provider "${provider}". Known: ${PROVIDER_PREFERENCE.join(", ")}.`);
  }

  const pathCtx = { repoRoot: opts.root };
  if (candidateConfigSource(pathCtx) === "db") {
    handleDbSession(provider);
  }

  const candidatePath = userPath(pathCtx, AUTOMATION_FILE);
  const automationDisplay = displayPath(pathCtx, AUTOMATION_FILE);
  const templatePath = join(opts.root, AUTOMATION_TEMPLATE);
  const schemaPath = join(opts.root, AUTOMATION_SCHEMA);
  const schema = existsSync(schemaPath) ? JSON.parse(readFileSync(schemaPath, "utf8")) : null;
  const fileExists = existsSync(candidatePath);
  const baseText = readFileSync(fileExists ? candidatePath : templatePath, "utf8");

  let plan;
  try {
    plan = planSessionEdit({ provider, currentText: baseText, schema });
  } catch (err) {
    fail(err.message);
  }
  if (!plan.ok) fail(plan.error);

  const preferredNote = PROVIDERS[provider].preferred
    ? " (preferred)"
    : " (fallback — extension is preferred)";

  const result = {
    command: "session",
    file: automationDisplay,
    path: plan.path,
    label: plan.label,
    value: plan.value,
    previous: plan.previous,
    changed: plan.changed,
    valid: plan.valid,
    willCreate: !fileExists,
    written: false,
  };

  if (!plan.changed) {
    if (opts.json) console.log(JSON.stringify({ ...result, note: "already set" }, null, 2));
    else
      console.log(`No change — session provider is already ${plan.value} in ${automationDisplay}.`);
    process.exit(0);
  }

  if (!plan.valid) {
    if (opts.json)
      console.log(
        JSON.stringify(
          { ...result, error: "would invalidate schema", errors: plan.errors },
          null,
          2
        )
      );
    else {
      console.error(
        `Refusing: this change would make ${automationDisplay} invalid against its schema:`
      );
      for (const e of plan.errors) console.error(`  ${e.path || "(root)"}: ${e.message}`);
    }
    process.exit(1);
  }

  const diff = `  ~ ${plan.path}: ${plan.previous} → ${plan.value}`;

  if (!opts.write) {
    if (opts.json) {
      console.log(JSON.stringify({ ...result, dryRun: true }, null, 2));
    } else {
      if (!fileExists)
        console.log(`(first write will create ${automationDisplay} from the template)`);
      console.log(`Proposed change to ${automationDisplay} (${plan.label}):`);
      console.log(diff);
      console.log(`  → session browser will be: ${provider}${preferredNote}`);
      console.log("Dry run - pass --write to commit.");
    }
    process.exit(0);
  }

  const created = ensureAutomationFile({ root: opts.root }).created;
  const actualText = readFileSync(candidatePath, "utf8");
  let writePlan = plan;
  if (actualText !== baseText) {
    writePlan = planSessionEdit({ provider, currentText: actualText, schema });
    if (!writePlan.ok || !writePlan.valid)
      fail(writePlan.error || "post-scaffold edit became invalid");
  }
  atomicWriteFile(candidatePath, writePlan.nextText);
  result.written = true;
  result.created = created;

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (created) console.log(`Created ${automationDisplay} from the template.`);
    console.log(`Written to ${automationDisplay}: ${plan.path} = ${plan.value}`);
    console.log(`Session browser is now: ${provider}${preferredNote}`);
  }
  process.exit(0);
}

function handleDbAutomationEdit({ command, kind, capability, platform, value }) {
  const loaded = loadAutomation({ root: opts.root });
  const { parts, label } = resolveEditPath({ kind, capability, platform });
  const currentData = mergeAutomationDefaults(loaded.data);
  const previous = getPath(currentData, parts);
  const nextData = structuredClone(currentData);
  setPath(nextData, parts, value === true);
  const changed = previous !== value;
  const result = {
    command,
    file: "sqlite:automation",
    path: parts.join("."),
    label,
    value: value === true,
    previous,
    changed,
    valid: true,
    willCreate: false,
    written: false,
  };
  const verdict = kind === "platform" ? mayRun({ capability, platform, data: nextData }) : null;

  if (!changed) {
    if (opts.json) console.log(JSON.stringify({ ...result, note: "already set" }, null, 2));
    else console.log(`No change - ${result.path} is already ${result.value} in SQLite.`);
    process.exit(0);
  }

  const diff = `  ~ ${result.path}: ${previous} → ${result.value}`;
  if (!opts.write) {
    if (opts.json) {
      console.log(JSON.stringify({ ...result, dryRun: true, verdict }, null, 2));
    } else {
      console.log(`Proposed change to SQLite automation config (${label}):`);
      console.log(diff);
      printVerdict(verdict, capability, platform);
      console.log("Dry run - pass --write to commit.");
    }
    process.exit(0);
  }

  try {
    candidateConfigPatch({ ...pathCtx, name: "automation", patch: nextData });
  } catch (err) {
    if (opts.json) {
      console.log(
        JSON.stringify({ ...result, error: err.message, errors: err.errors || [] }, null, 2)
      );
    } else {
      console.error("Refusing: this change would make sqlite:automation invalid:");
      if (err.errors)
        for (const e of err.errors) console.error(`  ${e.path || "(root)"}: ${e.message}`);
      else console.error(err.message);
    }
    process.exit(1);
  }

  result.written = true;
  if (opts.json) {
    console.log(JSON.stringify({ ...result, verdict }, null, 2));
  } else {
    console.log(`Written to SQLite automation config: ${result.path} = ${result.value}`);
    printVerdict(verdict, capability, platform);
  }
  process.exit(0);
}

function handleDbSession(provider) {
  const loaded = loadAutomation({ root: opts.root });
  const currentData = mergeAutomationDefaults(loaded.data);
  const { parts, label } = resolveEditPath({ kind: "session" });
  const previous = getPath(currentData, parts);
  const nextData = structuredClone(currentData);
  setPath(nextData, parts, provider);
  const changed = previous !== provider;
  const preferredNote = PROVIDERS[provider].preferred
    ? " (preferred)"
    : " (fallback - extension is preferred)";
  const result = {
    command: "session",
    file: "sqlite:automation",
    path: parts.join("."),
    label,
    value: provider,
    previous,
    changed,
    valid: true,
    willCreate: false,
    written: false,
  };

  if (!changed) {
    if (opts.json) console.log(JSON.stringify({ ...result, note: "already set" }, null, 2));
    else console.log(`No change - session provider is already ${provider} in SQLite.`);
    process.exit(0);
  }

  const diff = `  ~ ${result.path}: ${previous} → ${provider}`;
  if (!opts.write) {
    if (opts.json) {
      console.log(JSON.stringify({ ...result, dryRun: true }, null, 2));
    } else {
      console.log(`Proposed change to SQLite automation config (${label}):`);
      console.log(diff);
      console.log(`  → session browser will be: ${provider}${preferredNote}`);
      console.log("Dry run - pass --write to commit.");
    }
    process.exit(0);
  }

  try {
    candidateConfigPatch({ ...pathCtx, name: "automation", patch: nextData });
  } catch (err) {
    if (opts.json) {
      console.log(
        JSON.stringify({ ...result, error: err.message, errors: err.errors || [] }, null, 2)
      );
    } else {
      console.error("Refusing: this change would make sqlite:automation invalid:");
      if (err.errors)
        for (const e of err.errors) console.error(`  ${e.path || "(root)"}: ${e.message}`);
      else console.error(err.message);
    }
    process.exit(1);
  }

  result.written = true;
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Written to SQLite automation config: ${result.path} = ${provider}`);
    console.log(`Session browser is now: ${provider}${preferredNote}`);
  }
  process.exit(0);
}

function mergeAutomationDefaults(data) {
  return deepMerge(defaultAutomation(), data && typeof data === "object" ? data : {});
}

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (!patch || typeof patch !== "object") return patch;
  const out = { ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}) };
  for (const [key, value] of Object.entries(patch)) {
    out[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? deepMerge(out[key], value)
        : Array.isArray(value)
          ? value.slice()
          : value;
  }
  return out;
}

function getPath(obj, parts) {
  let cursor = obj;
  for (const part of parts) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function setPath(obj, parts, value) {
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cursor[parts[i]] = cursor[parts[i]] || {};
    cursor = cursor[parts[i]];
  }
  cursor[parts.at(-1)] = value;
}

function printVerdict(v, cap, plat) {
  if (!v) return;
  if (v.allowed) {
    console.log(`  ✓ ${cap} on ${plat} is now LIVE (global + platform + consent all on).`);
  } else {
    console.log(`  ◦ ${cap} on ${plat} still won't run — remaining:`);
    for (const r of v.reasons) console.log(`      - ${r}`);
  }
}

function fail(msg) {
  if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error(`automation: ${msg}`);
  process.exit(1);
}

function printStatus(asJson) {
  const status = automationStatus({ root: opts.root });
  const loaded = loadAutomation({ root: opts.root });
  const session = resolveSession({ data: loaded.data });
  if (asJson) {
    console.log(JSON.stringify({ ...status, session }, null, 2));
    return;
  }
  console.log("careerrat automation");
  console.log("====================");
  console.log("");
  if (!status.exists) {
    console.log(`Not configured — every capability is OFF (opt-in default).`);
    console.log(`No ${loaded.path} yet; the first \`--write\` creates it from the template.`);
    console.log("");
  } else if (!status.valid) {
    console.log(`${loaded.path} is INVALID against its schema:`);
    for (const e of status.errors) console.log(`  ${e.path || "(root)"}: ${e.message}`);
    console.log("");
  }
  console.log(
    `Setup mode: ${status.mode} (${status.mode === "basic" ? "all external capabilities hard-off" : "individual opt-ins below"})`
  );
  console.log(`Live capability×platform pairs: ${status.liveCount}`);
  console.log("");
  for (const cap of status.capabilities) {
    const global = cap.enabled ? "on" : "off";
    console.log(`${cap.capability}  [phase ${cap.phase} · global ${global}] — ${cap.summary}`);
    for (const p of cap.platforms) {
      const mark = p.allowed ? "LIVE " : "  -  ";
      const bits = [`platform ${p.enabled ? "on" : "off"}`, `consent ${p.consent ? "yes" : "no"}`];
      console.log(`  ${mark} ${p.platform.padEnd(11)} (${bits.join(", ")})`);
    }
    console.log("");
  }
  console.log(
    `Session browser: ${session.provider}${session.configuredProvider === "auto" ? " (automatic)" : ""}${session.profileRoot ? ` (profiles: ${session.profileRoot})` : ""}. Change: \`careerrat automation session <auto|extension|orca|playwright> --write\`.`
  );
  console.log(
    "Toggle: `careerrat automation enable <capability> [platform] --write`, `consent <platform> --write`."
  );
}

function printList(asJson) {
  if (asJson) {
    console.log(JSON.stringify({ capabilities: CAPABILITIES, platforms: PLATFORMS }, null, 2));
    return;
  }
  console.log("Capabilities (capability · phase · platforms):");
  for (const key of CAPABILITY_KEYS) {
    const c = CAPABILITIES[key];
    console.log(`  ${key.padEnd(22)} phase ${c.phase}  · ${c.platforms.join(", ")}`);
  }
  console.log("");
  console.log(`Platforms (consent ledger): ${PLATFORMS.join(", ")}`);
}

function printHelp() {
  console.log(`careerrat automation — opt-in browser-automation config (defaults OFF)

Usage:
  node src/cli/automation.mjs status [--json]          Show the capability/consent matrix
  node src/cli/automation.mjs consent <platform>       Propose recording ToS consent (dry run)
  node src/cli/automation.mjs consent <platform> --write   Record consent (after reading the ToS)
  node src/cli/automation.mjs revoke  <platform> --write   Withdraw consent
  node src/cli/automation.mjs enable  <capability> [platform] --write
  node src/cli/automation.mjs disable <capability> [platform] --write
  node src/cli/automation.mjs session <auto|extension|orca|playwright> [--write]  Set the session-browser provider
  node src/cli/automation.mjs --list [--json]          List capabilities + platforms
  node src/cli/automation.mjs --help

A capability runs on a platform only if ALL of: the capability global switch,
that platform's switch, and that platform's consent are on. \`enable <capability>\`
with no platform flips the global switch; with a platform flips just that platform.

Options:
  --write     Commit the change (default: dry run, writes nothing)
  --json      Machine-readable output
  --root DIR  Repo root (default: the careerrat install)

DB mode writes SQLite candidate_automation. Legacy mode patches
candidate/automation.yml comment-preserving + schema-validated; the first legacy
write scaffolds it from templates/automation.example.yml. No credentials are ever
stored — the browser session holds your logins. See docs/BROWSER.md.`);
}
