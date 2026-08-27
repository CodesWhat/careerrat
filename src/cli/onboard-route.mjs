// onboard-route.mjs — M1 of the paid-POC journey: the non-AI onboarding
// wizard's HTTP surface. Split out of tracker-dev.mjs the same way P0-4's
// skill-run-route.mjs was (see that file's header comment): `addRoute` is
// exactly the mount point for this, and `readJsonBodyCapped`/`sendJson` are
// imported from skill-run-route.mjs rather than duplicated.
//
// The app onboarding surface is SQLite-primary: POST /api/onboard/init creates
// candidate setup rows, candidate/profile/targeting/settings writes update
// those rows. The deterministic resume parser still handles plain-text/markdown
// resumes without a model, while BYOK AI routes are optional assists. The
// React onboarding lives under /app. M8 adds exactly one AI-touching route
// here (POST /api/onboard/resume-ai, for the PDF/image case
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
//   POST /api/onboard/finish             verify graduation + carry Paul into workspace-main
//   POST /api/onboard/init               ensureCandidateFiles() (never overwrites)
//   POST /api/onboard/resume             parse a pasted/loaded resume (2MB cap)
//   POST /api/onboard/resume-ai          M8 — AI-extract a PDF/image resume (5MB
//                                        cap, raw body bytes, ?name=<filename>)
//   POST /api/onboard/candidate/:name    merge+validate+write one candidate setup doc
//                                        (one concrete route per known name —
//                                        see CANDIDATE_ROUTE_ENTRIES below)
//   POST /api/onboard/candidate/evidence/remove  delete exactly one evidence
//                                        claim by id (Library drawer's Delete)
//   POST /api/onboard/evidence-seed      dedupe-merge claims into evidence.yml
//   POST /api/onboard/quick-start        search-ready DB setup -> durable local first search
//   POST /api/settings/ai-key            store a BYOK Anthropic key locally
//   POST /api/settings/ai-key/validate   validate then store a BYOK Anthropic key
//   POST /api/settings/ai-key/check      validate the currently configured AI route
//   GET  /api/settings/ai                report the resolved AI route (no key value)
//   GET  /api/settings/usage             summarize local AI token spend by feature
//
// WRITE-SCOPE NOTE: normal onboarding writes go through src/core/db/verbs/
// candidate.mjs. YAML writes remain only for non-DB source workspaces.
//
// HARD CONSTRAINT: this wizard never writes workspace/setup-state.json. That
// file is agent-write-only by contract — ingest-profile (the AI-driven
// interview) owns it exclusively. The non-AI wizard seeds/validates candidate
// files but never claims to have run the interview.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import {
  WORKSPACE_THREAD_ID,
  workspaceOnboardingHandoff,
} from "../core/agent/workspace-thread.mjs";
import { writeLocalAiKey } from "../core/ai/ai-env.mjs";
import { loadAIPreferences } from "../core/ai/ai-preferences.mjs";
import { makeBoundedAIEnvelope, runBoundedAI } from "../core/ai/bounded-ai.mjs";
import { resolveAIRoute } from "../core/ai/call-ai.mjs";
import {
  aiRuntimeIdForRoute,
  assertAIExecutionPlanForOperation,
  resolveAIExecutionPlan,
} from "../core/ai/operation-policy.mjs";
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
  candidateEvidenceRemoveOne,
  candidateEvidenceReplace,
  candidateSetupInitialize,
  publicSyncPreferenceGet,
  publicSyncPreferenceSet,
  resumeExtractionComplete,
  resumeExtractionFail,
  resumeExtractionGet,
  resumeExtractionProgress,
  resumeExtractionRecoverOrphans,
  resumeExtractionStart,
  skillChatThreadRead,
  sourceConfigGet,
  sourceConfigPut,
} from "../core/db/verbs.mjs";
import { buildDeepIngestViewModel } from "../core/deep-ingest/view-model.mjs";
import {
  countDeterministicSources,
  healSearchSourceConfig,
  latestSourcingRunForUi,
  runFirstSearchInBackground,
  startFirstSearchRun,
} from "../core/onboarding/first-search-run.mjs";
import {
  extractDocxResumeMarkdown as defaultExtractDocxResumeMarkdown,
  extractDocxResumeText as defaultExtractDocxResumeText,
  looksLikeUsableResumeText,
  normalizeDocxResumeText,
} from "../core/onboarding/resume-docx.mjs";
import { computeSetupProgress } from "../core/onboarding/setup-progress.mjs";
import {
  collapseUnansweredOnboardingPrompts,
  onboardingMessageIsInternal,
} from "../core/onboarding/transcript-cleanup.mjs";
import { displayPath, userPath } from "../core/paths/workspace.mjs";
import {
  cloneCandidateDefault,
  isCandidateDefault,
  normalizeCandidateProfile,
} from "../core/profile/candidate-defaults.mjs";
import {
  CANDIDATE_FILES,
  COPY_ONLY_CANDIDATE_FILES,
  loadCandidate,
  OPTIONAL_CANDIDATE_FILES,
} from "../core/profile/candidate-setup.mjs";
import { atomicWriteFile } from "../core/profile/gate-writer.mjs";
import { buildSearchSources } from "../core/profile/generate-search-sources.mjs";
import {
  deriveEvidenceSeed,
  deriveProfileSeed,
  deriveTargetingSeed,
  parseResume,
} from "../core/profile/resume-parser.mjs";
import { validate } from "../core/profile/schema-validator.mjs";
import { parseYaml, stringifyYaml } from "../core/profile/yaml.mjs";
import {
  buildSearchPromptContext,
  generateSearchPrompts,
  getSearchPrompts,
  saveSearchPrompts,
} from "../core/search/search-prompts.mjs";
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
export const ONBOARDING_SEARCH_PROMPTS_OPERATION_KIND = "onboarding.search-prompts";

// POST /api/onboard/resume-ai's binary-upload cap (frozen M8 contract: 5MB)
// and the extensions it accepts. Uploaded text résumés use the same structured
// extractor as PDF/image files; POST /api/onboard/resume remains the zero-AI
// pasted-text fallback.
const RESUME_AI_MAX_BYTES = 5 * 1024 * 1024;
const RESUME_AI_ALLOWED_EXTENSIONS = new Set([
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".txt",
  ".md",
  ".markdown",
]);
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

const CANDIDATE_ROUTE_ENTRIES = [
  ...CANDIDATE_FILES,
  ...OPTIONAL_CANDIDATE_FILES.filter((entry) => entry.name === "modes"),
  AUTOMATION_ROUTE_ENTRY,
];

