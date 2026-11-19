import assert from "node:assert/strict";
import { test } from "node:test";

import { checkLinks, dedupeUrls, trackerLinks } from "../src/core/liveness/check-links.mjs";

function delayedChecker() {
  const state = { active: 0, max: 0, byHost: new Map(), maxByHost: new Map() };
  const checker = async (url) => {
    const host = new URL(url).host;
    state.active += 1;
    state.max = Math.max(state.max, state.active);
    const h = (state.byHost.get(host) || 0) + 1;
    state.byHost.set(host, h);
    state.maxByHost.set(host, Math.max(state.maxByHost.get(host) || 0, h));
    // Later URLs finish first, to prove order is preserved.
    const n = Number(url.split("/").pop());
    await new Promise((resolve) => setTimeout(resolve, 12 - (n % 10)));
    state.active -= 1;
    state.byHost.set(host, state.byHost.get(host) - 1);
    return { result: "active", code: "ok", reason: url };
  };
  return { checker, state };
}

test("checkLinks bounds global and per-host concurrency", async () => {
  const urls = [];
  for (let i = 0; i < 24; i += 1) urls.push(`https://h${i % 6}.example/job/${i}`);
  const { checker, state } = delayedChecker();
  await checkLinks(urls, checker, { concurrency: 5, perHost: 2 });
  assert.ok(state.max <= 5, `global max ${state.max}`);
  assert.ok(state.max > 1, "ran in parallel");
  for (const [host, max] of state.maxByHost) assert.ok(max <= 2, `${host} max ${max}`);

  const same = Array.from({ length: 10 }, (_, i) => `https://one.example/job/${i}`);
  const second = delayedChecker();
  await checkLinks(same, second.checker, { concurrency: 8, perHost: 2 });
  assert.equal(second.state.max, 2);
});

test("checkLinks returns and emits results in input order", async () => {
  const urls = Array.from({ length: 15 }, (_, i) => `https://h${i % 3}.example/job/${i}`);
  const { checker } = delayedChecker();
  const emitted = [];
  const results = await checkLinks(urls, checker, {
    onResult: (_result, url, index) => emitted.push([index, url]),
  });
  assert.deepEqual(
    results.map((r) => r.reason),
    urls
  );
  assert.deepEqual(
    emitted.map(([i]) => i),
    urls.map((_, i) => i)
  );
});

test("checkLinks handles empty input and propagates checker errors", async () => {
  assert.deepEqual(await checkLinks([], async () => ({})), []);
  await assert.rejects(
    checkLinks(["https://a.example/1"], async () => {
      throw new Error("boom");
    }),
    /boom/
  );
});

test("dedupeUrls drops blanks and repeats, keeping first-seen order", () => {
  assert.deepEqual(dedupeUrls(["https://a/1", " https://a/1 ", "", null, "https://b/2"]), [
    "https://a/1",
    "https://b/2",
  ]);
});

test("trackerLinks skips terminal stages by default and includes them with includeClosed", () => {
  const data = {
    applications: [
      { status: "applied", link: "https://a.example/1" },
      { status: "Withdrawn", link: "https://a.example/2" },
      { status: "rejected", link: "https://a.example/3" },
      { status: "closed", link: "https://a.example/4" },
      { status: "interview", link: "https://a.example/1" },
    ],
    sourced: [
      { status: "sourced", link: "https://b.example/1" },
      { status: "cut", link: "https://b.example/2" },
      { link: "https://b.example/3" },
    ],
  };
  assert.deepEqual(trackerLinks(data), [
    "https://a.example/1",
    "https://b.example/1",
    "https://b.example/3",
  ]);
  assert.equal(trackerLinks(data, { includeClosed: true }).length, 7);
  assert.deepEqual(trackerLinks({ prospects: [{ status: "cut", link: "https://c/1" }] }), []);
});
