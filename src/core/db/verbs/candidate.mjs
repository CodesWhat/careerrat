// verbs/candidate.mjs — SQLite-backed candidate setup state.
//
// These verbs are intentionally separate from tracker-visible write verbs:
// profile/targeting/evidence/preferences setup is app state, not an
// application pipeline mutation. They do not bump tracker meta or write
// activity rows. Compatibility exports can materialize YAML later, but DB-mode
// app onboarding writes here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DEEP_INGEST_REQUIRED_LANES,
  evaluateDeepIngestReadiness,
} from "../../deep-ingest/readiness.mjs";
import {
  CANDIDATE_DEFAULTS,
  normalizeCandidateProfile,
} from "../../profile/candidate-defaults.mjs";
import { hasConfiguredCompensationFloor } from "../../profile/compensation.mjs";
import { assertCleanEvidenceClaims } from "../../profile/evidence-validation.mjs";
import { validate } from "../../profile/schema-validator.mjs";
import { openDb, requireDb } from "../connection.mjs";
import { withTransaction } from "../transaction.mjs";
import { bumpMeta, logActivityEvent, runVerb } from "./shared.mjs";

const PRODUCT_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const SINGLETON_TABLES = {
  profile: "candidate_profile",
  targeting: "candidate_targeting",
  honesty: "candidate_honesty",
  "form-defaults": "candidate_form_defaults",
  modes: "candidate_modes",
  automation: "candidate_automation",
  "application-limits": "candidate_application_limits",
};

const SCHEMA_PATHS = {
  profile: "config/profile.schema.json",
  targeting: "config/targeting.schema.json",
  honesty: "config/honesty.schema.json",
  "form-defaults": "config/form-defaults.schema.json",
  modes: "config/modes.schema.json",
  automation: "config/automation.schema.json",
  "application-limits": "config/application-limits.schema.json",
  evidence: "config/evidence.schema.json",
};

// The candidate-defaults module is the single canonical "genuinely empty"
// shape shared with legacy/YAML-mode onboarding (see onboard-route.mjs's
// readBaseDoc()). "application-limits" has no legacy YAML-route counterpart
// and no example template, so it stays defined only here.
const DEFAULTS = {
  ...CANDIDATE_DEFAULTS,
  "application-limits": { companies: [] },
};

const DEFAULT_SETUP = {
  readiness: {
    search_ready: false,
    gate_ready: false,
    apply_ready: false,
    deep_ingest_complete: false,
  },
  missing: {
    search_ready: [],
    gate_ready: [],
    apply_ready: [],
    deep_ingest_complete: [],
  },
};

const CANDIDATE_ACTIVITY = {
  profile: {
    title: "Candidate profile updated",
    operation: "candidate:profile-update",
    summary: "Saved identity, contact, location, compensation, or authorization changes.",
  },
  targeting: {
    title: "Job targets updated",
    operation: "candidate:targeting-update",
    summary: "Saved role lanes, fit signals, companies, or search preferences.",
  },
  honesty: {
    title: "Honesty boundaries updated",
    operation: "candidate:honesty-update",
    summary: "Saved confirmed claims and do-not-claim boundaries.",
  },
  "form-defaults": {
    title: "Application defaults updated",
    operation: "candidate:application-defaults-update",
    summary: "Saved reusable application answers and document preferences.",
  },
  modes: {
    title: "Working preferences updated",
    operation: "candidate:modes-update",
    summary: "Saved usage, application, or agent-voice preferences.",
  },
  automation: {
    title: "Automation permissions updated",
    operation: "candidate:automation-update",
    summary: "Saved consent settings for optional automation capabilities.",
  },
  "application-limits": {
    title: "Application limits updated",
    operation: "candidate:application-limits-update",
    summary: "Saved company application caps and cooldown rules.",
  },
};

