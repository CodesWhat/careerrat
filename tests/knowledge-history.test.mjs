import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { executeWorkspaceIntent } from "../src/core/agent/workspace-agent.mjs";
import { workspaceThreadRead } from "../src/core/agent/workspace-thread.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { candidateConfigGet } from "../src/core/db/verbs.mjs";

const roots = [];
after(() => {
  closeAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-knowledge-history-"));
  roots.push(repoRoot);
  const ctx = { repoRoot, env: {} };
  openDb(ctx);
  const messages = [];
  for (const value of [70, 80]) {
    await executeWorkspaceIntent({
      ...ctx,
      intent: {
        type: "settings.apply",
        entity: { type: "workspace", id: "workspace-main" },
        input: { change: { kind: "profile", section: "fit-floor", value } },
      },
    });
    messages.push(workspaceThreadRead(ctx).messages.at(-1));
  }
  return { ctx, messages };
}

test("direct knowledge Undo resolves saved values and appends durable inverse history", async () => {
  const { undoWorkspaceKnowledge } = await import("../src/core/agent/knowledge-history.mjs");
  const { ctx, messages } = await fixture();
  const result = undoWorkspaceKnowledge({
    ...ctx,
    messageId: messages[1].id,
    index: 1,
    entry: { before: 999 },
  });
  assert.deepEqual(result.operationResult, { ok: true });
  assert.equal(candidateConfigGet(ctx).targeting.fit_bands.fit_floor, 70);
  const saved = workspaceThreadRead(ctx).messages.at(-1);
  assert.equal(saved.kind, "action_result");
  assert.deepEqual(saved.artifacts[0].revertOf, { messageId: messages[1].id, index: 1 });
  assert.equal(saved.artifacts[0].after, 70);
  assert.equal(
    undoWorkspaceKnowledge({ ...ctx, messageId: messages[1].id, index: 1 }).operationResult.reason,
    "already-reverted"
  );
});

test("direct knowledge Undo refuses stale or invalid references without replacing newer knowledge", async () => {
  const { undoWorkspaceKnowledge } = await import("../src/core/agent/knowledge-history.mjs");
  const { ctx, messages } = await fixture();
  const stale = undoWorkspaceKnowledge({ ...ctx, messageId: messages[0].id, index: 1 });
  assert.deepEqual(stale.operationResult, { ok: false, reason: "stale" });
  assert.equal(candidateConfigGet(ctx).targeting.fit_bands.fit_floor, 80);
  assert.throws(
    () => undoWorkspaceKnowledge({ ...ctx, messageId: "missing-message", index: 0 }),
    /saved message/i
  );
  assert.equal(workspaceThreadRead(ctx).messages.at(-1).kind, "action_error");
  for (const index of [-1, 1.5, "1"]) {
    assert.throws(
      () => undoWorkspaceKnowledge({ ...ctx, messageId: messages[1].id, index }),
      /saved message|artifact index/i
    );
  }
});
