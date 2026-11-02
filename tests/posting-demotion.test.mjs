import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { closeAll } from "../src/core/db/connection.mjs";
import {
  postingSightingsLoad,
  postingSightingsRecord,
} from "../src/core/db/verbs/posting-sightings.mjs";
import { candidateSetupInitialize } from "../src/core/db/verbs.mjs";
import { buildSearchSources } from "../src/core/profile/generate-search-sources.mjs";
import { buildTitleFilter, filterAndDedupeOffers } from "../src/core/scoring/sourced-scanner.mjs";
import { assessScanDemotion } from "../src/core/search/posting-demotion.mjs";

const NOW = Date.parse("2026-01-15T00:00:00Z");
const targeting = {
  role_buckets: [{ name: "Accounting", priority: "primary", titles: ["Senior Accountant"] }],
};
const profile = {};
const longBody = "Reconcile ledgers and close the books each month. ".repeat(20);

test("clean postings are not demoted", () => {
  assert.equal(
    assessScanDemotion(
      { title: "Senior Accountant", bodyText: longBody, postedAt: "2026-01-10" },
      { targeting, now: NOW }
    ),
    null
  );
});

test("evergreen language, very old and repost history each demote with a reason", () => {
  const evergreen = assessScanDemotion(
    { title: "Senior Accountant", bodyText: `${longBody} Join our talent community.` },
    { targeting, now: NOW }
  );
  assert.ok(evergreen.points >= 15);
  assert.match(evergreen.reasons.join(" "), /evergreen/);

  const old = assessScanDemotion(
    { title: "Senior Accountant", bodyText: longBody, postedAt: "2025-05-01" },
    { targeting, now: NOW }
  );
  assert.ok(old.signals.includes("very-old"));

  const repost = assessScanDemotion(
    { title: "Senior Accountant", bodyText: longBody, postedAt: "2026-01-10" },
    {
      targeting,
      now: NOW,
      history: {
        seenCount: 2,
        firstSeen: "2025-12-01T00:00:00Z",
        lastSeen: "2026-01-01T00:00:00Z",
        urlCount: 3,
      },
    }
  );
  assert.deepEqual(repost.signals, ["reposted"]);
});

test("legitimacy.enabled false turns demotion off", () => {
  assert.equal(
    assessScanDemotion(
      { title: "x", bodyText: "Join our talent community." },
      { targeting: { ...targeting, legitimacy: { enabled: false } }, now: NOW }
    ),
    null
  );
});

function scan(offers, postingHistory) {
  const generated = buildSearchSources(targeting, profile);
  return filterAndDedupeOffers(offers, {
    titleFilter: buildTitleFilter(generated.title_filter, targeting),
    config: { targeting, profile },
    now: NOW,
    postingHistory,
    perCompanyCap: 5,
  });
}

test("a ghost-looking posting ranks below an equal clean one but is never cut", () => {
  const base = { title: "Senior Accountant", location: "Remote", postedAt: "2026-01-10" };
  const result = scan([
    {
      ...base,
      company: "Ghost Co",
      url: "https://example.com/g",
      bodyText: `${longBody} Join our talent community.`,
    },
    { ...base, company: "Real Co", url: "https://example.com/r", bodyText: longBody },
  ]);
  assert.deepEqual(
    result.kept.map((o) => o.company),
    ["Real Co", "Ghost Co"]
  );
  const ghost = result.kept[1];
  assert.match(ghost.ratingReason, /ranked lower: .*evergreen/);
  assert.ok(ghost.demotion.points > 0);
  assert.equal(ghost.score, result.kept[0].score);
});

test("sightings accumulate across scans and flag changing links", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-sightings-"));
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  mkdirSync(join(repoRoot, "workspace"), { recursive: true });
  try {
    candidateSetupInitialize({ repoRoot });
    for (const [i, url] of ["a", "b", "b", "c"].entries()) {
      postingSightingsRecord({
        repoRoot,
        entries: [{ key: "acme|accountant", url: `https://x.test/${url}` }],
        now: new Date(Date.UTC(2026, 0, 1 + i)),
      });
    }
    const row = postingSightingsLoad({ repoRoot }).get("acme|accountant");
    assert.equal(row.seenCount, 4);
    assert.equal(row.urlCount, 3);
    assert.equal(row.firstSeen, "2026-01-01T00:00:00.000Z");
    assert.equal(row.lastSeen, "2026-01-04T00:00:00.000Z");
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
