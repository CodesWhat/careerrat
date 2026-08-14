// verbs/calendar.mjs — opaque calendar context domain actions.
//
// calendarBusy[] is a top-level tracker.json key, so it is stored in the DB's
// kv table rather than a dedicated entity table. This file is intentionally
// still a named domain verb, not a generic kv writer: free/busy has a privacy
// invariant (start/end only, label always "Busy") that callers should not be
// able to bypass.
import { createHash } from "node:crypto";
import { bumpMeta, logActivityEvent, nowIso, runVerb } from "./shared.mjs";

const CALENDAR_BUSY_KEY = "calendarBusy";
const CALENDAR_WRITES_KEY = "calendarWrites";
const PROVIDERS = new Set([
  "work_calendar",
  "apple_calendar",
  "google_calendar",
  "outlook_calendar",
]);
const WRITE_PROVIDERS = new Set([
  "apple_calendar",
  "google_calendar",
  "outlook_calendar",
  "automation_tools",
]);

function readKvArray(db, key) {
  const row = db.prepare("SELECT data FROM kv WHERE key = ?").get(key);
  if (!row) return [];
  const parsed = JSON.parse(row.data);
  return Array.isArray(parsed) ? parsed : [];
}

function putKvArray(db, key, rows) {
  db.prepare(
    `INSERT INTO kv (key, data) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET data=excluded.data`
  ).run(key, JSON.stringify(rows));
}

function stableBusyId(provider, startIso, endIso) {
  const digest = createHash("sha256")
    .update(`${provider}\0${startIso}\0${endIso}`)
    .digest("hex")
    .slice(0, 16);
  return `busy_${digest}`;
}

function stableCalendarWriteId(provider, eventId, eventIso, title) {
  const digest = createHash("sha256")
    .update(`${provider}\0${eventId || ""}\0${eventIso || ""}\0${title}`)
    .digest("hex")
    .slice(0, 16);
  return `cal_${digest}`;
}

function assertIso(label, value) {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new Error(`calendarBusyUpsert: ${label} must be an ISO datetime`);
  }
}

function normalizeBlock(block, { ingestedAt, source }) {
  if (!block || typeof block !== "object") {
    throw new Error("calendarBusyUpsert: every block must be an object");
  }
  const provider = block.provider || "work_calendar";
  if (!PROVIDERS.has(provider)) {
    throw new Error(`calendarBusyUpsert: provider must be one of ${[...PROVIDERS].join(", ")}`);
  }
  const startIso = String(block.startIso || block.start || block.from || "").trim();
  const endIso = String(block.endIso || block.end || block.to || "").trim();
  assertIso("startIso", startIso);
  assertIso("endIso", endIso);
  if (Date.parse(endIso) <= Date.parse(startIso)) {
    throw new Error("calendarBusyUpsert: endIso must be after startIso");
  }

  return {
    id: stableBusyId(provider, startIso, endIso),
    provider,
    startIso,
    endIso,
    allDay: Boolean(block.allDay),
    label: "Busy",
    source: block.source || source || null,
    ingestedAt,
  };
}

function dedupeKey(block) {
  return `${block.provider}\0${block.startIso}\0${block.endIso}`;
}

function writeDedupeKey(record) {
  return `${record.provider}\0${record.eventId || ""}\0${record.eventIso || ""}\0${record.title.toLowerCase()}`;
}

