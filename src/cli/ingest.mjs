#!/usr/bin/env node
// Rolester ingest CLI — guided candidate setup.
//
// Modes:
//   (default)        Initialize: copy templates into candidate/ (never overwrite),
//                    then report validation + placeholder status and next steps.
//   --check          Validate every candidate file against its schema and reject
//                    leftover placeholders. Exit 1 if not ready. (No writes.)
//   --resume <path>  Parse a resume file and print profile/evidence seed YAML for
//                    review. (No writes — the interviewing agent decides.)
//   --write-config   Generate config/search-sources.yml and candidate/AGENTS.md
//                    from candidate/targeting.yml + candidate/profile.yml.
//   --json           Machine-readable output for the current mode.
//   --help           Show usage.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { displayPath, userPath } from "../core/paths/workspace.mjs";
import {
  CANDIDATE_FILES,
  ensureCandidateFiles,
  lintPlaceholders,
  loadCandidate,
} from "../core/profile/candidate-setup.mjs";
import { renderLocalAgents } from "../core/profile/generate-agents.mjs";
import { buildSearchSources } from "../core/profile/generate-search-sources.mjs";
import {
  deriveEvidenceSeed,
  deriveProfileSeed,
  parseResume,
} from "../core/profile/resume-parser.mjs";
import { formatErrors } from "../core/profile/schema-validator.mjs";
import { parseYaml, stringifyYaml } from "../core/profile/yaml.mjs";

const root = join(fileURLToPath(new URL("../..", import.meta.url)));
const pathCtx = { repoRoot: root };
const args = process.argv.slice(2);
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
  const ensure = ensureCandidateFiles({ root });
  const load = loadCandidate({ root });
  const lint = lintPlaceholders({ root });

  if (json) {
    console.log(
      JSON.stringify(
        { ensure, ok: load.ok, files: load.files, placeholders: lint.findings },
        null,
        2
      )
    );
    return 0;
  }

  console.log("careerrat ingest");
  console.log("===============");
  console.log("");
  if (ensure.created.length > 0) {
    console.log("Created candidate files from templates:");
    for (const path of ensure.created) console.log(`- ${path}`);
    console.log("");
  }
  if (ensure.existing.length > 0) {
    console.log(`Kept ${ensure.existing.length} existing candidate file(s) untouched.`);
    console.log("");
  }

  reportStatus(load, lint);

  console.log("");
  console.log("Next steps:");
  console.log("1. Fill in each candidate/*.yml with the real candidate's facts.");
  console.log("2. Replace every placeholder value (Jane Candidate, jane@example.com, ...).");
  console.log(
    "3. Drop writing samples into workspace/writing-samples/ and run: npm run calibrate:style"
  );
  console.log("4. Validate: careerrat ingest --check");
  console.log("5. Generate search config + local router: careerrat ingest --write-config");
  return 0;
}

function runCheck() {
  const load = loadCandidate({ root });
  const lint = lintPlaceholders({ root });
  const ok = load.ok && lint.clean;

  if (json) {
    console.log(JSON.stringify({ ok, files: load.files, placeholders: lint.findings }, null, 2));
    return ok ? 0 : 1;
  }

  console.log("careerrat ingest --check");
  console.log("=======================");
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

  console.log("# Resume parse — review before saving to candidate/ files.");
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
  const profilePath = userPath(pathCtx, "candidate/profile.yml");
  const targetingPath = userPath(pathCtx, "candidate/targeting.yml");
  if (!existsSync(profilePath) || !existsSync(targetingPath)) {
    console.error(
      "Need candidate/profile.yml and candidate/targeting.yml first. Run: npm run ingest"
    );
    return 1;
  }
  const profile = parseYaml(readFileSync(profilePath, "utf8"));
  const targeting = parseYaml(readFileSync(targetingPath, "utf8"));

  const sources = buildSearchSources(targeting, profile);
  const searchConfigPath = userPath(pathCtx, "config/search-sources.yml");
  mkdirSync(dirname(searchConfigPath), { recursive: true });
  writeFileSync(searchConfigPath, `${stringifyYaml(sources)}\n`);

  const template = readFileSync(join(root, "templates/AGENTS.md"), "utf8");
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

function optValue(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

function printHelp() {
  console.log(`careerrat ingest — guided candidate setup

Usage:
  careerrat ingest                       Initialize candidate/ from templates, then report status
  careerrat ingest --check            Validate candidate files + reject placeholders (exit 1 if not ready)
  careerrat ingest --resume <path>    Parse a resume into profile/evidence seed YAML (no writes)
  careerrat ingest --write-config     Generate config/search-sources.yml + candidate/AGENTS.md
  careerrat ingest --json             Machine-readable output for any mode

Candidate files (${CANDIDATE_FILES.length}): ${CANDIDATE_FILES.map((f) => f.name).join(", ")}
All candidate/* output is private user-layer data and is gitignored.`);
}
