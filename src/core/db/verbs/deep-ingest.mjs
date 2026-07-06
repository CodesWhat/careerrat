// verbs/deep-ingest.mjs - SQLite-native Deep ingest source/proposal/lane state.
//
// Deep ingest source, proposal, and lane-state writes are product workflow state,
// not tracker-visible job-search outcomes. These verbs intentionally avoid
// shared runVerb()/exportToTracker() side effects; only explicit confirmation
// writes trusted candidate facts.
import { randomUUID } from "node:crypto";
import { requireDb } from "../connection.mjs";
import { withTransaction } from "../transaction.mjs";

const SOURCE_TABLE = "deep_ingest_sources";
const PROPOSAL_TABLE = "deep_ingest_proposals";
const LANE_TABLE = "deep_ingest_lane_states";

export const DEEP_INGEST_REQUIRED_LANES = [
  "source_coverage",
  "evidence_claims",
  "story_bank",
  "honesty_boundaries",
  "writing_voice",
  "role_signals",
  "open_gaps",
];

export const DEEP_INGEST_LANE_STATUSES = [
  "not_started",
  "needs_source",
  "scanning",
  "review_needed",
  "gap",
  "completed",
  "deferred",
  "not_available",
  "failed",
];

export const DEEP_INGEST_TERMINAL_STATUSES = ["completed", "deferred", "not_available"];

const TARGET_SHAPES = new Set([
  "evidence",
  "story",
  "honesty_boundary",
  "writing_voice",
  "role_signal",
  "gap",
  "source",
  "paste",
  "link",
  "profile",
  "project",
  "recruiter_context",
  "job_context",
]);

const SOURCE_KINDS = new Set([
  "paste",
  "text",
  "url",
  "file",
  "repo",
  "local_path",
  "linkedin",
  "portfolio",
  "note",
  "recruiter_context",
  "job_context",
  "project_link",
]);

const PROPOSAL_DECISION_TO_STATUS = new Map([
  ["defer", "deferred"],
  ["reject", "rejected"],
  ["reopen", "review_needed"],
]);

const REASON_REQUIRED_STATUSES = new Set(["gap", "deferred", "not_available", "failed"]);
const PRIVATE_FIELD_NAMES = new Set([
  "current_base",
  "currentBase",
  "current_comp",
  "currentComp",
  "current_compensation",
  "currentCompensation",
]);

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeError(message, code = "BAD_REQUEST") {
  const err = new Error(message);
  err.code = code;
  return err;
}

function runDeepIngestVerb({ repoRoot, env }, fn) {
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => fn(db));
}

function parseRow(row) {
  return row ? JSON.parse(row.data) : null;
}

function readRow(db, table, id) {
  return parseRow(db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(String(id)));
}

function requireRow(db, table, id, label) {
  const row = readRow(db, table, id);
  if (!row) throw makeError(`no ${label} with id "${id}"`, "NOT_FOUND");
  return row;
}

function putRow(db, table, id, data) {
  db.prepare(
    `INSERT INTO ${table} (id, data) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data`
  ).run(String(id), JSON.stringify(data));
}

function readRows(db, table, order = "updated_at DESC") {
  return db
    .prepare(`SELECT data FROM ${table} ORDER BY ${order}`)
    .all()
    .map((row) => JSON.parse(row.data));
}

function assertNoPrivateCompKeys(value, path = "$") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertNoPrivateCompKeys(value[index], `${path}[${index}]`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_FIELD_NAMES.has(key)) {
      throw makeError(
        `Deep ingest payload contains private compensation field at ${path}.${key}`,
        "PRIVATE_FIELD_REJECTED"
      );
    }
    assertNoPrivateCompKeys(child, `${path}.${key}`);
  }
}

function normalizeTargetShape(value) {
  const targetShape = String(value || "").trim();
  if (!TARGET_SHAPES.has(targetShape)) {
    throw makeError(`unsupported Deep ingest target shape "${targetShape || "(missing)"}"`);
  }
  return targetShape;
}

function normalizeSourceKind(value) {
  const sourceKind = String(value || "paste").trim();
  if (!SOURCE_KINDS.has(sourceKind)) {
    throw makeError(`unsupported Deep ingest source kind "${sourceKind || "(missing)"}"`);
  }
  return sourceKind;
}