export function calendarBusyUpsert({ repoRoot, env, blocks, source } = {}) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error("calendarBusyUpsert: blocks must be a non-empty array");
  }

  return runVerb({ repoRoot, env }, (db) => {
    const ingestedAt = nowIso();
    const merged = new Map();
    for (const existing of readKvArray(db, CALENDAR_BUSY_KEY)) {
      const normalized = normalizeBlock(existing, {
        ingestedAt: existing.ingestedAt || ingestedAt,
        source: existing.source || null,
      });
      merged.set(dedupeKey(normalized), {
        ...normalized,
        ingestedAt: existing.ingestedAt || ingestedAt,
      });
    }
    for (const block of blocks) {
      const normalized = normalizeBlock(block, { ingestedAt, source });
      merged.set(dedupeKey(normalized), normalized);
    }

    const nextBlocks = [...merged.values()].sort((a, b) => a.startIso.localeCompare(b.startIso));
    putKvArray(db, CALENDAR_BUSY_KEY, nextBlocks);
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "system",
      title: `Calendar busy blocks updated — ${nextBlocks.length} stored`,
      summary: "Opaque start/end windows only; meeting details were not stored.",
      tags: ["calendarBusy"],
      operation: "calendar:busy-upsert",
    });
    return { key: CALENDAR_BUSY_KEY, count: nextBlocks.length, blocks: nextBlocks, meta, event };
  });
}

function assertWriteIso(label, value) {
  if (value && Number.isNaN(Date.parse(value))) {
    throw new Error(`calendarWriteAppend: ${label} must be an ISO datetime when provided`);
  }
}

function trimOrNull(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function normalizeCalendarWrite(record, { wroteAt } = {}) {
  if (!record || typeof record !== "object") {
    throw new Error("calendarWriteAppend: record must be an object");
  }
  const provider = trimOrNull(record.provider || record.platform);
  if (!WRITE_PROVIDERS.has(provider)) {
    throw new Error(
      `calendarWriteAppend: provider must be one of ${[...WRITE_PROVIDERS].join(", ")}`
    );
  }
  const title = trimOrNull(record.title || record.eventTitle);
  if (!title) throw new Error("calendarWriteAppend: title is required");

  const eventIso = trimOrNull(record.eventIso || record.eventAt || record.date);
  const writeAt =
    trimOrNull(record.wroteAt || record.createdAt || record.at) || wroteAt || nowIso();
  assertWriteIso("eventIso", eventIso);
  assertWriteIso("wroteAt", writeAt);

  const eventId = trimOrNull(record.eventId || record.calendarEventId);
  const normalized = {
    id: trimOrNull(record.id) || stableCalendarWriteId(provider, eventId, eventIso, title),
    eventId,
    provider,
    title,
    status: trimOrNull(record.status) || "written",
    wroteAt: writeAt,
    eventIso,
    summary: trimOrNull(record.summary || record.note),
    artifactPath: trimOrNull(record.artifactPath),
  };

  for (const [key, value] of Object.entries(normalized)) {
    if (value === null || value === undefined) delete normalized[key];
  }
  return normalized;
}

// calendarWriteAppend({record}) — append one confirm-first external calendar
// write audit row to top-level calendarWrites[], deduped by provider/event/date/title.
export function calendarWriteAppend({ repoRoot, env, record } = {}) {
  return runVerb({ repoRoot, env }, (db) => {
    const wroteAt = nowIso();
    const normalized = normalizeCalendarWrite(record, { wroteAt });
    const merged = new Map();
    for (const existing of readKvArray(db, CALENDAR_WRITES_KEY)) {
      const current = normalizeCalendarWrite(existing, { wroteAt: existing.wroteAt || wroteAt });
      merged.set(writeDedupeKey(current), current);
    }
    merged.set(writeDedupeKey(normalized), normalized);

    const writes = [...merged.values()].sort((a, b) =>
      String(a.wroteAt || "").localeCompare(String(b.wroteAt || ""))
    );
    putKvArray(db, CALENDAR_WRITES_KEY, writes);
    const meta = bumpMeta(db);
    const event = logActivityEvent(db, {
      type: "system",
      title: "Calendar event synced",
      summary: normalized.summary || "Confirmed event written to the selected calendar provider.",
      refs: record?.applicationId
        ? { applicationId: record.applicationId, company: record.company, role: record.role }
        : { company: record?.company, role: record?.role },
      tags: ["calendar"],
      operation: "calendar:write-append",
    });
    return { key: CALENDAR_WRITES_KEY, count: writes.length, record: normalized, meta, event };
  });
}
