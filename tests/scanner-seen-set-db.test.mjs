// tests/scanner-seen-set-db.test.mjs
// RED coverage for Phase 6 DB-first scanner dedupe. When SQLite exists,
// runSourcedScan() must build seen sets from DB application/sourced rows, not
// from the generated workspace/tracker.json compatibility export.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { runSourcedScan } from "../scripts/scan-sourced.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { appUpsert, companyAtsUpsert, sourcedUpsertBatch } from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const DB_APP_DUPLICATE_URL = "https://jobs.lever.co/acme/db-app-dupe";
const DB_SOURCED_DUPLICATE_URL = "https://jobs.lever.co/acme/db-sourced-dupe";
const TRACKER_ONLY_URL = "https://jobs.lever.co/acme/tracker-only-dupe";
const NEW_URL = "https://jobs.lever.co/acme/new-role";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-scanner-seen-set-"));
  cleanupRoots.push(repoRoot);
  mkdirSync(join(repoRoot, "workspace"), { recursive: true });
  return repoRoot;
}

function seedDbState(repoRoot) {
  openDb({ repoRoot });
  companyAtsUpsert({
    repoRoot,
    entry: { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
  });
  appUpsert({
    repoRoot,
    row: {
      id: "app-db-dupe",
      company: "Acme",
      role: "Director of IT",
      status: "applied",
      channel: "board",
      link: DB_APP_DUPLICATE_URL,
      fitScore: 80,
      fitBucket: "high",
    },
  });
  sourcedUpsertBatch({
    repoRoot,
    rows: [
      {
        id: "sourced-db-dupe",
        company: "Acme",
        role: "Principal Architect",
        status: "sourced",
        source: "scanner",
        channel: "board",
        link: DB_SOURCED_DUPLICATE_URL,
        loc: "Remote",
        base: "verify",
        fitScore: 82,
        fitBucket: "high",
        fitBasis: "triage",
        gate: "likely-keep",
        sourcedAt: "2026-07-05T00:00:00Z",
        updatedAt: "2026-07-05T00:00:00Z",
        artifacts: {},
      },
    ],
  });
}

function writeContradictoryTrackerExport(repoRoot) {
  const trackerPath = userPath({ repoRoot }, "workspace/tracker.json");
  mkdirSync(dirname(trackerPath), { recursive: true });
  writeFileSync(
    trackerPath,
    JSON.stringify(
      {
        meta: {},
        applications: [],
        sourced: [
          {
            id: "tracker-only",
            company: "Acme",
            role: "Tracker Export Only",
            status: "sourced",
            channel: "board",
            link: TRACKER_ONLY_URL,
            fitScore: 90,
            fitBucket: "high",
          },
        ],
        sources: [],
        communications: [],
      },
      null,
      2
    )
  );
}

function leverFetchStub() {
  return async (url) => {
    if (String(url).includes("api.lever.co")) {
      return new Response(
        JSON.stringify([
          {
            text: "Director of IT",
            hostedUrl: DB_APP_DUPLICATE_URL,
            categories: { location: "Remote" },
            descriptionBodyPlain: "Duplicate already captured in the SQLite applications table.",
          },
          {
            text: "Tracker Export Only",
            hostedUrl: TRACKER_ONLY_URL,
            categories: { location: "Remote" },
            descriptionBodyPlain: "This URL exists only in workspace/tracker.json.",
          },
          {
            text: "New Platform Lead",
            hostedUrl: NEW_URL,
            categories: { location: "Remote" },
            descriptionBodyPlain: "A genuinely new supported ATS role.",
          },
        ]),
        { status: 200 }
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
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

test("runSourcedScan: DB mode seen sets use DB rows and ignore tracker export rows", async () => {
  const repoRoot = tempRepo();
  seedDbState(repoRoot);
  writeContradictoryTrackerExport(repoRoot);

  const summary = await runSourcedScan({
    repoRoot,
    env: {},
    fetchImpl: leverFetchStub(),
    write: false,
  });

  const keptUrls = new Set(summary.offers.map((offer) => offer.url));

  assert.equal(summary.scanned, 3);
  assert.equal(summary.duplicates, 1);
  assert.equal(keptUrls.has(DB_APP_DUPLICATE_URL), false, "DB application URL is already seen");
  assert.equal(
    keptUrls.has(TRACKER_ONLY_URL),
    true,
    "tracker-export-only URL must not be seen when DB exists"
  );
  assert.equal(keptUrls.has(NEW_URL), true, "new ATS URL should be kept");
});
