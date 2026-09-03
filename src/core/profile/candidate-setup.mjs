// candidate-setup.mjs — creates and validates the candidate user-layer files.
// Zero runtime dependencies; uses only node:fs, node:path, node:url plus
// the two foundation modules below.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { displayPath, userPath } from "../paths/workspace.mjs";
import { validate } from "./schema-validator.mjs";
import { parseYaml } from "./yaml.mjs";

// ---------------------------------------------------------------------------
// Repo-root default (this file lives at src/core/profile/)
// ---------------------------------------------------------------------------

const DEFAULT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// ---------------------------------------------------------------------------
// CANDIDATE_FILES — the mapping table
// ---------------------------------------------------------------------------

export const CANDIDATE_FILES = [
  {
    name: "profile",
    candidatePath: "candidate/profile.yml",
    templatePath: "templates/profile.example.yml",
    schemaPath: "config/profile.schema.json",
  },
  {
    name: "targeting",
    candidatePath: "candidate/targeting.yml",
    templatePath: "templates/targeting.example.yml",
    schemaPath: "config/targeting.schema.json",
  },
  {
    name: "evidence",
    candidatePath: "candidate/evidence.yml",
    templatePath: "templates/evidence.example.yml",
    schemaPath: "config/evidence.schema.json",
  },
  {
    name: "honesty",
    candidatePath: "candidate/honesty.yml",
    templatePath: "templates/honesty.example.yml",
    schemaPath: "config/honesty.schema.json",
  },
  {
    name: "form-defaults",
    candidatePath: "candidate/form-defaults.yml",
    templatePath: "templates/form-defaults.example.yml",
    schemaPath: "config/form-defaults.schema.json",
  },
];

// Optional schema-validated config. New scaffolds get these files, but existing
// workspaces do not fail loadCandidate/doctor if they are absent; the owning
// helper supplies defaults.
export const OPTIONAL_CANDIDATE_FILES = [
  {
    name: "modes",
    candidatePath: "candidate/modes.yml",
    templatePath: "templates/modes.example.yml",
    schemaPath: "config/modes.schema.json",
  },
];

// Freeform candidate files scaffolded alongside the schema-validated config above
// but NOT YAML/schema-validated by loadCandidate. SOURCE_RESUME.md is the source
// résumé seed that tailor-application falls back to when no prior tailored file
// exists (tailor-application STEP 4).
export const COPY_ONLY_CANDIDATE_FILES = [
  {
    name: "source-resume",
    candidatePath: "candidate/SOURCE_RESUME.md",
    templatePath: "templates/SOURCE_RESUME.md",
  },
];

// ---------------------------------------------------------------------------
// ensureCandidateFiles
// ---------------------------------------------------------------------------

/**
 * Ensure the candidate/ directory exists and copy each template to its
 * candidate path ONLY IF the candidate file does not already exist.
 *
 * @param {{ root?: string }} [options]
 * @returns {{ created: string[], existing: string[] }}
 *   Arrays of candidate paths relative to root.
 */
export function ensureCandidateFiles({ root = DEFAULT_ROOT } = {}) {
  const candidateDir = userPath({ repoRoot: root }, "candidate");
  mkdirSync(candidateDir, { recursive: true });

  const created = [];
  const existing = [];

  for (const entry of [
    ...CANDIDATE_FILES,
    ...OPTIONAL_CANDIDATE_FILES,
    ...COPY_ONLY_CANDIDATE_FILES,
  ]) {
    const dest = userPath({ repoRoot: root }, entry.candidatePath);
    const display = displayPath({ repoRoot: root }, entry.candidatePath);
    if (existsSync(dest)) {
      existing.push(display);
    } else {
      const src = join(root, entry.templatePath);
      copyFileSync(src, dest);
      created.push(display);
    }
  }

  return { created, existing };
}

// ---------------------------------------------------------------------------
// loadCandidate
// ---------------------------------------------------------------------------

/**
 * Read and validate each candidate file against its JSON Schema.
 *
 * @param {{ root?: string }} [options]
 * @returns {{ ok: boolean, files: Array<{ name, path, exists, valid, errors }> }}
 */
export function loadCandidate({ root = DEFAULT_ROOT } = {}) {
  const files = [];

  for (const entry of CANDIDATE_FILES) {
    const candidatePath = userPath({ repoRoot: root }, entry.candidatePath);
    const schemaPath = join(root, entry.schemaPath);
    const display = displayPath({ repoRoot: root }, entry.candidatePath);

    if (!existsSync(candidatePath)) {
      files.push({
        name: entry.name,
        path: display,
        exists: false,
        valid: false,
        errors: [{ path: "", message: "file missing" }],
      });
      continue;
    }

    const text = readFileSync(candidatePath, "utf8");
    const data = parseYaml(text);
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const { valid, errors } = validate(data, schema);

    files.push({
      name: entry.name,
      path: display,
      exists: true,
      valid,
      errors,
    });
  }

  const ok = files.every((f) => f.exists && f.valid);
  return { ok, files };
}

// ---------------------------------------------------------------------------
// lintPlaceholders
// ---------------------------------------------------------------------------