function normalizeLane(value) {
  const lane = String(value || "").trim();
  if (!DEEP_INGEST_REQUIRED_LANES.includes(lane)) {
    throw makeError(`unsupported Deep ingest lane "${lane || "(missing)"}"`);
  }
  return lane;
}

function normalizeLaneStatus(value) {
  const status = String(value || "").trim();
  if (!DEEP_INGEST_LANE_STATUSES.includes(status)) {
    throw makeError(`unsupported Deep ingest lane status "${status || "(missing)"}"`);
  }
  return status;
}

function normalizeExpectedVersion(value, label) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0) {
    throw makeError(`${label} requires expectedVersion`);
  }
  return version;
}

function textPreview(value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 240) : null;
}

function sourceFromInput(input = {}) {
  if (!input || typeof input !== "object") {
    throw makeError("deepIngestSourceCreate requires input");
  }
  assertNoPrivateCompKeys(input);
  const now = nowIso();
  const source = {
    id: input.id ? String(input.id) : `deep_src_${randomUUID()}`,
    targetShape: normalizeTargetShape(input.targetShape),
    sourceKind: normalizeSourceKind(input.sourceKind),
    status: String(input.status || "proposal_ready"),
    label: String(input.label || "").trim() || "Deep ingest source",
    artifactPath: input.artifactPath ? String(input.artifactPath) : null,
    metadata: input.metadata && typeof input.metadata === "object" ? clone(input.metadata) : {},
    textPreview: input.textPreview || textPreview(input.text),
    textLength: input.text == null ? Number(input.textLength || 0) : String(input.text).length,
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
  };
  return source;
}

function sourceOutcome(source) {
  return {
    id: `outcome_${source.id}`,
    sourceId: source.id,
    status: source.status,
    targetShape: source.targetShape,
    visible: true,
  };
}

function proposalFromInput({ source, sourceId, targetShape, lane, proposal }) {
  if (!proposal || typeof proposal !== "object") {
    throw makeError("deepIngestProposalPut requires proposal");
  }
  assertNoPrivateCompKeys(proposal);
  const now = nowIso();
  const normalizedLane = normalizeLane(lane);
  const normalizedTargetShape = normalizeTargetShape(targetShape || source?.targetShape);
  return {
    id: `deep_prop_${randomUUID()}`,
    sourceId: String(sourceId),
    targetShape: normalizedTargetShape,
    lane: normalizedLane,
    status: "review_needed",
    version: 1,
    proposal: clone(proposal),
    decision: null,
    reason: null,
    createdAt: now,
    updatedAt: now,
  };
}

function assertProposalVersion(current, expectedVersion) {
  if (Number(current.version || 0) !== expectedVersion) {
    throw makeError(
      `Deep ingest proposal version conflict: expected ${expectedVersion}, found ${Number(current.version || 0)}`,
      "VERSION_CONFLICT"
    );
  }
}