// The curated subset of candidate files the M7 Settings page (apps/web/src/
// settings/SettingsPage.jsx) reads and writes. GET /api/onboard/state below
// includes parsed data for exactly these files — see that route's own
// comment for why this extends the existing state read instead of adding a
// new route. "honesty" was added for the Settings Honesty boundaries card — the
// write route (POST /api/onboard/candidate/honesty) already existed and
// already validated against config/honesty.schema.json; only this read-side
// prefill list was missing it.
const SETTINGS_DATA_FILES = [
  "profile",
  "targeting",
  "form-defaults",
  "modes",
  "honesty",
  "evidence",
  // Lane A / R1, R5 — same reason as the DB-path stateData.automation above:
  // scrubbed automation prefill (setup_mode/capabilities/consent only, never
  // automation.integrations credentials). No longer read by
  // computeSetupProgress — consent was removed from the setup checklist
  // (see SETUP_PROGRESS_ITEMS's own comment) — kept here for parity with
  // the DB-backed response shape.
  "automation",
];
const DEFAULT_PUBLIC_SYNC_PREFERENCE = Object.freeze({
  enabled: true,
  source: "default",
  updatedAt: null,
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function hasUsableResumeExtraction(extracted) {
  if (!String(extracted?.full_text || "").trim()) return false;

  // Targeting suggestions and `candidate.domain` can be inferred by the
  // model, so they do not prove that the uploaded document was actually
  // transcribed. Require at least one literal candidate field, claim, or
  // detected source section before accepting and persisting the result.
  const candidateFacts = Object.entries(extracted?.candidate || {}).some(
    ([key, value]) => key !== "domain" && String(value ?? "").trim()
  );
  const claimFacts = (extracted?.claims || []).some((claim) => String(claim?.claim ?? "").trim());
  const sectionFacts = Object.values(extracted?.sections || {}).some(
    (count) => Number.isFinite(Number(count)) && Number(count) > 0
  );

  return candidateFacts || claimFacts || sectionFacts;
}

// Detect resume text that is actually binary (a PDF/DOCX decoded as text).
// Two tells: literal
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

function resumeUploadRelPath(name, bytes) {
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const stableNumericId = BigInt(`0x${digest}`).toString(10);
  return `workspace/intake/resume-uploads/${stableNumericId}-${sanitizeUploadFilename(name)}`;
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
  const chatCursor = normalizeOnboardingChatCursor(raw?.chatCursor);
  return {
    stepIndex,
    completedIndexes: normalizeOnboardingCompletedIndexes(raw?.completedIndexes),
    draftSeeds,
    transcript: normalizeOnboardingTranscript(raw?.transcript),
    ...(chatCursor ? { chatCursor } : {}),
    updatedAt: typeof raw?.updatedAt === "string" && raw.updatedAt.trim() ? raw.updatedAt : null,
    finishedAt:
      typeof raw?.finishedAt === "string" && raw.finishedAt.trim() ? raw.finishedAt : null,
  };
}

const ONBOARDING_TRANSCRIPT_ROLES = new Set(["user", "assistant", "receipt", "system-pill"]);
const ONBOARDING_BLOCK_STATUSES = new Set(["pending", "saving", "resolved", "error"]);
const ONBOARDING_BLOCK_KINDS = new Set([
  "authorization",
  "consent_mode",
  "consent_capability",
  "companies_suggest",
  "company_add",
  "candidate_patch",
  "evidence_claim",
]);

function cloneJsonValue(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function normalizeOnboardingChatCursor(value) {
  if (!isPlainObject(value)) return null;
  const chatId = typeof value.chatId === "string" ? value.chatId.trim().slice(0, 500) : "";
  const eventId = Number(value.eventId);
  if (!chatId || !Number.isSafeInteger(eventId) || eventId < 0) return null;
  return { chatId, eventId };
}

function normalizeOnboardingTranscript(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-200).flatMap((message) => {
    if (
      !isPlainObject(message) ||
      !ONBOARDING_TRANSCRIPT_ROLES.has(message.role) ||
      onboardingMessageIsInternal(message)
    )
      return [];
    const normalized = {
      role: message.role,
      text: typeof message.text === "string" ? message.text.slice(0, 20000) : "",
    };
    if (typeof message.id === "string" && message.id.trim()) {
      normalized.id = message.id.trim().slice(0, 1000);
    }
    if (message.role === "assistant") {
      const cursor = normalizeOnboardingChatCursor(message);
      if (cursor) {
        normalized.chatId = cursor.chatId;
        normalized.eventId = cursor.eventId;
      }
    }
    const binaryChoice =
      message?.metadata?.choicePrompt?.mode === "binary" &&
      message.metadata.choicePrompt.state === "pending";
    if (
      message?.answerMode === "yes-no" ||
      message?.metadata?.answerMode === "yes-no" ||
      binaryChoice
    ) {
      normalized.answerMode = "yes-no";
      normalized.metadata = binaryChoice
        ? { choicePrompt: cloneJsonValue(message.metadata.choicePrompt, null) }
        : { answerMode: "yes-no" };
    }
    if (message.role === "assistant" && Array.isArray(message.blocks)) {
      normalized.blocks = message.blocks.slice(0, 20).flatMap((block) => {
        if (!isPlainObject(block) || !ONBOARDING_BLOCK_KINDS.has(block.kind)) return [];
        return [
          {
            kind: block.kind,
            summary: typeof block.summary === "string" ? block.summary.slice(0, 500) : "",
            patch: isPlainObject(block.patch) ? cloneJsonValue(block.patch, null) : null,
            payload:
              isPlainObject(block.payload) || typeof block.payload === "string"
                ? cloneJsonValue(block.payload, null)
                : null,
            status: ONBOARDING_BLOCK_STATUSES.has(block.status) ? block.status : "pending",
            ...(typeof block.resultSummary === "string"
              ? { resultSummary: block.resultSummary.slice(0, 500) }
              : {}),
            ...(typeof block.error === "string" ? { error: block.error.slice(0, 500) } : {}),
            ...(block.hidden === true ? { hidden: true } : {}),
          },
        ];
      });
    }
    return [normalized];
  });
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

function sameOnboardingTranscriptTurn(draftMessage, canonicalMessage) {
  if (draftMessage?.role !== canonicalMessage?.role) return false;
  if (draftMessage?.text === canonicalMessage?.text) return true;
  return (
    canonicalMessage?.role === "assistant" &&
    typeof canonicalMessage.text === "string" &&
    typeof draftMessage?.text === "string" &&
    canonicalMessage.text.includes(draftMessage.text)
  );
}

function reconcileOnboardingTranscript(draftMessages, canonicalMessages) {
  const draft = normalizeOnboardingTranscript(draftMessages);
  const canonical = normalizeOnboardingTranscript(canonicalMessages);
  if (!canonical.length) return draft;
  const reconciled = canonical.map((message, index) =>
    sameOnboardingTranscriptTurn(draft[index], message) ? draft[index] : message
  );
  if (draft.length > canonical.length) reconciled.push(...draft.slice(canonical.length));
  return reconciled;
}

export function readOnboardingDraft(pathCtx) {
  const draftPath = userPath(pathCtx, ONBOARDING_DRAFT_PATH);
  let draft = normalizeOnboardingDraft();
  if (existsSync(draftPath)) {
    try {
      draft = normalizeOnboardingDraft(JSON.parse(readFileSync(draftPath, "utf8")));
    } catch {
      draft = normalizeOnboardingDraft();
    }
  }
  if (!dbExists(pathCtx)) return draft;
  const canonical = skillChatThreadRead({
    ...pathCtx,
    skill: "ingest-profile",
  }).messages.filter((message) => message.visibility !== "internal");
  return normalizeOnboardingDraft({
    ...draft,
    transcript: collapseUnansweredOnboardingPrompts(
      reconcileOnboardingTranscript(draft.transcript, canonical)
    ),
  });
}

function writeOnboardingDraft(pathCtx, draft) {
  // finishedAt is a one-way completion flag consumed by desktop launch
  // routing; wizard autosaves omit it, and an omitted key must never wipe a
  // stamp that is already on disk.
  const current = readOnboardingDraft(pathCtx);
  const finishedAt = draft?.finishedAt === undefined ? current.finishedAt : draft.finishedAt;
  const next = normalizeOnboardingDraft({
    ...current,
    ...draft,
    finishedAt,
    updatedAt: new Date().toISOString(),
  });
  const draftPath = userPath(pathCtx, ONBOARDING_DRAFT_PATH);
  mkdirSync(dirname(draftPath), { recursive: true });
  atomicWriteFile(draftPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function finishOnboarding({ repoRoot, env = process.env, now } = {}) {
  const pathCtx = { repoRoot, env };
  if (!dbExists(pathCtx)) {
    return {
      status: 409,
      body: {
        ok: false,
        code: "ONBOARDING_NOT_READY",
        error: "Paul still needs to finish candidate setup before opening the workspace.",
      },
    };
  }

  try {
    const config = candidateConfigGet(pathCtx);
    const sourceResumePresent =
      dbSourceResumePresent(pathCtx) || existsSync(userPath(pathCtx, "candidate/SOURCE_RESUME.md"));
    const stateData = {
      profile: config.profile,
      targeting: config.targeting,
      evidence: config.evidence,
      "form-defaults": config["form-defaults"],
      setup: config.setup,
    };
    const setupProgress = computeSetupProgress({
      data: stateData,
      sourceResumePresent,
      keyConfigured: resolveAIRoute(env, { repoRoot }).type !== "none",
    });
    const deterministicSources = dbDeterministicSourceCounts(pathCtx, config);
    const firstSearchRun = latestSourcingRunForUi({
      repoRoot,
      env,
      purpose: "first-search",
    });
    const firstSearchStatus = firstSearchRun.run?.status;
    const firstSearchReady =
      (firstSearchStatus === "running" || firstSearchStatus === "completed") &&
      firstSearchRun.inputsChanged !== true;
    const ready =
      setupProgress.complete &&
      config.setup?.readiness?.search_ready === true &&
      deterministicSources.attempted > 0 &&
      firstSearchReady;

    if (!ready) {
      return {
        status: 409,
        body: {
          ok: false,
          code: "ONBOARDING_NOT_READY",
          error:
            "Paul still has setup work to finish. Your answers are saved, so retry or pause here.",
          setupProgress,
          readiness: config.setup?.readiness || {},
          deterministicSources,
          firstSearchRun,
        },
      };
    }

    const draft = readOnboardingDraft(pathCtx);
    const finishedAt = draft.finishedAt || dateIsoForOnboarding(now);
    const handoff = workspaceOnboardingHandoff({
      repoRoot,
      env,
      transcript: draft.transcript,
      handoffText:
        firstSearchStatus === "completed"
          ? "Setup is complete. Your first search finished, and I’ll continue here with your job search."
          : "Setup is complete and your first search is underway. I’ll continue here with your job search.",
      finishedAt,
      now,
    });
    const savedDraft = writeOnboardingDraft(pathCtx, {
      finishedAt: handoff.finishedAt,
    });
    return {
      status: 200,
      body: {
        ok: true,
        draft: savedDraft,
        handoff: {
          reused: handoff.reused,
          repaired: handoff.repaired,
          messageCount: handoff.messages.length,
          finishedAt: handoff.finishedAt,
        },
      },
    };
  } catch (err) {
    return {
      status: err?.code === "NO_DATABASE" ? 409 : 500,
      body: {
        ok: false,
        code: err?.code || "ONBOARDING_FINISH_FAILED",
        error: err?.message || String(err),
      },
    };
  }
}

function dateIsoForOnboarding(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) throw new Error("invalid onboarding completion date");
  return date.toISOString();
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

// Read a candidate file's current YAML doc, falling back to the canonical
// genuinely-empty default (CANDIDATE_DEFAULTS) when the candidate file
// doesn't exist yet — so a merge always has a valid base to start from.
//
// This is deliberately NOT entry.templatePath's illustrative "Jane
// Candidate" example content. That template exists so CLI users can
// scaffold a workspace and hand-edit the YAML (ensureCandidateFiles());
// treating it as a real base here would both (a) hand the onboarding API's
// callers demo data as if it were the candidate's own, and (b) — for the
// write route below — merge a real field onto the demo persona and write
// the whole thing to disk as the candidate's file.
function readBaseDoc(entry, candidatePath) {
  if (!existsSync(candidatePath)) return cloneCandidateDefault(entry.name);
  const doc = parseYaml(readFileSync(candidatePath, "utf8")) || {};
  return entry.name === "profile" ? normalizeCandidateProfile(doc) : doc;
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
      // candidateSetupInitialize() pre-inserts every singleton row at
      // DB-creation time (see ensureSetupRows in
      // src/core/db/verbs/candidate.mjs), so the row's mere existence is
      // never proof the candidate answered anything — a row that is
      // byte-identical to the untouched default (isCandidateDefault) means
      // "nothing written yet," same as the legacy/YAML-mode fallback's
      // missing-file case below.
      exists: !isCandidateDefault(entry.name, data),
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

// W4 — the chat-first onboarding surface's 7-item file pane / mini-progress
// row (engine, resume, roles, companies, evidence, guardrails, quick facts).
// Every item is derived from data GET /api/onboard/state already computes or
// reads — no new store, per the W4 spec's server-scope note. `complete`
// mirrors the design's "Setup complete · 7 of 7" line; the caller can leave
// at any point (nothing here gates app routes, it's report-only).
// Lane A / R5 — authorization joins the original 7 as a glanceable "quick
// facts"-style setup item (the interview's confirm-pill kinds that aren't
// tied to a multi-field editor). Appended at the end rather than interleaved
// so every pre-existing index/order assumption (MiniProgressRow, FilePane's
// row list) keeps reading the first 7 exactly as before.
//
// `consent` (automation setup_mode) was REMOVED from this list — asking a
// brand-new, non-power-user candidate to consent to browser automation
// before they've seen a single job is a decision they have no context for
// yet, and gating setup completion on it was also a live lockout bug: the
// ingest-profile may not write candidate/automation.yml at all, so a CLI-onboarded
// candidate could never flip this item
// and sat at 8 of 9 forever, permanently redirected to /onboarding. The
// underlying automation-consent feature is untouched and still works —
// Settings' automation controls, src/core/automation/consent.mjs, and the
// interview's own consent_mode/consent_capability confirm pills all still
// read/write candidate/automation.yml exactly as before. It's just no
// longer part of the SETUP CHECKLIST or setupProgress.complete.
export { computeSetupProgress } from "../core/onboarding/setup-progress.mjs";

// Same self-heal-on-read as search-route.mjs's GET /api/search/sources (see
// healSearchSourceConfig's header comment in first-search-run.mjs) — this is
// the identical countDeterministicSources computation, just feeding
// GET /api/onboard/state's FinishStep readiness display instead of the Jobs
// page. Only attempts the (no-AI) heal when the stored count is 0.
function dbDeterministicSourceCounts(pathCtx, config) {
  const searchSources = sourceConfigGet({ ...pathCtx, name: "search-sources" }).data;
  const sourcedScan = sourceConfigGet({ ...pathCtx, name: "sourced-scan" }).data;
  const counts = countDeterministicSources({ searchSources, sourcedScan });
  if (counts.attempted > 0) return counts;
  const healed = healSearchSourceConfig({ ...pathCtx, config });
  return healed.healed ? healed.deterministicSources : counts;
}

function dbSearchSourcesPresent(pathCtx, config) {
  return dbDeterministicSourceCounts(pathCtx, config).attempted > 0;
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

function mergeLocationFilter(existing = {}, generated = {}) {
  const merged = mergeFilterObject(existing, generated);
  for (const key of ["allow", "block"]) {
    if (Array.isArray(generated?.[key])) merged[key] = compactArrayValues(generated[key]);
  }
  if (generated?.needs_location !== undefined) {
    merged.needs_location = generated.needs_location;
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
    location_filter: mergeLocationFilter(existing.location_filter, generated.location_filter),
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

function prepareDbSearchSources(pathCtx, config) {
  const sources = buildDbSearchSources(pathCtx, config);
  sourceConfigPut({ ...pathCtx, name: "search-sources", data: sources });
  return sources;
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

  const sources = prepareDbSearchSources(pathCtx, config);
  const searchCount = Array.isArray(sources?.searches) ? sources.searches.length : 0;
  return {
    status: 200,
    body: {
      ok: true,
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

function resolveOnboardingSearchPromptExecutionPlan({ repoRoot, env }) {
  const route = resolveAIRoute(env, { repoRoot });
  const runtimeId = aiRuntimeIdForRoute(route);
  if (!runtimeId) {
    const error = new Error(route.error || "Select a ready AI provider before generating prompts.");
    error.code = "NO_AI_ROUTE";
    throw error;
  }
  return resolveAIExecutionPlan({
    operation: "research.web",
    runtimeId,
    preferences: loadAIPreferences({ repoRoot, env }),
  });
}

function searchPromptOperationResultRef({ request, executionPlan, state = "saved" }) {
  return {
    type: "search-prompts",
    id: request.inputFingerprint,
    state,
    executionPlan,
  };
}

export function createOnboardingSearchPromptOperationKind({
  repoRoot,
  env = process.env,
  buildContext = () => buildSearchPromptContext({ repoRoot, env }),
  resolveExecutionPlan = () => resolveOnboardingSearchPromptExecutionPlan({ repoRoot, env }),
  generateSearchPromptsImpl = generateSearchPrompts,
  getSearchPromptsImpl = getSearchPrompts,
  saveSearchPromptsImpl = saveSearchPrompts,
} = {}) {
  return {
    resumeOnRestart: true,
    parseRequest(input = {}) {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).length
      ) {
        const error = new Error("onboarding search-prompt input must be empty");
        error.code = "BAD_REQUEST";
        throw error;
      }
      const context = buildContext();
      if (!context || typeof context !== "object" || Array.isArray(context)) {
        const error = new Error("onboarding search-prompt context is unavailable");
        error.code = "SEARCH_PROMPTS_NO_TARGETING";
        throw error;
      }
      return {
        context,
        inputFingerprint: createHash("sha256").update(JSON.stringify(context)).digest("hex"),
      };
    },
    resolveExecutionPlan() {
      return assertAIExecutionPlanForOperation(resolveExecutionPlan(), "research.web");
    },
    isCompletedResultReusable({ request }) {
      const current = getSearchPromptsImpl({ repoRoot, env });
      return (
        current.prompts?.length > 0 && current.savedInputFingerprint === request.inputFingerprint
      );
    },
    normalizeError(error) {
      return {
        code: String(error?.code || "SEARCH_PROMPTS_GENERATION_FAILED"),
        message: "CareerRat couldn't generate the initial search prompts. Try again.",
        retryable: error?.retryable !== false,
      };
    },
    async execute({ request, executionPlan, signal, reportProgress }) {
      const frozenPlan = assertAIExecutionPlanForOperation(executionPlan, "research.web");
      const existing = getSearchPromptsImpl({ repoRoot, env });
      if (existing.prompts?.length) {
        return {
          resultRef: searchPromptOperationResultRef({
            request,
            executionPlan: frozenPlan,
            state: "preserved",
          }),
        };
      }
      await reportProgress?.({
        phase: "generating",
        message: "CareerRat is preparing search prompts from your targeting.",
      });
      const outcome = await generateSearchPromptsImpl({
        repoRoot,
        env,
        context: request.context,
        executionPlan: frozenPlan,
        signal,
      });
      if (!outcome?.body?.ok) {
        const error = new Error(
          outcome?.body?.error?.message || "CareerRat couldn't generate search prompts."
        );
        error.code = outcome?.body?.code || "SEARCH_PROMPTS_GENERATION_FAILED";
        throw error;
      }
      if (!getSearchPromptsImpl({ repoRoot, env }).prompts?.length) {
        saveSearchPromptsImpl({
          repoRoot,
          env,
          prompts: outcome.body.data.prompts,
          defaultSource: "generated",
        });
      }
      return {
        resultRef: searchPromptOperationResultRef({ request, executionPlan: frozenPlan }),
      };
    },
  };
}

export async function recoverOnboardingSearchPromptOperations({
  appOperations,
  recovered = [],
} = {}) {
  if (!appOperations?.retry) return [];
  const restarted = [];
  for (const operation of recovered) {
    if (
      operation?.kind !== ONBOARDING_SEARCH_PROMPTS_OPERATION_KIND ||
      operation?.status !== "failed" ||
      operation?.error?.retryable !== true
    ) {
      continue;
    }
    try {
      restarted.push(await appOperations.retry({ id: operation.id }));
    } catch {
      // Another process may already own the linked retry.
    }
  }
  return restarted;
}

function visibleAppOperation(operation) {
  if (!operation) return null;
  return Object.fromEntries(
    [
      "id",
      "kind",
      "status",
      "executionPlan",
      "progress",
      "resultRef",
      "error",
      "retryOf",
      "attempt",
      "createdAt",
      "startedAt",
      "completedAt",
      "updatedAt",
    ]
      .filter((key) => operation[key] !== undefined)
      .map((key) => [key, operation[key]])
  );
}

export async function prepareQuickStartFirstSearch({
  repoRoot,
  env = process.env,
  fetchImpl = fetch,
  retry = false,
  workspaceAgentRuntime,
  appOperations,
  startFirstSearchImpl = startFirstSearchRun,
  runSearchInBackgroundImpl = runFirstSearchInBackground,
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
    const result = workspaceAgentRuntime
      ? (
          await workspaceAgentRuntime.executeIntent({
            intent: {
              type: "search.run",
              entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
              input: { purpose: "first-search", retryFailed: retry === true },
            },
          })
        )?.operationResult
      : await startFirstSearchImpl({
          repoRoot,
          env,
          fetchImpl,
          retryFailed: retry === true,
        });
    if (!result) {
      const error = new Error("The workspace agent did not return a first-search run.");
      error.code = "SEARCH_START_FAILED";
      throw error;
    }
    if (
      !workspaceAgentRuntime?.startsSearchInBackground &&
      result.reused !== true &&
      result.run?.status === "running"
    ) {
      void runSearchInBackgroundImpl({
        repoRoot,
        env,
        fetchImpl,
        runId: result.run.id,
      })
        .then((run) => workspaceAgentRuntime?.recordSearchCompletion?.({ run }))
        .catch(() => {});
    }

    let searchPromptsOperation = null;
    try {
      if (!getSearchPrompts({ repoRoot, env }).prompts.length && appOperations?.start) {
        const started = await appOperations.start({
          kind: ONBOARDING_SEARCH_PROMPTS_OPERATION_KIND,
          input: {},
        });
        searchPromptsOperation = visibleAppOperation(started.operation);
      }
    } catch {
      // Prompt generation stays optional and never blocks the deterministic first search.
    }

    return {
      status: result.reused ? 200 : 202,
      body: {
        ...result,
        locks: {
          gateReady: setup.readiness?.gate_ready === true,
          applyReady: setup.readiness?.apply_ready === true,
        },
        ...(searchPromptsOperation ? { searchPromptsOperation } : {}),
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
  extractDocxResumeMarkdown = defaultExtractDocxResumeMarkdown,
  fetchImpl = fetch,
  workspaceAgentRuntime,
  appOperations,
  startFirstSearchImpl = startFirstSearchRun,
  runSearchInBackgroundImpl = runFirstSearchInBackground,
  finishOnboardingImpl = finishOnboarding,
  resumeWorkerOwnerId = `resume-worker-${process.pid}-${randomUUID()}`,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) {
  const pathCtx = { repoRoot, env };
  const activeResumeExtractions = new Map();

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
        const deterministicSources = dbDeterministicSourceCounts(pathCtx, config);
        const deepIngest = buildDeepIngestViewModel({ repoRoot, env });
        const dbSourceResumePresentValue =
          dbSourceResumePresent(pathCtx) ||
          existsSync(userPath(pathCtx, "candidate/SOURCE_RESUME.md"));
        const dbKeyConfigured = resolveAIRoute(env, { repoRoot }).type !== "none";
        const resumeExtraction = resumeExtractionGet(pathCtx).operation;
        const stateData = {
          profile: config.profile,
          targeting: config.targeting,
          evidence: config.evidence,
          "form-defaults": config["form-defaults"],
          // Lane A / R1, R5 — setup_mode/capabilities/consent only:
          // automation.integrations carries logo.dev credentials, and this
          // route already has a hard "never echo credential values" contract
          // (see logoImageTokenConfigured/logoSearchTokenConfigured below) —
          // never widen this to the raw `automation` doc.
          automation: {
            setup_mode: automation.setup_mode,
            capabilities: automation.capabilities,
            consent: automation.consent,
          },
          modes: config.modes,
          honesty: config.honesty,
          setup: config.setup,
          deepIngest,
          sourcing: {
            firstSearchRun,
            sourceSetup: { deterministicSources },
          },
        };
        sendJson(res, 200, {
          ok: true,
          files: dbCandidateFiles(repoRoot, pathCtx, config),
          data: stateData,
          deepIngest,
          sourcing: { firstSearchRun },
          deterministicSources,
          resumeExtraction,
          sourceResumePresent: dbSourceResumePresentValue,
          keyConfigured: dbKeyConfigured,
          searchSourcesPresent: dbSearchSourcesPresent(pathCtx, config),
          logoImageTokenConfigured: !!(integrations.logo_dev_token || publishableToken),
          logoSearchTokenConfigured: !!(integrations.logo_dev_secret_key || secretKey),
          publicSyncPreference: publicSyncPreferenceGet(pathCtx).preference,
          setupProgress: computeSetupProgress({
            data: stateData,
            sourceResumePresent: dbSourceResumePresentValue,
            keyConfigured: dbKeyConfigured,
          }),
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

    // Settings-page prefill data for the curated subset of candidate files
    // the M7 Settings surface reads (see SETTINGS_DATA_FILES above). This
    // extends the existing state read rather than adding a parallel
    // GET /api/onboard/candidate/:name route: the M7 design explicitly
    // prefers extending state when it's missing a needed read, over growing
    // the route surface.
    //
    // readBaseDoc() falls back to the canonical genuinely-empty doc (never
    // the illustrative "Jane Candidate" example template) when a candidate
    // file doesn't exist yet, so `data` is always safe to feed straight into
    // computeSetupProgress below: an unanswered field reads as unset, not as
    // demo content the candidate never supplied.
    const data = {};
    for (const name of SETTINGS_DATA_FILES) {
      const entry = CANDIDATE_ROUTE_ENTRIES.find((f) => f.name === name);
      if (!entry) continue;
      const candidatePath = userPath(pathCtx, entry.candidatePath);
      try {
        data[name] = readBaseDoc(entry, candidatePath);
      } catch {
        // The candidate file doesn't parse (e.g. a minimal test fixture, or
        // hand-edited YAML mid-repair) — degrade to an empty prefill rather
        // than 500ing the whole state read.
        data[name] = {};
      }
    }
    // Lane A / R1, R5 — same credential-echo guard as the DB path above:
    // automation.integrations is never handed back, even in the non-DB
    // compatibility fallback.
    if (data.automation) {
      data.automation = {
        setup_mode: data.automation.setup_mode,
        capabilities: data.automation.capabilities,
        consent: data.automation.consent,
      };
    }

    // M8 additive (Builder B): logo.dev credential presence, never the values
    // themselves — reuses logo-route.mjs's own resolveLogoTokens() so this
    // route doesn't re-derive candidate/automation.yml's read/fallback shape.
    // The Companies step uses these to decide whether to show the
    // autocomplete/logo affordances or degrade straight to manual entry +
    // initials, without ever seeing the secret/token values.
    const { publishableToken, secretKey } = resolveLogoTokens(pathCtx, env);
    const fallbackSourceResumePresent = existsSync(
      userPath(pathCtx, sourceResumeEntry.candidatePath)
    );
    const fallbackKeyConfigured = resolveAIRoute(env, { repoRoot }).type !== "none";

    sendJson(res, 200, {
      ok: true,
      files,
      data,
      sourceResumePresent: fallbackSourceResumePresent,
      keyConfigured: fallbackKeyConfigured,
      searchSourcesPresent: existsSync(userPath(pathCtx, "config/search-sources.yml")),
      logoImageTokenConfigured: !!publishableToken,
      logoSearchTokenConfigured: !!secretKey,
      publicSyncPreference: DEFAULT_PUBLIC_SYNC_PREFERENCE,
      setupProgress: computeSetupProgress({
        data,
        sourceResumePresent: fallbackSourceResumePresent,
        keyConfigured: fallbackKeyConfigured,
      }),
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
      sendJson(res, err.status || 400, {
        ok: false,
        error: { message: err.message },
      });
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

  addRoute("POST", "/api/onboard/finish", async (_req, res) => {
    try {
      const result = await finishOnboardingImpl({ repoRoot, env });
      if (
        result.status === 200 &&
        result.body?.handoff?.reused !== true &&
        result.body?.handoff?.repaired !== true &&
        typeof workspaceAgentRuntime?.executeIntent === "function"
      ) {
        try {
          await workspaceAgentRuntime.executeIntent({
            intent: {
              type: "source.discover",
              entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
              input: {
                request:
                  "Continue post-onboarding source discovery with research-boards before company discovery.",
              },
            },
          });
        } catch {
          // Graduation is already durable and the baseline search is usable.
          // Doctor keeps the same research-boards handoff available for retry.
        }
      }
      sendJson(res, result.status, result.body);
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        code: err?.code || "ONBOARDING_FINISH_FAILED",
        error: err?.message || String(err),
      });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/onboard/public-sync-preference — local opt-in/out for sharing
  // public company and board metadata back to future CareerRat users. The
  // public-intel DB verbs are fail-closed scrubbed; this route only toggles
  // whether the local workspace should participate.
  // -------------------------------------------------------------------------
  addRoute("POST", "/api/onboard/public-sync-preference", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, {
        ok: false,
        error: { message: err.message },
      });
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
      const result = publicSyncPreferenceSet({
        ...pathCtx,
        enabled: body.enabled,
      });
      sendJson(res, 200, { ok: true, publicSyncPreference: result.preference });
    } catch (err) {
      sendJson(res, err?.status || 400, {
        ok: false,
        error: {
          message: err?.message || String(err),
          code: err?.code || undefined,
        },
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
        error: "PDF/DOCX not supported: export resume as text or markdown",
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
  // Save the original upload, extract raw text locally, and quality-gate it —
  // that part is still fully deterministic and unconditional (unusable text
  // 422s before any AI is attempted). Once the text is usable: if an AI route
  // is configured, convert the DOCX to markdown (extractDocxResumeMarkdown
  // preserves hyperlink targets extractDocxResumeText drops — the fix for
  // vanishing LinkedIn/GitHub contact links), write it as an intake sidecar,
  // and run it through the same resume-extract flow POST /api/onboard/resume-ai
  // uses, via runResumeExtractBounded() (a hoisted function declaration
  // defined below, after the resume-ai route — JS hoists these to the top of
  // mountOnboardRoutes' scope, so the call site here is valid; it's
  // positioned there rather than above so the file's own retained-runtime
  // classification tests keep scoping the AI-touching literals to the
  // resume-ai route's slice rather than this deterministic-by-default one).
  // Any AI failure (unavailable, schema-invalid, provider error, or a thrown
  // error) falls back to today's fully deterministic response — a DOCX
  // upload must never fail, or behave differently, because the AI upgrade
  // failed when the deterministic text was already usable.
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
        error: `unsupported file type "${ext || name}": resume-docx accepts DOCX uploads only (.docx)`,
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

    const savedRelPath = resumeUploadRelPath(name, bytes);
    const savedPath = userPath(pathCtx, savedRelPath);
    mkdirSync(dirname(savedPath), { recursive: true });
    const reused = existsSync(savedPath);
    if (!reused) writeFileSync(savedPath, bytes);

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
        reused,
        guidance: "Paste text or upload PDF, TXT, or Markdown.",
      });
      return;
    }

    const parsed = parseResume(text);
    const localProfileSeed = deriveProfileSeed(parsed);
    const localEvidenceSeed = deriveEvidenceSeed(parsed);
    const rawTargetingSeed = deriveTargetingSeed(parsed);
    const localTargetingSeed = rawTargetingSeed ? normalizeTargetingSeed(rawTargetingSeed) : null;
    const resumeDocument = buildResumeDocumentFromParsed(parsed);
    const localSections = {
      experience: parsed.sections.experience.length,
      education: parsed.sections.education.length,
      skills: parsed.sections.skills.length,
      projects: parsed.sections.projects.length,
      other: parsed.sections.other.length,
    };
    const localData = {
      fullText: text,
      profileSeed: localProfileSeed,
      evidenceSeed: localEvidenceSeed,
      sections: localSections,
      resumeDocument,
      source: "docx",
      extraction: "local",
      savedPath: savedRelPath,
      reused,
      ...(localTargetingSeed?.role_buckets?.length ? { targetingSeed: localTargetingSeed } : {}),
    };
    const docxResponseData = (data) => ({
      profileSeed: data.profileSeed,
      evidenceSeed: data.evidenceSeed,
      sections: data.sections,
      ...(data.resumeDocument ? { resumeDocument: data.resumeDocument } : {}),
      source: "docx",
      extraction: data.extraction,
      savedPath: data.savedPath,
      reused: data.reused,
      ...(data.targetingSeed?.role_buckets?.length ? { targetingSeed: data.targetingSeed } : {}),
    });

    // AI upgrade — resolveAIRoute() never throws, it reports {type: "none"}
    // when neither ANTHROPIC_API_KEY nor CAREERRAT_AI_PROXY_URL is set (same
    // check GET /api/onboard/state already uses for keyConfigured), so this
    // is a plain gate, not a try/catch. Skipping the AI call entirely when no
    // route is configured means a DOCX upload with no key behaves exactly
    // like it did before this route existed — no invokeResumeExtract, no
    // runSkillStream call, nothing to fail.
    if (resolveAIRoute(env, { repoRoot }).type !== "none") {
      try {
        const markdown = await extractDocxResumeMarkdown(bytes);
        const markdownRelPath = `${savedRelPath}.md`;
        const markdownPath = userPath(pathCtx, markdownRelPath);
        atomicWriteFile(markdownPath, markdown);

        if (dbExists(pathCtx)) {
          let closed = false;
          res.on?.("close", () => {
            closed = true;
          });
          const upload = {
            savedRelPath,
            savedPath,
            reused,
            uploadDigest: createHash("sha256").update(bytes).digest("hex"),
          };
          const { started, execution } = startDurableResumeExtraction(upload, name, {
            inputPath: markdownPath,
            resultSource: "docx",
            resultExtraction: "ai",
            artifactSource: "docx",
            artifactExtraction: "ai",
            fallbackData: localData,
          });
          const response = execution
            ? await execution.promise
            : {
                status: 200,
                body: {
                  ok: true,
                  data: started.operation.result,
                  operation: started.operation,
                },
              };
          if (!closed) {
            if (response.body.ok) {
              sendJson(res, 200, {
                ok: true,
                ...docxResponseData(response.body.data),
                operation: response.body.operation,
                seedSaved: true,
              });
            } else {
              sendJson(res, response.status, response.body);
            }
          }
          return;
        }

        const outcome = await runResumeExtractBounded({
          savedPath: markdownPath,
        });

        if (outcome.body.ok) {
          const extracted = outcome.body.data || {};
          // full_text is required by config/resume-extract.schema.json, and the
          // bounded validator above already enforced its presence — no
          // resume_document-derived fallback needed here anymore (that
          // recomposable object was dropped from the extract contract; see
          // SKILL.md's own note).
          const fullText = normalizeDocxResumeText(extracted.full_text || "");
          const aiClaims = (extracted.claims || []).map((c, i) => ({
            id: `resume-${String(i + 1).padStart(3, "0")}`,
            claim: String(c?.claim ?? ""),
            evidence: String(c?.evidence ?? ""),
          }));
          const aiTargetingSeed = normalizeTargetingSeed(extracted.targeting_suggestions);

          const entry = COPY_ONLY_CANDIDATE_FILES.find((f) => f.name === "source-resume");
          const dest = userPath(pathCtx, entry.candidatePath);
          mkdirSync(dirname(dest), { recursive: true });
          atomicWriteFile(dest, fullText);

          sendJson(res, 200, {
            ok: true,
            profileSeed: { candidate: extracted.candidate || {} },
            evidenceSeed: { claims: aiClaims },
            sections: extracted.sections || {},
            source: "docx",
            extraction: "ai",
            savedPath: savedRelPath,
            reused,
            ...(aiTargetingSeed?.role_buckets?.length ? { targetingSeed: aiTargetingSeed } : {}),
          });
          return;
        }
      } catch {
        // Fall through to the deterministic path below — an AI hiccup never
        // fails a DOCX upload the deterministic parser already handled.
      }
    }

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
      ...docxResponseData(localData),
    });
  });

  // Shared upload intake for POST /api/onboard/resume-ai and its SSE sibling
  // POST /api/onboard/resume-ai-stream below: identical ?name= extension
  // check, 5MB raw-body cap, and saved-upload path for both — only what
  // happens with the file afterward (a buffered response vs. a live
  // progress stream) differs between the two routes.
  async function saveResumeAiUpload(req, name) {
    const ext = extname(name).toLowerCase();
    if (!RESUME_AI_ALLOWED_EXTENSIONS.has(ext)) {
      return {
        ok: false,
        status: 400,
        body: {
          error:
            `unsupported file type "${ext || name}": resume-ai accepts PDF, image, or text uploads ` +
            "(.pdf .png .jpg .jpeg .webp .txt .md .markdown)",
        },
      };
    }

    let bytes;
    try {
      bytes = await readRawBodyCapped(req, RESUME_AI_MAX_BYTES);
    } catch (err) {
      return {
        ok: false,
        status: err.status || 400,
        body: { error: err.message },
      };
    }
    if (!bytes.length) {
      return {
        ok: false,
        status: 400,
        body: { error: "request body is empty" },
      };
    }

    const savedRelPath = resumeUploadRelPath(name, bytes);
    const savedPath = userPath(pathCtx, savedRelPath);
    mkdirSync(dirname(savedPath), { recursive: true });
    const reused = existsSync(savedPath);
    // Raw bytes (a PDF/image) — never atomicWriteFile, which hardcodes utf8
    // and would corrupt binary data.
    if (!reused) writeFileSync(savedPath, bytes);

    return {
      ok: true,
      savedRelPath,
      savedPath,
      reused,
      uploadDigest: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  function resolvedResumeExecutionPlan() {
    const route = resolveAIRoute(env, { repoRoot });
    const runtimeId = aiRuntimeIdForRoute(route);
    if (!runtimeId) return null;
    return resolveAIExecutionPlan({
      operation: "structured.extraction",
      runtimeId,
      preferences: loadAIPreferences({ repoRoot, env }),
    });
  }

  function resumeExtractionData({ extracted, savedRelPath, reused, source = "ai", extraction }) {
    const fullText = normalizeDocxResumeText(extracted.full_text || "");
    const claims = (extracted.claims || []).map((claim, index) => ({
      id: `resume-${String(index + 1).padStart(3, "0")}`,
      claim: String(claim?.claim ?? ""),
      evidence: String(claim?.evidence ?? ""),
    }));
    return {
      fullText,
      profileSeed: { candidate: extracted.candidate || {} },
      evidenceSeed: { claims },
      sections: extracted.sections || {},
      targetingSeed: normalizeTargetingSeed(extracted.targeting_suggestions),
      source,
      ...(extraction ? { extraction } : {}),
      savedPath: savedRelPath,
      reused,
    };
  }

  function startResumeExtractionWorker({
    operation,
    savedPath,
    savedRelPath,
    name,
    reused,
    inputPath = savedPath,
    resultSource = "ai",
    resultExtraction,
    artifactSource = "resume-ai",
    artifactExtraction,
    fallbackData,
  }) {
    const existing = activeResumeExtractions.get(operation.id);
    if (existing) return existing;

    const controller = new AbortController();
    const listeners = new Set();
    const execution = { controller, listeners, shutdownRequested: false, promise: null };
    activeResumeExtractions.set(operation.id, execution);

    const complete = (data, outcome) => {
      const completed = resumeExtractionComplete({
        ...pathCtx,
        id: operation.id,
        ownerId: resumeWorkerOwnerId,
        artifact: {
          path: savedRelPath,
          filename: sanitizeUploadFilename(name),
          savedAt: new Date().toISOString(),
          source: artifactSource,
          ...(data.extraction || artifactExtraction
            ? { extraction: data.extraction || artifactExtraction }
            : {}),
          text: data.fullText,
          ...(data.resumeDocument ? { resumeDocument: data.resumeDocument } : {}),
        },
        result: data,
        ai: outcome?.body?.ai,
        manual: outcome?.body?.manual,
      }).operation;
      notify({ type: "done", data, operation: completed });
      return {
        status: 200,
        body: {
          ok: true,
          data,
          ai: outcome?.body?.ai,
          manual: outcome?.body?.manual || RESUME_AI_MANUAL,
          operation: completed,
        },
      };
    };

    const notify = (event) => {
      for (const listener of listeners) listener(event);
      if (event?.type === "activity" && event.message) {
        try {
          resumeExtractionProgress({
            ...pathCtx,
            id: operation.id,
            ownerId: resumeWorkerOwnerId,
            progress: { phase: "reading", message: String(event.message) },
          });
        } catch {
          // A shutdown or terminal write may win this progress-only race.
        }
      }
    };

    execution.promise = Promise.resolve().then(async () => {
      const heartbeat = setIntervalImpl(() => {
        try {
          resumeExtractionProgress({
            ...pathCtx,
            id: operation.id,
            ownerId: resumeWorkerOwnerId,
            progress: { phase: "reading" },
          });
        } catch {
          // A shutdown or terminal write may win this progress-only race.
        }
      }, 30000);
      try {
        resumeExtractionProgress({
          ...pathCtx,
          id: operation.id,
          ownerId: resumeWorkerOwnerId,
          progress: { phase: "reading", message: `Reading ${sanitizeUploadFilename(name)}…` },
        });
        const outcome = await runResumeExtractBounded({
          savedPath: inputPath,
          originalName: name,
          onProgress: notify,
          signal: controller.signal,
          executionPlan: operation.executionPlan,
        });
        if (controller.signal.aborted) {
          const error =
            controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new Error("CareerRat stopped reading this resume. Try it again.");
          error.code ||= "RESUME_EXTRACTION_SERVER_STOPPED";
          throw error;
        }
        if (!outcome.body.ok) {
          if (fallbackData) {
            const data = typeof fallbackData === "function" ? fallbackData() : fallbackData;
            return complete(data, outcome);
          }
          const failed = resumeExtractionFail({
            ...pathCtx,
            id: operation.id,
            ownerId: resumeWorkerOwnerId,
            error: {
              code: outcome.body.code || "RESUME_EXTRACTION_FAILED",
              message:
                outcome.body.error?.message || "CareerRat couldn't read that resume. Try again.",
            },
          }).operation;
          notify({
            type: "error",
            message:
              outcome.body.error?.message || "CareerRat couldn't read that resume. Try again.",
            status: outcome.status,
            operation: failed,
          });
          return { status: outcome.status, body: { ...outcome.body, operation: failed } };
        }

        const data = resumeExtractionData({
          extracted: outcome.body.data || {},
          savedRelPath,
          reused,
          source: resultSource,
          extraction: resultExtraction,
        });
        return complete(data, outcome);
      } catch (error) {
        const stopped = execution.shutdownRequested || controller.signal.aborted;
        if (!stopped && fallbackData) {
          const current = resumeExtractionGet({ ...pathCtx, id: operation.id }).operation;
          if (["queued", "running"].includes(current?.status)) {
            try {
              const data = typeof fallbackData === "function" ? fallbackData() : fallbackData;
              return complete(data);
            } catch {
              // Persist the terminal failure below when deterministic fallback cannot commit.
            }
          }
        }
        const safeError = {
          code: stopped
            ? "RESUME_EXTRACTION_SERVER_STOPPED"
            : error?.code || "RESUME_EXTRACTION_FAILED",
          message: stopped
            ? "CareerRat stopped before it finished reading this resume. Try it again."
            : "CareerRat couldn't read that resume. Try again.",
        };
        let failed = null;
        try {
          failed = resumeExtractionFail({
            ...pathCtx,
            id: operation.id,
            ownerId: resumeWorkerOwnerId,
            error: safeError,
          }).operation;
        } catch {
          failed = resumeExtractionGet({ ...pathCtx, id: operation.id }).operation;
        }
        const body = {
          ok: false,
          code: safeError.code,
          error: { message: safeError.message },
          manual: RESUME_AI_MANUAL,
          operation: failed,
        };
        notify({ type: "error", message: safeError.message, status: 500, operation: failed });
        return { status: 500, body };
      } finally {
        clearIntervalImpl(heartbeat);
        activeResumeExtractions.delete(operation.id);
      }
    });
    return execution;
  }

  function startDurableResumeExtraction(upload, name, workerOptions = {}) {
    const started = resumeExtractionStart({
      ...pathCtx,
      uploadDigest: upload.uploadDigest,
      uploadPath: upload.savedRelPath,
      filename: sanitizeUploadFilename(name),
      executionPlan: resolvedResumeExecutionPlan(),
      ownerId: resumeWorkerOwnerId,
    });
    if (started.operation.status === "completed") {
      return { started, execution: null };
    }
    return {
      started,
      execution: startResumeExtractionWorker({
        operation: started.operation,
        savedPath: upload.savedPath,
        savedRelPath: upload.savedRelPath,
        name,
        reused: upload.reused,
        ...workerOptions,
      }),
    };
  }

  addRoute("GET", "/api/onboard/resume-ai/operation", (req, res) => {
    try {
      const requestUrl = new URL(req.url, "http://127.0.0.1");
      const operation = resumeExtractionGet({
        ...pathCtx,
        id: requestUrl.searchParams.get("id") || undefined,
        uploadDigest: requestUrl.searchParams.get("digest") || undefined,
      }).operation;
      sendJson(res, 200, { ok: true, operation });
    } catch (error) {
      sendJson(res, error?.code === "NOT_FOUND" ? 404 : 500, {
        ok: false,
        error: { message: error?.message || "Resume extraction could not be loaded." },
      });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/onboard/resume-ai?name=<filename> — raw PDF/image bytes.
  //
  // Frozen M8 contract: the request body IS the file (no JSON envelope,
  // unlike every other route in this file) — `name` travels as a query
  // param purely so the server knows the original filename/extension.
  // Saves via saveResumeAiUpload() above (shared with the SSE sibling
  // below), then runs the resume-extract skill one-shot via
  // runResumeExtractBounded() (a hoisted function declaration defined right
  // after these two routes — JS hoists these to the top of
  // mountOnboardRoutes' scope, so the call site here is valid; it's
  // positioned there rather than above so the file's own retained-runtime
  // classification tests keep scoping the AI-touching literals to the
  // resume-ai route's slice rather than this deterministic-by-default one).
  // The response shape uses the common bounded envelope.
  // -------------------------------------------------------------------------
  addRoute("POST", "/api/onboard/resume-ai", async (req, res) => {
    const requestUrl = new URL(req.url, "http://127.0.0.1");
    const name = (requestUrl.searchParams.get("name") || "").trim();
    if (!name) {
      sendJson(res, 400, { error: "?name=<filename> is required" });
      return;
    }

    const upload = await saveResumeAiUpload(req, name);
    if (!upload.ok) {
      sendJson(res, upload.status, upload.body);
      return;
    }
    const { savedRelPath, savedPath, reused } = upload;

    if (dbExists(pathCtx)) {
      let closed = false;
      res.on?.("close", () => {
        closed = true;
      });
      const { started, execution } = startDurableResumeExtraction(upload, name);
      if (!execution) {
        if (!closed) {
          const operation = started.operation;
          sendJson(res, 200, {
            ok: true,
            data: operation.result,
            ai: operation.ai,
            manual: operation.manual || RESUME_AI_MANUAL,
            operation,
          });
        }
        return;
      }
      const response = await execution.promise;
      if (!closed) sendJson(res, response.status, response.body);
      return;
    }

    const outcome = await runResumeExtractBounded({ savedPath });

    if (!outcome.body.ok) {
      sendJson(res, outcome.status, outcome.body);
      return;
    }

    const extracted = outcome.body.data || {};
    // full_text is required by config/resume-extract.schema.json, and the
    // bounded validator above already enforced its presence — no
    // resume_document-derived fallback needed here anymore (that
    // recomposable object was dropped from the extract contract for speed;
    // see resume-extract SKILL.md's own note).
    const fullText = normalizeDocxResumeText(extracted.full_text || "");
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
        profileSeed: { candidate: extracted.candidate || {} },
        evidenceSeed: { claims },
        sections: extracted.sections || {},
        targetingSeed: normalizeTargetingSeed(extracted.targeting_suggestions),
        source: "ai",
        savedPath: savedRelPath,
        reused,
      },
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/onboard/resume-ai-stream?name=<filename> — SSE sibling of
  // POST /api/onboard/resume-ai above: identical upload validation/limits/
  // save path (via saveResumeAiUpload()), but streams resume-extract's
  // progress back over Server-Sent Events instead of buffering into one big
  // response — a real PDF extraction call can take ~2 minutes with nothing
  // else on the wire; this route gives the client something to show
  // throughout that wait. FROZEN CONTRACT — the wizard's ResumeStep client
  // is built against this exact frame shape; do not change it casually.
  //
  // Frames — each a standard SSE `data: <json>\n\n` (no `event:` line; the
  // `type` field inside the JSON carries that):
  //   {"type":"saved","savedPath":...}           right after the upload saves
  //   {"type":"activity","message":...}          short human progress lines
  //   {"type":"json","chunk":...}                each assistant text block, verbatim
  //   {"type":"restart"}                         bounded helper moved to its
  //                                               correction retry — client resets
  //   {"type":"done","data":{...}}                same `data` shape the buffered
  //                                               route returns (fullText, profileSeed,
  //                                               evidenceSeed, sections, targetingSeed,
  //                                               source:"ai", savedPath); the
  //                                               source-resume artifact is registered
  //                                               first, exactly like the buffered route
  //   {"type":"error","message":...,"status":n}  terminal failure, safe message only
  // Heartbeat: a `: ping\n\n` comment frame every 10s while the run is in
  // flight. Headers flush immediately once the upload is saved — everything
  // from that point on is committed to the stream, so any failure can only
  // be reported in-band (an {"type":"error"} frame), never a second
  // writeHead/sendJson.
  // -------------------------------------------------------------------------
  addRoute("POST", "/api/onboard/resume-ai-stream", async (req, res) => {
    const requestUrl = new URL(req.url, "http://127.0.0.1");
    const name = (requestUrl.searchParams.get("name") || "").trim();
    if (!name) {
      sendJson(res, 400, { error: "?name=<filename> is required" });
      return;
    }

    const upload = await saveResumeAiUpload(req, name);
    if (!upload.ok) {
      sendJson(res, upload.status, upload.body);
      return;
    }
    const { savedRelPath, savedPath, reused } = upload;

    if (dbExists(pathCtx)) {
      let closed = false;
      res.on("close", () => {
        closed = true;
      });
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.flushHeaders?.();
      const emit = (payload) => {
        if (closed) return;
        try {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch {
          closed = true;
        }
      };
      emit({
        type: "saved",
        savedPath: savedRelPath,
        reused,
        uploadDigest: upload.uploadDigest,
      });
      const { started, execution } = startDurableResumeExtraction(upload, name);
      emit({ type: "started", operation: started.operation });
      if (!execution) {
        emit({ type: "done", data: started.operation.result, operation: started.operation });
      } else {
        execution.listeners.add(emit);
        await execution.promise;
        execution.listeners.delete(emit);
      }
      if (!closed) res.end();
      return;
    }

    // Client-disconnect guard: `res.on("close")`, not `req.on("close")` —
    // see skill-run-route.mjs's own comment on this exact choice (req's own
    // "close" fires as soon as its body finishes being read, which is
    // unrelated to whether the client is still connected). The upload body
    // here has already been fully read by saveResumeAiUpload() above, so
    // req's "close" would be doubly misleading by this point.
    let closed = false;
    res.on("close", () => {
      closed = true;
    });

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();

    function emit(payload) {
      if (closed) return;
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        closed = true;
      }
    }

    emit({ type: "saved", savedPath: savedRelPath, reused });

    const heartbeat = setInterval(() => {
      if (closed) return;
      try {
        res.write(": ping\n\n");
      } catch {
        closed = true;
      }
    }, 10000);

    try {
      const outcome = await runResumeExtractBounded({
        savedPath,
        originalName: name,
        onProgress: emit,
      });

      if (!outcome.body.ok) {
        emit({
          type: "error",
          message: outcome.body.error?.message || "Resume extraction failed.",
          status: outcome.status,
        });
        return;
      }

      const extracted = outcome.body.data || {};
      const fullText = normalizeDocxResumeText(extracted.full_text || "");
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
          },
        });
      } else {
        const entry = COPY_ONLY_CANDIDATE_FILES.find((f) => f.name === "source-resume");
        const dest = userPath(pathCtx, entry.candidatePath);
        mkdirSync(dirname(dest), { recursive: true });
        atomicWriteFile(dest, fullText);
      }

      emit({
        type: "done",
        data: {
          fullText,
          profileSeed: { candidate: extracted.candidate || {} },
          evidenceSeed: { claims },
          sections: extracted.sections || {},
          targetingSeed: normalizeTargetingSeed(extracted.targeting_suggestions),
          source: "ai",
          savedPath: savedRelPath,
          reused,
        },
      });
    } catch {
      // Never relay a raw caught error message here — an exception this
      // late is an unexpected bug, not a scrubbed provider failure, so its
      // message could contain anything (a file path, a stack fragment). The
      // known failure shapes (schema-invalid, no AI route, provider error)
      // are all handled above via outcome.body, already scrubbed by
      // bounded-ai.mjs's own error normalization.
      emit({
        type: "error",
        message: "Resume extraction failed unexpectedly.",
        status: 500,
      });
    } finally {
      clearInterval(heartbeat);
      if (!closed) {
        try {
          res.end();
        } catch {
          // client already gone
        }
      }
    }
  });

  // Shared by all three resume-extract callers: POST /api/onboard/resume-ai
  // (PDF/image, over the saved upload itself), its SSE sibling
  // POST /api/onboard/resume-ai-stream above, and POST /api/onboard/resume-docx's
  // AI upgrade (over a converted markdown sidecar). Runs the resume-extract
  // skill one-shot against `savedPath`, Read-only tool surface, buffers the
  // assistant's text reply, and validates/retries it via the shared
  // bounded-AI fallback helper. `originalName`/`onProgress` are optional —
  // the two buffered callers omit them (byte-identical to before this
  // change), while the SSE route above passes both to narrate the run.
  async function runResumeExtractBounded({
    savedPath,
    originalName,
    onProgress,
    signal,
    executionPlan,
  } = {}) {
    const schema = JSON.parse(readFileSync(join(repoRoot, RESUME_EXTRACT_SCHEMA_PATH), "utf8"));

    // Speed: résumé extraction is a well-bounded transcription+classification
    // task a fast/cheap model handles reliably, and — now that the extract
    // contract no longer asks for a resume_document duplicate — output size
    // is small enough that model choice, not payload size, is what
    // dominates wall-clock time. The FIRST attempt runs on that fast model;
    // a correction retry (the bounded helper's second pass, triggered only
    // when the first attempt's reply failed schema validation) falls back
    // to the server's normally-configured default model instead — the
    // quality net for whatever tripped the fast model up the first time.
    const fastModel = env.CAREERRAT_RESUME_EXTRACT_MODEL || "claude-haiku-4-5-20251001";

    // Scoped per run (per call to runResumeExtractBounded), not per attempt
    // — "the first time" a system event batch arrives, across the whole
    // run including any correction retry, not once per attempt.
    let sawSystemEvent = false;

    // One attempt of the one-shot skill run: Read-only tool surface, the
    // saved file's path as input (a corrective addendum on a retry — see
    // structured-oneshot.mjs's own header comment for why `invoke` throwing
    // here is deliberately NOT caught inside runStructuredOneshot). Buffers
    // every `assistant` event's text blocks in order, exactly like
    // skill-runtime.mjs's own header comment describes for a driven
    // (non-SSE-passthrough) run — and, when `onProgress` is given, narrates
    // the same event stream as short activity lines plus verbatim JSON
    // chunks for the SSE route above.
    async function invokeResumeExtract({ correction }) {
      let rawText = "";
      // Reset every attempt — "at most once per attempt".
      let emittedThinking = false;
      const runtimeResult = await runSkillStream({
        skill: "resume-extract",
        action: RESUME_AI_LABELS.action,
        operation: RESUME_AI_LABELS.operation,
        input: correction
          ? `Read the file at this exact path: ${savedPath}\n\n${correction}`
          : { path: savedPath },
        repoRoot,
        // Only the first (non-correction) attempt gets the fast-model env
        // override — a retry runs with the unmodified env, i.e. whatever
        // model this server is normally configured for.
        env: correction ? env : { ...env, ANTHROPIC_MODEL: fastModel },
        tools: ["Read"],
        approvedReadPaths: [savedPath],
        outputSchema: schema,
        signal,
        executionPlan: executionPlan || undefined,
        useExecutionPlanRoute: Boolean(executionPlan),
        onEvent: (evt) => {
          if (onProgress) {
            if (evt.type === "system") {
              // Too chatty to narrate individually — suppress every one
              // except the very first, which tells the user we're actually
              // reading their file.
              if (!sawSystemEvent) {
                sawSystemEvent = true;
                onProgress({
                  type: "activity",
                  message: `Reading ${originalName}…`,
                });
              }
              return;
            }
            if (evt.type === "tool_use" && evt.data?.name === "Read") {
              const toolPath = String(evt.data?.input?.file_path || evt.data?.input?.path || "");
              if (toolPath) {
                onProgress({
                  type: "activity",
                  message: `Reading ${basename(toolPath)}…`,
                });
              }
              return;
            }
          }
          if (evt.type !== "assistant") return;
          for (const block of evt.data?.message?.content ?? []) {
            if (block?.type === "text" && typeof block.text === "string") {
              rawText += block.text;
              onProgress?.({ type: "json", chunk: block.text });
            } else if (onProgress && block?.type === "thinking" && !emittedThinking) {
              emittedThinking = true;
              onProgress({
                type: "activity",
                message: "Analyzing your resume…",
              });
            }
          }
        },
      });
      if (runtimeResult?.ok === false) {
        const error = new Error(runtimeResult.error || "The selected AI runtime failed.");
        error.code = runtimeResult.code || "AI_PROVIDER_FAILED";
        throw error;
      }
      return rawText;
    }

    onProgress?.({ type: "activity", message: "Warming up the reader…" });

    const outcome = await runBoundedAI({
      labels: RESUME_AI_LABELS,
      schema,
      manual: RESUME_AI_MANUAL,
      structuredMode: "fallback",
      maxRetries: 1,
      invoke: async ({ correction }) => {
        if (correction && onProgress) onProgress({ type: "restart" });
        return invokeResumeExtract({ correction });
      },
    });

    if (outcome.body.ok && !hasUsableResumeExtraction(outcome.body.data)) {
      return makeBoundedAIEnvelope({
        ok: false,
        status: 422,
        code: "RESUME_EXTRACTION_INCOMPLETE",
        error: {
          message:
            "AI could not extract usable resume facts. Try a clearer file or use the manual text path.",
        },
        ai: outcome.body.ai,
        manual: outcome.body.manual,
      });
    }

    return outcome;
  }

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
              ? candidateEvidenceMerge({
                  ...pathCtx,
                  claims: patch.claims || [],
                })
              : candidateConfigPatch({ ...pathCtx, name: entry.name, patch });
          sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          sendCandidateError(res, err);
        }
        return;
      }

      const candidatePath = userPath(pathCtx, entry.candidatePath);
      const base = readBaseDoc(entry, candidatePath);
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
  // POST /api/onboard/candidate/evidence/replace — replace one whole evidence
  // section atomically while preserving every supplied durable claim id.
  // -------------------------------------------------------------------------
  addRoute("POST", "/api/onboard/candidate/evidence/replace", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return;
    }
    const posted = Array.isArray(body?.claims) ? body.claims : null;
    if (!posted) {
      sendJson(res, 400, {
        ok: false,
        error: "body.claims must be an array",
      });
      return;
    }
    if (!dbExists(pathCtx)) {
      sendJson(res, 409, {
        ok: false,
        error: "SQLite candidate setup is required",
      });
      return;
    }
    try {
      const result = candidateEvidenceReplace({ ...pathCtx, claims: posted });
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      sendCandidateError(res, err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/onboard/candidate/evidence/remove — { id } delete exactly one
  // evidence claim by id (new verb: candidateEvidenceRemoveOne). A clean
  // 404-equivalent surfaces via sendCandidateError for an unknown id — same
  // NOT_FOUND -> sendCandidateError convention every other candidate route
  // in this file already uses.
  // -------------------------------------------------------------------------
  addRoute("POST", "/api/onboard/candidate/evidence/remove", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.message });
      return;
    }

    const id = typeof body?.id === "string" ? body.id.trim() : "";
    if (!id) {
      sendJson(res, 400, { ok: false, error: "body.id is required" });
      return;
    }

    if (!dbExists(pathCtx)) {
      sendJson(res, 409, {
        ok: false,
        error: "SQLite candidate setup is required",
      });
      return;
    }

    try {
      const result = candidateEvidenceRemoveOne({ ...pathCtx, id });
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      sendCandidateError(res, err);
    }
  });

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
    const doc = readBaseDoc(entry, candidatePath);
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
      added.push({
        id,
        claim: claimText,
        evidence: String(raw?.evidence ?? ""),
      });
    }

    const merged = { ...doc, claims: [...existingClaims, ...added] };
    const schema = readSchema(repoRoot, entry);
    const { valid, errors } = validate(merged, schema);
    if (!valid) {
      sendJson(res, 400, { ok: false, errors });
      return;
    }

    writeYamlDoc(candidatePath, merged);
    sendJson(res, 200, {
      ok: true,
      added: added.length,
      skipped,
      total: merged.claims.length,
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

    const result = await prepareQuickStartFirstSearch({
      repoRoot,
      env,
      fetchImpl,
      retry: body?.retry === true,
      workspaceAgentRuntime,
      appOperations,
      startFirstSearchImpl,
      runSearchInBackgroundImpl,
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
    sendJson(res, 200, {
      ok: true,
      route: "byok",
      provider: validation.provider,
    });
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
      sendJson(res, 200, {
        ok: true,
        route: "proxy",
        provider: "managed-proxy",
      });
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
    sendJson(res, 200, {
      ok: true,
      route: "byok",
      provider: validation.provider,
    });
  });

  addRoute("GET", "/api/settings/ai", (_req, res) => {
    sendJson(res, 200, {
      route: resolveAIRoute(env, { repoRoot }).type,
      keyPresent: !!env.ANTHROPIC_API_KEY,
    });
  });

  addRoute("GET", "/api/settings/usage", (_req, res) => {
    sendJson(res, 200, {
      ok: true,
      summary: summarizeUsageEvents(readUsageEvents({ root: repoRoot })),
    });
  });

  async function shutdownResumeExtractions() {
    const active = [...activeResumeExtractions.values()];
    for (const execution of active) {
      execution.shutdownRequested = true;
      const error = new Error(
        "CareerRat stopped before it finished reading this resume. Try it again."
      );
      error.code = "RESUME_EXTRACTION_SERVER_STOPPED";
      execution.controller.abort(error);
    }
    await Promise.all(active.map((execution) => execution.promise));
  }

  function recoverResumeExtractions() {
    if (!dbExists(pathCtx)) return { ok: true, recovered: [] };
    return resumeExtractionRecoverOrphans({
      ...pathCtx,
      ownerId: resumeWorkerOwnerId,
    });
  }

  return {
    shutdownResumeExtractions,
    recoverResumeExtractions,
  };
}
