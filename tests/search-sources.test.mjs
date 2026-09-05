import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { reportIngestFailure } from "../scripts/capture-board-snapshot.mjs";
import {
  buildSearchSnapshotPath,
  captureSearchSources,
  hiringCafeSearchUrl,
  ingestCapturedSnapshot,
  loadSearchSourceConfig,
  reportSnapshotIngestFailure,
  searchSourceUrl,
  selectSearchSources,
  stampSourceOffers,
} from "../scripts/capture-search-sources.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { putRow } from "../src/core/db/verbs/shared.mjs";
import { ExportFailedError, sourcedUpsertBatch } from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import { captureAndPersistOffersIfDb } from "../src/core/scoring/sourced-persistence.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-search-sources-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builds HiringCafe saved-search URLs with the 24h recency convention", () => {
  const url = new URL(hiringCafeSearchUrl("forward deployed engineer"));
  const state = JSON.parse(url.searchParams.get("searchState"));

  assert.equal(url.origin, "https://hiring.cafe");
  assert.deepEqual(state, {
    searchQuery: "forward deployed engineer",
    dateFetchedPastNDays: 2,
    sortBy: "date",
  });
});

test("filters enabled configured sources by provider and id", () => {
  const config = {
    sources: [
      { id: "hc-fde", provider: "hiringcafe", term: "forward deployed engineer", enabled: true },
      { id: "hc-disabled", provider: "hiringcafe", term: "applied ai", enabled: false },
      {
        id: "li-ai",
        provider: "linkedin",
        url: "https://www.linkedin.com/jobs/search/?keywords=agentic%20ai",
        enabled: true,
      },
    ],
  };

  assert.deepEqual(
    selectSearchSources(config, { provider: "hiringcafe" }).map((source) => source.id),
    ["hc-fde"]
  );
  assert.deepEqual(
    selectSearchSources(config, { ids: ["li-ai", "hc-disabled"], includeDisabled: true }).map(
      (source) => source.id
    ),
    ["hc-disabled", "li-ai"]
  );
});

test("loads canonical YAML search-sources config", () => {
  const config = loadSearchSourceConfig(
    new URL("../config/search-sources.example.yml", import.meta.url).pathname
  );

  assert.ok(Array.isArray(config.searches), "expected searches[] from YAML config");
  assert.ok(config.searches.length > 0, "expected example YAML to contain searches");
});

test("selects canonical searches[] entries and aliases query to term", () => {
  const config = {
    searches: [
      {
        provider: "HiringCafe",
        label: "Forward Deployed Engineer",
        query: "forward deployed engineer",
        enabled: true,
      },
    ],
  };
  const selected = selectSearchSources(config, { provider: "hiringcafe" });

  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, "hiringcafe-forward-deployed-engineer");
  assert.equal(selected[0].term, "forward deployed engineer");
});

test("builds HiringCafe capture URL from canonical query field", () => {
  const [source] = selectSearchSources(
    {
      searches: [
        {
          provider: "HiringCafe",
          label: "Applied AI Engineer",
          query: "applied AI engineer",
          enabled: true,
        },
      ],
    },
    { provider: "hiringcafe" }
  );
  const url = new URL(searchSourceUrl(source));
  const state = JSON.parse(url.searchParams.get("searchState"));

  assert.equal(url.origin, "https://hiring.cafe");
  assert.equal(state.searchQuery, "applied AI engineer");
});

test("builds sanitized timestamped batch snapshot paths", () => {
  assert.equal(
    buildSearchSnapshotPath({
      source: "HiringCafe Saved",
      date: new Date("2026-06-08T12:34:56.000Z"),
    }),
    "scan-results/hiringcafe-saved-browser-20260608-123456.json"
  );
});

test("stamps captured offers with source metadata and canonical req ids", () => {
  const offers = stampSourceOffers({
    provider: "hiringcafe",
    source: { id: "hc-fde", label: "Forward Deployed Engineer", provider: "hiringcafe" },
    searchUrl: "https://hiring.cafe/?searchState=x",
    capturedUrl: "https://hiring.cafe/?searchState=x",
    offers: [
      {
        company: "Acme",
        title: "Forward Deployed Engineer",
        hiringCafeUrl: "https://hiring.cafe/job/swfwvwmaq6basefz",
        url: "https://jobs.ashbyhq.com/acme/example",
      },
    ],
  });

  assert.deepEqual(offers, [
    {
      company: "Acme",
      title: "Forward Deployed Engineer",
      hiringCafeUrl: "https://hiring.cafe/job/swfwvwmaq6basefz",
      url: "https://jobs.ashbyhq.com/acme/example",
      source: "hiringcafe-browser",
      sourceId: "hc-fde",
      sourceLabel: "Forward Deployed Engineer",
      sourceProvider: "hiringcafe",
      searchUrl: "https://hiring.cafe/?searchState=x",
      capturedUrl: "https://hiring.cafe/?searchState=x",
      reqId: "hiringcafe:swfwvwmaq6basefz",
    },
  ]);
});

