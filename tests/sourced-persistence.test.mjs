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
import { sourcedUpsertBatch } from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import { extractReqId } from "../src/core/scoring/sourced-identity.mjs";
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
  // CR-29 round 9: `ok` used to look only at `failed`, so a conflict-only
  // batch (zero artifact failures, one rejected bridge offer) reported
  // ok:true — both snapshot CLIs trusted that flag and exited 0 despite the
  // unresolved conflict.
  assert.equal(result.failed, 0, "this batch has no artifact-write failures");
  assert.equal(result.ok, false, "a conflict alone must still mark the batch not-ok");

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

test("a bridge offer spanning one accepted in-memory offer AND one already-persisted row is a conflict, not a persisted-duplicate shortcut (CR-29 round 8)", () => {
  // Round 7 closed the same-batch (accepted vs. accepted) and stored-row
  // (persisted vs. persisted) bridge cases, but reconcileOffersBeforeCapture
  // still took a shortcut the moment ANY of a bridge's matching keys
  // resolved to an already-PERSISTED row — without checking whether the
  // bridge ALSO matched an offer just accepted earlier in this same batch.
  // That let a bridge carrying one identity from an in-memory offer and one
  // from a persisted row attach the in-memory offer's identity onto the
  // persisted row's aliasKeys, after which the in-memory offer got rejected
  // as "that persisted row's duplicate" at the final upsert — silently
  // losing a legitimate new posting and poisoning an unrelated stored row.
  const repoRoot = tempRepo();
  openDb({ repoRoot });

  const postingP = offer({
    title: "Persisted Engineer",
    url: "https://jobs.example.test/acme/persisted-engineer",
    reqId: "req-persisted",
    rawText: "Body content for the already-persisted posting.",
  });
  const first = captureAndPersistOffersIfDb({
    repoRoot,
    offers: [postingP],
    dedupeCanonical: true,
  });
  assert.equal(first.persistedRows, 1, "posting P must be persisted before the bridge batch runs");
  const beforeP = openDb({ repoRoot })
    .prepare("SELECT data FROM sourced")
    .all()
    .map((row) => JSON.parse(row.data))[0];

  const postingA = offer({
    title: "Accepted Engineer",
    url: "https://jobs.example.test/acme/accepted-engineer",
    reqId: "req-accepted",
    rawText: "Body content for the offer accepted this batch.",
  });
  // Carries posting A's URL (matches A's in-memory url: key this batch) AND
  // posting P's explicit reqId (matches P's already-persisted req: key).
  const bridge = offer({
    title: "Bridge Role",
    url: postingA.url,
    reqId: postingP.reqId,
    rawText: "Body content for the mixed bridge offer.",
  });

  const result = captureAndPersistOffersIfDb({
    repoRoot,
    offers: [postingA, bridge],
    dedupeCanonical: true,
  });

  assert.equal(result.persistedRows, 1, "posting A must still persist");
  assert.equal(result.conflicts, 1, "the mixed bridge offer must be counted as a conflict");
  assert.equal(result.conflictOffers.length, 1);
  assert.equal(result.conflictOffers[0].url, bridge.url);

  const rows = openDb({ repoRoot })
    .prepare("SELECT data FROM sourced")
    .all()
    .map((row) => JSON.parse(row.data));
  assert.equal(rows.length, 2, "the bridge offer must not persist as a third row");

  const afterP = rows.find((row) => row.role === "Persisted Engineer");
  assert.deepEqual(
    afterP,
    beforeP,
    "the already-persisted posting must remain byte-for-byte unchanged, including its aliasKeys"
  );
  const afterA = rows.find((row) => row.role === "Accepted Engineer");
  assert.deepEqual(
    afterA?.aliasKeys || [],
    [],
    "the accepted posting must not absorb the bridge offer's other identity either"
  );
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

test("stableSourcedId leaves a short identity's persisted ID byte-identical (CR-29 round 10)", () => {
  // Regression guard for the collision fix below: an identity that never
  // needed truncation must keep producing the exact ID existing rows were
  // already persisted under, not gain a digest suffix it doesn't need.
  const rows = sourcedRowsFromScanOffers([
    offer({ reqId: "workday:acme.wd1.myworkdayjobs.com:req0001" }),
  ]);
  assert.equal(rows[0].id, "sourced-acme-workday-acme-wd1-myworkdayjobs-com-req0001");
});

test("two Workday requisitions under a maximum-length tenant hostname persist as distinct rows with no conflict (CR-29 round 10)", () => {
  // The reqId stableSourcedId slugs is "workday:<hostname>:<reqid>". A
  // maximum-length (63-character) Workday tenant label pushes the hostname
  // alone past the 80-character slug limit, so REQ0001 and REQ0002 used to
  // truncate to the identical slug and silently collide on the persisted
  // row ID: the second put overwrote the first with no conflict reported.
  const repoRoot = tempRepo();
  openDb({ repoRoot });

  const tenant = "a".repeat(63);
  const url1 = `https://${tenant}.wd5.myworkdayjobs.com/en-US/External/job/USA-Remote/Staff-Engineer_REQ0001`;
  const url2 = `https://${tenant}.wd5.myworkdayjobs.com/en-US/External/job/USA-Remote/Staff-Engineer_REQ0002`;
  const reqOne = offer({
    title: "Staff Engineer",
    url: url1,
    reqId: extractReqId(url1).id,
    rawText: "Body content for REQ0001.",
  });
  const reqTwo = offer({
    title: "Staff Engineer",
    url: url2,
    reqId: extractReqId(url2).id,
    rawText: "Body content for REQ0002.",
  });

  assert.notEqual(reqOne.reqId, reqTwo.reqId, "the two requisitions must carry distinct reqIds");

  const result = captureAndPersistOffersIfDb({
    repoRoot,
    offers: [reqOne, reqTwo],
    dedupeCanonical: true,
  });

  assert.equal(result.persistedRows, 2, "both requisitions must persist");
  assert.equal(result.conflicts, 0, "distinct requisitions must never be reported as a conflict");
  assert.equal(result.failed, 0);
  assert.equal(result.ok, true);

  const rows = openDb({ repoRoot })
    .prepare("SELECT id FROM sourced")
    .all()
    .map((row) => row.id);
  assert.equal(rows.length, 2, "neither requisition may overwrite the other's row");
  assert.equal(new Set(rows).size, 2, "the two persisted IDs must be distinct");
});

test("captureAndPersistOffersIfDb persists underscore and hyphen requisition-id spellings as two distinct rows (CR-29 round 11)", () => {
  // Codex review of PR #304: collisionSafeSlug only appended its
  // collision-avoiding digest suffix once a slug exceeded the 80-character
  // limit. "workday:acme.wd1.myworkdayjobs.com:jr_2024_00123" and
  // "...:jr-2024-00123" are both well under that limit and both collapse
  // (regex-collapsing "_" and "-" alike) to the identical short slug, so the
  // second upsert silently overwrote the first with no conflict reported.
  const repoRoot = tempRepo();
  openDb({ repoRoot });

  const underscoreOffer = offer({
    title: "Staff Engineer",
    url: "https://jobs.example.test/acme/staff-engineer-underscore",
    reqId: "workday:acme.wd1.myworkdayjobs.com:jr_2024_00123",
    rawText: "Body for the underscore-separated requisition.",
  });
  const hyphenOffer = offer({
    title: "Staff Engineer",
    url: "https://jobs.example.test/acme/staff-engineer-hyphen",
    reqId: "workday:acme.wd1.myworkdayjobs.com:jr-2024-00123",
    rawText: "Body for the hyphen-separated requisition.",
  });

  const result = captureAndPersistOffersIfDb({
    repoRoot,
    offers: [underscoreOffer, hyphenOffer],
    dedupeCanonical: true,
  });

  assert.equal(result.persistedRows, 2, "both requisition-id spellings must persist");
  assert.equal(
    result.conflicts,
    0,
    "distinct requisition ids must never be reported as a conflict"
  );
  assert.equal(result.failed, 0);
  assert.equal(result.ok, true);

  const rows = openDb({ repoRoot })
    .prepare("SELECT id FROM sourced")
    .all()
    .map((row) => row.id);
  assert.equal(
    rows.length,
    2,
    "the hyphen-separated requisition must not overwrite the underscore-separated one's row"
  );
  assert.equal(new Set(rows).size, 2, "the two persisted IDs must be distinct");
});

test("sourcedUpsertBatch rejects a same-ID put whose identity is disjoint from the stored row, instead of overwriting it (CR-29 round 11)", () => {
  // A collision-safe slug makes an accidental same-ID collision between two
  // UNRELATED postings far rarer, but not impossible (a caller can still
  // hand this verb a pre-built row.id directly). Guard the write itself:
  // when an incoming row's id already belongs to a stored row whose
  // identity keys share nothing with it, that's two different postings
  // sharing an ID by accident, not a genuine update — reject it as a
  // conflict rather than silently discarding the original row's data.
  const repoRoot = tempRepo();
  openDb({ repoRoot });

  const originalRow = {
    id: "sourced-collision-test",
    company: "Acme",
    role: "Staff Engineer",
    status: "sourced",
    source: "scanner",
    channel: "board",
    link: "https://jobs.example.test/acme/original-posting",
    loc: "Remote",
    base: "verify",
    fitScore: 80,
    fitBucket: "high",
    fitBasis: "triage",
    gate: "likely-keep",
    sourcedAt: "2026-07-05T00:00:00Z",
    updatedAt: "2026-07-05T00:00:00Z",
    artifacts: {},
  };
  sourcedUpsertBatch({ repoRoot, rows: [originalRow] });

  const collidingRow = {
    id: "sourced-collision-test",
    company: "Beta",
    role: "Totally Different Role",
    status: "sourced",
    source: "scanner",
    channel: "board",
    link: "https://jobs.example.test/beta/unrelated-posting",
    loc: "Remote",
    base: "verify",
    fitScore: 60,
    fitBucket: "med",
    fitBasis: "triage",
    gate: "review",
    sourcedAt: "2026-07-06T00:00:00Z",
    updatedAt: "2026-07-06T00:00:00Z",
    artifacts: {},
  };

  const result = sourcedUpsertBatch({ repoRoot, rows: [collidingRow] });

  assert.equal(result.created, 0);
  assert.equal(result.updated, 0);
  assert.equal(
    result.conflicts,
    1,
    "a disjoint-identity same-ID put must be reported as a conflict"
  );
  assert.deepEqual(result.acceptedIds, []);

  const stored = openDb({ repoRoot })
    .prepare("SELECT data FROM sourced WHERE id = ?")
    .get("sourced-collision-test");
  const storedRow = JSON.parse(stored.data);
  assert.equal(storedRow.company, "Acme", "the original row must survive untouched");
  assert.equal(storedRow.link, "https://jobs.example.test/acme/original-posting");
});
