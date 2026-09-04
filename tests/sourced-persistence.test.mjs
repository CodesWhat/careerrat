import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

test("captureAndPersistOffersIfDb writes every JD artifact to its FINAL content-addressed path BEFORE opening the DB transaction, so the transaction itself does no filesystem I/O (CR-29 round 6)", () => {
  // JD writes used to happen INSIDE sourcedUpsertBatch's BEGIN IMMEDIATE
  // transaction (round 4), then were staged to a scratch path and renamed
  // after the transaction resolved (round 5). Both a crash and a rename
  // failure between commit and rename could permanently orphan an
  // already-committed row (CR-29 round 6 finding). The write now lands
  // directly at its FINAL, content-addressed path before this function ever
  // calls sourcedUpsertBatch at all — no rename step, nothing left to
  // recover after a crash. Proven directly here: `guard` runs INSIDE
  // sourcedUpsertBatch's own transaction (right after BEGIN IMMEDIATE), so
  // if every offer's final .md file is already on disk by the time guard
  // fires, the writes provably happened before the transaction opened, not
  // during it.
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

  let mdFilesSeenByGuard = null;
  const result = captureAndPersistOffersIfDb({
    repoRoot,
    offers,
    dedupeCanonical: true,
    guard: () => {
      mdFilesSeenByGuard = existsSync(jobsDir)
        ? readdirSync(jobsDir).filter((name) => name.endsWith(".md")).length
        : 0;
    },
  });

  assert.equal(
    mdFilesSeenByGuard,
    offers.length,
    "every offer's JD artifact must already be written to its final path before guard(db) — and therefore the write transaction — runs"
  );
  assert.equal(result.persistedRows, offers.length);
  assert.equal(result.failed, 0);
  assert.equal(result.ok, true);

  // Every written file must still be there once the batch resolves: all
  // five offers have distinct identities (dedupeCanonical, no collisions),
  // so every one of them won its row and none should have been discarded.
  const finalFiles = readdirSync(jobsDir).filter((name) => name.endsWith(".md"));
  assert.equal(finalFiles.length, offers.length);
  for (const row of openDb({ repoRoot }).prepare("SELECT data FROM sourced").all()) {
    const parsed = JSON.parse(row.data);
    assert.equal(existsSync(userPath({ repoRoot }, parsed.artifacts.jd)), true);
  }
});

test("a JD artifact write failure excludes the offer BEFORE any DB transaction opens, leaving no row (CR-29 round 6)", () => {
  // The write now happens before sourcedUpsertBatch is even called: a
  // failure there must abort insertion for that offer entirely, never leave
  // a row whose artifacts.jd references something that was never written.
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const jobsDir = userPath({ repoRoot }, "workspace/jobs");
  // Block EVERY artifact write, regardless of its content-addressed
  // filename: making "workspace/jobs" itself a plain FILE means
  // mkdirSync(dirname(absPath), { recursive: true }) throws ENOTDIR for any
  // offer, since an ancestor path component exists but isn't a directory.
  mkdirSync(dirname(jobsDir), { recursive: true });
  writeFileSync(jobsDir, "");

  const result = captureAndPersistOffersIfDb({
    repoRoot,
    offers: [offer({ reqId: "write-fail-1" })],
    dedupeCanonical: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.persistedRows, 0);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.failedIds, ["sourced-acme-write-fail-1"]);
  assert.equal(result.offers.length, 0);

  const rows = openDb({ repoRoot }).prepare("SELECT id FROM sourced").all();
  assert.equal(rows.length, 0, "a write failure before the transaction must leave no DB row");
});

test("a rejected transaction removes the JD artifact this batch just wrote, since no row ends up referencing it (CR-29 round 6)", () => {
  // The artifact write happens before the transaction opens, so a guard
  // rejection (or any other rollback) must not leave that write orphaned on
  // disk with nothing pointing at it.
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const jobsDir = userPath({ repoRoot }, "workspace/jobs");

  let caught;
  try {
    captureAndPersistOffersIfDb({
      repoRoot,
      offers: [offer({ reqId: "rollback-1" })],
      dedupeCanonical: true,
      guard: () => {
        throw new Error("forced rollback for the regression");
      },
    });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, "the guard rejection must propagate, not be swallowed");
  assert.equal(caught.message, "forced rollback for the regression");

  const rows = openDb({ repoRoot }).prepare("SELECT id FROM sourced").all();
  assert.equal(rows.length, 0, "the rejected transaction must leave no row");

  const remainingFiles = existsSync(jobsDir)
    ? readdirSync(jobsDir).filter((name) => name.endsWith(".md"))
    : [];
  assert.deepEqual(
    remainingFiles,
    [],
    "the written-but-unreferenced artifact must be removed after the rollback"
  );
});

test("a crash between the artifact write and the DB commit is idempotent on retry: one row ends up pointing at the artifact that already existed (CR-29 round 6)", () => {
  // Writing straight to the FINAL content-addressed path (no stage/rename
  // step) means a crash in that window leaves no pending state to recover:
  // the retry just re-renders identical content to the identical path and
  // commits normally.
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const jobsDir = userPath({ repoRoot }, "workspace/jobs");
  const crashOffer = offer({
    reqId: "crash-retry-1",
    rawText: "Body content for the crash-retry regression.",
  });

  const first = captureAndPersistOffersIfDb({
    repoRoot,
    offers: [crashOffer],
    dedupeCanonical: true,
  });
  assert.equal(first.persistedRows, 1);
  const relPath = first.offers[0].artifacts.jd;
  const absPath = userPath({ repoRoot }, relPath);
  const originalContent = readFileSync(absPath, "utf8");

  // Simulate a crash AFTER the artifact write landed (proven durable above)
  // but BEFORE the DB transaction's commit ever reached this process again:
  // delete the row directly, leaving the file exactly as a real crash
  // would.
  openDb({ repoRoot }).prepare("DELETE FROM sourced").run();
  assert.equal(openDb({ repoRoot }).prepare("SELECT id FROM sourced").all().length, 0);
  assert.equal(
    existsSync(absPath),
    true,
    "the artifact must still exist after the simulated crash"
  );

  const retried = captureAndPersistOffersIfDb({
    repoRoot,
    offers: [crashOffer],
    dedupeCanonical: true,
  });

  assert.equal(retried.persistedRows, 1);
  assert.equal(
    retried.offers[0].artifacts.jd,
    relPath,
    "the retry must re-derive the identical content-addressed path"
  );
  assert.equal(readFileSync(absPath, "utf8"), originalContent);

  const rows = openDb({ repoRoot })
    .prepare("SELECT data FROM sourced")
    .all()
    .map((row) => JSON.parse(row.data));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].artifacts.jd, relPath);

  const jobFiles = readdirSync(jobsDir).filter((name) => name.endsWith(".md"));
  assert.deepEqual(
    jobFiles,
    [relPath.replace("workspace/jobs/", "")],
    "no duplicate artifact must be created on retry"
  );
});
