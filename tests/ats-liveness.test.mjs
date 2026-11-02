import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { closeAll } from "../src/core/db/connection.mjs";
import { jobLinkCheckLast, jobLinkCheckRecord } from "../src/core/db/verbs/search-liveness.mjs";
import { candidateSetupInitialize } from "../src/core/db/verbs.mjs";
import { atsLivenessTarget } from "../src/core/liveness/ats-liveness.mjs";
import { closedSinceLastCheck } from "../src/core/liveness/closed-since.mjs";
import { checkUrlLiveness } from "../src/core/liveness/job-link-checker.mjs";

const resolveHost = async () => [{ address: "93.184.216.34", family: 4 }];
const fixture = (name) =>
  readFileSync(new URL(`./fixtures/ats-liveness/${name}`, import.meta.url), "utf8");
const json = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

const GH = "https://boards.greenhouse.io/acme/jobs/4012345006";
const LEVER = "https://jobs.lever.co/acme/5f2c8a1e-9b3d-4c77-8a10-2d6e0b7f4a91";
const ASHBY = "https://jobs.ashbyhq.com/acme/9a8b7c6d-5e4f-4321-8fed-cba987654321";
const WORKABLE = "https://apply.workable.com/acme/j/A1B2C3D4E5";
const SR = "https://jobs.smartrecruiters.com/AcmeCo/743999876543210-qa-lead";

// Routes requests by host; records every URL so tests can prove the page was not scraped.
function router(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    for (const [needle, handler] of routes) {
      if (String(url).includes(needle)) return handler(String(url));
    }
    return new Response("<html><body>page</body></html>", { status: 200 });
  };
  return { fetchImpl, calls };
}

const open = [
  [GH, "boards-api.greenhouse.io", () => json(fixture("greenhouse-job.json"))],
  [LEVER, "api.lever.co", () => json(fixture("lever-job.json"))],
  [ASHBY, "api.ashbyhq.com", () => json(fixture("ashby-board.json"))],
  [WORKABLE, "api.workable.com", () => json(fixture("workable-job.json"))],
  [SR, "api.smartrecruiters.com", () => json(fixture("smartrecruiters-job.json"))],
];
const apiNeedle = {
  [GH]: "boards-api.greenhouse.io",
  [LEVER]: "api.lever.co",
  [ASHBY]: "api.ashbyhq.com",
  [WORKABLE]: "/api/v2/accounts/",
  [SR]: "api.smartrecruiters.com",
};

test("open postings are confirmed by the ATS API without fetching the page", async () => {
  for (const [url, , handler] of open) {
    const { fetchImpl, calls } = router([[apiNeedle[url], handler]]);
    const result = await checkUrlLiveness(url, { fetchImpl, resolveHost });
    assert.equal(result.result, "active", url);
    assert.equal(result.code, "ats_open");
    assert.ok(!calls.includes(url), `page fetched for ${url}`);
  }
});

test("a 404/410 from the ATS API closes the posting", async () => {
  for (const url of [GH, LEVER, WORKABLE, SR]) {
    for (const status of [404, 410]) {
      const { fetchImpl } = router([[apiNeedle[url], () => new Response("{}", { status })]]);
      const result = await checkUrlLiveness(url, { fetchImpl, resolveHost });
      assert.equal(result.result, "expired", `${url} ${status}`);
      assert.equal(result.code, "ats_gone");
    }
  }
});

test("Ashby is closed when the board listing no longer has the job, and when the board is gone", async () => {
  const board = JSON.parse(fixture("ashby-board.json"));
  board.jobs = board.jobs.filter((job) => !ASHBY.includes(job.id));
  const delisted = router([["api.ashbyhq.com", () => json(JSON.stringify(board))]]);
  assert.equal((await checkUrlLiveness(ASHBY, { ...delisted, resolveHost })).result, "expired");
  const noBoard = router([["api.ashbyhq.com", () => new Response("", { status: 404 })]]);
  assert.equal((await checkUrlLiveness(ASHBY, { ...noBoard, resolveHost })).result, "expired");
});

test("network errors and 429/5xx are never a closed verdict; the page check runs instead", async () => {
  for (const url of [GH, LEVER, ASHBY, WORKABLE, SR]) {
    const failures = [
      () => {
        throw new Error("socket hang up");
      },
      () => new Response("slow down", { status: 429 }),
      () => new Response("oops", { status: 503 }),
      () => json("not json at all"),
    ];
    for (const failure of failures) {
      const { fetchImpl, calls } = router([[apiNeedle[url], failure]]);
      const result = await checkUrlLiveness(url, { fetchImpl, resolveHost });
      assert.notEqual(result.result, "expired", url);
      assert.ok(calls.includes(url), `fell back to the page check for ${url}`);
    }
  }
});

test("non-ATS URLs and unsupported ATS shapes skip the ATS lookup", () => {
  assert.equal(atsLivenessTarget("https://example.com/careers/1"), null);
  assert.equal(atsLivenessTarget("https://boards.greenhouse.io/acme"), null);
  assert.equal(atsLivenessTarget("https://jobs.lever.co/acme"), null);
  assert.equal(atsLivenessTarget("not a url"), null);
});

test("atsNative: false keeps the page-only check", async () => {
  const { fetchImpl, calls } = router([]);
  await checkUrlLiveness(GH, { fetchImpl, resolveHost, atsNative: false });
  assert.deepEqual(calls, [GH]);
});

test("closed-since-last-check compares against the recorded ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "careerrat-links-ledger-"));
  mkdirSync(join(dir, "config"), { recursive: true });
  try {
    candidateSetupInitialize({ repoRoot: dir });
    jobLinkCheckRecord({
      repoRoot: dir,
      entries: [
        { url: GH, result: "active" },
        { url: LEVER, result: "expired" },
      ],
    });
    const previous = jobLinkCheckLast({ repoRoot: dir });
    const results = [
      { url: GH, result: "expired" },
      { url: LEVER, result: "expired" },
      { url: ASHBY, result: "expired" },
      { url: SR, result: "active" },
    ];
    assert.deepEqual(closedSinceLastCheck(previous, results), [GH]);
  } finally {
    closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
