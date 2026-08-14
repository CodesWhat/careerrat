import assert from "node:assert/strict";
import test from "node:test";

import { isBoardProviderSupported, scanBoards } from "../src/core/scoring/sourced-scanner.mjs";

test("isBoardProviderSupported recognizes supported providers case-insensitively", () => {
  for (const provider of ["remoteok", "RemoteOK", "REMOTIVE", "workingnomads", "WorkingNomads"]) {
    assert.equal(isBoardProviderSupported(provider), true, provider);
  }

  for (const provider of ["unknown", null, undefined]) {
    assert.equal(isBoardProviderSupported(provider), false, String(provider));
  }
});

test("scanBoards fetches only enabled supported board sources and tags offers", async () => {
  const fetched = [];
  const result = await scanBoards(
    {
      sources: [
        { provider: "RemoteOK", source_type: "board", label: "Remote board", enabled: true },
        { provider: "remotive", source_type: "board", enabled: false },
        { provider: "unknown", source_type: "board", enabled: true },
        { provider: "workingnomads", source_type: "rss", enabled: true },
      ],
    },
    {
      fetchImpl: async (url) => {
        fetched.push(url);
        return [
          {
            position: "Applied AI Engineer",
            url: "https://jobs.example.test/applied-ai",
            company: "Example Labs",
          },
        ];
      },
    }
  );

  assert.deepEqual(fetched, ["https://remoteok.com/api"]);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.offers, [
    {
      title: "Applied AI Engineer",
      url: "https://jobs.example.test/applied-ai",
      company: "Example Labs",
      location: "",
      postedAt: null,
      source: "remoteok-board",
    },
  ]);
});

test("scanBoards accepts searches and isolates per-source fetch errors", async () => {
  const result = await scanBoards(
    {
      searches: [
        { provider: "remotive", source_type: "board", label: "Broken Remotive" },
        { provider: "remoteok", source_type: "board" },
        { provider: "workingnomads", source_type: "board" },
      ],
    },
    {
      fetchImpl: async (url) => {
        const hostname = new URL(url).hostname;
        if (hostname === "remotive.com") throw new Error("feed unavailable");
        if (hostname === "remoteok.com") throw new Error("remote feed unavailable");
        if (hostname === "workingnomads.com" || hostname === "www.workingnomads.com") {
          return [
            {
              title: "Solutions Engineer",
              url: "https://jobs.example.test/solutions",
              company_name: "Example Works",
            },
          ];
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    }
  );

  assert.deepEqual(result.errors, [
    { company: "Broken Remotive", error: "feed unavailable" },
    { company: "remoteok", error: "remote feed unavailable" },
  ]);
  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].source, "workingnomads-board");
});
