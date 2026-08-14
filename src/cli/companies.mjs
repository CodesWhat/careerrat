#!/usr/bin/env node
// CareerRat companies CLI — manage config/sourced-scan.json#tracked_companies.
//
// Commands:
//   --list (default)         Print tracked companies as a numbered list with providers.
//   --add "<name>" --url "<careers_url>"
//                            Append a company (dry-run by default, --write to commit).
//   --remove "<name>"        Remove by name (dry-run by default, --write to commit).
//   --json                   Machine-readable output for any mode.
//   --help / -h              Show usage.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dbExists } from "../core/db/connection.mjs";
import { companyAtsRemove, companyAtsUpsert, sourceConfigGet } from "../core/db/verbs.mjs";
import { userPath } from "../core/paths/workspace.mjs";
import { inferProvider, loadScannerConfig } from "../core/scoring/sourced-scanner.mjs";

const args = process.argv.slice(2);
const root = optValueFrom(args, "--root") || join(fileURLToPath(new URL("../..", import.meta.url)));
const pathCtx = { repoRoot: root };
const CONFIG_REL = "config/sourced-scan.json";
const CONFIG_PATH = userPath(pathCtx, CONFIG_REL);

const SUPPORTED_HOSTS = [
  "jobs.ashbyhq.com",
  "job-boards.greenhouse.io",
  "boards.greenhouse.io",
  "jobs.lever.co",
  "apply.workable.com",
  "careers.smartrecruiters.com",
  "jobs.smartrecruiters.com",
];
const ATS_FAMILIES = "Ashby, Greenhouse, Lever, Workable, or SmartRecruiters";

const json = args.includes("--json");
const write = args.includes("--write");

if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

let exitCode = 0;
if (args.includes("--add")) {
  exitCode = runAdd();
} else if (args.includes("--remove")) {
  exitCode = runRemove();
} else {
  exitCode = runList();
}
process.exit(exitCode);

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function runList() {
  const config = loadConfig();
  const companies = config.tracked_companies || [];
  if (json) {
    const rows = companies.map((entry, i) => ({
      index: i + 1,
      name: entry.name,
      careers_url: entry.careers_url,
      provider: inferProvider(entry),
      enabled: entry.enabled !== false,
      lastRunAt: entry.lastRunAt || null,
    }));
    console.log(
      JSON.stringify(
        {
          total: companies.length,
          companies: rows,
          readiness: companyAtsReadiness(companies),
        },
        null,
        2
      )
    );
    return 0;
  }
  if (companies.length === 0) {
    console.log("No tracked companies yet.");
    console.log(
      "Company ATS scans are not wired: Ask your agent to run discover-companies next to find target employers automatically, or add a scannable ATS board manually."
    );
    console.log(
      `Until this is populated, search-jobs can use broad board searches but will not scan company ATS boards like ${ATS_FAMILIES}.`
    );
    console.log(
      `Add one: careerrat companies --add "Acme" --url "https://jobs.ashbyhq.com/acme" --write`
    );
    return 0;
  }
  for (const [i, entry] of companies.entries()) {
    const provider = inferProvider(entry) || "unknown";
    const flag = entry.enabled === false ? "✗" : "✓";
    const watermark = entry.lastRunAt ? ` last-run ${entry.lastRunAt}` : " never-run";
    console.log(
      `${String(i + 1).padStart(2)} ${flag} ${entry.name} — ${entry.careers_url} (${provider})${watermark}`
    );
  }
  console.log(`\n${companies.length} tracked ${companies.length === 1 ? "company" : "companies"}.`);
  return 0;
}