// Patterns to detect leftover placeholder strings (case-insensitive).
const PLACEHOLDER_PATTERNS = [
  /\bTODO\b/i,
  /\bTBD\b/i,
  /\bFIXME\b/i,
  /lorem ipsum/i,
  /\bplaceholder\b/i,
  /\[company\]/i,
  /\[role\]/i,
  /\[candidate\]/i,
  /\[insert[^\]]*\]/i,
  /\{company\}/i,
  /\{role\}/i,
  /\{candidate\}/i,
  /<insert[^>]*>/i,
  /<company>/i,
  /<role>/i,
  /<candidate>/i,
  /Jane Candidate/i,
  /jane@example\.com/i,
  /\+1-555-0100/i,
  /janecandidate/i,
];

/**
 * Scan each existing candidate file for leftover placeholder strings.
 *
 * @param {{ root?: string }} [options]
 * @returns {{ clean: boolean, findings: Array<{ file, line, text }> }}
 *   file is relative to root; line is 1-based; text is the trimmed line.
 */
export function lintPlaceholders({ root = DEFAULT_ROOT } = {}) {
  const findings = [];

  for (const entry of CANDIDATE_FILES) {
    const fullPath = userPath({ repoRoot: root }, entry.candidatePath);
    if (!existsSync(fullPath)) continue;
    const display = displayPath({ repoRoot: root }, entry.candidatePath);

    const text = readFileSync(fullPath, "utf8");
    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed === "") continue;
      for (const pattern of PLACEHOLDER_PATTERNS) {
        if (pattern.test(lines[i])) {
          findings.push({
            file: display,
            line: i + 1,
            text: trimmed,
          });
          break; // one finding per line
        }
      }
    }
  }

  return { clean: findings.length === 0, findings };
}

// ---------------------------------------------------------------------------
// checkTemplateLeftovers
// ---------------------------------------------------------------------------

// Literal strings that only appear in a candidate file because it still carries
// content copied verbatim from templates/*.example.yml — the "Jane Candidate"
// tech-demo persona and the evidence/honesty placeholder entries. Unlike
// PLACEHOLDER_PATTERNS above (broad residue words: TODO, TBD, lorem ipsum), each
// entry here names the exact template file it comes from, so the coverage test
// in tests/health-template-leftovers.test.mjs can assert the marker still
// appears in that template on disk — if a template edit drops or changes one of
// these values without updating this list, that test fails instead of the check
// silently going blind.
export const TEMPLATE_LEFTOVER_MARKERS = [
  { marker: "Jane Candidate", template: "templates/profile.example.yml" },
  { marker: "jane@example.com", template: "templates/profile.example.yml" },
  { marker: "+1-555-0100", template: "templates/profile.example.yml" },
  { marker: "janecandidate", template: "templates/profile.example.yml" },
  { marker: "Example Tool", template: "templates/honesty.example.yml" },
  { marker: "Adjacent Tool", template: "templates/honesty.example.yml" },
  { marker: "Tool Never Used", template: "templates/honesty.example.yml" },
  {
    marker: "Describe the real project, scope, stakeholders, and shipped result.",
    template: "templates/evidence.example.yml",
  },
  { marker: "Add measurable impact if true.", template: "templates/evidence.example.yml" },
];

// Walks a parsed YAML value, yielding [dotted.key.path, leafStringValue] pairs.
// Array entries get a numeric index segment (e.g. "tools.confirmed[0]").
function* flattenLeaves(value, prefix) {
  if (typeof value === "string") {
    yield [prefix, value];
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      yield* flattenLeaves(value[i], `${prefix}[${i}]`);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      yield* flattenLeaves(child, prefix ? `${prefix}.${key}` : key);
    }
  }
}

/**
 * Scan each existing candidate file for values that still match a known
 * template marker. Unlike lintPlaceholders, findings never carry the real
 * candidate value or surrounding line — only the file, the YAML key path, and
 * the matched marker itself, so a report never leaks candidate PII or comp.
 *
 * @param {{ root?: string }} [options]
 * @returns {{ clean: boolean, findings: Array<{ file, key, marker }> }}
 *   file is relative to root; key is a dotted YAML path.
 */
export function checkTemplateLeftovers({ root = DEFAULT_ROOT } = {}) {
  const findings = [];

  for (const entry of CANDIDATE_FILES) {
    const fullPath = userPath({ repoRoot: root }, entry.candidatePath);
    if (!existsSync(fullPath)) continue;
    const display = displayPath({ repoRoot: root }, entry.candidatePath);

    let data;
    try {
      data = parseYaml(readFileSync(fullPath, "utf8"));
    } catch {
      continue; // unparseable → let schema validation speak
    }

    for (const [key, leaf] of flattenLeaves(data, "")) {
      for (const { marker } of TEMPLATE_LEFTOVER_MARKERS) {
        if (leaf.includes(marker)) {
          findings.push({ file: display, key, marker });
          break; // one finding per leaf
        }
      }
    }
  }

  return { clean: findings.length === 0, findings };
}
