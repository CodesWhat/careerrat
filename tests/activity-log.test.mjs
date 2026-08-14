// tests/activity-log.test.mjs
// node:test suite for the Activity Pulse feed primitive (activity-log.mjs).
//
// The feed renders on the dashboard (outbound), so the privacy + honesty backstops
// are load-bearing: these tests pin them, plus canonicalization defaults and the
// JSONL round-trip / dedupe / prune behavior.

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ACTIVITY_TYPES,
  appendActivity,
  canonicalizeEvent,
  computeAppend,
  eventId,
  listActivity,
  pruneActivity,
  readActivity,
} from "../src/core/tracker/activity-log.mjs";

const NOW = new Date("2026-06-16T12:00:00Z");

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "careerrat-activity-"));
}

// ---------------------------------------------------------------------------
// canonicalizeEvent — defaults + normalization
// ---------------------------------------------------------------------------

test("canonicalizeEvent fills defaults (id, at, actor, tone, needsUser)", () => {
  const e = canonicalizeEvent({ type: "evaluated", title: "Gate verdict: KEEP" }, { now: NOW });
  assert.equal(e.at, "2026-06-16T12:00:00.000Z");
  assert.equal(e.actor, "agent");
  assert.equal(e.tone, "info");
  assert.equal(e.needsUser, false);
  assert.ok(e.id.startsWith("evt_"));
});

test("canonicalizeEvent derives tone from type (offer→success, failure→warning)", () => {
  assert.equal(canonicalizeEvent({ type: "offer", title: "Offer" }, { now: NOW }).tone, "success");
  assert.equal(canonicalizeEvent({ type: "failure", title: "Halt" }, { now: NOW }).tone, "warning");
});

test("canonicalizeEvent drops empty optionals and empty refs", () => {
  const e = canonicalizeEvent(
    { type: "system", title: "x", summary: "  ", refs: { company: "" }, tags: [] },
    { now: NOW }
  );
  assert.ok(!("summary" in e));
  assert.ok(!("refs" in e));
  assert.ok(!("tags" in e));
});

test("eventId is stable for identical identifying content", () => {
  const a = eventId({
    at: "2026-06-10T00:00:00Z",
    type: "applied",
    title: "Applied — Acme",
    refs: { applicationId: "x" },
  });
  const b = eventId({
    at: "2026-06-10T00:00:00Z",
    type: "applied",
    title: "Applied — Acme",
    refs: { applicationId: "x" },
  });
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// computeAppend — validation + guards (pure, no fs)
// ---------------------------------------------------------------------------

test("computeAppend accepts a well-formed event", () => {
  const r = computeAppend({
    event: { type: "applied", title: "Applied — Staff PM @ Acme" },
    now: NOW,
  });
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(r.line).type, "applied");
});

test("computeAppend refuses a missing title", () => {
  const r = computeAppend({ event: { type: "applied" }, now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /title is required/);
});

test("computeAppend refuses a type outside the enum", () => {
  const r = computeAppend({ event: { type: "frobnicate", title: "x" }, now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /schema:/);
});

test("computeAppend refuses placeholder residue in prose", () => {
  const r = computeAppend({ event: { type: "drafted", title: "Note to [Company]" }, now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /placeholder/);
});

test("computeAppend refuses a private comp leak (current_base)", () => {
  // The narrow token guard — the feed is outbound, the private field never goes out.
  const r = computeAppend({
    event: { type: "system", title: "synced current_base into note" },
    now: NOW,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /private comp input/);
});

test("computeAppend allows a legitimate market-comp number in prose", () => {
  // "Offer received — $250K" is fine; only the literal current_base field is barred.
  const r = computeAppend({
    event: { type: "offer", title: "Offer received — $250K base @ Acme" },
    now: NOW,
  });
  assert.equal(r.ok, true);
});

test("every declared ACTIVITY_TYPE validates", () => {
  for (const type of ACTIVITY_TYPES) {
    const r = computeAppend({ event: { type, title: `event of ${type}` }, now: NOW });
    assert.equal(r.ok, true, `type ${type} should validate: ${r.error}`);
  }
});

// ---------------------------------------------------------------------------
// fs round-trip: append → read → list, dedupe, prune
// ---------------------------------------------------------------------------

test("appendActivity round-trips through JSONL and lists newest-first", () => {
  const root = tempRoot();
  try {
    appendActivity({ type: "sourced", title: "Sourced A", at: "2026-06-10T00:00:00Z" }, { root });
    appendActivity({ type: "applied", title: "Applied B", at: "2026-06-11T00:00:00Z" }, { root });
    const all = readActivity({ root });
    assert.equal(all.length, 2);
    const newestFirst = listActivity({ root });
    assert.equal(newestFirst[0].title, "Applied B");
    assert.equal(newestFirst[1].title, "Sourced A");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("appendActivity dedupes on content-derived id (idempotent backfill)", () => {
  const root = tempRoot();
  try {
    const evt = {
      type: "applied",
      title: "Applied — Acme",
      at: "2026-06-10T00:00:00Z",
      refs: { applicationId: "a1" },
    };
    const first = appendActivity(evt, { root });
    const second = appendActivity(evt, { root });
    assert.equal(first.deduped, false);
    assert.equal(second.deduped, true);
    assert.equal(readActivity({ root }).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readActivity skips a malformed trailing line without throwing", () => {
  const root = tempRoot();
  try {
    const res = appendActivity(
      { type: "system", title: "ok", at: "2026-06-10T00:00:00Z" },
      { root }
    );
    // Simulate a crash mid-append: a partial, un-parseable trailing line.
    appendFileSync(res.path, '{"id":"evt_partial","at":"2026-06-11', "utf8");
    const all = readActivity({ root });
    assert.equal(all.length, 1);
    assert.equal(all[0].title, "ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneActivity keeps the most recent max events", () => {
  const root = tempRoot();
  try {
    for (let i = 0; i < 6; i++) {
      appendActivity(
        {
          type: "system",
          title: `event ${i}`,
          at: `2026-06-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
        },
        { root }
      );
    }
    const res = pruneActivity({ root, max: 4 });
    assert.equal(res.kept, 4);
    assert.equal(res.dropped, 2);
    const kept = readActivity({ root });
    assert.equal(kept.length, 4);
    assert.equal(kept[0].title, "event 2"); // oldest two dropped
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("appendActivity auto-prunes once past the high-water mark", () => {
  const root = tempRoot();
  try {
    let prunedOnce = false;
    for (let i = 0; i < 12; i++) {
      const res = appendActivity(
        {
          type: "system",
          title: `auto ${i}`,
          at: `2026-06-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
        },
        { root, max: 4, pruneAt: 6 }
      );
      if (res.pruned) prunedOnce = true;
    }
    assert.ok(prunedOnce, "retention should have fired at least once");
    const kept = readActivity({ root });
    assert.ok(kept.length <= 6, `feed stays bounded by the ceiling (got ${kept.length})`);
    // The newest event is always preserved — retention only drops the oldest.
    assert.equal(kept.at(-1).title, "auto 11");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
