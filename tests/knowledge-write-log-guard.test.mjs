import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { revertKnowledgeWrite } from "../src/core/agent/knowledge-write-log.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { appUpsert } from "../src/core/db/verbs/app.mjs";
import {
  candidateConfigGet,
  candidateEvidenceMerge,
  candidateEvidenceReplace,
  candidateSetupInitialize,
} from "../src/core/db/verbs/candidate.mjs";
import {
  deepIngestConfirmedItemUpdate,
  deepIngestConfirmedItemUpsert,
  deepIngestStateGet,
} from "../src/core/db/verbs/deep-ingest.mjs";
import { restoreRerankRows } from "../src/core/strategy/review.mjs";

const roots = [];
after(() => {
  closeAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-knowledge-guard-"));
  roots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  candidateSetupInitialize({ repoRoot, env: {} });
  return { repoRoot, env: {} };
}

const claims = (ctx) => candidateConfigGet(ctx).evidence?.claims || [];

// An entry whose `key` getter fires `race` on its `nth` read. The undo reads
// each key only after it took its snapshot and checked it, so this lands a
// concurrent edit between the check and the write.
function racingEntry(entry, key, nth, race) {
  let reads = 0;
  return Object.defineProperty({ ...entry }, key, {
    enumerable: true,
    get() {
      reads += 1;
      if (reads === nth) race();
      return entry[key];
    },
  });
}

const rewriteClaim = (ctx) =>
  candidateEvidenceReplace({
    ...ctx,
    claims: [{ id: "ev-1", claim: "Rewritten.", evidence: "Release notes." }],
  });

const moveTitle = (ctx) =>
  deepIngestConfirmedItemUpdate({
    ...ctx,
    lane: "story_bank",
    id: "sb-1",
    fields: { title: "Moved" },
  });

test("evidence undo (remove) writes nothing when the claim changed mid-flight", () => {
  const ctx = tempRepo();
  candidateEvidenceMerge({
    ...ctx,
    claims: [{ id: "ev-1", claim: "Shipped the thing.", evidence: "Release notes." }],
  });
  const added = claims(ctx).find((claim) => claim.id === "ev-1");
  const entry = racingEntry(
    {
      kind: "knowledge_write",
      target: "evidence",
      op: "add",
      id: "ev-1",
      beforeAbsent: true,
      after: added,
      revertible: true,
    },
    "id",
    2,
    () => rewriteClaim(ctx)
  );
  const outcome = revertKnowledgeWrite({ ...ctx, entry, messageId: "m1", index: 0 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "stale");
  assert.ok(claims(ctx).some((claim) => claim.id === "ev-1"));
});

test("evidence undo (restore) writes nothing when the claim changed mid-flight", () => {
  const ctx = tempRepo();
  candidateEvidenceMerge({
    ...ctx,
    claims: [{ id: "ev-1", claim: "Shipped the thing.", evidence: "Release notes." }],
  });
  const current = claims(ctx).find((claim) => claim.id === "ev-1");
  const prior = { ...current, claim: "Shipped an earlier thing." };
  const entry = racingEntry(
    {
      kind: "knowledge_write",
      target: "evidence",
      op: "set",
      id: "ev-1",
      before: prior,
      after: current,
      revertible: true,
    },
    "before",
    1,
    () => rewriteClaim(ctx)
  );
  const outcome = revertKnowledgeWrite({ ...ctx, entry, messageId: "m1", index: 0 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "stale");
  assert.notEqual(claims(ctx).find((claim) => claim.id === "ev-1")?.claim, prior.claim);
});

function seedLane(ctx) {
  deepIngestConfirmedItemUpsert({
    ...ctx,
    lane: "story_bank",
    id: "sb-1",
    fields: { title: "After" },
  });
  return deepIngestStateGet(ctx).confirmed.storyBank.find((row) => row.id === "sb-1");
}

const lane = (ctx) => deepIngestStateGet(ctx).confirmed.storyBank.find((row) => row.id === "sb-1");

test("deep-ingest undo (remove) writes nothing when the row changed mid-flight", () => {
  const ctx = tempRepo();
  const row = seedLane(ctx);
  const entry = racingEntry(
    {
      kind: "knowledge_write",
      target: "deep_ingest:story_bank",
      op: "add",
      id: "sb-1",
      beforeAbsent: true,
      after: row,
      revertible: true,
    },
    "id",
    2,
    () => moveTitle(ctx)
  );
  const outcome = revertKnowledgeWrite({ ...ctx, entry, messageId: "m1", index: 0 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "stale");
  assert.equal(lane(ctx)?.title, "Moved");
});

test("deep-ingest undo (field) writes nothing when the field changed mid-flight", () => {
  const ctx = tempRepo();
  seedLane(ctx);
  const entry = racingEntry(
    {
      kind: "knowledge_write",
      target: "deep_ingest:story_bank",
      op: "set",
      id: "sb-1",
      path: "title",
      before: "Before",
      after: "After",
      revertible: true,
    },
    "id",
    2,
    () => moveTitle(ctx)
  );
  const outcome = revertKnowledgeWrite({ ...ctx, entry, messageId: "m1", index: 0 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "stale");
  assert.equal(lane(ctx)?.title, "Moved");
});

const readApp = (ctx, id) =>
  JSON.parse(openDb(ctx).prepare("SELECT data FROM applications WHERE id = ?").get(id).data);

test("rerank undo rolls every row back when a later restore fails mid-write", () => {
  const ctx = tempRepo();
  for (const id of ["app-a", "app-b"]) {
    appUpsert({
      ...ctx,
      row: { id, company: "Co", role: "Eng", status: "screen", priority: 1 },
    });
  }
  const snap = (id, status, priority) => ({ id, table: "applications", status, priority });
  const before = [snap("app-a", "applied", 2), snap("app-b", "applied", 2)];
  const after = [snap("app-a", "screen", 1), snap("app-b", "screen", 1)];
  // The second row's restore blows up after the first row was already written.
  Object.defineProperty(before[1], "status", {
    get() {
      throw new Error("boom");
    },
  });
  assert.throws(() => restoreRerankRows({ ...ctx, before, after }), /boom/);
  assert.equal(readApp(ctx, "app-a").status, "screen");
  assert.equal(readApp(ctx, "app-a").priority, 1);
});
