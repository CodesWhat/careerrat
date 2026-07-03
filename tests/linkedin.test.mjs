// tests/linkedin.test.mjs
// node:test suite for the deterministic LinkedIn saved-search URL builder
// (src/core/providers/linkedin.mjs) — the M8 sibling of hiringcafe.mjs's
// buildHiringCafeUrl. Pure functions only, no I/O, no network.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildLinkedInSearchUrl,
  salaryBandForMinimumBase,
} from "../src/core/providers/linkedin.mjs";

// ---------------------------------------------------------------------------
// buildLinkedInSearchUrl — recipe cases from
// .agents/skills/search-jobs/SKILL.md's "LinkedIn URL-filter recipe"
// ---------------------------------------------------------------------------

test("buildLinkedInSearchUrl: keywords only — quoted, sortBy defaults to DD", () => {
  const url = buildLinkedInSearchUrl({ keywords: "Forward Deployed Engineer" });
  assert.equal(
    url,
    "https://www.linkedin.com/jobs/search/?keywords=%22Forward%20Deployed%20Engineer%22&sortBy=DD"
  );
});

test("buildLinkedInSearchUrl: matches the exact real-world shape already saved in this workspace's config/search-sources.yml", () => {
  // Real observed entry (config/search-sources.yml, `platform: linkedin`):
  //   https://www.linkedin.com/jobs/search/?keywords=%22Forward%20Deployed%20Engineer%22
  //     &location=United%20States&f_TPR=r86400&f_SB2=9&sortBy=DD
  const url = buildLinkedInSearchUrl({
    keywords: "Forward Deployed Engineer",
    location: "United States",
    postedWithin: 24, // hours -> r86400
    salaryBand: 9,
  });
  assert.equal(
    url,
    "https://www.linkedin.com/jobs/search/?keywords=%22Forward%20Deployed%20Engineer%22" +
      "&location=United%20States&f_TPR=r86400&f_SB2=9&sortBy=DD"
  );
});

test("buildLinkedInSearchUrl: f_TPR seconds — 24h/7d/30d recipe presets", () => {
  const cases = [
    { hours: 24, seconds: 86400 },
    { hours: 24 * 7, seconds: 604800 },
    { hours: 24 * 30, seconds: 2592000 },
  ];
  for (const { hours, seconds } of cases) {
    const url = buildLinkedInSearchUrl({ keywords: "Engineer", postedWithin: hours });
    assert.match(url, new RegExp(`f_TPR=r${seconds}(&|$)`), `${hours}h should encode r${seconds}`);
  }
});

test("buildLinkedInSearchUrl: f_SB2 salary band passes through verbatim", () => {
  const url = buildLinkedInSearchUrl({ keywords: "Engineer", salaryBand: 7 });
  assert.match(url, /f_SB2=7(&|$)/);
});

test("buildLinkedInSearchUrl: remote:true adds f_WT=2 before sortBy", () => {
  const url = buildLinkedInSearchUrl({ keywords: "Engineer", remote: true });
  assert.equal(
    url,
    "https://www.linkedin.com/jobs/search/?keywords=%22Engineer%22&f_WT=2&sortBy=DD"
  );
});

test("buildLinkedInSearchUrl: remote:false (default) never adds f_WT", () => {
  const url = buildLinkedInSearchUrl({ keywords: "Engineer" });
  assert.ok(!url.includes("f_WT"));
});

test("buildLinkedInSearchUrl: param order is keywords, location, f_TPR, f_SB2, f_WT, sortBy", () => {
  const url = buildLinkedInSearchUrl({
    keywords: "Engineer",
    location: "Remote",
    postedWithin: 24,
    salaryBand: 8,
    remote: true,
  });
  const order = url
    .split("?")[1]
    .split("&")
    .map((p) => p.split("=")[0]);
  assert.deepEqual(order, ["keywords", "location", "f_TPR", "f_SB2", "f_WT", "sortBy"]);
});

test("buildLinkedInSearchUrl: a custom sortBy overrides the DD default", () => {
  const url = buildLinkedInSearchUrl({ keywords: "Engineer", sortBy: "R" });
  assert.match(url, /sortBy=R$/);
});

test("buildLinkedInSearchUrl: encodes spaces as %20 (not '+') and quotes as %22 — byte-faithful to the observed real URLs", () => {
  const url = buildLinkedInSearchUrl({ keywords: "AI Solutions Architect", location: "New York" });
  assert.ok(!url.includes("+"), "must never use application/x-www-form-urlencoded '+' encoding");
  assert.match(url, /keywords=%22AI%20Solutions%20Architect%22/);
  assert.match(url, /location=New%20York/);
});

test("buildLinkedInSearchUrl: throws on missing/empty keywords", () => {
  assert.throws(() => buildLinkedInSearchUrl({}), /non-empty keywords/);
  assert.throws(() => buildLinkedInSearchUrl({ keywords: "   " }), /non-empty keywords/);
});

test("buildLinkedInSearchUrl: throws on a non-positive postedWithin", () => {
  assert.throws(
    () => buildLinkedInSearchUrl({ keywords: "Engineer", postedWithin: 0 }),
    /positive/
  );
  assert.throws(
    () => buildLinkedInSearchUrl({ keywords: "Engineer", postedWithin: -5 }),
    /positive/
  );
});

test("buildLinkedInSearchUrl: throws on a non-integer or negative salaryBand", () => {
  assert.throws(
    () => buildLinkedInSearchUrl({ keywords: "Engineer", salaryBand: 7.5 }),
    /non-negative integer/
  );
  assert.throws(
    () => buildLinkedInSearchUrl({ keywords: "Engineer", salaryBand: -1 }),
    /non-negative integer/
  );
});

test("buildLinkedInSearchUrl: salaryBand: 0 is valid (not treated as falsy/omitted)", () => {
  const url = buildLinkedInSearchUrl({ keywords: "Engineer", salaryBand: 0 });
  assert.match(url, /f_SB2=0(&|$)/);
});

// ---------------------------------------------------------------------------
// salaryBandForMinimumBase — the derivation helper (an addition beyond the
// frozen signature, documented in linkedin.mjs's header comment)
// ---------------------------------------------------------------------------

test("salaryBandForMinimumBase: matches the three data points documented in the SKILL.md recipe", () => {
  assert.equal(salaryBandForMinimumBase(160000), 7);
  assert.equal(salaryBandForMinimumBase(180000), 8);
  assert.equal(salaryBandForMinimumBase(200000), 9);
});

test("salaryBandForMinimumBase: rounds down to the nearest at-or-below band, never up", () => {
  // $175k sits between band 7 ($160k) and band 8 ($180k) — must pick 7, not 8,
  // so a real qualifying posting is never excluded by a banding mismatch.
  assert.equal(salaryBandForMinimumBase(175000), 7);
});

test("salaryBandForMinimumBase: non-positive/non-numeric input returns null rather than throwing", () => {
  assert.equal(salaryBandForMinimumBase(0), null);
  assert.equal(salaryBandForMinimumBase(-50000), null);
  assert.equal(salaryBandForMinimumBase(null), null);
  assert.equal(salaryBandForMinimumBase(undefined), null);
  assert.equal(salaryBandForMinimumBase("not a number"), null);
});
