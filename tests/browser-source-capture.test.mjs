import assert from "node:assert/strict";
import test from "node:test";

import { captureBrowserSearchSource } from "../src/core/search/browser-source-capture.mjs";

const resolvePublic = async (rawUrl) => ({ ok: true, url: new URL(rawUrl).toString() });

function source(overrides = {}) {
  return {
    provider: "linkedin",
    platform: "linkedin",
    source_type: "browser",
    auth: true,
    label: "LinkedIn NYC",
    url: "https://www.linkedin.com/jobs/search/?keywords=bar%20manager",
    enabled: true,
    ...overrides,
  };
}

test("captureBrowserSearchSource captures an already-authenticated source through the app session", async () => {
  const calls = [];
  const session = {
    available: true,
    async open(url) {
      calls.push(["open", url]);
      return { url, title: "Bar manager jobs", text: "Jobs matching your search" };
    },
    async extractRows(input) {
      calls.push(["extractRows", input]);
      return {
        rows: [
          {
            title: "Bar Manager",
            company: "Example Hospitality",
            location: "New York, NY",
            url: "https://www.linkedin.com/jobs/view/bar-manager-1234567890",
          },
        ],
      };
    },
  };

  const result = await captureBrowserSearchSource({
    source: source(),
    session,
    resolvePublicTargetImpl: resolvePublic,
  });

  assert.equal(result.needsLogin, null);
  assert.deepEqual(result.errors, []);
  assert.equal(result.offers.length, 1);
  assert.deepEqual(
    {
      company: result.offers[0].company,
      title: result.offers[0].title,
      url: result.offers[0].url,
      location: result.offers[0].location,
      source: result.offers[0].source,
      sourceProvider: result.offers[0].sourceProvider,
      bodyPartial: result.offers[0].bodyPartial,
    },
    {
      company: "Example Hospitality",
      title: "Bar Manager",
      url: "https://www.linkedin.com/jobs/view/bar-manager-1234567890",
      location: "New York, NY",
      source: "linkedin-browser",
      sourceProvider: "linkedin",
      bodyPartial: true,
    }
  );
  assert.deepEqual(
    calls.map(([name]) => name),
    ["open", "extractRows"]
  );
});

test("captureBrowserSearchSource returns one contextual login handoff instead of a permission error", async () => {
  let extracted = false;
  const session = {
    available: true,
    async open(_url) {
      return {
        url: "https://www.linkedin.com/login",
        title: "Sign in",
        text: "Email address Password Sign in",
      };
    },
    async extractRows() {
      extracted = true;
      return { rows: [] };
    },
  };

  const result = await captureBrowserSearchSource({
    source: source(),
    session,
    resolvePublicTargetImpl: resolvePublic,
  });

  assert.equal(extracted, false);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.needsLogin, {
    platform: "linkedin",
    label: "LinkedIn",
    sourceLabel: "LinkedIn NYC",
    url: "https://www.linkedin.com/jobs/search/?keywords=bar%20manager",
    prompt: "Do you want to log into LinkedIn so I can use it?",
  });
});

test("captureBrowserSearchSource captures posting-shaped rows from an arbitrary enabled source", async () => {
  const session = {
    available: true,
    async open(url) {
      return { url, title: "Open roles", text: "Venue Operations Manager" };
    },
    async extractRows() {
      return {
        rows: [
          {
            title: "Venue Operations Manager",
            company: "Example Venue",
            location: "New York, NY",
            url: "https://jobs.example.com/openings/venue-operations-manager",
          },
          { title: "Browse jobs", company: "", location: "", url: "https://jobs.example.com" },
        ],
      };
    },
  };

  const result = await captureBrowserSearchSource({
    source: source({
      provider: "jobs.example.com",
      platform: undefined,
      auth: false,
      source_type: "url-query",
      label: "Example Venue jobs",
      url: "https://jobs.example.com/search?q=operations",
    }),
    session,
    resolvePublicTargetImpl: resolvePublic,
  });

  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].company, "Example Venue");
  assert.equal(result.offers[0].title, "Venue Operations Manager");
});

test("captureBrowserSearchSource reports unavailable app browser without consent-matrix language", async () => {
  const result = await captureBrowserSearchSource({
    source: source(),
    session: { available: false, reason: "No callable browser surface is installed." },
  });

  assert.equal(result.offers.length, 0);
  assert.equal(result.needsLogin, null);
  assert.deepEqual(result.errors, [
    {
      company: "LinkedIn NYC",
      error: "No callable browser surface is installed.",
    },
  ]);
  assert.doesNotMatch(result.errors[0].error, /consent|permission|automation/i);
});

test("captureBrowserSearchSource rejects a source whose hostname resolves to a private address", async () => {
  let opened = false;
  const result = await captureBrowserSearchSource({
    source: source({ url: "https://jobs.example.test/search" }),
    session: {
      available: true,
      async open() {
        opened = true;
        return {};
      },
    },
    resolvePublicTargetImpl: async () => ({
      ok: false,
      reason: "host resolved to a private, local, or non-public address",
    }),
  });

  assert.equal(opened, false);
  assert.equal(result.offers.length, 0);
  assert.match(result.errors[0].error, /private|non-public/i);
});

test("captureBrowserSearchSource rejects a redirect that lands on a private address before extraction", async () => {
  let extracted = false;
  const result = await captureBrowserSearchSource({
    source: source({ url: "https://jobs.example.test/search" }),
    session: {
      available: true,
      async open() {
        return { url: "http://127.0.0.1:7777/admin", title: "Admin", text: "private" };
      },
      async extractRows() {
        extracted = true;
        return { rows: [] };
      },
    },
    resolvePublicTargetImpl: async (rawUrl) =>
      String(rawUrl).includes("127.0.0.1")
        ? { ok: false, reason: "private or local host is not fetchable" }
        : { ok: true, url: new URL(rawUrl).toString() },
  });

  assert.equal(extracted, false);
  assert.equal(result.offers.length, 0);
  assert.match(result.errors[0].error, /private|local/i);
});
