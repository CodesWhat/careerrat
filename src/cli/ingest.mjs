#!/usr/bin/env node
// CareerRat ingest CLI — guided candidate setup.
//
// Modes:
//   (default)        Initialize DB-backed candidate setup, then report readiness.
//   --check          Validate every candidate file against its schema and reject
//                    leftover placeholders. Exit 1 if not ready. (No writes.)
//   --resume <path>  Parse a resume file and print profile/evidence seed YAML for
//                    review. (No writes — the interviewing agent decides.)
//   --write-config   Generate compatibility candidate/*.yml, config/search-sources.yml,
//                    and candidate/AGENTS.md from canonical candidate config.
//   --json           Machine-readable output for the current mode.
//   --help           Show usage.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { dbExists, dbFilePath } from "../core/db/connection.mjs";
import {
  candidateConfigGet,
  candidateSetupInitialize,
  sourceConfigPut,
} from "../core/db/verbs.mjs";
import { displayPath, userPath } from "../core/paths/workspace.mjs";
import {
  CANDIDATE_FILES,
  lintPlaceholders,
  loadCandidate,
} from "../core/profile/candidate-setup.mjs";
import {
  CANDIDATE_DOCS,
  candidateDocNames,
  loadCandidateConfig,
  loadCandidateDoc,
} from "../core/profile/config-store.mjs";
import { renderLocalAgents } from "../core/profile/generate-agents.mjs";
import { buildSearchSources } from "../core/profile/generate-search-sources.mjs";
import {
  deriveEvidenceSeed,
  deriveProfileSeed,
  parseResume,
} from "../core/profile/resume-parser.mjs";
import { formatErrors } from "../core/profile/schema-validator.mjs";
import { stringifyYaml } from "../core/profile/yaml.mjs";

const args = process.argv.slice(2);
const installRoot = join(fileURLToPath(new URL("../..", import.meta.url)));
const root = optValue("--root") || installRoot;
const pathCtx = { repoRoot: root };
const json = args.includes("--json");

if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

let exitCode = 0;
if (args.includes("--check")) {
  exitCode = runCheck();
} else if (args.includes("--resume")) {
  exitCode = runResume(optValue("--resume"));
} else if (args.includes("--write-config")) {
  exitCode = runWriteConfig();
} else {
  exitCode = runInit();
}
process.exit(exitCode);

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function runInit() {
  const result = candidateSetupInitialize(pathCtx);
  const readiness = dbCandidateReadiness(candidateConfigGet(pathCtx));
  if (json) {
    console.log(JSON.stringify({ mode: "db", ok: true, setup: result.setup, readiness }, null, 2));
    return 0;
  }

  console.log("careerrat ingest");
  console.log("================");
  console.log("");
  const dbPath = dbFilePath(pathCtx);
  const dbRel = relative(pathCtx.repoRoot, dbPath);
  const dbDisplay =
    dbRel && !dbRel.startsWith("..") && !isAbsolute(dbRel) ? dbRel.replaceAll(sep, "/") : dbPath;
  console.log(`Initialized SQLite-backed candidate setup at ${dbDisplay}.`);
  reportDbStatus(readiness);
  console.log("");
  console.log("Next steps:");
  console.log("1. Use the onboarding wizard or ingest-profile to fill profile and targeting.");
  console.log("2. Validate: careerrat ingest --check");
  console.log("3. Export compatibility files only when needed: careerrat ingest --write-config");
  return 0;
}

