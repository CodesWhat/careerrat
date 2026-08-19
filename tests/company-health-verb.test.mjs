// tests/company-health-verb.test.mjs — coverage for the company-health
// skill's STEP 5 write path (src/core/db/verbs/company-health.mjs): the
// validateCompanyHealth guard (rating/provenance enums, asOf format, fitDelta
// sign/floor, required fields, the current_base privacy leak) and
// companyHealthSet's transactional write (row replace + meta bump + activity
// event) on both an applications[] row and a sourced[] row. Mirrors
// tests/db-verbs.test.mjs's tempRepo()/activityCount()/activityRow()
// conventions rather than importing them, since this file owns its own
// fixtures.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { appUpsert } from "../src/core/db/verbs/app.mjs";
import { companyHealthSet, validateCompanyHealth } from "../src/core/db/verbs/company-health.mjs";
import { NotFoundError } from "../src/core/db/verbs/shared.mjs";
import { sourcedUpsertBatch } from "../src/core/db/verbs/sourced.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-company-health-verb-"));
  cleanupRoots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function activityCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM activity_events").get().n;
}

function activityRow(db, id) {
  const row = db.prepare("SELECT id, type, data FROM activity_events WHERE id = ?").get(id);
  return row ? { id: row.id, type: row.type, data: JSON.parse(row.data) } : null;
}

