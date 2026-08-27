import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  resumeExtractionFail,
  resumeExtractionStart,
} from "../src/core/db/verbs/resume-extractions.mjs";

function plan({ model, effort }) {
  return {
    policyVersion: 1,
    operation: "structured.extraction",
    runtimeId: "managed-anthropic",
    adapterVersion: 1,
    requested: { quality: "automatic", reasoning: "automatic" },
    resolved: {
      quality: "balanced",
      reasoning: "medium",
      model,
      modelSource: "alias",
      effort,
      speedTier: null,
    },
    fallback: null,
  };
}

test("resume extraction retry reuses the original execution plan", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-operation-plan-"));
  const env = {};
  openDb({ repoRoot, env });
  try {
    const originalPlan = plan({ model: "sonnet", effort: "medium" });
    const changedPlan = plan({ model: "opus", effort: "high" });
    const first = resumeExtractionStart({
      repoRoot,
      env,
      uploadDigest: "resume-digest",
      uploadPath: "workspace/intake/resume.pdf",
      filename: "resume.pdf",
      executionPlan: originalPlan,
      ownerId: "app-1",
    }).operation;
    resumeExtractionFail({
      repoRoot,
      env,
      id: first.id,
      ownerId: "app-1",
      error: { code: "RESUME_EXTRACTION_FAILED", message: "temporary failure" },
    });

    const retry = resumeExtractionStart({
      repoRoot,
      env,
      uploadDigest: "resume-digest",
      uploadPath: "workspace/intake/resume.pdf",
      filename: "resume.pdf",
      executionPlan: changedPlan,
      ownerId: "app-2",
    }).operation;

    assert.equal(retry.retryOf, first.id);
    assert.deepEqual(retry.executionPlan, originalPlan);
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
