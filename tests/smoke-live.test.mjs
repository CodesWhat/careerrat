import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { failures, runSmoke } from "../scripts/smoke-live.mjs";

test("live smoke fails on zero jobs and on any provider error", () => {
  assert.deepEqual(failures([{ name: "lever", jobs: 3, errors: [] }]), []);
  assert.deepEqual(failures([{ name: "lever", jobs: 0, errors: [] }]), [
    "lever: returned zero jobs",
  ]);
  assert.deepEqual(failures([{ name: "ashby", jobs: 2, errors: [{ error: "fetch failed" }] }]), [
    "ashby: fetch failed",
  ]);
});

test("live smoke checks every main provider and never injects its own fetch", async () => {
  const seen = [];
  const checks = await runSmoke({
    scanCompaniesImpl: async (config, options) => {
      seen.push([config.tracked_companies[0].provider, options]);
      return { offers: [{}], errors: [] };
    },
    scanBoardsImpl: async (config, options) => {
      seen.push([config.searches[0].provider, options]);
      return { offers: [{}], errors: [] };
    },
  });
  assert.deepEqual(
    seen.map(([provider]) => provider),
    ["greenhouse", "lever", "ashby", "remotive"]
  );
  assert.ok(seen.every(([, options]) => options === undefined));
  assert.equal(checks.length, 4);
  const source = readFileSync(join(import.meta.dirname, "../scripts/smoke-live.mjs"), "utf8");
  assert.doesNotMatch(source, /fetchImpl\s*[:=]/);
});
