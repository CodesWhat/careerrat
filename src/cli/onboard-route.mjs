// onboard-route.mjs — M1 of the paid-POC journey: the non-AI onboarding
// wizard's HTTP surface. Split out of tracker-dev.mjs the same way P0-4's
// skill-run-route.mjs was (see that file's header comment): `addRoute` is
// exactly the mount point for this, and `readJsonBodyCapped`/`sendJson` are
// imported from skill-run-route.mjs rather than duplicated.
//
// Everything here is deliberately AI-free: it seeds candidate/ files from
// templates, parses a plain-text/markdown resume with the zero-dep
// resume-parser.mjs (never calls a model), validates + writes candidate YAML
// through the existing schema-validator.mjs/yaml.mjs primitives, and stores a
// BYOK Anthropic key locally (ai-env.mjs). The companion byte-static page is
// src/core/onboarding/onboard-page.mjs, mounted at GET /onboard by
// tracker-dev.mjs.
//
// mountOnboardRoutes({ addRoute, repoRoot, env }) registers:
//
//   GET  /api/onboard/state              candidate-file + key + config status
//   POST /api/onboard/init               ensureCandidateFiles() (never overwrites)
//   POST /api/onboard/resume             parse a pasted/loaded resume (2MB cap)
//   POST /api/onboard/candidate/:name    merge+validate+write one candidate file
//                                        (one concrete route per known name —
//                                        see CANDIDATE_ROUTE_ENTRIES below)
//   POST /api/onboard/evidence-seed      dedupe-merge claims into evidence.yml
//   POST /api/onboard/write-config       same work as `rolester ingest --write-config`
//   POST /api/settings/ai-key            store a BYOK Anthropic key locally
//   GET  /api/settings/ai                report the resolved AI route (no key value)
//
// WRITE-SCOPE NOTE: storage-adapter.mjs's readFile/writeFile are scoped to
// `workspace/` only (see that file's header) — they cannot address
// candidate/config paths. Candidate/config writes below go straight to
// gate-writer.mjs's atomicWriteFile() via userPath(), which is the exact same
// primitive the adapter's writeFile delegates to internally, and the same
// pattern gate-writer.mjs's own callers already use for candidate YAML edits.
//
// HARD CONSTRAINT: this wizard never writes workspace/setup-state.json. That
// file is agent-write-only by contract — ingest-profile (the AI-driven
// interview) owns it exclusively. The non-AI wizard seeds/validates candidate
// files but never claims to have run the interview.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeLocalAiKey } from "../core/ai/ai-env.mjs";
import { resolveAIRoute } from "../core/ai/call-ai.mjs";
import { displayPath, userPath } from "../core/paths/workspace.mjs";
import {
  CANDIDATE_FILES,
  COPY_ONLY_CANDIDATE_FILES,
  ensureCandidateFiles,
  loadCandidate,
  OPTIONAL_CANDIDATE_FILES,
} from "../core/profile/candidate-setup.mjs";
import { atomicWriteFile } from "../core/profile/gate-writer.mjs";
import { renderLocalAgents } from "../core/profile/generate-agents.mjs";
import { buildSearchSources } from "../core/profile/generate-search-sources.mjs";
import {
  deriveEvidenceSeed,
  deriveProfileSeed,
  parseResume,
} from "../core/profile/resume-parser.mjs";
import { validate } from "../core/profile/schema-validator.mjs";
import { parseYaml, stringifyYaml } from "../core/profile/yaml.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 1024 * 1024; // 1MB — same cap skill-run-route.mjs uses.
const RESUME_MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB — resume text can be long.

