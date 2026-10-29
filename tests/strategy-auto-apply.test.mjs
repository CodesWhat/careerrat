// strategy-auto-apply.test.mjs: strategy.review applies recommendations with at
// least three supporting data points on its own, logs each with an Undo, and
// leaves thin-evidence and pay-lowering ones as suggestions.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { executeWorkspaceIntent } from "../src/core/agent/workspace-agent.mjs";
import { WORKSPACE_THREAD_ID } from "../src/core/agent/workspace-thread.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { appScheduleInterview, appUpsert } from "../src/core/db/verbs/app.mjs";
import {
  candidateConfigGet,
  candidateConfigPatch,
  candidateSetupInitialize,
} from "../src/core/db/verbs/candidate.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-strategy-auto-"));
  cleanupRoots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  candidateSetupInitialize({ repoRoot, env: {} });
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots) rmSync(root, { recursive: true, force: true });
});

function draftWith(recommendations) {
  return async () => ({
    state: "drafted",
    generatedAt: "2026-08-15T12:00:00.000Z",
    reviewSignal: { reviewed: true, outcomes: 9, newOutcomes: 5, daysSince: 1 },
    reevaluation: null,
    headline: "Review ready.",
    findings: [],
    recommendations,
  });
}

function review(repoRoot, recommendations) {
  return executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "strategy.review",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { force: true },
    },
    draftStrategyReviewImpl: draftWith(recommendations),
  });
}

function rec(id, type, evidenceCount, proposal, title = id) {
  return { id, type, title, rationale: "Because.", evidenceCount, proposal };
}

function undoFor(repoRoot, message, entryIndex) {
  return executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "knowledge.revert",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { messageId: message.id, index: entryIndex },
    },
  });
}

test("a review applies N>=3 recommendations, logs each with an Undo, and Undo restores a gate write", async () => {
  const repoRoot = tempRepo();
  candidateConfigPatch({
    repoRoot,
    env: {},
    name: "targeting",
    patch: { cut_signals: ["pager duty"] },
  });
  const result = await review(repoRoot, [
    rec("a", "cut-signal", 3, { signal: "on-call-rotation" }, "Cut on-call"),
    rec("b", "exclude-company", 5, { company: "Acme Corp" }, "Skip Acme"),
  ]);
  const last = result.messages.at(-1);
  const entries = last.artifacts.filter((artifact) => artifact.kind === "knowledge_write");
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => entry.revertible === true));
  assert.deepEqual(
    last.artifacts[0].recommendations.map((item) => item.status),
    ["applied", "applied"]
  );
  assert.match(last.text, /Applied 2, each with an Undo/);
  assert.equal(
    last.metadata.nextActions.filter((action) => action.intent.type === "knowledge.revert").length,
    2
  );
  assert.deepEqual(candidateConfigGet({ repoRoot, env: {} }).targeting.cut_signals, [
    "pager duty",
    "on-call-rotation",
  ]);

  const cutIndex = last.artifacts.findIndex((artifact) => artifact.path === "cut_signals");
  await undoFor(repoRoot, last, cutIndex);
  assert.deepEqual(candidateConfigGet({ repoRoot, env: {} }).targeting.cut_signals, ["pager duty"]);
});

test("N<3 stays a suggestion with an Apply action, and Apply logs an Undo", async () => {
  const repoRoot = tempRepo();
  const result = await review(repoRoot, [
    rec("thin", "keep-signal", 2, { signal: "remote-first" }, "Keep remote-first"),
  ]);
  const last = result.messages.at(-1);
  assert.equal(last.artifacts[0].recommendations[0].status, "suggested");
  assert.match(last.artifacts[0].recommendations[0].reason, /Only 2 data points/);
  assert.equal(last.artifacts.filter((a) => a.kind === "knowledge_write").length, 0);
  assert.deepEqual(candidateConfigGet({ repoRoot, env: {} }).targeting?.keep_signals ?? [], []);

  const apply = last.metadata.nextActions.find((action) => action.intent.type === "strategy.apply");
  assert.equal(apply.label, "Apply: Keep remote-first");
  const applied = await executeWorkspaceIntent({ repoRoot, env: {}, intent: apply.intent });
  const message = applied.messages.at(-1);
  const entry = message.artifacts.find((artifact) => artifact.kind === "knowledge_write");
  assert.equal(entry.path, "keep_signals");
  assert.equal(entry.writer, "strategy.apply");
  assert.deepEqual(candidateConfigGet({ repoRoot, env: {} }).targeting.keep_signals, [
    "remote-first",
  ]);
  const undo = message.metadata.nextActions.find((a) => a.intent.type === "knowledge.revert");
  await executeWorkspaceIntent({ repoRoot, env: {}, intent: undo.intent });
  assert.equal(candidateConfigGet({ repoRoot, env: {} }).targeting?.keep_signals?.length ?? 0, 0);
});

