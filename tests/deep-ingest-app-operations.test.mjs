import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  deepIngestProposalDecision,
  deepIngestSourceCreate,
  deepIngestSourceGet,
  deepIngestStateGet,
} from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import { createAppOperationManager } from "../src/core/runtime/app-operation-manager.mjs";

let lifecycle = {};
try {
  lifecycle = await import("../src/core/deep-ingest/app-operations.mjs");
} catch {
  // The first TDD run proves the server-owned lifecycle does not exist yet.
}

const roots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-deep-ingest-operation-"));
  roots.push(repoRoot);
  openDb({ repoRoot });
  return repoRoot;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function kinds(options) {
  assert.equal(
    typeof lifecycle.createDeepIngestAppOperationKinds,
    "function",
    "expected createDeepIngestAppOperationKinds to be exported"
  );
  return lifecycle.createDeepIngestAppOperationKinds(options);
}

function scanResult(input, text = "Built a durable Deep Ingest lifecycle.") {
  return {
    status: "proposal_ready",
    source: {
      id: "scanner-generated-id",
      targetShape: input.targetShape,
      sourceKind: input.sourceKind,
      status: "proposal_ready",
      label: input.fileName || input.url || "Pasted notes",
      artifactPath: input.artifactPath || null,
      metadata: {
        ...(input.url ? { url: input.url } : {}),
        ...(input.fileName ? { fileName: input.fileName } : {}),
      },
      textLength: text.length,
    },
    outcome: { status: "proposal_ready", visible: true },
    chunks: [
      {
        id: "scanner-chunk",
        sourceId: "scanner-generated-id",
        index: 0,
        chunkKind: "text",
        text,
        charStart: 0,
        charEnd: text.length,
        byteStart: 0,
        byteEnd: Buffer.byteLength(text),
      },
    ],
    proposal: {
      id: "scanner-proposal",
      targetShape: input.targetShape,
      lane: "evidence_claims",
      status: "review_needed",
      validation: { status: "source_scanned" },
    },
  };
}

function proposalResult(source, suffix = "one") {
  return {
    status: "proposal_ready",
    proposals: [
      {
        id: `builder-${suffix}`,
        lane: "evidence",
        sourceId: source.id,
        chunkId: source.chunks[0].id,
        status: "review_needed",
        confidence: 0.9,
        supportingQuote: "Built a durable Deep Ingest lifecycle",
        payload: { claim: "Built a durable Deep Ingest lifecycle." },
        validation: { status: "passed", blockedReasons: [] },
      },
    ],
    gaps: [],
    manual: null,
  };
}

