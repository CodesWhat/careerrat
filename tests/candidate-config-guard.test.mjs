import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { revertKnowledgeWrite } from "../src/core/agent/knowledge-write-log.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  candidateConfigGet,
  candidateConfigPatch,
  candidateSetupInitialize,
} from "../src/core/db/verbs/candidate.mjs";

const roots = [];
after(() => {
  closeAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-config-guard-"));
  roots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  candidateSetupInitialize({ repoRoot, env: {} });
  return { repoRoot, env: {} };
}

const headline = (ctx) => candidateConfigGet(ctx).profile.candidate?.headline;

test("a guard that fails inside the transaction aborts the patch with CONFLICT", () => {
  const ctx = tempRepo();
  candidateConfigPatch({ ...ctx, name: "profile", patch: { candidate: { headline: "One" } } });
  assert.throws(
    () =>
      candidateConfigPatch({
        ...ctx,
        name: "profile",
        patch: { candidate: { headline: "Two" } },
        guard: (doc) => doc.candidate?.headline === "Stale",
      }),
    (error) => error.code === "CONFLICT"
  );
  assert.equal(headline(ctx), "One");
});

test("a passing guard lets the patch through", () => {
  const ctx = tempRepo();
  candidateConfigPatch({ ...ctx, name: "profile", patch: { candidate: { headline: "One" } } });
  candidateConfigPatch({
    ...ctx,
    name: "profile",
    patch: { candidate: { headline: "Two" } },
    guard: (doc) => doc.candidate?.headline === "One",
  });
  assert.equal(headline(ctx), "Two");
});

test("undo refuses as stale when the value moved after the entry", () => {
  const ctx = tempRepo();
  candidateConfigPatch({ ...ctx, name: "profile", patch: { candidate: { headline: "After" } } });
  const entry = {
    kind: "knowledge_write",
    target: "candidate_config:profile",
    op: "set",
    path: "candidate.headline",
    before: "Before",
    after: "After",
    revertible: true,
  };
  candidateConfigPatch({ ...ctx, name: "profile", patch: { candidate: { headline: "Later" } } });
  const outcome = revertKnowledgeWrite({ ...ctx, entry, messageId: "m1", index: 0 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "stale");
  assert.equal(headline(ctx), "Later");
});