test("a comp floor decrease stays a suggestion even with strong evidence, an increase applies", async () => {
  const repoRoot = tempRepo();
  candidateConfigPatch({
    repoRoot,
    env: {},
    name: "profile",
    patch: { compensation: { minimum_base: 150000 } },
  });
  const lower = await review(repoRoot, [
    rec("lower", "comp-floor", 6, { amount: 120000 }, "Lower the floor"),
  ]);
  const lowerMessage = lower.messages.at(-1);
  assert.equal(lowerMessage.artifacts[0].recommendations[0].status, "suggested");
  assert.match(lowerMessage.artifacts[0].recommendations[0].reason, /Lowers your minimum base pay/);
  assert.equal(candidateConfigGet({ repoRoot, env: {} }).profile.compensation.minimum_base, 150000);

  const higher = await review(repoRoot, [
    rec("higher", "comp-floor", 6, { amount: 170000 }, "Raise the floor"),
  ]);
  assert.equal(higher.messages.at(-1).artifacts[0].recommendations[0].status, "applied");
  assert.equal(candidateConfigGet({ repoRoot, env: {} }).profile.compensation.minimum_base, 170000);
});

test("fit bands apply per key and Undo restores them", async () => {
  const repoRoot = tempRepo();
  candidateConfigPatch({
    repoRoot,
    env: {},
    name: "targeting",
    patch: { fit_bands: { high_min: 80, med_min: 60 } },
  });
  const result = await review(repoRoot, [
    rec("bands", "fit-bands", 4, { patch: { high_min: 85, fit_floor: 40 } }, "Tighten bands"),
  ]);
  const last = result.messages.at(-1);
  assert.equal(candidateConfigGet({ repoRoot, env: {} }).targeting.fit_bands.high_min, 85);
  const entries = last.artifacts.filter((artifact) => artifact.kind === "knowledge_write");
  assert.deepEqual(entries.map((entry) => entry.path).sort(), [
    "fit_bands.fit_floor",
    "fit_bands.high_min",
  ]);
  for (const entry of entries) await undoFor(repoRoot, last, last.artifacts.indexOf(entry));
  const bands = candidateConfigGet({ repoRoot, env: {} }).targeting.fit_bands;
  assert.equal(bands.high_min, 80);
  assert.equal(bands.med_min, 60);
  assert.equal(bands.fit_floor, undefined);
});

test("a rerank applies and Undo restores each row's status and priority", async () => {
  const repoRoot = tempRepo();
  appUpsert({
    repoRoot,
    env: {},
    row: { id: "app-r1", company: "Acme", role: "Engineer", status: "applied", priority: "low" },
  });
  const result = await review(repoRoot, [
    rec("rr", "rerank", 3, { id: "app-r1", priority: "high" }, "Raise Acme"),
  ]);
  const last = result.messages.at(-1);
  const entry = last.artifacts.find((artifact) => artifact.target === "rows:rerank");
  assert.equal(entry.revertible, true);
  const read = () =>
    JSON.parse(
      openDb({ repoRoot, env: {} })
        .prepare("SELECT data FROM applications WHERE id = ?")
        .get("app-r1").data
    );
  assert.equal(read().priority, "high");
  await undoFor(repoRoot, last, last.artifacts.indexOf(entry));
  assert.equal(read().priority, "low");
  assert.equal(read().status, "applied");
});

test("a learning is logged but not revertible", async () => {
  const repoRoot = tempRepo();
  const result = await review(repoRoot, [
    rec(
      "learn",
      "learning",
      3,
      { family: "ops", title: "Skip on-call", body: "On-call roles keep getting rejected." },
      "Record learning"
    ),
  ]);
  const last = result.messages.at(-1);
  const entry = last.artifacts.find((artifact) => artifact.target === "learning");
  assert.equal(entry.revertible, false);
  assert.match(entry.revertNote, /append-only/);
  assert.equal(
    last.metadata.nextActions.some((action) => action.intent.type === "knowledge.revert"),
    false
  );
});

