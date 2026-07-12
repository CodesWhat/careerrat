// onboard-route.mjs — M1 of the paid-POC journey: the non-AI onboarding
// wizard's HTTP surface. Split out of tracker-dev.mjs the same way P0-4's
// skill-run-route.mjs was (see that file's header comment): `addRoute` is
// exactly the mount point for this, and `readJsonBodyCapped`/`sendJson` are
// imported from skill-run-route.mjs rather than duplicated.
//
// The app onboarding surface is SQLite-primary: POST /api/onboard/init creates
// candidate setup rows, candidate/profile/targeting/settings writes update
// those rows, and YAML is materialized only by write-config as compatibility
// output. The deterministic resume parser still handles plain-text/markdown
// resumes without a model, while BYOK AI routes are optional assists. The
// companion byte-static page is src/core/onboarding/onboard-page.mjs, mounted
// at GET /onboard by tracker-dev.mjs. M8 adds exactly one AI-touching
// route here (POST /api/onboard/resume-ai, for the PDF/image case
// resume-parser.mjs can't handle) rather than a separate file, since it's the
// same résumé-intake concern as the existing POST /api/onboard/resume. The
// route returns the shared bounded-AI envelope, while the web API wrapper
// unwraps body.data for the wizard's existing seed shape.
//
// mountOnboardRoutes({ addRoute, repoRoot, env }) registers:
//
//   GET  /api/onboard/state              candidate-file + key + config status
//   GET  /api/onboard/draft              resumable wizard step + unsaved UI seeds
//   POST /api/onboard/draft              persist resumable wizard step + unsaved UI seeds
//   POST /api/onboard/init               ensureCandidateFiles() (never overwrites)
//   POST /api/onboard/resume             parse a pasted/loaded resume (2MB cap)
//   POST /api/onboard/resume-ai          M8 — AI-extract a PDF/image resume (5MB
//                                        cap, raw body bytes, ?name=<filename>)
//   POST /api/onboard/candidate/:name    merge+validate+write one candidate setup doc
//                                        (one concrete route per known name —
//                                        see CANDIDATE_ROUTE_ENTRIES below)
//   POST /api/onboard/evidence-seed      dedupe-merge claims into evidence.yml
//   POST /api/onboard/write-config       export compatibility candidate/source files
//   POST /api/onboard/quick-start        search-ready DB setup -> durable local first search
//   POST /api/settings/ai-key            store a BYOK Anthropic key locally
//   POST /api/settings/ai-key/validate   validate then store a BYOK Anthropic key
//   POST /api/settings/ai-key/check      validate the currently configured AI route
//   GET  /api/settings/ai                report the resolved AI route (no key value)
//   GET  /api/settings/usage             summarize local AI token spend by feature
//
// WRITE-SCOPE NOTE: normal onboarding writes go through src/core/db/verbs/
// candidate.mjs. Legacy YAML writes in this file are compatibility fallback
// paths for non-DB workspaces and explicit write-config exports.
//
// HARD CONSTRAINT: this wizard never writes workspace/setup-state.json. That
// file is agent-write-only by contract — ingest-profile (the AI-driven
// interview) owns it exclusively. The non-AI wizard seeds/validates candidate
// files but never claims to have run the interview.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { writeLocalAiKey } from "../core/ai/ai-env.mjs";
import { runBoundedAI } from "../core/ai/bounded-ai.mjs";
import { resolveAIRoute } from "../core/ai/call-ai.mjs";
import { validateAiProviderKey } from "../core/ai/provider-validation.mjs";
import { runSkillStream as defaultRunSkillStream } from "../core/ai/skill-runtime.mjs";
import { readUsageEvents, summarizeUsageEvents } from "../core/ai/usage-log.mjs";
import { dbExists } from "../core/db/connection.mjs";
import {
  candidateArtifactExists,
  candidateArtifactPut,
  candidateConfigGet,
  candidateConfigPatch,
  candidateEvidenceMerge,
  candidateSetupInitialize,
  publicSyncPreferenceGet,
  publicSyncPreferenceSet,
  sourceConfigGet,
  sourceConfigPut,
} from "../core/db/verbs.mjs";
import { buildDeepIngestViewModel } from "../core/deep-ingest/view-model.mjs";
import {
  countDeterministicSources,
  latestSourcingRunForUi,
  runFirstSearchInBackground,
  startFirstSearchRun,
} from "../core/onboarding/first-search-run.mjs";
import {
  extractDocxResumeText as defaultExtractDocxResumeText,
  looksLikeUsableResumeText,
  normalizeDocxResumeText,
} from "../core/onboarding/resume-docx.mjs";
import { displayPath, userPath } from "../core/paths/workspace.mjs";
import {
  CANDIDATE_FILES,
  COPY_ONLY_CANDIDATE_FILES,
  loadCandidate,
  OPTIONAL_CANDIDATE_FILES,
} from "../core/profile/candidate-setup.mjs";
import { atomicWriteFile } from "../core/profile/gate-writer.mjs";
import { renderLocalAgents } from "../core/profile/generate-agents.mjs";
import { buildSearchSources } from "../core/profile/generate-search-sources.mjs";
import {
  deriveEvidenceSeed,
  deriveProfileSeed,
  deriveTargetingSeed,
  parseResume,
} from "../core/profile/resume-parser.mjs";
import { validate } from "../core/profile/schema-validator.mjs";
import { parseYaml, stringifyYaml } from "../core/profile/yaml.mjs";
// M8 additive (Builder B, wizard UI): resolveLogoTokens is already exported
// by logo-route.mjs for exactly this reuse — see its own header comment.
// Reused here (not re-derived) so GET /api/onboard/state can report logo.dev
// image/search capability WITHOUT ever echoing credential values back (same
// "never echoed" convention as keyConfigured/the AI key below).
import { resolveLogoTokens } from "./logo-route.mjs";
import { readJsonBodyCapped, readRawBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 1024 * 1024; // 1MB — same cap skill-run-route.mjs uses.
const RESUME_MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB — resume text can be long.
const ONBOARDING_DRAFT_PATH = ".internal/onboarding-draft.json";
const ONBOARDING_DRAFT_MAX_STEP = 7;

// POST /api/onboard/resume-ai's binary-upload cap (frozen M8 contract: 5MB)
// and the extensions it accepts — PDF/image only; .txt/.md keep using the
// existing zero-AI POST /api/onboard/resume above.
const RESUME_AI_MAX_BYTES = 5 * 1024 * 1024;
const RESUME_AI_ALLOWED_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp"]);
const RESUME_DOCX_MAX_BYTES = 5 * 1024 * 1024;
const RESUME_DOCX_ALLOWED_EXTENSIONS = new Set([".docx"]);
const RESUME_EXTRACT_SCHEMA_PATH = "config/resume-extract.schema.json";
const RESUME_AI_LABELS = Object.freeze({
  skill: "resume-extract",
  action: "resume-ai",
  operation: "onboard.resume-ai",
});
const RESUME_AI_MANUAL = Object.freeze({
  available: true,
  reason: "resume-ai-unavailable",
  action: "paste-resume-text",
});
const TARGETING_PRIORITY_ALIASES = new Map([
  ["primary", "primary"],
  ["secondary", "secondary"],
  ["adjacent", "secondary"],
  ["stretch", "stretch"],
  ["oe", "oe"],
]);

// Concrete candidate-file routes: CANDIDATE_FILES (profile, targeting,
// evidence, honesty, form-defaults) plus the one OPTIONAL_CANDIDATE_FILES
// entry the spec calls out by name (modes). addRoute() is a flat
// method+path Map (see tracker-dev.mjs), not a param router, so ":name" is
// realized as one concrete route per known name rather than a wildcard — any
// other name simply 404s via the server's existing fallback.
// M8 additive (Builder B, wizard UI): a legacy write route for
// candidate/automation.yml#integrations.{logo_dev_token,logo_dev_secret_key}
// — image lookup now has a built-in publishable default, while the secret key
// remains optional for logo.dev Brand Search autocomplete. Deliberately NOT
// added to candidate-setup.mjs's OPTIONAL_CANDIDATE_FILES/ensureCandidateFiles():
// automation.yml's absence is load-bearing ("nothing automated" — see the
// template's own header), and POST /api/onboard/init must keep not
// scaffolding it. This entry exists ONLY so the one extra
// POST /api/onboard/candidate/automation route below can validate+merge+write
// it on demand, reusing readBaseDoc/deepMerge/writeYamlDoc exactly like every
// other candidate file — automation.yml's own schema is additionalProperties
// permissive enough (see config/automation.schema.json) that merging in a new
// top-level `integrations` key never trips validation.
const AUTOMATION_ROUTE_ENTRY = {
  name: "automation",
  candidatePath: "candidate/automation.yml",
  templatePath: "templates/automation.example.yml",
  schemaPath: "config/automation.schema.json",
};

const APPLICATION_LIMITS_COMPAT_ENTRY = {
  name: "application-limits",
  candidatePath: "candidate/application-limits.yml",
};

const CANDIDATE_ROUTE_ENTRIES = [
  ...CANDIDATE_FILES,
  ...OPTIONAL_CANDIDATE_FILES.filter((entry) => entry.name === "modes"),
  AUTOMATION_ROUTE_ENTRY,
];

// The curated subset of candidate files the M7 Settings page (apps/web/src/
// settings/SettingsPage.jsx) reads and writes. GET /api/onboard/state below
// includes parsed data for exactly these files — see that route's own
// comment for why this extends the existing state read instead of adding a
// new route.
const SETTINGS_DATA_FILES = ["profile", "targeting", "form-defaults", "modes"];
const DEFAULT_PUBLIC_SYNC_PREFERENCE = Object.freeze({
  enabled: true,
  source: "default",
  updatedAt: null,
});

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

const RESUME_CONTACT_FIELDS = [
  "full_name",
  "email",
  "phone",
  "location",
  "linkedin",
  "github",
  "portfolio",
];

function nullableText(value) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

function normalizeLineItems(value) {
  return normalizeDocxResumeText(value)
    .split("\n")
    .map((line) => line.replace(/^[\s\-*•]+/, "").trim())
    .filter(Boolean);
}

function normalizeContact(contact = {}) {
  const out = {};
  for (const field of RESUME_CONTACT_FIELDS) out[field] = nullableText(contact[field]);
  return out;
}

function buildResumeDocumentFromParsed(parsed) {
  return {
    contact: normalizeContact(parsed.contact || {}),
    headline: null,
    summary: nullableText(parsed.summary),
    experience: (parsed.sections?.experience || []).map((block) => {
      const rawText = normalizeDocxResumeText(block);
      return {
        company: null,
        title: null,
        location: null,
        start_date: null,
        end_date: null,
        bullets: normalizeLineItems(block),
        raw_text: rawText,
      };
    }),
    education: (parsed.sections?.education || []).map((block) => ({
      institution: null,
      degree: null,
      location: null,
      dates: null,
      raw_text: normalizeDocxResumeText(block),
    })),
    skills: (parsed.sections?.skills || []).length
      ? [
          {
            category: null,
            items: (parsed.sections.skills || [])
              .map((item) => String(item).trim())
              .filter(Boolean),
          },
        ]
      : [],
    projects: (parsed.sections?.projects || []).map((block) => {
      const rawText = normalizeDocxResumeText(block);
      const items = normalizeLineItems(block);
      return {
        name: items[0] || null,
        description: null,
        bullets: items,
        technologies: [],
        raw_text: rawText,
      };
    }),
    certifications: [],
    other_sections: (parsed.sections?.other || []).map((block) => ({
      heading: null,
      items: normalizeLineItems(block),
      raw_text: normalizeDocxResumeText(block),
    })),
  };
}

function pushResumeBlock(lines, heading, blocks, renderBlock) {
  if (!Array.isArray(blocks) || !blocks.length) return;
  lines.push("", heading);
  for (const block of blocks) {
    const rendered = normalizeDocxResumeText(renderBlock(block));
    if (rendered) lines.push(rendered);
  }
}

function joinCompact(parts, separator = " | ") {
  return parts
    .map((part) => nullableText(part))
    .filter(Boolean)
    .join(separator);
}

function resumeDocumentToPlainText(document) {
  if (!document || typeof document !== "object") return "";
  const lines = [];
  const contact = document.contact || {};
  if (contact.full_name) lines.push(contact.full_name);
  const contactLine = joinCompact([
    contact.email,
    contact.phone,
    contact.location,
    contact.linkedin,
    contact.github,
    contact.portfolio,
  ]);
  if (contactLine) lines.push(contactLine);
  if (document.headline) lines.push("", document.headline);
  if (document.summary) lines.push("", "Summary", document.summary);

  pushResumeBlock(lines, "Experience", document.experience, (entry) => {
    const header = joinCompact([entry.title, entry.company], " — ");
    const meta = joinCompact([
      entry.location,
      joinCompact([entry.start_date, entry.end_date], " - "),
    ]);
    const bullets = Array.isArray(entry.bullets)
      ? entry.bullets
          .map((bullet) => `- ${String(bullet).trim()}`)
          .filter((bullet) => bullet !== "- ")
      : [];
    return [header, meta, ...bullets, entry.raw_text && !bullets.length ? entry.raw_text : ""]
      .filter(Boolean)
      .join("\n");
  });

  pushResumeBlock(lines, "Education", document.education, (entry) =>
    [
      joinCompact([entry.degree, entry.institution], " — "),
      entry.location,
      entry.dates,
      entry.raw_text,
    ]
      .filter(Boolean)
      .join("\n")
  );

  if (Array.isArray(document.skills) && document.skills.length) {
    lines.push("", "Skills");
    for (const group of document.skills) {
      const items = Array.isArray(group.items)
        ? group.items.map((item) => String(item).trim()).filter(Boolean)
        : [];
      if (!items.length) continue;
      lines.push(group.category ? `${group.category}: ${items.join(", ")}` : items.join(", "));
    }
  }

  pushResumeBlock(lines, "Projects", document.projects, (entry) => {
    const tech =
      Array.isArray(entry.technologies) && entry.technologies.length
        ? `Technologies: ${entry.technologies.join(", ")}`
        : "";
    const bullets = Array.isArray(entry.bullets)
      ? entry.bullets
          .map((bullet) => `- ${String(bullet).trim()}`)
          .filter((bullet) => bullet !== "- ")
      : [];
    return [
      entry.name,
      entry.description,
      ...bullets,
      tech,
      entry.raw_text && !bullets.length ? entry.raw_text : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  pushResumeBlock(lines, "Certifications", document.certifications, (entry) =>
    [joinCompact([entry.name, entry.issuer], " — "), entry.date, entry.raw_text]
      .filter(Boolean)
      .join("\n")
  );

  pushResumeBlock(lines, "Additional", document.other_sections, (section) => {
    const items = Array.isArray(section.items)
      ? section.items.map((item) => `- ${String(item).trim()}`).filter((item) => item !== "- ")
      : [];
    return [section.heading, ...items, section.raw_text && !items.length ? section.raw_text : ""]
      .filter(Boolean)
      .join("\n");
  });

  return normalizeDocxResumeText(lines.join("\n"));
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

export function normalizeOnboardingDraft(raw = {}) {
  const numericStep = Number(raw?.stepIndex);
  const stepIndex = Number.isFinite(numericStep)
    ? Math.max(0, Math.min(ONBOARDING_DRAFT_MAX_STEP, Math.trunc(numericStep)))
    : 0;
  const draftSeeds = isPlainObject(raw?.draftSeeds) ? raw.draftSeeds : {};
  return {
    stepIndex,
    completedIndexes: normalizeOnboardingCompletedIndexes(raw?.completedIndexes),
    draftSeeds,
    updatedAt: typeof raw?.updatedAt === "string" && raw.updatedAt.trim() ? raw.updatedAt : null,
  };
}

function normalizeOnboardingCompletedIndexes(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value >= 0)
        .map((value) => Math.min(ONBOARDING_DRAFT_MAX_STEP, Math.trunc(value)))
    )
  ).sort((a, b) => a - b);
}

function readOnboardingDraft(pathCtx) {
  const draftPath = userPath(pathCtx, ONBOARDING_DRAFT_PATH);
  if (!existsSync(draftPath)) return normalizeOnboardingDraft();
  try {
    return normalizeOnboardingDraft(JSON.parse(readFileSync(draftPath, "utf8")));
  } catch {
    return normalizeOnboardingDraft();
  }
}

function writeOnboardingDraft(pathCtx, draft) {
  const next = normalizeOnboardingDraft({ ...draft, updatedAt: new Date().toISOString() });
  const draftPath = userPath(pathCtx, ONBOARDING_DRAFT_PATH);
  mkdirSync(dirname(draftPath), { recursive: true });
  atomicWriteFile(draftPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
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

function compactStrings(values, limit) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

export function normalizeTargetingSeed(raw = {}) {
  const roleBuckets = [];
  for (const bucket of Array.isArray(raw.role_buckets) ? raw.role_buckets : []) {
    const titles = compactStrings(bucket?.titles, 8);
    if (!titles.length) continue;
    const priority =
      TARGETING_PRIORITY_ALIASES.get(String(bucket?.priority || "").toLowerCase()) || "secondary";
    const fitSignals = compactStrings(bucket?.fit_signals, 12);
    const downSignals = compactStrings(bucket?.down_signals, 12);
    roleBuckets.push({
      name: String(bucket?.name || (roleBuckets.length ? "Secondary" : "Primary")).trim(),
      priority,
      titles,
      ...(String(bucket?.notes || "").trim()
        ? { notes: String(bucket.notes).trim().slice(0, 240) }
        : {}),
      ...(fitSignals.length ? { fit_signals: fitSignals } : {}),
      ...(downSignals.length ? { down_signals: downSignals } : {}),
    });
    if (roleBuckets.length >= 4) break;
  }

  return {
    role_buckets: roleBuckets,
    keep_signals: compactStrings(raw.keep_signals, 12),
    tracked_companies: compactStrings(raw.tracked_companies, 24),
  };
}

const DB_STATE_ENTRIES = [
  ...CANDIDATE_FILES,
  ...OPTIONAL_CANDIDATE_FILES.filter((entry) => entry.name === "modes"),
];

function docFromCandidateConfig(config, name) {
  if (name === "form-defaults") return config["form-defaults"];
  return config[name];
}

function dbCandidateFiles(repoRoot, pathCtx, config) {
  return DB_STATE_ENTRIES.map((entry) => {
    const data = docFromCandidateConfig(config, entry.name);
    const { valid, errors } = validate(data, readSchema(repoRoot, entry));
    return {
      name: entry.name,
      path: displayPath(pathCtx, entry.candidatePath),
      exists: true,
      valid,
      errors,
    };
  });
}

function dbSourceResumePresent(pathCtx) {
  try {
    return candidateArtifactExists({ ...pathCtx, id: "source-resume" });
  } catch {
    return false;
  }
}

function dbDeterministicSourceCounts(pathCtx) {
  const searchSources = sourceConfigGet({ ...pathCtx, name: "search-sources" }).data;
  const sourcedScan = sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data;
  return countDeterministicSources({ searchSources, sourcedScan });
}

function dbSearchSourcesPresent(pathCtx) {
  const searchSources = sourceConfigGet({ ...pathCtx, name: "search-sources" }).data;
  const sourcedScan = sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data;
  return countDeterministicSources({ searchSources, sourcedScan }).attempted > 0;
}

function exportCandidateCompatibilityFiles(pathCtx, config) {
  const written = [];
  for (const entry of [
    ...DB_STATE_ENTRIES,
    AUTOMATION_ROUTE_ENTRY,
    APPLICATION_LIMITS_COMPAT_ENTRY,
  ]) {
    const data = docFromCandidateConfig(config, entry.name);
    if (!data || (entry.name === "automation" && Object.keys(data).length === 0)) continue;
    if (entry.name === "application-limits" && !(data.companies || []).length) continue;
    const candidatePath = userPath(pathCtx, entry.candidatePath);
    writeYamlDoc(candidatePath, data);
    written.push(displayPath(pathCtx, entry.candidatePath));
  }
  return written;
}

function validateDbProfileAndTargeting(repoRoot, config) {
  const profileEntry = CANDIDATE_FILES.find((f) => f.name === "profile");
  const targetingEntry = CANDIDATE_FILES.find((f) => f.name === "targeting");
  const profileCheck = validate(config.profile, readSchema(repoRoot, profileEntry));
  const targetingCheck = validate(config.targeting, readSchema(repoRoot, targetingEntry));
  return {
    valid: profileCheck.valid && targetingCheck.valid,
    profileErrors: profileCheck.errors,
    targetingErrors: targetingCheck.errors,
  };
}

function compactArrayValues(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const key = String(value || "")
      .trim()
      .toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function mergeFilterObject(existing = {}, generated = {}) {
  const keys = new Set([...Object.keys(generated || {}), ...Object.keys(existing || {})]);
  const merged = {};
  for (const key of keys) {
    merged[key] = compactArrayValues([...asArray(existing?.[key]), ...asArray(generated?.[key])]);
  }
  return merged;
}

function sourceEntryKey(entry = {}) {
  const provider = String(entry.provider || entry.platform || "")
    .trim()
    .toLowerCase();
  const url = String(entry.url || "")
    .trim()
    .toLowerCase();
  if (url) return `url:${url}`;
  const rssUrl = String(entry.rssUrl || entry.rss_url || "")
    .trim()
    .toLowerCase();
  if (rssUrl) return `rss:${rssUrl}`;
  const query = String(entry.query || "")
    .trim()
    .toLowerCase();
  if (query) return `query:${provider}:${query}`;
  const label = String(entry.label || "")
    .trim()
    .toLowerCase();
  return label ? `label:${provider}:${label}` : "";
}

function companyEntryKey(entry = {}) {
  const name = String(entry.name || entry)
    .trim()
    .toLowerCase();
  const careersUrl = String(entry.careers_url || entry.url || "")
    .trim()
    .toLowerCase();
  return careersUrl ? `url:${careersUrl}` : name ? `name:${name}` : "";
}

function mergeEntries(existingEntries, generatedEntries, keyForEntry) {
  const out = [];
  const seen = new Set();
  for (const entry of [
    ...(Array.isArray(existingEntries) ? existingEntries : []),
    ...(Array.isArray(generatedEntries) ? generatedEntries : []),
  ]) {
    const key = keyForEntry(entry);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(entry);
  }
  return out;
}

function mergeSourceCatalog(existing = {}, generated = {}) {
  const keys = new Set([...Object.keys(generated || {}), ...Object.keys(existing || {})]);
  const merged = {};
  for (const key of keys) {
    merged[key] = compactArrayValues([...asArray(existing?.[key]), ...asArray(generated?.[key])]);
  }
  return merged;
}

function mergeSearchSources(existing = {}, generated = {}) {
  return {
    ...generated,
    ...existing,
    title_filter: mergeFilterObject(existing.title_filter, generated.title_filter),
    location_filter: mergeFilterObject(existing.location_filter, generated.location_filter),
    searches: mergeEntries(existing.searches, generated.searches, sourceEntryKey),
    tracked_companies: mergeEntries(
      existing.tracked_companies,
      generated.tracked_companies,
      companyEntryKey
    ),
    source_catalog: mergeSourceCatalog(existing.source_catalog, generated.source_catalog),
  };
}

function buildDbSearchSources(pathCtx, config) {
  const generated = buildSearchSources(config.targeting, config.profile);
  const current = sourceConfigGet({ ...pathCtx, name: "search-sources" });
  if (current.stored !== true) return generated;
  return mergeSearchSources(current.data, generated);
}

function writeDbCompatibilityBundle(repoRoot, pathCtx, config) {
  const written = exportCandidateCompatibilityFiles(pathCtx, config);
  const sources = buildDbSearchSources(pathCtx, config);
  sourceConfigPut({ ...pathCtx, name: "search-sources", data: sources });
  const searchConfigPath = userPath(pathCtx, "config/search-sources.yml");
  mkdirSync(dirname(searchConfigPath), { recursive: true });
  atomicWriteFile(searchConfigPath, `${stringifyYaml(sources)}\n`);
  written.push(displayPath(pathCtx, "config/search-sources.yml"));

  const template = readFileSync(join(repoRoot, "templates/AGENTS.md"), "utf8");
  const agentsPath = userPath(pathCtx, "candidate/AGENTS.md");
  mkdirSync(dirname(agentsPath), { recursive: true });
  atomicWriteFile(
    agentsPath,
    renderLocalAgents({ template, profile: config.profile, targeting: config.targeting })
  );
  written.push(displayPath(pathCtx, "candidate/AGENTS.md"));

  return { written, sources };
}

function sendCandidateError(res, err) {
  sendJson(res, err?.code === "NO_DATABASE" ? 409 : 400, {
    ok: false,
    error: err?.message || String(err),
    errors: err?.errors || undefined,
  });
}

export function prepareQuickStartSourcing({ repoRoot, env = process.env } = {}) {
  const pathCtx = { repoRoot, env };
  if (!dbExists(pathCtx)) {
    return {
      status: 409,
      body: {
        ok: false,
        error: "SQLite candidate setup is required before quick-start sourcing",
      },
    };
  }

  let config;
  try {
    config = candidateConfigGet(pathCtx);
  } catch (err) {
    return {
      status: err?.code === "NO_DATABASE" ? 409 : 400,
      body: {
        ok: false,
        error: err?.message || String(err),
        errors: err?.errors || undefined,
      },
    };
  }

  const setup = config.setup || {};
  if (setup.readiness?.search_ready !== true) {
    return {
      status: 409,
      body: {
        ok: false,
        error: "Candidate setup is not search-ready",
        readiness: setup.readiness || {},
        missing: setup.missing || {},
      },
    };
  }

  const check = validateDbProfileAndTargeting(repoRoot, config);
  if (!check.valid) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "candidate profile and/or targeting DB docs do not validate",
        profileErrors: check.profileErrors,
        targetingErrors: check.targetingErrors,
      },
    };
  }

  const { written, sources } = writeDbCompatibilityBundle(repoRoot, pathCtx, config);
  const searchCount = Array.isArray(sources?.searches) ? sources.searches.length : 0;
  return {
    status: 200,
    body: {
      ok: true,
      written,
      readiness: setup.readiness,
      missing: setup.missing,
      locks: {
        gateReady: setup.readiness?.gate_ready === true,
        applyReady: setup.readiness?.apply_ready === true,
      },
      searches: { count: searchCount },
      nextSkill: "research-boards",
      nextMessage:
        "Search sources are ready. Run research-boards next, then discover-companies before the first search-jobs sweep.",
    },
  };
}

export function prepareQuickStartFirstSearch({
  repoRoot,
  env = process.env,
  fetchImpl = fetch,
  retry = false,
} = {}) {
  const pathCtx = { repoRoot, env };
  if (!dbExists(pathCtx)) {
    return {
      status: 409,
      body: {
        ok: false,
        error: "SQLite candidate setup is required before quick-start sourcing",
      },
    };
  }

  let config;
  try {
    config = candidateConfigGet(pathCtx);
  } catch (err) {
    return {
      status: err?.code === "NO_DATABASE" ? 409 : 400,
      body: {
        ok: false,
        error: err?.message || String(err),
        errors: err?.errors || undefined,
      },
    };
  }

  const setup = config.setup || {};
  if (setup.readiness?.search_ready !== true) {
    return {
      status: 409,
      body: {
        ok: false,
        error: "Candidate setup is not search-ready",
        readiness: setup.readiness || {},
        missing: setup.missing || {},
      },
    };
  }

  const check = validateDbProfileAndTargeting(repoRoot, config);
  if (!check.valid) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "candidate profile and/or targeting DB docs do not validate",
        profileErrors: check.profileErrors,
        targetingErrors: check.targetingErrors,
      },
    };
  }

  try {
    const result = startFirstSearchRun({ repoRoot, env, retryFailed: retry === true });
    if (result.reused !== true && result.run?.status === "running") {
      void runFirstSearchInBackground({
        repoRoot,
        env,
        fetchImpl,
        runId: result.run.id,
      }).catch(() => {});
    }
    return {
      status: result.reused ? 200 : 202,
      body: {
        ...result,
        locks: {
          gateReady: setup.readiness?.gate_ready === true,
          applyReady: setup.readiness?.apply_ready === true,
        },
      },
    };
  } catch (err) {
    return {
      status: err?.code === "NO_DATABASE" || err?.code === "NOT_SEARCH_READY" ? 409 : 500,
      body: {
        ok: false,
        error: err?.message || String(err),
        code: err?.code || undefined,
        readiness: err?.readiness || undefined,
        missing: err?.missing || undefined,
        errors: err?.errors || undefined,
      },
    };
  }
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
  // a hand-rolled MOCKED runtime (happy/retry-then-ok/422/413/501/502) without
  // touching the real @anthropic-ai/claude-agent-sdk devDependency.
  runSkillStream = defaultRunSkillStream,
  extractDocxResumeText = defaultExtractDocxResumeText,
  fetchImpl = fetch,
}) {
  const pathCtx = { repoRoot, env };

  // -------------------------------------------------------------------------
  // GET /api/onboard/state — report-only; never runs ensureCandidateFiles.
  // -------------------------------------------------------------------------
  addRoute("GET", "/api/onboard/state", (_req, res) => {
    if (dbExists(pathCtx)) {
      try {
        const config = candidateConfigGet(pathCtx);
        const automation = config.automation || {};
        const { publishableToken, secretKey } = resolveLogoTokens(pathCtx, env);
        const integrations = automation.integrations || {};
        const firstSearchRun = latestSourcingRunForUi({
          repoRoot,
          env,
          purpose: "first-search",
        });
        const deterministicSources = dbDeterministicSourceCounts(pathCtx);
        const deepIngest = buildDeepIngestViewModel({ repoRoot, env });
        sendJson(res, 200, {
          ok: true,
          files: dbCandidateFiles(repoRoot, pathCtx, config),
          data: {
            profile: config.profile,
            targeting: config.targeting,
            "form-defaults": config["form-defaults"],
            modes: config.modes,
            setup: config.setup,
            deepIngest,
            sourcing: {
              firstSearchRun,
              sourceSetup: { deterministicSources },
            },
          },
          deepIngest,
          sourcing: { firstSearchRun },
          deterministicSources,
          sourceResumePresent:
            dbSourceResumePresent(pathCtx) ||
            existsSync(userPath(pathCtx, "candidate/SOURCE_RESUME.md")),
          keyConfigured: resolveAIRoute(env).type !== "none",
          searchSourcesPresent: dbSearchSourcesPresent(pathCtx),
          logoImageTokenConfigured: !!(integrations.logo_dev_token || publishableToken),
          logoSearchTokenConfigured: !!(integrations.logo_dev_secret_key || secretKey),
          publicSyncPreference: publicSyncPreferenceGet(pathCtx).preference,
        });
        return;
      } catch (err) {
        sendCandidateError(res, err);
        return;
      }
    }

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

    // M8 additive (Builder B): logo.dev credential presence, never the values
    // themselves — reuses logo-route.mjs's own resolveLogoTokens() so this
    // route doesn't re-derive candidate/automation.yml's read/fallback shape.
    // The Companies step uses these to decide whether to show the
    // autocomplete/logo affordances or degrade straight to manual entry +
    // initials, without ever seeing the secret/token values.
    const { publishableToken, secretKey } = resolveLogoTokens(pathCtx, env);

    sendJson(res, 200, {
      ok: true,
      files,
      data,
      sourceResumePresent: existsSync(userPath(pathCtx, sourceResumeEntry.candidatePath)),
      keyConfigured: resolveAIRoute(env).type !== "none",
      searchSourcesPresent: existsSync(userPath(pathCtx, "config/search-sources.yml")),
      logoImageTokenConfigured: !!publishableToken,
      logoSearchTokenConfigured: !!secretKey,
      publicSyncPreference: DEFAULT_PUBLIC_SYNC_PREFERENCE,
    });
  });

  // -------------------------------------------------------------------------
  // GET/POST /api/onboard/draft — durable UI-only wizard state. This is the
  // app's resumability layer for focused step + unsaved mock/AI seeds; it
  // deliberately lives under internal/ and never touches workspace/setup-state.json
  // (that file remains owned by ingest-profile).
  // -------------------------------------------------------------------------
  addRoute("GET", "/api/onboard/draft", (_req, res) => {
    sendJson(res, 200, { ok: true, draft: readOnboardingDraft(pathCtx) });
  });

  addRoute("POST", "/api/onboard/draft", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { ok: false, error: { message: err.message } });
      return;
    }

    try {
      const draft = writeOnboardingDraft(pathCtx, body || {});
      sendJson(res, 200, { ok: true, draft });
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/onboard/public-sync-preference — local opt-in/out for sharing
  // public company and board metadata back to future Rolester users. The
  // public-intel DB verbs are fail-closed scrubbed; this route only toggles
  // whether the local workspace should participate.
  // -------------------------------------------------------------------------
  addRoute("POST", "/api/onboard/public-sync-preference", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { ok: false, error: { message: err.message } });
      return;
    }

    if (typeof body?.enabled !== "boolean") {
      sendJson(res, 400, {
        ok: false,
        error: { message: "public sync preference enabled must be a boolean" },
      });
      return;
    }

    try {
      if (!dbExists(pathCtx)) candidateSetupInitialize(pathCtx);
      const result = publicSyncPreferenceSet({ ...pathCtx, enabled: body.enabled });
      sendJson(res, 200, { ok: true, publicSyncPreference: result.preference });
    } catch (err) {
      sendJson(res, err?.status || 400, {
        ok: false,
        error: { message: err?.message || String(err), code: err?.code || undefined },
      });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/onboard/init — template seeding, never overwrites.
  // -------------------------------------------------------------------------
  addRoute("POST", "/api/onboard/init", (_req, res) => {
    const result = candidateSetupInitialize(pathCtx);
    sendJson(res, 200, { ok: true, ...result, dbInitialized: true });
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
    const rawTargetingSeed = deriveTargetingSeed(parsed);
    const targetingSeed = rawTargetingSeed ? normalizeTargetingSeed(rawTargetingSeed) : null;
    const resumeDocument = buildResumeDocumentFromParsed(parsed);
    const sections = {
      experience: parsed.sections.experience.length,
      education: parsed.sections.education.length,
      skills: parsed.sections.skills.length,
      projects: parsed.sections.projects.length,
      other: parsed.sections.other.length,
    };

    if (body?.save) {
      if (dbExists(pathCtx)) {
        candidateArtifactPut({
          ...pathCtx,
          id: "source-resume",
          kind: "source-resume",
          data: {
            text,
            resumeDocument,
            savedAt: new Date().toISOString(),
            source: "resume-text",
          },
        });
      } else {
        const entry = COPY_ONLY_CANDIDATE_FILES.find((f) => f.name === "source-resume");
        const dest = userPath(pathCtx, entry.candidatePath);
        mkdirSync(dirname(dest), { recursive: true });
        atomicWriteFile(dest, text);
      }
    }

    sendJson(res, 200, {
      profileSeed,
      evidenceSeed,
      sections,
      resumeDocument,
      ...(targetingSeed?.role_buckets?.length ? { targetingSeed } : {}),
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/onboard/resume-docx?name=<filename> — raw DOCX bytes.
  //
  // DOCX intake is deterministic: save the original upload, extract raw text
  // locally, quality-gate the text, and only then write source-resume readiness.
  // PDF/image resumes remain on the existing AI upload path.
  // -------------------------------------------------------------------------
  addRoute("POST", "/api/onboard/resume-docx", async (req, res) => {
    const requestUrl = new URL(req.url, "http://127.0.0.1");
    const name = (requestUrl.searchParams.get("name") || "").trim();
    if (!name) {
      sendJson(res, 400, { error: "?name=<filename> is required" });
      return;
    }

    const ext = extname(name).toLowerCase();
    if (!RESUME_DOCX_ALLOWED_EXTENSIONS.has(ext)) {
      sendJson(res, 400, {
        error: `unsupported file type "${ext || name}" — resume-docx accepts DOCX uploads only (.docx)`,
      });
      return;
    }

    let bytes;
    try {
      bytes = await readRawBodyCapped(req, RESUME_DOCX_MAX_BYTES);
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
    writeFileSync(savedPath, bytes);

    let text = "";
    let usable = false;
    try {
      const extracted = await extractDocxResumeText(bytes);
      if (extracted && typeof extracted === "object" && !Buffer.isBuffer(extracted)) {
        text = normalizeDocxResumeText(extracted.text || extracted.value || "");
        usable = extracted.ok === false ? false : looksLikeUsableResumeText(text);
      } else {
        text = normalizeDocxResumeText(extracted);
        usable = looksLikeUsableResumeText(text);
      }
    } catch {
      usable = false;
    }

    if (!usable) {
      sendJson(res, 422, {
        ok: false,
        code: "DOCX_TEXT_UNUSABLE",
        error:
          "We could not read usable text from that DOCX. The original file was saved; paste text or upload PDF, TXT, or Markdown.",
        savedPath: savedRelPath,
        guidance: "Paste text or upload PDF, TXT, or Markdown.",
      });
      return;
    }

    const parsed = parseResume(text);
    const profileSeed = deriveProfileSeed(parsed);
    const evidenceSeed = deriveEvidenceSeed(parsed);
    const rawTargetingSeed = deriveTargetingSeed(parsed);
    const targetingSeed = rawTargetingSeed ? normalizeTargetingSeed(rawTargetingSeed) : null;
    const resumeDocument = buildResumeDocumentFromParsed(parsed);
    const sections = {
      experience: parsed.sections.experience.length,
      education: parsed.sections.education.length,
      skills: parsed.sections.skills.length,
      projects: parsed.sections.projects.length,
      other: parsed.sections.other.length,
    };

    if (dbExists(pathCtx)) {
      candidateArtifactPut({
        ...pathCtx,
        id: "source-resume",
        kind: "source-resume",
        data: {
          path: savedRelPath,
          filename: sanitizeUploadFilename(name),
          savedAt: new Date().toISOString(),
          source: "docx",
          text,
          resumeDocument,
        },
      });
    } else {
      const entry = COPY_ONLY_CANDIDATE_FILES.find((f) => f.name === "source-resume");
      const dest = userPath(pathCtx, entry.candidatePath);
      mkdirSync(dirname(dest), { recursive: true });
      atomicWriteFile(dest, text);
    }

    sendJson(res, 200, {
      ok: true,
      profileSeed,
      evidenceSeed,
      sections,
      resumeDocument,
      source: "docx",
      savedPath: savedRelPath,
      ...(targetingSeed?.role_buckets?.length ? { targetingSeed } : {}),
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/onboard/resume-ai?name=<filename> — raw PDF/image bytes.
  //
  // Frozen M8 contract: the request body IS the file (no JSON envelope,
  // unlike every other route in this file) — `name` travels as a query
  // param purely so the server knows the original filename/extension.
  // Saves under workspace/intake/resume-uploads/, then runs the
  // resume-extract skill one-shot (tools: ["Read"] only) over the embedded
  // runtime, buffers its reply, and parses/validates/retries via the shared
  // bounded-AI fallback helper. The route keeps the Read-only skill adapter
  // because PDF/image extraction needs local file access, while the response
  // shape now uses the common bounded envelope.
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
        action: RESUME_AI_LABELS.action,
        operation: RESUME_AI_LABELS.operation,
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

    const outcome = await runBoundedAI({
      labels: RESUME_AI_LABELS,
      schema,
      manual: RESUME_AI_MANUAL,
      structuredMode: "fallback",
      maxRetries: 1,
      invoke: invokeResumeExtract,
    });

    if (!outcome.body.ok) {
      sendJson(res, outcome.status, outcome.body);
      return;
    }

    const extracted = outcome.body.data || {};
    const resumeDocument = extracted.resume_document;
    const fullText =
      normalizeDocxResumeText(extracted.full_text || "") ||
      resumeDocumentToPlainText(resumeDocument);
    const claims = (extracted.claims || []).map((c, i) => ({
      id: `resume-${String(i + 1).padStart(3, "0")}`,
      claim: String(c?.claim ?? ""),
      evidence: String(c?.evidence ?? ""),
    }));

    if (dbExists(pathCtx)) {
      candidateArtifactPut({
        ...pathCtx,
        id: "source-resume",
        kind: "source-resume",
        data: {
          path: savedRelPath,
          filename: sanitizeUploadFilename(name),
          savedAt: new Date().toISOString(),
          source: "resume-ai",
          text: fullText,
          resumeDocument,
        },
      });
    } else {
      const entry = COPY_ONLY_CANDIDATE_FILES.find((f) => f.name === "source-resume");
      const dest = userPath(pathCtx, entry.candidatePath);
      mkdirSync(dirname(dest), { recursive: true });
      atomicWriteFile(dest, fullText);
    }

    sendJson(res, outcome.status, {
      ...outcome.body,
      data: {
        fullText,
        resumeDocument,
        profileSeed: { candidate: extracted.candidate || {} },
        evidenceSeed: { claims },
        sections: extracted.sections || {},
        targetingSeed: normalizeTargetingSeed(extracted.targeting_suggestions),
        source: "ai",
        savedPath: savedRelPath,
      },
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

      if (dbExists(pathCtx)) {
        try {
          const result =
            entry.name === "evidence"
              ? candidateEvidenceMerge({ ...pathCtx, claims: patch.claims || [] })
              : candidateConfigPatch({ ...pathCtx, name: entry.name, patch });
          sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          sendCandidateError(res, err);
        }
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

    if (dbExists(pathCtx)) {
      try {
        const result = candidateEvidenceMerge({ ...pathCtx, claims: posted });
        sendJson(res, 200, result);
      } catch (err) {
        sendCandidateError(res, err);
      }
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
  // POST /api/onboard/write-config — exports CLI/debug compatibility files.
  // The product source setup state remains SQLite `search-sources`; generated
  // YAML is support output, not app readiness.
  // -------------------------------------------------------------------------
  addRoute("POST", "/api/onboard/write-config", (_req, res) => {
    if (dbExists(pathCtx)) {
      let config;
      try {
        config = candidateConfigGet(pathCtx);
      } catch (err) {
        sendCandidateError(res, err);
        return;
      }

      const check = validateDbProfileAndTargeting(repoRoot, config);
      if (!check.valid) {
        sendJson(res, 400, {
          error: "candidate profile and/or targeting DB docs do not validate",
          profileErrors: check.profileErrors,
          targetingErrors: check.targetingErrors,
        });
        return;
      }

      const { written } = writeDbCompatibilityBundle(repoRoot, pathCtx, config);
      sendJson(res, 200, { written });
      return;
    }

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
  // POST /api/onboard/quick-start — search-ready DB setup -> durable first
  // search. Optional JSON body { retry: true } retries a previously failed
  // first-search run instead of reusing it forever; an empty/missing body
  // keeps the default (no retry) behavior.
  // -------------------------------------------------------------------------
  addRoute("POST", "/api/onboard/quick-start", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return;
    }

    const result = prepareQuickStartFirstSearch({
      repoRoot,
      env,
      fetchImpl,
      retry: body?.retry === true,
    });
    sendJson(res, result.status, result.body);
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

  addRoute("POST", "/api/settings/ai-key/validate", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return;
    }

    const validation = await validateAiProviderKey({
      provider: body?.provider || "anthropic",
      apiKey: body?.apiKey,
      env,
      fetchImpl,
    });
    if (!validation.ok) {
      sendJson(res, validation.status || 400, {
        ok: false,
        provider: validation.provider,
        code: validation.code,
        error: validation.message,
      });
      return;
    }

    try {
      writeLocalAiKey({ repoRoot, apiKey: body?.apiKey, env });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    sendJson(res, 200, { ok: true, route: "byok", provider: validation.provider });
  });

  addRoute("POST", "/api/settings/ai-key/check", async (req, res) => {
    let body = {};
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return;
    }

    const route = resolveAIRoute(env);
    if (route.type === "proxy") {
      sendJson(res, 200, { ok: true, route: "proxy", provider: "managed-proxy" });
      return;
    }
    if (route.type !== "byok") {
      sendJson(res, 409, {
        ok: false,
        provider: body?.provider || "anthropic",
        code: "missing_key",
        error: "No AI key is configured yet.",
      });
      return;
    }

    const validation = await validateAiProviderKey({
      provider: body?.provider || "anthropic",
      apiKey: route.apiKey,
      env,
      fetchImpl,
    });
    if (!validation.ok) {
      sendJson(res, validation.status || 400, {
        ok: false,
        provider: validation.provider,
        code: validation.code,
        error: validation.message,
      });
      return;
    }
    sendJson(res, 200, { ok: true, route: "byok", provider: validation.provider });
  });

  addRoute("GET", "/api/settings/ai", (_req, res) => {
    sendJson(res, 200, {
      route: resolveAIRoute(env).type,
      keyPresent: !!env.ANTHROPIC_API_KEY,
    });
  });

  addRoute("GET", "/api/settings/usage", (_req, res) => {
    sendJson(res, 200, {
      ok: true,
      summary: summarizeUsageEvents(readUsageEvents({ root: repoRoot })),
    });
  });
}
