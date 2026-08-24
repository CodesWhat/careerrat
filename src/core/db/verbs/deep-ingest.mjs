// verbs/deep-ingest.mjs - SQLite-native Deep ingest source/proposal/lane state.
//
// Deep ingest source, proposal, and lane-state writes are product workflow state,
// not tracker-visible job-search outcomes. These verbs intentionally avoid
// shared runVerb()/exportToTracker() side effects; only explicit confirmation
// writes trusted candidate facts.
import { randomUUID } from "node:crypto";
import {
  DEFAULT_DEEP_INGEST_REQUIRED_LANES,
  evaluateDeepIngestReadiness,
  DEEP_INGEST_TERMINAL_STATUSES as READINESS_TERMINAL_STATUSES,
} from "../../deep-ingest/readiness.mjs";
import { validateDeepIngestGrounding } from "../../deep-ingest/validators/grounding.mjs";
import { validateDeepIngestLaneTransition } from "../../deep-ingest/validators/lane-state.mjs";
import { validateDeepIngestPrivacy } from "../../deep-ingest/validators/privacy.mjs";
import { requireDb } from "../connection.mjs";
import { withTransaction } from "../transaction.mjs";
import { bumpMeta, logActivityEvent } from "./shared.mjs";

const SOURCE_TABLE = "deep_ingest_sources";
const CHUNK_TABLE = "deep_ingest_source_chunks";
const PROPOSAL_TABLE = "deep_ingest_proposals";
const LANE_TABLE = "deep_ingest_lane_states";

// The four lanes writeConfirmedLaneOutput lands in a dedicated per-lane
// table (evidence_claims is the fifth confirmable lane, but it lands in
// candidate_evidence_claims via writeEvidenceClaims/candidateEvidenceMerge
// instead — see writeConfirmedLaneOutput below). Shared by
// writeConfirmedLaneOutput and the confirmed-item update/remove verbs so the
// two can never disagree on which table a lane writes to.
const CONFIRMED_LANE_TABLES = {
  story_bank: "deep_ingest_story_bank",
  honesty_boundaries: "deep_ingest_honesty_boundaries",
  writing_voice: "deep_ingest_writing_voice",
  role_signals: "deep_ingest_role_signals",
};

const CONFIRMED_LANE_ACTIVITY = {
  source_coverage: {
    singular: "Source coverage",
    confirmed: "Source coverage confirmed",
  },
  evidence_claims: {
    singular: "Evidence claim",
    confirmed: "Evidence added from deep intake",
  },
  story_bank: {
    singular: "Interview story",
    confirmed: "Interview story added",
  },
  honesty_boundaries: {
    singular: "Honesty boundary",
    confirmed: "Honesty boundary confirmed",
  },
  writing_voice: {
    singular: "Writing preferences",
    confirmed: "Writing preferences confirmed",
  },
  role_signals: {
    singular: "Role signal",
    confirmed: "Role signals confirmed",
  },
  open_gaps: {
    singular: "Open gap",
    confirmed: "Open gap reviewed",
  },
};

export const DEEP_INGEST_REQUIRED_LANES = DEFAULT_DEEP_INGEST_REQUIRED_LANES;

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

export const DEEP_INGEST_TERMINAL_STATUSES = READINESS_TERMINAL_STATUSES;

const TARGET_SHAPES = new Set([
  "auto",
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
  ["mark_not_available", "not_available"],
  ["reject", "rejected"],
  ["reopen", "review_needed"],
  ["retry", "review_needed"],
  ["save_edits", "review_needed"],
]);

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

function logConfirmedCandidateActivity(db, { lane, action, count = 1 }) {
  const labels = CONFIRMED_LANE_ACTIVITY[lane] || {
    singular: "Deep intake item",
    confirmed: "Deep intake item confirmed",
  };
  const title =
    action === "confirm"
      ? labels.confirmed
      : `${labels.singular} ${
          action === "remove" ? "removed" : action === "add" ? "added" : "updated"
        }`;
  const meta = bumpMeta(db);
  const event = logActivityEvent(db, {
    type: "system",
    title,
    summary:
      action === "confirm"
        ? `Confirmed ${count} ${count === 1 ? "item" : "items"} from the deep intake review.`
        : action === "remove"
          ? "Removed a confirmed item from the Evidence Library."
          : action === "add"
            ? "Added a manually confirmed item to the Evidence Library."
            : "Saved edits to a confirmed Evidence Library item.",
    tags: [
      `operation:${action === "confirm" ? "deep-intake:confirm" : `library:item-${action}`}`,
      `lane:${lane}`,
    ],
  });
  return { meta, event };
}

