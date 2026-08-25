import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeSourceReviewArtifact,
  parsePersistedSourceReviewTable,
  parseSourceReviewOutput,
} from "../src/core/discovery/source-review-artifact.mjs";

const EXACT_CANDIDATES = [
  {
    label: "LandEarly",
    url: "https://www.landearly.com/remote-jobs/platform-engineer",
    sourceType: "url-query",
    why: "Dated US platform roles, including senior and staff openings with pay data",
    status: "proposed",
    confidence: "high",
  },
  {
    label: "4 Day Week",
    url: "https://4dayweek.io/platform-engineering-jobs",
    sourceType: "url-query",
    why: "Fresh platform and backend listings from named employers, with US remote roles",
    status: "proposed",
    confidence: "high",
  },
  {
    label: "TrulyRemote Dev",
    url: "https://trulyremote.dev/remote-backend-engineer-jobs",
    sourceType: "url-query",
    why: "Updated backend board currently showing Staff Backend Engineer and distributed-systems roles",
    status: "proposed",
    confidence: "high",
  },
  {
    label: "Built In",
    url: "https://builtin.com/jobs/remote/dev-engineering/search/platform-engineer",
    sourceType: "url-query",
    why: "Dated US platform listings, including staff roles above the compensation floor",
    status: "proposed",
    confidence: "high",
  },
  {
    label: "RemotePilot",
    url: "https://remotepilot.dev/categories/backend-engineering/",
    sourceType: "url-query",
    why: "Staff backend, infrastructure, and distributed-systems listings",
    status: "proposed",
    confidence: "borderline",
  },
  {
    label: "DevJobsList",
    url: "https://www.devjobslist.com/",
    sourceType: "browser",
    why: "Dated remote software listings with employer and compensation details",
    status: "proposed",
    confidence: "borderline",
  },
  {
    label: "Anywhere Devs",
    url: "https://anywheredevs.com/",
    sourceType: "browser",
    why: "Landing page claims fresh remote engineering coverage but exposes no specific listings",
    status: "rejected",
    rejectionReason: "no visible dated listing",
  },
];

const PERSISTED_SOURCE_REVIEW_TABLE = [
  "I found six useful new sources. Nothing has been added yet.",
  "| # | Board | Source type | Why relevant | Status |",
  "|---|---|---|---|---|",
  "| 1 | [LandEarly](https://www.landearly.com/remote-jobs/platform-engineer) | url-query | Dated US platform roles, including senior and staff openings with pay data | NEW |",
  "| 2 | [4 Day Week](https://4dayweek.io/platform-engineering-jobs) | url-query | Fresh platform and backend listings from named employers, with US remote roles | NEW |",
  "| 3 | [TrulyRemote Dev](https://trulyremote.dev/remote-backend-engineer-jobs) | url-query | Updated backend board currently showing Staff Backend Engineer and distributed-systems roles | NEW |",
  "| 4 | [Built In](https://builtin.com/jobs/remote/dev-engineering/search/platform-engineer) | url-query | Dated US platform listings, including staff roles above the compensation floor | NEW |",
  "| 5 | [RemotePilot](https://remotepilot.dev/categories/backend-engineering/) | url-query | Staff backend, infrastructure, and distributed-systems listings | NEW (borderline: some stale or poorly categorized results) |",
  "| 6 | [DevJobsList](https://www.devjobslist.com/) | browser | Dated remote software listings with employer and compensation details | NEW (borderline: weak US staff/platform targeting) |",
  "| 7 | [Anywhere Devs](https://anywheredevs.com/) | browser | Landing page claims fresh remote engineering coverage but exposes no specific listings | REJECTED: no visible dated listing |",
  "BOARDS FOUND: 7 screened",
  "PROPOSED (new): 6 (4 high-confidence, 2 borderline/medium)",
  "REJECTED: 1 (reasons: no visible dated listing)",
  "AUTO-ADDED: none (chat handoff — writes happen via the Add source/Skip controls, not this turn)",
].join("\n");

test("source review artifact validates and derives the exact seven-board review", () => {
  const review = normalizeSourceReviewArtifact({
    kind: "source_review",
    candidates: EXACT_CANDIDATES,
  });

  assert.equal(review.kind, "source_review");
  assert.equal(review.screenedCount, 7);
  assert.equal(review.proposalCount, 6);
  assert.equal(review.highConfidenceCount, 4);
  assert.equal(review.borderlineCount, 2);
  assert.equal(review.rejectedCount, 1);
  assert.equal(review.candidates[6].rejectionReason, "no visible dated listing");
  assert.match(review.id, /^source-review-/);
  assert.equal(new Set(review.candidates.map((candidate) => candidate.id)).size, 7);
});

