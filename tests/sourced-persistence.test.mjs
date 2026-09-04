import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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

test("a rejected transaction leaves the JD artifact this batch just wrote on disk, since deleting it would race a concurrent committer (CR-29 round 7)", () => {
  // The artifact write happens before the transaction opens. Round 6 had a
  // guard rejection (or any other rollback) eagerly delete that write, on
  // the theory that no row ends up referencing it. Round 7 removes that
  // delete entirely: it re-checked "does any row reference this path" right
  // before unlinking, but a concurrent process could commit a row against
  // the identical content-addressed path in the gap between that check and
  // the unlink, leaving the concurrent run's durable row pointing at a file
  // this run had just deleted out from under it. The path is
  // content-addressed and therefore immutable, so leaving the orphan behind
  // is harmless disk bloat, never a correctness problem.
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
  assert.equal(
    remainingFiles.length,
    1,
    "the written-but-unreferenced artifact must survive the rollback, not be deleted"
  );
});

test("a rolled-back batch never deletes a final artifact another already-committed row references (CR-29 round 7)", () => {
  // The exact race the round-6 eager delete was vulnerable to: a row from an
  // EARLIER, already-committed batch references the same content-addressed
  // path a LATER batch re-derives (identical offer content) and then rolls
  // back. The earlier row's artifact must come out of the rollback intact.
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const sharedOffer = offer({
    reqId: "shared-artifact-1",
    rawText: "Body content shared by the committed row and the rolled-back batch.",
  });

  const committed = captureAndPersistOffersIfDb({
    repoRoot,
    offers: [sharedOffer],
    dedupeCanonical: true,
  });
  assert.equal(committed.persistedRows, 1);
  const relPath = committed.offers[0].artifacts.jd;
  const absPath = userPath({ repoRoot }, relPath);
  const originalContent = readFileSync(absPath, "utf8");

  // A second batch re-renders the SAME content-addressed path (dedupeCanonical
  // off, so it isn't recognized as a duplicate row — the case that matters is
  // purely "this batch's write lands at a path something else already
  // references") and then rolls back.
  let caught;
  try {
    captureAndPersistOffersIfDb({
      repoRoot,
      offers: [sharedOffer],
      guard: () => {
        throw new Error("forced rollback for the shared-artifact regression");
      },
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "the guard rejection must propagate");

  assert.equal(existsSync(absPath), true, "the committed row's artifact must survive intact");
  assert.equal(readFileSync(absPath, "utf8"), originalContent);
  const rows = openDb({ repoRoot })
    .prepare("SELECT data FROM sourced")
    .all()
    .map((row) => JSON.parse(row.data));
  assert.equal(rows.length, 1, "the rolled-back batch must still leave only the earlier row");
  assert.equal(rows[0].artifacts.jd, relPath);
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

test("a same-batch bridge offer spanning two legitimate postings is rejected as a conflict, not merged onto either (CR-29 round 7)", () => {
  // Before round 7, same-batch reconciliation picked the FIRST identity key
  // a bridge offer matched and blindly repointed every OTHER identity onto
  // that owner — so a bridge offer carrying one identity from each of two
  // otherwise-unrelated legitimate postings merged their ownership and
  // discarded whichever posting lost the final upsert. The shared ownership
  // rule (computeIdentityAliasMerge, src/core/db/verbs/sourced.mjs) now
  // resolves every distinct owner among the bridge's matching keys and
  // rejects the offer outright once there's more than one.
  const repoRoot = tempRepo();
  openDb({ repoRoot });

  const postingA = offer({
    title: "Staff Engineer",
    url: "https://jobs.example.test/acme/staff-engineer-a",
    reqId: "req-a",
    rawText: "Body content for posting A.",
  });
  const postingB = offer({
    title: "Senior Engineer",
    url: "https://jobs.example.test/acme/senior-engineer-b",
    reqId: "req-b",
    rawText: "Body content for posting B.",
  });
  // Carries posting A's URL (matches A's url: key) AND posting B's explicit
  // reqId (matches B's req: key) — one identity from each.
  const bridge = offer({
    title: "Bridge Role",
    url: postingA.url,
    reqId: postingB.reqId,
    rawText: "Body content for the bridge offer.",
  });

  const result = captureAndPersistOffersIfDb({
    repoRoot,
    offers: [postingA, postingB, bridge],
    dedupeCanonical: true,
  });

  assert.equal(result.persistedRows, 2, "both legitimate postings must persist");
  assert.equal(result.conflicts, 1, "the bridge offer must be counted as a conflict");
  assert.equal(result.conflictOffers.length, 1);
  assert.equal(result.conflictOffers[0].url, bridge.url);

  const rows = openDb({ repoRoot })
    .prepare("SELECT data FROM sourced")
    .all()
    .map((row) => JSON.parse(row.data));
  assert.equal(rows.length, 2, "the bridge offer must not persist as a third row");
  const titles = rows.map((row) => row.role).sort();
  assert.deepEqual(titles, ["Senior Engineer", "Staff Engineer"]);
  for (const row of rows) {
    assert.deepEqual(
      row.aliasKeys || [],
      [],
      "neither legitimate posting may absorb the bridge offer's other identity"
    );
  }
});

test("writeCanonicalCapturedJob writes through a private temp file and renames atomically, cleaning up the temp file on failure (CR-29 round 7)", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const jobsDir = userPath({ repoRoot }, "workspace/jobs");

  const first = captureAndPersistOffersIfDb({
    repoRoot,
    offers: [offer({ reqId: "atomic-write-1", rawText: "Body for the atomic-write regression." })],
    dedupeCanonical: true,
  });
  assert.equal(first.persistedRows, 1);
  const relPath = first.offers[0].artifacts.jd;
  const absPath = userPath({ repoRoot }, relPath);
  const originalContent = readFileSync(absPath, "utf8");

  // No stray "<final>.<pid>.<random>.tmp" files must survive a normal write.
  const filesAfterFirstWrite = readdirSync(jobsDir);
  assert.deepEqual(
    filesAfterFirstWrite,
    [relPath.replace("workspace/jobs/", "")],
    "no temp file must remain after a successful write"
  );

  // Simulate the row vanishing without the artifact vanishing (a crash
  // between the write and the commit, same setup as the round-6 crash-retry
  // regression above) so the retry's write hits writeCanonicalCapturedJob's
  // existing-path skip instead of being filtered out earlier by dedupe.
  // Skipping the write outright (content-addressed: an existing file at this
  // exact path can only be this same content) must leave the existing
  // artifact byte-identical, with no temp file left behind.
  openDb({ repoRoot }).prepare("DELETE FROM sourced").run();
  const retried = captureAndPersistOffersIfDb({
    repoRoot,
    offers: [offer({ reqId: "atomic-write-1", rawText: "Body for the atomic-write regression." })],
    dedupeCanonical: true,
  });
  assert.equal(retried.persistedRows, 1);
  assert.equal(readFileSync(absPath, "utf8"), originalContent);
  assert.deepEqual(readdirSync(jobsDir), [relPath.replace("workspace/jobs/", "")]);
});

test("a blocked temp-file write leaves an existing final artifact byte-identical and no temp file behind (CR-29 round 7)", () => {
  const repoRoot = tempRepo();
  openDb({ repoRoot });
  const jobsDir = userPath({ repoRoot }, "workspace/jobs");
  const blockedOffer = offer({
    reqId: "blocked-write-1",
    rawText: "Body for the blocked-write regression.",
  });

  const first = captureAndPersistOffersIfDb({
    repoRoot,
    offers: [blockedOffer],
    dedupeCanonical: true,
  });
  assert.equal(first.persistedRows, 1);
  const relPath = first.offers[0].artifacts.jd;
  const absPath = userPath({ repoRoot }, relPath);
  const originalContent = readFileSync(absPath, "utf8");

  // A DIFFERENT offer whose rendered content collides with nothing existing
  // still exercises the temp-file path (the retry above already proved the
  // existing-path skip). Block every temp file from being created under
  // workspace/jobs by making the directory read-only, then confirm the
  // existing artifact from the first write is untouched and no partial temp
  // file survives.
  const otherOffer = offer({
    title: "Other Role",
    url: "https://jobs.example.test/acme/other-role",
    reqId: "blocked-write-2",
    rawText: "Body for a second, distinct offer that must not be able to write.",
  });
  let mode;
  try {
    mode = statSync(jobsDir).mode;
  } catch {
    mode = null;
  }
  chmodSync(jobsDir, 0o555);
  let result;
  try {
    result = captureAndPersistOffersIfDb({
      repoRoot,
      offers: [otherOffer],
      dedupeCanonical: true,
    });
  } finally {
    if (mode !== null) chmodSync(jobsDir, mode);
    else chmodSync(jobsDir, 0o755);
  }

  assert.equal(result.persistedRows, 0);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.failedIds, ["sourced-acme-blocked-write-2"]);
  assert.deepEqual(result.failedOffers, [
    { id: "sourced-acme-blocked-write-2", url: otherOffer.url },
  ]);

  assert.equal(existsSync(absPath), true, "the earlier, unrelated artifact must be untouched");
  assert.equal(readFileSync(absPath, "utf8"), originalContent);
  const survivingFiles = readdirSync(jobsDir).filter((name) => !name.startsWith("."));
  assert.deepEqual(
    survivingFiles,
    [relPath.replace("workspace/jobs/", "")],
    "no temp file may survive a blocked write"
  );
});
