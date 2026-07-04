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
const PROVIDERS = new Set([
  "work_calendar",
  "apple_calendar",
  "google_calendar",
  "outlook_calendar",
]);

function readBusyBlocks(db) {
  const row = db.prepare("SELECT data FROM kv WHERE key = ?").get(CALENDAR_BUSY_KEY);
  if (!row) return [];
  const parsed = JSON.parse(row.data);
  return Array.isArray(parsed) ? parsed : [];
}

function putBusyBlocks(db, blocks) {
  db.prepare(
    `INSERT INTO kv (key, data) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET data=excluded.data`
  ).run(CALENDAR_BUSY_KEY, JSON.stringify(blocks));
}

function stableBusyId(provider, startIso, endIso) {
  const digest = createHash("sha256")
    .update(`${provider}\0${startIso}\0${endIso}`)
    .digest("hex")
    .slice(0, 16);
  return `busy_${digest}`;
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

export function calendarBusyUpsert({ repoRoot, env, blocks, source } = {}) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error("calendarBusyUpsert: blocks must be a non-empty array");
  }

  return runVerb({ repoRoot, env }, (db) => {
    const ingestedAt = nowIso();
    const merged = new Map();
    for (const existing of readBusyBlocks(db)) {
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
    putBusyBlocks(db, nextBlocks);
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