test("batch snapshots keep raw scanned count when output offers are limited", async () => {
  const page = {
    async bringToFront() {},
    async goto() {},
    async waitForLoadState() {},
    async waitForTimeout() {},
    async evaluate() {
      return [
        {
          company: "Acme",
          title: "Forward Deployed Engineer",
          hiringCafeUrl: "https://hiring.cafe/job/one",
        },
        {
          company: "Beta",
          title: "Applied AI Engineer",
          hiringCafeUrl: "https://hiring.cafe/job/two",
        },
      ];
    },
    url() {
      return "https://hiring.cafe/";
    },
  };
  const chromium = {
    async launchPersistentContext() {
      return {
        pages() {
          return [page];
        },
        async close() {},
      };
    },
  };

  const snapshot = await captureSearchSources({
    sources: [{ id: "hc-fde", provider: "hiringcafe", label: "FDE", url: "https://hiring.cafe/" }],
    sourceName: "hiringcafe",
    chromium,
    limit: 1,
    perSourceLimit: 0,
    waitMs: 0,
    now: new Date("2026-06-08T12:34:56.000Z"),
  });

  assert.equal(snapshot.scanned, 2);
  assert.equal(snapshot.offers.length, 1);
  assert.equal(snapshot.source, "hiringcafe-browser");
});

test("browser capture defaults isolate persistent profiles by CareerRat home", async () => {
  async function launchedProfileDir(dataRoot) {
    let capturedProfileDir = null;
    const page = {
      async bringToFront() {},
      async goto() {},
      async waitForLoadState() {},
      async waitForTimeout() {},
      async evaluate() {
        return [];
      },
      url() {
        return "https://example.com/jobs";
      },
    };
    await captureSearchSources({
      repoRoot: "/repo",
      env: { CAREERRAT_HOME: dataRoot },
      sources: [
        { id: "generic", provider: "generic", label: "Generic", url: "https://example.com/jobs" },
      ],
      chromium: {
        async launchPersistentContext(profileDir) {
          capturedProfileDir = profileDir;
          return {
            pages: () => [page],
            async close() {},
          };
        },
      },
      waitMs: 0,
    });
    return capturedProfileDir;
  }

  const firstHome = tempRepo();
  const secondHome = tempRepo();
  const first = await launchedProfileDir(firstHome);
  const second = await launchedProfileDir(secondHome);

  assert.equal(first, join(firstHome, "board-profiles", "generic"));
  assert.equal(second, join(secondHome, "board-profiles", "generic"));
  assert.notEqual(first, second);
});

test("HiringCafe Vercel security checkpoint is reported as a capture error", async () => {
  const page = {
    async bringToFront() {},
    async goto() {},
    async waitForLoadState() {},
    async waitForTimeout() {},
    async evaluate(fn) {
      if (String(fn).includes("document.title")) {
        return {
          title: "Vercel Security Checkpoint",
          text: "Failed to verify your browser Code 21 Vercel Security Checkpoint",
        };
      }
      return [];
    },
    url() {
      return "https://hiring.cafe/";
    },
  };
  const chromium = {
    async launchPersistentContext() {
      return {
        pages() {
          return [page];
        },
        async close() {},
      };
    },
  };

  const snapshot = await captureSearchSources({
    sources: [{ id: "hc-fde", provider: "hiringcafe", label: "FDE", url: "https://hiring.cafe/" }],
    sourceName: "hiringcafe",
    chromium,
    waitMs: 0,
    now: new Date("2026-06-08T12:34:56.000Z"),
  });

  assert.equal(snapshot.offers.length, 0);
  assert.equal(snapshot.errors.length, 1);
  assert.match(snapshot.errors[0].error, /security checkpoint/i);
});

test("authenticated browser capture runs from the explicit capture request without a switch matrix", async () => {
  const repoRoot = tempRepo();
  let launches = 0;
  const page = {
    async bringToFront() {},
    async goto() {},
    async waitForLoadState() {},
    async waitForTimeout() {},
    async evaluate() {
      return [];
    },
    url() {
      return "https://www.linkedin.com/jobs/search/?keywords=applied%20ai";
    },
  };
  const snapshot = await captureSearchSources({
    repoRoot,
    sources: [
      {
        id: "linkedin-ai",
        provider: "linkedin",
        platform: "linkedin",
        auth: true,
        url: "https://www.linkedin.com/jobs/search/?keywords=applied%20ai",
      },
    ],
    chromium: {
      async launchPersistentContext() {
        launches += 1;
        return {
          pages: () => [page],
          async close() {},
        };
      },
    },
    waitMs: 0,
  });

  assert.equal(launches, 1);
  assert.equal(snapshot.errors.length, 0);
});

