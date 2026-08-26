import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dbExists } from "../db/connection.mjs";
import { candidateConfigGet } from "../db/verbs.mjs";
import { userPath } from "../paths/workspace.mjs";
import { normalizeCandidateProfile } from "./candidate-defaults.mjs";
import { parseYaml } from "./yaml.mjs";

const DEFAULT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export const CANDIDATE_DOCS = {
  profile: {
    candidatePath: "candidate/profile.yml",
    templatePath: "templates/profile.example.yml",
  },
  targeting: {
    candidatePath: "candidate/targeting.yml",
    templatePath: "templates/targeting.example.yml",
  },
  evidence: {
    candidatePath: "candidate/evidence.yml",
    templatePath: "templates/evidence.example.yml",
  },
  honesty: {
    candidatePath: "candidate/honesty.yml",
    templatePath: "templates/honesty.example.yml",
  },
  "form-defaults": {
    candidatePath: "candidate/form-defaults.yml",
    templatePath: "templates/form-defaults.example.yml",
  },
  modes: {
    candidatePath: "candidate/modes.yml",
    templatePath: "templates/modes.example.yml",
  },
  automation: {
    candidatePath: "candidate/automation.yml",
    templatePath: "templates/automation.example.yml",
  },
  "application-limits": {
    candidatePath: "candidate/application-limits.yml",
    templatePath: "templates/application-limits.example.yml",
  },
};

export function candidateDocNames() {
  return Object.keys(CANDIDATE_DOCS);
}

export function loadCandidateConfig({
  repoRoot = DEFAULT_ROOT,
  env = process.env,
  fallbackToTemplate = false,
} = {}) {
  const pathCtx = { repoRoot, env };
  if (dbExists(pathCtx)) {
    return { mode: "db", ...candidateConfigGet(pathCtx) };
  }

  const out = { mode: "legacy" };
  for (const name of candidateDocNames()) {
    out[name] = loadLegacyCandidateDoc(name, { repoRoot, env, fallbackToTemplate }) || {};
  }
  return out;
}

const AGENT_PRIVATE_FORM_DEFAULT_FIELDS = new Set([
  "current_base",
  "eeo_default",
  "voluntary_self_identification",
]);

export function sanitizeCandidateConfigForAgent(config = {}) {
  const formDefaults = config?.["form-defaults"];
  if (!formDefaults || typeof formDefaults !== "object" || Array.isArray(formDefaults)) {
    return { ...config };
  }
  return {
    ...config,
    "form-defaults": Object.fromEntries(
      Object.entries(formDefaults).filter(
        ([field]) => !AGENT_PRIVATE_FORM_DEFAULT_FIELDS.has(field)
      )
    ),
  };
}

// Agent runtimes use this accessor instead of the canonical local-app view.
// The app and deterministic application filler keep using loadCandidateConfig,
// so voluntary form policy and answers never have to enter a model context.
export function loadAgentCandidateConfig(options = {}) {
  return sanitizeCandidateConfigForAgent(loadCandidateConfig(options));
}

export function loadLegacyCandidateConfig({
  repoRoot = DEFAULT_ROOT,
  env = process.env,
  fallbackToTemplate = false,
} = {}) {
  const out = {};
  for (const name of candidateDocNames()) {
    const doc = loadLegacyCandidateDoc(name, {
      repoRoot,
      env,
      fallbackToTemplate,
    });
    if (doc) out[name] = doc;
  }
  return out;
}

export function loadCandidateDoc(
  name,
  { repoRoot = DEFAULT_ROOT, env = process.env, fallbackToTemplate = false } = {}
) {
  const pathCtx = { repoRoot, env };
  if (dbExists(pathCtx)) {
    return docFromDbConfig(candidateConfigGet(pathCtx), name);
  }
  return loadLegacyCandidateDoc(name, { repoRoot, env, fallbackToTemplate });
}

export function candidateConfigSource({ repoRoot = DEFAULT_ROOT, env = process.env } = {}) {
  return dbExists({ repoRoot, env }) ? "db" : "legacy";
}

function docFromDbConfig(config, name) {
  if (name === "form-defaults") return config["form-defaults"];
  if (name === "application-limits") return config["application-limits"];
  return config[name] || null;
}

function loadLegacyCandidateDoc(name, { repoRoot, env, fallbackToTemplate }) {
  const spec = CANDIDATE_DOCS[name];
  if (!spec) {
    const err = new Error(`unknown candidate config "${name}"`);
    err.code = "NOT_FOUND";
    throw err;
  }

  const pathCtx = { repoRoot, env };
  const candidatePath = userPath(pathCtx, spec.candidatePath);
  if (existsSync(candidatePath)) {
    const doc = parseYaml(readFileSync(candidatePath, "utf8")) || {};
    return name === "profile" ? normalizeCandidateProfile(doc) : doc;
  }
  if (fallbackToTemplate) {
    const templatePath = join(repoRoot, spec.templatePath);
    if (existsSync(templatePath)) {
      const doc = parseYaml(readFileSync(templatePath, "utf8")) || {};
      return name === "profile" ? normalizeCandidateProfile(doc) : doc;
    }
  }
  return null;
}
