// tests/db-export.test.mjs — exportToTracker's round-trip correctness bar (M6
// decision 8): import -> export -> deep-equal (modulo key order — irrelevant
// to JS object equality anyway) against the source tracker.json, and the
// exported file must pass the same checks scripts/verify-tracker.mjs runs
// plus validate against config/tracker.schema.json.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "../src/core/db/connection.mjs";
import { exportToTracker } from "../src/core/db/export-to-tracker.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import { validate } from "../src/core/profile/schema-validator.mjs";
import { loadTrackerData, validateTrackerData } from "../src/core/tracker/tracker-data.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const DEMO_DIR = join(REPO_ROOT, "examples/demo-workspace");
const SCHEMA_PATH = join(REPO_ROOT, "config/tracker.schema.json");

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-db-export-"));
  cleanupRoots.push(repoRoot);
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

test("import -> export round-trips the demo workspace tracker.json exactly (modulo key order)", () => {
  const repoRoot = tempRepo();
  const source = JSON.parse(readFileSync(join(DEMO_DIR, "tracker.json"), "utf8"));

  importFromTracker({ repoRoot, sourceDir: DEMO_DIR });
  const result = exportToTracker({ repoRoot });

  assert.ok(existsSync(result.trackerPath));
  const exported = JSON.parse(readFileSync(result.trackerPath, "utf8"));

  // assert.deepEqual compares own enumerable key/value pairs regardless of
  // insertion order, so this IS the "modulo key order" comparison.
  assert.deepEqual(exported, source);
});

test("re-import + re-export is idempotent: exporting twice in a row is a byte-identical no-op", () => {
  const repoRoot = tempRepo();
  importFromTracker({ repoRoot, sourceDir: DEMO_DIR });
  const first = exportToTracker({ repoRoot });
  const firstText = readFileSync(first.trackerPath, "utf8");

  importFromTracker({ repoRoot, sourceDir: DEMO_DIR }); // re-import, same source
  const second = exportToTracker({ repoRoot });
  const secondText = readFileSync(second.trackerPath, "utf8");

  assert.equal(secondText, firstText, "re-import + re-export must be byte-identical (idempotent)");
});

test("the exported tracker.json passes the same checks scripts/verify-tracker.mjs runs (0 errors)", () => {
  const repoRoot = tempRepo();
  importFromTracker({ repoRoot, sourceDir: DEMO_DIR });
  const result = exportToTracker({ repoRoot });

  const data = loadTrackerData(result.trackerPath);
  assert.equal(data.apps.length, 29);
  assert.equal(data.sourced.length, 2);

  const { errors } = validateTrackerData(data);
  assert.deepEqual(errors, [], `verify-tracker must report 0 errors, got: ${errors.join("; ")}`);
});

// examples/demo-workspace/tracker.json itself already carries a handful of
// pre-existing tracker.schema.json violations (some communications[].channel
// values use the applications/sourced channel vocabulary — "referral"/"board"/
// "recruiter" — instead of the communications-only enum). That's a demo-data
// quality issue that predates this DB layer and is out of scope here (fixing
// examples/demo-workspace/tracker.json is not part of the M6 spec). What
// matters for the DB layer's correctness is that round-tripping through the
// db introduces NO NEW schema violations beyond what the source already had.
test("round-tripping through the db introduces no NEW tracker.schema.json violations vs the source", () => {
  const repoRoot = tempRepo();
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const source = JSON.parse(readFileSync(join(DEMO_DIR, "tracker.json"), "utf8"));

  importFromTracker({ repoRoot, sourceDir: DEMO_DIR });
  const result = exportToTracker({ repoRoot });
  const exported = JSON.parse(readFileSync(result.trackerPath, "utf8"));

  const sourceErrors = validate(source, schema).errors.map((e) => `${e.path}: ${e.message}`);
  const exportedErrors = validate(exported, schema).errors.map((e) => `${e.path}: ${e.message}`);
  assert.deepEqual(
    exportedErrors.sort(),
    sourceErrors.sort(),
    "export must not introduce or fix any schema violations relative to the source — it's a byte-shape-compatible round-trip, not a validator"
  );
});

// A clean, schema-conformant synthetic fixture proves the DB layer's OWN
// output shape validates against config/tracker.schema.json end to end, once
// the input data itself is clean.
test("a schema-clean source round-trips to schema-clean output", () => {
  const repoRoot = tempRepo();
  const sourceDir = join(repoRoot, "clean-fixture");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(
    join(sourceDir, "tracker.json"),
    JSON.stringify(
      {
        meta: { lastUpdatedAt: "2026-01-01T00:00:00.000Z", version: 1 },
        applications: [
          {
            id: "app-1",
            company: "Acme",
            role: "Staff Engineer",
            status: "interview",
            channel: "referral",
          },
        ],
        sourced: [],
        sources: [],
        communications: [
          {
            id: "comm-1",
            applicationId: "app-1",
            status: "waiting",
            summary: "Waiting on next round.",
            channel: "email",
          },
        ],
      },
      null,
      2
    )
  );

  importFromTracker({ repoRoot, sourceDir });
  const result = exportToTracker({ repoRoot });
  const exported = JSON.parse(readFileSync(result.trackerPath, "utf8"));

  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const { valid, errors } = validate(exported, schema);
  assert.ok(
    valid,
    `exported tracker.json must validate against tracker.schema.json, got: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`
  );
});

test("exportToTracker also (re)writes workspace/activity.jsonl next to tracker.json", () => {
  const repoRoot = tempRepo();
  importFromTracker({ repoRoot, sourceDir: DEMO_DIR });
  const result = exportToTracker({ repoRoot });

  assert.ok(existsSync(result.activityPath));
  const expectedActivityPath = userPath({ repoRoot }, "workspace/activity.jsonl");
  assert.equal(result.activityPath, expectedActivityPath);
});