test("ingests captured browser snapshot offers into DB sourced rows with JD artifacts", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });

  const result = ingestCapturedSnapshot({
    repoRoot,
    now: new Date("2026-07-04T12:00:00.000Z"),
    snapshot: {
      source: "linkedin-browser",
      offers: [
        {
          company: "Acme",
          title: "Director of IT",
          url: "https://www.linkedin.com/jobs/view/123456",
          location: "Remote",
          source: "linkedin-browser",
          sourceId: "li-director",
          sourceLabel: "Director search",
          sourceProvider: "linkedin",
          searchUrl: "https://www.linkedin.com/jobs/search/?keywords=Director",
          capturedUrl:
            "https://www.linkedin.com/jobs/search/?keywords=Director&currentJobId=123456",
          hiringCafeUrl: "https://hiring.cafe/job/source-ref",
          reqId: "linkedin:123456",
          rawText: "Own identity, endpoints, SaaS automation, and IT operations.",
        },
      ],
    },
  });

  assert.equal(result.persistedRows, 1);
  assert.match(result.offers[0].artifacts.jd, /^workspace\/jobs\/acme-director-of-it-/);
  assert.equal(existsSync(userPath({ repoRoot }, result.offers[0].artifacts.jd)), true);
  assert.match(
    readFileSync(userPath({ repoRoot }, result.offers[0].artifacts.jd), "utf8"),
    /Own identity, endpoints, SaaS automation/
  );

  const rows = openDb({ repoRoot })
    .prepare("SELECT data FROM sourced")
    .all()
    .map((row) => JSON.parse(row.data));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company, "Acme");
  assert.equal(rows[0].role, "Director of IT");
  assert.equal(rows[0].source, "linkedin-browser");
  assert.equal(rows[0].sourcedAt, "2026-07-04T12:00:00.000Z");
  assert.equal(rows[0].updatedAt, "2026-07-04T12:00:00.000Z");
  assert.equal(rows[0].artifacts.jd, result.offers[0].artifacts.jd);
  assert.deepEqual(rows[0].sourceMeta, {
    sourceId: "li-director",
    sourceLabel: "Director search",
    sourceProvider: "linkedin",
    searchUrl: "https://www.linkedin.com/jobs/search/?keywords=Director",
    capturedUrl: "https://www.linkedin.com/jobs/search/?keywords=Director&currentJobId=123456",
    hiringCafeUrl: "https://hiring.cafe/job/source-ref",
  });

  const tracker = JSON.parse(
    readFileSync(userPath({ repoRoot }, "workspace/tracker.json"), "utf8")
  );
  assert.equal(tracker.sourced.length, 1);
  assert.equal(tracker.sourced[0].id, rows[0].id);
});

test("a losing duplicate with the same explicit reqId never overwrites the accepted row's JD artifact", () => {
  // CR-29 round 3: prepareAcceptedRow wrote the deterministic JD artifact
  // (company-role-reqId.md, same path for both offers here since the reqId
  // is unchanged) BEFORE sourcedUpsertBatch's own inner duplicate check ran.
  // A second capture reusing the same explicit reqId with a changed
  // URL/body could therefore overwrite the first (accepted) row's artifact
  // file and then still get rejected as a duplicate, leaving the DB
  // pointing at content that no longer matches what was captured.
  const repoRoot = tempRepo();
  openDb({ repoRoot });

  const first = ingestCapturedSnapshot({
    repoRoot,
    now: new Date("2026-07-04T12:00:00.000Z"),
    snapshot: {
      source: "generic-browser",
      offers: [
        {
          company: "Acme",
          title: "Widget Engineer",
          url: "https://example.test/jobs/111",
          reqId: "explicit:foo",
          rawText: "Original body content unique-marker-A.",
        },
      ],
    },
  });
  assert.equal(first.persistedRows, 1);
  const artifactPath = userPath({ repoRoot }, first.offers[0].artifacts.jd);
  assert.match(readFileSync(artifactPath, "utf8"), /unique-marker-A/);

  const second = ingestCapturedSnapshot({
    repoRoot,
    now: new Date("2026-07-05T12:00:00.000Z"),
    snapshot: {
      source: "generic-browser",
      offers: [
        {
          company: "Acme",
          title: "Widget Engineer",
          url: "https://example.test/jobs/222",
          reqId: "explicit:foo",
          rawText: "Replacement body content unique-marker-B.",
        },
      ],
    },
  });
  assert.equal(second.persistedRows, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(second.offers.length, 0);

  const artifactContent = readFileSync(artifactPath, "utf8");
  assert.match(artifactContent, /unique-marker-A/);
  assert.doesNotMatch(artifactContent, /unique-marker-B/);

  const rows = openDb({ repoRoot })
    .prepare("SELECT data FROM sourced")
    .all()
    .map((row) => JSON.parse(row.data));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].link, "https://example.test/jobs/111");
});

test("capture ingest skips invalid blank-company offers without writing JD artifacts", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });

  const result = ingestCapturedSnapshot({
    repoRoot,
    now: new Date("2026-07-04T12:00:00.000Z"),
    snapshot: {
      source: "generic-browser",
      offers: [
        {
          company: "",
          title: "Unattributed role",
          url: "https://example.test/jobs/1",
          rawText: "This card did not expose an employer.",
        },
      ],
    },
  });

  assert.equal(result.persistedRows, 0);
  assert.equal(result.offers.length, 0);
  assert.equal(existsSync(userPath({ repoRoot }, "workspace/jobs")), false);
});