// A hospital-system fixture (deliberately non-tech, matches the repo's
// domain-neutral convention) that satisfies every validateCompanyHealth
// requirement out of the box; individual tests override just the field
// they're exercising.
function validHealthPayload(overrides = {}) {
  return {
    rating: "watch",
    forFunction: "clinical staffing",
    asOf: "2026-08-10",
    provenance: "built-from-data",
    dimensions: {
      layoffRisk: { level: "elevated", note: "Hiring freeze for non-clinical roles." },
      hiringMomentum: { level: "steady" },
    },
    crossCut: ["stability"],
    fitDelta: -3,
    rationale: "A hiring freeze was announced for non-clinical roles at this hospital system.",
    signals: [
      {
        source: "Local news",
        date: "2026-08-01",
        summary: "The hospital system announced a hiring freeze for non-clinical roles.",
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// companyHealthSet — happy path
// ---------------------------------------------------------------------------

test("companyHealthSet writes the full companyHealth object onto an applications row and logs a research activity event", () => {
  const repoRoot = tempRepo();
  appUpsert({
    repoRoot,
    env: {},
    row: {
      id: "app-riverside",
      company: "Riverside Health",
      role: "Registered Nurse",
      status: "reviewed-hold",
    },
  });
  const db = openDb({ repoRoot, env: {} });
  const beforeActivity = activityCount(db);

  const payload = validHealthPayload();
  const result = companyHealthSet({
    repoRoot,
    env: {},
    id: "app-riverside",
    companyHealth: payload,
  });

  assert.equal(result.table, "applications");
  assert.equal(result.id, "app-riverside");

  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-riverside");
  const stored = JSON.parse(row.data);
  assert.deepEqual(stored.companyHealth, payload);

  assert.equal(activityCount(db), beforeActivity + 1);
  const event = activityRow(db, result.event.id);
  assert.ok(event, "companyHealthSet must log an activity event");
  assert.equal(event.type, "research");
  assert.equal(event.data.title, "Company health: Riverside Health, watch");
  assert.equal(event.data.summary, "clinical staffing-scoped as of 2026-08-10 (built-from-data).");
  assert.deepEqual(event.data.refs, {
    company: "Riverside Health",
    role: "Registered Nurse",
    applicationId: "app-riverside",
  });
  assert.deepEqual(event.data.tags, ["health:watch", "operation:company-health:rate"]);
});

test("companyHealthSet writes onto a sourced row and refs sourcedId instead of applicationId", () => {
  const repoRoot = tempRepo();
  sourcedUpsertBatch({
    repoRoot,
    env: {},
    rows: [
      {
        id: "sourced-riverside",
        company: "Riverside Health",
        role: "Registered Nurse",
        status: "sourced",
      },
    ],
  });
  const db = openDb({ repoRoot, env: {} });

  const payload = validHealthPayload({ rating: "risky" });
  const result = companyHealthSet({
    repoRoot,
    env: {},
    id: "sourced-riverside",
    companyHealth: payload,
  });

  assert.equal(result.table, "sourced");
  const row = db.prepare("SELECT data FROM sourced WHERE id = ?").get("sourced-riverside");
  const stored = JSON.parse(row.data);
  assert.deepEqual(stored.companyHealth, payload);

  const event = activityRow(db, result.event.id);
  assert.equal(event.type, "research");
  assert.equal(event.data.title, "Company health: Riverside Health, risky");
  assert.deepEqual(event.data.refs, {
    company: "Riverside Health",
    role: "Registered Nurse",
    sourcedId: "sourced-riverside",
  });
});

test("companyHealthSet defaults fitDelta to 0 and normalizes crossCut/signals when omitted", () => {
  const repoRoot = tempRepo();
  appUpsert({
    repoRoot,
    env: {},
    row: { id: "app-riverside", company: "Riverside Health", role: "Registered Nurse" },
  });

  const payload = {
    rating: "healthy",
    forFunction: "clinical staffing",
    asOf: "2026-08-10",
    provenance: "needs-more-info",
    dimensions: {},
    rationale: "No concerning signals found in public reporting.",
  };
  const result = companyHealthSet({
    repoRoot,
    env: {},
    id: "app-riverside",
    companyHealth: payload,
  });

  assert.equal(result.companyHealth.fitDelta, 0);
  assert.deepEqual(result.companyHealth.crossCut, []);
  assert.deepEqual(result.companyHealth.signals, []);
});

test("companyHealthSet rejects an unknown id with a NotFoundError", () => {
  const repoRoot = tempRepo();
  assert.throws(
    () =>
      companyHealthSet({
        repoRoot,
        env: {},
        id: "does-not-exist",
        companyHealth: validHealthPayload(),
      }),
    (err) => err instanceof NotFoundError && err.code === "NOT_FOUND"
  );
});

// ---------------------------------------------------------------------------
// validateCompanyHealth — rejection matrix
// ---------------------------------------------------------------------------

const REJECTION_CASES = [
  {
    name: "bad rating",
    overrides: { rating: "excellent" },
    code: "BAD_HEALTH_RATING",
  },
  {
    name: "bad provenance",
    overrides: { provenance: "vibes" },
    code: "BAD_HEALTH_PROVENANCE",
  },
  {
    name: "missing forFunction",
    overrides: { forFunction: "" },
    code: "BAD_HEALTH_FUNCTION",
  },
  {
    name: "bad asOf (not an ISO date)",
    overrides: { asOf: "August 10th" },
    code: "BAD_HEALTH_AS_OF",
  },
  {
    name: "missing rationale",
    overrides: { rationale: "" },
    code: "BAD_HEALTH_RATIONALE",
  },
  {
    name: "missing dimensions object",
    overrides: { dimensions: null },
    code: "BAD_HEALTH_DIMENSIONS",
  },
  {
    // The contract shape is { level, note, functionHit?, trend? } — a flat
    // string level (the pre-contract legacy form) is rejected, not coerced.
    name: "a flat string dimension entry",
    overrides: { dimensions: { layoffRisk: "elevated" } },
    code: "BAD_HEALTH_DIMENSION_ENTRY",
  },
  {
    name: "crossCut not an array",
    overrides: { crossCut: "stability" },
    code: "BAD_HEALTH_CROSS_CUT",
  },
  {
    name: "signals not an array",
    overrides: { signals: "a news article" },
    code: "BAD_HEALTH_SIGNALS",
  },
  {
    name: "positive fitDelta",
    overrides: { fitDelta: 5 },
    code: "BAD_HEALTH_FIT_DELTA",
  },
  {
    name: "fitDelta below the -20 floor",
    overrides: { fitDelta: -21 },
    code: "BAD_HEALTH_FIT_DELTA",
  },
];

for (const { name, overrides, code } of REJECTION_CASES) {
  test(`validateCompanyHealth rejects ${name}`, () => {
    assert.throws(
      () => validateCompanyHealth(validHealthPayload(overrides)),
      (err) => err.code === code
    );
  });
}

test("validateCompanyHealth requires a companyHealth object", () => {
  assert.throws(
    () => validateCompanyHealth(null),
    (err) => err.code === "BAD_COMPANY_HEALTH"
  );
  assert.throws(
    () => validateCompanyHealth([1, 2, 3]),
    (err) => err.code === "BAD_COMPANY_HEALTH"
  );
});

test("validateCompanyHealth refuses a current_base token anywhere in the payload", () => {
  assert.throws(
    () =>
      validateCompanyHealth(
        validHealthPayload({
          rationale: "Candidate's current_base of $185,000 is not disclosed publicly.",
        })
      ),
    (err) => err.code === "HEALTH_COMP_LEAK"
  );
  // The leak guard scans the whole serialized payload, not just rationale —
  // a stray current_base token anywhere (e.g. buried in a signal summary)
  // must be caught too.
  assert.throws(
    () =>
      validateCompanyHealth(
        validHealthPayload({
          signals: [{ source: "note", summary: "current_base leaked into a signal note" }],
        })
      ),
    (err) => err.code === "HEALTH_COMP_LEAK"
  );
});

test("companyHealthSet propagates validateCompanyHealth's rejection before touching the row", () => {
  const repoRoot = tempRepo();
  appUpsert({
    repoRoot,
    env: {},
    row: { id: "app-riverside", company: "Riverside Health", role: "Registered Nurse" },
  });
  const db = openDb({ repoRoot, env: {} });
  const beforeActivity = activityCount(db);

  assert.throws(
    () =>
      companyHealthSet({
        repoRoot,
        env: {},
        id: "app-riverside",
        companyHealth: validHealthPayload({ rating: "excellent" }),
      }),
    (err) => err.code === "BAD_HEALTH_RATING"
  );

  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-riverside");
  assert.equal(JSON.parse(row.data).companyHealth, undefined);
  assert.equal(activityCount(db), beforeActivity);
});
