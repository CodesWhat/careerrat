import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import * as onboardRoute from "../src/cli/onboard-route.mjs";
import { resolveAIExecutionPlan } from "../src/core/ai/operation-policy.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { createAppOperationManager } from "../src/core/runtime/app-operation-manager.mjs";

const roots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-onboard-search-operation-"));
  roots.push(repoRoot);
  openDb({ repoRoot });
  return repoRoot;
}

function plan(runtimeId) {
  return resolveAIExecutionPlan({
    operation: "research.web",
    runtimeId,
    quality: "balanced",
    reasoning: "medium",
    installedRuntime: {
      path: `/safe/${runtimeId}`,
      realPath: `/safe/${runtimeId}`,
      version: "0.149.1",
      binaryFingerprint: "a".repeat(64),
      capabilities: {
        completion: true,
        structuredOutput: true,
        appWorkflows: true,
        exactRead: true,
        publicWeb: true,
        liveActivity: true,
        resumable: true,
      },
    },
  });
}

after(() => {
  closeAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("onboarding search-prompt retries after restart reuse the frozen provider plan and context", async () => {
  assert.equal(
    typeof onboardRoute.createOnboardingSearchPromptOperationKind,
    "function",
    "expected an onboarding search-prompt app-operation kind"
  );
  assert.equal(
    typeof onboardRoute.recoverOnboardingSearchPromptOperations,
    "function",
    "expected onboarding restart recovery to retry its safe app operation"
  );
  assert.equal(onboardRoute.ONBOARDING_SEARCH_PROMPTS_OPERATION_KIND, "onboarding.search-prompts");

  const repoRoot = tempRepo();
  const context = {
    role_buckets: [{ name: "Applied AI", titles: ["Applied AI Engineer"] }],
    location: { home: "New York, NY", remote: true, remote_scope: "home-country" },
  };
  const codexPlan = plan("codex");
  const claudePlan = plan("claude");
  let selectedPlan = codexPlan;
  let attempts = 0;
  let saved = [];
  const invocations = [];
  const kind = onboardRoute.createOnboardingSearchPromptOperationKind({
    repoRoot,
    buildContext: () => context,
    resolveExecutionPlan: () => selectedPlan,
    getSearchPromptsImpl: () => ({ prompts: saved }),
    generateSearchPromptsImpl: async (options) => {
      attempts += 1;
      invocations.push(options);
      if (attempts === 1) {
        const error = new Error("provider disconnected");
        error.code = "AI_TRANSPORT_FAILED";
        throw error;
      }
      return {
        body: {
          ok: true,
          data: {
            prompts: [
              { text: "Find Applied AI Engineer roles in New York." },
              { text: "Find remote Applied AI Engineer roles in the United States." },
            ],
          },
          ai: { executionPlan: options.executionPlan },
        },
      };
    },
    saveSearchPromptsImpl: ({ prompts }) => {
      saved = prompts;
    },
  });

  const firstManager = createAppOperationManager({
    repoRoot,
    ownerId: "onboard-process-before-restart",
    kinds: { [onboardRoute.ONBOARDING_SEARCH_PROMPTS_OPERATION_KIND]: kind },
  });
  const first = await firstManager.start({
    kind: onboardRoute.ONBOARDING_SEARCH_PROMPTS_OPERATION_KIND,
    input: {},
  });
  assert.equal(first.operation.ownerId, "onboard-process-before-restart");
  assert.match(first.operation.leaseExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(first.operation.request.context, context);
  assert.deepEqual(first.operation.executionPlan, codexPlan);
  const failed = await firstManager.wait(first.operation.id);
  assert.equal(failed.status, "failed");
  await firstManager.shutdown();

  selectedPlan = claudePlan;
  const restartedManager = createAppOperationManager({
    repoRoot,
    ownerId: "onboard-process-after-restart",
    kinds: { [onboardRoute.ONBOARDING_SEARCH_PROMPTS_OPERATION_KIND]: kind },
  });
  const recovered = await onboardRoute.recoverOnboardingSearchPromptOperations({
    appOperations: restartedManager,
    recovered: [failed],
  });
  assert.equal(recovered.length, 1);
  const retried = recovered[0];
  assert.equal(retried.operation.retryOf, first.operation.id);
  assert.deepEqual(retried.operation.executionPlan, codexPlan);
  const completed = await restartedManager.wait(retried.operation.id);
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.executionPlan, codexPlan);
  assert.deepEqual(completed.resultRef.executionPlan, codexPlan);
  assert.deepEqual(
    invocations.map((invocation) => invocation.executionPlan),
    [codexPlan, codexPlan]
  );
  assert.deepEqual(
    invocations.map((invocation) => invocation.context),
    [context, context]
  );
  assert.equal(saved.length, 2);
  await restartedManager.shutdown();
});