test("snapshot ingestion canonically dedupes a Workday posting against a row persisted under the old tenant-only key", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });

  // Simulates a row persisted before the CR-29 migration, when Workday
  // identity was keyed on `workday:<tenant>:<req>` instead of the current
  // `workday:<full-hostname>:<req>`. Seeded directly (dedupeCanonical off)
  // so its stored id keeps the pre-migration shape; canonical dedupe on the
  // read side must still recognize it by recomputing identity from its url.
  sourcedUpsertBatch({
    repoRoot,
    rows: [
      {
        id: "workday:acme:jr12345",
        company: "Acme",
        role: "Senior Engineer",
        status: "sourced",
        source: "scanner",
        channel: "board",
        link: "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boston/Senior-Engineer_JR12345",
        loc: "Boston, MA",
        base: "verify",
        fitScore: 80,
        fitBucket: "high",
        fitBasis: "triage",
        gate: "likely-keep",
        sourcedAt: "2026-07-05T00:00:00Z",
        updatedAt: "2026-07-05T00:00:00Z",
        artifacts: {},
      },
    ],
  });

  // Re-ingested through the snapshot path (capture-board-snapshot /
  // capture-search-sources) with a "-N" cross-site disambiguator suffix on
  // the URL, using the new full-hostname key shape.
  const result = ingestCapturedSnapshot({
    repoRoot,
    now: new Date("2026-07-06T00:00:00.000Z"),
    snapshot: {
      source: "workday-browser",
      offers: [
        {
          company: "Acme",
          title: "Senior Engineer",
          url: "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boston/Senior-Engineer_JR12345-2",
          location: "Boston, MA",
          source: "workday-browser",
          rawText: "Own the platform roadmap for the Boston engineering team.",
        },
      ],
    },
  });

  assert.equal(result.persistedRows, 0);
  assert.equal(result.duplicates, 1);
  assert.equal(result.offers.length, 0);

  const rows = openDb({ repoRoot })
    .prepare("SELECT data FROM sourced")
    .all()
    .map((row) => JSON.parse(row.data));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "workday:acme:jr12345");
});

test("snapshot ingestion canonically dedupes a HiringCafe-sourced Workday posting despite its own aggregator reqId", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });

  // Existing row persisted straight from the direct Workday board, keyed on
  // the unsuffixed requisition.
  sourcedUpsertBatch({
    repoRoot,
    rows: [
      {
        id: "workday:acme.wd5.myworkdayjobs.com:jr12345",
        company: "Acme",
        role: "Senior Engineer",
        status: "sourced",
        source: "scanner",
        channel: "board",
        link: "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boston/Senior-Engineer_JR12345",
        loc: "Boston, MA",
        base: "verify",
        fitScore: 80,
        fitBucket: "high",
        fitBasis: "triage",
        gate: "likely-keep",
        sourcedAt: "2026-07-05T00:00:00Z",
        updatedAt: "2026-07-05T00:00:00Z",
        artifacts: {},
      },
    ],
  });

  // HiringCafe re-publishes the same requisition with its own aggregator
  // reqId and the Workday external link carrying a "-2" cross-site
  // disambiguator suffix. Its explicit reqId alone would shadow the
  // URL-derived Workday key and miss the duplicate.
  const result = ingestCapturedSnapshot({
    repoRoot,
    now: new Date("2026-07-06T00:00:00.000Z"),
    snapshot: {
      source: "hiringcafe-browser",
      offers: [
        {
          company: "Acme",
          title: "Senior Engineer",
          hiringCafeUrl: "https://hiring.cafe/job/swfwvwmaq6basefz",
          url: "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boston/Senior-Engineer_JR12345-2",
          reqId: "hiringcafe:swfwvwmaq6basefz",
          location: "Boston, MA",
          source: "hiringcafe-browser",
          rawText: "Own the platform roadmap for the Boston engineering team.",
        },
      ],
    },
  });

  assert.equal(result.persistedRows, 0);
  assert.equal(result.duplicates, 1);
  assert.equal(result.offers.length, 0);

  const rows = openDb({ repoRoot })
    .prepare("SELECT data FROM sourced")
    .all()
    .map((row) => JSON.parse(row.data));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "workday:acme.wd5.myworkdayjobs.com:jr12345");
});

