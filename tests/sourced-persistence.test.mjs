import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import {
  captureAndPersistOffersIfDb,
  sourcedRowsFromScanOffers,
} from "../src/core/scoring/sourced-persistence.mjs";

function offer(overrides = {}) {
  return {
    company: "Acme",
    title: "Staff Engineer",
    url: "https://jobs.example.test/acme/staff-engineer",
    bodyPartial: false,
    ...overrides,
  };
}

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-sourced-persistence-"));
  cleanupRoots.push(repoRoot);
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

test("sourced rows recover explicit base-pay and salary ranges from canonical bodies", () => {
  const rows = sourcedRowsFromScanOffers([
    offer({
      bodyText: "The base pay range for this role is $180,000 - $220,000 per year.",
    }),
    offer({
      title: "Principal Engineer",
      url: "https://jobs.example.test/acme/principal-engineer",
      bodyText: "The annual salary range is $205,000 - $255,000.",
    }),
    offer({
      title: "Engineering Director",
      url: "https://jobs.example.test/acme/engineering-director",
      bodyText: "Estimated Base Pay Range\n$175,000—$196,800 USD",
    }),
  ]);

  assert.equal(rows[0].base, "$180,000 - $220,000");
  assert.equal(rows[1].base, "$205,000 - $255,000");
  assert.equal(rows[2].base, "$175,000—$196,800 USD");
});

test("sourced rows keep bonus, OTE, equity, and total-comp ranges unverified", () => {
  const bodies = [
    "The salary range, inclusive of annual bonus, is $180,000 - $240,000.",
    "The OTE range for this role is $210,000 - $280,000.",
    "The equity grant range is $150,000 - $225,000.",
    "Total compensation, including base salary and bonus, ranges from $220,000 - $300,000.",
    "Zone 1 Pay:\n$183,000 - $229,000 USD\nThis pay is in addition to salary, bonus, and equity.",
  ];

  const rows = sourcedRowsFromScanOffers(
    bodies.map((bodyText, index) =>
      offer({
        title: `Staff Engineer ${index}`,
        url: `https://jobs.example.test/acme/staff-engineer-${index}`,
        bodyText,
      })
    )
  );

  assert.deepEqual(
    rows.map((row) => row.base),
    ["verify", "verify", "verify", "verify", "verify"]
  );
});

test("existing offer compensation takes precedence over canonical-body extraction", () => {
  const [row] = sourcedRowsFromScanOffers([
    offer({
      comp: "$230,000 - $270,000 base",
      bodyText: "The base salary range is $180,000 - $220,000.",
    }),
  ]);

  assert.equal(row.base, "$230,000 - $270,000 base");
});

test("generic compensation is classified instead of assumed to be base pay", () => {
  const rows = sourcedRowsFromScanOffers([
    offer({ comp: "$180,000 - $220,000 base salary" }),
    offer({
      title: "Lead Bartender",
      url: "https://jobs.example.test/acme/lead-bartender",
      comp: "$90,000 - $110,000 including tips",
    }),
    offer({
      title: "Account Executive",
      url: "https://jobs.example.test/acme/account-executive",
      comp: "$180,000 - $240,000 total compensation including equity",
    }),
  ]);

  assert.deepEqual(
    rows.map(({ base, tc, compBasis }) => ({ base, tc, compBasis })),
    [
      { base: "$180,000 - $220,000 base salary", tc: null, compBasis: undefined },
      {
        base: "verify",
        tc: "$90,000 - $110,000 including tips",
        compBasis: "annual-earnings",
      },
      { base: "verify", tc: null, compBasis: undefined },
    ]
  );
});

test("sourced rows persist base pay and annual earnings separately", () => {
  const [row] = sourcedRowsFromScanOffers([
    offer({
      baseComp: "$11.35 per hour",
      annualEarningsComp: "$95,000 - $120,000 including tips",
      bodyText:
        "Base pay: $11.35 per hour. Estimated annual earnings including tips: $95,000 - $120,000.",
    }),
  ]);

  assert.equal(row.base, "$11.35 per hour");
  assert.equal(row.tc, "$95,000 - $120,000 including tips");
  assert.equal(row.compBasis, "annual-earnings");
});

