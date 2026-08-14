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
import { seedDemo } from "../src/core/db/demo-seed.mjs";
import { exportToTracker } from "../src/core/db/export-to-tracker.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";
import { candidateConfigGet } from "../src/core/db/verbs/candidate.mjs";
import { readJobDescriptionArtifact } from "../src/core/jobs/job-description.mjs";
import { computeSetupProgress } from "../src/core/onboarding/setup-progress.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import { validate } from "../src/core/profile/schema-validator.mjs";
import { loadTrackerData, validateTrackerData } from "../src/core/tracker/tracker-data.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const DEMO_DIR = join(REPO_ROOT, "examples/demo-workspace");
const SCHEMA_PATH = join(REPO_ROOT, "config/tracker.schema.json");

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-db-export-"));
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
  // examples/demo-workspace/tracker.json#sourced grew from 2 to 9 in 2a9bf4c
  // (stage-tiered demo enrichment) — this test never checks a hardcoded
  // shape beyond the round-trip + 0-schema-errors bar, so the count just
  // needs to track the fixture's current contents.
  assert.equal(data.sourced.length, 9);

  const { errors } = validateTrackerData(data);
  assert.deepEqual(errors, [], `verify-tracker must report 0 errors, got: ${errors.join("; ")}`);
});

test("the bundled demo and its db round-trip are schema-clean", () => {
  const repoRoot = tempRepo();
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const source = JSON.parse(readFileSync(join(DEMO_DIR, "tracker.json"), "utf8"));

  importFromTracker({ repoRoot, sourceDir: DEMO_DIR });
  const result = exportToTracker({ repoRoot });
  const exported = JSON.parse(readFileSync(result.trackerPath, "utf8"));

  const sourceResult = validate(source, schema);
  assert.ok(
    sourceResult.valid,
    `bundled demo must validate against tracker.schema.json, got: ${sourceResult.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`
  );

  const exportedResult = validate(exported, schema);
  assert.ok(
    exportedResult.valid,
    `exported demo must validate against tracker.schema.json, got: ${exportedResult.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`
  );
});

test("the bundled demo uses canonical application status values", () => {
  const tracker = JSON.parse(readFileSync(join(DEMO_DIR, "tracker.json"), "utf8"));
  const canonical = new Set([
    "reviewed-hold",
    "manual-apply",
    "applied",
    "screen",
    "interview",
    "assessment",
    "technical",
    "hiring-manager",
    "onsite",
    "final",
    "offer",
    "accepted",
    "rejected",
    "withdrawn",
  ]);

  for (const app of tracker.applications) {
    assert.ok(canonical.has(app.status), `${app.id} has noncanonical status ${app.status}`);
  }
});

test("the bundled demo never stores prose in path-owned document fields", () => {
  const tracker = JSON.parse(
    readFileSync(join(REPO_ROOT, "examples/demo-workspace/tracker.json"), "utf8")
  );
  for (const row of [...(tracker.applications || []), ...(tracker.sourced || [])]) {
    for (const key of ["jd", "resume", "coverLetter", "answers"]) {
      const value = row.artifacts?.[key];
      if (value == null) continue;
      assert.match(value, /^workspace\//, `${row.id} artifacts.${key} must be a workspace path`);
    }
  }
});

test("every bundled demo job seeds a readable complete or explicitly partial JD capture", () => {
  const repoRoot = tempRepo();
  seedDemo({ repoRoot, env: {}, today: "2026-08-14" });
  const tracker = JSON.parse(
    readFileSync(userPath({ repoRoot }, "workspace/tracker.json"), "utf8")
  );
  const rows = [
    ...tracker.applications.map((row) => ({ ...row, recordType: "application" })),
    ...tracker.sourced.map((row) => ({ ...row, recordType: "sourced" })),
  ];

  assert.equal(rows.length, 38);
  for (const row of rows) {
    assert.match(
      String(row.artifacts?.jd || ""),
      /^workspace\/jobs\/.+\.md$/,
      `${row.id} must point at a canonical job artifact`
    );
    const result = readJobDescriptionArtifact({
      repoRoot,
      env: {},
      source: row.recordType,
      id: row.id,
    });
    assert.match(result.artifact.completeness, /^(?:complete|partial)$/);
    assert.ok(result.artifact.bodyChars > 50, `${row.id} must have a useful captured body`);
  }

  const candidate = candidateConfigGet({ repoRoot, env: {} });
  assert.equal(candidate.profile.candidate.full_name, "Riley Chen");
  assert.equal(candidate.setup.readiness.search_ready, true);
  assert.equal(
    computeSetupProgress({ data: candidate, sourceResumePresent: true, keyConfigured: true })
      .complete,
    true
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