test("a discarded HiringCafe bridge alias resolves a later HiringCafe-only ingest back to the same row", () => {
  // CR-29 round 3: suppressing the bridged HiringCafe duplicate (previous
  // test) used to drop it silently: the canonical row never learned the
  // aggregator's own identity. A LATER capture that only carries the
  // HiringCafe side (no outbound Workday URL at all, e.g. the listing lost
  // its external link) then shared no key with the stored row and inserted
  // as a second, duplicate role. Three steps, one row throughout: direct
  // Workday, bridged HiringCafe (merges the alias), HiringCafe-only (must
  // now match via that alias).
  const repoRoot = tempRepo();
  openDb({ repoRoot });

  // Step 1: direct Workday board capture.
  sourcedUpsertBatch({
    repoRoot,
    rows: [
      {
        id: "workday:acme.wd5.myworkdayjobs.com:jr12345",
        company: "Acme",
        role: "Senior Engineer",
        status: "sourced",
        source: "scanner",
        channel: "board",
        link: "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boston/Senior-Engineer_JR12345",
        loc: "Boston, MA",
        base: "verify",
        fitScore: 80,
        fitBucket: "high",
        fitBasis: "triage",
        gate: "likely-keep",
        sourcedAt: "2026-07-05T00:00:00Z",
        updatedAt: "2026-07-05T00:00:00Z",
        artifacts: {},
      },
    ],
  });

  // Step 2: bridged HiringCafe capture, same posting, carries both its own
  // aggregator reqId and the Workday URL (with the cross-site "-2" suffix).
  const bridged = ingestCapturedSnapshot({
    repoRoot,
    now: new Date("2026-07-06T00:00:00.000Z"),
    snapshot: {
      source: "hiringcafe-browser",
      offers: [
        {
          company: "Acme",
          title: "Senior Engineer",
          hiringCafeUrl: "https://hiring.cafe/job/swfwvwmaq6basefz",
          url: "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boston/Senior-Engineer_JR12345-2",
          reqId: "hiringcafe:swfwvwmaq6basefz",
          location: "Boston, MA",
          source: "hiringcafe-browser",
          rawText: "Own the platform roadmap for the Boston engineering team.",
        },
      ],
    },
  });
  assert.equal(bridged.persistedRows, 0);
  assert.equal(bridged.duplicates, 1);

  const afterBridge = openDb({ repoRoot })
    .prepare("SELECT data FROM sourced")
    .all()
    .map((row) => JSON.parse(row.data));
  assert.equal(afterBridge.length, 1);
  assert.ok(afterBridge[0].aliasKeys?.includes("req:hiringcafe:swfwvwmaq6basefz"));

  // Step 3: HiringCafe-only capture, no Workday URL at all, only the
  // aggregator's own page and reqId. Must still resolve to the same row via
  // the alias persisted in step 2.
  const hiringCafeOnly = ingestCapturedSnapshot({
    repoRoot,
    now: new Date("2026-07-07T00:00:00.000Z"),
    snapshot: {
      source: "hiringcafe-browser",
      offers: [
        {
          company: "Acme",
          title: "Senior Engineer",
          url: "https://hiring.cafe/job/swfwvwmaq6basefz",
          reqId: "hiringcafe:swfwvwmaq6basefz",
          location: "Boston, MA",
          source: "hiringcafe-browser",
          rawText: "Own the platform roadmap for the Boston engineering team.",
        },
      ],
    },
  });
  assert.equal(hiringCafeOnly.persistedRows, 0);
  assert.equal(hiringCafeOnly.duplicates, 1);

  const finalRows = openDb({ repoRoot })
    .prepare("SELECT data FROM sourced")
    .all()
    .map((row) => JSON.parse(row.data));
  assert.equal(finalRows.length, 1);
  assert.equal(finalRows[0].id, "workday:acme.wd5.myworkdayjobs.com:jr12345");
});

test("a JD artifact-write failure leaves no dangling DB row, and a retry after the failure is fixed succeeds", () => {
  // CR-29 round 4: the JD artifact write used to happen AFTER
  // sourcedUpsertBatch's transaction (and the tracker.json/activity.jsonl
  // export inside it) had already returned, so a write failure landed a
  // durable row whose artifacts.jd pointed at a file that never got written.
  // Reconciliation then rejected a retry of the same offer as a duplicate,
  // permanently losing the description. The write now happens BEFORE
  // sourcedUpsertBatch is even called (CR-29 round 6, to its FINAL
  // content-addressed path) — a failure there must leave NO row and NO
  // claimed identity, so a retry (once whatever failed is fixed) inserts
  // cleanly instead of bouncing off a phantom duplicate.
  const repoRoot = tempRepo();
  openDb({ repoRoot });

  const offer = {
    company: "Acme",
    title: "JD Write Failure Role",
    url: "https://example.test/jobs/jd-write-failure",
    reqId: "explicit-jdfail-1",
    rawText: "Body content for the write-failure regression.",
  };
  const jobsDir = userPath({ repoRoot }, "workspace/jobs");
  // Block EVERY artifact write, regardless of its content-addressed
  // filename: making "workspace/jobs" itself a plain FILE means
  // mkdirSync(dirname(absPath), { recursive: true }) throws for any offer,
  // since an ancestor path component exists but isn't a directory.
  mkdirSync(dirname(jobsDir), { recursive: true });
  writeFileSync(jobsDir, "");

  const failed = ingestCapturedSnapshot({
    repoRoot,
    now: new Date("2026-07-04T12:00:00.000Z"),
    snapshot: { source: "generic-browser", offers: [offer] },
  });

  assert.equal(failed.ok, false);
  assert.equal(failed.persistedRows, 0);
  assert.equal(failed.offers.length, 0);
  assert.equal(failed.persisted?.failed, 1);

  const rowsAfterFailure = openDb({ repoRoot }).prepare("SELECT data FROM sourced").all();
  assert.equal(rowsAfterFailure.length, 0, "a write failure must not leave a dangling row");

  // Fix the failure (remove the blocking file) and retry the exact same
  // offer.
  rmSync(jobsDir, { force: true });

  const retried = ingestCapturedSnapshot({
    repoRoot,
    now: new Date("2026-07-04T12:05:00.000Z"),
    snapshot: { source: "generic-browser", offers: [offer] },
  });

  assert.equal(retried.ok, true);
  assert.equal(retried.persistedRows, 1);
  assert.equal(retried.offers.length, 1);
  const jdAbsPath = userPath({ repoRoot }, retried.offers[0].artifacts.jd);
  assert.equal(readFileSync(jdAbsPath, "utf8").includes("write-failure regression"), true);

  const rowsAfterRetry = openDb({ repoRoot })
    .prepare("SELECT data FROM sourced")
    .all()
    .map((row) => JSON.parse(row.data));
  assert.equal(rowsAfterRetry.length, 1);
  assert.equal(rowsAfterRetry[0].artifacts.jd, retried.offers[0].artifacts.jd);
});