function writeEvidenceClaims(db, items) {
  const rows = db
    .prepare("SELECT data FROM candidate_evidence_claims ORDER BY rowid ASC")
    .all()
    .map((row) => JSON.parse(row.data));
  const usedIds = new Set(rows.map((row) => String(row.id || "")));
  const byClaim = new Map(
    rows.map((row) => [String(row.claim || "").trim(), String(row.id || "")])
  );
  const stmt = db.prepare(
    `INSERT INTO candidate_evidence_claims (id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
  );
  let added = 0;
  for (const raw of Array.isArray(items) ? items : []) {
    const claim = String(raw?.claim || "").trim();
    if (!claim) continue;
    const requestedId = String(raw?.id || "").trim();
    const duplicateId = byClaim.get(claim);
    if (duplicateId && duplicateId !== requestedId) continue;
    const id = requestedId || nextEvidenceId(usedIds);
    usedIds.add(id);
    byClaim.set(claim, id);
    const data = {
      ...clone(raw),
      id,
      claim,
      evidence: String(raw?.evidence || raw?.supportingQuote || ""),
    };
    stmt.run(id, JSON.stringify(data), nowIso());
    added += 1;
  }
  return { added };
}

function nextEvidenceId(usedIds) {
  let n = 1;
  let id = `deep-evidence-${String(n).padStart(3, "0")}`;
  while (usedIds.has(id)) {
    n += 1;
    id = `deep-evidence-${String(n).padStart(3, "0")}`;
  }
  return id;
}

function writeConfirmedLaneOutput(db, proposal, edits, updatedAt) {
  const items = Array.isArray(edits?.items) ? edits.items : [];
  if (proposal.lane === "evidence_claims") {
    return { evidence: writeEvidenceClaims(db, items) };
  }

  const tableByLane = {
    story_bank: "deep_ingest_story_bank",
    honesty_boundaries: "deep_ingest_honesty_boundaries",
    writing_voice: "deep_ingest_writing_voice",
    role_signals: "deep_ingest_role_signals",
  };
  const table = tableByLane[proposal.lane];
  if (!table) return { written: 0 };

  let written = 0;
  for (const raw of items.length ? items : [edits]) {
    if (!raw || typeof raw !== "object") continue;
    const id = raw.id ? String(raw.id) : `${proposal.lane}_${randomUUID()}`;
    putRow(db, table, id, {
      ...clone(raw),
      id,
      status: raw.status || "confirmed",
      sourceProposalId: proposal.id,
      updatedAt,
    });
    written += 1;
  }
  return { written };
}

export function deepIngestSourceCreate({ repoRoot, env, input } = {}) {
  return runDeepIngestVerb({ repoRoot, env }, (db) => {
    const source = sourceFromInput(input);
    putRow(db, SOURCE_TABLE, source.id, source);
    return {
      ok: true,
      source: readRow(db, SOURCE_TABLE, source.id),
      outcome: sourceOutcome(source),
    };
  });
}

export function deepIngestSourceList({ repoRoot, env, status, targetShape, limit } = {}) {
  const db = requireDb({ repoRoot, env });
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push("status = ?");
    params.push(String(status));
  }
  if (targetShape) {
    clauses.push("target_shape = ?");
    params.push(String(targetShape));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limitClause = Number.isInteger(limit) && limit > 0 ? "LIMIT ?" : "";
  if (limitClause) params.push(limit);
  return db
    .prepare(`SELECT data FROM ${SOURCE_TABLE} ${where} ORDER BY updated_at DESC ${limitClause}`)
    .all(...params)
    .map((row) => JSON.parse(row.data));
}

export function deepIngestSourceGet({ repoRoot, env, sourceId, id } = {}) {
  const db = requireDb({ repoRoot, env });
  return { ok: true, source: readRow(db, SOURCE_TABLE, sourceId || id) };
}

export function deepIngestProposalPut({
  repoRoot,
  env,
  sourceId,
  targetShape,
  lane,
  proposal,
} = {}) {
  if (!String(sourceId || "").trim()) throw makeError("deepIngestProposalPut requires sourceId");
  return runDeepIngestVerb({ repoRoot, env }, (db) => {
    const source = requireRow(db, SOURCE_TABLE, sourceId, "Deep ingest source");
    const row = proposalFromInput({ source, sourceId, targetShape, lane, proposal });
    putRow(db, PROPOSAL_TABLE, row.id, row);
    return readRow(db, PROPOSAL_TABLE, row.id);
  });
}

export function deepIngestProposalDecision({
  repoRoot,
  env,
  proposalId,
  expectedVersion,
  decision,
  reason,
} = {}) {
  const expected = normalizeExpectedVersion(expectedVersion, "deepIngestProposalDecision");
  const normalizedDecision = String(decision || "").trim();
  const status = PROPOSAL_DECISION_TO_STATUS.get(normalizedDecision);
  if (!status) throw makeError(`unsupported Deep ingest proposal decision "${normalizedDecision}"`);
  if ((status === "deferred" || status === "rejected") && !String(reason || "").trim()) {
    throw makeError("Deep ingest proposal decision requires reason");
  }

  return runDeepIngestVerb({ repoRoot, env }, (db) => {
    const current = requireRow(db, PROPOSAL_TABLE, proposalId, "Deep ingest proposal");
    assertProposalVersion(current, expected);
    const updatedAt = nowIso();
    const next = {
      ...current,
      status,
      version: expected + 1,
      decision: normalizedDecision,
      reason: reason ? String(reason) : null,
      updatedAt,
    };
    putRow(db, PROPOSAL_TABLE, next.id, next);
    return readRow(db, PROPOSAL_TABLE, next.id);
  });
}

export function deepIngestConfirmProposal({
  repoRoot,
  env,
  proposalId,
  expectedVersion,
  edits = {},
} = {}) {
  const expected = normalizeExpectedVersion(expectedVersion, "deepIngestConfirmProposal");
  assertNoPrivateCompKeys(edits);

  return runDeepIngestVerb({ repoRoot, env }, (db) => {
    const current = requireRow(db, PROPOSAL_TABLE, proposalId, "Deep ingest proposal");
    assertProposalVersion(current, expected);
    const updatedAt = nowIso();
    const output = writeConfirmedLaneOutput(db, current, edits, updatedAt);
    const next = {
      ...current,
      status: "confirmed",
      version: expected + 1,
      decision: "confirm",
      reason: null,
      confirmedOutput: clone(edits),
      output,
      updatedAt,
    };
    putRow(db, PROPOSAL_TABLE, next.id, next);
    return readRow(db, PROPOSAL_TABLE, next.id);
  });
}

export function deepIngestLaneSetState({ repoRoot, env, lane, status, reason } = {}) {
  const normalizedLane = normalizeLane(lane);
  const normalizedStatus = normalizeLaneStatus(status);
  if (REASON_REQUIRED_STATUSES.has(normalizedStatus) && !String(reason || "").trim()) {
    throw makeError(`Deep ingest lane status "${normalizedStatus}" requires reason`);
  }

  return runDeepIngestVerb({ repoRoot, env }, (db) => {
    const existing = readRow(db, LANE_TABLE, normalizedLane);
    const now = nowIso();
    const laneState = {
      id: normalizedLane,
      lane: normalizedLane,
      status: normalizedStatus,
      reason: reason ? String(reason) : null,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    putRow(db, LANE_TABLE, normalizedLane, laneState);
    return { ok: true, laneState: readRow(db, LANE_TABLE, normalizedLane) };
  });
}

export function deepIngestStateGet({ repoRoot, env } = {}) {
  const db = requireDb({ repoRoot, env });
  const sources = readRows(db, SOURCE_TABLE);
  const proposals = readRows(db, PROPOSAL_TABLE);
  const laneRows = readRows(db, LANE_TABLE, "lane ASC");
  const laneStates = Object.fromEntries(
    DEEP_INGEST_REQUIRED_LANES.map((lane) => [
      lane,
      {
        id: lane,
        lane,
        status: "not_started",
        reason: null,
        createdAt: null,
        updatedAt: null,
      },
    ])
  );
  for (const row of laneRows) {
    if (row?.lane) laneStates[row.lane] = row;
  }

  const terminalLanes = DEEP_INGEST_REQUIRED_LANES.filter((lane) =>
    DEEP_INGEST_TERMINAL_STATUSES.includes(laneStates[lane]?.status)
  );

  return {
    ok: true,
    sources,
    proposals,
    laneStates,
    confirmed: {
      evidence: proposals.filter(
        (proposal) => proposal.lane === "evidence_claims" && proposal.status === "confirmed"
      ),
      storyBank: readRows(db, "deep_ingest_story_bank"),
      writingVoice: readRows(db, "deep_ingest_writing_voice"),
      honestyBoundaries: readRows(db, "deep_ingest_honesty_boundaries"),
      roleSignals: readRows(db, "deep_ingest_role_signals"),
    },
    openGaps: proposals.filter(
      (proposal) => proposal.lane === "open_gaps" && proposal.status !== "confirmed"
    ),
    requiredLaneCount: DEEP_INGEST_REQUIRED_LANES.length,
    terminalLaneCount: terminalLanes.length,
    terminalSummary: {
      complete: terminalLanes.length === DEEP_INGEST_REQUIRED_LANES.length,
      terminalLanes,
      missingLanes: DEEP_INGEST_REQUIRED_LANES.filter((lane) => !terminalLanes.includes(lane)),
    },
  };
}
