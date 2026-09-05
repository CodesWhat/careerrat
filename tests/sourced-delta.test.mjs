import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { buildRepoSeenIds } from "../scripts/delta-sourced.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { sourcedUpsertBatch } from "../src/core/db/verbs.mjs";
import {
  buildOfferIdentitySet,
  diffSnapshotOffers,
  latestSnapshotPair,
  offerIdentity,
  offerIdentityKeys,
  renderDeltaMarkdown,
  summarizeDelta,
} from "../src/core/scoring/sourced-delta.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-sourced-delta-"));
  cleanupRoots.push(repoRoot);
  mkdirSync(join(repoRoot, "workspace"), { recursive: true });
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

test("uses req ids before normalized URLs for stable offer identity", () => {
  assert.equal(
    offerIdentity({
      reqId: "hiringcafe:abc123",
      url: "https://hiring.cafe/job/abc123?utm_source=noise",
    }),
    "hiringcafe:abc123"
  );
  assert.equal(
    offerIdentity({
      url: "https://www.linkedin.com/jobs/view/444555666/?trk=public_jobs_topcard-title",
    }),
    "linkedin:444555666"
  );
  assert.equal(
    offerIdentity({
      url: "https://job-boards.greenhouse.io/acme/jobs/123?gh_jid=123&utm_campaign=x",
    }),
    "greenhouse:123"
  );
});