test("a tracker export failure still leaves the DB row and its already-written JD artifact consistent", () => {
  // CR-29 round 4: proves the fix's ORDERING, not just the write-failure
  // path above. The JD write now happens before the row commits, so by the
  // time exportToTracker runs (outside the transaction, per runVerb) and
  // fails, the row and its artifact are already both durable and
  // consistent — unlike before, when the write ran only after export had
  // already succeeded or thrown, and export throwing meant the fs write was
  // never even attempted.
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  // Force exportToTracker to fail: atomicWriteFile's rename/write onto an
  // existing DIRECTORY at the tracker.json path throws EISDIR (same trick
  // as tests/db-verb-export-integrity.test.mjs).
  mkdirSync(userPath({ repoRoot }, "workspace/tracker.json"), { recursive: true });

  const offer = {
    company: "Acme",
    title: "Export Failure Role",
    url: "https://example.test/jobs/export-failure",
    reqId: "explicit-exportfail-1",
    rawText: "Body content for the export-failure regression.",
  };

  let caught;
  try {
    ingestCapturedSnapshot({
      repoRoot,
      now: new Date("2026-07-04T12:00:00.000Z"),
      snapshot: { source: "generic-browser", offers: [offer] },
    });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, "an export failure must not be swallowed as a silent success");
  assert.ok(caught instanceof ExportFailedError);
  assert.equal(caught.code, "EXPORT_FAILED");
  assert.equal(caught.committed, true, "the db write already committed before export ran");

  const rows = openDb({ repoRoot })
    .prepare("SELECT data FROM sourced")
    .all()
    .map((row) => JSON.parse(row.data));
  assert.equal(rows.length, 1, "the sourced row must still have committed");
  const jdAbsPath = userPath({ repoRoot }, rows[0].artifacts.jd);
  assert.equal(
    readFileSync(jdAbsPath, "utf8").includes("export-failure regression"),
    true,
    "the JD artifact must already exist, since the write happens before the row commits"
  );
});

