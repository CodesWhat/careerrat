// tests/scan-sourced.test.mjs
// node:test suite for the M3 promotion of scripts/scan-sourced.mjs's
// orchestration into an exported, importable runSourcedScan() (see that
// file's own header comment). Covers:
//   - runSourcedScan() against a stubbed fetchImpl (no real network) —
//     summary shape, write side effects, and no cross-call state
//     leakage between two different repoRoots (the refactor's main risk:
//     the old code cached candidate config in module-level variables tied to
//     a single fixed _scriptRoot).
//   - the CLI (main(), behind the import.meta.url entry guard) still parses
//     its flags and prints identically post-refactor — run for real as a
//     child process against the real repo with --company set to a name that
//     matches nothing, which also skips the search-sources.yml RSS scan (see
//     runSourcedScan's own `!companyFilter` guard), so this hits zero
//     network and stays fast/deterministic even though _scriptRoot always
//     resolves to the real installed script location.
//
// Does not re-test sourced-scanner.mjs's scoring/filtering rules — that's
// tests/sourced-scanner.test.mjs's job; this file only confirms the
// orchestration promotion didn't change behavior.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runSourcedScan } from "../scripts/scan-sourced.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  candidateConfigPatch,
  candidateSetupInitialize,
  companyAtsUpsert,
  sourceConfigGet,
  sourceConfigPut,
  sourcedUpsertBatch,
} from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import { parseYaml, stringifyYaml } from "../src/core/profile/yaml.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-scan-sourced-"));
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  mkdirSync(join(repoRoot, "workspace"), { recursive: true });
  return repoRoot;
}

function writeSourcedScanConfig(repoRoot, overrides = {}) {
  const configPath = join(repoRoot, "config/sourced-scan.json");
  const doc = {
    title_filter: { positive: [], negative: [] },
    location_filter: null,
    tracked_companies: [{ name: "Acme", careers_url: "https://jobs.lever.co/acme" }],
    ...overrides,
  };
  writeFileSync(configPath, JSON.stringify(doc, null, 2));
  return configPath;
}

function writeTargeting(repoRoot, keepSignals) {
  mkdirSync(join(repoRoot, "candidate"), { recursive: true });
  writeFileSync(
    join(repoRoot, "candidate/targeting.yml"),
    `${stringifyYaml({ keep_signals: keepSignals })}\n`
  );
}

function searchSourcesFixture() {
  return {
    searches: [
      {
        provider: "Example RSS",
        source_type: "rss",
        label: "Example feed",
        rssUrl: "https://example.test/jobs.xml",
        enabled: true,
        recency: { mode: "since-last-run" },
      },
    ],
  };
}

function writeSearchSourcesConfig(repoRoot, config = searchSourcesFixture()) {
  writeFileSync(join(repoRoot, "config/search-sources.yml"), `${stringifyYaml(config)}\n`);
}

