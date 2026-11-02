// Re-ingesting a calendar could only add busy blocks, so a cancelled or moved
// meeting stayed busy forever and a free calendar could not be recorded.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { calendarBusyUpsert } from "../src/core/db/verbs/calendar.mjs";

const roots = [];
function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-cal-window-"));
  roots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  return repoRoot;
}
after(() => {
  closeAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const block = (day, hour) => ({
  startIso: `2026-11-${day}T${hour}:00:00.000Z`,
  endIso: `2026-11-${day}T${hour}:30:00.000Z`,
});

test("a windowed re-ingest drops a cancelled meeting and keeps blocks outside the window", () => {
  const repoRoot = tempRepo();
  calendarBusyUpsert({
    repoRoot,
    env: {},
    blocks: [block("03", "10"), block("04", "10"), block("20", "10")],
  });
  const result = calendarBusyUpsert({
    repoRoot,
    env: {},
    blocks: [block("04", "10")],
    window: { startIso: "2026-11-03T00:00:00.000Z", endIso: "2026-11-10T00:00:00.000Z" },
  });
  assert.deepEqual(
    result.blocks.map((b) => b.startIso.slice(0, 10)),
    ["2026-11-04", "2026-11-20"]
  );
});

test("an empty list with a window records a free calendar", () => {
  const repoRoot = tempRepo();
  calendarBusyUpsert({ repoRoot, env: {}, blocks: [block("03", "10")] });
  const result = calendarBusyUpsert({
    repoRoot,
    env: {},
    blocks: [],
    window: { startIso: "2026-11-01T00:00:00.000Z", endIso: "2026-11-08T00:00:00.000Z" },
  });
  assert.equal(result.count, 0);
});

test("without a window an empty list is still refused and ingest still only adds", () => {
  const repoRoot = tempRepo();
  assert.throws(() => calendarBusyUpsert({ repoRoot, env: {}, blocks: [] }), /non-empty/);
  calendarBusyUpsert({ repoRoot, env: {}, blocks: [block("03", "10")] });
  const result = calendarBusyUpsert({ repoRoot, env: {}, blocks: [block("04", "10")] });
  assert.equal(result.count, 2);
});
