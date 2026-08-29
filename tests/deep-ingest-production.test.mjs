import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDevServer } from "../src/cli/tracker-dev.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { resolveUserPaths } from "../src/core/paths/workspace.mjs";

test("the production app registers and mounts both durable Deep Ingest operation kinds", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-deep-production-"));
  const workspaceDir = resolveUserPaths({ repoRoot }).workspaceDir;
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(workspaceDir, "tracker.json"),
    JSON.stringify({ applications: [], sourced: [], sources: [], communications: [] })
  );
  openDb({ repoRoot });
  const dev = createDevServer({ repoRoot, env: {} });

  try {
    assert.deepEqual(
      dev.appOperations
        .supportedKinds()
        .filter((kind) => kind.startsWith("deep-ingest-"))
        .sort(),
      ["deep-ingest-proposal-build", "deep-ingest-source-scan"]
    );

    await dev.listen({ port: 0, host: "127.0.0.1" });
    const origin = `http://127.0.0.1:${dev.server.address().port}`;
    const sourceResponse = await fetch(`${origin}/api/deep-ingest/sources`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceKind: "paste",
        targetShape: "evidence",
        text: "Built and shipped a durable background workflow.",
      }),
    });
    const started = await sourceResponse.json();

    assert.equal(sourceResponse.status, 202);
    assert.equal(started.data.operation.kind, "deep-ingest-source-scan");
    assert.match(started.data.subject.sourceId, /^deep_src_/);
    const completed = await dev.appOperations.wait(started.data.operation.id);
    assert.equal(completed.status, "completed");

    const proposalResponse = await fetch(`${origin}/api/deep-ingest/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceId: started.data.subject.sourceId,
        targetShape: "evidence",
      }),
    });
    const proposals = await proposalResponse.json();
    assert.equal(proposalResponse.status, 202);
    assert.equal(proposals.data.operation.kind, "deep-ingest-proposal-build");
  } finally {
    await dev.shutdownAppOperations();
    await dev.shutdownSourcingWorkers?.();
    dev.chatRuntime.shutdown();
    if (dev.server.listening) await new Promise((resolve) => dev.server.close(resolve));
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