test("two offers for the same posting in ONE batch (direct Workday, then a HiringCafe bridge) merge to one row whose aliases a later HiringCafe-only retry can still resolve", () => {
  // CR-29 round 2/4: reconcileOffersBeforeCapture used to check every offer
  // in a batch only against PERSISTED rows (buildDbSeenSets), so when the
  // direct Workday offer and its HiringCafe bridge arrived in the SAME
  // batch, the bridge was correctly recognized as a same-batch duplicate,
  // but the alias merge (sourcedMergeIdentityAlias) looked it up in the DB,
  // where the direct offer hadn't landed yet — a silent no-op. The bridge's
  // aggregator reqId was then lost, and a LATER HiringCafe-only capture (no
  // outbound Workday URL at all) inserted a second row instead of resolving
  // back to the first.
  const repoRoot = tempRepo();
  openDb({ repoRoot });

  const first = ingestCapturedSnapshot({
    repoRoot,
    now: new Date("2026-07-04T12:00:00.000Z"),
    snapshot: {
      source: "mixed-browser",
      offers: [
        {
          company: "Acme",
          title: "Senior Engineer",
          url: "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boston/Senior-Engineer_JR12345",
          location: "Boston, MA",
          source: "workday-browser",
          rawText: "The direct Workday board capture.",
        },
        {
          company: "Acme",
          title: "Senior Engineer",
          hiringCafeUrl: "https://hiring.cafe/job/swfwvwmaq6basefz",
          url: "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boston/Senior-Engineer_JR12345-2",
          reqId: "hiringcafe:swfwvwmaq6basefz",
          location: "Boston, MA",
          source: "hiringcafe-browser",
          rawText: "The bridged HiringCafe capture, same batch as the direct one.",
        },
      ],
    },
  });

  assert.equal(first.persistedRows, 1);
  assert.equal(first.duplicates, 1);

  const afterFirstBatch = openDb({ repoRoot })
    .prepare("SELECT data FROM sourced")
    .all()
    .map((row) => JSON.parse(row.data));
  assert.equal(afterFirstBatch.length, 1, "one row for both same-batch representations");
  assert.ok(
    afterFirstBatch[0].aliasKeys?.includes("req:hiringcafe:swfwvwmaq6basefz"),
    "the same-batch bridge's alias must be merged onto the accepted row"
  );

  const hiringCafeOnly = ingestCapturedSnapshot({
    repoRoot,
    now: new Date("2026-07-05T12:00:00.000Z"),
    snapshot: {
      source: "hiringcafe-browser",
      offers: [
        {
          company: "Acme",
          title: "Senior Engineer",
          url: "https://hiring.cafe/job/swfwvwmaq6basefz",
          reqId: "hiringcafe:swfwvwmaq6basefz",
          location: "Boston, MA",
          source: "hiringcafe-browser",
          rawText: "A later HiringCafe-only republish, no Workday URL at all.",
        },
      ],
    },
  });

  assert.equal(hiringCafeOnly.persistedRows, 0);
  assert.equal(hiringCafeOnly.duplicates, 1);

  const finalRows = openDb({ repoRoot })
    .prepare("SELECT data FROM sourced")
    .all()
    .map((row) => JSON.parse(row.data));
  assert.equal(finalRows.length, 1, "still one row after the alias-only retry");
  assert.equal(finalRows[0].id, afterFirstBatch[0].id);
});

test("a same-batch row's ACCUMULATED aliases survive final reconciliation against a concurrently persisted row (CR-29 round 6)", () => {
  // sourced-identity.mjs's identityAliasAdditions used to compute additions
  // from `duplicate`'s OWN postingIdentityKeys only, dropping any aliasKeys
  // the duplicate had already accumulated from an EARLIER same-batch merge.
  // Here, X wins an in-batch identity contest against Y (accumulating Y's
  // URL as an alias), then a DIFFERENT row Z — persisted CONCURRENTLY, after
  // reconcileOffersBeforeCapture's read-only seenPostingKeys snapshot but
  // before sourcedUpsertBatch's own transaction opens (simulated here via
  // `guard`, which runs inside that transaction right before its fresh
  // storedPostingIndex is built) — turns out to already own X's shared
  // reqId. X is discarded as Z's duplicate, and Z must inherit BOTH of X's
  // surviving identities: its own URL AND the URL X only holds because Y's
  // alias was merged onto it earlier in this same batch.
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });

  const sharedReqId = "req-concurrent-shared";
  const offerX = {
    company: "Acme",
    title: "Concurrent Engineer",
    url: "https://jobs.example.test/acme/concurrent-x",
    reqId: sharedReqId,
    rawText: "Body content for the concurrent-reconciliation regression (X).",
  };
  const offerY = {
    company: "Acme",
    title: "Concurrent Engineer",
    url: "https://jobs.example.test/acme/concurrent-y",
    reqId: sharedReqId,
    rawText: "Body content for the concurrent-reconciliation regression (Y).",
  };

  const result = captureAndPersistOffersIfDb({
    repoRoot,
    // X before Y: X wins the in-batch identity contest on sharedReqId and
    // accumulates Y's URL as an alias (identityAliasAdditions(X, Y)).
    offers: [offerX, offerY],
    dedupeCanonical: true,
    guard: (db) => {
      putRow(db, "sourced", "sourced-concurrent-z", {
        id: "sourced-concurrent-z",
        company: "Acme",
        role: "Concurrent Engineer",
        status: "sourced",
        link: "https://jobs.example.test/acme/concurrent-z-canonical",
        reqId: sharedReqId,
      });
    },
  });

  // X loses to the concurrently-persisted Z; nothing new is accepted.
  assert.equal(result.persistedRows, 0);
  assert.equal(result.offers.length, 0);

  const zRow = JSON.parse(
    db.prepare("SELECT data FROM sourced WHERE id = ?").get("sourced-concurrent-z").data
  );
  assert.ok(
    zRow.aliasKeys?.includes("url:https://jobs.example.test/acme/concurrent-x"),
    "Z must inherit X's own URL"
  );
  assert.ok(
    zRow.aliasKeys?.includes("url:https://jobs.example.test/acme/concurrent-y"),
    "Z must also inherit Y's URL, which X only held as an ACCUMULATED alias from the same batch"
  );
});

function withStubbedConsoleError(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => {
    lines.push(args.join(" "));
  };
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    fn();
    return { lines, exitCode: process.exitCode };
  } finally {
    console.error = original;
    process.exitCode = originalExitCode;
  }
}