test("a writer failure leaves the recommendation as a suggestion instead of failing the review", async () => {
  const repoRoot = tempRepo();
  const result = await review(repoRoot, [
    rec("stale", "rerank", 4, { id: "missing-row", priority: "high" }, "Raise ghost"),
    rec("style", "writing-style", 9, {}, "Change style"),
  ]);
  const items = result.messages.at(-1).artifacts[0].recommendations;
  assert.deepEqual(
    items.map((item) => item.status),
    ["suggested", "suggested"]
  );
  assert.match(items[0].reason, /no longer on the board/);
  assert.match(items[1].reason, /no automated writer/);
  assert.equal(
    result.messages
      .at(-1)
      .metadata.nextActions.some((action) => action.label === "Apply: Change style"),
    false
  );
});

test("applying one suggestion keeps the other Apply buttons and Finish review, after the Undo", async () => {
  const repoRoot = tempRepo();
  const result = await review(repoRoot, [
    rec("one", "keep-signal", 2, { signal: "remote-first" }, "Keep remote-first"),
    rec("two", "cut-signal", 1, { signal: "on-call" }, "Cut on-call"),
    rec("three", "exclude-company", 2, { company: "Acme Corp" }, "Skip Acme"),
  ]);
  const first = result.messages
    .at(-1)
    .metadata.nextActions.find((action) => action.label === "Apply: Keep remote-first");
  const applied = await executeWorkspaceIntent({ repoRoot, env: {}, intent: first.intent });
  const labels = applied.messages.at(-1).metadata.nextActions.map((action) => action.label);
  assert.equal(applied.messages.at(-1).metadata.nextActions[0].intent.type, "knowledge.revert");
  assert.deepEqual(labels.slice(1), ["Apply: Cut on-call", "Apply: Skip Acme", "Finish review"]);

  const second = applied.messages
    .at(-1)
    .metadata.nextActions.find((action) => action.label === "Apply: Cut on-call");
  const next = await executeWorkspaceIntent({ repoRoot, env: {}, intent: second.intent });
  assert.deepEqual(
    next.messages
      .at(-1)
      .metadata.nextActions.map((action) => action.label)
      .slice(1),
    ["Apply: Skip Acme", "Finish review"]
  );
});

function readApp(repoRoot, id) {
  return JSON.parse(
    openDb({ repoRoot, env: {} }).prepare("SELECT data FROM applications WHERE id = ?").get(id).data
  );
}

test("Undo of a rerank out of interview brings the interview details back", async () => {
  const repoRoot = tempRepo();
  appUpsert({
    repoRoot,
    env: {},
    row: {
      id: "app-iv",
      company: "Acme",
      role: "Engineer",
      status: "interview",
      statusNote: "Phone screen done.",
      interviewAt: "2099-01-10T15:00:00.000Z",
      interviewNote: "Bring the portfolio.",
    },
  });
  const result = await review(repoRoot, [
    rec("cut", "rerank", 3, { id: "app-iv", toStatus: "cut" }, "Cut Acme"),
  ]);
  const last = result.messages.at(-1);
  const entry = last.artifacts.find((artifact) => artifact.target === "rows:rerank");
  assert.equal(readApp(repoRoot, "app-iv").status, "cut");
  assert.equal(readApp(repoRoot, "app-iv").interviewAt, null);
  await undoFor(repoRoot, last, last.artifacts.indexOf(entry));
  const restored = readApp(repoRoot, "app-iv");
  assert.equal(restored.status, "interview");
  assert.equal(restored.interviewAt, "2099-01-10T15:00:00.000Z");
  assert.equal(restored.interviewNote, "Bring the portfolio.");
  assert.equal(restored.statusNote, "Phone screen done.");
});

test("a later edit to a snapshotted interview field blocks the rerank Undo", async () => {
  const repoRoot = tempRepo();
  appUpsert({
    repoRoot,
    env: {},
    row: {
      id: "app-iv2",
      company: "Acme",
      role: "Engineer",
      status: "interview",
      interviewAt: "2099-01-10T15:00:00.000Z",
    },
  });
  const result = await review(repoRoot, [
    rec("cut", "rerank", 3, { id: "app-iv2", toStatus: "cut" }, "Cut Acme"),
  ]);
  const last = result.messages.at(-1);
  const entry = last.artifacts.find((artifact) => artifact.target === "rows:rerank");
  appScheduleInterview({
    repoRoot,
    env: {},
    id: "app-iv2",
    at: "2099-02-01T15:00:00.000Z",
    note: "Rescheduled.",
  });
  await undoFor(repoRoot, last, last.artifacts.indexOf(entry));
  const live = readApp(repoRoot, "app-iv2");
  assert.equal(live.status, "cut");
  assert.equal(live.interviewAt, "2099-02-01T15:00:00.000Z");
});
