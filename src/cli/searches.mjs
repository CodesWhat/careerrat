#!/usr/bin/env node
// CareerRat searches CLI — build and curate search source config.
//
// This is the authoring surface for job-search SOURCES (the `setup-searches`
// skill drives it). In DB workspaces it reads/writes SQLite source config; in
// legacy workspaces it reads/writes config/search-sources.yml. It builds and
// maintains the source list; it does not scan, dedupe results, or gate jobs —
// that is `search-jobs` and `evaluate-job`.
//
// Modes:
//   --list                  Show current searches (index, provider, label, target, enabled).
//   --providers             Show the pinned deterministic provider manifest.
//   --from-targeting        Generate/refresh searches from candidate/targeting.yml +
//                           candidate/profile.yml, merged into any existing config
//                           (manual entries preserved — idempotent).
//   --add-query "<q>"       Append a single keyword search.
//       [--label "<l>"]
//   --add-url "<url>"       Append a search from a pasted URL (hiring.cafe filters preserved).
//       [--label "<l>"]
//   --add-provider "<id>"   Append a deterministic Career Ops provider source.
//       [--query "<q>"] [--url "<url>"] [--label "<l>"]
//   --enable <selector>     Enable a search by index or label.
//   --disable <selector>    Disable a search by index or label.
//   --json                  Machine-readable output for the current mode.
//   --help                  Show usage.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dbExists } from "../core/db/connection.mjs";
import { sourceConfigGet, sourceConfigPut } from "../core/db/verbs.mjs";
import { displayPath, userPath } from "../core/paths/workspace.mjs";
import { loadCandidateDoc } from "../core/profile/config-store.mjs";
import { buildSearchSources } from "../core/profile/generate-search-sources.mjs";
import { formatErrors } from "../core/profile/schema-validator.mjs";
import {
  CAREER_OPS_PROVIDER_PARITY,
  CAREER_OPS_UPSTREAM,
} from "../core/providers/provider-parity.mjs";
import {
  addProviderSource,
  addSearchFromQuery,
  addSearchFromUrl,
  emptyConfig,
  listSearches,
  mergeSearchConfigs,
  parseConfig,
  serializeConfig,
  setEnabled,
  validateConfig,
} from "../core/providers/search-sources.mjs";

const root = join(fileURLToPath(new URL("../..", import.meta.url)));
const pathCtx = { repoRoot: root };
const CONFIG_REL = "config/search-sources.yml";
const CONFIG_PATH = userPath(pathCtx, CONFIG_REL);
const CONFIG_DISPLAY = displayPath(pathCtx, CONFIG_REL);
const SCHEMA_PATH = join(root, "config/search-sources.schema.json");

const args = process.argv.slice(2);
const json = args.includes("--json");

if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

let exitCode = 0;
if (args.includes("--providers")) {
  exitCode = runProviders();
} else if (args.includes("--from-targeting")) {
  exitCode = runFromTargeting();
} else if (args.includes("--add-provider")) {
  exitCode = runAddProvider();
} else if (args.includes("--add-query")) {
  exitCode = runAddQuery();
} else if (args.includes("--add-url")) {
  exitCode = runAddUrl();
} else if (args.includes("--enable")) {
  exitCode = runToggle(optValue("--enable"), true);
} else if (args.includes("--disable")) {
  exitCode = runToggle(optValue("--disable"), false);
} else {
  exitCode = runList();
}
process.exit(exitCode);

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function runProviders() {
  const result = {
    upstream: CAREER_OPS_UPSTREAM,
    providers: CAREER_OPS_PROVIDER_PARITY,
  };
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  const implemented = result.providers.filter((provider) => provider.status === "implemented");
  console.log(`${implemented.length} public deterministic providers:`);
  console.log(implemented.map((provider) => provider.id).join(", "));
  for (const provider of result.providers.filter((entry) => entry.status !== "implemented")) {
    console.log(`\n${provider.id}: ${provider.status} - ${provider.reason}`);
  }
  return 0;
}

