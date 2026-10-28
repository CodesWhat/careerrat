import assert from "node:assert/strict";
import { test } from "node:test";

import { buildKnowledgeWriteEntry } from "../src/core/agent/knowledge-write-log.mjs";

const source = { kind: "settings.apply", intentMessageId: "m1" };

test("an entry is scoped to the touched path and carries the artifact shape", () => {
  const entry = buildKnowledgeWriteEntry({
    target: "candidate_config:targeting",
    op: "set",
    path: "fit_bands.fit_floor",
    before: 60,
    after: 70,
    source,
    writer: "settings.apply",
    label: "Minimum fit",
  });
  assert.deepEqual(entry, {
    kind: "knowledge_write",
    target: "candidate_config:targeting",
    op: "set",
    path: "fit_bands.fit_floor",
    label: "Minimum fit",
    before: 60,
    after: 70,
    source,
    writer: "settings.apply",
    revertible: true,
  });
});

test("an absent before is flagged rather than dropped by JSON", () => {
  const entry = buildKnowledgeWriteEntry({
    target: "evidence",
    op: "add",
    id: "ev-1",
    before: undefined,
    after: { id: "ev-1", claim: "Did a thing." },
    source,
    writer: "test",
  });
  assert.equal(entry.beforeAbsent, true);
  assert.equal(entry.id, "ev-1");
  assert.equal("path" in entry, false);
  assert.equal(entry.revertible, true);
});

test("values that trip the comp guard are redacted and not revertible", () => {
  const entry = buildKnowledgeWriteEntry({
    target: "candidate_config:profile",
    op: "set",
    path: "compensation.current_base",
    before: 100000,
    after: 120000,
    source,
    writer: "settings.apply",
  });
  const text = JSON.stringify(entry);
  assert.equal(text.includes("current_base"), false);
  assert.equal(text.includes("100000"), false);
  assert.equal(text.includes("120000"), false);
  assert.equal(entry.before, "[private]");
  assert.equal(entry.after, "[private]");
  assert.equal(entry.revertible, false);
  assert.equal(entry.revertNote, "This value is private, so it can't be undone from the thread.");

  const phrased = buildKnowledgeWriteEntry({
    target: "candidate_config:honesty",
    op: "add",
    path: "notes",
    before: "none",
    after: "I currently earn a lot",
    source,
    writer: "test",
  });
  assert.equal(phrased.revertible, false);
  assert.equal(phrased.after, "[private]");
});

test("a writer with no inverse is not revertible and says why", () => {
  const entry = buildKnowledgeWriteEntry({
    target: "learnings",
    op: "add",
    path: "learnings.md",
    before: "a",
    after: "ab",
    source,
    writer: "learnings.append",
    revertible: false,
  });
  assert.equal(entry.revertible, false);
  assert.equal(entry.revertNote, "This kind of change can't be undone from the thread.");

  const custom = buildKnowledgeWriteEntry({
    target: "learnings",
    op: "add",
    path: "x",
    before: 1,
    after: 2,
    source,
    writer: "w",
    revertible: false,
    revertNote: "Appended notes stay put.",
  });
  assert.equal(custom.revertNote, "Appended notes stay put.");
});