test("CR5 closeout: sourced persistence retains explicit unsupported ISO currency evidence", () => {
  const rows = sourcedRowsFromScanOffers(
    ["CHF", "AUD", "PLN"].map((currency, index) =>
      offer({
        title: `Staff Engineer ${index}`,
        url: `https://jobs.example.test/acme/staff-engineer-${index}`,
        bodyText: `Base salary: 90k-110k ${currency} per year.`,
      })
    )
  );

  assert.deepEqual(
    rows.map(({ base }) => base),
    ["90k-110k CHF", "90k-110k AUD", "90k-110k PLN"]
  );
});

test("partial bodies do not infer compensation but existing offer compensation still wins", () => {
  const rows = sourcedRowsFromScanOffers([
    offer({
      bodyPartial: true,
      bodyText: "The base salary range is $180,000 - $220,000.",
    }),
    offer({
      title: "Principal Engineer",
      url: "https://jobs.example.test/acme/principal-engineer",
      comp: "$240,000 - $280,000 base",
      bodyPartial: true,
      bodyText: "The visible excerpt says the base salary range starts at $180,000.",
    }),
  ]);

  assert.equal(rows[0].base, "verify");
  assert.equal(rows[1].base, "$240,000 - $280,000 base");
});

test("sourced rows preserve qualification unknowns and unverified search status", () => {
  const [row] = sourcedRowsFromScanOffers([
    offer({
      qualificationUnknowns: ["compensation", "location"],
      source: "ai-web-search",
      bodyPartial: true,
      bodyText: "Unverified open-web evidence for a specific employer and role.",
    }),
  ]);

  assert.deepEqual(row.scanner.qualificationUnknowns, ["compensation", "location"]);
  assert.equal(row.scanner.unverified, true);
});

test("captureAndPersistOffersIfDb stages every JD artifact BEFORE opening the DB transaction, so the transaction itself does no filesystem I/O (CR-29 round 5)", () => {
  // JD writes used to happen INSIDE sourcedUpsertBatch's BEGIN IMMEDIATE
  // transaction, so lock duration scaled with batch size and document size.
  // The write is now staged (scratch path, plain writeFileSync) before this
  // function ever calls sourcedUpsertBatch at all; only a rename happens
  // after the transaction resolves. Proven directly here: `guard` runs
  // INSIDE sourcedUpsertBatch's own transaction (right after BEGIN
  // IMMEDIATE), so if every offer's staged file is already on disk by the
  // time guard fires, the writes provably happened before the transaction
  // opened, not during it.
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const jobsDir = userPath({ repoRoot }, "workspace/jobs");

  const offers = ["alpha", "beta", "gamma", "delta", "epsilon"].map((slug) => ({
    company: "Writer Contention Co",
    title: `${slug} Engineer`,
    url: `https://jobs.example.test/writer-contention/${slug}`,
    reqId: `writer-contention-${slug}`,
    rawText: `Body content for the writer-contention regression: ${slug}.`,
  }));

  let stagedFilesSeenByGuard = null;
  const result = captureAndPersistOffersIfDb({
    repoRoot,
    offers,
    dedupeCanonical: true,
    guard: () => {
      stagedFilesSeenByGuard = existsSync(jobsDir)
        ? readdirSync(jobsDir).filter((name) => name.includes(".staging-")).length
        : 0;
    },
  });

  assert.equal(
    stagedFilesSeenByGuard,
    offers.length,
    "every offer's JD artifact must already be staged to disk before guard(db) — and therefore the write transaction — runs"
  );
  assert.equal(result.persistedRows, offers.length);
  assert.equal(result.failed, 0);

  // Every staged scratch file must be gone once the batch resolves: the
  // winners were renamed to their final deterministic path, and none lost
  // their slot here (dedupeCanonical, all distinct identities), so nothing
  // should remain to discard either.
  const remainingStagingFiles = readdirSync(jobsDir).filter((name) => name.includes(".staging-"));
  assert.deepEqual(remainingStagingFiles, []);
});