function runList() {
  const config = loadConfig();
  if (!config) {
    if (json) {
      console.log(JSON.stringify({ exists: false, searches: [] }, null, 2));
    } else {
      console.log(`No ${CONFIG_DISPLAY} yet.`);
      console.log("Generate one from targeting: careerrat searches --from-targeting");
    }
    return 0;
  }
  const rows = listSearches(config);
  if (json) {
    console.log(
      JSON.stringify({ exists: true, searches: rows, readiness: runReadiness(rows) }, null, 2)
    );
    return 0;
  }
  printTable(rows);
  return 0;
}

function runFromTargeting() {
  const targeting = loadCandidateDoc("targeting", pathCtx);
  const profile = loadCandidateDoc("profile", pathCtx);
  if (!targeting || !profile) {
    console.error(
      "Need candidate/targeting.yml and candidate/profile.yml first. Run: careerrat ingest"
    );
    return 1;
  }
  const baseline = buildSearchSources(targeting, profile);
  // Board-wide aggregator entries (RemoteOK/Remotive/Working Nomads) are seeded
  // unconditionally by buildSearchSources — even for an unfinished onboarding
  // with no role_buckets — so they alone must not satisfy this "targeting has
  // role titles" guard; only role-derived entries count.
  const roleDerivedSearches = (baseline.searches ?? []).filter((s) => s.source_type !== "board");
  if (roleDerivedSearches.length === 0) {
    return failFromTargeting(
      "No role titles found in candidate targeting; finish onboarding before generating search sources."
    );
  }

  const existing = loadConfig();
  const config = existing ? mergeSearchConfigs(existing, baseline) : baseline;

  return writeConfig(config, { mode: "from-targeting", added: config.searches.length });
}

function failFromTargeting(message) {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  } else {
    console.error(message);
  }
  return 1;
}

