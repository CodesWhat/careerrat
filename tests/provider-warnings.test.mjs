import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchCareerOpsProvider } from "../src/core/providers/career-ops-registry.mjs";
import { scanBoards } from "../src/core/scoring/sourced-scanner.mjs";

// The builtin adapter reports "nothing to scan" with console.error and returns
// no jobs. Before this, that line only went to stderr, which the terminal
// search worker discards, so the run looked clean.
const EMPTY_BUILTIN = { name: "Warn Board", provider: "builtin", source_type: "board" };

test("fetchCareerOpsProvider hands vendor console.error warnings to the caller's sink", async () => {
  const warnings = [];
  const jobs = await fetchCareerOpsProvider("builtin", EMPTY_BUILTIN, {
    fetchImpl: async () => new Response("", { status: 200 }),
    warnings,
  });
  assert.deepEqual(jobs, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no queries: or categories: configured/);
});

test("scanBoards returns provider warnings per source and keeps concurrent sources apart", async () => {
  const results = await Promise.all([
    scanBoards(
      { sources: [{ ...EMPTY_BUILTIN, label: "Board A", enabled: true }] },
      { fetchImpl: async () => new Response("", { status: 200 }) }
    ),
    scanBoards(
      { sources: [{ ...EMPTY_BUILTIN, label: "Board B", enabled: true }] },
      { fetchImpl: async () => new Response("", { status: 200 }) }
    ),
  ]);
  assert.equal(results[0].warnings.length, 1);
  assert.equal(results[0].warnings[0].company, "Board A");
  assert.equal(results[1].warnings.length, 1);
  assert.equal(results[1].warnings[0].company, "Board B");
});

test("a stored --query reaches providers that read searchKeywords", async () => {
  const bodies = [];
  await fetchCareerOpsProvider(
    "glints",
    { name: "Glints board", provider: "glints", query: "data analyst" },
    {
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async (_url, init = {}) => {
        bodies.push(String(init.body || ""));
        return new Response(JSON.stringify({ data: { searchJobsV3: { jobsInPage: [] } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    }
  ).catch(() => {});
  assert.ok(bodies.length > 0, "provider should have made a request");
  assert.match(bodies[0], /"SearchTerm":"data analyst"/);
});