function runCheck() {
  if (dbExists(pathCtx)) {
    const readiness = dbCandidateReadiness(candidateConfigGet(pathCtx));
    if (json) {
      console.log(JSON.stringify({ mode: "db", ok: readiness.ok, readiness }, null, 2));
      return readiness.ok ? 0 : 1;
    }
    console.log("careerrat ingest --check");
    console.log("========================");
    console.log("");
    reportDbStatus(readiness);
    console.log("");
    console.log(
      readiness.ok
        ? "Candidate setup is complete enough for search kickoff."
        : "Candidate setup is incomplete. Fill the missing DB-backed fields and re-run."
    );
    return readiness.ok ? 0 : 1;
  }

  const load = loadCandidate({ root });
  const lint = lintPlaceholders({ root });
  const ok = load.ok && lint.clean;

  if (json) {
    console.log(JSON.stringify({ ok, files: load.files, placeholders: lint.findings }, null, 2));
    return ok ? 0 : 1;
  }

  console.log("careerrat ingest --check");
  console.log("========================");
  console.log("");
  reportStatus(load, lint);
  console.log("");
  console.log(
    ok
      ? "Candidate setup is complete and valid."
      : "Candidate setup is incomplete. Fix the items above and re-run."
  );
  return ok ? 0 : 1;
}

function runResume(path) {
  if (!path) {
    console.error("Usage: careerrat ingest --resume <path-to-resume.md|.txt>");
    return 1;
  }
  const resolved = isAbsolute(path) ? path : join(process.cwd(), path);
  if (!existsSync(resolved)) {
    console.error(`Resume file not found: ${resolved}`);
    return 1;
  }
  const parsed = parseResume(readFileSync(resolved, "utf8"));
  const profileSeed = deriveProfileSeed(parsed);
  const evidenceSeed = deriveEvidenceSeed(parsed);

  if (json) {
    console.log(
      JSON.stringify(
        {
          contact: parsed.contact,
          profileSeed,
          evidenceSeed,
          links: parsed.links,
          skills: parsed.sections.skills,
        },
        null,
        2
      )
    );
    return 0;
  }

  console.log("# Resume parse: review before saving to candidate/ files.");
  console.log("# Nothing is written automatically; the interview decides what is true.\n");
  console.log("## Profile seed (candidate/profile.yml)\n");
  console.log(stringifyYaml(profileSeed));
  console.log("\n## Evidence seed (candidate/evidence.yml)\n");
  console.log(stringifyYaml(evidenceSeed));
  if (parsed.sections.skills.length > 0) {
    console.log(
      `\n## Skills detected (verify before claiming): ${parsed.sections.skills.join(", ")}`
    );
  }
  if (parsed.links.length > 0) {
    console.log(`## Links detected: ${parsed.links.join(", ")}`);
  }
  return 0;
}

function runWriteConfig() {
  if (dbExists(pathCtx)) {
    const config = loadCandidateConfig(pathCtx);
    const profile = config.profile;
    const targeting = config.targeting;

    const wrote = exportCandidateCompatibilityFiles(config);
    const sources = buildSearchSources(targeting, profile);
    sourceConfigPut({ ...pathCtx, name: "search-sources", data: sources });
    const searchConfigPath = userPath(pathCtx, "config/search-sources.yml");
    mkdirSync(dirname(searchConfigPath), { recursive: true });
    writeFileSync(searchConfigPath, `${stringifyYaml(sources)}\n`);
    wrote.push(displayPath(pathCtx, "config/search-sources.yml"));

    const template = readFileSync(join(installRoot, "templates/AGENTS.md"), "utf8");
    const agentsPath = userPath(pathCtx, "candidate/AGENTS.md");
    mkdirSync(dirname(agentsPath), { recursive: true });
    writeFileSync(agentsPath, renderLocalAgents({ template, profile, targeting }));
    wrote.push(displayPath(pathCtx, "candidate/AGENTS.md"));

    if (json) {
      console.log(
        JSON.stringify(
          {
            mode: "db",
            wrote,
            searches: sources.searches.length,
          },
          null,
          2
        )
      );
      return 0;
    }
    console.log("Wrote:");
    for (const path of wrote) console.log(`- ${path}`);
    console.log(`Searches: ${sources.searches.length}`);
    return 0;
  }

  const profile = loadCandidateDoc("profile", pathCtx);
  const targeting = loadCandidateDoc("targeting", pathCtx);
  if (!profile || !targeting) {
    console.error(
      "Need candidate/profile.yml and candidate/targeting.yml first. Run: npm run ingest"
    );
    return 1;
  }

  const sources = buildSearchSources(targeting, profile);
  const searchConfigPath = userPath(pathCtx, "config/search-sources.yml");
  mkdirSync(dirname(searchConfigPath), { recursive: true });
  writeFileSync(searchConfigPath, `${stringifyYaml(sources)}\n`);

  const template = readFileSync(join(installRoot, "templates/AGENTS.md"), "utf8");
  const agentsPath = userPath(pathCtx, "candidate/AGENTS.md");
  mkdirSync(dirname(agentsPath), { recursive: true });
  writeFileSync(agentsPath, renderLocalAgents({ template, profile, targeting }));
  const wrote = [
    displayPath(pathCtx, "config/search-sources.yml"),
    displayPath(pathCtx, "candidate/AGENTS.md"),
  ];

  if (json) {
    console.log(
      JSON.stringify(
        {
          wrote,
          searches: sources.searches.length,
        },
        null,
        2
      )
    );
    return 0;
  }
  console.log("Wrote:");
  console.log(`- ${wrote[0]} (${sources.searches.length} searches)`);
  console.log(`- ${wrote[1]} (personalized router)`);
  return 0;
}