function parseRow(row) {
  return row ? JSON.parse(row.data) : null;
}

function readRow(db, table, id) {
  return parseRow(db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(String(id)));
}

function requireRow(db, table, id, label) {
  const row = readRow(db, table, id);
  if (!row) throw makeError(`${label} not found: "${id}"`, "NOT_FOUND");
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

function chunkFromInput(source, raw, index) {
  const now = nowIso();
  return {
    id: raw?.id ? String(raw.id) : `${source.id}_chunk_${String(index + 1).padStart(3, "0")}`,
    sourceId: source.id,
    chunkKind: String(raw?.chunkKind || "text"),
    index,
    text: String(raw?.text || ""),
    charStart: Number(raw?.charStart || 0),
    charEnd: Number(raw?.charEnd || String(raw?.text || "").length),
    byteStart: Number(raw?.byteStart || 0),
    byteEnd: Number(raw?.byteEnd || Buffer.byteLength(String(raw?.text || ""), "utf8")),
    createdAt: raw?.createdAt || source.createdAt || now,
    updatedAt: raw?.updatedAt || source.updatedAt || now,
  };
}

function replaceSourceChunks(db, source, chunks) {
  db.prepare(`DELETE FROM ${CHUNK_TABLE} WHERE source_id = ?`).run(source.id);
  const rawChunks =
    Array.isArray(chunks) && chunks.length
      ? chunks
      : source._sourceText
        ? [{ id: `${source.id}_chunk_001`, text: source._sourceText }]
        : [];
  const normalized = rawChunks.map((chunk, index) => chunkFromInput(source, chunk, index));
  for (const chunk of normalized) {
    putRow(db, CHUNK_TABLE, chunk.id, chunk);
  }
  return normalized;
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

function proposalItems(proposalPayload = {}) {
  if (Array.isArray(proposalPayload.items)) return proposalPayload.items;
  if (Array.isArray(proposalPayload.proposals)) return proposalPayload.proposals;
  if (Array.isArray(proposalPayload.gaps)) return proposalPayload.gaps;
  if (proposalPayload.payload && typeof proposalPayload.payload === "object")
    return [proposalPayload];
  return [];
}

function sourceChunks(db, sourceId) {
  return db
    .prepare(
      `SELECT data FROM ${CHUNK_TABLE} WHERE source_id = ? ORDER BY json_extract(data, '$.index') ASC`
    )
    .all(String(sourceId || ""))
    .map((row) => JSON.parse(row.data));
}

function proposalBlockedReasons(value) {
  const reasons = new Set();
  const payload = value?.proposal || value || {};
  if (payload?.validation?.status === "blocked") {
    for (const reason of payload.validation.blockedReasons || []) reasons.add(String(reason));
  }
  for (const item of proposalItems(payload)) {
    if (item?.status === "blocked" || item?.validation?.status === "blocked") {
      reasons.add("blocked");
      for (const reason of item?.validation?.blockedReasons || []) reasons.add(String(reason));
    }
  }
  return [...reasons].filter(Boolean);
}

function validationPayload(item) {
  if (item?.payload && typeof item.payload === "object") return item.payload;
  const { validation: _validation, ...rest } = item || {};
  return rest;
}

function normalizeEditedItems({ db, proposal, edits = {}, forConfirm = false }) {
  const currentItems = proposalItems(proposal.proposal);
  const editedItems = Array.isArray(edits.items) ? edits.items : [];
  const rawItems = editedItems.length ? editedItems : currentItems;
  const chunks = sourceChunks(db, proposal.sourceId);

  return rawItems.map((raw, index) => {
    const base = currentItems[index] && editedItems.length ? currentItems[index] : {};
    const item = {
      ...clone(base),
      ...clone(raw || {}),
      sourceId: String(raw?.sourceId || base?.sourceId || proposal.sourceId),
    };
    if (!item.chunkId && chunks.length === 1) item.chunkId = chunks[0].id;
    const blockedReasons = new Set();
    let status = "passed";

    const currentValidation = item.validation || {};
    if (item.status === "blocked" || currentValidation.status === "blocked") {
      for (const reason of currentValidation.blockedReasons || [])
        blockedReasons.add(String(reason));
      if (!editedItems.length) status = "blocked";
    }

    const privacy = validateDeepIngestPrivacy({ proposal: { payload: validationPayload(item) } });
    if (!privacy.ok) {
      status = "blocked";
      for (const reason of privacy.blockedFields) blockedReasons.add(reason);
    }

    if (proposal.lane !== "open_gaps") {
      const grounding = validateDeepIngestGrounding({ proposal: item, chunks });
      if (!grounding.ok) {
        status = status === "blocked" ? "blocked" : "needs_quote";
        for (const reason of grounding.errors?.length ? ["ungrounded"] : grounding.blockedFields) {
          blockedReasons.add(reason);
        }
      }
    }

    if (forConfirm && status !== "passed") {
      const err = makeError(
        status === "needs_quote"
          ? "Deep ingest proposal needs a supporting source quote before confirmation"
          : "Deep ingest proposal is blocked and cannot be confirmed",
        "PROPOSAL_BLOCKED"
      );
      err.validation = { status, blockedReasons: [...blockedReasons].sort() };
      throw err;
    }

    return {
      ...item,
      validation: {
        status,
        blockedReasons: [...blockedReasons].sort(),
      },
    };
  });
}

function mergedProposalPayload(current, edits, items) {
  return {
    ...clone(current.proposal || {}),
    ...clone(edits || {}),
    items,
    validation: {
      status: items.some((item) => item.validation?.status === "blocked")
        ? "blocked"
        : items.some((item) => item.validation?.status === "needs_quote")
          ? "needs_quote"
          : "passed",
      blockedReasons: [
        ...new Set(items.flatMap((item) => item.validation?.blockedReasons || [])),
      ].sort(),
    },
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

function writeEvidenceClaims(db, items, proposal, confirmedAt) {
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
  let accepted = 0;
  for (const raw of Array.isArray(items) ? items : []) {
    const claim = evidenceClaimFromItem(raw);
    if (!claim) continue;
    accepted += 1;
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
      sourceId: String(raw?.sourceId || proposal.sourceId),
      sourceProposalId: proposal.id,
      supportingQuote: raw?.supportingQuote ? String(raw.supportingQuote) : null,
      confirmedAt,
    };
    stmt.run(id, JSON.stringify(data), nowIso());
    added += 1;
  }
  return { added, accepted };
}

function evidenceClaimFromItem(raw) {
  return String(raw?.claim || raw?.payload?.claim || raw?.title || raw?.summary || "").trim();
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
    const evidence = writeEvidenceClaims(db, items, proposal, updatedAt);
    if (evidence.accepted === 0) {
      throw makeError("Deep ingest evidence confirmation requires a claim");
    }
    return { evidence };
  }

  const table = CONFIRMED_LANE_TABLES[proposal.lane];
  if (!table) return { written: 0 };

  let written = 0;
  for (const raw of items.length ? items : [edits]) {
    if (!raw || typeof raw !== "object") continue;
    const id = raw.id ? String(raw.id) : `${proposal.lane}_${randomUUID()}`;
    putRow(db, table, id, {
      ...clone(raw),
      id,
      status: raw.status || "confirmed",
      sourceId: String(raw.sourceId || proposal.sourceId),
      sourceProposalId: proposal.id,
      supportingQuote: raw.supportingQuote ? String(raw.supportingQuote) : null,
      confirmedAt: updatedAt,
      updatedAt,
    });
    written += 1;
  }
  return { written };
}

function markLaneCompleted(db, lane, updatedAt) {
  const normalizedLane = normalizeLane(lane);
  const existing = readRow(db, LANE_TABLE, normalizedLane);
  putRow(db, LANE_TABLE, normalizedLane, {
    id: normalizedLane,
    lane: normalizedLane,
    status: "completed",
    reason: null,
    createdAt: existing?.createdAt || updatedAt,
    updatedAt,
  });
}

export function deepIngestSourceCreate({ repoRoot, env, input } = {}) {
  return runDeepIngestVerb({ repoRoot, env }, (db) => {
    const source = sourceFromInput(input);
    if (input?.text != null) source._sourceText = String(input.text || "");
    putRow(db, SOURCE_TABLE, source.id, source);
    const chunks = replaceSourceChunks(db, source, input?.chunks);
    delete source._sourceText;
    putRow(db, SOURCE_TABLE, source.id, source);
    const sourceCoverage = readRow(db, LANE_TABLE, "source_coverage");
    putRow(db, LANE_TABLE, "source_coverage", {
      id: "source_coverage",
      lane: "source_coverage",
      status: "review_needed",
      reason: null,
      createdAt: sourceCoverage?.createdAt || source.createdAt,
      updatedAt: source.updatedAt,
    });
    const openGaps = readRow(db, LANE_TABLE, "open_gaps");
    putRow(db, LANE_TABLE, "open_gaps", {
      id: "open_gaps",
      lane: "open_gaps",
      status: "not_started",
      reason: null,
      createdAt: openGaps?.createdAt || source.createdAt,
      updatedAt: source.updatedAt,
    });
    return {
      ok: true,
      source: readRow(db, SOURCE_TABLE, source.id),
      chunks,
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

export function deepIngestSourceRemove({ repoRoot, env, sourceId, id } = {}) {
  const rowId = String(sourceId || id || "").trim();
  if (!rowId) throw makeError("deepIngestSourceRemove requires sourceId");

  return runDeepIngestVerb({ repoRoot, env }, (db) => {
    requireRow(db, SOURCE_TABLE, rowId, "Deep ingest source");
    const proposalRows = db
      .prepare(`SELECT data FROM ${PROPOSAL_TABLE} WHERE source_id = ?`)
      .all(rowId)
      .map((row) => JSON.parse(row.data));
    const hasDrafts = proposalRows.some(
      (row) => row?.proposal?.validation?.status !== "source_scanned"
    );
    if (hasDrafts) {
      throw makeError(
        "Deep ingest source has drafted proposals; discard or resolve them before removing it",
        "SOURCE_HAS_DRAFTS"
      );
    }

    const removedProposals = db
      .prepare(`DELETE FROM ${PROPOSAL_TABLE} WHERE source_id = ?`)
      .run(rowId).changes;
    const removedChunks = db
      .prepare(`DELETE FROM ${CHUNK_TABLE} WHERE source_id = ?`)
      .run(rowId).changes;
    db.prepare(`DELETE FROM ${SOURCE_TABLE} WHERE id = ?`).run(rowId);

    return { ok: true, sourceId: rowId, removedProposals, removedChunks };
  });
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
  edits = {},
} = {}) {
  const expected = normalizeExpectedVersion(expectedVersion, "deepIngestProposalDecision");
  const normalizedDecision = String(decision || "").trim();
  const status = PROPOSAL_DECISION_TO_STATUS.get(normalizedDecision);
  if (!status) throw makeError(`unsupported Deep ingest proposal decision "${normalizedDecision}"`);
  if (
    (status === "deferred" || status === "rejected" || status === "not_available") &&
    !String(reason || "").trim()
  ) {
    throw makeError("Deep ingest proposal decision requires reason");
  }

  return runDeepIngestVerb({ repoRoot, env }, (db) => {
    const current = requireRow(db, PROPOSAL_TABLE, proposalId, "Deep ingest proposal");
    assertProposalVersion(current, expected);
    const updatedAt = nowIso();
    if (normalizedDecision === "save_edits") {
      assertNoPrivateCompKeys(edits);
      const items = normalizeEditedItems({ db, proposal: current, edits });
      const next = {
        ...current,
        status: "review_needed",
        version: expected + 1,
        proposal: mergedProposalPayload(current, edits, items),
        decision: normalizedDecision,
        reason: null,
        updatedAt,
      };
      putRow(db, PROPOSAL_TABLE, next.id, next);
      return readRow(db, PROPOSAL_TABLE, next.id);
    }
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
    const hasEdits = Array.isArray(edits?.items) && edits.items.length > 0;
    const currentBlocks = proposalBlockedReasons(current);
    if (!hasEdits && currentBlocks.length) {
      const err = makeError(
        "Deep ingest proposal is blocked and cannot be confirmed",
        "PROPOSAL_BLOCKED"
      );
      err.validation = { status: "blocked", blockedReasons: currentBlocks };
      throw err;
    }
    const updatedAt = nowIso();
    const items = normalizeEditedItems({ db, proposal: current, edits, forConfirm: true });
    const confirmedOutput = { ...clone(edits), items };
    const output = writeConfirmedLaneOutput(db, current, confirmedOutput, updatedAt);
    const next = {
      ...current,
      status: "confirmed",
      version: expected + 1,
      decision: "confirm",
      reason: null,
      proposal: mergedProposalPayload(current, confirmedOutput, items),
      confirmedOutput,
      output,
      updatedAt,
    };
    putRow(db, PROPOSAL_TABLE, next.id, next);
    markLaneCompleted(db, current.lane, updatedAt);
    const activity = logConfirmedCandidateActivity(db, {
      lane: current.lane,
      action: "confirm",
      count: items.length,
    });
    return { ...readRow(db, PROPOSAL_TABLE, next.id), ...activity };
  });
}

// Resolve a lane name to its confirmed-item table for the update/remove
// verbs below. normalizeLane() already rejects any string outside the full
// DEEP_INGEST_REQUIRED_LANES set; the extra check here narrows further to
// just the four lanes CONFIRMED_LANE_TABLES covers — evidence_claims,
// source_coverage, and open_gaps have no dedicated per-lane table (evidence
// claims are edited/removed via the candidate evidence verbs instead, see
// src/core/db/verbs/candidate.mjs's candidateEvidenceMerge/
// candidateEvidenceRemoveOne).
function confirmedLaneTable(lane) {
  const normalizedLane = normalizeLane(lane);
  const table = CONFIRMED_LANE_TABLES[normalizedLane];
  if (!table) {
    throw makeError(
      `Deep ingest lane "${normalizedLane}" has no confirmed reference table to edit`
    );
  }
  return { lane: normalizedLane, table };
}

// Update one already-confirmed reference-library row by {lane, id}. This is
// a plain, user-initiated edit of the user's own already-confirmed data —
// unlike confirming a proposal, it re-runs ONLY the privacy guard
// (validateDeepIngestPrivacy — the same comp/contact/protected-trait/
// local-path/private-token check normalizeEditedItems runs before
// confirmation) and never grounding/quote-matching, since a user's own later
// edit isn't chunk-bound the way an AI-proposed item is.
//
// writeConfirmedLaneOutput's putRow() call above is a plain upsert-by-id
// (INSERT ... ON CONFLICT(id) DO UPDATE SET data = excluded.data) — that's
// what lets this verb update the row in place by reusing putRow with the
// SAME id, rather than needing separate UPDATE SQL or any special-cased
// upsert-vs-insert branching.
export function deepIngestConfirmedItemUpdate({ repoRoot, env, lane, id, fields } = {}) {
  const rowId = String(id || "").trim();
  if (!rowId) throw makeError("deepIngestConfirmedItemUpdate requires id");
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw makeError("deepIngestConfirmedItemUpdate requires fields");
  }

  const { lane: normalizedLane, table } = confirmedLaneTable(lane);
  const privacy = validateDeepIngestPrivacy({ proposal: { payload: fields } });
  if (!privacy.ok) {
    const err = makeError(
      "Deep ingest confirmed item update is blocked by the privacy guard",
      "PRIVACY_BLOCKED"
    );
    err.reasons = privacy.blockedFields;
    throw err;
  }

  return runDeepIngestVerb({ repoRoot, env }, (db) => {
    const current = requireRow(db, table, rowId, "Deep ingest confirmed item");
    const updatedAt = nowIso();
    const next = {
      ...clone(current),
      ...clone(fields),
      id: rowId,
      lane: normalizedLane,
      updatedAt,
    };
    putRow(db, table, rowId, next);
    const activity = logConfirmedCandidateActivity(db, {
      lane: normalizedLane,
      action: "update",
    });
    return { ok: true, lane: normalizedLane, item: readRow(db, table, rowId), ...activity };
  });
}

export function deepIngestConfirmedItemUpsert({ repoRoot, env, lane, id, fields } = {}) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw makeError("deepIngestConfirmedItemUpsert requires fields");
  }

  const { lane: normalizedLane, table } = confirmedLaneTable(lane);
  const privacy = validateDeepIngestPrivacy({ proposal: { payload: fields } });
  if (!privacy.ok) {
    const err = makeError(
      "Deep ingest confirmed item update is blocked by the privacy guard",
      "PRIVACY_BLOCKED"
    );
    err.reasons = privacy.blockedFields;
    throw err;
  }

  return runDeepIngestVerb({ repoRoot, env }, (db) => {
    const rowId = String(id || "").trim() || `${normalizedLane}_${randomUUID()}`;
    const current = readRow(db, table, rowId);
    const updatedAt = nowIso();
    const next = {
      ...(current ? clone(current) : {}),
      ...clone(fields),
      id: rowId,
      lane: normalizedLane,
      status: "confirmed",
      confirmedAt: current?.confirmedAt || updatedAt,
      updatedAt,
    };
    putRow(db, table, rowId, next);
    markLaneCompleted(db, normalizedLane, updatedAt);
    const created = !current;
    const activity = logConfirmedCandidateActivity(db, {
      lane: normalizedLane,
      action: created ? "add" : "update",
    });
    return {
      ok: true,
      lane: normalizedLane,
      created,
      item: readRow(db, table, rowId),
      ...activity,
    };
  });
}

// Remove exactly one confirmed reference-library row by {lane, id}. A clean
// NOT_FOUND on an unknown id (via requireRow), same convention as every
// other by-id lookup in this file.
export function deepIngestConfirmedItemRemove({ repoRoot, env, lane, id } = {}) {
  const rowId = String(id || "").trim();
  if (!rowId) throw makeError("deepIngestConfirmedItemRemove requires id");

  const { lane: normalizedLane, table } = confirmedLaneTable(lane);

  return runDeepIngestVerb({ repoRoot, env }, (db) => {
    requireRow(db, table, rowId, "Deep ingest confirmed item");
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(rowId);
    const activity = logConfirmedCandidateActivity(db, {
      lane: normalizedLane,
      action: "remove",
    });
    return { ok: true, lane: normalizedLane, removed: rowId, ...activity };
  });
}

// --- deepIngestConfirmedForGeneration ---------------------------------------
//
// Promotion-pipeline reader (promotion-pipeline-design-2026-07-19.md): the
// read-time source for every generate-time consumer (packet context, the
// gate, the sourced scanner) of the four confirmed Library lanes. Never
// materializes into stories.yml/writing-style.md/targeting/honesty YAML —
// those stay read-only and untouched (Decision 1/2).

function rowId(row) {
  return row && typeof row === "object" && row.id != null ? String(row.id) : "";
}

function cleanScalar(value) {
  return value == null ? "" : String(value).trim();
}

// Accepts any mix of arrays/strings (e.g. a story's role_signals vs.
// roleSignals spelling) and folds them into one deduped, trimmed list —
// case-insensitive dedupe, first spelling wins.
function toStringList(...values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const items = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
    for (const item of items) {
      const text = String(item ?? "").trim();
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
  }
  return out;
}

function projectStoryRow(row) {
  return {
    id: rowId(row),
    // Every row here already passed the status === "confirmed" filter; the
    // field must survive projection because the packet engine's legacy
    // claimable/unconfirmed split keys on it (generate.mjs reviewed()) —
    // without it, confirmed stories get prompted as "unconfirmed" material.
    status: "confirmed",
    title: cleanScalar(row.title),
    situation: cleanScalar(row.situation),
    task: cleanScalar(row.task),
    action: cleanScalar(row.action),
    result: cleanScalar(row.result),
    reflection: cleanScalar(row.reflection),
    competencies: toStringList(row.competencies),
    roleSignals: toStringList(row.role_signals, row.roleSignals),
    metrics: toStringList(row.metrics),
    openQuestions: toStringList(row.open_questions, row.openQuestions),
    supportingQuote: cleanScalar(row.supportingQuote),
    confirmedAt: cleanScalar(row.confirmedAt),
    updatedAt: cleanScalar(row.updatedAt),
  };
}

function projectVoiceRow(row) {
  return {
    id: rowId(row),
    summary: cleanScalar(row.summary),
    doPhrases: toStringList(row.doPhrases),
    avoidPhrases: toStringList(row.avoidPhrases),
    updatedAt: cleanScalar(row.updatedAt),
  };
}

function projectBoundaryRow(row) {
  return {
    id: rowId(row),
    boundaryType: cleanScalar(row.boundaryType),
    text: cleanScalar(row.text),
    allowedWording: cleanScalar(row.allowedWording),
    forbiddenWording: cleanScalar(row.forbiddenWording),
    reason: cleanScalar(row.reason),
    updatedAt: cleanScalar(row.updatedAt),
  };
}

function projectRoleSignalRow(row) {
  return {
    id: rowId(row),
    roleFamily: cleanScalar(row.roleFamily),
    signalType: cleanScalar(row.signalType),
    text: cleanScalar(row.text),
    rationale: cleanScalar(row.rationale),
    updatedAt: cleanScalar(row.updatedAt),
  };
}

// Reads one confirmed lane table, keeps only `status === "confirmed"` rows,
// re-runs the privacy guard per row (a privacy-failing row is skipped even
// for honesty — Decision 9), and projects through the lane's field allowlist
// (never spreads arbitrary JSON onward, so current_base can never surface).
//
// `failClosed` (honesty only): a malformed row throws out of this function
// entirely instead of being caught and skipped, so a read/parse failure on
// the honesty table fails the whole verb call — the other three lanes stay
// best-effort and record a diagnostic instead.
function collectConfirmedLane({ db, lane, table, projectRow, skipped, failClosed = false }) {
  const rows = readRows(db, table, "updated_at DESC, id ASC");
  const kept = [];
  for (const row of rows) {
    try {
      if (!row || typeof row !== "object") throw new Error("row is not an object");
      if (row.status !== "confirmed") continue;
      const privacy = validateDeepIngestPrivacy({ proposal: { payload: row } });
      if (!privacy.ok) {
        skipped.push({
          lane,
          id: rowId(row),
          reason: `privacy: ${privacy.blockedFields.join(", ")}`,
        });
        continue;
      }
      kept.push(projectRow(row));
    } catch (err) {
      if (failClosed) throw err;
      skipped.push({ lane, id: rowId(row), reason: `malformed: ${err.message}` });
    }
  }
  return kept;
}

export function deepIngestConfirmedForGeneration({ repoRoot, env } = {}) {
  const db = requireDb({ repoRoot, env });
  const skipped = [];

  const storyBank = collectConfirmedLane({
    db,
    lane: "story_bank",
    table: CONFIRMED_LANE_TABLES.story_bank,
    projectRow: projectStoryRow,
    skipped,
  });
  const writingVoice = collectConfirmedLane({
    db,
    lane: "writing_voice",
    table: CONFIRMED_LANE_TABLES.writing_voice,
    projectRow: projectVoiceRow,
    skipped,
  });
  const roleSignals = collectConfirmedLane({
    db,
    lane: "role_signals",
    table: CONFIRMED_LANE_TABLES.role_signals,
    projectRow: projectRoleSignalRow,
    skipped,
  });
  // Honesty fails closed (Decision 9): a read/parse failure here must throw
  // and fail generation with the existing error surface, never silently
  // drop boundary rows the way the other three lanes do.
  const honestyBoundaries = collectConfirmedLane({
    db,
    lane: "honesty_boundaries",
    table: CONFIRMED_LANE_TABLES.honesty_boundaries,
    projectRow: projectBoundaryRow,
    skipped,
    failClosed: true,
  });

  return { storyBank, writingVoice, honestyBoundaries, roleSignals, skipped };
}

export function deepIngestLaneSetState({ repoRoot, env, lane, status, reason } = {}) {
  const transition = validateDeepIngestLaneTransition({ lane, status, reason });
  if (!transition.ok) throw makeError(transition.error);
  const normalizedLane = normalizeLane(transition.lane);
  const normalizedStatus = normalizeLaneStatus(transition.status);

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
  const sourceChunks = readRows(db, CHUNK_TABLE);
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

  const readiness = evaluateDeepIngestReadiness({
    laneStates,
    requiredLanes: DEEP_INGEST_REQUIRED_LANES,
  });
  const terminalLanes = readiness.lanes.filter((lane) => lane.terminal).map((lane) => lane.key);

  return {
    ok: true,
    sources,
    sourceChunks,
    proposals,
    lanes: readiness.lanes,
    laneStates,
    readiness,
    todos: readiness.todos,
    gaps: readiness.gaps,
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
    terminalLaneCount: readiness.terminalCount,
    terminalSummary: {
      complete: readiness.ready,
      terminalLanes,
      missingLanes: readiness.missing.map((lane) => lane.key),
    },
  };
}
