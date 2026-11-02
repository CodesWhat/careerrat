import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runSourcedScan } from "../scripts/scan-sourced.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import { deadBoardList } from "../src/core/db/verbs/search-liveness.mjs";
import {
  candidateSetupInitialize,
  companyAtsRemove,
  companyAtsUpsert,
} from "../src/core/db/verbs.mjs";
import { classifyBoardOutcome, planDeadBoardSkips } from "../src/core/search/dead-boards.mjs";

const resolveHost = async () => [{ address: "93.184.216.34", family: 4 }];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-dead-boards-"));
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  mkdirSync(join(repoRoot, "workspace"), { recursive: true });
  return repoRoot;
}

// Counts requests per slug; `status` decides what each slug answers.
function countingFetch(status) {
  const calls = [];
  const impl = async (url) => {
    const slug = String(url).match(/postings\/([^/?]+)/)?.[1];
    calls.push(slug);
    const code = typeof status === "function" ? status(slug) : status;
    const body = code === 200 ? "[]" : "gone";
    return new Response(body, { status: code, headers: { "content-type": "application/json" } });
  };
  return { impl, calls };
}

async function withRepo(fn) {
  const repoRoot = tempRepo();
  try {
    candidateSetupInitialize({ repoRoot });
    companyAtsUpsert({
      repoRoot,
      entry: { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
    });
    companyAtsUpsert({
      repoRoot,
      entry: { name: "Live", careers_url: "https://jobs.lever.co/live" },
    });
    await fn(repoRoot);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

const run = (repoRoot, fetchImpl, extra = {}) =>
  runSourcedScan({ repoRoot, fetchImpl, resolveHost, write: true, ...extra });

test("classifyBoardOutcome: only 404/410 with nothing else is dead", () => {
  assert.equal(
    classifyBoardOutcome({ errors: [{ error: "HTTP 404 Not Found" }], offers: [] }),
    "dead"
  );
  assert.equal(classifyBoardOutcome({ errors: [{ error: "HTTP 410" }], offers: [] }), "dead");
  for (const error of [
    "HTTP 500",
    "HTTP 429",
    "HTTP 403",
    "fetch timed out after 15000ms",
    "fetch failed",
  ]) {
    assert.equal(classifyBoardOutcome({ errors: [{ error }], offers: [] }), "unknown", error);
  }
  assert.equal(classifyBoardOutcome({ errors: [], offers: [] }), "alive");
  assert.equal(classifyBoardOutcome({ errors: [{ error: "HTTP 404" }], offers: [{}] }), "unknown");
});

test("a board dead on 2 consecutive runs gets 0 requests on the third and is listed once", async () => {
  await withRepo(async (repoRoot) => {
    const dead = (slug) => (slug === "acme" ? 404 : 200);
    await run(repoRoot, countingFetch(dead).impl);
    assert.equal(deadBoardList({ repoRoot })[0].dead_since, null);
    const second = await run(repoRoot, countingFetch(dead).impl);
    assert.equal(second.deadBoards.skipped.length, 0);
    assert.ok(deadBoardList({ repoRoot })[0].dead_since);

    const third = countingFetch(dead);
    const summary = await run(repoRoot, third.impl);
    assert.equal(third.calls.filter((slug) => slug === "acme").length, 0);
    assert.ok(third.calls.includes("live"));
    assert.deepEqual(
      summary.deadBoards.skipped.map((b) => b.label),
      ["Acme"]
    );
  });
});

test("transient errors never count toward dead", async () => {
  await withRepo(async (repoRoot) => {
    for (const status of [500, 429, 503]) {
      await run(repoRoot, countingFetch((slug) => (slug === "acme" ? status : 200)).impl);
    }
    await run(repoRoot, async () => {
      throw new Error("socket hang up");
    });
    assert.equal(deadBoardList({ repoRoot }).length, 0);
    // One real 404 afterwards is strike one, not confirmation.
    await run(repoRoot, countingFetch((slug) => (slug === "acme" ? 404 : 200)).impl);
    assert.equal(deadBoardList({ repoRoot })[0].dead_since, null);
    const next = countingFetch(200);
    await run(repoRoot, next.impl);
    assert.ok(next.calls.includes("acme"));
    assert.equal(deadBoardList({ repoRoot }).length, 0);
  });
});

test("a revived board comes back via --recheck-dead", async () => {
  await withRepo(async (repoRoot) => {
    const dead = (slug) => (slug === "acme" ? 404 : 200);
    await run(repoRoot, countingFetch(dead).impl);
    await run(repoRoot, countingFetch(dead).impl);
    const alive = countingFetch(200);
    await run(repoRoot, alive.impl, { recheckDead: true });
    assert.ok(alive.calls.includes("acme"));
    assert.equal(deadBoardList({ repoRoot }).length, 0);
    const after = countingFetch(200);
    const summary = await run(repoRoot, after.impl);
    assert.ok(after.calls.includes("acme"));
    assert.equal(summary.deadBoards.skipped.length, 0);
  });
});

test("editing or removing and re-adding a dead source re-checks it immediately", async () => {
  await withRepo(async (repoRoot) => {
    const dead = (slug) => (slug === "acme" ? 404 : 200);
    await run(repoRoot, countingFetch(dead).impl);
    await run(repoRoot, countingFetch(dead).impl);

    // Edit: same name, new board URL.
    companyAtsUpsert({
      repoRoot,
      entry: { name: "Acme", careers_url: "https://jobs.lever.co/acme2" },
    });
    const edited = countingFetch(200);
    await run(repoRoot, edited.impl);
    assert.ok(edited.calls.includes("acme2"));

    // Re-add: back to the dead URL after a removal; the old record is pruned.
    companyAtsUpsert({
      repoRoot,
      entry: { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
    });
    await run(repoRoot, countingFetch(dead).impl);
    await run(repoRoot, countingFetch(dead).impl);
    assert.ok(deadBoardList({ repoRoot })[0].dead_since);
    companyAtsRemove({ repoRoot, name: "Acme" });
    await run(repoRoot, countingFetch(200).impl);
    companyAtsUpsert({
      repoRoot,
      entry: { name: "Acme", careers_url: "https://jobs.lever.co/acme" },
    });
    const readded = countingFetch(200);
    await run(repoRoot, readded.impl);
    assert.ok(readded.calls.includes("acme"));
  });
});

test("a confirmed-dead board is probed again after 14 days", async () => {
  await withRepo(async (repoRoot) => {
    const dead = (slug) => (slug === "acme" ? 404 : 200);
    await run(repoRoot, countingFetch(dead).impl);
    await run(repoRoot, countingFetch(dead).impl);
    const company = { name: "Acme", careers_url: "https://jobs.lever.co/acme" };
    const at = (days) => new Date(Date.now() + days * 86_400_000);
    const plan = (now) =>
      planDeadBoardSkips({ pathCtx: { repoRoot }, companies: [company], tasks: [], now });
    assert.equal(plan(at(13)).companies.length, 0);
    assert.equal(plan(at(15)).companies.length, 1);
  });
});