function exportCandidateCompatibilityFiles(config) {
  const wrote = [];
  for (const name of candidateDocNames()) {
    if (name === "automation" && Object.keys(config.automation || {}).length === 0) continue;
    const spec = CANDIDATE_DOCS[name];
    const data = name === "form-defaults" ? config["form-defaults"] : config[name];
    if (name === "application-limits" && !(data?.companies || []).length) continue;
    if (!spec || data == null) continue;
    const path = userPath(pathCtx, spec.candidatePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${stringifyYaml(data)}\n`);
    wrote.push(displayPath(pathCtx, spec.candidatePath));
  }
  return wrote;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reportStatus(load, lint) {
  console.log("Candidate files:");
  for (const file of load.files) {
    if (!file.exists) {
      console.log(`- ${file.path}: missing`);
    } else if (!file.valid) {
      console.log(`- ${file.path}: invalid`);
      console.log(
        formatErrors(file.errors)
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n")
      );
    } else {
      console.log(`- ${file.path}: ok`);
    }
  }
  if (lint.findings.length > 0) {
    console.log("");
    console.log("Unresolved placeholders:");
    for (const hit of lint.findings) {
      console.log(`- ${hit.file}:${hit.line}: ${hit.text}`);
    }
  }
}

function dbCandidateReadiness(config) {
  const missing = [];
  const candidate = config.profile?.candidate || {};
  if (!String(candidate.full_name || "").trim()) missing.push("profile.candidate.full_name");
  if (!String(candidate.email || "").trim()) missing.push("profile.candidate.email");
  const buckets = Array.isArray(config.targeting?.role_buckets)
    ? config.targeting.role_buckets
    : [];
  if (!buckets.some((bucket) => Array.isArray(bucket.titles) && bucket.titles.length > 0)) {
    missing.push("targeting.role_buckets[].titles");
  }
  return { ok: missing.length === 0, missing };
}

function reportDbStatus(readiness) {
  console.log("Candidate setup source: SQLite");
  if (readiness.ok) {
    console.log("- profile/contact: ok");
    console.log("- targeting tracks: ok");
    return;
  }
  console.log("Missing:");
  for (const item of readiness.missing) console.log(`- ${item}`);
}

function optValue(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

function printHelp() {
  console.log(`careerrat ingest: guided candidate setup

Usage:
  careerrat ingest                       Initialize candidate/ from templates, then report status
  careerrat ingest --check            Validate candidate files + reject placeholders (exit 1 if not ready)
  careerrat ingest --resume <path>    Parse a resume into profile/evidence seed YAML (no writes)
  careerrat ingest --write-config     Generate config/search-sources.yml + candidate/AGENTS.md
  careerrat ingest --json             Machine-readable output for any mode

Candidate files (${CANDIDATE_FILES.length}): ${CANDIDATE_FILES.map((f) => f.name).join(", ")}
All candidate/* output is private user-layer data and is gitignored.`);
}