test("capture-board-snapshot's reportIngestFailure prints a bounded failed-id list, sets a nonzero exit code, and never touches an already-committed row (CR-29 round 6)", () => {
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });

  const ok = captureAndPersistOffersIfDb({
    repoRoot,
    offers: [
      {
        company: "Acme",
        title: "Board Snapshot Survivor",
        url: "https://jobs.example.test/acme/board-survivor",
        reqId: "board-survivor",
        rawText: "Body content for the board-snapshot survivor regression.",
      },
    ],
    dedupeCanonical: true,
  });
  assert.equal(ok.persistedRows, 1, "the first offer must commit before the block is set up");
  const survivorId = db.prepare("SELECT id FROM sourced").get().id;

  // Block every subsequent JD write: workspace/jobs itself becomes a plain
  // file, so mkdirSync(dirname(absPath)) throws ENOTDIR for any offer.
  const jobsDir = userPath({ repoRoot }, "workspace/jobs");
  rmSync(jobsDir, { recursive: true, force: true });
  writeFileSync(jobsDir, "blocking file, not a directory", "utf8");

  const failed = captureAndPersistOffersIfDb({
    repoRoot,
    offers: [
      {
        company: "Acme",
        title: "Board Snapshot Casualty",
        url: "https://jobs.example.test/acme/board-casualty",
        reqId: "board-casualty",
        rawText: "Body content for the board-snapshot casualty regression.",
      },
    ],
    dedupeCanonical: true,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.failed, 1);

  const { lines, exitCode } = withStubbedConsoleError(() => reportIngestFailure(failed));

  assert.equal(exitCode, 1, "a JD artifact-write failure must set a nonzero exit code");
  assert.match(lines[0], /Failed to persist 1 offer\(s\)/);
  assert.ok(
    failed.failedIds.every((id) => lines[0].includes(id)),
    "the failed id must be printed"
  );
  assert.match(lines[1], /still intact/);

  const survivorRow = openDb({ repoRoot })
    .prepare("SELECT data FROM sourced WHERE id = ?")
    .get(survivorId);
  assert.ok(survivorRow, "the earlier successfully committed row must be untouched");
  const rows = openDb({ repoRoot })
    .prepare("SELECT id FROM sourced")
    .all()
    .map((row) => row.id);
  assert.equal(rows.length, 1, "the blocked offer must never have landed a dangling row");
});

test("capture-board-snapshot's reportIngestFailure and capture-search-sources' reportSnapshotIngestFailure both bound a long failed-id list with a trailing ellipsis (CR-29 round 6)", () => {
  const manyFailedIds = Array.from({ length: 15 }, (_, i) => `sourced-bulk-${i}`);
  const syntheticResult = { failed: 15, failedIds: manyFailedIds };

  const board = withStubbedConsoleError(() => reportIngestFailure(syntheticResult));
  const searchSources = withStubbedConsoleError(() => reportSnapshotIngestFailure(syntheticResult));

  for (const { lines, exitCode } of [board, searchSources]) {
    assert.equal(exitCode, 1);
    assert.match(lines[0], /Failed to persist 15 offer\(s\)/);
    for (const id of manyFailedIds.slice(0, 10)) assert.ok(lines[0].includes(id));
    for (const id of manyFailedIds.slice(10)) assert.ok(!lines[0].includes(id));
    assert.match(lines[0], /, \.\.\.$/, "a list longer than 10 ids must end with an ellipsis");
  }
});

test("a conflict-only capture result (failed: 0, conflicts > 0) still sets a nonzero exit code and names the conflict, in both snapshot CLIs (CR-29 round 9)", () => {
  // Round 9: captureAndPersistOffersIfDb's `ok` now requires
  // `failed === 0 && conflicts === 0`, so a conflict-only ingest (nothing
  // failed to write, but a bridge offer was rejected as ambiguous) also
  // reaches these reporters. Before this fix neither reporter said
  // anything about conflicts at all, so a caller checking stderr for
  // "Failed to persist" would see nothing and assume a clean run.
  const conflictOnlyResult = {
    failed: 0,
    failedIds: [],
    conflicts: 1,
    conflictOffers: [
      { company: "Acme", title: "Bridge Role", url: "https://jobs.example.test/acme/bridge" },
    ],
  };

  const board = withStubbedConsoleError(() => reportIngestFailure(conflictOnlyResult));
  const searchSources = withStubbedConsoleError(() =>
    reportSnapshotIngestFailure(conflictOnlyResult)
  );

  for (const { lines, exitCode } of [board, searchSources]) {
    assert.equal(exitCode, 1, "a conflict-only result must still exit nonzero");
    assert.ok(
      !lines.some((line) => /Failed to persist/.test(line)),
      "no artifact failures occurred, so no 'Failed to persist' line should print"
    );
    assert.ok(
      lines.some((line) => /identity conflict/i.test(line) && line.includes("Acme")),
      "the conflict line must name the conflicting offer"
    );
  }
});
