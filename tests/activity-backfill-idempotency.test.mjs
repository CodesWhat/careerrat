// tests/activity-backfill-idempotency.test.mjs
//
// Regression coverage for the cross-version dedupe bug: `eventId()` used to hash
// the raw presentation `title`, so a copy-only rewrite of that prose (the em-dash
// sweep — see activity-backfill.mjs / db/verbs/*.mjs) changed the id computed for
// an otherwise-identical logical event. A user who backfilled on an older build
// and re-ran `careerrat activity backfill --write` after upgrading would get a
// fresh id for every backfilled event, miss the dedupe check, and double their
// entire backfilled history.
//
// This suite pins two things `tests/activity-log.test.mjs` didn't cover:
//   1. eventId() is stable across the specific separator rewrites the sweep made
//      (em dash -> colon, em dash -> comma).
//   2. End-to-end: seed workspace/activity.jsonl with events in the PRE-sweep
//      title format (as an older build would have written them, with ids that do
//      NOT match what the current code would compute), then run the CURRENT
//      deriveActivityEvents() + appendActivity() over equivalent tracker data —
//      the same replay `careerrat activity backfill --write` performs on
//      upgrade — and assert nothing duplicates.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { deriveActivityEvents } from "../src/core/tracker/activity-backfill.mjs";
import {
  activityAbsPath,
  appendActivity,
  eventId,
  readActivity,
} from "../src/core/tracker/activity-log.mjs";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "careerrat-activity-backfill-"));
}

// ---------------------------------------------------------------------------
// eventId() is stable across the sweep's specific separator rewrites.
// ---------------------------------------------------------------------------

test("eventId is unchanged when an em dash becomes a colon (activity-backfill.mjs sweep)", () => {
  const pre = eventId({
    at: "2026-06-01T12:00:00.000Z",
    type: "applied",
    title: "Submitted application — Acme",
    refs: { applicationId: "app-1" },
  });
  const post = eventId({
    at: "2026-06-01T12:00:00.000Z",
    type: "applied",
    title: "Submitted application: Acme",
    refs: { applicationId: "app-1" },
  });
  assert.equal(pre, post);
});

test("eventId is unchanged when an em dash becomes a comma (company-health.mjs sweep)", () => {
  const pre = eventId({
    at: "2026-06-01T12:00:00.000Z",
    type: "research",
    title: "Company health: Acme — healthy",
    refs: { company: "Acme" },
  });
  const post = eventId({
    at: "2026-06-01T12:00:00.000Z",
    type: "research",
    title: "Company health: Acme, healthy",
    refs: { company: "Acme" },
  });
  assert.equal(pre, post);
});