// Concrete candidate-file routes: CANDIDATE_FILES (profile, targeting,
// evidence, honesty, form-defaults) plus the one OPTIONAL_CANDIDATE_FILES
// entry the spec calls out by name (modes). addRoute() is a flat
// method+path Map (see tracker-dev.mjs), not a param router, so ":name" is
// realized as one concrete route per known name rather than a wildcard — any
// other name simply 404s via the server's existing fallback.
const CANDIDATE_ROUTE_ENTRIES = [
  ...CANDIDATE_FILES,
  ...OPTIONAL_CANDIDATE_FILES.filter((entry) => entry.name === "modes"),
];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// Detect resume text that is actually binary (a PDF/DOCX read client-side as
// text, per onboard-page.mjs's FileReader.readAsText hint). Two tells: literal
// NUL bytes (never legitimate in text), or a high ratio of U+FFFD replacement
// characters (what a lossy UTF-8 decode of binary data produces). 1% is a
// deliberately low bar — real resumes have essentially zero replacement
// characters; binary garbage has them throughout.
export function looksBinary(text) {
  if (text.indexOf("\0") !== -1) return true;
  if (!text.length) return false;
  const replacementCount = (text.match(/\uFFFD/g) || []).length;
  return replacementCount / text.length > 0.01;
}

// Deep-merge `patch` onto `base`: object keys merge recursively: an array in
// `patch` REPLACES the corresponding array in `base` wholesale (never
// element-wise merged); any other `patch` value (scalar, or an object where
// `base`'s value isn't a plain object) simply replaces `base`'s value. This
// is the exact "posted values win; arrays replace, objects merge" contract
// the onboarding wizard's per-field submits rely on: posting one changed
// field never clobbers sibling fields the user already saved.
export function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (patch !== null && typeof patch === "object") {
    const baseObj = isPlainObject(base) ? base : {};
    const out = { ...baseObj };
    for (const [key, value] of Object.entries(patch)) {
      if (Array.isArray(value)) {
        out[key] = value.slice();
      } else if (value !== null && typeof value === "object" && isPlainObject(baseObj[key])) {
        out[key] = deepMerge(baseObj[key], value);
      } else if (value !== null && typeof value === "object") {
        out[key] = deepMerge({}, value);
      } else {
        out[key] = value;
      }
    }
    return out;
  }
  return patch;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Assign the next unused claim id. Prefers the caller's own id (from a
// resume-derived seed, e.g. "resume-003") if it isn't already taken;
// otherwise mints "seed-NNN", skipping any id already in `usedIds`.
function nextAvailableId(usedIds, preferred) {
  if (preferred && !usedIds.has(preferred)) return preferred;
  let n = 1;
  let candidate = `seed-${String(n).padStart(3, "0")}`;
  while (usedIds.has(candidate)) {
    n++;
    candidate = `seed-${String(n).padStart(3, "0")}`;
  }
  return candidate;
}

// Read a candidate file's current YAML doc, falling back to its template
// default when the candidate file doesn't exist yet — the same "seed from
// template" behavior ensureCandidateFiles() copies onto disk, just read
// in-memory here so a merge always has a valid base to start from.
function readBaseDoc(repoRoot, entry, candidatePath) {
  const text = existsSync(candidatePath)
    ? readFileSync(candidatePath, "utf8")
    : readFileSync(join(repoRoot, entry.templatePath), "utf8");
  return parseYaml(text) || {};
}

function readSchema(repoRoot, entry) {
  return JSON.parse(readFileSync(join(repoRoot, entry.schemaPath), "utf8"));
}

function writeYamlDoc(candidatePath, doc) {
  mkdirSync(dirname(candidatePath), { recursive: true });
  atomicWriteFile(candidatePath, `${stringifyYaml(doc)}\n`);
}

// ---------------------------------------------------------------------------
// mountOnboardRoutes
// ---------------------------------------------------------------------------