function runAddQuery() {
  const query = optValue("--add-query");
  if (!query) {
    console.error('Usage: careerrat searches --add-query "<query>" [--label "<label>"]');
    return 1;
  }
  const config = loadConfig() || emptyConfig();
  let next;
  try {
    const provider = optValue("--provider") || "HiringCafe";
    const options = {
      query,
      label: optValue("--label") || undefined,
      provider,
    };
    next =
      provider.toLowerCase() === "hiringcafe"
        ? addSearchFromQuery(config, options)
        : addProviderSource(config, options);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  if (next.searches.length === (config.searches?.length ?? 0)) {
    if (!json) console.log(`Already present: no duplicate added for "${query}".`);
  }
  return writeConfig(next, { mode: "add-query", query });
}

function runAddProvider() {
  const provider = optValue("--add-provider");
  if (!provider) {
    console.error(
      'Usage: careerrat searches --add-provider "<id>" [--query "<query>"] [--url "<url>"] [--label "<label>"]'
    );
    return 1;
  }
  const config = loadConfig() || emptyConfig();
  let next;
  try {
    next = addProviderSource(config, {
      provider,
      query: optValue("--query") || undefined,
      url: optValue("--url") || undefined,
      label: optValue("--label") || undefined,
    });
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  if (next.searches.length === (config.searches?.length ?? 0) && !json) {
    console.log(`Already present: no duplicate added for provider "${provider}".`);
  }
  return writeConfig(next, { mode: "add-provider", provider });
}

function runAddUrl() {
  const url = optValue("--add-url");
  if (!url) {
    console.error('Usage: careerrat searches --add-url "<full URL>" [--label "<label>"]');
    return 1;
  }
  const config = loadConfig() || emptyConfig();
  let next;
  try {
    next = addSearchFromUrl(config, url, { label: optValue("--label") || undefined });
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  return writeConfig(next, { mode: "add-url", url });
}

function runToggle(selector, enabled) {
  if (selector == null) {
    console.error(`Usage: careerrat searches --${enabled ? "enable" : "disable"} <index or label>`);
    return 1;
  }
  const config = loadConfig();
  if (!config) {
    console.error(`No ${CONFIG_DISPLAY} yet. Run: careerrat searches --from-targeting`);
    return 1;
  }
  const sel = /^\d+$/.test(selector) ? Number(selector) : selector;
  let next;
  try {
    next = setEnabled(config, sel, enabled);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  return writeConfig(next, { mode: enabled ? "enable" : "disable", selector });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadConfig() {
  if (dbExists(pathCtx)) {
    const stored = sourceConfigGet({ ...pathCtx, name: "search-sources" });
    return stored.stored ? stored.data : null;
  }
  if (!existsSync(CONFIG_PATH)) return null;
  return parseConfig(readFileSync(CONFIG_PATH, "utf8"));
}

function loadSchema() {
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
}

// Validate, then write. Refuses to persist an invalid config.
function writeConfig(config, meta) {
  const result = validateConfig(config, loadSchema());
  if (!result.valid) {
    console.error("Refusing to write: generated config is invalid.");
    console.error(formatErrors(result.errors));
    return 1;
  }
  const dbMode = dbExists(pathCtx);
  if (dbMode) {
    sourceConfigPut({ ...pathCtx, name: "search-sources", data: config });
  } else {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, `${serializeConfig(config)}\n`);
  }
  const rows = listSearches(config);
  const wrote = dbMode ? "SQLite source config: search-sources" : CONFIG_DISPLAY;
  if (json) {
    console.log(
      JSON.stringify({ ...meta, wrote, searches: rows, readiness: runReadiness(rows) }, null, 2)
    );
    return 0;
  }
  console.log(`Wrote ${wrote} (${rows.length} search${rows.length === 1 ? "" : "es"}).`);
  printTable(rows);
  return 0;
}

function printTable(rows) {
  if (rows.length === 0) {
    console.log("(no searches configured)");
    return;
  }
  for (const r of rows) {
    const flag = r.enabled === false ? "✗" : "✓";
    const ran = r.lastRunAt ? ` last-run ${r.lastRunAt}` : "";
    console.log(
      `${String(r.index).padStart(2)} ${flag} [${r.provider}] ${r.label}: ${r.target}${ran}`
    );
  }
  printRunReadiness(rows);
}

function runReadiness(rows) {
  const enabled = rows.filter((row) => row.enabled !== false);
  return {
    total: rows.length,
    enabled: enabled.length,
    withLastRun: enabled.filter((row) => row.lastRunAt).length,
  };
}

function printRunReadiness(rows) {
  const readiness = runReadiness(rows);
  const searchWord = readiness.enabled === 1 ? "search" : "searches";
  console.log(
    `\n${readiness.enabled} enabled ${searchWord} configured; ${readiness.withLastRun}/${readiness.enabled} have run watermarks.`
  );
  if (readiness.enabled === 0) {
    console.log("Next: ask your agent to run setup-searches or enable sources before search-jobs.");
  } else if (readiness.withLastRun === 0) {
    console.log(
      "Next: Ask your agent to run search-jobs to scan these sources. `modes allows search:sweep:broad` reports the background-mode setting, not run history."
    );
  } else if (readiness.withLastRun < readiness.enabled) {
    const missing = readiness.enabled - readiness.withLastRun;
    console.log(
      `Next: Ask your agent to run search-jobs to scan ${missing} enabled ${missing === 1 ? "source" : "sources"} without watermarks.`
    );
  }
}

function optValue(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

function printHelp() {
  console.log(`careerrat searches: build and curate config/search-sources.yml

Usage:
  careerrat searches                                      Show current searches
  careerrat searches --providers                          Show deterministic provider support
  careerrat searches --from-targeting                     Generate/refresh from candidate targeting (idempotent)
  careerrat searches --add-query "<q>" [--label "<l>"]
  careerrat searches --add-url "<url>" [--label "<l>"]    Import a pasted URL (hiring.cafe filters preserved)
  careerrat searches --add-provider "<id>" [--query "<q>"] [--url "<url>"] [--label "<l>"]
  careerrat searches --enable <index or label>            Enable a search
  careerrat searches --disable <index or label>           Disable a search
  careerrat searches --json                               Machine-readable output for any mode

This builds the SOURCE list. Running scans, dedupe, and gating belong to search-jobs / evaluate-job.`);
}