const DEEP_INGEST_LANE_LABELS = {
  source_coverage: "source coverage",
  evidence_claims: "deeper evidence bank",
  story_bank: "story bank",
  honesty_boundaries: "honesty boundaries",
  writing_voice: "writing voice",
  role_signals: "role signals",
  open_gaps: "open gaps",
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readSchema(name) {
  return JSON.parse(readFileSync(join(PRODUCT_ROOT, SCHEMA_PATHS[name]), "utf8"));
}

function assertValid(name, doc) {
  const schemaPath = SCHEMA_PATHS[name];
  if (!schemaPath) return;
  const { valid, errors } = validate(doc, readSchema(name));
  if (!valid) {
    const err = new Error(`${name} does not validate`);
    err.code = "VALIDATION_FAILED";
    err.errors = errors;
    throw err;
  }
}

function readSingleton(db, table, fallback) {
  const row = db.prepare(`SELECT data FROM ${table} WHERE id = 1`).get();
  return row ? JSON.parse(row.data) : clone(fallback);
}

function putSingleton(db, table, value) {
  db.prepare(
    `INSERT INTO ${table} (id, data, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
  ).run(JSON.stringify(value), new Date().toISOString());
}

function putSingletonIfMissing(db, table, value) {
  db.prepare(`INSERT OR IGNORE INTO ${table} (id, data, updated_at) VALUES (1, ?, ?)`).run(
    JSON.stringify(value),
    new Date().toISOString()
  );
}

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (!isPlainObject(patch)) return patch;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (Array.isArray(value)) out[key] = value.slice();
    else if (isPlainObject(value)) out[key] = deepMerge(out[key], value);
    else out[key] = value;
  }
  return out;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const LOCATION_MODE_FIELDS = [
  "remote",
  "remote_scope",
  "hybrid",
  "onsite",
  "relocation",
  "max_commute_days_per_week",
];

function normalizeCandidateProfilePatch(patch) {
  const location = patch?.location;
  if (!isPlainObject(location)) return patch;
  const normalizedLocation = { ...location };
  if (normalizedLocation.relocation === false) normalizedLocation.relocation = [];
  if (
    !Object.hasOwn(normalizedLocation, "mode_preferences_confirmed") &&
    LOCATION_MODE_FIELDS.some((field) => Object.hasOwn(normalizedLocation, field))
  ) {
    normalizedLocation.mode_preferences_confirmed = true;
  }
  return {
    ...patch,
    location: normalizedLocation,
  };
}

function compactStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function tableRows(db, table, order = "rowid ASC") {
  return db
    .prepare(`SELECT data FROM ${table} ORDER BY ${order}`)
    .all()
    .map((row) => JSON.parse(row.data));
}

function readTargeting(db) {
  const base = readSingleton(db, "candidate_targeting", DEFAULTS.targeting);
  return {
    ...base,
    role_buckets: tableRows(db, "candidate_search_tracks", "sort_order ASC, rowid ASC"),
    tracked_companies: tableRows(
      db,
      "candidate_target_companies",
      "kind ASC, sort_order ASC, name COLLATE NOCASE ASC"
    )
      .filter((row) => row.kind === "target")
      .map((row) => row.name),
    excluded_companies: tableRows(
      db,
      "candidate_target_companies",
      "kind ASC, sort_order ASC, name COLLATE NOCASE ASC"
    )
      .filter((row) => row.kind === "excluded")
      .map((row) => row.name),
  };
}

function readEvidence(db) {
  return { claims: tableRows(db, "candidate_evidence_claims", "rowid ASC") };
}

function readCandidateConfigFromDb(db) {
  return {
    profile: normalizeCandidateProfile(readSingleton(db, "candidate_profile", DEFAULTS.profile)),
    targeting: readTargeting(db),
    evidence: readEvidence(db),
    honesty: readSingleton(db, "candidate_honesty", DEFAULTS.honesty),
    "form-defaults": readSingleton(db, "candidate_form_defaults", DEFAULTS["form-defaults"]),
    modes: readSingleton(db, "candidate_modes", DEFAULTS.modes),
    automation: readSingleton(db, "candidate_automation", DEFAULTS.automation),
    "application-limits": readSingleton(
      db,
      "candidate_application_limits",
      DEFAULTS["application-limits"]
    ),
  };
}

function hasCandidateArtifact(db, { id, kind }) {
  if (id && db.prepare("SELECT 1 FROM candidate_artifacts WHERE id = ?").get(String(id))) {
    return true;
  }
  if (
    kind &&
    db.prepare("SELECT 1 FROM candidate_artifacts WHERE kind = ? LIMIT 1").get(String(kind))
  ) {
    return true;
  }
  return false;
}

function hasAnyTitle(targeting) {
  return (targeting.role_buckets || []).some((bucket) =>
    (bucket?.titles || []).some((title) => String(title || "").trim())
  );
}

function hasSearchLocation(profile) {
  const location = profile.location || {};
  const candidate = profile.candidate || {};
  return !!(
    String(location.home || "").trim() ||
    String(candidate.location || "").trim() ||
    location.remote ||
    location.hybrid ||
    location.onsite ||
    (Array.isArray(location.relocation) && location.relocation.length > 0)
  );
}

// authorizationDeclared — Lane A / R3: splits "declared" (a real answer exists
// for readiness purposes) from "authorized" (work_authorized or
// requires_sponsorship === true, hasAuthorization's old, still-narrower bar).
// gate.mjs / form-fill.mjs / sourced-scanner.mjs keep reading
// profile.authorization directly with their own semantics — this helper only
// feeds the readiness/setup surface below (searchMissing never referenced
// authorization; only gateMissing/applyMissing do).
//
// profile.authorization can't carry an "explicitly answered false/false" flag
// of its own: DEFAULTS.profile.authorization already seeds {work_authorized:
// false, requires_sponsorship: false} at candidateSetupInitialize() time (see
// DEFAULTS above, and gate.mjs's own notAuthorized check, which must keep
// reading that exact default) — so a profile-shape check alone can never tell
// a genuine "not authorized, no sponsorship needed either" answer apart from
// an untouched row. The interview UI (apps/web/src/onboarding/InterviewSurface.jsx)
// resolves that ambiguity procedurally: an authorization confirm-pill save that
// resolves to {false, false} ALSO records a form-defaults.declined_fields.authorization
// entry (same as an explicit "I'd rather not say") — so "declared" here is a
// single check: a recorded decline in form-defaults.declined_fields.authorization,
// or the pre-existing affirmative case.
export function authorizationDeclared(profile, formDefaults) {
  const auth = profile?.authorization || {};
  const declined = !!formDefaults?.declined_fields?.authorization;
  return auth.work_authorized === true || auth.requires_sponsorship === true || declined;
}

function tableExists(db, table) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
}

function computeDeepIngestReadiness(db) {
  if (!tableExists(db, "deep_ingest_lane_states")) {
    return evaluateDeepIngestReadiness({
      laneStates: [],
      requiredLanes: DEFAULT_DEEP_INGEST_REQUIRED_LANES,
    });
  }
  const rows = db
    .prepare("SELECT data FROM deep_ingest_lane_states")
    .all()
    .map((row) => JSON.parse(row.data));
  return evaluateDeepIngestReadiness({
    laneStates: rows,
    requiredLanes: DEFAULT_DEEP_INGEST_REQUIRED_LANES,
  });
}

function deepIngestSetupMissing(readiness) {
  if (readiness.ready) return [];
  return [
    readiness.progressText,
    ...readiness.missing.map((lane) => {
      const label = DEEP_INGEST_LANE_LABELS[lane.lane] || lane.label || lane.lane;
      if (lane.reasonRequired) {
        return `${label} requires a reason for ${humanizeDeepIngestStatus(lane.status)}.`;
      }
      return `${label}: ${humanizeDeepIngestStatus(lane.status)}.`;
    }),
  ];
}

function humanizeDeepIngestStatus(status) {
  return String(status || "not_started").replaceAll("_", " ");
}

function computeCandidateSetup(db) {
  const config = readCandidateConfigFromDb(db);
  const { profile, targeting, evidence } = config;
  const formDefaults = config["form-defaults"] || {};
  const hasSourceResume = hasCandidateArtifact(db, {
    id: "source-resume",
    kind: "source-resume",
  });
  const resumeHandled = hasSourceResume || !!formDefaults.declined_fields?.resume;
  const titlesReady = hasAnyTitle(targeting);
  const locationReady = hasSearchLocation(profile);
  const compReady = hasConfiguredCompensationFloor(profile.compensation);
  const authDeclared = authorizationDeclared(profile, formDefaults);
  const evidenceCount = (evidence.claims || []).length;

  const searchMissing = [];
  if (!resumeHandled) searchMissing.push("source resume");
  if (!titlesReady) searchMissing.push("role titles");
  if (!locationReady) searchMissing.push("search location or remote posture");

  const gateMissing = [];
  if (!titlesReady) gateMissing.push("role titles");
  if (!locationReady) gateMissing.push("location posture");
  if (!compReady) gateMissing.push("compensation floor");
  if (!authDeclared) gateMissing.push("work authorization");

  const applyMissing = [...gateMissing];
  if (!String(profile.candidate?.full_name || "").trim()) applyMissing.push("candidate full name");
  if (!String(profile.candidate?.email || "").trim()) applyMissing.push("candidate email");
  if (evidenceCount < 1) applyMissing.push("evidence claims");

  const deepReadiness = computeDeepIngestReadiness(db);
  const deepMissing = deepIngestSetupMissing(deepReadiness);

  return {
    readiness: {
      search_ready: searchMissing.length === 0,
      gate_ready: gateMissing.length === 0,
      apply_ready: applyMissing.length === 0,
      deep_ingest_complete: deepReadiness.ready,
    },
    missing: {
      search_ready: searchMissing,
      gate_ready: gateMissing,
      apply_ready: applyMissing,
      deep_ingest_complete: deepMissing,
    },
  };
}

function refreshCandidateSetup(db) {
  const setup = computeCandidateSetup(db);
  putSingleton(db, "candidate_setup", setup);
  return setup;
}

function putSearchTracks(db, buckets) {
  db.prepare("DELETE FROM candidate_search_tracks").run();
  const stmt = db.prepare(
    `INSERT INTO candidate_search_tracks (id, sort_order, data, updated_at) VALUES (?, ?, ?, ?)`
  );
  let order = 0;
  for (const data of normalizeSearchTracks(buckets)) {
    order += 1;
    stmt.run(
      `track-${String(order).padStart(3, "0")}`,
      order,
      JSON.stringify(data),
      new Date().toISOString()
    );
  }
}

function normalizeSearchTracks(buckets) {
  const out = [];
  for (const bucket of Array.isArray(buckets) ? buckets : []) {
    const titles = compactStrings(bucket?.titles);
    if (!titles.length) continue;
    const fitSignals = compactStrings(bucket?.fit_signals);
    const downSignals = compactStrings(bucket?.down_signals);
    const order = out.length + 1;
    out.push({
      name: String(bucket?.name || (order === 1 ? "Primary" : "Secondary")).trim(),
      priority: normalizePriority(bucket?.priority, order),
      titles,
      ...(String(bucket?.notes || "").trim() ? { notes: String(bucket.notes).trim() } : {}),
      ...(fitSignals.length ? { fit_signals: fitSignals } : {}),
      ...(downSignals.length ? { down_signals: downSignals } : {}),
    });
  }
  return out;
}

function normalizePriority(value, order) {
  const priority = String(value || "").toLowerCase();
  if (["primary", "secondary", "stretch", "oe"].includes(priority)) return priority;
  if (priority === "adjacent") return "secondary";
  return order === 1 ? "primary" : "secondary";
}

function normalizeApplicationLimits(doc = {}) {
  const companies = [];
  const seen = new Map();
  for (const raw of Array.isArray(doc.companies) ? doc.companies : []) {
    const row = normalizeApplicationLimitRow(raw);
    if (!row) continue;
    const key = applicationLimitKey(row);
    if (seen.has(key)) {
      companies[seen.get(key)] = normalizeApplicationLimitRow({
        ...companies[seen.get(key)],
        ...row,
        company: companies[seen.get(key)].company,
      });
      continue;
    }
    seen.set(key, companies.length);
    companies.push(row);
  }
  return { ...doc, companies };
}

function normalizeApplicationLimitRow(raw = {}) {
  const company = String(raw.company || "").trim();
  if (!company) return null;
  const row = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined) row[key] = value;
  }
  row.company = company;
  row.scope = String(row.scope || "all-roles").trim() || "all-roles";
  row.status = normalizeLimitStatus(row.status);
  if (row.cap !== undefined) row.cap = normalizeCap(row.cap);
  if (row.cooldown_days !== undefined && row.cooldown_days !== null) {
    const n = Number(row.cooldown_days);
    row.cooldown_days = Number.isFinite(n) ? n : null;
  }
  for (const key of [
    "hit_on",
    "hit_via",
    "reapply_rule",
    "reapply_after",
    "bypass",
    "source",
    "note",
  ]) {
    if (row[key] !== undefined && row[key] !== null) row[key] = String(row[key]).trim();
  }
  return row;
}

function normalizeLimitStatus(value) {
  const status = String(value || "ok").toLowerCase();
  if (["ok", "caution", "blocked"].includes(status)) return status;
  return "ok";
}

function normalizeCap(value) {
  if (value == null || value === "") return null;
  // A flow-style YAML cap (`cap: { max: 5, window_days: 180 }`) reaches here
  // as a literal string — parse it, then fall through to the same object
  // normalization every other shape gets (returning the parsed map raw let
  // un-coerced values skip schema validation's number checks).
  if (typeof value === "string") return normalizeCap(parseFlowMap(value));
  if (isPlainObject(value)) {
    const max = Number(value.max);
    if (!Number.isFinite(max)) return null;
    // window_days: null is meaningful — a lifetime cap with no rolling
    // window (e.g. "one application per candidate, ever").
    const windowDays = value.window_days == null ? null : Number(value.window_days);
    if (windowDays !== null && !Number.isFinite(windowDays)) return null;
    return { ...value, max, window_days: windowDays };
  }
  return null;
}

function parseFlowMap(value) {
  const text = String(value || "").trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  const out = {};
  for (const part of text.slice(1, -1).split(",")) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const rawValue = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = parseFlowScalar(rawValue);
  }
  return out;
}

function parseFlowScalar(value) {
  const text = String(value || "").trim();
  if (text === "null" || text === "~") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d+\.\d+$/.test(text)) return Number.parseFloat(text);
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function applicationLimitKey(row) {
  return `${slug(row.company)}::${String(row.scope || "all-roles").toLowerCase()}`;
}

function putCompanies(db, kind, names) {
  db.prepare("DELETE FROM candidate_target_companies WHERE kind = ?").run(kind);
  const stmt = db.prepare(
    `INSERT INTO candidate_target_companies (id, kind, sort_order, data, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  let order = 0;
  for (const name of compactStrings(names)) {
    order += 1;
    const id = `${kind}-${slug(name)}`;
    stmt.run(id, kind, order, JSON.stringify({ kind, name }), new Date().toISOString());
  }
}

function slug(value) {
  return (
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "item"
  );
}

function ensureSetupRows(db) {
  for (const [name, table] of Object.entries(SINGLETON_TABLES)) {
    putSingletonIfMissing(db, table, DEFAULTS[name] || {});
  }
  putSingletonIfMissing(db, "candidate_setup", DEFAULT_SETUP);
}

function completeCandidateConfigWrite(db, name, { data, setup }, { recordActivity = true } = {}) {
  if (!recordActivity) return { data, setup, meta: null, event: null };
  const activity = CANDIDATE_ACTIVITY[name] || {
    title: "Candidate settings updated",
    operation: "candidate:settings-update",
    summary: "Saved candidate settings.",
  };
  const meta = bumpMeta(db);
  const event = logActivityEvent(db, {
    type: "system",
    title: activity.title,
    summary: activity.summary,
    tags: [`operation:${activity.operation}`],
  });
  return { data, setup, meta, event };
}

export function candidateSetupInitialize({ repoRoot, env } = {}) {
  const db = openDb({ repoRoot, env });
  return withTransaction(db, () => {
    ensureSetupRows(db);
    return { ok: true, setup: refreshCandidateSetup(db) };
  });
}

export function candidateConfigGet({ repoRoot, env } = {}) {
  const db = requireDb({ repoRoot, env });
  return { ...readCandidateConfigFromDb(db), setup: computeCandidateSetup(db) };
}

export function applyCandidateResumeSeedInDb(
  db,
  { profileSeed, evidenceSeed, targetingSeed } = {}
) {
  const candidatePatch = Object.fromEntries(
    Object.entries(profileSeed?.candidate || {}).filter(([, value]) => value !== null)
  );
  if (Object.keys(candidatePatch).length) {
    const current = readSingleton(db, "candidate_profile", DEFAULTS.profile);
    const patch = { candidate: candidatePatch };
    const extractedLocation = String(candidatePatch.location || "").trim();
    if (extractedLocation && !String(current?.location?.home || "").trim()) {
      patch.location = { home: extractedLocation };
    }
    const merged = normalizeCandidateProfile(
      deepMerge(current, normalizeCandidateProfilePatch(patch))
    );
    assertValid("profile", merged);
    putSingleton(db, "candidate_profile", merged);
  }

  const claims = Array.isArray(evidenceSeed?.claims)
    ? evidenceSeed.claims
        .map((claim) => ({
          ...claim,
          claim: String(claim?.claim || "").trim(),
          evidence: String(claim?.evidence || "Candidate-provided resume").trim(),
        }))
        .filter((claim) => claim.claim)
    : [];
  assertCleanEvidenceClaims(claims);
  const existingEvidence = readEvidence(db).claims;
  const seenClaims = new Set(
    existingEvidence.map((claim) => String(claim?.claim || "").trim()).filter(Boolean)
  );
  const usedIds = new Set(existingEvidence.map((claim) => String(claim?.id || "")));
  const insertEvidence = db.prepare(
    `INSERT INTO candidate_evidence_claims (id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
  );
  let evidenceAdded = 0;
  for (const claim of claims) {
    if (seenClaims.has(claim.claim)) continue;
    let id = String(claim.id || "").trim();
    if (!id || usedIds.has(id)) id = nextClaimId(usedIds);
    const data = { ...claim, id };
    insertEvidence.run(id, JSON.stringify(data), new Date().toISOString());
    usedIds.add(id);
    seenClaims.add(claim.claim);
    evidenceAdded += 1;
  }
  const evidence = readEvidence(db);
  assertValid("evidence", evidence);

  const currentTargeting = readTargeting(db);
  const targetingPatch = {};
  if (
    Array.isArray(targetingSeed?.role_buckets) &&
    targetingSeed.role_buckets.length &&
    currentTargeting.role_buckets.length === 0
  ) {
    targetingPatch.role_buckets = targetingSeed.role_buckets;
  }
  if (
    Array.isArray(targetingSeed?.keep_signals) &&
    targetingSeed.keep_signals.length &&
    (!Array.isArray(currentTargeting.keep_signals) || currentTargeting.keep_signals.length === 0)
  ) {
    targetingPatch.keep_signals = targetingSeed.keep_signals;
  }
  if (Object.keys(targetingPatch).length) {
    const merged = deepMerge(currentTargeting, targetingPatch);
    merged.role_buckets = normalizeSearchTracks(merged.role_buckets);
    merged.tracked_companies = compactStrings(merged.tracked_companies);
    merged.excluded_companies = compactStrings(merged.excluded_companies);
    assertValid("targeting", merged);
    const { role_buckets, tracked_companies, excluded_companies, ...base } = merged;
    putSingleton(db, "candidate_targeting", base);
    putSearchTracks(db, role_buckets);
    putCompanies(db, "target", tracked_companies);
    putCompanies(db, "excluded", excluded_companies);
  }

  const meta = bumpMeta(db);
  const event = logActivityEvent(db, {
    type: "system",
    title: "Resume added",
    summary: `${evidenceAdded} resume evidence ${evidenceAdded === 1 ? "claim" : "claims"} saved to the candidate profile.`,
    tags: ["operation:candidate:resume-ingest"],
  });
  return {
    profile: normalizeCandidateProfile(readSingleton(db, "candidate_profile", DEFAULTS.profile)),
    targeting: readTargeting(db),
    evidence,
    setup: refreshCandidateSetup(db),
    meta,
    event,
  };
}

export function candidateConfigPatch({ repoRoot, env, name, patch, recordActivity = true } = {}) {
  if (!SINGLETON_TABLES[name]) {
    const err = new Error(`unknown candidate config "${name}"`);
    err.code = "NOT_FOUND";
    throw err;
  }
  if (!isPlainObject(patch)) {
    const err = new Error("patch must be an object");
    err.code = "BAD_REQUEST";
    throw err;
  }

  return runVerb(
    { repoRoot, env },
    (db) => {
      if (name === "targeting") {
        const current = readTargeting(db);
        const merged = deepMerge(current, patch);
        merged.role_buckets = normalizeSearchTracks(merged.role_buckets);
        merged.tracked_companies = compactStrings(merged.tracked_companies);
        merged.excluded_companies = compactStrings(merged.excluded_companies);
        assertValid("targeting", merged);
        const { role_buckets, tracked_companies, excluded_companies, ...base } = merged;
        putSingleton(db, "candidate_targeting", base);
        putSearchTracks(db, role_buckets);
        putCompanies(db, "target", tracked_companies);
        putCompanies(db, "excluded", excluded_companies);
        return completeCandidateConfigWrite(
          db,
          name,
          { data: readTargeting(db), setup: refreshCandidateSetup(db) },
          { recordActivity }
        );
      }

      if (name === "application-limits") {
        const current = readSingleton(
          db,
          "candidate_application_limits",
          DEFAULTS["application-limits"]
        );
        const merged = normalizeApplicationLimits(deepMerge(current, patch));
        assertValid(name, merged);
        putSingleton(db, "candidate_application_limits", merged);
        return completeCandidateConfigWrite(
          db,
          name,
          { data: merged, setup: refreshCandidateSetup(db) },
          { recordActivity }
        );
      }

      const table = SINGLETON_TABLES[name];
      const current = readSingleton(db, table, DEFAULTS[name] || {});
      const merged =
        name === "profile"
          ? normalizeCandidateProfile(deepMerge(current, normalizeCandidateProfilePatch(patch)))
          : deepMerge(current, patch);
      assertValid(name, merged);
      putSingleton(db, table, merged);
      return completeCandidateConfigWrite(
        db,
        name,
        { data: merged, setup: refreshCandidateSetup(db) },
        { recordActivity }
      );
    },
    { requireExistingTracker: true }
  );
}

export function candidateApplicationLimitUpsert({ repoRoot, env, row } = {}) {
  const normalized = normalizeApplicationLimitRow(row);
  if (!normalized) {
    const err = new Error("application limit row requires company");
    err.code = "BAD_REQUEST";
    throw err;
  }
  return runVerb(
    { repoRoot, env },
    (db) => {
      const current = normalizeApplicationLimits(
        readSingleton(db, "candidate_application_limits", DEFAULTS["application-limits"])
      );
      const key = applicationLimitKey(normalized);
      const existingIndex = current.companies.findIndex(
        (item) => applicationLimitKey(item) === key
      );
      if (existingIndex === -1) {
        current.companies.push(normalized);
      } else {
        if (row.status === undefined) normalized.status = current.companies[existingIndex].status;
        current.companies[existingIndex] = normalizeApplicationLimitRow({
          ...current.companies[existingIndex],
          ...normalized,
          company: current.companies[existingIndex].company,
        });
      }
      assertValid("application-limits", current);
      putSingleton(db, "candidate_application_limits", current);
      return completeCandidateConfigWrite(db, "application-limits", {
        data: current,
        setup: refreshCandidateSetup(db),
      });
    },
    { requireExistingTracker: true }
  );
}

// The same honesty/privacy backstop src/cli/evidence.mjs's `careerrat evidence
// add` path already enforces via evidence-writer.mjs's validateClaims() —
// shared via evidence-validation.mjs's validateClaimFields() (not
// evidence-writer.mjs directly: that file pulls in config-store.mjs, which
// pulls in db/verbs.mjs, which barrels this file back in — importing
// evidence-writer.mjs here would close that cycle; see
// evidence-validation.mjs's header comment) so the CLI's dry-run/--write path
// and every HTTP caller of candidateEvidenceMerge (the evidence merge route,
// the evidence-seed route, and Library's future edit-in-place save) share one
// firewall. This runs against the RAW incoming claims, before ids are
// assigned below, so it only checks field shape (links/role_signals/
// forbidden_wording must be arrays of non-empty strings) and placeholder/
// current_base residue — not id/claim/evidence presence, which the
// post-write assertValid("evidence", ...) schema check below covers once ids
// are in place. A claim that fails either guard can never enter the bank
// through any surface, not just the CLI's own guarded add.
function evidenceIdsInValue(value, targetIds, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) evidenceIdsInValue(item, targetIds, found);
    return found;
  }
  if (!isPlainObject(value)) return found;
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[_-]/g, "");
    if (normalizedKey === "evidenceids" && Array.isArray(nested)) {
      for (const rawId of nested) {
        const id = String(rawId || "").trim();
        if (targetIds.has(id)) found.add(id);
      }
    }
    evidenceIdsInValue(nested, targetIds, found);
  }
  return found;
}

function evidenceReferences(db, claimIds) {
  const targetIds = new Set(claimIds.map(String).filter(Boolean));
  if (targetIds.size === 0) return [];
  const references = [];
  for (const { id, data } of db.prepare("SELECT id, data FROM applications ORDER BY id").all()) {
    for (const claimId of evidenceIdsInValue(JSON.parse(data), targetIds)) {
      references.push({ claimId, owner: `application:${id}` });
    }
  }
  for (const { id, data } of db
    .prepare("SELECT id, data FROM deep_ingest_story_bank ORDER BY id")
    .all()) {
    for (const claimId of evidenceIdsInValue(JSON.parse(data), targetIds)) {
      references.push({ claimId, owner: `story:${id}` });
    }
  }
  return references;
}

function assertEvidenceClaimsUnused(db, claimIds) {
  const references = evidenceReferences(db, claimIds);
  if (references.length === 0) return;
  const err = new Error(
    "evidence claims still cited by saved application material cannot be removed"
  );
  err.code = "EVIDENCE_IN_USE";
  err.claimIds = [...new Set(references.map(({ claimId }) => claimId))];
  err.references = references;
  throw err;
}

export function candidateEvidenceMerge({ repoRoot, env, claims, recordActivity = true } = {}) {
  if (!Array.isArray(claims)) {
    const err = new Error("claims must be an array");
    err.code = "BAD_REQUEST";
    throw err;
  }
  assertCleanEvidenceClaims(claims);
  return runVerb(
    { repoRoot, env },
    (db) => {
      const existing = readEvidence(db).claims;
      const seenClaims = new Map(
        existing.map((claim) => [String(claim.claim || "").trim(), String(claim.id || "")])
      );
      const usedIds = new Set(existing.map((claim) => String(claim.id || "")));
      const existingById = new Map(existing.map((claim) => [String(claim.id || ""), claim]));
      const stmt = db.prepare(
        `INSERT INTO candidate_evidence_claims (id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
      );
      let added = 0;
      let skipped = 0;
      for (const raw of claims) {
        const claimText = String(raw?.claim || "").trim();
        const rawId = raw?.id ? String(raw.id) : "";
        const existingIdForText = seenClaims.get(claimText);
        if (!claimText || (existingIdForText && existingIdForText !== rawId)) {
          skipped += 1;
          continue;
        }
        const replacingExistingId = rawId && existingById.has(rawId);
        const id =
          rawId && (!usedIds.has(rawId) || existingIdForText === rawId || replacingExistingId)
            ? rawId
            : nextClaimId(usedIds);
        if (replacingExistingId) {
          const previousClaimText = String(existingById.get(rawId)?.claim || "").trim();
          if (previousClaimText && previousClaimText !== claimText)
            seenClaims.delete(previousClaimText);
        }
        seenClaims.set(claimText, id);
        usedIds.add(id);
        const data = {
          ...raw,
          id,
          claim: claimText,
          evidence: String(raw?.evidence || ""),
        };
        stmt.run(id, JSON.stringify(data), new Date().toISOString());
        added += 1;
      }
      const evidence = readEvidence(db);
      assertValid("evidence", evidence);
      const meta = added > 0 && recordActivity ? bumpMeta(db) : null;
      const event =
        added > 0 && recordActivity
          ? logActivityEvent(db, {
              type: "system",
              title: "Evidence bank updated",
              summary: `${added} evidence ${added === 1 ? "claim" : "claims"} saved${
                skipped ? `; ${skipped} duplicate${skipped === 1 ? "" : "s"} skipped` : ""
              }.`,
              tags: ["operation:candidate:evidence-save"],
            })
          : null;
      return {
        added,
        skipped,
        total: evidence.claims.length,
        data: evidence,
        setup: refreshCandidateSetup(db),
        meta,
        event,
      };
    },
    { requireExistingTracker: true }
  );
}

export function candidateEvidenceReplace({ repoRoot, env, claims, recordActivity = true } = {}) {
  if (!Array.isArray(claims)) {
    const err = new Error("claims must be an array");
    err.code = "BAD_REQUEST";
    throw err;
  }
  assertCleanEvidenceClaims(claims);
  return runVerb(
    { repoRoot, env },
    (db) => {
      const existing = readEvidence(db).claims;
      const existingByText = new Map(
        existing.map((claim) => [String(claim?.claim || "").trim(), String(claim?.id || "")])
      );
      const reservedIds = new Set([
        ...existing.map((claim) => String(claim?.id || "")),
        ...claims.map((claim) => String(claim?.id || "").trim()).filter(Boolean),
      ]);
      const usedIds = new Set();
      const usedTexts = new Set();
      const normalized = claims.map((raw, index) => {
        const claimText = String(raw?.claim || "").trim();
        const explicitId = String(raw?.id || "").trim();
        if (!claimText) {
          const err = new Error(`claims[${index}] is missing claim text`);
          err.code = "BAD_REQUEST";
          throw err;
        }
        if (usedTexts.has(claimText)) {
          const err = new Error(`duplicate evidence claim text: "${claimText}"`);
          err.code = "BAD_REQUEST";
          throw err;
        }
        let id = explicitId;
        const exactExistingId = existingByText.get(claimText);
        if (!id && exactExistingId && !usedIds.has(exactExistingId)) id = exactExistingId;
        if (!id) id = nextClaimId(reservedIds);
        if (usedIds.has(id)) {
          const err = new Error(`duplicate evidence claim id: "${id}"`);
          err.code = "BAD_REQUEST";
          throw err;
        }
        usedTexts.add(claimText);
        usedIds.add(id);
        reservedIds.add(id);
        return {
          ...raw,
          id,
          claim: claimText,
          evidence: String(raw?.evidence || "").trim(),
        };
      });

      const evidence = { claims: normalized };
      assertValid("evidence", evidence);
      const previousIds = new Set(existing.map((claim) => String(claim?.id || "")));
      const removedIds = existing
        .map((claim) => String(claim?.id || ""))
        .filter((id) => id && !usedIds.has(id));
      assertEvidenceClaimsUnused(db, removedIds);
      const removed = removedIds.length;
      const replaced = normalized.filter((claim) => previousIds.has(claim.id)).length;
      const now = new Date().toISOString();
      db.prepare("DELETE FROM candidate_evidence_claims").run();
      const insert = db.prepare(
        "INSERT INTO candidate_evidence_claims (id, data, updated_at) VALUES (?, ?, ?)"
      );
      for (const claim of normalized) insert.run(claim.id, JSON.stringify(claim), now);

      const saved = readEvidence(db);
      assertValid("evidence", saved);
      const meta = recordActivity ? bumpMeta(db) : null;
      const event = recordActivity
        ? logActivityEvent(db, {
            type: "system",
            title: "Evidence bank updated",
            summary: `${normalized.length} evidence ${normalized.length === 1 ? "claim" : "claims"} saved as one section.`,
            tags: ["operation:candidate:evidence-replace"],
          })
        : null;
      return {
        replaced,
        added: normalized.length - replaced,
        removed,
        total: saved.claims.length,
        data: saved,
        setup: refreshCandidateSetup(db),
        meta,
        event,
      };
    },
    { requireExistingTracker: true }
  );
}

function nextClaimId(usedIds) {
  let n = 1;
  let id = `seed-${String(n).padStart(3, "0")}`;
  while (usedIds.has(id)) {
    n += 1;
    id = `seed-${String(n).padStart(3, "0")}`;
  }
  return id;
}

// Delete exactly one row from candidate_evidence_claims by id. Item 14's
// new verb: unlike candidateEvidenceMerge (upsert-by-id), this is a pure
// remove — a clean NOT_FOUND on an unknown id rather than a silent no-op,
// so the Library drawer's Delete affordance can surface a real error.
export function candidateEvidenceRemoveOne({ repoRoot, env, id } = {}) {
  const claimId = String(id || "").trim();
  if (!claimId) {
    const err = new Error("candidateEvidenceRemoveOne requires id");
    err.code = "BAD_REQUEST";
    throw err;
  }
  return runVerb(
    { repoRoot, env },
    (db) => {
      const existing = db
        .prepare("SELECT data FROM candidate_evidence_claims WHERE id = ?")
        .get(claimId);
      if (!existing) {
        const err = new Error(`evidence claim not found: "${claimId}"`);
        err.code = "NOT_FOUND";
        throw err;
      }
      assertEvidenceClaimsUnused(db, [claimId]);
      db.prepare("DELETE FROM candidate_evidence_claims WHERE id = ?").run(claimId);
      const removedClaim = JSON.parse(existing.data);
      const meta = bumpMeta(db);
      const event = logActivityEvent(db, {
        type: "system",
        title: "Evidence claim removed",
        summary: String(removedClaim?.claim || "Removed one saved evidence claim.").slice(0, 120),
        tags: ["operation:candidate:evidence-remove"],
      });
      return {
        removed: claimId,
        data: readEvidence(db),
        setup: refreshCandidateSetup(db),
        meta,
        event,
      };
    },
    { requireExistingTracker: true }
  );
}

export function candidateArtifactPut({ repoRoot, env, id, kind, data } = {}) {
  if (!id || !kind) {
    const err = new Error("id and kind are required");
    err.code = "BAD_REQUEST";
    throw err;
  }
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    db.prepare(
      `INSERT INTO candidate_artifacts (id, kind, data, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, data=excluded.data, updated_at=excluded.updated_at`
    ).run(String(id), String(kind), JSON.stringify(data || {}), new Date().toISOString());
    return { ok: true, setup: refreshCandidateSetup(db) };
  });
}

export function candidateArtifactExists({ repoRoot, env, id, kind } = {}) {
  if (!id && !kind) return false;
  const db = requireDb({ repoRoot, env });
  if (id) {
    return !!db.prepare("SELECT 1 FROM candidate_artifacts WHERE id = ?").get(String(id));
  }
  return !!db.prepare("SELECT 1 FROM candidate_artifacts WHERE kind = ? LIMIT 1").get(String(kind));
}

export function candidateArtifactGet({ repoRoot, env, id, kind } = {}) {
  if (!id && !kind) return null;
  const db = requireDb({ repoRoot, env });
  let row = null;
  if (id) {
    row = db.prepare("SELECT data FROM candidate_artifacts WHERE id = ?").get(String(id));
  }
  if (!row && kind) {
    row = db
      .prepare("SELECT data FROM candidate_artifacts WHERE kind = ? LIMIT 1")
      .get(String(kind));
  }
  return row ? JSON.parse(row.data) : null;
}
