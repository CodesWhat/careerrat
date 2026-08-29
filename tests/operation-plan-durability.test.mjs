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

function plan({ model, effort, operation = "structured.extraction" }) {
  return {
    policyVersion: 1,
    operation,
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

test("resume extraction retry rejects a persisted plan for another operation", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-operation-plan-"));
  const env = {};
  const db = openDb({ repoRoot, env });
  try {
    const originalPlan = plan({ model: "sonnet", effort: "medium" });
    const first = resumeExtractionStart({
      repoRoot,
      env,
      uploadDigest: "resume-wrong-operation",
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
    const stored = JSON.parse(
      db.prepare("SELECT data FROM resume_extractions WHERE id = ?").get(first.id).data
    );
    stored.executionPlan = plan({
      model: "sonnet",
      effort: "high",
      operation: "coach.deep",
    });
    db.prepare("UPDATE resume_extractions SET data = ? WHERE id = ?").run(
      JSON.stringify(stored),
      first.id
    );

    assert.throws(
      () =>
        resumeExtractionStart({
          repoRoot,
          env,
          uploadDigest: "resume-wrong-operation",
          uploadPath: "workspace/intake/resume.pdf",
          filename: "resume.pdf",
          executionPlan: originalPlan,
          ownerId: "app-2",
        }),
      (error) =>
        error.code === "AI_EXECUTION_PLAN_OPERATION_MISMATCH" &&
        /coach\.deep.*structured\.extraction/i.test(error.message)
    );
  } finally {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
