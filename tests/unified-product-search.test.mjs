import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runSourcedScan } from "../scripts/scan-sourced.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import {
  candidateConfigPatch,
  candidateSetupInitialize,
  sourceConfigPut,
} from "../src/core/db/verbs.mjs";
import { runUnifiedJobSearch } from "../src/core/search/unified-job-search.mjs";

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-unified-product-search-"));
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  mkdirSync(join(repoRoot, "workspace"), { recursive: true });
  return repoRoot;
}

function rssResponse() {
  return new Response(
    `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Public engineering jobs</title>
    <item>
      <title>Board Company — Staff Backend Engineer (Remote)</title>
      <link>https://jobs.example.test/board-company/staff-backend</link>
      <description>Build distributed backend systems and developer infrastructure.</description>
      <guid>staff-backend</guid>
      <pubDate>Thu, 27 Aug 2026 12:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`,
    { status: 200 }
  );
}

test("unified product search tops up company ATS, configured, and saved browser sources with AI", async () => {
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
          remote_scope: "worldwide",
          hybrid: true,
          onsite: false,
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
            name: "Engineering",
            titles: [
              "Staff Platform Engineer",
              "Staff Backend Engineer",
              "Developer Experience Engineer",
            ],
          },
        ],
        fit_bands: { fit_floor: 0 },
      },
    });
    sourceConfigPut({
      repoRoot,
      name: "sourced-scan",
      data: {
        title_filter: {
          positive: [
            "Staff Platform Engineer",
            "Staff Backend Engineer",
            "Developer Experience Engineer",
          ],
          negative: [],
        },
        location_filter: null,
        tracked_companies: [
          { name: "ATS Company", careers_url: "https://jobs.lever.co/ats-company" },
        ],
      },
    });
    sourceConfigPut({
      repoRoot,
      name: "search-sources",
      data: {
        searches: [
          {
            provider: "Public engineering feed",
            source_type: "rss",
            label: "Public engineering feed",
            rssUrl: "https://feeds.example.test/engineering.xml",
            enabled: true,
          },
          {
            provider: "saved-browser",
            source_type: "browser",
            label: "Saved engineering search",
            url: "https://jobs.example.test/saved-engineering-search",
            enabled: true,
          },
        ],
      },
    });

    const events = [];
    const result = await runUnifiedJobSearch({
      searchExecutionId: "search-provider-neutral",
      runDeterministic: async ({ searchExecutionId }) => {
        events.push(`deterministic:${searchExecutionId}`);
        return runSourcedScan({
          repoRoot,
          write: false,
          resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
          fetchImpl: async (url) => {
            if (String(url).includes("api.lever.co")) {
              return new Response(
                JSON.stringify([
                  {
                    text: "Staff Platform Engineer",
                    hostedUrl: "https://jobs.lever.co/ats-company/staff-platform",
                    categories: { location: "Remote - US" },
                    descriptionPlain: "Own the internal platform and distributed systems.",
                  },
                ]),
                { status: 200 }
              );
            }
            if (String(url) === "https://feeds.example.test/engineering.xml") {
              return rssResponse();
            }
            throw new Error(`unexpected fetch: ${url}`);
          },
          captureBrowserSourceImpl: async (source) => {
            assert.equal(source.url, "https://jobs.example.test/saved-engineering-search");
            return {
              offers: [
                {
                  company: "Browser Company",
                  title: "Developer Experience Engineer",
                  url: "https://jobs.example.test/browser-company/developer-experience",
                  location: "New York, NY",
                  bodyText: "Improve developer tooling and the internal platform.",
                  source: "saved-browser",
                  sourceProvider: "saved-browser",
                },
              ],
              errors: [],
              needsLogin: null,
            };
          },
        });
      },
      runAiWeb: async ({ searchExecutionId, deterministic }) => {
        events.push(`ai:${searchExecutionId}`);
        assert.equal(deterministic.status, "succeeded");
        assert.equal(
          deterministic.result.offers.length,
          3,
          JSON.stringify(
            deterministic.result.offers.map(({ company, title, source }) => ({
              company,
              title,
              source,
            }))
          )
        );
        return {
          ok: true,
          offers: [
            {
              company: "Open Web Company",
              title: "Staff Infrastructure Engineer",
              url: "https://careers.example.test/open-web-company/staff-infrastructure",
              source: "ai-web-search",
            },
          ],
        };
      },
    });

    assert.deepEqual(events, [
      "deterministic:search-provider-neutral",
      "ai:search-provider-neutral",
    ]);
    assert.equal(result.ok, true);
    assert.equal(
      result.lanes.aiWeb.status,
      "succeeded",
      JSON.stringify(result.lanes.aiWeb.error || {})
    );
    assert.equal(result.lanes.deterministic.status, "succeeded");
    assert.equal(result.partial, false);
    assert.deepEqual(result.lanes.deterministic.result.offers.map((offer) => offer.source).sort(), [
      "Public engineering feed",
      "lever-api",
      "saved-browser",
    ]);
    assert.equal(result.lanes.aiWeb.result.offers[0].source, "ai-web-search");
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