test("eventId still distinguishes genuinely different titles (not over-collapsed)", () => {
  const a = eventId({
    at: "2026-06-01T12:00:00.000Z",
    type: "applied",
    title: "Submitted application: Acme",
    refs: { applicationId: "app-1" },
  });
  const b = eventId({
    at: "2026-06-01T12:00:00.000Z",
    type: "applied",
    title: "Submitted application: Widgetco",
    refs: { applicationId: "app-1" },
  });
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// End-to-end: backfill replay over a PRE-sweep activity.jsonl must not duplicate.
// ---------------------------------------------------------------------------

// Same shape deriveActivityEvents() consumes: two applications, each with an
// appliedAt date and an inbound comm, so both an "applied" event and either a
// "message" or a status event get derived per app (mirrors the applied/inbound
// paths that actually produce em-dash-affected titles pre-sweep).
const trackerData = {
  applications: [
    {
      id: "app-1",
      company: "Acme",
      role: "Staff PM",
      appliedAt: "2026-06-01",
      status: "applied",
      channel: "referral",
      link: "https://acme.example/careers/123",
    },
    {
      id: "app-2",
      company: "Beta",
      role: "Engineer",
      appliedAt: "2026-05-01",
      status: "phone screen",
      channel: "cold apply",
      link: "https://beta.example/jobs/9",
    },
  ],
  communications: [
    {
      applicationId: "app-1",
      company: "Acme",
      role: "Staff PM",
      subject: "Application received",
      messages: [
        {
          at: "2026-06-05T09:00:00Z",
          direction: "inbound",
          summary: "Thanks for applying, we'll be in touch.",
          subject: "Application received",
        },
      ],
    },
    {
      applicationId: "app-2",
      company: "Beta",
      role: "Engineer",
      subject: "Interview scheduling",
      messages: [
        {
          at: "2026-05-10T14:00:00Z",
          direction: "inbound",
          summary: "Let's set up a phone screen.",
          subject: "Interview scheduling",
        },
      ],
    },
  ],
};

// The CURRENT code's output (post-sweep titles: colon separators). This is
// exactly what `careerrat activity backfill --write` derives today.
const currentDerived = deriveActivityEvents(trackerData);

// The same four logical events, but written the way a PRE-sweep build would
// have: em-dash titles, and — critically — ids that do NOT match what the
// current eventId() would compute for either the old or the new title. This
// simulates an on-disk feed from before the fix: dedupe must not be able to
// lean on stored-id equality at all here, only on recomputed content.
function preSweepFixtureLines() {
  return [
    {
      id: "evt_legacy_app1_applied",
      at: "2026-06-01T12:00:00.000Z",
      type: "applied",
      actor: "agent",
      title: "Submitted application — Acme",
      summary: "Staff PM · via referral",
      refs: {
        applicationId: "app-1",
        company: "Acme",
        role: "Staff PM",
        url: "https://acme.example/careers/123",
      },
      tone: "info",
    },
    {
      id: "evt_legacy_app1_reply",
      at: "2026-06-05T09:00:00.000Z",
      type: "message",
      actor: "world",
      title: "Acme replied",
      summary: "Thanks for applying, we'll be in touch.",
      refs: { applicationId: "app-1", company: "Acme", role: "Staff PM" },
      tone: "info",
    },
    {
      id: "evt_legacy_app2_applied",
      at: "2026-05-01T12:00:00.000Z",
      type: "applied",
      actor: "agent",
      title: "Submitted application — Beta",
      summary: "Engineer · via cold apply",
      refs: {
        applicationId: "app-2",
        company: "Beta",
        role: "Engineer",
        url: "https://beta.example/jobs/9",
      },
      tone: "info",
    },
    {
      id: "evt_legacy_app2_interview",
      at: "2026-05-10T14:00:00.000Z",
      type: "interview",
      actor: "world",
      title: "Interview stage — Beta",
      summary: "Advanced past application.",
      refs: {
        applicationId: "app-2",
        company: "Beta",
        role: "Engineer",
        url: "https://beta.example/jobs/9",
      },
      tone: "info",
    },
  ];
}

test("sanity: the sweep's rewrite is reflected in today's derived titles", () => {
  const titles = currentDerived.map((e) => e.title);
  assert.ok(titles.includes("Submitted application: Acme"));
  assert.ok(titles.includes("Submitted application: Beta"));
  assert.ok(titles.includes("Interview stage: Beta"));
  assert.ok(titles.includes("Acme replied"));
  assert.equal(currentDerived.length, 4);
});

test("backfill replay over a pre-sweep feed is idempotent (the bug this suite exists for)", () => {
  const root = tempRoot();
  try {
    const path = activityAbsPath(root);
    const lines = preSweepFixtureLines();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${lines.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
    assert.equal(readActivity({ root }).length, 4, "fixture seeded");

    // This is the exact replay `careerrat activity backfill --write` performs:
    // append every currently-derived event (oldest-first, matching the CLI).
    const results = [...currentDerived].reverse().map((event) => appendActivity(event, { root }));

    for (const res of results) {
      assert.equal(res.ok, true);
    }
    const dedupedCount = results.filter((r) => r.deduped).length;
    assert.equal(dedupedCount, 4, "every derived event should match an existing pre-sweep line");

    const after = readActivity({ root });
    assert.equal(after.length, 4, "no duplicates were appended");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