test("diffs current job-board snapshots against the previous snapshot", () => {
  const previous = [
    {
      company: "Acme",
      title: "Forward Deployed Engineer",
      url: "https://hiring.cafe/job/old",
      reqId: "hiringcafe:old",
    },
    {
      company: "Beta",
      title: "Director of IT",
      url: "https://jobs.ashbyhq.com/beta/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    },
  ];
  const current = [
    {
      company: "Acme",
      title: "Forward Deployed Engineer",
      url: "https://hiring.cafe/job/old",
      reqId: "hiringcafe:old",
    },
    {
      company: "Gamma",
      title: "AI Solutions Architect",
      url: "https://hiring.cafe/job/new",
      reqId: "hiringcafe:new",
    },
  ];

  const delta = diffSnapshotOffers({ current, previous });

  assert.deepEqual(
    delta.newOffers.map((offer) => offer.company),
    ["Gamma"]
  );
  assert.deepEqual(
    delta.carriedOffers.map((offer) => offer.company),
    ["Acme"]
  );
  assert.deepEqual(
    delta.removedOffers.map((offer) => offer.company),
    ["Beta"]
  );
});

test("summarizes delta counts separately from repo dedupe", () => {
  const delta = diffSnapshotOffers({
    current: [
      {
        company: "Gamma",
        title: "AI Solutions Architect",
        url: "https://hiring.cafe/job/new",
        reqId: "hiringcafe:new",
      },
      {
        company: "Acme",
        title: "Forward Deployed Engineer",
        url: "https://hiring.cafe/job/old",
        reqId: "hiringcafe:old",
      },
    ],
    previous: [
      {
        company: "Acme",
        title: "Forward Deployed Engineer",
        url: "https://hiring.cafe/job/old",
        reqId: "hiringcafe:old",
      },
    ],
    seenIds: new Set(["hiringcafe:new"]),
  });

  const summary = summarizeDelta(delta);

  assert.deepEqual(summary, {
    current: 2,
    previous: 1,
    newSincePrevious: 1,
    newAfterRepoDedupe: 0,
    carried: 1,
    removed: 0,
  });
});

test("offerIdentityKeys keeps both an aggregator's own reqId and its URL-derived Workday key", () => {
  const keys = offerIdentityKeys({
    company: "Acme",
    title: "Senior Engineer",
    hiringCafeUrl: "https://hiring.cafe/job/swfwvwmaq6basefz",
    url: "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boston/Senior-Engineer_JR12345-2",
    reqId: "hiringcafe:swfwvwmaq6basefz",
  });

  assert.ok(keys.includes("hiringcafe:swfwvwmaq6basefz"));
  assert.ok(keys.includes("workday:acme.wd5.myworkdayjobs.com:jr12345"));
});

test("recognizes a posting carried from a direct Workday snapshot into its HiringCafe-bridged representation", () => {
  // CR-29 round 3: offerIdentity reduced the bridged posting to its
  // aggregator reqId alone, shadowing the URL-derived Workday key the
  // PREVIOUS snapshot's direct posting was keyed on: reported as one new
  // role and one removed role instead of one carried role.
  const previous = [
    {
      company: "Acme",
      title: "Senior Engineer",
      url: "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boston/Senior-Engineer_JR12345",
    },
  ];
  const current = [
    {
      company: "Acme",
      title: "Senior Engineer",
      hiringCafeUrl: "https://hiring.cafe/job/swfwvwmaq6basefz",
      url: "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boston/Senior-Engineer_JR12345-2",
      reqId: "hiringcafe:swfwvwmaq6basefz",
    },
  ];

  const delta = diffSnapshotOffers({ current, previous });

  assert.deepEqual(
    delta.carriedOffers.map((offer) => offer.company),
    ["Acme"]
  );
  assert.deepEqual(delta.newOffers, []);
  assert.deepEqual(delta.removedOffers, []);
});

test("flags a HiringCafe-bridged posting as a repo duplicate of an already-seen direct Workday key", () => {
  const seenIds = buildOfferIdentitySet([
    {
      url: "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boston/Senior-Engineer_JR12345",
    },
  ]);

  const delta = diffSnapshotOffers({
    current: [
      {
        company: "Acme",
        title: "Senior Engineer",
        hiringCafeUrl: "https://hiring.cafe/job/swfwvwmaq6basefz",
        url: "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boston/Senior-Engineer_JR12345-2",
        reqId: "hiringcafe:swfwvwmaq6basefz",
      },
    ],
    previous: [],
    seenIds,
  });

  assert.equal(delta.newOffers.length, 1);
  assert.equal(delta.newOffers[0].repoDuplicate, true);
});

test("allows a one-file baseline when explicitly requested", () => {
  const dir = mkdtempSync(join(tmpdir(), "sourced-delta-"));
  const snapshotPath = join(dir, "linkedin-browser-20260608-120000.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(snapshotPath, JSON.stringify({ source: "linkedin-browser", offers: [] }));

  const pair = latestSnapshotPair({ dir, source: "linkedin-browser", baselineOk: true });

  assert.equal(pair.current, snapshotPath);
  assert.equal(pair.previous, null);
  assert.equal(pair.baseline, true);
});

test("renders baseline deltas without a previous file path", () => {
  const markdown = renderDeltaMarkdown({
    currentPath: "scan-results/linkedin-browser-20260608-120000.json",
    previousPath: null,
    delta: diffSnapshotOffers({
      current: [
        {
          company: "Acme",
          title: "Forward Deployed Engineer",
          url: "https://www.linkedin.com/jobs/view/123/",
        },
      ],
      previous: [],
    }),
    summary: {
      current: 1,
      previous: 0,
      newSincePrevious: 1,
      newAfterRepoDedupe: 1,
      carried: 0,
      removed: 0,
    },
  });

  assert.match(markdown, /Previous: `empty baseline/);
  assert.match(markdown, /Acme/);
});

test("buildRepoSeenIds includes a persisted identity alias in DB mode, so a HiringCafe-only offer is not reported as repo-new", () => {
  // CR-29 round 4: buildSeenSets' tracker.json/jobs-frontmatter projection
  // only reads each row's link/co/role, so a persisted identity alias (added
  // onto a canonical row's aliasKeys[] when an earlier duplicate's OTHER
  // representation was folded onto it) never reached repoSeen through it,
  // even though the alias is present on the exported row. A HiringCafe-only
  // representation of an already-stored direct Workday posting would then
  // show up under --repo-new-only even though DB ingestion already
  // recognizes it as the same row.
  const repoRoot = tempRepo();
  openDb({ repoRoot });

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
        // Persisted by an earlier merge (sourcedMergeIdentityAliasBatch /
        // sourcedUpsertBatch's own inline duplicate merge) when a bridged
        // HiringCafe capture of this same posting was suppressed.
        aliasKeys: ["req:hiringcafe:swfwvwmaq6basefz"],
      },
    ],
  });

  const seenIds = buildRepoSeenIds({ repoRoot });
  assert.ok(
    seenIds.has("hiringcafe:swfwvwmaq6basefz"),
    "the persisted alias must participate in the DB-mode repo-seen set"
  );

  const delta = diffSnapshotOffers({
    current: [
      {
        company: "Acme",
        title: "Senior Engineer",
        url: "https://hiring.cafe/job/swfwvwmaq6basefz",
        reqId: "hiringcafe:swfwvwmaq6basefz",
      },
    ],
    previous: [],
    seenIds,
  });

  assert.equal(delta.newOffers.length, 1);
  assert.equal(
    delta.newOffers[0].repoDuplicate,
    true,
    "an alias-only representation of an already-stored row must not be reported as repo-new"
  );
});

test("buildRepoSeenIds re-normalizes a persisted URL-only alias through sourced-delta's own normalizeUrl, so a differently-tracked republish is still recognized as repo-seen", () => {
  // CR-29 round 5: seenPostingKeys' "url:" entries are normalized through
  // sourced-identity.mjs's normalizePostingUrl (lowercases hostname, strips
  // hash, strips a trailing pathname slash) — it does NOT strip tracking
  // params. sourced-delta's own offerIdentityKeys normalizes every "url:"
  // key it computes through normalizeUrl instead, which DOES strip
  // utm_/trk/ref/gh_src/source params and a trailing slash of the whole
  // string. Importing the DB's persisted url alias verbatim (the round-4
  // fix, which only handled "req:" keys) would leave a tracking-param
  // mismatch, so a persisted URL-only alias survives ingestion but still
  // gets reported as repo-new here.
  const repoRoot = tempRepo();
  openDb({ repoRoot });

  sourcedUpsertBatch({
    repoRoot,
    rows: [
      {
        id: "sourced-url-alias-canonical",
        company: "Acme",
        role: "Platform Engineer",
        status: "sourced",
        source: "scanner",
        channel: "board",
        link: "https://acme.example.test/careers/platform-engineer",
        loc: "Remote",
        base: "verify",
        fitScore: 75,
        fitBucket: "high",
        fitBasis: "triage",
        gate: "likely-keep",
        sourcedAt: "2026-07-05T00:00:00Z",
        updatedAt: "2026-07-05T00:00:00Z",
        artifacts: {},
        // Persisted by an earlier merge for a differently-tracked republish
        // of the same posting (e.g. a paid board link with tracking params
        // this run's canonical dedupe folded onto the direct posting).
        aliasKeys: [
          "url:https://boards.example.test/careers/platform-engineer?utm_source=paid&utm_campaign=q3",
        ],
      },
    ],
  });

  const seenIds = buildRepoSeenIds({ repoRoot });
  assert.ok(
    seenIds.has("url:https://boards.example.test/careers/platform-engineer"),
    "the persisted URL alias must be re-normalized through sourced-delta's own normalizeUrl"
  );

  const delta = diffSnapshotOffers({
    current: [
      {
        company: "Acme",
        title: "Platform Engineer",
        // Same board, no tracking params, a trailing slash normalizeUrl
        // must also strip.
        url: "https://boards.example.test/careers/platform-engineer/",
      },
    ],
    previous: [],
    seenIds,
  });

  assert.equal(delta.newOffers.length, 1);
  assert.equal(
    delta.newOffers[0].repoDuplicate,
    true,
    "a persisted URL-only alias must resolve a differently-tracked republish as repo-seen"
  );
});

test("buildRepoSeenIds preserves a persisted URL alias's path/query casing, but still lowercases a requisition id (CR-29 round 6)", () => {
  // buildRepoSeenIds used to lowercase EVERY id it collected, url: keys
  // included. offerIdentityKeys' own "url:" keys are normalizeUrl-
  // normalized but never lowercased, so a persisted URL-only alias with a
  // case-sensitive path segment (e.g. a board that actually serves
  // "/Jobs/Platform-Engineer", not "/jobs/platform-engineer") got mangled
  // here and could never match the CURRENT snapshot offer's own,
  // correctly-cased key — reporting an already-persisted posting as
  // repo-new. Requisition identities carry no case-sensitive meaning and
  // must still lowercase.
  const repoRoot = tempRepo();
  openDb({ repoRoot });

  sourcedUpsertBatch({
    repoRoot,
    rows: [
      {
        id: "sourced-mixed-case-url-canonical",
        company: "Acme",
        role: "Platform Engineer",
        status: "sourced",
        source: "scanner",
        channel: "board",
        link: "https://boards.example.test/careers/Platform-Engineer",
        loc: "Remote",
        base: "verify",
        fitScore: 75,
        fitBucket: "high",
        fitBasis: "triage",
        gate: "likely-keep",
        sourcedAt: "2026-07-05T00:00:00Z",
        updatedAt: "2026-07-05T00:00:00Z",
        artifacts: {},
        // Persisted by an earlier merge for a differently-tracked republish
        // whose board serves a case-sensitive path.
        aliasKeys: [
          "url:https://boards.example.test/careers/Case-Sensitive-Path?dept=Engineering",
          "req:MIXED-CASE-REQ-123",
        ],
      },
    ],
  });

  const seenIds = buildRepoSeenIds({ repoRoot });
  assert.ok(
    seenIds.has("url:https://boards.example.test/careers/Case-Sensitive-Path?dept=Engineering"),
    "a persisted URL alias's path/query casing must be preserved, not lowercased"
  );
  assert.ok(seenIds.has("mixed-case-req-123"), "a requisition identity must still lowercase");
  assert.equal(
    seenIds.has("url:https://boards.example.test/careers/case-sensitive-path?dept=engineering"),
    false,
    "a lowercased URL must not spuriously satisfy the case-sensitive one"
  );

  const delta = diffSnapshotOffers({
    current: [
      {
        company: "Acme",
        title: "Case Sensitive Path Role",
        // Same case-sensitive board, identical casing to the persisted alias.
        url: "https://boards.example.test/careers/Case-Sensitive-Path?dept=Engineering",
      },
    ],
    previous: [],
    seenIds,
  });

  assert.equal(delta.newOffers.length, 1);
  assert.equal(
    delta.newOffers[0].repoDuplicate,
    true,
    "a mixed-case URL-only alias must still resolve an identically-cased republish as repo-seen"
  );
});

test("buildRepoSeenIds falls back to the legacy tracker.json builder when there is no DB", () => {
  const repoRoot = tempRepo();
  // No openDb() call: this repo has no SQLite database at all.
  const seenIds = buildRepoSeenIds({ repoRoot });
  assert.deepEqual(seenIds, new Set());
});
