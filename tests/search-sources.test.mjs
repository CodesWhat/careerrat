import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  buildSearchSnapshotPath,
  captureSearchSources,
  hiringCafeSearchUrl,
  ingestCapturedSnapshot,
  loadSearchSourceConfig,
  searchSourceUrl,
  selectSearchSources,
  stampSourceOffers,
} from "../scripts/capture-search-sources.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

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
