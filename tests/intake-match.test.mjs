// tests/intake-match.test.mjs — src/core/intake/match.mjs's dedup/tracker
// matcher: exact_req_id > exact_url > company_role precedence, company
// history as supplementary (never a hard duplicate), and the "no match"
// shape when nothing lines up.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";
import { matchTrackerRecord } from "../src/core/intake/match.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-intake-match-"));
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

function seed(repoRoot, { applications = [], sourced = [] } = {}) {
  const sourceDir = join(repoRoot, "fixture-source");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(
    join(sourceDir, "tracker.json"),
    JSON.stringify({ meta: {}, applications, sourced, sources: [], communications: [] }, null, 2)
  );
  importFromTracker({ repoRoot, sourceDir });
  return openDb({ repoRoot });
}

test("matchTrackerRecord: exact req-id match wins even when the URLs differ (moved/re-slugged posting)", () => {
  const repoRoot = tempRepo();
  // Ashby req ids are UUID-shaped (sourced-scanner.mjs's extractReqId) — a
  // query-string difference the URL-normalizer wouldn't otherwise strip
  // (?foo=bar, not a utm_/trk/ref/gh_src/source key) still resolves to the
  // SAME req id, since extractReqId only looks at the pathname.
  const db = seed(repoRoot, {
    applications: [
      {
        id: "app-1",
        company: "Acme",
        role: "Staff Engineer",
        status: "applied",
        link: "https://jobs.ashbyhq.com/acme/12345678-1234-1234-1234-123456789abc",
      },
    ],
  });

  const result = matchTrackerRecord({
    db,
    url: "https://jobs.ashbyhq.com/acme/12345678-1234-1234-1234-123456789abc?foo=bar",
  });
  assert.equal(result.matched, true);
  assert.equal(result.confidence, "exact_req_id");
  assert.equal(result.recordType, "application");
  assert.equal(result.id, "app-1");
  assert.match(result.summary, /already applied/);
});

test("matchTrackerRecord: exact normalized-URL match when no req id is extractable", () => {
  const repoRoot = tempRepo();
  const db = seed(repoRoot, {
    sourced: [
      { id: "sourced-1", company: "Globex", role: "PM", link: "https://globex.com/careers/pm" },
    ],
  });

  const result = matchTrackerRecord({ db, url: "https://globex.com/careers/pm?ref=linkedin" });
  assert.equal(result.matched, true);
  assert.equal(result.confidence, "exact_url");
  assert.equal(result.recordType, "sourced");
  assert.equal(result.id, "sourced-1");
});

test("matchTrackerRecord: company+role match when no URL is given at all", () => {
  const repoRoot = tempRepo();
  const db = seed(repoRoot, {
    applications: [{ id: "app-2", company: "Initech", role: "Analyst", status: "reviewed-hold" }],
  });

  const result = matchTrackerRecord({ db, company: "Initech", role: "Analyst" });
  assert.equal(result.matched, true);
  assert.equal(result.confidence, "company_role");
  assert.equal(result.id, "app-2");
});

test("matchTrackerRecord: no match returns matched:false with the documented null shape", () => {
  const repoRoot = tempRepo();
  const db = seed(repoRoot, {});
  const result = matchTrackerRecord({ db, url: "https://nowhere.example.com/jobs/1" });
  assert.deepEqual(result, {
    matched: false,
    confidence: null,
    recordType: null,
    id: null,
    company: null,
    role: null,
    status: null,
    summary: null,
    companyHistory: [],
  });
});

test("matchTrackerRecord: companyHistory surfaces OTHER roles at the same company as supplementary context, not a hard duplicate", () => {
  const repoRoot = tempRepo();
  const db = seed(repoRoot, {
    applications: [
      { id: "app-3", company: "Umbrella", role: "Backend Engineer", status: "rejected" },
      { id: "app-4", company: "Umbrella", role: "SRE", status: "applied" },
    ],
  });

  // A NEW role at a company we already have history with — not a duplicate
  // (different role -> no exact company_role hit), but companyHistory must
  // still surface the prior record(s) as context.
  const result = matchTrackerRecord({ db, company: "Umbrella", role: "Frontend Engineer" });
  assert.equal(result.matched, false);
  assert.equal(result.companyHistory.length, 2);
  const roles = result.companyHistory.map((h) => h.role).sort();
  assert.deepEqual(roles, ["Backend Engineer", "SRE"]);
});