// A single-job Lever fixture, matching tests/sourced-scanner.test.mjs's own
// Lever fixture shape. descriptionPlain, not descriptionBodyPlain: the vendor
// provider (src/core/providers/career-ops/vendor/lever.mjs) maps bodyText from
// descriptionPlain only, not the richer legacy descriptionBodyPlain +
// additionalPlain + salaryDescriptionPlain + lists composition the old
// CareerRat-local fetchLever() used to build.
function leverFetchStub(title = "Director of IT") {
  return async (url) => {
    if (String(url).includes("api.lever.co")) {
      return new Response(
        JSON.stringify([
          {
            text: title,
            hostedUrl: "https://jobs.lever.co/acme/abc",
            categories: { location: "Remote" },
            descriptionPlain: "Own corporate IT, identity, endpoint, and automation.",
          },
        ]),
        { status: 200 }
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

function manyLeverFetchStub() {
  return async (url) => {
    const slug = new URL(String(url)).pathname.split("/").filter(Boolean).at(-1);
    return new Response(
      JSON.stringify([
        {
          text: `Staff Platform Engineer ${slug}`,
          hostedUrl: `https://jobs.lever.co/${slug}/req-${slug}`,
          categories: { location: "Remote - US" },
          descriptionPlain: "Own platform infrastructure, identity, and automation systems.",
        },
      ]),
      { status: 200 }
    );
  };
}

function rssFetchStub() {
  return async (url) => {
    assert.equal(String(url), "https://example.test/jobs.xml");
    return new Response(
      `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Example jobs</title>
    <item>
      <title>Acme — Director of IT (Remote)</title>
      <link>https://example.test/jobs/director-it</link>
      <description>Own corporate IT, identity, endpoint, and automation.</description>
      <guid>director-it</guid>
      <pubDate>Fri, 03 Jul 2026 12:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`,
      { status: 200 }
    );
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function leverResponse({ title, url, location = "Remote", body = "Role description." }) {
  return new Response(
    JSON.stringify([
      {
        text: title,
        hostedUrl: url,
        categories: { location },
        descriptionBodyPlain: body,
      },
    ]),
    { status: 200 }
  );
}

function rssResponse({ company, title, url }) {
  return new Response(
    `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>${company} jobs</title>
    <item>
      <title>${company} — ${title} (Remote)</title>
      <link>${url}</link>
      <description>Build deterministic AI and identity automation systems.</description>
      <guid>${url}</guid>
      <pubDate>Fri, 03 Jul 2026 12:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`,
    { status: 200 }
  );
}

// ---------------------------------------------------------------------------
// runSourcedScan()
// ---------------------------------------------------------------------------

test("runSourcedScan returns the documented summary shape from a stubbed fetch", async () => {
  const repoRoot = tempRepo();
  try {
    const configPath = writeSourcedScanConfig(repoRoot);
    const summary = await runSourcedScan({
      repoRoot,
      fetchImpl: leverFetchStub(),
      configPath,
      write: false,
    });
    assert.equal(summary.scanned, 1);
    assert.equal(summary.new, 1);
    assert.equal(summary.duplicates, 0);
    assert.equal(summary.invalid, 0);
    assert.ok(Array.isArray(summary.errors));
    assert.ok(Array.isArray(summary.offers));
    assert.equal(summary.offers.length, 1);
    const offer = summary.offers[0];
    assert.equal(offer.company, "Acme");
    assert.equal(offer.title, "Director of IT");
    assert.equal(typeof offer.score, "number");
    assert.equal(typeof offer.fit, "string");
    assert.equal(typeof offer.bodyChars, "number");
    assert.ok(!("bodyText" in offer), "bodyText should be stripped to bodyChars for output");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("partial-offer hydration uses a bounded worker pool and preserves output order", async () => {
  const repoRoot = tempRepo();
  try {
    candidateSetupInitialize({ repoRoot });
    const companies = Array.from({ length: 9 }, (_, index) => `Company ${index}`);
    sourceConfigPut({
      repoRoot,
      name: "search-sources",
      data: {
        searches: companies.map((company, index) => ({
          provider: "Remote Vibe Coding Jobs",
          source_type: "rss",
          label: `Remote Vibe Coding Jobs ${company} feed`,
          rssUrl: `https://example.test/jobs-${index}.xml`,
          enabled: true,
        })),
      },
    });
    let active = 0;
    let maxActive = 0;
    let hydrated = 0;
    const summary = await runSourcedScan({
      repoRoot,
      write: false,
      fetchImpl: async (url) => {
        const index = Number(String(url).match(/jobs-(\d+)\.xml/)?.[1]);
        return rssResponse({
          company: companies[index],
          title: `Staff Platform Engineer ${index}`,
          url: `https://jobs.example.test/role-${index}`,
        });
      },
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      hydrateOfferImpl: async (offer) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        hydrated += 1;
        return { ...offer, bodyText: `Full body for ${offer.company}`, bodyPartial: false };
      },
    });

    assert.equal(summary.new, 9);
    assert.equal(hydrated, 9);
    assert.ok(maxActive <= 4, `expected at most four hydrations, saw ${maxActive}`);
    assert.deepEqual(
      summary.offers.map(({ company }) => company),
      companies
    );
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("source acquisition uses a bounded worker pool instead of fetching boards serially", async () => {
  const repoRoot = tempRepo();
  const release = deferred();
  const fourStarted = deferred();
  try {
    const companies = Array.from({ length: 9 }, (_, index) => ({
      name: `Company ${index}`,
      careers_url: `https://jobs.lever.co/company-${index}`,
    }));
    const configPath = writeSourcedScanConfig(repoRoot, { tracked_companies: companies });
    let active = 0;
    let maxActive = 0;
    let started = 0;
    const scan = runSourcedScan({
      repoRoot,
      configPath,
      write: false,
      fetchImpl: async (url) => {
        const slug = new URL(String(url)).pathname.split("/").filter(Boolean).at(-1);
        started += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (started === 4) fourStarted.resolve();
        await release.promise;
        active -= 1;
        return new Response(
          JSON.stringify([
            {
              text: `Platform Engineer ${slug}`,
              hostedUrl: `https://jobs.lever.co/${slug}/role-1`,
              categories: { location: "Remote - US" },
              descriptionPlain: "Build reliable platform infrastructure and developer tooling.",
            },
          ]),
          { status: 200 }
        );
      },
    });

    const ranConcurrently = await Promise.race([
      fourStarted.promise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 75)),
    ]);
    release.resolve();
    const summary = await scan;

    assert.equal(ranConcurrently, true);
    assert.ok(maxActive > 1);
    assert.ok(maxActive <= 4);
    assert.equal(summary.scanned, companies.length);
  } finally {
    release.resolve();
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("offer liveness verification uses bounded concurrency", async () => {
  const repoRoot = tempRepo();
  const release = deferred();
  const fourStarted = deferred();
  try {
    const configPath = writeSourcedScanConfig(repoRoot);
    let active = 0;
    let maxActive = 0;
    let started = 0;
    const scan = runSourcedScan({
      repoRoot,
      configPath,
      write: false,
      verify: true,
      fetchImpl: async (url) => {
        if (String(url).includes("api.lever.co")) {
          return new Response(
            JSON.stringify(
              Array.from({ length: 9 }, (_, index) => ({
                text: `Platform Engineer ${index}`,
                hostedUrl: `https://jobs.lever.co/acme/role-${index}`,
                categories: { location: "Remote - US" },
                descriptionPlain: "Build reliable platform infrastructure and developer tooling.",
              }))
            ),
            { status: 200 }
          );
        }
        started += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (started === 4) fourStarted.resolve();
        await release.promise;
        active -= 1;
        return new Response("live", { status: 200 });
      },
    });

    const ranConcurrently = await Promise.race([
      fourStarted.promise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 75)),
    ]);
    release.resolve();
    const summary = await scan;

    assert.equal(ranConcurrently, true);
    assert.ok(maxActive > 1);
    assert.ok(maxActive <= 6);
    assert.equal(summary.expired, 0);
    assert.equal(summary.new, 5);
  } finally {
    release.resolve();
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("the presentation limit is applied after hydration so rejected candidates backfill", async () => {
  const repoRoot = tempRepo();
  try {
    candidateSetupInitialize({ repoRoot });
    candidateConfigPatch({
      repoRoot,
      name: "profile",
      patch: { compensation: { minimum_base: 180000 } },
    });
    const companies = Array.from({ length: 8 }, (_, index) => `Limited ${index}`);
    sourceConfigPut({
      repoRoot,
      name: "search-sources",
      data: {
        searches: companies.map((company, index) => ({
          provider: "Remote Vibe Coding Jobs",
          source_type: "rss",
          label: `Remote Vibe Coding Jobs ${company} feed`,
          rssUrl: `https://example.test/limited-${index}.xml`,
          enabled: true,
        })),
      },
    });
    let active = 0;
    let hydrated = 0;
    let maxActive = 0;
    const summary = await runSourcedScan({
      repoRoot,
      write: false,
      limit: 3,
      fetchImpl: async (url) => {
        const index = Number(String(url).match(/limited-(\d+)\.xml/)?.[1]);
        return rssResponse({
          company: companies[index],
          title: `Staff Platform Engineer ${index}`,
          url: `https://jobs.example.test/limited-role-${index}`,
        });
      },
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      hydrateOfferImpl: async (offer) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        hydrated += 1;
        const index = Number(String(offer.url).match(/limited-role-(\d+)/)?.[1]);
        return {
          ...offer,
          bodyText:
            index < 3
              ? "Salary Range: $100,000 - $120,000 annually."
              : "Salary Range: $200,000 - $240,000 annually.",
          bodyPartial: false,
        };
      },
    });

    assert.equal(summary.new, 3);
    assert.equal(summary.qualified, 5);
    assert.equal(summary.filteredSalary, 3);
    assert.equal(summary.overflow, 2);
    assert.equal(hydrated, 8);
    assert.ok(maxActive <= 4, `expected at most four hydrations, saw ${maxActive}`);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("the per-company cap is applied after hydration so rejected roles do not consume it", async () => {
  const repoRoot = tempRepo();
  try {
    candidateSetupInitialize({ repoRoot });
    candidateConfigPatch({
      repoRoot,
      name: "profile",
      patch: { compensation: { minimum_base: 180000 } },
    });
    candidateConfigPatch({
      repoRoot,
      name: "targeting",
      patch: { search_preferences: { presentation_cap_per_company: 2 } },
    });
    const sources = Array.from({ length: 4 }, (_, index) => ({
      provider: "Remote Vibe Coding Jobs",
      source_type: "rss",
      label: `FloodCo feed ${index}`,
      rssUrl: `https://example.test/flood-${index}.xml`,
      enabled: true,
    }));
    sourceConfigPut({
      repoRoot,
      name: "search-sources",
      data: { searches: sources },
    });

    const summary = await runSourcedScan({
      repoRoot,
      write: false,
      fetchImpl: async (url) => {
        const index = Number(String(url).match(/flood-(\d+)\.xml/)?.[1]);
        return rssResponse({
          company: "FloodCo",
          title: `Staff Platform Engineer ${index}`,
          url: `https://jobs.example.test/flood-role-${index}`,
        });
      },
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      hydrateOfferImpl: async (offer) => {
        const index = Number(String(offer.url).match(/flood-role-(\d+)/)?.[1]);
        return {
          ...offer,
          bodyText:
            index < 2
              ? "Salary Range: $100,000 - $120,000 annually."
              : "Salary Range: $200,000 - $240,000 annually.",
          bodyPartial: false,
        };
      },
    });

    assert.equal(summary.new, 2);
    assert.equal(summary.qualified, 2);
    assert.equal(summary.filteredSalary, 2);
    assert.equal(summary.overflow, 0);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("false-zero summaries split title blockers from relevance and bound safe rejection samples", async () => {
  const repoRoot = tempRepo();
  const rejected = [
    "Sales Engineer",
    "Finance Manager",
    "Account Executive",
    "Product Marketing Manager",
    "Registered Nurse",
    "Data Scientist",
  ];
  try {
    const configPath = writeSourcedScanConfig(repoRoot, {
      title_filter: { positive: ["Staff Platform Engineer"], negative: ["Sales"] },
    });
    const summary = await runSourcedScan({
      repoRoot,
      configPath,
      write: false,
      fetchImpl: async () =>
        new Response(
          JSON.stringify(
            rejected.map((title, index) => ({
              text: title,
              hostedUrl: `https://jobs.lever.co/acme/rejected-${index}`,
              categories: { location: "Remote - US" },
              descriptionPlain: `PRIVATE-CANDIDATE-DATA ${"full body ".repeat(200)}`,
            }))
          ),
          { status: 200 }
        ),
    });

    assert.equal(summary.new, 0);
    assert.equal(summary.reasonCounts.title, 6);
    assert.equal(summary.reasonCounts.titleBlocker, 1);
    assert.equal(summary.reasonCounts.titleRelevance, 5);
    assert.deepEqual(Object.keys(summary.rejectionSamples), [
      "title",
      "seniority",
      "location",
      "age",
      "salary",
      "eligibility",
      "duplicate",
      "invalid",
      "expired",
      "overflow",
    ]);
    assert.equal(summary.rejectionSamples.title.length, 3);
    assert.deepEqual(
      summary.rejectionSamples.title.map((sample) => sample.kind),
      ["blocker", "relevance", "relevance"]
    );
    assert.ok(
      summary.rejectionSamples.title.every(
        (sample) =>
          typeof sample.company === "string" &&
          typeof sample.title === "string" &&
          typeof sample.location === "string" &&
          typeof sample.reason === "string" &&
          !("url" in sample) &&
          !("bodyText" in sample) &&
          !("description" in sample)
      )
    );
    assert.doesNotMatch(JSON.stringify(summary.rejectionSamples), /PRIVATE-CANDIDATE-DATA/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("write:true captures JD artifacts without writing generated scan-result files", async () => {
  const repoRoot = tempRepo();
  try {
    const configPath = writeSourcedScanConfig(repoRoot);
    const summary = await runSourcedScan({
      repoRoot,
      fetchImpl: leverFetchStub(),
      configPath,
      write: true,
    });
    assert.match(summary.offers[0].artifacts.jd, /^workspace\/jobs\/acme-director-of-it-/);
    const jdText = readFileSync(userPath({ repoRoot }, summary.offers[0].artifacts.jd), "utf8");
    assert.match(jdText, /company: Acme/);
    assert.match(jdText, /role: Director of IT/);
    assert.match(jdText, /source: "?https:\/\/jobs\.lever\.co\/acme\/abc"?/);
    assert.match(jdText, /Own corporate IT, identity, endpoint, and automation\./);
    assert.ok(
      !existsSync(userPath({ repoRoot }, "workspace/scan-results")),
      "product scans must not write generated scan-result files"
    );
    assert.ok(
      !existsSync(userPath({ repoRoot }, "workspace/intake")),
      "product scans must not write generated intake digests"
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("structured scan output keeps more than 25 persisted offers and every handoff field", async () => {
  const repoRoot = tempRepo();
  try {
    const trackedCompanies = Array.from({ length: 30 }, (_, index) => {
      const slug = `company-${String(index + 1).padStart(2, "0")}`;
      return { name: slug, careers_url: `https://jobs.lever.co/${slug}` };
    });
    const configPath = writeSourcedScanConfig(repoRoot, {
      tracked_companies: trackedCompanies,
    });
    const summary = await runSourcedScan({
      repoRoot,
      fetchImpl: manyLeverFetchStub(),
      configPath,
      write: true,
    });

    assert.equal(summary.offers.length, 30);
    for (const offer of summary.offers) {
      assert.match(offer.id, /^sourced-/);
      assert.equal(typeof offer.fitScore, "number");
      assert.equal(typeof offer.fitBucket, "string");
      assert.equal(typeof offer.ratingReason, "string");
      assert.ok(Array.isArray(offer.ruleFlags));
      assert.match(offer.artifacts.jd, /^workspace\/jobs\/.+\.md$/);
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("no cross-call state leakage: two repoRoots with different targeting score independently", async () => {
  // The pre-refactor script cached candidate config in module-level state
  // computed once against a single fixed _scriptRoot. runSourcedScan() must
  // read fresh per call so two different repoRoots (or two requests against
  // the embedded server) never bleed scoring context into each other.
  const repoA = tempRepo();
  const repoB = tempRepo();
  try {
    const configPathA = writeSourcedScanConfig(repoA);
    const configPathB = writeSourcedScanConfig(repoB);
    writeTargeting(repoA, ["director of it"]);
    writeTargeting(repoB, ["something else entirely"]);

    const summaryA = await runSourcedScan({
      repoRoot: repoA,
      fetchImpl: leverFetchStub("Director of IT"),
      configPath: configPathA,
      write: false,
    });
    const summaryB = await runSourcedScan({
      repoRoot: repoB,
      fetchImpl: leverFetchStub("Director of IT"),
      configPath: configPathB,
      write: false,
    });

    // repoA's targeting keep-signal matches the offer title -> high base score.
    // repoB's targeting doesn't -> no keep-signal bump.
    assert.ok(
      summaryA.offers[0].score > summaryB.offers[0].score,
      `expected repoA's keep-signal match (${summaryA.offers[0].score}) to outscore repoB's non-match (${summaryB.offers[0].score})`
    );
  } finally {
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  }
});

test("gracefully returns an empty scan when config/sourced-scan.json doesn't exist yet", async () => {
  const repoRoot = tempRepo();
  try {
    const summary = await runSourcedScan({
      repoRoot,
      fetchImpl: async () => {
        throw new Error("should never fetch with zero tracked companies");
      },
      write: false,
    });
    assert.equal(summary.scanned, 0);
    assert.equal(summary.new, 0);
    assert.deepEqual(summary.offers, []);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("DB mode scans sourced companies from SQLite without config/sourced-scan.json", async () => {
  const repoRoot = tempRepo();
  try {
    candidateSetupInitialize({ repoRoot });
    companyAtsUpsert({
      repoRoot,
      entry: { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
    });

    const summary = await runSourcedScan({
      repoRoot,
      fetchImpl: leverFetchStub(),
      write: false,
    });

    assert.equal(summary.scanned, 1);
    assert.equal(summary.new, 1);
    assert.equal(summary.offers[0].company, "Acme");
    assert.equal(existsSync(userPath({ repoRoot }, "config/sourced-scan.json")), false);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("DB mode write:true stamps a successful company-board watermark", async () => {
  const repoRoot = tempRepo();
  try {
    candidateSetupInitialize({ repoRoot });
    companyAtsUpsert({
      repoRoot,
      entry: { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
    });

    await runSourcedScan({
      repoRoot,
      fetchImpl: leverFetchStub(),
      write: true,
    });

    const company = sourceConfigGet({ repoRoot, name: "sourced-scan" }).data.tracked_companies[0];
    assert.match(company.lastRunAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("DB mode scoring uses SQLite targeting when candidate YAML is absent", async () => {
  const repoA = tempRepo();
  const repoB = tempRepo();
  try {
    for (const repoRoot of [repoA, repoB]) {
      candidateSetupInitialize({ repoRoot });
      companyAtsUpsert({
        repoRoot,
        entry: { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
      });
    }
    candidateConfigPatch({
      repoRoot: repoA,
      name: "targeting",
      patch: { keep_signals: ["director of it"] },
    });
    candidateConfigPatch({
      repoRoot: repoB,
      name: "targeting",
      patch: { keep_signals: ["something else entirely"] },
    });

    const summaryA = await runSourcedScan({
      repoRoot: repoA,
      fetchImpl: leverFetchStub("Director of IT"),
      write: false,
    });
    const summaryB = await runSourcedScan({
      repoRoot: repoB,
      fetchImpl: leverFetchStub("Director of IT"),
      write: false,
    });

    assert.equal(existsSync(userPath({ repoRoot: repoA }, "candidate/targeting.yml")), false);
    assert.equal(existsSync(userPath({ repoRoot: repoB }, "candidate/targeting.yml")), false);
    assert.ok(
      summaryA.offers[0].score > summaryB.offers[0].score,
      `expected DB targeting keep-signal match (${summaryA.offers[0].score}) to outscore non-match (${summaryB.offers[0].score})`
    );
  } finally {
    closeAll();
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  }
});

test("DB mode write:true persists scan offers through sourcedUpsertBatch and exports tracker", async () => {
  const repoRoot = tempRepo();
  try {
    candidateSetupInitialize({ repoRoot });
    companyAtsUpsert({
      repoRoot,
      entry: { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
    });

    const summary = await runSourcedScan({
      repoRoot,
      fetchImpl: leverFetchStub(),
      write: true,
    });

    const db = openDb({ repoRoot });
    const rows = db
      .prepare("SELECT data FROM sourced ORDER BY rowid ASC")
      .all()
      .map((row) => JSON.parse(row.data));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].company, "Acme");
    assert.equal(rows[0].role, "Director of IT");
    assert.equal(rows[0].artifacts.jd, summary.offers[0].artifacts.jd);
    assert.equal(existsSync(userPath({ repoRoot }, rows[0].artifacts.jd)), true);
    assert.equal(rows[0].scanner.bodyChars, summary.offers[0].bodyChars);

    const jobFiles = readdirSync(userPath({ repoRoot }, "workspace/jobs")).filter((name) =>
      name.endsWith(".md")
    );
    assert.deepEqual(jobFiles, [summary.offers[0].artifacts.jd.replace("workspace/jobs/", "")]);

    const tracker = JSON.parse(
      readFileSync(userPath({ repoRoot }, "workspace/tracker.json"), "utf8")
    );
    assert.equal(tracker.sourced.length, 1);
    assert.equal(tracker.sourced[0].id, rows[0].id);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("DB mode waits for every source before persisting the globally ranked result", async () => {
  const repoRoot = tempRepo();
  const betaResponse = deferred();
  const betaRequested = deferred();
  try {
    candidateSetupInitialize({ repoRoot });
    sourceConfigPut({
      repoRoot,
      name: "sourced-scan",
      data: {
        title_filter: { positive: [], negative: [] },
        location_filter: null,
        tracked_companies: [
          { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
          { name: "Beta", careers_url: "https://jobs.lever.co/beta" },
        ],
      },
    });

    const scanPromise = runSourcedScan({
      repoRoot,
      write: true,
      fetchImpl: async (url) => {
        if (String(url).includes("/acme")) {
          return leverResponse({
            title: "Applied AI Engineer",
            url: "https://jobs.lever.co/acme/applied-ai",
          });
        }
        if (String(url).includes("/beta")) {
          betaRequested.resolve();
          return betaResponse.promise;
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    });

    await betaRequested.promise;

    const db = openDb({ repoRoot });
    const midScanRows = db
      .prepare("SELECT data FROM sourced ORDER BY id ASC")
      .all()
      .map((row) => JSON.parse(row.data));
    assert.deepEqual(
      midScanRows.map((row) => row.company),
      [],
      "no early source may persist before the global qualification and ranking pass"
    );

    const trackerPath = userPath({ repoRoot }, "workspace/tracker.json");
    if (existsSync(trackerPath)) {
      const tracker = JSON.parse(readFileSync(trackerPath, "utf8"));
      assert.deepEqual(
        tracker.sourced.map((row) => row.company),
        []
      );
    }

    betaResponse.resolve(
      leverResponse({
        title: "Identity Automation Engineer",
        url: "https://jobs.lever.co/beta/identity-automation",
      })
    );
    const summary = await scanPromise;

    assert.equal(summary.new, 2);
    assert.deepEqual(
      summary.offers.map((offer) => offer.company),
      ["Acme", "Beta"]
    );
  } finally {
    betaResponse.resolve(new Response("[]", { status: 200 }));
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("global same-run dedupe selects the richer cross-source copy regardless of source order", async () => {
  const repoRoot = tempRepo();
  const weak = { name: "Acme", careers_url: "https://jobs.lever.co/weak" };
  const rich = { name: "Acme", careers_url: "https://jobs.lever.co/rich" };
  try {
    const fetchImpl = async (url) => {
      const isRich = String(url).includes("/rich");
      return new Response(
        JSON.stringify([
          {
            text: "Staff Platform Engineer",
            hostedUrl: `https://jobs.lever.co/acme/canonical${isRich ? "" : "?source=preview"}`,
            categories: { location: "Remote - US" },
            descriptionPlain: isRich
              ? "Own a distributed platform and mentor engineers. ".repeat(20)
              : "Short preview.",
            ...(isRich ? { salaryRange: "$210,000 - $250,000" } : {}),
          },
        ]),
        { status: 200 }
      );
    };

    for (const trackedCompanies of [
      [weak, rich],
      [rich, weak],
    ]) {
      const configPath = writeSourcedScanConfig(repoRoot, { tracked_companies: trackedCompanies });
      const summary = await runSourcedScan({
        repoRoot,
        configPath,
        fetchImpl,
        write: false,
      });

      assert.equal(summary.new, 1);
      assert.equal(summary.duplicates, 1);
      assert.deepEqual(
        summary.offers.map((offer) => offer.url),
        ["https://jobs.lever.co/acme/canonical"]
      );
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("global collection preserves cross-source dedupe and final summary parity", async () => {
  const repoRoot = tempRepo();
  try {
    candidateSetupInitialize({ repoRoot });
    sourceConfigPut({
      repoRoot,
      name: "sourced-scan",
      data: {
        title_filter: { positive: ["Applied AI", "Identity"], negative: ["Sales"] },
        location_filter: { allow: ["Remote"], block: ["India"] },
        tracked_companies: [
          { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
          { name: "Beta", careers_url: "https://jobs.lever.co/beta" },
        ],
      },
    });

    const sharedUrl = "https://jobs.lever.co/shared/duplicate-role";
    const summary = await runSourcedScan({
      repoRoot,
      write: true,
      fetchImpl: async (url) => {
        if (String(url).includes("/acme")) {
          return new Response(
            JSON.stringify([
              {
                text: "Applied AI Engineer",
                hostedUrl: sharedUrl,
                categories: { location: "Remote" },
              },
              {
                text: "Sales Manager",
                hostedUrl: "https://jobs.lever.co/acme/sales",
                categories: { location: "Remote" },
              },
            ]),
            { status: 200 }
          );
        }
        if (String(url).includes("/beta")) {
          return new Response(
            JSON.stringify([
              {
                text: "Applied AI Engineer",
                hostedUrl: sharedUrl,
                categories: { location: "Remote" },
              },
              {
                text: "Identity Engineer",
                hostedUrl: "https://jobs.lever.co/beta/identity",
                categories: { location: "India" },
              },
            ]),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    });

    assert.deepEqual(
      {
        scanned: summary.scanned,
        new: summary.new,
        filteredTitle: summary.filteredTitle,
        filteredLocation: summary.filteredLocation,
        duplicates: summary.duplicates,
        invalid: summary.invalid,
        expired: summary.expired,
        errors: summary.errors,
        offers: summary.offers.map(({ company, title, url }) => ({ company, title, url })),
      },
      {
        scanned: 4,
        new: 1,
        filteredTitle: 1,
        filteredLocation: 1,
        duplicates: 1,
        invalid: 0,
        expired: 0,
        errors: [],
        offers: [{ company: "Acme", title: "Applied AI Engineer", url: sharedUrl }],
      },
      "the collected result must match a whole-scan filter/dedup pass"
    );

    const db = openDb({ repoRoot });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sourced").get().count, 1);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("DB mode write:true stamps search-source watermarks in SQLite without writing YAML", async () => {
  const repoRoot = tempRepo();
  try {
    candidateSetupInitialize({ repoRoot });
    sourceConfigPut({ repoRoot, name: "search-sources", data: searchSourcesFixture() });

    await runSourcedScan({
      repoRoot,
      fetchImpl: rssFetchStub(),
      // The SSRF guard resolves the host before ever calling fetchImpl; mock
      // it to a real public address so this stays a pure unit test with no
      // network access, same pattern as public-http-fetch.test.mjs.
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      write: true,
    });

    const stored = sourceConfigGet({ repoRoot, name: "search-sources" }).data;
    const lastRunAt = stored.searches[0].recency.lastRunAt;
    assert.match(lastRunAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(existsSync(userPath({ repoRoot }, "config/search-sources.yml")), false);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("DB ATS search sources run through Career Ops and hydrate a full JD before capture", async () => {
  const repoRoot = tempRepo();
  const boardUrl = "https://acme.bamboohr.com/careers";
  const jobUrl = "https://acme.bamboohr.com/careers/42";
  try {
    candidateSetupInitialize({ repoRoot });
    candidateConfigPatch({
      repoRoot,
      name: "profile",
      patch: {
        location: {
          home: "Denver, CO",
          remote: true,
          hybrid: true,
          onsite: true,
          relocation: [],
        },
      },
    });
    sourceConfigPut({
      repoRoot,
      name: "search-sources",
      data: {
        searches: [
          {
            provider: "bamboohr",
            source_type: "ats",
            label: "Acme careers",
            name: "Acme",
            url: boardUrl,
            enabled: true,
          },
        ],
      },
    });

    const summary = await runSourcedScan({
      repoRoot,
      write: true,
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async (url) => {
        if (String(url) === `${boardUrl}/list`) {
          return new Response(
            JSON.stringify({
              result: [
                {
                  id: "42",
                  jobOpeningName: "Staff Platform Engineer",
                  location: { city: "Denver", state: "CO" },
                },
              ],
            }),
            { status: 200 }
          );
        }
        if (String(url) === jobUrl) {
          return new Response(
            `<html><body><h1>Staff Platform Engineer</h1><p>${"Build reliable distributed systems. ".repeat(30)}</p><a href="/apply">Apply now</a></body></html>`,
            { status: 200, headers: { "content-type": "text/html" } }
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    });

    assert.equal(summary.new, 1);
    assert.equal(summary.offers[0].source, "bamboohr-api");
    assert.equal(summary.offers[0].bodyPartial, false);
    const jdText = readFileSync(userPath({ repoRoot }, summary.offers[0].artifacts.jd), "utf8");
    assert.match(jdText, /partial: false/);
    assert.match(jdText, /Build reliable distributed systems/);
    const stored = sourceConfigGet({ repoRoot, name: "search-sources" }).data;
    assert.match(stored.searches[0].recency.lastRunAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("DB RSS scan replaces a feed preview with the canonical ATS job body before capture", async () => {
  const repoRoot = tempRepo();
  const aggregatorUrl = "https://remotevibecodingjobs.com/jobs/acme-staff-engineer";
  const atsUrl = "https://job-boards.greenhouse.io/acme/jobs/123456";
  const canonicalEnding =
    "Final responsibility: preserve this complete sentence in the local job capture.";
  const canonicalBody = `${"Complete canonical job description with platform ownership. ".repeat(90)}${canonicalEnding}`;
  assert.ok(canonicalBody.length > 4000);
  try {
    candidateSetupInitialize({ repoRoot });
    sourceConfigPut({
      repoRoot,
      name: "search-sources",
      data: {
        searches: [
          {
            provider: "RemoteVibeCodingJobs",
            source_type: "rss",
            label: "Remote Vibe Coding Jobs",
            rssUrl: "https://remotevibecodingjobs.com/feed.xml",
            enabled: true,
          },
        ],
      },
    });

    const fetchImpl = async (requestedUrl) => {
      const url = String(requestedUrl);
      if (url === "https://remotevibecodingjobs.com/feed.xml") {
        return rssResponse({ company: "Acme", title: "Staff Engineer", url: aggregatorUrl });
      }
      if (url === aggregatorUrl) {
        return new Response(
          `<html><body><h1>Staff Engineer</h1><a href="${atsUrl}">Apply now</a></body></html>`,
          { status: 200 }
        );
      }
      if (url.includes("boards-api.greenhouse.io/v1/boards/acme/jobs")) {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                title: "Staff Engineer",
                absolute_url: atsUrl,
                location: { name: "United States (Remote)" },
                content: `<p>${canonicalBody}</p>`,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const summary = await runSourcedScan({
      repoRoot,
      fetchImpl,
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      write: true,
    });

    assert.equal(summary.new, 1);
    assert.equal(summary.offers[0].url, atsUrl);
    assert.equal(summary.offers[0].bodyPartial, false);
    assert.equal(summary.offers[0].capturedUrl, aggregatorUrl);
    const jdText = readFileSync(userPath({ repoRoot }, summary.offers[0].artifacts.jd), "utf8");
    assert.match(jdText, /partial: false/);
    assert.match(jdText, /Complete canonical job description/);
    assert.match(jdText, new RegExp(canonicalEnding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const frontmatterEnd = jdText.indexOf("\n---", 4);
    const frontmatter = parseYaml(jdText.slice(4, frontmatterEnd));
    assert.equal(frontmatter.source, atsUrl);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("DB RSS scan requalifies canonical job facts before capture", async () => {
  const repoRoot = tempRepo();
  const feedUrl = "https://remotevibecodingjobs.com/feed.xml";
  const roles = [
    {
      company: "Stealth Startup",
      title: "Founding Software Engineer",
      slug: "stealth",
      location: "San Francisco, CA (Remote)",
      bodyText: "Location: San Francisco Bay Area, CA (in-person).",
    },
    {
      company: "David",
      title: "Software Engineer, AI & Internal Tools",
      slug: "david",
      location: "New York, NY (Remote)",
      bodyText: "We work in the office 5 days per week in New York City.",
    },
    {
      company: "Credence",
      title: "AI Software Engineer",
      slug: "credence",
      location: "Tysons Corner, VA (Remote)",
      bodyText: "Salary Range: $120,000 - $150,000 annually.",
    },
  ];
  try {
    candidateSetupInitialize({ repoRoot });
    candidateConfigPatch({
      repoRoot,
      name: "profile",
      patch: {
        compensation: { minimum_base: 180000 },
        location: {
          home: "Brooklyn, NY",
          remote: true,
          remote_scope: "home-country",
          hybrid: true,
          onsite: false,
          max_commute_days_per_week: 2,
          relocation: [],
        },
      },
    });
    candidateConfigPatch({
      repoRoot,
      name: "targeting",
      patch: { role_buckets: [{ name: "Primary", titles: ["Software Engineer"] }] },
    });
    sourceConfigPut({
      repoRoot,
      name: "search-sources",
      data: {
        searches: [
          {
            provider: "RemoteVibeCodingJobs",
            source_type: "rss",
            label: "Remote Vibe Coding Jobs",
            rssUrl: feedUrl,
            enabled: true,
          },
        ],
      },
    });
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel>${roles
      .map(
        (role) =>
          `<item><title>${role.company} — ${role.title} (Remote)</title><link>https://remotevibecodingjobs.com/jobs/${role.slug}</link><description>Location: ${role.location.replace(" (Remote)", "")}</description><guid>${role.slug}</guid></item>`
      )
      .join("")}</channel></rss>`;

    const summary = await runSourcedScan({
      repoRoot,
      write: true,
      fetchImpl: async (url) => {
        assert.equal(String(url), feedUrl);
        return new Response(feed, { status: 200 });
      },
      hydrateOfferImpl: async (offer) => {
        const canonical = roles.find((role) => role.company === offer.company);
        return {
          ...offer,
          location: canonical.location,
          bodyText: canonical.bodyText,
          bodyPartial: false,
        };
      },
    });

    assert.equal(summary.new, 0);
    assert.equal(summary.filteredLocation, 2);
    assert.equal(summary.filteredSalary, 1);
    assert.deepEqual(summary.rejectionSamples.location.map((row) => row.reason).sort(), [
      "office-days-exceed-preference",
      "onsite-not-allowed",
    ]);
    assert.equal(summary.rejectionSamples.salary[0]?.reason, "comp-below-floor");
    assert.equal(
      openDb({ repoRoot }).prepare("SELECT COUNT(*) AS count FROM sourced").get().count,
      0
    );
    assert.equal(existsSync(userPath({ repoRoot }, "workspace/jobs")), false);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("partial preview policy waits for canonical location and compensation before rejection", async () => {
  const repoRoot = tempRepo();
  const feedUrl = "https://remotevibecodingjobs.com/misleading-preview.xml";
  try {
    candidateSetupInitialize({ repoRoot });
    candidateConfigPatch({
      repoRoot,
      name: "profile",
      patch: {
        compensation: { minimum_base: 180000 },
        location: {
          home: "Brooklyn, NY",
          remote: true,
          remote_scope: "home-country",
          hybrid: true,
          onsite: false,
          max_commute_days_per_week: 2,
          relocation: [],
        },
      },
    });
    candidateConfigPatch({
      repoRoot,
      name: "targeting",
      patch: { role_buckets: [{ name: "Primary", titles: ["Software Engineer"] }] },
    });
    sourceConfigPut({
      repoRoot,
      name: "search-sources",
      data: {
        searches: [
          {
            provider: "RemoteVibeCodingJobs",
            source_type: "rss",
            label: "Remote Vibe Coding Jobs",
            rssUrl: feedUrl,
            enabled: true,
          },
        ],
      },
    });
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>Preview Location Co — Software Engineer (Remote)</title><link>https://jobs.example.test/preview-location</link><description>Location: San Francisco Bay Area, CA (in-person)</description><guid>preview-location</guid></item>
      <item><title>Preview Comp Co — Software Engineer (Remote)</title><link>https://jobs.example.test/preview-comp</link><description>Salary Range: $100,000 - $120,000 annually.</description><guid>preview-comp</guid></item>
    </channel></rss>`;

    const summary = await runSourcedScan({
      repoRoot,
      write: false,
      fetchImpl: async (url) => {
        assert.equal(String(url), feedUrl);
        return new Response(feed, { status: 200 });
      },
      hydrateOfferImpl: async (offer) => ({
        ...offer,
        location: "Remote - United States",
        bodyText: "Salary Range: $200,000 - $240,000 annually. This is a fully remote role.",
        bodyPartial: false,
      }),
    });

    assert.equal(summary.new, 2);
    assert.equal(summary.qualified, 2);
    assert.equal(summary.filteredLocation, 0);
    assert.equal(summary.filteredSalary, 0);
    assert.deepEqual(summary.offers.map((offer) => offer.company).sort(), [
      "Preview Comp Co",
      "Preview Location Co",
    ]);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("search-source watermarks wait until the full scan is durably persisted", async () => {
  const repoRoot = tempRepo();
  const secondResponse = deferred();
  const secondRequested = deferred();
  try {
    candidateSetupInitialize({ repoRoot });
    sourceConfigPut({
      repoRoot,
      name: "search-sources",
      data: {
        searches: [
          {
            label: "First RSS",
            source_type: "rss",
            rssUrl: "https://example.test/first.xml",
            enabled: true,
            recency: { mode: "since-last-run" },
          },
          {
            label: "Second RSS",
            source_type: "rss",
            rssUrl: "https://example.test/second.xml",
            enabled: true,
            recency: { mode: "since-last-run" },
          },
        ],
      },
    });

    const scanPromise = runSourcedScan({
      repoRoot,
      write: true,
      // The SSRF guard resolves the host before ever calling fetchImpl; mock
      // it to a real public address so this stays a pure unit test with no
      // network access, same pattern as public-http-fetch.test.mjs.
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async (url) => {
        if (String(url).endsWith("/first.xml")) {
          return rssResponse({
            company: "First Co",
            title: "Applied AI Engineer",
            url: "https://example.test/jobs/first",
          });
        }
        if (String(url).endsWith("/second.xml")) {
          secondRequested.resolve();
          return secondResponse.promise;
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    });

    await secondRequested.promise;

    const midScan = sourceConfigGet({ repoRoot, name: "search-sources" }).data;
    assert.equal(
      midScan.searches[0].recency.lastRunAt,
      undefined,
      "a fetched source must not advance before the run's offers are durable"
    );
    assert.equal(
      midScan.searches[1].recency.lastRunAt,
      undefined,
      "a pending source must not receive a watermark"
    );

    secondResponse.resolve(
      rssResponse({
        company: "Second Co",
        title: "Identity Engineer",
        url: "https://example.test/jobs/second",
      })
    );
    const summary = await scanPromise;
    assert.equal(summary.new, 2);

    const completed = sourceConfigGet({ repoRoot, name: "search-sources" }).data;
    assert.match(completed.searches[0].recency.lastRunAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(completed.searches[1].recency.lastRunAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    secondResponse.resolve(new Response("", { status: 200 }));
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("an in-flight scan never stamps a replacement source URL it did not fetch", async () => {
  const repoRoot = tempRepo();
  const response = deferred();
  const requested = deferred();
  try {
    candidateSetupInitialize({ repoRoot });
    sourceConfigPut({
      repoRoot,
      name: "search-sources",
      data: {
        searches: [
          {
            id: "venue-feed",
            label: "Venue jobs",
            source_type: "rss",
            rssUrl: "https://example.test/old.xml",
            enabled: true,
            recency: { mode: "since-last-run" },
          },
        ],
      },
    });

    const scan = runSourcedScan({
      repoRoot,
      write: true,
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async (url) => {
        assert.equal(String(url), "https://example.test/old.xml");
        requested.resolve();
        return response.promise;
      },
    });
    await requested.promise;

    sourceConfigPut({
      repoRoot,
      name: "search-sources",
      data: {
        searches: [
          {
            id: "venue-feed",
            label: "Venue jobs",
            source_type: "rss",
            rssUrl: "https://example.test/new.xml",
            enabled: true,
            recency: { mode: "since-last-run" },
          },
        ],
      },
    });
    response.resolve(
      rssResponse({
        company: "Venue Co",
        title: "Event Operations Manager",
        url: "https://example.test/jobs/event-ops",
      })
    );
    await scan;

    const stored = sourceConfigGet({ repoRoot, name: "search-sources" }).data.searches[0];
    assert.equal(stored.rssUrl, "https://example.test/new.xml");
    assert.equal(stored.recency.lastRunAt, undefined);
  } finally {
    response.resolve(new Response("", { status: 200 }));
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("an in-flight company scan never stamps a replacement careers URL it did not fetch", async () => {
  const repoRoot = tempRepo();
  const response = deferred();
  const requested = deferred();
  try {
    candidateSetupInitialize({ repoRoot });
    companyAtsUpsert({
      repoRoot,
      entry: { name: "Acme", careers_url: "https://jobs.lever.co/oldco" },
    });

    const scan = runSourcedScan({
      repoRoot,
      write: true,
      fetchImpl: async (url) => {
        assert.match(String(url), /api\.lever\.co\/v0\/postings\/oldco/);
        requested.resolve();
        return response.promise;
      },
    });
    await requested.promise;

    companyAtsUpsert({
      repoRoot,
      entry: { name: "Acme", careers_url: "https://jobs.lever.co/newco" },
    });
    response.resolve(
      new Response(
        JSON.stringify([
          {
            text: "Platform Engineer",
            hostedUrl: "https://jobs.lever.co/oldco/role-1",
            categories: { location: "Remote" },
            descriptionPlain: "Build reliable infrastructure and developer tooling.",
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    await scan;

    const stored = sourceConfigGet({ repoRoot, name: "sourced-scan" }).data.tracked_companies[0];
    assert.equal(stored.careers_url, "https://jobs.lever.co/newco");
    assert.equal(stored.lastRunAt, undefined);
  } finally {
    response.resolve(new Response("[]", { status: 200 }));
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a post-fetch failure leaves the source watermark and sourced rows untouched", async () => {
  const repoRoot = tempRepo();
  try {
    candidateSetupInitialize({ repoRoot });
    sourceConfigPut({ repoRoot, name: "search-sources", data: searchSourcesFixture() });
    let activeChecks = 0;

    await assert.rejects(
      runSourcedScan({
        repoRoot,
        write: true,
        fetchImpl: rssFetchStub(),
        resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
        assertActive: () => {
          activeChecks += 1;
          if (activeChecks === 4) throw new Error("cancelled after fetch");
        },
      }),
      /cancelled after fetch/
    );

    const stored = sourceConfigGet({ repoRoot, name: "search-sources" }).data;
    assert.equal(
      stored.searches[0].recency.lastRunAt,
      undefined,
      "a failed run must retry the fetched interval"
    );
    assert.equal(
      openDb({ repoRoot }).prepare("SELECT COUNT(*) AS count FROM sourced").get().count,
      0
    );
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a successful no-op source advances while a failed sibling remains retryable", async () => {
  const repoRoot = tempRepo();
  try {
    candidateSetupInitialize({ repoRoot });
    sourceConfigPut({
      repoRoot,
      name: "search-sources",
      data: {
        searches: [
          {
            label: "Empty RSS",
            source_type: "rss",
            rssUrl: "https://example.test/empty.xml",
            enabled: true,
            recency: { mode: "since-last-run" },
          },
          {
            label: "Broken RSS",
            source_type: "rss",
            rssUrl: "https://example.test/broken.xml",
            enabled: true,
            recency: { mode: "since-last-run" },
          },
        ],
      },
    });

    const summary = await runSourcedScan({
      repoRoot,
      write: true,
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async (url) => {
        if (String(url).endsWith("/empty.xml")) {
          return new Response("<rss><channel><title>No current roles</title></channel></rss>", {
            status: 200,
          });
        }
        throw new Error("provider unavailable");
      },
    });

    assert.equal(summary.new, 0);
    assert.equal(summary.errors.length, 1);
    const stored = sourceConfigGet({ repoRoot, name: "search-sources" }).data;
    assert.match(stored.searches[0].recency.lastRunAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(stored.searches[1].recency.lastRunAt, undefined);
    assert.equal(
      openDb({ repoRoot }).prepare("SELECT COUNT(*) AS count FROM sourced").get().count,
      0
    );
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a writable DB search hides stale sourced rows that fail the current compensation floor", async () => {
  const repoRoot = tempRepo();
  try {
    candidateSetupInitialize({ repoRoot });
    candidateConfigPatch({
      repoRoot,
      name: "profile",
      patch: {
        compensation: { minimum_base: 180000 },
        authorization: { work_authorized: false, requires_sponsorship: true },
        location: {
          home: "Brooklyn, NY",
          remote: true,
          remote_scope: "home-country",
          hybrid: true,
          onsite: false,
          max_commute_days_per_week: 2,
          relocation: [],
        },
      },
    });
    candidateConfigPatch({
      repoRoot,
      name: "targeting",
      patch: {
        role_buckets: [
          {
            name: "Platform engineering",
            titles: ["Staff Platform Engineer", "Senior Software Engineer"],
          },
        ],
        search_preferences: { posting_age: { mode: "fixed-days", days: 30 } },
      },
    });
    sourceConfigPut({
      repoRoot,
      name: "sourced-scan",
      data: { title_filter: { positive: [], negative: [] }, tracked_companies: [] },
    });
    sourceConfigPut({ repoRoot, name: "search-sources", data: { searches: [] } });

    const jobsDir = userPath({ repoRoot }, "workspace/jobs");
    mkdirSync(jobsDir, { recursive: true });
    const saved = [
      {
        id: "sourced-below-floor",
        company: "Credence Example",
        role: "Senior Software Engineer",
        status: "sourced",
        link: "https://jobs.example.test/credence",
        loc: "Tysons Corner, VA (Remote)",
        artifact: "workspace/jobs/credence-example.md",
        body: "Salary Range: $120,000 - $150,000 annually.",
      },
      {
        id: "sourced-clears-floor",
        company: "Eligible Example",
        role: "Staff Platform Engineer",
        status: "sourced",
        link: "https://jobs.example.test/eligible",
        loc: "USA (Remote)",
        artifact: "workspace/jobs/eligible-example.md",
        body: "The base salary range is $190,000 - $240,000 annually.",
      },
      {
        id: "sourced-comp-unknown",
        company: "Unknown Example",
        role: "Staff Platform Engineer",
        status: "sourced",
        link: "https://jobs.example.test/unknown",
        loc: "USA (Remote)",
        artifact: "workspace/jobs/unknown-example.md",
        body: "Compensation depends on experience.",
      },
      {
        id: "sourced-reviewed-hold",
        company: "Reviewed Example",
        role: "Senior Software Engineer",
        status: "reviewed-hold",
        link: "https://jobs.example.test/reviewed",
        loc: "USA (Remote)",
        artifact: "workspace/jobs/reviewed-example.md",
        body: "Salary Range: $100,000 - $140,000 annually.",
      },
      {
        id: "sourced-below-seniority",
        company: "Junior Example",
        role: "Junior Software Engineer",
        status: "sourced",
        link: "https://jobs.example.test/junior",
        loc: "USA (Remote)",
        artifact: "workspace/jobs/junior-example.md",
        body: "The base salary range is $190,000 - $220,000 annually.",
      },
      {
        id: "sourced-foreign-remote",
        company: "Europe Example",
        role: "Staff Platform Engineer",
        status: "sourced",
        link: "https://jobs.example.test/europe",
        loc: "Europe (Remote)",
        artifact: "workspace/jobs/europe-example.md",
        body: "The base salary range is $190,000 - $220,000 annually.",
      },
      {
        id: "sourced-too-many-office-days",
        company: "Hybrid Example",
        role: "Staff Platform Engineer",
        status: "sourced",
        link: "https://jobs.example.test/hybrid",
        loc: "New York, NY (Hybrid)",
        artifact: "workspace/jobs/hybrid-example.md",
        body: "This role requires working in the office 3 days per week. Base salary: $190,000 - $220,000.",
      },
      {
        id: "sourced-too-old",
        company: "Old Example",
        role: "Staff Platform Engineer",
        status: "sourced",
        link: "https://jobs.example.test/old",
        loc: "USA (Remote)",
        postedAt: "2026-06-01T00:00:00.000Z",
        artifact: "workspace/jobs/old-example.md",
        body: "The base salary range is $190,000 - $220,000 annually.",
      },
      {
        id: "sourced-no-sponsorship",
        company: "Authorization Example",
        role: "Staff Platform Engineer",
        status: "sourced",
        link: "https://jobs.example.test/no-sponsorship",
        loc: "USA (Remote)",
        artifact: "workspace/jobs/authorization-example.md",
        body: "The base salary range is $190,000 - $220,000 annually. We do not offer visa sponsorship.",
      },
      {
        id: "sourced-unsafe-artifact",
        company: "Unknown Capture Example",
        role: "Staff Platform Engineer",
        status: "sourced",
        link: "https://jobs.example.test/unsafe-artifact",
        loc: "USA (Remote)",
        artifact: "workspace/jobs/../outside.md",
        body: "Salary range: $100,000 - $120,000 annually.",
      },
    ];
    for (const row of saved) {
      writeFileSync(
        userPath({ repoRoot }, row.artifact),
        `---\ncompany: ${row.company}\nrole: ${row.role}\npartial: true\n---\n\n${row.body}\n`
      );
    }
    sourcedUpsertBatch({
      repoRoot,
      rows: saved.map(({ artifact, body: _body, ...row }) => ({
        ...row,
        source: "fixture",
        channel: "board",
        base: "verify",
        fitScore: 80,
        fitBucket: "med",
        fitBasis: "triage",
        gate: "review",
        sourcedAt: "2026-08-27T12:00:00.000Z",
        updatedAt: "2026-08-27T12:00:00.000Z",
        artifacts: { jd: artifact },
        scanner: { bodyPartial: true },
      })),
    });

    const db = openDb({ repoRoot });
    const beforeMeta = db.prepare("SELECT version FROM meta WHERE id = 1").get().version;
    const beforeEvents = db.prepare("SELECT COUNT(*) AS count FROM activity_events").get().count;
    let guardCalls = 0;

    const summary = await runSourcedScan({
      repoRoot,
      write: true,
      writeGuard: () => {
        guardCalls += 1;
      },
    });

    const rows = new Map(
      db
        .prepare("SELECT id, data FROM sourced ORDER BY id")
        .all()
        .map((row) => [row.id, JSON.parse(row.data)])
    );
    assert.equal(summary.revalidatedExisting.examined, 9);
    assert.equal(summary.revalidatedExisting.readable, 8);
    assert.equal(summary.revalidatedExisting.unreadable, 1);
    assert.deepEqual(
      new Set(summary.revalidatedExisting.hiddenIds),
      new Set([
        "sourced-below-floor",
        "sourced-below-seniority",
        "sourced-foreign-remote",
        "sourced-too-many-office-days",
        "sourced-too-old",
        "sourced-no-sponsorship",
      ])
    );
    assert.equal(summary.revalidatedExisting.hidden, 6);
    assert.equal(rows.get("sourced-below-floor").status, "cut");
    assert.equal(rows.get("sourced-below-floor").policyRevalidation.reason, "comp-below-floor");
    assert.equal(rows.get("sourced-clears-floor").status, "sourced");
    assert.equal(rows.get("sourced-comp-unknown").status, "sourced");
    assert.equal(rows.get("sourced-reviewed-hold").status, "reviewed-hold");
    assert.equal(rows.get("sourced-below-seniority").status, "cut");
    assert.equal(rows.get("sourced-foreign-remote").status, "cut");
    assert.equal(rows.get("sourced-too-many-office-days").status, "cut");
    assert.equal(rows.get("sourced-too-old").status, "cut");
    assert.equal(rows.get("sourced-no-sponsorship").status, "cut");
    assert.equal(rows.get("sourced-unsafe-artifact").status, "sourced");
    assert.equal(db.prepare("SELECT version FROM meta WHERE id = 1").get().version, beforeMeta + 1);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM activity_events").get().count,
      beforeEvents + 1
    );
    assert.equal(guardCalls, 1);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("writable searches skip unchanged saved-job policy revalidation", async () => {
  const repoRoot = tempRepo();
  try {
    candidateSetupInitialize({ repoRoot });
    candidateConfigPatch({
      repoRoot,
      name: "profile",
      patch: { compensation: { minimum_base: 100000 } },
    });
    sourceConfigPut({
      repoRoot,
      name: "sourced-scan",
      data: { title_filter: { positive: [], negative: [] }, tracked_companies: [] },
    });
    sourceConfigPut({ repoRoot, name: "search-sources", data: { searches: [] } });
    const artifact = "workspace/jobs/policy-cache-example.md";
    mkdirSync(userPath({ repoRoot }, "workspace/jobs"), { recursive: true });
    writeFileSync(
      userPath({ repoRoot }, artifact),
      "---\ncompany: Policy Cache Co\nrole: Platform Engineer\npartial: false\n---\n\nBase salary range: $140,000 - $170,000 annually.\n"
    );
    sourcedUpsertBatch({
      repoRoot,
      rows: [
        {
          id: "sourced-policy-cache",
          company: "Policy Cache Co",
          role: "Platform Engineer",
          status: "sourced",
          link: "https://jobs.example.test/policy-cache",
          loc: "USA (Remote)",
          base: "$140,000 - $170,000",
          fitScore: 80,
          fitBucket: "high",
          fitBasis: "triage",
          gate: "review",
          sourcedAt: "2026-08-27T12:00:00.000Z",
          updatedAt: "2026-08-27T12:00:00.000Z",
          artifacts: { jd: artifact },
          scanner: { bodyPartial: false },
        },
      ],
    });

    const first = await runSourcedScan({ repoRoot, write: true });
    assert.equal(first.revalidatedExisting.skipped, false);
    assert.equal(first.revalidatedExisting.examined, 1);
    assert.match(
      sourceConfigGet({ repoRoot, name: "sourced-scan" }).data.policyRevalidation.digest,
      /^[a-f0-9]{64}$/
    );

    const second = await runSourcedScan({ repoRoot, write: true });
    assert.equal(second.revalidatedExisting.skipped, true);
    assert.equal(second.revalidatedExisting.examined, 0);

    candidateConfigPatch({
      repoRoot,
      name: "profile",
      patch: { compensation: { minimum_base: 200000 } },
    });
    const changedPolicy = await runSourcedScan({ repoRoot, write: true });
    assert.equal(changedPolicy.revalidatedExisting.skipped, false);
    assert.equal(changedPolicy.revalidatedExisting.examined, 1);
    assert.equal(changedPolicy.revalidatedExisting.hidden, 1);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("DB mode merges board offers, filters their titles, and stamps board watermarks", async () => {
  const repoRoot = tempRepo();
  try {
    candidateSetupInitialize({ repoRoot });
    sourceConfigPut({
      repoRoot,
      name: "sourced-scan",
      data: {
        title_filter: { positive: ["Director of IT", "Applied AI"], negative: [] },
        location_filter: null,
        tracked_companies: [
          { name: "Example Systems", careers_url: "https://jobs.lever.co/example" },
        ],
      },
    });
    sourceConfigPut({
      repoRoot,
      name: "search-sources",
      data: {
        searches: [
          {
            provider: "remoteok",
            source_type: "board",
            label: "RemoteOK",
            enabled: true,
            recency: { mode: "since-last-run" },
          },
        ],
      },
    });

    const summary = await runSourcedScan({
      repoRoot,
      fetchImpl: async (url) => {
        if (String(url).includes("api.lever.co")) {
          return new Response(
            JSON.stringify([
              {
                text: "Director of IT",
                hostedUrl: "https://jobs.lever.co/example/director-it",
                categories: { location: "Remote" },
              },
            ]),
            { status: 200 }
          );
        }
        if (String(url) === "https://remoteok.com/api") {
          return [
            { last_updated: 1_720_000_000, legal: "metadata" },
            {
              position: "Applied AI Engineer",
              url: "https://jobs.example.test/applied-ai",
              company: "Example Labs",
              location: "Remote",
            },
            {
              position: "Sales Manager",
              url: "https://jobs.example.test/sales",
              company: "Example Sales",
              location: "Remote",
            },
          ];
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
      write: true,
    });

    assert.equal(summary.scanned, 3);
    assert.equal(summary.new, 2);
    assert.equal(summary.filteredTitle, 1);
    assert.deepEqual(
      summary.offers.map(({ title, source }) => ({ title, source })),
      [
        { title: "Director of IT", source: "lever-api" },
        { title: "Applied AI Engineer", source: "remoteok-board" },
      ]
    );

    const stored = sourceConfigGet({ repoRoot, name: "search-sources" }).data;
    assert.match(stored.searches[0].recency.lastRunAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runSourcedScan materializes generated query-only HiringCafe sources", async () => {
  const repoRoot = tempRepo();
  try {
    candidateSetupInitialize({ repoRoot });
    candidateConfigPatch({
      repoRoot,
      name: "profile",
      patch: {
        location: {
          home: "New York, NY",
          remote: true,
          remote_scope: "home-country",
          hybrid: true,
          onsite: true,
          relocation: [],
        },
      },
    });
    candidateConfigPatch({
      repoRoot,
      name: "targeting",
      patch: {
        role_buckets: [{ name: "Bar leadership", titles: ["Bar Manager"] }],
        fit_bands: { fit_floor: 0 },
      },
    });
    sourceConfigPut({
      repoRoot,
      name: "sourced-scan",
      data: {
        title_filter: { positive: ["Bar Manager"], negative: [] },
        location_filter: null,
        tracked_companies: [],
      },
    });
    sourceConfigPut({
      repoRoot,
      name: "search-sources",
      data: {
        searches: [
          {
            provider: "HiringCafe",
            source_type: "url-query",
            label: "Bar Manager",
            query: "Bar Manager",
            enabled: true,
            recency: { mode: "since-last-run", safetyMinutes: 30 },
            searchState: { sortBy: "date" },
          },
        ],
      },
    });
    const captured = [];

    const summary = await runSourcedScan({
      repoRoot,
      write: true,
      captureBrowserSourceImpl: async (source) => {
        captured.push(source);
        return {
          offers: [
            {
              company: "Example Hospitality",
              title: "Bar Manager",
              url: "https://www.linkedin.com/jobs/view/bar-manager-1234567890",
              location: "New York, NY",
              bodyText: "Unverified browser result for a Bar Manager role in New York City.",
              bodyPartial: true,
              source: "hiringcafe-browser",
              sourceProvider: "hiringcafe",
            },
          ],
          errors: [],
          needsLogin: null,
        };
      },
      hydrateOfferImpl: async (offer) => offer,
    });

    assert.equal(captured.length, 1);
    assert.match(captured[0].url, /^https:\/\/hiring\.cafe\/\?searchState=/);
    assert.equal(new URL(captured[0].url).searchParams.has("searchState"), true);
    assert.equal(summary.scanned, 1);
    assert.equal(summary.new, 1);
    assert.deepEqual(summary.loginRequests, []);
    assert.equal(summary.offers[0].title, "Bar Manager");
    const stored = sourceConfigGet({ repoRoot, name: "search-sources" }).data;
    assert.match(stored.searches[0].recency.lastRunAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runSourcedScan preserves a login-backed session JD without public rehydration", async () => {
  const repoRoot = tempRepo();
  const fullBody =
    "Lead the beverage program, coach the team, manage inventory, and deliver polished service for a New York City venue. ".repeat(
      12
    );
  try {
    candidateSetupInitialize({ repoRoot });
    candidateConfigPatch({
      repoRoot,
      name: "profile",
      patch: {
        location: {
          home: "New York, NY",
          remote: true,
          remote_scope: "home-country",
          hybrid: true,
          onsite: true,
          relocation: [],
        },
      },
    });
    candidateConfigPatch({
      repoRoot,
      name: "targeting",
      patch: {
        role_buckets: [{ name: "Bar leadership", titles: ["Bar Manager"] }],
        fit_bands: { fit_floor: 0 },
      },
    });
    sourceConfigPut({
      repoRoot,
      name: "sourced-scan",
      data: {
        title_filter: { positive: ["Bar Manager"], negative: [] },
        location_filter: null,
        tracked_companies: [],
      },
    });
    sourceConfigPut({
      repoRoot,
      name: "search-sources",
      data: {
        searches: [
          {
            provider: "linkedin",
            platform: "linkedin",
            source_type: "browser",
            auth: true,
            label: "LinkedIn NYC",
            url: "https://www.linkedin.com/jobs/search/?keywords=bar%20manager",
            enabled: true,
          },
        ],
      },
    });
    let publicHydrationCalls = 0;

    const summary = await runSourcedScan({
      repoRoot,
      write: true,
      captureBrowserSourceImpl: async () => ({
        offers: [
          {
            company: "Example Hospitality",
            title: "Bar Manager",
            url: "https://www.linkedin.com/jobs/view/bar-manager-1234567890",
            location: "New York, NY",
            bodyText: fullBody,
            bodyPartial: false,
            bodyCapture: "session-browser",
            source: "linkedin-browser",
            sourceProvider: "linkedin",
            capturedUrl: "https://www.linkedin.com/jobs/view/bar-manager-1234567890",
          },
          {
            company: "Example Hotel",
            title: "Bar Manager",
            url: "https://www.linkedin.com/jobs/view/bar-manager-9876543210",
            location: "New York, NY",
            bodyText: "",
            bodyPartial: true,
            bodyCapture: "session-browser",
            source: "linkedin-browser",
            sourceProvider: "linkedin",
            capturedUrl: "https://www.linkedin.com/jobs/view/bar-manager-9876543210",
          },
        ],
        errors: [
          {
            company: "Example Hotel",
            error: "CareerRat could not read the full job description.",
          },
        ],
        needsLogin: null,
      }),
      hydrateOfferImpl: async () => {
        publicHydrationCalls += 1;
        throw new Error("login-backed JDs must not be rehydrated over public HTTP");
      },
    });

    assert.equal(publicHydrationCalls, 0);
    assert.equal(summary.new, 2);
    const complete = summary.offers.find((offer) => offer.company === "Example Hospitality");
    const partial = summary.offers.find((offer) => offer.company === "Example Hotel");
    assert.equal(complete.bodyPartial, false);
    assert.equal(complete.bodyChars, fullBody.trim().length);
    assert.equal(partial.bodyPartial, true);
    assert.equal(partial.bodyChars, 0);
    const jdText = readFileSync(userPath({ repoRoot }, complete.artifacts.jd), "utf8");
    assert.match(jdText, /partial: false/);
    assert.match(jdText, /Lead the beverage program/);
    assert.equal(jdText.includes(fullBody.trim()), true);
    const partialJdText = readFileSync(userPath({ repoRoot }, partial.artifacts.jd), "utf8");
    assert.match(partialJdText, /partial: true/);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runSourcedScan returns a contextual login request without failing the rest of search", async () => {
  const repoRoot = tempRepo();
  try {
    candidateSetupInitialize({ repoRoot });
    sourceConfigPut({
      repoRoot,
      name: "sourced-scan",
      data: { title_filter: { positive: [], negative: [] }, tracked_companies: [] },
    });
    sourceConfigPut({
      repoRoot,
      name: "search-sources",
      data: {
        searches: [
          {
            provider: "linkedin",
            platform: "linkedin",
            source_type: "browser",
            auth: true,
            label: "LinkedIn NYC",
            url: "https://www.linkedin.com/jobs/search/?keywords=operations",
            enabled: true,
          },
        ],
      },
    });

    const summary = await runSourcedScan({
      repoRoot,
      write: true,
      captureBrowserSourceImpl: async () => ({
        offers: [],
        errors: [],
        needsLogin: {
          platform: "linkedin",
          label: "LinkedIn",
          sourceLabel: "LinkedIn NYC",
          url: "https://www.linkedin.com/jobs/search/?keywords=operations",
          prompt: "Do you want to log into LinkedIn so I can use it?",
        },
      }),
    });

    assert.equal(summary.scanned, 0);
    assert.deepEqual(summary.errors, []);
    assert.deepEqual(summary.loginRequests, [
      {
        platform: "linkedin",
        label: "LinkedIn",
        sourceLabel: "LinkedIn NYC",
        url: "https://www.linkedin.com/jobs/search/?keywords=operations",
        prompt: "Do you want to log into LinkedIn so I can use it?",
      },
    ]);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runSourcedScan preflights the exact disabled authenticated source instead of returning a false empty search", async () => {
  const repoRoot = tempRepo();
  try {
    candidateSetupInitialize({ repoRoot });
    sourceConfigPut({
      repoRoot,
      name: "sourced-scan",
      data: { title_filter: { positive: [], negative: [] }, tracked_companies: [] },
    });
    sourceConfigPut({
      repoRoot,
      name: "search-sources",
      data: {
        searches: [
          {
            provider: "linkedin.com",
            source_type: "browser",
            auth: true,
            platform: "linkedin",
            label: "LinkedIn NYC operations",
            url: "https://www.linkedin.com/jobs/search/?keywords=operations&location=New%20York",
            enabled: false,
          },
        ],
      },
    });
    let captures = 0;

    const summary = await runSourcedScan({
      repoRoot,
      write: true,
      captureBrowserSourceImpl: async () => {
        captures += 1;
        throw new Error("a disabled source must not open before Yes");
      },
    });

    assert.equal(captures, 0);
    assert.equal(summary.scanned, 0);
    assert.deepEqual(summary.errors, []);
    assert.deepEqual(summary.loginRequests, [
      {
        platform: "linkedin",
        label: "LinkedIn",
        sourceLabel: "LinkedIn NYC operations",
        url: "https://www.linkedin.com/jobs/search/?keywords=operations&location=New%20York",
        prompt: "Do you want to log into LinkedIn so I can use it?",
      },
    ]);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("explicit config mode in a DB workspace captures output without mutating DB product state", async () => {
  const repoRoot = tempRepo();
  try {
    candidateSetupInitialize({ repoRoot });
    sourceConfigPut({ repoRoot, name: "search-sources", data: searchSourcesFixture() });
    const configPath = writeSourcedScanConfig(repoRoot);

    const summary = await runSourcedScan({
      repoRoot,
      fetchImpl: leverFetchStub(),
      configPath,
      write: true,
    });

    assert.equal(summary.scanned, 1);
    assert.equal(summary.new, 1);
    assert.deepEqual(summary.errors, []);
    assert.match(summary.offers[0].artifacts.jd, /^workspace\/jobs\/acme-director-of-it-/);
    assert.equal(existsSync(userPath({ repoRoot }, summary.offers[0].artifacts.jd)), true);

    const db = openDb({ repoRoot });
    const rows = db.prepare("SELECT data FROM sourced ORDER BY rowid ASC").all();
    assert.equal(rows.length, 0, "explicit config mode must not write sourced DB rows");
    assert.equal(
      existsSync(userPath({ repoRoot }, "workspace/tracker.json")),
      false,
      "explicit config mode must not export tracker.json through DB persistence"
    );

    const stored = sourceConfigGet({ repoRoot, name: "search-sources" }).data;
    assert.equal(
      stored.searches[0].recency.lastRunAt,
      undefined,
      "explicit config mode must not stamp DB search-source watermarks"
    );
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("explicit config mode does not dedupe against DB sourced rows", async () => {
  const repoRoot = tempRepo();
  try {
    candidateSetupInitialize({ repoRoot });
    sourcedUpsertBatch({
      repoRoot,
      rows: [
        {
          id: "sourced-existing-acme",
          company: "Acme",
          role: "Director of IT",
          status: "sourced",
          source: "scanner",
          channel: "board",
          link: "https://jobs.lever.co/acme/abc",
          loc: "Remote",
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
    const configPath = writeSourcedScanConfig(repoRoot);

    const summary = await runSourcedScan({
      repoRoot,
      fetchImpl: leverFetchStub(),
      configPath,
      write: false,
    });

    assert.equal(summary.new, 1);
    assert.equal(summary.duplicates, 0);
    assert.equal(summary.offers[0].url, "https://jobs.lever.co/acme/abc");
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("explicit config scans without DB do not mutate legacy search-sources.yml", async () => {
  const repoRoot = tempRepo();
  try {
    const configPath = writeSourcedScanConfig(repoRoot, { tracked_companies: [] });
    writeSearchSourcesConfig(repoRoot);
    const before = readFileSync(join(repoRoot, "config/search-sources.yml"), "utf8");

    await runSourcedScan({
      repoRoot,
      fetchImpl: rssFetchStub(),
      configPath,
      write: true,
    });

    const after = readFileSync(join(repoRoot, "config/search-sources.yml"), "utf8");
    assert.equal(after, before);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI (main(), behind the import.meta.url entry guard) — a real child process
// against the real repo, --company filtered to a nonexistent name so it hits
// zero network (see this file's header comment).
// ---------------------------------------------------------------------------

test("CLI still runs end-to-end post-refactor in plain JSON and summary modes", () => {
  const scriptPath = join(REPO_ROOT, "scripts/scan-sourced.mjs");
  const noMatchCompany = "zzz-does-not-exist-zzz";

  const plain = execFileSync(process.execPath, [scriptPath, "--company", noMatchCompany], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const parsed = JSON.parse(plain);
  assert.equal(parsed.scanned, 0);
  assert.equal(parsed.new, 0);
  assert.deepEqual(parsed.offers, []);

  const summaryOut = execFileSync(
    process.execPath,
    [scriptPath, "--company", noMatchCompany, "--summary"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  assert.match(summaryOut, /^Scanned: 0/m);
  assert.match(summaryOut, /Top scanner output:/);
});

test("CLI rejects removed compatibility flags instead of silently ignoring them", () => {
  const scriptPath = join(REPO_ROOT, "scripts/scan-sourced.mjs");
  for (const flag of ["--intake", "--timestamped"]) {
    const result = spawnSync(
      process.execPath,
      [scriptPath, "--company", "zzz-does-not-exist-zzz", flag],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    assert.notEqual(result.status, 0, `${flag} must not remain a silent no-op`);
    assert.match(result.stderr, /unknown option/i);
  }
});
