// tests/gate-apply.test.mjs — coverage for the shared DB-native gate-write
// primitive (src/core/profile/gate-apply.mjs) reused by both settings.apply
// (workspace-agent.mjs) and strategy.apply's per-recommendation dispatch
// (src/core/strategy/review.mjs → applyGateType). Follows the tempRepo
// convention established by tests/workspace-agent.test.mjs.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { candidateConfigGet } from "../src/core/db/verbs/candidate.mjs";
import { applyGateWrite, GATE_APPLY_SUMMARIES } from "../src/core/profile/gate-apply.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-gate-apply-"));
  cleanupRoots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("applyGateWrite throws a plain error without a .code for an unknown gate type", () => {
  const repoRoot = tempRepo();
  assert.throws(
    () => applyGateWrite({ repoRoot, env: {}, type: "not-a-real-gate", value: "x" }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.code, undefined, "resolveRoute's error must not carry a .code");
      assert.match(error.message, /unknown gate type/i);
      return true;
    }
  );
});

test("applyGateWrite comp-floor: writes profile compensation.minimum_base, then reports no-op on a repeat write", () => {
  const repoRoot = tempRepo();

  const first = applyGateWrite({ repoRoot, env: {}, type: "comp-floor", value: 150000 });
  assert.equal(first.changed, true);
  assert.equal(first.field, "compensation.minimum_base");
  assert.equal(first.value, 150000);
  assert.equal(first.summary, GATE_APPLY_SUMMARIES["comp-floor"](150000));

  const stored = candidateConfigGet({ repoRoot, env: {} }).profile.compensation;
  assert.equal(stored.minimum_base, 150000);

  const second = applyGateWrite({ repoRoot, env: {}, type: "comp-floor", value: 150000 });
  assert.equal(second.changed, false);
  assert.equal(second.summary, "Already saved. Nothing changed.");
  assert.equal(second.from, 150000);
  assert.equal(second.value, 150000);
});

test("applyGateWrite append gate (cut-signal) appends to targeting.cut_signals and is idempotent", () => {
  const repoRoot = tempRepo();

  const first = applyGateWrite({
    repoRoot,
    env: {},
    type: "cut-signal",
    value: "on-call rotation",
  });
  assert.equal(first.changed, true);
  assert.equal(first.field, "cut_signals");
  assert.equal(first.summary, GATE_APPLY_SUMMARIES["cut-signal"]("on-call rotation"));

  const targeting = candidateConfigGet({ repoRoot, env: {} }).targeting;
  assert.ok(targeting.cut_signals.includes("on-call rotation"));

  const second = applyGateWrite({
    repoRoot,
    env: {},
    type: "cut-signal",
    value: "on-call rotation",
  });
  assert.equal(second.changed, false);
  assert.equal(second.summary, "Already saved. Nothing changed.");
});