after(() => {
  closeAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("Deep Ingest exports fixed source-scan and proposal-build operation registration", () => {
  assert.equal(lifecycle.DEEP_INGEST_SOURCE_SCAN_KIND, "deep-ingest-source-scan");
  assert.equal(lifecycle.DEEP_INGEST_PROPOSAL_BUILD_KIND, "deep-ingest-proposal-build");
  assert.equal(typeof lifecycle.withDeepIngestAppOperationKinds, "function");
  assert.equal(typeof lifecycle.prepareDeepIngestSourceScan, "function");

  const registered = lifecycle.withDeepIngestAppOperationKinds({ existing: { value: true } }, {});
  assert.equal(registered.existing.value, true);
  assert.equal(typeof registered[lifecycle.DEEP_INGEST_SOURCE_SCAN_KIND].parseRequest, "function");
  assert.equal(
    typeof registered[lifecycle.DEEP_INGEST_PROPOSAL_BUILD_KIND].resolveExecutionPlan,
    "function"
  );
});

test("source operation parsing is side-effect free and accepts only a prepared source identity", async () => {
  const repoRoot = tempRepo();
  const config = kinds({ repoRoot })[lifecycle.DEEP_INGEST_SOURCE_SCAN_KIND];
  assert.throws(
    () =>
      config.parseRequest({
        targetShape: "evidence",
        sourceKind: "text",
        text: "This raw source must be prepared by the owning route.",
      }),
    /prepared Deep Ingest source/i
  );
  assert.equal(deepIngestStateGet({ repoRoot }).sources.length, 0);
});

test("source scan owns a stable scanning row before work and outlives the request", async () => {
  const repoRoot = tempRepo();
  const release = deferred();
  let scanCalls = 0;
  const manager = createAppOperationManager({
    repoRoot,
    ownerId: "deep-source-owner",
    kinds: kinds({
      repoRoot,
      async scanSource({ input, signal }) {
        scanCalls += 1;
        assert.equal(signal.aborted, false);
        await release.promise;
        return scanResult(input);
      },
    }),
  });

  const prepared = lifecycle.prepareDeepIngestSourceScan({
    repoRoot,
    input: {
      targetShape: "evidence",
      sourceKind: "text",
      text: "  Built a durable Deep Ingest lifecycle.\r\n",
    },
  });
  const started = await manager.start({
    kind: lifecycle.DEEP_INGEST_SOURCE_SCAN_KIND,
    input: prepared.request,
  });
  const source = deepIngestSourceGet({
    repoRoot,
    sourceId: started.operation.request.sourceId,
  }).source;
  assert.equal(source.id, started.operation.request.sourceId);
  assert.equal(source.status, "scanning");
  assert.equal(source.version, 1);
  assert.equal(source.metadata.sourceDigest, started.operation.request.sourceDigest);

  const duplicatePrepared = lifecycle.prepareDeepIngestSourceScan({
    repoRoot,
    input: {
      sourceKind: "text",
      targetShape: "evidence",
      text: "Built a durable Deep Ingest lifecycle.\n",
    },
  });
  const duplicate = await manager.start({
    kind: lifecycle.DEEP_INGEST_SOURCE_SCAN_KIND,
    input: duplicatePrepared.request,
  });
  assert.equal(duplicate.operation.id, started.operation.id);
  assert.equal(scanCalls, 1);

  release.resolve();
  const completed = await manager.wait(started.operation.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.resultRef.type, "deep-ingest-source");
  assert.equal(completed.resultRef.id, source.id);
  assert.equal(completed.resultRef.version, 1);
  assert.equal(
    deepIngestSourceGet({ repoRoot, sourceId: source.id }).source.status,
    "proposal_ready"
  );
  await manager.shutdown();
});

test("shutdown aborts scanning without orphaning its retryable upload", async () => {
  const repoRoot = tempRepo();
  const artifactPath = "workspace/deep-ingest/sources/abort-notes.md";
  const absolutePath = userPath({ repoRoot }, artifactPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, "Evidence that must survive an interrupted scan.");
  const manager = createAppOperationManager({
    repoRoot,
    ownerId: "deep-upload-owner",
    kinds: kinds({
      repoRoot,
      async scanSource({ signal }) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        signal.throwIfAborted();
      },
    }),
  });

  const prepared = lifecycle.prepareDeepIngestSourceScan({
    repoRoot,
    input: {
      targetShape: "evidence",
      sourceKind: "file",
      fileName: "abort-notes.md",
      artifactPath,
      ownedUpload: true,
    },
  });
  const started = await manager.start({
    kind: lifecycle.DEEP_INGEST_SOURCE_SCAN_KIND,
    input: prepared.request,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await manager.shutdown();

  const failed = manager.get({ id: started.operation.id });
  const source = deepIngestSourceGet({
    repoRoot,
    sourceId: started.operation.request.sourceId,
  }).source;
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "APP_OPERATION_SERVER_STOPPED");
  assert.equal(failed.error.retryable, true);
  assert.equal(source.status, "scanning");
  assert.equal(source.artifactPath, artifactPath);
  assert.equal(source.metadata.ownedUpload, true);
  assert.equal(existsSync(absolutePath), true);
  assert.equal(
    readFileSync(absolutePath, "utf8"),
    "Evidence that must survive an interrupted scan."
  );
});

test("a duplicate upload reuses source identity and cleans only the unlinked staged copy", async () => {
  const repoRoot = tempRepo();
  const firstPath = "workspace/deep-ingest/sources/first.md";
  const duplicatePath = "workspace/deep-ingest/sources/duplicate.md";
  for (const path of [firstPath, duplicatePath]) {
    const absolute = userPath({ repoRoot }, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, "Same uploaded evidence.");
  }
  const manager = createAppOperationManager({
    repoRoot,
    kinds: kinds({ repoRoot, scanSource: async ({ input }) => scanResult(input) }),
  });

  const firstPrepared = lifecycle.prepareDeepIngestSourceScan({
    repoRoot,
    input: {
      targetShape: "evidence",
      sourceKind: "file",
      fileName: "notes.md",
      artifactPath: firstPath,
      ownedUpload: true,
    },
  });
  const first = await manager.start({
    kind: lifecycle.DEEP_INGEST_SOURCE_SCAN_KIND,
    input: firstPrepared.request,
  });
  await manager.wait(first.operation.id);
  const duplicatePrepared = lifecycle.prepareDeepIngestSourceScan({
    repoRoot,
    input: {
      targetShape: "evidence",
      sourceKind: "file",
      fileName: "notes.md",
      artifactPath: duplicatePath,
      ownedUpload: true,
    },
  });
  const duplicate = await manager.start({
    kind: lifecycle.DEEP_INGEST_SOURCE_SCAN_KIND,
    input: duplicatePrepared.request,
  });

  assert.equal(duplicate.operation.id, first.operation.id);
  assert.equal(existsSync(userPath({ repoRoot }, firstPath)), true);
  assert.equal(existsSync(userPath({ repoRoot }, duplicatePath)), false);
  const sources = deepIngestStateGet({ repoRoot }).sources;
  assert.equal(sources.length, 1);
  assert.equal(sources[0].artifactPath, firstPath);
  await manager.shutdown();
});

test("proposal retries keep the frozen extraction plan while a changed source version gets a new plan", async () => {
  const repoRoot = tempRepo();
  const sourceId = "deep_src_plan_fixture";
  deepIngestSourceCreate({
    repoRoot,
    input: {
      id: sourceId,
      version: 1,
      targetShape: "evidence",
      sourceKind: "paste",
      text: "Built a durable Deep Ingest lifecycle.",
      chunks: [{ id: "plan-chunk", text: "Built a durable Deep Ingest lifecycle." }],
    },
  });
  let settingsRevision = 1;
  let calls = 0;
  const plans = [];
  const manager = createAppOperationManager({
    repoRoot,
    kinds: kinds({
      repoRoot,
      resolveProposalExecutionPlan() {
        return {
          operation: "structured.extraction",
          runtimeId: "codex",
          policyVersion: settingsRevision,
          resolved: { model: `model-${settingsRevision}`, effort: "medium" },
        };
      },
      proposalBuilders: {
        evidence: async ({ source, executionPlan, signal }) => {
          signal.throwIfAborted();
          calls += 1;
          plans.push(executionPlan);
          if (calls === 1) throw new Error("interrupted before proposals were saved");
          return proposalResult(source, String(calls));
        },
      },
    }),
  });

  const first = await manager.start({
    kind: lifecycle.DEEP_INGEST_PROPOSAL_BUILD_KIND,
    input: { sourceId, targetShape: "evidence" },
  });
  assert.equal((await manager.wait(first.operation.id)).status, "failed");
  settingsRevision = 2;
  const retry = await manager.retry({ id: first.operation.id });
  const completed = await manager.wait(retry.operation.id);
  assert.equal(completed.status, "completed");
  assert.equal(retry.operation.retryOf, first.operation.id);
  assert.deepEqual(plans[1], plans[0]);
  assert.equal(plans[1].resolved.model, "model-1");
  assert.equal(completed.resultRef.sourceId, sourceId);
  assert.equal(completed.resultRef.sourceVersion, 1);

  deepIngestSourceCreate({
    repoRoot,
    input: {
      id: sourceId,
      version: 2,
      targetShape: "evidence",
      sourceKind: "paste",
      text: "Built a second durable Deep Ingest lifecycle.",
      chunks: [{ id: "plan-chunk-v2", text: "Built a second durable Deep Ingest lifecycle." }],
    },
  });
  const changed = await manager.start({
    kind: lifecycle.DEEP_INGEST_PROPOSAL_BUILD_KIND,
    input: { sourceId, targetShape: "evidence" },
  });
  assert.notEqual(changed.operation.id, first.operation.id);
  await manager.wait(changed.operation.id);
  assert.equal(plans[2].resolved.model, "model-2");
  await manager.shutdown();
});

test("proposal persistence is atomic and idempotent for the frozen source version and target", async () => {
  const repoRoot = tempRepo();
  const source = deepIngestSourceCreate({
    repoRoot,
    input: {
      id: "deep_src_idempotent_fixture",
      version: 3,
      targetShape: "evidence",
      sourceKind: "paste",
      text: "Built a durable Deep Ingest lifecycle.",
      chunks: [{ id: "idempotent-chunk", text: "Built a durable Deep Ingest lifecycle." }],
    },
  }).source;
  let rowCount = 2;
  const operationKinds = kinds({
    repoRoot,
    resolveProposalExecutionPlan: () => ({
      operation: "structured.extraction",
      runtimeId: "claude",
    }),
    proposalBuilders: {
      evidence: async ({ source: builderSource }) => {
        const built = proposalResult(builderSource);
        if (rowCount === 2) {
          built.proposals.push({
            ...built.proposals[0],
            id: "builder-two",
            payload: { claim: "Built a second durable Deep Ingest lifecycle." },
          });
        }
        return built;
      },
    },
  });
  const config = operationKinds[lifecycle.DEEP_INGEST_PROPOSAL_BUILD_KIND];
  const request = await config.parseRequest({ sourceId: source.id, targetShape: "evidence" });
  const executionPlan = await config.resolveExecutionPlan({ request });
  const progress = [];
  const execute = () =>
    config.execute({
      operation: { id: "direct-idempotency-check" },
      request,
      executionPlan,
      signal: new AbortController().signal,
      reportProgress(value) {
        progress.push(value);
      },
    });

  const first = await execute();
  assert.equal(deepIngestStateGet({ repoRoot }).proposals.length, 2);
  rowCount = 1;
  const second = await execute();
  assert.equal(second.resultRef.id, first.resultRef.id);
  assert.equal(second.resultRef.proposalIds[0], first.resultRef.proposalIds[0]);
  const state = deepIngestStateGet({ repoRoot });
  assert.equal(state.proposals.length, 1);
  assert.equal(state.proposals[0].id, first.resultRef.proposalIds[0]);
  assert.equal(state.proposals[0].proposalSetId, first.resultRef.id);
  assert.ok(progress.every((value) => JSON.stringify(value).length < 300));

  const deferredProposal = deepIngestProposalDecision({
    repoRoot,
    proposalId: state.proposals[0].id,
    expectedVersion: state.proposals[0].version,
    decision: "defer",
    reason: "Review this evidence later.",
  });
  await execute();
  const afterDecision = deepIngestStateGet({ repoRoot }).proposals[0];
  assert.equal(afterDecision.status, "deferred");
  assert.equal(afterDecision.version, deferredProposal.version);
});
