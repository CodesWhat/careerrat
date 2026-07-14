import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "../src/core/db/connection.mjs";
import { candidateConfigPatch, candidateSetupInitialize } from "../src/core/db/verbs.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-candidate-limits-"));
  cleanupRoots.push(repoRoot);
  candidateSetupInitialize({ repoRoot });
  return repoRoot;
}

function patchCap(cap) {
  return candidateConfigPatch({
    repoRoot: tempRepo(),
    name: "application-limits",
    patch: {
      companies: [{ company: "Example Corp", cap }],
    },
  });
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidateConfigPatch normalizes a flow-style YAML application cap", () => {
  const result = patchCap("{ max: 5, window_days: 180 }");

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.companies[0].cap, { max: 5, window_days: 180 });
});

test("candidateConfigPatch accepts a flow-style lifetime application cap", () => {
  const result = patchCap("{ max: 1, window_days: null }");

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.companies[0].cap, { max: 1, window_days: null });
});

test("candidateConfigPatch normalizes an unparseable application cap to null", () => {
  const result = patchCap("not a flow map");

  assert.equal(result.ok, true);
  assert.equal(result.data.companies[0].cap, null);
});