test("source review output strips model prose and protocol in favor of deterministic copy", () => {
  const output = parseSourceReviewOutput(
    [
      "I found six useful new sources. Nothing has been added yet.",
      "",
      "| # | Board | Source type | Why relevant | Status |",
      "|---|---|---|---|---|",
      "| 1 | [LandEarly](https://www.landearly.com/remote-jobs/platform-engineer) | url-query | Dated US platform roles, including senior and staff openings with pay data | NEW |",
      "| 2 | [4 Day Week](https://4dayweek.io/platform-engineering-jobs) | url-query | Fresh platform and backend listings from named employers, with US remote roles | NEW |",
      "| 3 | [TrulyRemote Dev](https://trulyremote.dev/remote-backend-engineer-jobs) | url-query | Updated backend board currently showing Staff Backend Engineer and distributed-systems roles | NEW |",
      "| 4 | [Built In](https://builtin.com/jobs/remote/dev-engineering/search/platform-engineer) | url-query | Dated US platform listings, including staff roles above the compensation floor | NEW |",
      "| 5 | [RemotePilot](https://remotepilot.dev/categories/backend-engineering/) | url-query | Staff backend, infrastructure, and distributed-systems listings | NEW (borderline: some stale or poorly categorized results) |",
      "| 6 | [DevJobsList](https://www.devjobslist.com/) | browser | Dated remote software listings with employer and compensation details | NEW (borderline: weak US staff/platform targeting) |",
      "| 7 | [Anywhere Devs](https://anywheredevs.com/) | browser | Landing page claims fresh remote engineering coverage but exposes no specific listings | REJECTED: no visible dated listing |",
      "",
      "BOARDS FOUND: 7 screened",
      "PROPOSED (new): 6 (4 high-confidence, 2 borderline/medium)",
      "REJECTED: 1 (reasons: no visible dated listing)",
      "AUTO-ADDED: none (chat handoff — writes happen via the Add source/Skip controls, not this turn)",
      "```careerrat:discovery",
      JSON.stringify({ kind: "source_review", candidates: EXACT_CANDIDATES }),
      "```",
    ].join("\n")
  );

  assert.equal(output.text, "I found 6 useful sources. Nothing has been added yet.");
  assert.equal(output.artifacts.length, 1);
  assert.equal(output.artifacts[0].proposalCount, 6);
  assert.doesNotMatch(JSON.stringify(output), /BOARDS FOUND|\| # \| Board|careerrat:discovery/);
});

test("source review output keeps raw persisted Markdown outside the live protocol", () => {
  const output = parseSourceReviewOutput(PERSISTED_SOURCE_REVIEW_TABLE);

  assert.equal(output.text, "I couldn't prepare the source review. Run it again.");
  assert.deepEqual(output.artifacts, []);
  assert.doesNotMatch(JSON.stringify(output), /BOARDS FOUND|AUTO-ADDED|\| # \| Board/);
});

test("persisted source review parsing converts the exact historical Markdown ledger", () => {
  const output = parsePersistedSourceReviewTable(PERSISTED_SOURCE_REVIEW_TABLE);

  assert.equal(output.text, "I found 6 useful sources. Nothing has been added yet.");
  assert.equal(output.artifacts.length, 1);
  assert.equal(output.artifacts[0].proposalCount, 6);
  assert.equal(output.artifacts[0].highConfidenceCount, 4);
  assert.equal(output.artifacts[0].borderlineCount, 2);
  assert.equal(output.artifacts[0].rejectedCount, 1);
  assert.doesNotMatch(JSON.stringify(output), /BOARDS FOUND|AUTO-ADDED|\| # \| Board/);
});

test("persisted source review parsing rejects unsafe URLs, unknown source types, and unknown statuses", () => {
  const invalidLedgers = [
    PERSISTED_SOURCE_REVIEW_TABLE.replace(
      "https://www.landearly.com/remote-jobs/platform-engineer",
      "file:///etc/passwd"
    ),
    PERSISTED_SOURCE_REVIEW_TABLE.replace(
      "| url-query | Dated US platform roles",
      "| api | Dated US platform roles"
    ),
    PERSISTED_SOURCE_REVIEW_TABLE.replace("pay data | NEW |", "pay data | MAYBE |"),
  ];

  for (const ledger of invalidLedgers) {
    const output = parsePersistedSourceReviewTable(ledger);
    assert.equal(output.text, "I couldn't prepare the source review. Run it again.");
    assert.deepEqual(output.artifacts, []);
    assert.doesNotMatch(JSON.stringify(output), /file:|AUTO-ADDED|\| # \| Board/);
  }
});

test("source review output fails closed with readable copy and no raw malformed protocol", () => {
  const output = parseSourceReviewOutput(
    [
      "I found sources.",
      "```careerrat:discovery",
      '{"kind":"source_review","candidates":[{"label":"Unsafe","url":"file:///etc/passwd"}]}',
      "```",
      "AUTO-ADDED: none",
    ].join("\n")
  );

  assert.equal(output.text, "I couldn't prepare the source review. Run it again.");
  assert.deepEqual(output.artifacts, []);
  assert.doesNotMatch(output.text, /file:|AUTO-ADDED|careerrat:discovery/);
});
