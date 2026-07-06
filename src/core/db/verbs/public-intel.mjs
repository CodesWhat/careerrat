// verbs/public-intel.mjs — DB-owned public company/board metadata.

import { scrubPublicIntelPayload } from "../../discovery/public-intel-scrub.mjs";
import { requireDb } from "../connection.mjs";
import { withTransaction } from "../transaction.mjs";
import { companyAtsUpsert } from "./source-config.mjs";

const PREF_ID = "public-sync-home";

export const PUBLIC_INTEL_REVIEW_ACTIONS = Object.freeze([
  { action: "use-supported-ats", label: "Use supported ATS" },
  { action: "keep-public-metadata", label: "Keep public metadata" },
  { action: "refresh-scan", label: "Refresh scan" },
  { action: "suppress-review", label: "Suppress review" },
  { action: "escalate-agent", label: "Escalate to agent" },
]);

const REVIEW_ACTIONS = new Set(PUBLIC_INTEL_REVIEW_ACTIONS.map((item) => item.action));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string" || typeof now === "number") return new Date(now).toISOString();
  return new Date().toISOString();
}

function makeError(message, code, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

function readRow(db, table, id) {
  const row = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(String(id));
  return row ? JSON.parse(row.data) : null;
}

function readRows(db, table, where = "", params = []) {
  return db
    .prepare(`SELECT data FROM ${table} ${where} ORDER BY updated_at DESC, id ASC`)
    .all(...params)
    .map((row) => JSON.parse(row.data));
}

function publicPreference(stored) {
  if (!stored) return { enabled: true, source: "default", updatedAt: null };
  return {
    enabled: Boolean(stored.enabled),
    source: stored.source || "user",
    updatedAt: stored.updatedAt || null,
  };
}

function requireId(value, label) {
  const id = String(value?.id || "").trim();
  if (!id) throw makeError(`${label} requires id`, "BAD_REQUEST", 400);
  return id;
}

function publicData(value, { now, context }) {
  const next = clone(value || {});
  next.updatedAt = next.updatedAt || nowIso(now);
  return scrubPublicIntelPayload(next, { context });
}

function upsertPublicRow({ repoRoot, env, table, label, value, now }) {
  const id = requireId(value, label);
  const data = publicData(value, { now, context: label });
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    db.prepare(
      `INSERT INTO ${table} (id, data)
       VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET data=excluded.data`
    ).run(id, JSON.stringify(data));
    return { ok: true, [label]: readRow(db, table, id) };
  });
}

export function publicCompanyIntelUpsert({ repoRoot, env, record, now } = {}) {
  const result = upsertPublicRow({
    repoRoot,
    env,
    table: "public_company_intel",
    label: "record",
    value: record,
    now,
  });
  return { ok: true, record: result.record };
}

export function publicBoardIntelUpsert({ repoRoot, env, record, now } = {}) {
  const result = upsertPublicRow({
    repoRoot,
    env,
    table: "public_board_intel",
    label: "record",
    value: record,
    now,
  });
  return { ok: true, record: result.record };
}

export function publicCareersPageUpsert({ repoRoot, env, page, now } = {}) {
  const result = upsertPublicRow({
    repoRoot,
    env,
    table: "public_careers_pages",
    label: "page",
    value: page,
    now,
  });
  return { ok: true, page: result.page };
}

export function publicSyncPreferenceGet({ repoRoot, env } = {}) {
  const db = requireDb({ repoRoot, env });
  const stored = readRow(db, "public_sync_preferences", PREF_ID);
  return {
    ok: true,
    preference: publicPreference(stored),
  };
}

export function publicSyncPreferenceSet({ repoRoot, env, enabled, now } = {}) {
  if (typeof enabled !== "boolean") {
    throw makeError("public sync preference enabled must be a boolean", "BAD_REQUEST", 400);
  }
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const data = {
      id: PREF_ID,
      enabled,
      source: "user",
      updatedAt: nowIso(now),
    };
    db.prepare(
      `INSERT INTO public_sync_preferences (id, data)
       VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET data=excluded.data`
    ).run(PREF_ID, JSON.stringify(data));
    return {
      ok: true,
      preference: publicPreference(readRow(db, "public_sync_preferences", PREF_ID)),
    };
  });
}

export function publicIntelSyncPreview({ repoRoot, env } = {}) {
  const db = requireDb({ repoRoot, env });
  const data = {
    companies: readRows(db, "public_company_intel"),
    boards: readRows(db, "public_board_intel"),
    careersPages: readRows(db, "public_careers_pages"),
    preference: publicPreference(readRow(db, "public_sync_preferences", PREF_ID)),
  };
  scrubPublicIntelPayload(data, { context: "public-sync-preview" });
  return { ok: true, data };
}

