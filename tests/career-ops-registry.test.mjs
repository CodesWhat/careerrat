import assert from "node:assert/strict";
import { test } from "node:test";

import {
  careerOpsLoadFailures,
  careerOpsProviderIds,
  loadCareerOpsProviders,
} from "../src/core/providers/career-ops-registry.mjs";

// loadCareerOpsProviders is the per-provider isolation loader behind the
// module's top-level registry build: 74+ vendored provider files used to load
// through a single Promise.all, so one broken vendor file threw and took down
// the WHOLE registry (and therefore every module that imports it) for every
// other provider too. `importProvider` is injectable specifically so this can
// be tested with a mocked failing loader, without touching the real vendor/
// tree (which is vendored, not ours to edit).

function fakeProvider(id, overrides = {}) {
  return { default: { id, fetch: async () => [], ...overrides } };
}

test("loadCareerOpsProviders isolates one failing provider and still loads the survivors", async () => {
  const importProvider = async (id) => {
    if (id === "broken") throw new Error("syntax error in vendor file");
    return fakeProvider(id);
  };

  const { providers, failures } = await loadCareerOpsProviders(
    ["good-a", "broken", "good-b"],
    importProvider
  );

  assert.deepEqual(providers.map((p) => p.id).sort(), ["good-a", "good-b"]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].id, "broken");
  assert.match(failures[0].error.message, /syntax error in vendor file/);
});

test("loadCareerOpsProviders records a shape-invalid provider as a failure, not a thrown error", async () => {
  // A provider module that loads fine but doesn't satisfy { id, fetch } (e.g.
  // its id doesn't match the registry id, or fetch isn't a function) must be
  // skipped the same way an import-time throw is — it should never propagate
  // and take the whole registry down.
  const importProvider = async (id) => {
    if (id === "mismatched-id") return fakeProvider("something-else");
    if (id === "no-fetch") return { default: { id: "no-fetch" } };
    if (id === "bad-detect") return fakeProvider(id, { detect: "not-a-function" });
    return fakeProvider(id);
  };

  const { providers, failures } = await loadCareerOpsProviders(
    ["mismatched-id", "no-fetch", "bad-detect", "healthy"],
    importProvider
  );

  assert.deepEqual(
    providers.map((p) => p.id),
    ["healthy"]
  );
  const failedIds = failures.map((f) => f.id).sort();
  assert.deepEqual(failedIds, ["bad-detect", "mismatched-id", "no-fetch"]);
  for (const f of failures) assert.ok(f.error instanceof Error);
});

test("loadCareerOpsProviders with every provider healthy returns zero failures", async () => {
  const importProvider = async (id) => fakeProvider(id);
  const { providers, failures } = await loadCareerOpsProviders(["a", "b", "c"], importProvider);
  assert.equal(providers.length, 3);
  assert.deepEqual(failures, []);
});

test("loadCareerOpsProviders preserves provider order for the survivors", async () => {
  const importProvider = async (id) => {
    if (id === "b") throw new Error("nope");
    return fakeProvider(id);
  };
  const { providers } = await loadCareerOpsProviders(["a", "b", "c", "d"], importProvider);
  assert.deepEqual(
    providers.map((p) => p.id),
    ["a", "c", "d"]
  );
});

// Regression guard on the real registry: every vendored provider currently in
// the tree must actually load. If this ever fails, `careerOpsLoadFailures()`
// is exactly the diagnostic the fix added — a broken vendor file no longer
// takes the whole module down, it shows up here instead.
test("the real career-ops registry loads with zero failures and a non-empty provider set", () => {
  assert.deepEqual(careerOpsLoadFailures(), []);
  assert.ok(careerOpsProviderIds().length > 0);
});
