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
import { validate } from "../../profile/schema-validator.mjs";
import { openDb, requireDb } from "../connection.mjs";
import { withTransaction } from "../transaction.mjs";

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
};

const DEFAULTS = {
  profile: {
    candidate: {
      full_name: "",
      email: "",
      preferred_name: "",
      headline: "",
      phone: "",
      location: "",
      linkedin: "",
      github: "",
      portfolio: "",
      domain: "",
      toolchain: "markdown-only",
    },
    compensation: {
      currency: "USD",
      current_comp_shareable: false,
      current_base: null,
      target_base: null,
      minimum_base: null,
      target_total_comp: null,
      cash_over_equity: true,
      expected_base: null,
      oe_min_base: null,
      oe_max_base: null,
      relo_package_needs: "",
    },
    location: {
      home: "",
      remote: true,
      hybrid: false,
      onsite: false,
      relocation: [],
      travel_tolerance: "",
    },
    authorization: {
      work_authorized: false,
      requires_sponsorship: false,
      notice_period: "",
    },
  },
  targeting: {
    role_buckets: [],
    keep_signals: [],
    cut_signals: [],
    excluded_companies: [],
    tracked_companies: [],
    degree_policy: "",
    fit_bands: { high_min: 85, med_min: 65 },
    search_preferences: {
      posting_age: { mode: "since-last-run" },
      cadence: { mode: "daily", recommended_from: "default" },
    },
  },
  evidence: { claims: [] },
  honesty: {
    education: { highest_degree: null, add_education_section: false },
    tools: { confirmed: [], adjacent: [], do_not_claim: [] },
    claims: { do_not_fabricate: ["degrees", "employers", "metrics", "tools"] },
    style: { avoid: [] },
  },
  "form-defaults": {
    source: "Rolester",
    work_authorization: "",
    requires_sponsorship: "",
    current_employer: null,
    current_title: null,
    expected_base: null,
    linkedin: null,
    github: null,
    portfolio: null,
    eeo_default: "Prefer not to answer",
    screening_answers: {},
    document_formats: {
      default_packet_format: "pdf",
      required_export_formats: [],
    },
    confirm_current_role: false,
    auto_submit: false,
  },
  modes: {
    usage_mode: "standard",
    application_mode: "balanced",
    agent_voice: "standard",
  },
  automation: {},
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
    profile: readSingleton(db, "candidate_profile", DEFAULTS.profile),
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

function hasCompFloor(profile) {
  const value = profile.compensation?.minimum_base;
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasAuthorization(profile) {
  const auth = profile.authorization || {};
  return auth.work_authorized === true || auth.requires_sponsorship === true;
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
  const hasSourceResume = hasCandidateArtifact(db, {
    id: "source-resume",
    kind: "source-resume",
  });
  const titlesReady = hasAnyTitle(targeting);
  const locationReady = hasSearchLocation(profile);
  const compReady = hasCompFloor(profile);
  const authReady = hasAuthorization(profile);
  const evidenceCount = (evidence.claims || []).length;

  const searchMissing = [];
  if (!hasSourceResume) searchMissing.push("source resume");
  if (!titlesReady) searchMissing.push("role titles");
  if (!locationReady) searchMissing.push("search location or remote posture");

  const gateMissing = [];
  if (!titlesReady) gateMissing.push("role titles");
  if (!locationReady) gateMissing.push("location posture");
  if (!compReady) gateMissing.push("compensation floor");
  if (!authReady) gateMissing.push("work authorization");

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
    const order = out.length + 1;
    out.push({
      name: String(bucket?.name || (order === 1 ? "Primary" : "Secondary")).trim(),
      priority: normalizePriority(bucket?.priority, order),
      titles,
      ...(String(bucket?.notes || "").trim() ? { notes: String(bucket.notes).trim() } : {}),
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
  if (typeof value === "string") return parseFlowMap(value);
  if (isPlainObject(value)) {
    const max = Number(value.max);
    const windowDays = Number(value.window_days);
    if (!Number.isFinite(max) || !Number.isFinite(windowDays)) return null;
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

export function candidateConfigPatch({ repoRoot, env, name, patch } = {}) {
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

  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
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
      return { ok: true, data: readTargeting(db), setup: refreshCandidateSetup(db) };
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
      return { ok: true, data: merged, setup: refreshCandidateSetup(db) };
    }

    const table = SINGLETON_TABLES[name];
    const current = readSingleton(db, table, DEFAULTS[name] || {});
    const merged = deepMerge(current, patch);
    assertValid(name, merged);
    putSingleton(db, table, merged);
    return { ok: true, data: merged, setup: refreshCandidateSetup(db) };
  });
}

export function candidateApplicationLimitUpsert({ repoRoot, env, row } = {}) {
  const normalized = normalizeApplicationLimitRow(row);
  if (!normalized) {
    const err = new Error("application limit row requires company");
    err.code = "BAD_REQUEST";
    throw err;
  }
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const current = normalizeApplicationLimits(
      readSingleton(db, "candidate_application_limits", DEFAULTS["application-limits"])
    );
    const key = applicationLimitKey(normalized);
    const existingIndex = current.companies.findIndex((item) => applicationLimitKey(item) === key);
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
    return { ok: true, data: current, setup: refreshCandidateSetup(db) };
  });
}

export function candidateEvidenceMerge({ repoRoot, env, claims } = {}) {
  if (!Array.isArray(claims)) {
    const err = new Error("claims must be an array");
    err.code = "BAD_REQUEST";
    throw err;
  }
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
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
      const data = { ...raw, id, claim: claimText, evidence: String(raw?.evidence || "") };
      stmt.run(id, JSON.stringify(data), new Date().toISOString());
      added += 1;
    }
    const evidence = readEvidence(db);
    assertValid("evidence", evidence);
    return {
      ok: true,
      added,
      skipped,
      total: evidence.claims.length,
      data: evidence,
      setup: refreshCandidateSetup(db),
    };
  });
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
