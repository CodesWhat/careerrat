// tests/sitemap-hardening.test.mjs: Codex findings on the sitemap provider and
// robots-check.mjs (CR70 follow-up). Offline: transports and resolvers are injected.
//
// Run:  node --test tests/sitemap-hardening.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isPathAllowed,
  matchLength,
  robotsAllows,
} from "../src/core/providers/career-ops/robots-check.mjs";
import { parseSitemapDocument } from "../src/core/providers/career-ops/vendor/sitemap.mjs";

const PUBLIC = async () => ["93.184.215.14"];
const robots = (body, status = 200, headers = {}) => ({
  fetchImpl: async () => new Response(body, { status, headers }),
  resolver: PUBLIC,
  cache: new Map(),
});

test("sitemap XML with many unclosed entries parses in linear time", () => {
  const n = 40_000;
  const xml = `<urlset>${"<url><loc>https://a.example.test/jobs/1/x</loc>".repeat(n)}</urlset>`;
  const started = performance.now();
  const doc = parseSitemapDocument(xml);
  const ms = performance.now() - started;
  // The first unclosed entry runs to the first close tag; here there is none, so no rows.
  assert.equal(doc.kind, "urlset");
  assert.ok(ms < 1500, `parse took ${ms}ms`);
});

test("sitemap XML with many unclosed roots and locs stays linear", () => {
  const xml = `${"<urlset><url><loc>".repeat(30_000)}`;
  const started = performance.now();
  assert.throws(() => parseSitemapDocument(xml), /truncated/);
  assert.ok(performance.now() - started < 1500);
});

test("sitemap XML still reads entries, CDATA and self-closed roots", () => {
  const doc = parseSitemapDocument(
    "<urlset><url><loc><![CDATA[https://a.example.test/jobs/1/x?a=1&b=2]]></loc></url><url><loc>https://a.example.test/jobs/2/y</loc></url></urlset>"
  );
  assert.deepEqual(doc.locs, [
    "https://a.example.test/jobs/1/x?a=1&b=2",
    "https://a.example.test/jobs/2/y",
  ]);
  assert.deepEqual(parseSitemapDocument("<urlset/>"), { kind: "urlset", locs: [] });
  const index = parseSitemapDocument(
    "<sitemapindex><sitemap><loc>https://a.example.test/s1.xml</loc></sitemap></sitemapindex>"
  );
  assert.equal(index.kind, "index");
});

test("a robots rule that exceeds the work budget denies the path", () => {
  const body = `User-agent: *\nDisallow: /${"a*".repeat(6000)}z$\n`;
  const path = `/${"a".repeat(3000)}b`;
  assert.equal(isPathAllowed(body, "careerrat", path), false);
});

test("matchLength throws once its budget is spent", () => {
  assert.throws(() => matchLength("/a*b*c", "/aaaaaaaaaa", { remaining: 5 }), /budget/);
});

test("an ordinary robots.txt is unaffected by the work budget", () => {
  const body = "User-agent: *\nDisallow: /private/*/x$\nAllow: /private/open\n";
  assert.equal(isPathAllowed(body, "careerrat", "/private/a/x"), false);
  assert.equal(isPathAllowed(body, "careerrat", "/jobs/1"), true);
});

test("a stalled DNS preflight ends at the deadline instead of hanging", async () => {
  const stalled = new Promise(() => {});
  const result = await Promise.race([
    robotsAllows("https://a.example.test/jobs/1", {
      fetchImpl: async () => new Response("", { status: 404 }),
      resolver: () => stalled,
      cache: new Map(),
      timeoutMs: 50,
    }),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 2000)),
  ]);
  assert.notEqual(result, "hung");
  assert.equal(result.allowed, false);
  assert.equal(result.code, "robots_timeout");
});

test("a stalled DNS preflight on a redirect hop ends at the deadline", async () => {
  let lookups = 0;
  const result = await Promise.race([
    robotsAllows("https://a.example.test/jobs/1", {
      fetchImpl: async () =>
        new Response("", {
          status: 301,
          headers: { location: "https://b.example.test/robots.txt" },
        }),
      resolver: (host) => {
        lookups += 1;
        return host === "a.example.test" ? PUBLIC() : new Promise(() => {});
      },
      cache: new Map(),
      timeoutMs: 50,
    }),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 2000)),
  ]);
  assert.equal(lookups, 2);
  assert.equal(result.code, "robots_timeout");
});

test("the caller's abort signal ends a stalled preflight and is not cached", async () => {
  const cache = new Map();
  const controller = new AbortController();
  const pending = robotsAllows("https://a.example.test/jobs/1", {
    fetchImpl: async () => new Response("", { status: 404 }),
    resolver: () => new Promise(() => {}),
    cache,
    timeoutMs: 60_000,
    signal: controller.signal,
  });
  controller.abort();
  const result = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve("hung"), 2000)),
  ]);
  assert.equal(result.code, "robots_aborted");
  assert.equal(cache.size, 0);
});

test("an HTTP 206 robots.txt is not the full policy", async () => {
  const result = await robotsAllows(
    "https://a.example.test/jobs/1",
    robots("User-agent: *\nDisallow: /nothing\n", 206)
  );
  assert.equal(result.allowed, false);
  assert.equal(result.code, "robots_partial_content");
});

test("an escaped asterisk in a rule is a literal, not a wildcard", () => {
  const body = "User-agent: *\nDisallow: /a%2Ab\n";
  assert.equal(isPathAllowed(body, "careerrat", "/axxb"), true);
  assert.equal(isPathAllowed(body, "careerrat", "/a*b"), false);
  assert.equal(matchLength("/a%2Ab", "/axxb"), -1);
});

test("an escaped dollar in a rule is a literal, not an end anchor", () => {
  const body = "User-agent: *\nDisallow: /a%24\n";
  assert.equal(isPathAllowed(body, "careerrat", "/a$x"), false);
  assert.equal(isPathAllowed(body, "careerrat", "/ab"), true);
  // A raw trailing $ still anchors, and a raw * still wildcards.
  assert.equal(matchLength("/a$", "/ab"), -1);
  assert.equal(matchLength("/a*c", "/abc"), 4);
});
