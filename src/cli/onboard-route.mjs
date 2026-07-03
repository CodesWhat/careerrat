// onboard-route.mjs — M1 of the paid-POC journey: the non-AI onboarding
// wizard's HTTP surface. Split out of tracker-dev.mjs the same way P0-4's
// skill-run-route.mjs was (see that file's header comment): `addRoute` is
// exactly the mount point for this, and `readJsonBodyCapped`/`sendJson` are
// imported from skill-run-route.mjs rather than duplicated.
//
// Everything here was originally deliberately AI-free (M1): it seeds
// candidate/ files from templates, parses a plain-text/markdown resume with
// the zero-dep resume-parser.mjs (never calls a model), validates + writes
// candidate YAML through the existing schema-validator.mjs/yaml.mjs
// primitives, and stores a BYOK Anthropic key locally (ai-env.mjs). The
// companion byte-static page is src/core/onboarding/onboard-page.mjs,
// mounted at GET /onboard by tracker-dev.mjs. M8 adds exactly one AI-touching
// route here (POST /api/onboard/resume-ai, for the PDF/image case
// resume-parser.mjs can't handle) rather than a separate file, since it's the
// same résumé-intake concern as the existing POST /api/onboard/resume and
// mirrors that route's response shape byte-for-byte.
//
// mountOnboardRoutes({ addRoute, repoRoot, env }) registers:
//
//   GET  /api/onboard/state              candidate-file + key + config status
//   POST /api/onboard/init               ensureCandidateFiles() (never overwrites)
//   POST /api/onboard/resume             parse a pasted/loaded resume (2MB cap)
//   POST /api/onboard/resume-ai          M8 — AI-extract a PDF/image resume (5MB
//                                        cap, raw body bytes, ?name=<filename>)
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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { writeLocalAiKey } from "../core/ai/ai-env.mjs";
import { resolveAIRoute } from "../core/ai/call-ai.mjs";
import { runSkillStream as defaultRunSkillStream } from "../core/ai/skill-runtime.mjs";
import { runStructuredOneshot } from "../core/ai/structured-oneshot.mjs";
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
import { readJsonBodyCapped, readRawBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 1024 * 1024; // 1MB — same cap skill-run-route.mjs uses.
const RESUME_MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB — resume text can be long.

// POST /api/onboard/resume-ai's binary-upload cap (frozen M8 contract: 5MB)
// and the extensions it accepts — PDF/image only; .txt/.md keep using the
// existing zero-AI POST /api/onboard/resume above.
const RESUME_AI_MAX_BYTES = 5 * 1024 * 1024;
const RESUME_AI_ALLOWED_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp"]);
const RESUME_EXTRACT_SCHEMA_PATH = "config/resume-extract.schema.json";

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

// The curated subset of candidate files the M7 Settings page (apps/web/src/
// settings/SettingsPage.jsx) reads and writes. GET /api/onboard/state below
// includes parsed data for exactly these files — see that route's own
// comment for why this extends the existing state read instead of adding a
// new route.
const SETTINGS_DATA_FILES = ["profile", "targeting", "form-defaults", "modes"];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// Detect resume text that is actually binary (a PDF/DOCX read client-side as
// text, per onboard-page.mjs's FileReader.readAsText hint). Two tells: literal
// NUL bytes (never legitimate in text), or a high ratio of U+FFFD replacement
// characters (what a lossy UTF-8 decode of binary data produces). 1% is a
// deliberately low bar — real resumes have essentially zero replacement
// characters; binary garbage has them throughout.
// Traversal-safe filename sanitizer for POST /api/onboard/resume-ai's saved
// upload path. Strips any directory component first (handles both "/" and
// "\" separators, defeating a `../../etc/passwd`-shaped `name` before the
// character filter even runs), then replaces every character outside
// [A-Za-z0-9._-], then strips leading dots (so a bare ".." or ".hidden"
// can't survive as a hidden/parent-referencing segment). Never returns an
// empty string — falls back to "upload" so a pathologically-named upload
// still lands somewhere sane.
export function sanitizeUploadFilename(name) {
  const base =
    String(name || "")
      .split(/[/\\]/)
      .pop() || "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned || "upload";
}

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

export function mountOnboardRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  // Dependency-injected the same way tracker-dev.mjs's mountSkillRunRoute
  // wires runSkillStream — so POST /api/onboard/resume-ai's tests can drive
  // a hand-rolled MOCKED runtime (happy/retry-then-ok/422/413/501) without
  // touching the real @anthropic-ai/claude-agent-sdk devDependency.
  runSkillStream = defaultRunSkillStream,
}) {
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

    // Settings-page prefill data — parsed current (or template-default, via
    // readBaseDoc()'s existing fallback) YAML for the curated subset of
    // candidate files the M7 Settings surface reads (see
    // SETTINGS_DATA_FILES above). This extends the existing state read
    // rather than adding a parallel GET /api/onboard/candidate/:name route:
    // the M7 design explicitly prefers extending state when it's missing a
    // needed read, over growing the route surface.
    const data = {};
    for (const name of SETTINGS_DATA_FILES) {
      const entry = CANDIDATE_ROUTE_ENTRIES.find((f) => f.name === name);
      if (!entry) continue;
      const candidatePath = userPath(pathCtx, entry.candidatePath);
      try {
        data[name] = readBaseDoc(repoRoot, entry, candidatePath);
      } catch {
        // Neither the candidate file nor its template exists in this
        // repoRoot (e.g. a minimal test fixture, or a workspace mid-setup
        // before ensureCandidateFiles() has run) — degrade to an empty
        // prefill rather than 500ing the whole state read.
        data[name] = {};
      }
    }

    sendJson(res, 200, {
      files,
      data,
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
  // POST /api/onboard/resume-ai?name=<filename> — raw PDF/image bytes.
  //
  // Frozen M8 contract: the request body IS the file (no JSON envelope,
  // unlike every other route in this file) — `name` travels as a query
  // param purely so the server knows the original filename/extension.
  // Saves under workspace/intake/resume-uploads/, then runs the new
  // resume-extract skill one-shot (tools: ["Read"] only) over the embedded
  // runtime, buffers its reply, and parses/validates/retries via the shared
  // structured-oneshot helper (src/core/ai/structured-oneshot.mjs — also
  // used by POST /api/assist/suggest). The success response is shaped
  // identically to POST /api/onboard/resume's above (profileSeed/
  // evidenceSeed/sections) plus `source: "ai"`, so the wizard's review/edit
  // UI is 100% parser-agnostic about which path produced the seed.
  // -------------------------------------------------------------------------
  addRoute("POST", "/api/onboard/resume-ai", async (req, res) => {
    const requestUrl = new URL(req.url, "http://127.0.0.1");
    const name = (requestUrl.searchParams.get("name") || "").trim();
    if (!name) {
      sendJson(res, 400, { error: "?name=<filename> is required" });
      return;
    }

    const ext = extname(name).toLowerCase();
    if (!RESUME_AI_ALLOWED_EXTENSIONS.has(ext)) {
      sendJson(res, 400, {
        error:
          `unsupported file type "${ext || name}" — resume-ai accepts PDF/image uploads only ` +
          "(.pdf .png .jpg .jpeg .webp); .txt/.md resumes go through POST /api/onboard/resume",
      });
      return;
    }

    let bytes;
    try {
      bytes = await readRawBodyCapped(req, RESUME_AI_MAX_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return;
    }
    if (!bytes.length) {
      sendJson(res, 400, { error: "request body is empty" });
      return;
    }

    const savedRelPath = `workspace/intake/resume-uploads/${Date.now()}-${sanitizeUploadFilename(name)}`;
    const savedPath = userPath(pathCtx, savedRelPath);
    mkdirSync(dirname(savedPath), { recursive: true });
    // Raw bytes (a PDF/image) — never atomicWriteFile, which hardcodes utf8
    // and would corrupt binary data.
    writeFileSync(savedPath, bytes);

    const schema = JSON.parse(readFileSync(join(repoRoot, RESUME_EXTRACT_SCHEMA_PATH), "utf8"));

    // One attempt of the one-shot skill run: Read-only tool surface, the
    // saved file's path as input (a corrective addendum on a retry — see
    // structured-oneshot.mjs's own header comment for why `invoke` throwing
    // here is deliberately NOT caught inside runStructuredOneshot). Buffers
    // every `assistant` event's text blocks in order, exactly like
    // skill-runtime.mjs's own header comment describes for a driven
    // (non-SSE-passthrough) run.
    async function invokeResumeExtract({ correction }) {
      let rawText = "";
      await runSkillStream({
        skill: "resume-extract",
        input: correction
          ? `Read the file at this exact path: ${savedPath}\n\n${correction}`
          : { path: savedPath },
        repoRoot,
        env,
        tools: ["Read"],
        onEvent: (evt) => {
          if (evt.type !== "assistant") return;
          for (const block of evt.data?.message?.content ?? []) {
            if (block?.type === "text" && typeof block.text === "string") {
              rawText += block.text;
            }
          }
        },
      });
      return rawText;
    }

    let outcome;
    try {
      outcome = await runStructuredOneshot({ schema, maxRetries: 1, invoke: invokeResumeExtract });
    } catch (err) {
      // runSkillStream rejects (before ever calling onEvent) for a config
      // problem — no AI route, the skill not allowlisted, or the SDK
      // devDependency missing. Every one of those is "the AI assist isn't
      // available," which is a 501 by the standing convention ("No API key
      // → assists return 501") — never the generic 400 skill-run-route.mjs
      // uses for its own SKILL_NOT_ALLOWED/NO_AI_ROUTE mapping, since this
      // route has no not-a-skill-name/bad-request case to distinguish it
      // from.
      const status =
        err.code === "SDK_NOT_INSTALLED" ||
        err.code === "NO_AI_ROUTE" ||
        err.code === "SKILL_NOT_ALLOWED"
          ? 501
          : 500;
      sendJson(res, status, { error: err.message });
      return;
    }

    if (!outcome.ok) {
      // Expected failure mode (the model never produced valid structured
      // output after one retry) — the wizard's fallback is the existing
      // paste-text textarea, keyed off this exact status per the frozen
      // contract.
      sendJson(res, 422, {
        error: "could not extract a usable profile from this file after a retry",
        raw: outcome.raw,
      });
      return;
    }

    const claims = (outcome.data.claims || []).map((c, i) => ({
      id: `resume-${String(i + 1).padStart(3, "0")}`,
      claim: String(c?.claim ?? ""),
      evidence: String(c?.evidence ?? ""),
    }));

    sendJson(res, 200, {
      profileSeed: { candidate: outcome.data.candidate || {} },
      evidenceSeed: { claims },
      sections: outcome.data.sections || {},
      source: "ai",
    });
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
