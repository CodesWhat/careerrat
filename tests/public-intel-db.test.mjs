import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { ALL_MIGRATIONS } from "../src/core/db/migrations.mjs";
import { candidateConfigPatch, candidateSetupInitialize } from "../src/core/db/verbs.mjs";

const cleanupRoots = [];
const NOW = new Date("2026-07-06T12:00:00.000Z");

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-public-intel-db-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

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

async function publicIntelVerbs() {
  return import("../src/core/db/verbs/public-intel.mjs");
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration 009 creates separate public-intel tables with JSON constraints and indexes", () => {
  const { db } = setupRepo();

  assert.ok(ALL_MIGRATIONS.some(({ id, name }) => id === 9 && name === "public-intel"));
  const migrationLog = db.prepare("SELECT id, name FROM _migrations WHERE id = ?").get(9);
  assert.deepEqual({ ...migrationLog }, { id: 9, name: "public-intel" });

  for (const table of [
    "public_company_intel",
    "public_board_intel",
    "public_careers_pages",
    "public_intel_review_items",
    "public_sync_preferences",
  ]) {
    const sql = tableSql(db, table);
    assert.ok(sql, `expected ${table} to exist`);
    assert.match(sql, /data TEXT NOT NULL CHECK \(json_valid\(data\)\)/);
    assert.match(sql, /updated_at TEXT GENERATED ALWAYS/);
    assert.throws(
      () => db.prepare(`INSERT INTO ${table} (id, data) VALUES (?, ?)`).run("bad", "{"),
      /CHECK constraint failed/,
      `${table} must reject invalid JSON`
    );
  }

  assert.match(tableSql(db, "public_company_intel"), /company_key TEXT GENERATED ALWAYS/);
  assert.match(tableSql(db, "public_company_intel"), /company_domain TEXT GENERATED ALWAYS/);
  assert.match(tableSql(db, "public_board_intel"), /ats_provider TEXT GENERATED ALWAYS/);
  assert.match(tableSql(db, "public_careers_pages"), /extraction_status TEXT GENERATED ALWAYS/);
  assert.match(tableSql(db, "public_intel_review_items"), /version INTEGER GENERATED ALWAYS/);
  assert.match(tableSql(db, "public_sync_preferences"), /enabled INTEGER GENERATED ALWAYS/);

  assert.ok(indexNames(db, "public_company_intel").includes("idx_public_company_intel_domain"));
  assert.ok(indexNames(db, "public_board_intel").includes("idx_public_board_intel_provider"));
  assert.ok(indexNames(db, "public_careers_pages").includes("idx_public_careers_pages_status"));
  assert.ok(
    indexNames(db, "public_intel_review_items").includes("idx_public_intel_review_items_status")
  );
});

test("public-intel verbs are exported through the canonical DB barrels", async () => {
  const direct = await publicIntelVerbs();
  const barrel = await import("../src/core/db/verbs.mjs");
  for (const name of [
    "publicBoardIntelUpsert",
    "publicCareersPageUpsert",
    "publicCompanyIntelUpsert",
    "publicIntelSyncPreview",
    "publicSyncPreferenceGet",
    "publicSyncPreferenceSet",
  ]) {
    assert.equal(typeof direct[name], "function", `direct export ${name}`);
    assert.equal(typeof barrel[name], "function", `barrel export ${name}`);
  }
});

test("public-intel verbs round-trip public metadata and keep sync preview scoped to public tables", async () => {
  const { repoRoot } = setupRepo();
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      candidate: { full_name: "Private Candidate", domain: "identity automation" },
      compensation: { current_base: 171234, minimum_base: 206789, target_base: 231234 },
    },
  });

  const {
    publicBoardIntelUpsert,
    publicCareersPageUpsert,
    publicCompanyIntelUpsert,
    publicIntelSyncPreview,
  } = await publicIntelVerbs();

  publicCompanyIntelUpsert({
    repoRoot,
    record: {
      id: "company-acme",
      companyKey: "acme-ai",
      companyName: "Acme AI",
      companyDomain: "acme.example",
      careersUrl: "https://acme.example/careers",
      provider: "custom",
      confidence: "medium",
      provenance: [{ source: "public-page-fetch", url: "https://acme.example" }],
      firstSeenAt: NOW.toISOString(),
      lastVerifiedAt: NOW.toISOString(),
      freshnessStatus: "fresh",
    },
    now: NOW,
  });
  publicBoardIntelUpsert({
    repoRoot,
    record: {
      id: "board-acme",
      companyKey: "acme-ai",
      boardUrl: "https://jobs.lever.co/acme",
      atsProvider: "lever",
      sourceKind: "supported_ats",
      confidence: "high",
      provenance: [{ source: "resolver", url: "https://jobs.lever.co/acme" }],
    },
    now: NOW,
  });
  publicCareersPageUpsert({
    repoRoot,
    page: {
      id: "page-acme",
      companyKey: "acme-ai",
      url: "https://acme.example/careers",
      extractionStatus: "metadata_found",
      inputHash: "sha256-public-page",
      confidence: "medium",
      publicSignals: ["jobs-link", "ats-link"],
      provenance: [{ source: "public-page-fetch", url: "https://acme.example/careers" }],
    },
    now: NOW,
  });

  const preview = publicIntelSyncPreview({ repoRoot });
  assert.equal(preview.ok, true);
  assert.equal(preview.data.companies.length, 1);
  assert.equal(preview.data.boards.length, 1);
  assert.equal(preview.data.careersPages.length, 1);

  const serialized = JSON.stringify(preview);
  for (const token of [
    "Private Candidate",
    "current_base",
    "minimum_base",
    "target_base",
    "fitScore",
    "trackerId",
    "applicationId",
    "privateNote",
    "workspace/",
    "/Users/",
  ]) {
    assert.equal(serialized.includes(token), false, `sync preview leaked ${token}`);
  }
});

test("public sync preference defaults on and persists opt-out locally", async () => {
  const { repoRoot } = setupRepo();
  const { publicSyncPreferenceGet, publicSyncPreferenceSet } = await publicIntelVerbs();

  assert.deepEqual(publicSyncPreferenceGet({ repoRoot }).preference, {
    enabled: true,
    source: "default",
    updatedAt: null,
  });

  const saved = publicSyncPreferenceSet({ repoRoot, enabled: false, now: NOW });
  assert.equal(saved.ok, true);
  assert.deepEqual(publicSyncPreferenceGet({ repoRoot }).preference, {
    enabled: false,
    source: "user",
    updatedAt: NOW.toISOString(),
  });
});