test("matchTrackerRecord: companyHistory excludes the matched record itself", () => {
  const repoRoot = tempRepo();
  const db = seed(repoRoot, {
    applications: [
      { id: "app-5", company: "Hooli", role: "PM", status: "applied" },
      { id: "app-6", company: "Hooli", role: "Designer", status: "rejected" },
    ],
  });

  const result = matchTrackerRecord({ db, company: "Hooli", role: "PM" });
  assert.equal(result.matched, true);
  assert.equal(result.id, "app-5");
  assert.deepEqual(
    result.companyHistory.map((h) => h.id),
    ["app-6"]
  );
});

// ---------------------------------------------------------------------------
// company_unique — real status-update pastes almost never name the role
// ("they passed after the final round"); when the caller only extracted a
// company, a single row at that company is unambiguous, not a guess.
// ---------------------------------------------------------------------------

test("matchTrackerRecord: company-only (no role) matches company_unique when exactly one application row is at that company", () => {
  const repoRoot = tempRepo();
  const db = seed(repoRoot, {
    applications: [
      {
        id: "demo-app-1",
        company: "E Corp",
        role: "Staff Software Engineer",
        status: "applied",
        appliedAt: "2026-06-01",
      },
    ],
  });

  const result = matchTrackerRecord({ db, company: "E Corp" });
  assert.equal(result.matched, true);
  assert.equal(result.confidence, "company_unique");
  assert.equal(result.recordType, "application");
  assert.equal(result.id, "demo-app-1");
  assert.equal(result.role, "Staff Software Engineer");
  assert.match(result.summary, /already applied/);
  // The matched record itself is excluded from companyHistory, same as any
  // other confidence level.
  assert.equal(result.companyHistory.length, 0);
});

test("matchTrackerRecord: company-only (no role) stays unmatched when TWO application rows share that company — still a guess, not unambiguous", () => {
  const repoRoot = tempRepo();
  const db = seed(repoRoot, {
    applications: [
      { id: "app-a", company: "E Corp", role: "Staff Software Engineer", status: "applied" },
      { id: "app-b", company: "E Corp", role: "Senior Backend Engineer", status: "interviewing" },
    ],
  });

  const result = matchTrackerRecord({ db, company: "E Corp" });
  assert.equal(result.matched, false);
  assert.equal(result.confidence, null);
  // Both rows still surface as companyHistory context for the human.
  assert.equal(result.companyHistory.length, 2);
});

test("matchTrackerRecord: company-only (no role) matches a unique SOURCED-only row too (recordType: sourced)", () => {
  const repoRoot = tempRepo();
  const db = seed(repoRoot, {
    sourced: [{ id: "sourced-9", company: "Vandelay Industries", role: "PM", fitScore: 82 }],
  });

  const result = matchTrackerRecord({ db, company: "Vandelay Industries" });
  assert.equal(result.matched, true);
  assert.equal(result.confidence, "company_unique");
  assert.equal(result.recordType, "sourced");
  assert.equal(result.id, "sourced-9");
});

test("matchTrackerRecord: company-only (no role) prefers a unique APPLICATION over sourced rows at the same company", () => {
  const repoRoot = tempRepo();
  const db = seed(repoRoot, {
    applications: [{ id: "app-c", company: "Stark Industries", role: "SRE", status: "applied" }],
    sourced: [
      { id: "sourced-1", company: "Stark Industries", role: "PM" },
      { id: "sourced-2", company: "Stark Industries", role: "Designer" },
    ],
  });

  // Two sourced rows at this company would be ambiguous on their own, but a
  // single application row wins outright — applications are preferred and
  // sourced rows are never even consulted once one application matches.
  const result = matchTrackerRecord({ db, company: "Stark Industries" });
  assert.equal(result.matched, true);
  assert.equal(result.confidence, "company_unique");
  assert.equal(result.recordType, "application");
  assert.equal(result.id, "app-c");
});

test("matchTrackerRecord: company_role precedence still wins over company_unique when a role IS given and matches exactly", () => {
  const repoRoot = tempRepo();
  const db = seed(repoRoot, {
    applications: [
      { id: "app-x", company: "Acme", role: "Staff Engineer", status: "applied" },
      { id: "app-y", company: "Acme", role: "Product Manager", status: "rejected" },
    ],
  });

  // Two rows at "Acme" — company_unique alone would be ambiguous, but a
  // role WAS given and it matches app-x exactly, so company_role fires
  // first (the existing, higher-precedence rule) rather than falling
  // through to the company-only path (which never even runs here, since
  // that path only applies when no role was extracted at all).
  const result = matchTrackerRecord({ db, company: "Acme", role: "Staff Engineer" });
  assert.equal(result.matched, true);
  assert.equal(result.confidence, "company_role");
  assert.equal(result.id, "app-x");
});
