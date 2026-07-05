import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { ALL_MIGRATIONS } from "../src/core/db/migrations.mjs";
import {
  candidateSetupInitialize,
  companyBoardResolutionGet,
  companyBoardResolutionListDue,
  companyBoardResolutionUpsert,
  companyProposalBatchGet,
  companyProposalBatchLatest,
  companyProposalBatchPatchState,
  companyProposalBatchPut,
} from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const cleanupRoots = [];
const NOW = new Date("2026-07-04T12:00:00.000Z");

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-company-discovery-cache-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function setupRepo() {
  const repoRoot = tempRepo();
  candidateSetupInitialize({ repoRoot });
  return { repoRoot, db: openDb({ repoRoot }) };
}

function tableSql(db, name) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
    ?.sql;
}

function indexNames(db, tableName) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name")
    .all(tableName)
    .map((row) => row.name);
}

function baseResolution(overrides = {}) {
  return {
    company_key: "acme-ai",
    company_name: "Acme AI",
    company_domain: "acme.example",
    careers_url: "https://acme.example/careers",
    job_board_url: "https://jobs.lever.co/acme",
    ats_provider: "lever",
    api_url: "https://api.lever.co/v0/postings/acme",
    confidence: "high",
    provenance: [{ source: "manual-domain-hint", url: "https://acme.example" }],
    first_resolved_at: "2026-06-01T12:00:00.000Z",
    last_verified_at: "2026-07-01T12:00:00.000Z",
    last_scan_result: {
      status: "matching-roles-found",
      matching_role_count: 2,
      last_error: null,
    },
    failure_count: 0,
    zero_job_count: 0,
    next_refresh_reason: null,
    status: "supported_ats",
    ...overrides,
  };
}

function putResolution(repoRoot, companyKey, overrides = {}) {
  return companyBoardResolutionUpsert({
    repoRoot,
    resolution: baseResolution({
      company_key: companyKey,
      company_name: companyKey
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" "),
      ...overrides,
    }),
  }).resolution;
}

test("migration 006 creates resolver cache and proposal tables with JSON constraints and query indexes", () => {
  const { db } = setupRepo();

  assert.equal(db.prepare("PRAGMA user_version").get().user_version, ALL_MIGRATIONS.at(-1).id);
  const migrationLog = db.prepare("SELECT id, name FROM _migrations WHERE id = ?").get(6);
  assert.equal(migrationLog.id, 6);
  assert.equal(migrationLog.name, "company-discovery-cache");

  const resolutionSql = tableSql(db, "company_board_resolutions");
  assert.match(resolutionSql, /data TEXT NOT NULL CHECK \(json_valid\(data\)\)/);
  assert.match(resolutionSql, /company_key TEXT GENERATED ALWAYS/);
  assert.match(resolutionSql, /zero_job_count INTEGER GENERATED ALWAYS/);

  const proposalSql = tableSql(db, "company_discovery_proposals");
  assert.match(proposalSql, /data TEXT NOT NULL CHECK \(json_valid\(data\)\)/);
  assert.match(proposalSql, /status TEXT GENERATED ALWAYS/);
  assert.match(proposalSql, /version INTEGER GENERATED ALWAYS/);
  assert.match(proposalSql, /created_at TEXT GENERATED ALWAYS/);

  assert.deepEqual(indexNames(db, "company_board_resolutions"), [
    "idx_company_board_resolutions_company_key",
    "idx_company_board_resolutions_due_refresh",
    "idx_company_board_resolutions_last_verified",
    "idx_company_board_resolutions_provider",
    "idx_company_board_resolutions_status",
  ]);
  assert.ok(
    indexNames(db, "company_discovery_proposals").includes(
      "idx_company_discovery_proposals_latest_pending"
    )
  );

  assert.throws(
    () =>
      db
        .prepare("INSERT INTO company_board_resolutions (id, data) VALUES (?, ?)")
        .run("bad-resolution", "{"),
    /CHECK constraint failed/
  );
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO company_discovery_proposals (id, data) VALUES (?, ?)")
        .run("bad-proposal", "{"),
    /CHECK constraint failed/
  );
});

test("company board resolution upsert/get round-trips the D-15 resolver cache fields", () => {
  const { repoRoot } = setupRepo();
  const resolution = baseResolution();

  const written = companyBoardResolutionUpsert({ repoRoot, resolution });
  assert.equal(written.ok, true);
  assert.deepEqual(written.resolution, resolution);

  const read = companyBoardResolutionGet({ repoRoot, companyKey: "acme-ai" });
  assert.equal(read.ok, true);
  assert.deepEqual(read.resolution, resolution);

  const byDomain = companyBoardResolutionGet({ repoRoot, companyDomain: "acme.example" });
  assert.equal(byDomain.ok, true);
  assert.deepEqual(byDomain.resolution, resolution);
});