export function mountOnboardRoutes({ addRoute, repoRoot, env = process.env }) {
  const pathCtx = { repoRoot };

  // -------------------------------------------------------------------------
  // GET /api/onboard/state — report-only; never runs ensureCandidateFiles.
  // -------------------------------------------------------------------------
  addRoute("GET", "/api/onboard/state", (_req, res) => {
    const load = loadCandidate({ root: repoRoot });
    const files = load.files.map(({ name, exists, valid, errors }) => ({
      name,
      exists,
      valid,
      errors,
    }));
    const sourceResumeEntry = COPY_ONLY_CANDIDATE_FILES.find((f) => f.name === "source-resume");
    sendJson(res, 200, {
      files,
      sourceResumePresent: existsSync(userPath(pathCtx, sourceResumeEntry.candidatePath)),
      keyConfigured: resolveAIRoute(env).type !== "none",
      searchSourcesPresent: existsSync(userPath(pathCtx, "config/search-sources.yml")),
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/onboard/init — template seeding, never overwrites.
  // -------------------------------------------------------------------------
  addRoute("POST", "/api/onboard/init", (_req, res) => {
    const result = ensureCandidateFiles({ root: repoRoot });
    sendJson(res, 200, result);
  });

  // -------------------------------------------------------------------------
  // POST /api/onboard/resume — { text, save?: boolean }
  // -------------------------------------------------------------------------
  addRoute("POST", "/api/onboard/resume", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, RESUME_MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return;
    }

    const text = typeof body?.text === "string" ? body.text : "";
    if (!text.trim()) {
      sendJson(res, 400, { error: "body.text is required" });
      return;
    }
    if (looksBinary(text)) {
      sendJson(res, 400, {
        error: "PDF/DOCX not supported — export resume as text or markdown",
      });
      return;
    }

    const parsed = parseResume(text);
    const profileSeed = deriveProfileSeed(parsed);
    const evidenceSeed = deriveEvidenceSeed(parsed);
    const sections = {
      experience: parsed.sections.experience.length,
      education: parsed.sections.education.length,
      skills: parsed.sections.skills.length,
      projects: parsed.sections.projects.length,
      other: parsed.sections.other.length,
    };

    if (body?.save) {
      const entry = COPY_ONLY_CANDIDATE_FILES.find((f) => f.name === "source-resume");
      const dest = userPath(pathCtx, entry.candidatePath);
      mkdirSync(dirname(dest), { recursive: true });
      atomicWriteFile(dest, text);
    }

    sendJson(res, 200, { profileSeed, evidenceSeed, sections });
  });

  // -------------------------------------------------------------------------
  // POST /api/onboard/candidate/:name — { data } deep-merge, validate, write.
  // -------------------------------------------------------------------------
  for (const entry of CANDIDATE_ROUTE_ENTRIES) {
    addRoute("POST", `/api/onboard/candidate/${entry.name}`, async (req, res) => {
      let body;
      try {
        body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
      } catch (err) {
        sendJson(res, err.status || 400, { error: err.message });
        return;
      }

      const patch = body?.data;
      if (!isPlainObject(patch)) {
        sendJson(res, 400, {
          ok: false,
          errors: [{ path: "", message: "body.data must be an object" }],
        });
        return;
      }

      const candidatePath = userPath(pathCtx, entry.candidatePath);
      const base = readBaseDoc(repoRoot, entry, candidatePath);
      const merged = deepMerge(base, patch);

      const schema = readSchema(repoRoot, entry);
      const { valid, errors } = validate(merged, schema);
      if (!valid) {
        sendJson(res, 400, { ok: false, errors });
        return;
      }

      writeYamlDoc(candidatePath, merged);
      sendJson(res, 200, { ok: true });
    });
  }

  // -------------------------------------------------------------------------
  // POST /api/onboard/evidence-seed — { claims: [{id?, claim, evidence}] }
  // -------------------------------------------------------------------------
  addRoute("POST", "/api/onboard/evidence-seed", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return;
    }

    const posted = Array.isArray(body?.claims) ? body.claims : null;
    if (!posted) {
      sendJson(res, 400, { error: "body.claims must be an array" });
      return;
    }

    const entry = CANDIDATE_FILES.find((f) => f.name === "evidence");
    const candidatePath = userPath(pathCtx, entry.candidatePath);
    const doc = readBaseDoc(repoRoot, entry, candidatePath);
    const existingClaims = Array.isArray(doc.claims) ? doc.claims : [];

    const existingClaimTexts = new Set(existingClaims.map((c) => String(c?.claim ?? "").trim()));
    const usedIds = new Set(existingClaims.map((c) => String(c?.id ?? "")));

    const added = [];
    let skipped = 0;
    for (const raw of posted) {
      const claimText = String(raw?.claim ?? "").trim();
      if (!claimText || existingClaimTexts.has(claimText)) {
        skipped++;
        continue;
      }
      existingClaimTexts.add(claimText);
      const id = nextAvailableId(usedIds, raw?.id ? String(raw.id) : null);
      usedIds.add(id);
      added.push({ id, claim: claimText, evidence: String(raw?.evidence ?? "") });
    }

    const merged = { ...doc, claims: [...existingClaims, ...added] };
    const schema = readSchema(repoRoot, entry);
    const { valid, errors } = validate(merged, schema);
    if (!valid) {
      sendJson(res, 400, { ok: false, errors });
      return;
    }

    writeYamlDoc(candidatePath, merged);
    sendJson(res, 200, { ok: true, added: added.length, skipped, total: merged.claims.length });
  });

  // -------------------------------------------------------------------------
  // POST /api/onboard/write-config — mirrors `rolester ingest --write-config`.
  // -------------------------------------------------------------------------
  addRoute("POST", "/api/onboard/write-config", (_req, res) => {
    const profilePath = userPath(pathCtx, "candidate/profile.yml");
    const targetingPath = userPath(pathCtx, "candidate/targeting.yml");
    if (!existsSync(profilePath) || !existsSync(targetingPath)) {
      sendJson(res, 400, {
        error: "candidate/profile.yml and candidate/targeting.yml are required first",
      });
      return;
    }

    const profileEntry = CANDIDATE_FILES.find((f) => f.name === "profile");
    const targetingEntry = CANDIDATE_FILES.find((f) => f.name === "targeting");
    const profile = parseYaml(readFileSync(profilePath, "utf8"));
    const targeting = parseYaml(readFileSync(targetingPath, "utf8"));
    const profileCheck = validate(profile, readSchema(repoRoot, profileEntry));
    const targetingCheck = validate(targeting, readSchema(repoRoot, targetingEntry));
    if (!profileCheck.valid || !targetingCheck.valid) {
      sendJson(res, 400, {
        error: "candidate/profile.yml and/or candidate/targeting.yml do not validate",
        profileErrors: profileCheck.errors,
        targetingErrors: targetingCheck.errors,
      });
      return;
    }

    const sources = buildSearchSources(targeting, profile);
    const searchConfigPath = userPath(pathCtx, "config/search-sources.yml");
    mkdirSync(dirname(searchConfigPath), { recursive: true });
    atomicWriteFile(searchConfigPath, `${stringifyYaml(sources)}\n`);

    const template = readFileSync(join(repoRoot, "templates/AGENTS.md"), "utf8");
    const agentsPath = userPath(pathCtx, "candidate/AGENTS.md");
    mkdirSync(dirname(agentsPath), { recursive: true });
    atomicWriteFile(agentsPath, renderLocalAgents({ template, profile, targeting }));

    sendJson(res, 200, {
      written: [
        displayPath(pathCtx, "config/search-sources.yml"),
        displayPath(pathCtx, "candidate/AGENTS.md"),
      ],
    });
  });

  // -------------------------------------------------------------------------
  // BYOK key storage
  // -------------------------------------------------------------------------
  addRoute("POST", "/api/settings/ai-key", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return;
    }
    try {
      writeLocalAiKey({ repoRoot, apiKey: body?.apiKey, env });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    sendJson(res, 200, { ok: true, route: "byok" });
  });

  addRoute("GET", "/api/settings/ai", (_req, res) => {
    sendJson(res, 200, {
      route: resolveAIRoute(env).type,
      keyPresent: !!env.ANTHROPIC_API_KEY,
    });
  });
}
