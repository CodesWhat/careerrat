import assert from "node:assert/strict";
import { test } from "node:test";

import { AI_OPERATION_DEFAULTS, resolveAIExecutionPlan } from "../src/core/ai/operation-policy.mjs";

test("automatic policy keeps Paul strong and routes web research to the balanced model", () => {
  const paul = resolveAIExecutionPlan({
    operation: "paul.conversation",
    runtimeId: "claude",
  });
  const search = resolveAIExecutionPlan({
    operation: "research.web",
    runtimeId: "claude",
  });

  assert.deepEqual(AI_OPERATION_DEFAULTS["paul.conversation"], {
    quality: "best",
    reasoning: "medium",
  });
  assert.equal(paul.requested.quality, "automatic");
  assert.equal(paul.resolved.quality, "best");
  assert.equal(paul.resolved.model, "opus");
  assert.equal(paul.resolved.effort, "medium");
  assert.equal(search.resolved.quality, "balanced");
  assert.equal(search.resolved.model, "sonnet");
  assert.equal(search.resolved.effort, "medium");
});

test("quality and reasoning preferences use provider-neutral product values", () => {
  const plan = resolveAIExecutionPlan({
    operation: "paul.conversation",
    runtimeId: "codex",
    quality: "faster",
    reasoning: "high",
  });

  assert.equal(plan.requested.quality, "faster");
  assert.equal(plan.requested.reasoning, "high");
  assert.equal(plan.resolved.quality, "faster");
  assert.equal(plan.resolved.model, "gpt-5.6-luna");
  assert.equal(plan.resolved.effort, "high");
  assert.equal(plan.runtimeId, "codex");
  assert.equal(plan.fallback, null);
});

test("operation defaults protect consequential judgment and coaching from low effort", () => {
  for (const operation of ["coach.deep", "application.judgment"]) {
    const plan = resolveAIExecutionPlan({ operation, runtimeId: "codex" });
    assert.equal(plan.resolved.quality, "best");
    assert.equal(plan.resolved.effort, "high");
  }
  const drafting = resolveAIExecutionPlan({
    operation: "application.drafting",
    runtimeId: "claude",
  });
  assert.equal(drafting.resolved.model, "opus");
  assert.equal(drafting.resolved.effort, "medium");
});

test("provider mappings never cross Claude and Codex model families", () => {
  const qualities = ["faster", "balanced", "best"];
  const claude = qualities.map(
    (quality) =>
      resolveAIExecutionPlan({
        operation: "paul.conversation",
        runtimeId: "claude",
        quality,
      }).resolved.model
  );
  const codex = qualities.map(
    (quality) =>
      resolveAIExecutionPlan({
        operation: "paul.conversation",
        runtimeId: "codex",
        quality,
      }).resolved.model
  );

  assert.deepEqual(claude, ["haiku", "sonnet", "opus"]);
  assert.deepEqual(codex, ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]);
  assert.ok(claude.every((model) => !model.startsWith("gpt-")));
  assert.ok(codex.every((model) => !model.startsWith("claude-")));
});

test("an unavailable mapped model falls back within the selected provider and records it", () => {
  const plan = resolveAIExecutionPlan({
    operation: "paul.conversation",
    runtimeId: "codex",
    quality: "best",
    reasoning: "high",
    capabilities: {
      models: ["gpt-5.6-terra", "gpt-5.6-luna"],
      effortLevels: ["low", "medium"],
    },
  });

  assert.equal(plan.runtimeId, "codex");
  assert.equal(plan.resolved.model, null);
  assert.equal(plan.resolved.modelSource, "provider-default");
  assert.equal(plan.resolved.effort, "medium");
  assert.match(plan.fallback.reason, /model.*unavailable/i);
  assert.match(plan.fallback.reason, /effort.*unsupported/i);
  assert.equal(plan.fallback.fromModel, "gpt-5.6-sol");
  assert.equal(plan.fallback.toModel, null);
  assert.equal(plan.fallback.fromEffort, "high");
  assert.equal(plan.fallback.toEffort, "medium");
});

test("provider fallbacks keep their existing model owner while applying operation effort", () => {
  for (const runtimeId of ["anthropic-api", "managed-anthropic"]) {
    const plan = resolveAIExecutionPlan({
      operation: "bounded.classification",
      runtimeId,
    });
    assert.equal(plan.runtimeId, runtimeId);
    assert.equal(plan.resolved.model, null);
    assert.equal(plan.resolved.modelSource, "provider-default");
    assert.equal(plan.resolved.effort, "low");
  }
});

test("execution plans are immutable receipts", () => {
  const plan = resolveAIExecutionPlan({
    operation: "research.web",
    runtimeId: "claude",
  });
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.requested), true);
  assert.equal(Object.isFrozen(plan.resolved), true);
  assert.throws(() => {
    plan.resolved.model = "haiku";
  }, TypeError);
});

test("invalid policy values fail before a provider is invoked", () => {
  assert.throws(
    () =>
      resolveAIExecutionPlan({
        operation: "research.web",
        runtimeId: "codex",
        quality: "cheap",
      }),
    { code: "AI_POLICY_INVALID" }
  );
  assert.throws(() => resolveAIExecutionPlan({ operation: "unknown", runtimeId: "claude" }), {
    code: "AI_POLICY_INVALID",
  });
});
