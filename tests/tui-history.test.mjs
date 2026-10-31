import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildKnowledgeWriteEntry } from "../src/core/agent/knowledge-write-log.mjs";
import {
  workspaceMessageAppend,
  workspaceThreadRead,
} from "../src/core/agent/workspace-thread.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import { appUpsert } from "../src/core/db/verbs/app.mjs";
import {
  candidateConfigGet,
  candidateConfigPatch,
  candidateSetupInitialize,
} from "../src/core/db/verbs/candidate.mjs";
import { jobThreadMessageAppend } from "../src/core/db/verbs/chat-first.mjs";
import { readJobs } from "../src/core/tui/jobs.mjs";

const api = await import("../src/core/tui/history.mjs").catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return {};
});
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "careerrat-tui-history-"));
  const ctx = { repoRoot: root, env: { CAREERRAT_HOME: root } };
  candidateSetupInitialize(ctx);
  t.after(() => {
    closeAll();
    rmSync(root, { recursive: true, force: true });
  });
  candidateConfigPatch({ ...ctx, name: "targeting", patch: { fit_bands: { fit_floor: 70 } } });
  const entry = buildKnowledgeWriteEntry({
    target: "candidate_config:targeting",
    op: "set",
    path: "fit_bands.fit_floor",
    before: 60,
    after: 70,
    label: "Fit floor",
  });
  const { message } = workspaceMessageAppend({
    ...ctx,
    role: "assistant",
    kind: "action_result",
    text: "Saved fit floor",
    artifacts: [entry],
  });
  return { ...ctx, preview: { messageId: message.id, index: 0, entry } };
}
test("TUI history reads complete canonical conversations and changes without writes", (t) => {
  const ctx = fixture(t);
  appUpsert({
    ...ctx,
    row: { id: "northstar", company: "Northstar", role: "Engineer", status: "applied" },
  });
  const text = `${"Full history. ".repeat(150)}LAST_HISTORY_FACT`;
  jobThreadMessageAppend({ ...ctx, applicationId: "northstar", role: "user", text });
  jobThreadMessageAppend({
    ...ctx,
    applicationId: "northstar",
    role: "assistant",
    text: "Saved the dossier.",
    artifacts: [{ kind: "document", path: "workspace/interview-prep/northstar.md" }],
  });
  const before = readFileSync(join(ctx.env.CAREERRAT_HOME, "db/careerrat.db"));
  const data = readJobs(ctx);
  assert.equal(data.jobs[0].thread.messages[0].text, text);
  assert.equal(
    data.jobs[0].thread.messages[1].artifacts[0].path,
    "workspace/interview-prep/northstar.md"
  );
  assert.equal(data.workspaceMessages.at(-1).text, "Saved fit floor");
  assert.equal(data.changes[0].messageId, ctx.preview.messageId);
  assert.equal(data.changes[0].reverted, false);
  assert.deepEqual(readFileSync(join(ctx.env.CAREERRAT_HOME, "db/careerrat.db")), before);
});
test("confirmed TUI Undo uses the existing guarded writer and records its inverse", (t) => {
  assert.equal(typeof api.applyTuiUndo, "function");
  const ctx = fixture(t);
  const result = api.applyTuiUndo({ ...ctx, preview: ctx.preview });
  assert.deepEqual(result.operationResult, { ok: true });
  assert.equal(candidateConfigGet(ctx).targeting.fit_bands.fit_floor, 60);
  assert.equal(readJobs(ctx).changes[0].reverted, true);
  assert.equal(
    workspaceThreadRead(ctx).messages.at(-1).artifacts[0].revertOf.messageId,
    ctx.preview.messageId
  );
});
test("changed previews and stale values cannot silently undo newer work", (t) => {
  assert.equal(typeof api.applyTuiUndo, "function");
  const ctx = fixture(t);
  assert.throws(
    () =>
      api.applyTuiUndo({
        ...ctx,
        preview: { ...ctx.preview, entry: { ...ctx.preview.entry, after: 999 } },
      }),
    /preview changed/i
  );
  candidateConfigPatch({ ...ctx, name: "targeting", patch: { fit_bands: { fit_floor: 80 } } });
  const result = api.applyTuiUndo({ ...ctx, preview: ctx.preview });
  assert.deepEqual(result.operationResult, { ok: false, reason: "stale" });
  assert.equal(candidateConfigGet(ctx).targeting.fit_bands.fit_floor, 80);
});

test("sourced-job context stays durable without promoting the job to an application", async (t) => {
  const { sourcedUpsertBatch } = await import("../src/core/db/verbs/sourced.mjs");
  const ctx = fixture(t);
  sourcedUpsertBatch({
    ...ctx,
    rows: [{ id: "saved-source", company: "Orbit", role: "Engineer", status: "sourced" }],
  });
  workspaceMessageAppend({
    ...ctx,
    role: "assistant",
    text: "Saved the original JD and fit questions.",
    metadata: { jobId: "saved-source", jobKind: "sourced" },
  });
  const job = readJobs(ctx).jobs.find((row) => row.id === "saved-source");
  assert.equal(job.kind, "sourced");
  assert.equal(job.thread, null);
  assert.equal(job.contextMessages[0].text, "Saved the original JD and fit questions.");
});
