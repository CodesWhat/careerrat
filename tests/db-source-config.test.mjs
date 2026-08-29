import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "../src/core/db/connection.mjs";
import {
  candidateSetupInitialize,
  companyAtsRemove,
  companyAtsUpsert,
  publicSearchSourceUpsert,
  sourceConfigGet,
  sourceConfigPut,
} from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-db-source-config-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("company ATS verbs keep sourced-scan config in SQLite without writing compatibility JSON", () => {
  const repoRoot = tempRepo();
  candidateSetupInitialize({ repoRoot });

  const initial = sourceConfigGet({ repoRoot, name: "sourced-scan" });
  assert.deepEqual(initial.data.tracked_companies, []);

  const added = companyAtsUpsert({
    repoRoot,
    entry: { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
  });
  assert.equal(added.status, "added");
  assert.equal(added.total, 1);

  const duplicate = companyAtsUpsert({
    repoRoot,
    entry: { name: "ACME", careers_url: "https://jobs.lever.co/acme" },
  });
  assert.equal(duplicate.status, "already-tracked");
  assert.equal(duplicate.total, 1);

  const afterAdd = sourceConfigGet({ repoRoot, name: "sourced-scan" });
  assert.deepEqual(afterAdd.data.tracked_companies, [
    { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
  ]);
  assert.equal(existsSync(userPath({ repoRoot }, "config/sourced-scan.json")), false);

  const removed = companyAtsRemove({ repoRoot, name: "acme" });
  assert.equal(removed.status, "removed");
  assert.deepEqual(sourceConfigGet({ repoRoot, name: "sourced-scan" }).data.tracked_companies, []);
});

test("VER-04 company ATS source-config owner does not write generated tracker exports", () => {
  const repoRoot = tempRepo();
  candidateSetupInitialize({ repoRoot });
  const trackerPath = userPath({ repoRoot }, "workspace/tracker.json");
  const trackerHtmlPath = userPath({ repoRoot }, "workspace/tracker.html");
  const activityPath = userPath({ repoRoot }, "workspace/activity.jsonl");

  const added = companyAtsUpsert({
    repoRoot,
    entry: { name: "Owner Boundary Co", careers_url: "https://jobs.lever.co/owner-boundary" },
  });
  assert.equal(added.status, "added");
  assert.deepEqual(sourceConfigGet({ repoRoot, name: "sourced-scan" }).data.tracked_companies, [
    { name: "Owner Boundary Co", careers_url: "https://jobs.lever.co/owner-boundary" },
  ]);

  const duplicate = companyAtsUpsert({
    repoRoot,
    entry: { name: "owner boundary co", careers_url: "https://jobs.lever.co/owner-boundary" },
  });
  assert.equal(duplicate.status, "already-tracked");

  assert.equal(existsSync(userPath({ repoRoot }, "config/sourced-scan.json")), false);
  assert.equal(existsSync(trackerPath), false);
  assert.equal(existsSync(trackerHtmlPath), false);
  assert.equal(existsSync(activityPath), false);
});

test("search source config normalizes legacy manual-auth rows and persists generic public sources", () => {
  const repoRoot = tempRepo();
  candidateSetupInitialize({ repoRoot });
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      searches: [
        {
          provider: "indeed.com",
          source_type: "manual-auth",
          label: "Indeed saved search",
          url: "https://www.indeed.com/jobs?q=operations",
          enabled: false,
        },
      ],
    },
  });

  const normalized = sourceConfigGet({ repoRoot, name: "search-sources" }).data.searches[0];
  assert.equal(normalized.source_type, "browser");
  assert.equal(normalized.auth, true);

  const added = publicSearchSourceUpsert({
    repoRoot,
    entry: {
      name: "Plain Co careers",
      url: "https://plain.example/careers",
    },
  });
  assert.equal(added.status, "added");
  assert.deepEqual(added.entry, {
    provider: "plain.example",
    source_type: "browser",
    platform: "plain.example",
    label: "Plain Co careers",
    url: "https://plain.example/careers",
    enabled: true,
    recency: { mode: "since-last-run", safetyMinutes: 30 },
  });
  assert.equal(
    publicSearchSourceUpsert({ repoRoot, entry: added.entry }).status,
    "already-tracked"
  );
  assert.throws(
    () =>
      publicSearchSourceUpsert({
        repoRoot,
        entry: { name: "Local", url: "http://127.0.0.1/jobs" },
      }),
    /private|local/i
  );
});