export function publicIntelStateGet({ repoRoot, env } = {}) {
  const db = requireDb({ repoRoot, env });
  return {
    ok: true,
    data: {
      counts: {
        companies: db.prepare("SELECT count(*) AS n FROM public_company_intel").get().n,
        boards: db.prepare("SELECT count(*) AS n FROM public_board_intel").get().n,
        careersPages: db.prepare("SELECT count(*) AS n FROM public_careers_pages").get().n,
        reviewItems: db
          .prepare("SELECT count(*) AS n FROM public_intel_review_items WHERE status = 'pending'")
          .get().n,
      },
      preference: publicSyncPreferenceGet({ repoRoot, env }).preference,
    },
  };
}

export function publicIntelReviewItemUpsert({ repoRoot, env, item, now } = {}) {
  const id = requireId(item, "item");
  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const current = readRow(db, "public_intel_review_items", id);
    const version = Number(item.version ?? current?.version ?? 0) || 1;
    const data = publicData(
      {
        status: "pending",
        ...clone(item),
        version,
      },
      { now, context: "public-intel-review-item" }
    );
    db.prepare(
      `INSERT INTO public_intel_review_items (id, data)
       VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET data=excluded.data`
    ).run(id, JSON.stringify(data));
    return { ok: true, item: readRow(db, "public_intel_review_items", id) };
  });
}

export function publicIntelReviewList({ repoRoot, env, status = "pending" } = {}) {
  const db = requireDb({ repoRoot, env });
  const where = status ? "WHERE status = ?" : "";
  return {
    ok: true,
    items: readRows(db, "public_intel_review_items", where, status ? [status] : []),
  };
}

function normalizeCompanyAtsEntry({ item, board }) {
  const jobBoardUrl = board?.boardUrl || board?.jobBoardUrl || item?.proposedBoardUrl;
  const atsProvider = board?.atsProvider || item?.proposedProvider;
  const name = item?.companyName || item?.companyKey || "Public company";
  if (!jobBoardUrl || !atsProvider || atsProvider === "custom") {
    throw makeError(
      "use-supported-ats requires a validated supported ATS board",
      "BAD_REQUEST",
      400
    );
  }
  return {
    name,
    careers_url: jobBoardUrl,
    jobBoardUrl,
    atsProvider,
  };
}

export function publicIntelReviewDecision({
  repoRoot,
  env,
  itemId,
  expectedVersion,
  action,
  patch = {},
  companyAtsUpsertImpl = companyAtsUpsert,
  now,
} = {}) {
  if (!String(itemId || "").trim()) {
    throw makeError("publicIntelReviewDecision requires itemId", "BAD_REQUEST", 400);
  }
  if (!REVIEW_ACTIONS.has(action)) {
    throw makeError(`unsupported public-intel review action: ${action}`, "BAD_REQUEST", 400);
  }
  if (!Number.isInteger(Number(expectedVersion))) {
    throw makeError("publicIntelReviewDecision requires expectedVersion", "BAD_REQUEST", 400);
  }

  const db = requireDb({ repoRoot, env });
  return withTransaction(db, () => {
    const current = readRow(db, "public_intel_review_items", itemId);
    if (!current)
      throw makeError(`public-intel review item not found: ${itemId}`, "NOT_FOUND", 404);
    const version = Number(current.version || 0);
    if (version !== Number(expectedVersion)) {
      throw makeError(
        `public-intel review item version conflict: expected ${expectedVersion}, found ${version}`,
        "CONFLICT",
        409
      );
    }

    let sourceConfigResult = null;
    if (action === "use-supported-ats") {
      const board = current.proposedBoardId
        ? readRow(db, "public_board_intel", current.proposedBoardId)
        : null;
      sourceConfigResult = companyAtsUpsertImpl(normalizeCompanyAtsEntry({ item: current, board }));
    }

    const nextStatus =
      action === "refresh-scan"
        ? "refresh_requested"
        : action === "suppress-review"
          ? "suppressed"
          : action === "escalate-agent"
            ? "escalated"
            : "resolved";
    const next = publicData(
      {
        ...clone(current),
        ...clone(patch),
        status: nextStatus,
        decision: { action, decidedAt: nowIso(now) },
        version: version + 1,
      },
      { now, context: "public-intel-review-decision" }
    );
    db.prepare("UPDATE public_intel_review_items SET data = ? WHERE id = ?").run(
      JSON.stringify(next),
      String(itemId)
    );
    return {
      ok: true,
      item: readRow(db, "public_intel_review_items", itemId),
      sourceConfig: sourceConfigResult,
    };
  });
}
