#!/usr/bin/env node

// careerrat plugins — read-only listing and verification for the bundled
// plugin layer (plugins/<name>/ under the repo root).
//
// Plugins here are code we ship, never user-added, never remote — there is no
// enable/disable registry and nothing to install. Whether a plugin may run is
// a per-capability point-of-need consent decision `careerrat automation` and
// src/core/plugins/consent.mjs already own. So this CLI does exactly two
// things and nothing else: list what's bundled (with its current consent
// state), and verify every bundled manifest is well-formed. It never
// enables, disables, or runs a plugin.
//
// Usage:
//   node src/cli/plugins.mjs [list] [--json]
//   node src/cli/plugins.mjs verify [--json]
//   node src/cli/plugins.mjs --help
//
// CAREERRAT_PLUGINS_ROOT, when set, overrides where plugins/ is discovered
// from (used by tests to point at a scratch tree with a broken manifest).
// Consent resolution (automation.yml / CAREERRAT_HOME) is unaffected by it —
// that always resolves against the real repo root, same as every other CLI.

import { fileURLToPath } from "node:url";
import { listBundledPlugins, pluginAllowed, verifyBundledPlugins } from "../core/plugins/index.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function parseArgs(argv) {
  const opts = { positional: [], json: false, root: ROOT, env: process.env };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--root") opts.root = argv[++i];
    else opts.positional.push(a);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
// Discovery root: where plugins/ is read from. Overridable in tests only, via
// CAREERRAT_PLUGINS_ROOT — kept separate from opts.root, which stays the real
// consent/workspace root for pluginAllowed().
const pluginsRoot = String(opts.env.CAREERRAT_PLUGINS_ROOT || "").trim() || opts.root;

if (opts.help) {
  printHelp();
  process.exit(0);
}

const verb = opts.positional[0] || "list";

try {
  switch (verb) {
    case "list":
      cmdList();
      break;
    case "verify":
      cmdVerify();
      break;
    default:
      fail(`unknown command "${verb}". Commands: list, verify. See --help.`);
  }
} catch (err) {
  fail(err?.message || String(err));
}

// ---------------------------------------------------------------------------

function cmdList() {
  const manifests = listBundledPlugins({ root: pluginsRoot });
  const rows = manifests.map((manifest) => {
    const verdict = pluginAllowed({ manifest, root: opts.root, env: opts.env });
    return {
      name: manifest.name,
      description: manifest.description,
      capability: manifest.capability,
      fetchHosts: manifest.fetchHosts,
      reads: manifest.reads,
      allowed: verdict.allowed,
      reason: verdict.reason,
    };
  });

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, plugins: rows }, null, 2));
    process.exit(0);
    return;
  }

  if (rows.length === 0) {
    console.log("No bundled plugins found.");
    process.exit(0);
    return;
  }

  console.log(`Bundled plugins (${rows.length}):`);
  for (const row of rows) {
    console.log(`- ${row.name}: ${row.description}`);
    console.log(`  capability: ${row.capability ?? "none"}`);
    console.log(`  fetch hosts: ${row.fetchHosts.length ? row.fetchHosts.join(", ") : "none"}`);
    console.log(`  consent: ${row.allowed ? "allowed" : `blocked: ${row.reason}`}`);
  }
  process.exit(0);
}

function cmdVerify() {
  const results = verifyBundledPlugins({ root: pluginsRoot });
  const ok = results.every((r) => r.ok);

  if (opts.json) {
    console.log(JSON.stringify({ ok, results }, null, 2));
    process.exit(ok ? 0 : 1);
    return;
  }

  if (results.length === 0) {
    console.log("No bundled plugins found.");
    process.exit(0);
    return;
  }

  for (const result of results) {
    if (result.ok) {
      console.log(`ok    ${result.name}`);
    } else {
      console.log(`FAIL  ${result.name}`);
      for (const error of result.errors) console.log(`      ${error}`);
    }
  }
  console.log("");
  console.log(
    ok
      ? `${results.length} bundled plugin(s), all verified.`
      : `${results.filter((r) => !r.ok).length} of ${results.length} bundled plugin(s) failed verification.`
  );
  process.exit(ok ? 0 : 1);
}

function fail(msg) {
  if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error(`plugins: ${msg}`);
  process.exit(1);
}

function printHelp() {
  console.log(`careerrat plugins: list and verify the bundled plugin layer (read-only)

Usage:
  node src/cli/plugins.mjs [list] [--json]
  node src/cli/plugins.mjs verify [--json]

Commands:
  list      Default. One line per bundled plugin: name, description, declared
            capability, fetch hosts, and its current consent state against
            this workspace (allowed / blocked: reason).
  verify    Validate every bundled plugin's manifest.json and confirm its
            entry file exists inside plugins/. Exit 0 when all pass, exit 1
            otherwise, naming each failure.

Options:
  --json    Machine-readable output.
  --root DIR  Repo root used to resolve consent/workspace config (default:
              the careerrat install).

There is no enable/disable registry here — bundled plugins ship with the repo
and are never user-added. Whether a plugin that declares a capability may run
is a point-of-need consent decision; see \`careerrat automation\`.`);
}