test("company board resolution due list uses pinned refresh thresholds and reasons", () => {
  const { repoRoot } = setupRepo();

  putResolution(repoRoot, "fresh", {
    last_verified_at: "2026-06-25T12:00:00.000Z",
  });
  putResolution(repoRoot, "stale-ttl", {
    last_verified_at: "2026-06-19T11:59:59.000Z",
  });
  putResolution(repoRoot, "failure-threshold", {
    last_verified_at: "2026-07-01T12:00:00.000Z",
    failure_count: 2,
  });
  putResolution(repoRoot, "zero-jobs", {
    last_verified_at: "2026-07-01T12:00:00.000Z",
    zero_job_count: 2,
  });
  putResolution(repoRoot, "http-403", {
    last_scan_result: { status: "http-403" },
  });
  putResolution(repoRoot, "http-404", {
    last_scan_result: { status: "http-404" },
  });
  putResolution(repoRoot, "failed-extraction", {
    last_scan_result: { status: "failed-extraction" },
  });
  putResolution(repoRoot, "provider-change", {
    last_scan_result: { status: "provider-change" },
  });
  putResolution(repoRoot, "stored-reason", {
    next_refresh_reason: "explicit-refresh",
  });

  const due = companyBoardResolutionListDue({ repoRoot, now: NOW });
  assert.equal(due.ok, true);
  assert.deepEqual(
    due.resolutions.map((resolution) => [resolution.company_key, resolution.due_reason]),
    [
      ["failure-threshold", "resolver-failure-threshold"],
      ["failed-extraction", "failed-extraction"],
      ["http-403", "http-403"],
      ["http-404", "http-404"],
      ["provider-change", "provider-change"],
      ["stale-ttl", "stale-ttl"],
      ["stored-reason", "explicit-refresh"],
      ["zero-jobs", "zero-jobs-threshold"],
    ]
  );
});

test("proposal batches support get/latest pending reads and version-conflict patches", () => {
  const { repoRoot } = setupRepo();

  const older = {
    batchId: "batch-old",
    status: "pending",
    version: 1,
    created_at: "2026-07-04T10:00:00.000Z",
    proposals: [{ proposalId: "proposal-old", version: 1 }],
  };
  const newerPending = {
    batchId: "batch-new",
    status: "pending",
    version: 1,
    created_at: "2026-07-04T11:00:00.000Z",
    proposals: [{ proposalId: "proposal-new", version: 1 }],
  };
  const decided = {
    batchId: "batch-decided",
    status: "approved",
    version: 4,
    created_at: "2026-07-04T12:00:00.000Z",
    proposals: [{ proposalId: "proposal-decided", version: 4 }],
  };

  assert.deepEqual(companyProposalBatchPut({ repoRoot, batch: older }).batch, older);
  assert.deepEqual(companyProposalBatchPut({ repoRoot, batch: newerPending }).batch, newerPending);
  assert.deepEqual(companyProposalBatchPut({ repoRoot, batch: decided }).batch, decided);

  assert.deepEqual(companyProposalBatchGet({ repoRoot, batchId: "batch-old" }).batch, older);
  assert.deepEqual(companyProposalBatchLatest({ repoRoot, status: "pending" }).batch, newerPending);

  const patched = companyProposalBatchPatchState({
    repoRoot,
    batchId: "batch-new",
    expectedVersion: 1,
    status: "approved",
    patch: {
      decisions: [{ proposalId: "proposal-new", action: "approve-supported-ats" }],
    },
  });
  assert.equal(patched.ok, true);
  assert.equal(patched.batch.status, "approved");
  assert.equal(patched.batch.version, 2);
  assert.deepEqual(patched.batch.decisions, [
    { proposalId: "proposal-new", action: "approve-supported-ats" },
  ]);

  assert.throws(
    () =>
      companyProposalBatchPatchState({
        repoRoot,
        batchId: "batch-new",
        expectedVersion: 1,
        status: "rejected",
        patch: { decisions: [{ proposalId: "proposal-new", action: "reject" }] },
      }),
    (err) => err.code === "CONFLICT"
  );
  assert.deepEqual(
    companyProposalBatchGet({ repoRoot, batchId: "batch-new" }).batch,
    patched.batch
  );

  assert.equal(existsSync(userPath({ repoRoot }, "workspace/tracker.json")), false);
  assert.equal(existsSync(userPath({ repoRoot }, "workspace/activity.jsonl")), false);
  assert.equal(existsSync(userPath({ repoRoot }, "config/sourced-scan.json")), false);
});
