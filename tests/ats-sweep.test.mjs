import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runSourcedScan } from "../scripts/scan-sourced.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import { deadBoardList } from "../src/core/db/verbs/search-liveness.mjs";
import {
  candidateConfigPatch,
  candidateSetupInitialize,
  companyAtsUpsert,
} from "../src/core/db/verbs.mjs";
import {
  boardIdentityFromUrl,
  parseSlugList,
  planSweep,
  SWEEP_PROVIDERS,
} from "../src/core/search/ats-sweep.mjs";

const resolveHost = async () => [{ address: "93.184.216.34", family: 4 }];

test("parseSlugList reads JSON maps, JSON rows and text lines, dropping junk", () => {
  const map = parseSlugList(
    '{"greenhouse":["Acme","acme","bad slug!"],"lever":["globex"],"nope":["x"]}'
  );
  assert.deepEqual(map.slugs, [
    { provider: "greenhouse", slug: "acme" },
    { provider: "lever", slug: "globex" },
  ]);
  assert.equal(map.dropped, 2);
  assert.deepEqual(parseSlugList('[{"provider":"ashby","slug":"umbrella"}]').slugs, [
    { provider: "ashby", slug: "umbrella" },
  ]);
  const text = parseSlugList("# my list\nlever:initech\n\nrecruitee:hooli # note\nbogus\n");
  assert.deepEqual(text.slugs, [
    { provider: "lever", slug: "initech" },
    { provider: "recruitee", slug: "hooli" },
  ]);
  assert.equal(text.dropped, 1);
});

test("board URLs round-trip through boardIdentityFromUrl", () => {
  for (const provider of Object.keys(SWEEP_PROVIDERS)) {
    assert.deepEqual(boardIdentityFromUrl(SWEEP_PROVIDERS[provider]("acme-co")), {
      provider,
      slug: "acme-co",
    });
  }
  assert.equal(boardIdentityFromUrl("https://example.com/jobs"), null);
});

test("planSweep skips tracked boards and rotates a long list by day", () => {
  const slugs = Array.from({ length: 10 }, (_, i) => ({ provider: "lever", slug: `co${i}` }));
  const tracked = [{ name: "Co0", careers_url: "https://jobs.lever.co/co0" }];
  const plan = planSweep({ slugs, tracked, maxBoards: 4, now: 0 });
  assert.equal(plan.skippedTracked, 1);
  assert.equal(plan.total, 9);
  assert.equal(plan.entries.length, 4);
  assert.equal(plan.entries[0].careers_url, "https://jobs.lever.co/co1");
  assert.equal(plan.entries[0].name, "Co1");
  const next = planSweep({ slugs, tracked, maxBoards: 4, now: 86400000 });
  assert.equal(next.entries[0].careers_url, "https://jobs.lever.co/co5");
  const all = new Set();
  for (let day = 0; day < 3; day += 1) {
    for (const e of planSweep({ slugs, tracked, maxBoards: 4, now: day * 86400000 }).entries) {
      all.add(e.careers_url);
    }
  }
  assert.equal(all.size, 9, "every board is reached within a few days");
});

function leverFetch({ dead = [], jobsBySlug = {} } = {}) {
  const calls = [];
  const impl = async (url) => {
    const slug = String(url).match(/postings\/([^/?]+)/)?.[1];
    calls.push(slug);
    if (dead.includes(slug)) return new Response("gone", { status: 404 });
    const jobs = (jobsBySlug[slug] || []).map((title, i) => ({
      text: title,
      hostedUrl: `https://jobs.lever.co/${slug}/role-${i}`,
      categories: { location: "Remote - US" },
      descriptionPlain: "Do the work well, with great teammates, on meaningful problems. ".repeat(
        10
      ),
    }));
    return new Response(JSON.stringify(jobs), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

async function withRepo(slugFile, fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-ats-sweep-"));
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  mkdirSync(join(repoRoot, "workspace"), { recursive: true });
  try {
    candidateSetupInitialize({ repoRoot });
    companyAtsUpsert({
      repoRoot,
      entry: { name: "Tracked", careers_url: "https://jobs.lever.co/tracked" },
    });
    if (slugFile !== null) writeFileSync(join(repoRoot, "config/ats-sweep-slugs.txt"), slugFile);
    await fn(repoRoot);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

const run = (repoRoot, fetchImpl, extra = {}) =>
  runSourcedScan({
    repoRoot,
    fetchImpl,
    resolveHost,
    write: true,
    hostThrottle: { minSpacingMs: 0 },
    ...extra,
  });

test("without a slug list the sweep does nothing", async () => {
  await withRepo(null, async (repoRoot) => {
    const fetch = leverFetch();
    const summary = await run(repoRoot, fetch.impl);
    assert.equal(summary.atsSweep, undefined);
    assert.deepEqual(fetch.calls, ["tracked"]);
  });
});

test("listed boards are scanned, deduped against tracked ones, and kept out of run health", async () => {
  await withRepo("lever:tracked\nlever:gone-co\nlever:real-co\n", async (repoRoot) => {
    const fetch = leverFetch({
      dead: ["gone-co"],
      jobsBySlug: { "real-co": ["Platform Engineer"] },
    });
    const summary = await run(repoRoot, fetch.impl);
    assert.deepEqual([...fetch.calls].sort(), ["gone-co", "real-co", "tracked"]);
    assert.equal(summary.atsSweep.boards, 2);
    assert.equal(summary.atsSweep.skippedTracked, 1);
    assert.equal(summary.atsSweep.errors, 1);
    assert.equal(summary.atsSweep.offers, 1);
    assert.equal(summary.scanned, 1);
    assert.equal(summary.attemptedSources, 1, "swept boards are not attempted sources");
    assert.deepEqual(summary.errors, []);
    assert.ok(summary.offers.some((o) => o.company === "Real Co"));
  });
});

test("a swept board that stays dead is skipped on later runs", async () => {
  await withRepo("lever:gone-co\nlever:real-co\n", async (repoRoot) => {
    const dead = { dead: ["gone-co"], jobsBySlug: {} };
    await run(repoRoot, leverFetch(dead).impl);
    await run(repoRoot, leverFetch(dead).impl);
    assert.ok(deadBoardList({ repoRoot }).some((row) => row.kind === "sweep" && row.dead_since));
    const third = leverFetch(dead);
    const summary = await run(repoRoot, third.impl);
    assert.equal(third.calls.filter((slug) => slug === "gone-co").length, 0);
    assert.equal(summary.atsSweep.deadSkipped, 1);
  });
});

test("ats_sweep.enabled false in targeting turns it off even with a list", async () => {
  await withRepo("lever:real-co\n", async (repoRoot) => {
    candidateConfigPatch({
      repoRoot,
      name: "targeting",
      patch: { search_preferences: { ats_sweep: { enabled: false } } },
    });
    const fetch = leverFetch();
    const summary = await run(repoRoot, fetch.impl);
    assert.equal(summary.atsSweep, undefined);
    assert.deepEqual(fetch.calls, ["tracked"]);
  });
});