function runAdd() {
  const name = optValue("--add");
  const url = optValue("--url");

  if (!name || !url) {
    console.error('Usage: careerrat companies --add "<name>" --url "<careers_url>" [--write]');
    return 2;
  }

  const provider = inferProvider({ careers_url: url });
  if (!provider) {
    console.error(`Unsupported ATS host — cannot scan "${url}".`);
    console.error(`Supported hosts: ${SUPPORTED_HOSTS.join(", ")}`);
    return 2;
  }

  const config = loadConfig();
  const companies = config.tracked_companies || [];

  const duplicate = companies.find(
    (entry) => entry.name.toLowerCase() === name.toLowerCase() || entry.careers_url === url
  );
  if (duplicate) {
    if (json) {
      console.log(
        JSON.stringify({
          status: "already-tracked",
          name: duplicate.name,
          careers_url: duplicate.careers_url,
          provider: inferProvider(duplicate),
        })
      );
    } else {
      console.log(
        `Already tracked: ${duplicate.name} — ${duplicate.careers_url} (${inferProvider(duplicate)})`
      );
    }
    return 0;
  }

  const entry = { name, careers_url: url };

  if (!write) {
    if (json) {
      console.log(
        JSON.stringify({ status: "dry-run", would_add: { name, careers_url: url, provider } })
      );
    } else {
      console.log(`Dry run — would add: ${name} — ${url} (${provider})`);
      console.log("Pass --write to commit.");
    }
    return 0;
  }

  const next = { ...config, tracked_companies: [...companies, entry] };
  if (dbExists(pathCtx)) {
    const result = companyAtsUpsert({ ...pathCtx, entry });
    if (json) {
      console.log(
        JSON.stringify({
          status: result.status,
          name: result.entry.name,
          careers_url: result.entry.careers_url,
          provider,
          total: result.total,
        })
      );
    } else {
      const verb = result.status === "updated" ? "Updated" : "Added";
      console.log(`${verb} ${result.entry.name} — ${result.entry.careers_url} (${provider})`);
      console.log(`${result.total} tracked ${result.total === 1 ? "company" : "companies"} total.`);
    }
    return 0;
  }

  writeConfig(next);

  if (json) {
    console.log(
      JSON.stringify({
        status: "added",
        name,
        careers_url: url,
        provider,
        total: next.tracked_companies.length,
      })
    );
  } else {
    console.log(`Added ${name} — ${url} (${provider})`);
    console.log(
      `${next.tracked_companies.length} tracked ${next.tracked_companies.length === 1 ? "company" : "companies"} total.`
    );
  }
  return 0;
}

function runRemove() {
  const name = optValue("--remove");
  if (!name) {
    console.error('Usage: careerrat companies --remove "<name>" [--write]');
    return 2;
  }

  const config = loadConfig();
  const companies = config.tracked_companies || [];
  const match = companies.find((entry) => entry.name.toLowerCase() === name.toLowerCase());

  if (!match) {
    if (json) {
      console.log(JSON.stringify({ status: "not-found", name }));
    } else {
      console.log(`Not found: "${name}" is not in the tracked list.`);
    }
    return 0;
  }

  if (!write) {
    if (json) {
      console.log(
        JSON.stringify({
          status: "dry-run",
          would_remove: {
            name: match.name,
            careers_url: match.careers_url,
            provider: inferProvider(match),
          },
        })
      );
    } else {
      console.log(
        `Dry run — would remove: ${match.name} — ${match.careers_url} (${inferProvider(match) || "unknown"})`
      );
      console.log("Pass --write to commit.");
    }
    return 0;
  }

  const next = { ...config, tracked_companies: companies.filter((entry) => entry !== match) };
  if (dbExists(pathCtx)) {
    const result = companyAtsRemove({ ...pathCtx, name });
    if (json) {
      console.log(
        JSON.stringify({ status: result.status, name: result.name || name, total: result.total })
      );
    } else {
      console.log(`Removed ${result.name || name}`);
      console.log(`${result.total} tracked ${result.total === 1 ? "company" : "companies"} total.`);
    }
    return 0;
  }

  writeConfig(next);

  if (json) {
    console.log(
      JSON.stringify({ status: "removed", name: match.name, total: next.tracked_companies.length })
    );
  } else {
    console.log(`Removed ${match.name} — ${match.careers_url}`);
    console.log(
      `${next.tracked_companies.length} tracked ${next.tracked_companies.length === 1 ? "company" : "companies"} total.`
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadConfig() {
  if (dbExists(pathCtx)) return sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data;
  return loadScannerConfig(CONFIG_PATH);
}

function companyAtsReadiness(companies) {
  const providers = [...new Set(companies.map((entry) => inferProvider(entry)).filter(Boolean))];
  return {
    configured: companies.length > 0,
    total: companies.length,
    providers,
    missingAction:
      companies.length === 0
        ? "Run discover-companies, or add a scannable ATS board with careerrat companies --add."
        : null,
  };
}

function writeConfig(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(tmp, CONFIG_PATH);
}

function optValue(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

function optValueFrom(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
}

function printHelp() {
  console.log(`careerrat companies — manage config/sourced-scan.json#tracked_companies

Usage:
  careerrat companies                                        List tracked companies (default)
  careerrat companies --add "<name>" --url "<url>"           Dry-run add (print what would be added)
  careerrat companies --add "<name>" --url "<url>" --write   Append a company and save
  careerrat companies --remove "<name>"                      Dry-run remove
  careerrat companies --remove "<name>" --write              Remove a company and save
  careerrat companies --json                                 Machine-readable output for any mode

Supported ATS hosts: ${SUPPORTED_HOSTS.join(", ")}

Only scannable ATS URLs are accepted. Non-scannable boards are rejected at --add time.`);
}
