import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { candidateSetupInitialize } from "../src/core/db/verbs/candidate.mjs";
import { sourceConfigPut } from "../src/core/db/verbs/source-config.mjs";
import { sourcingRunGet, sourcingRunStart } from "../src/core/db/verbs/sourcing-runs.mjs";
import { stopTerminalSessionSearches } from "../src/core/search/terminal-search-worker.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "careerrat-search-cli-"));
  t.after(() => {
    closeAll();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    repoRoot: root,
    env: {
      CAREERRAT_HOME: home,
      PATH: process.env.PATH,
      HOME: home,
      CAREERRAT_NO_UPDATE_CHECK: "1",
    },
  };
}
function cli(ctx, args) {
  return execFileSync(process.execPath, [join(root, "bin/careerrat.mjs"), "search", ...args], {
    env: ctx.env,
    encoding: "utf8",
  });
}
test("search is discoverable and help does not initialize a workspace", (t) => {
  const ctx = fixture(t);
  assert.match(cli(ctx, ["--help"]), /background scan/);
  assert.equal(existsSync(join(ctx.env.CAREERRAT_HOME, "db")), false);
});
test("search status and cancel use exact canonical runs and preserve other people", (t) => {
  const ctx = fixture(t);
  openDb(ctx);
  const { run } = sourcingRunStart({ ...ctx, purpose: "manual-search" });
  assert.equal(JSON.parse(cli(ctx, ["status", "--id", run.id])).run.id, run.id);
  const other = {
    ...ctx,
    env: { ...ctx.env, CAREERRAT_HOME: join(ctx.env.CAREERRAT_HOME, "other") },
  };
  openDb(other);
  assert.equal(JSON.parse(cli(other, ["status"])).run, null);
  const result = JSON.parse(cli(ctx, ["cancel", "--id", run.id]));
  assert.equal(result.run.error.code, "SEARCH_CANCELLED");
  assert.equal(existsSync(result.handoffPath), true);
  assert.equal(JSON.parse(cli(ctx, ["cancel", "--id", run.id])).run.status, "failed");
});
test("search requires explicit database setup and rejects unknown options", (t) => {
  const ctx = fixture(t);
  for (const args of [["start"], ["cancel"], ["status", "--bogus"]]) {
    const result = spawnSync(
      process.execPath,
      [join(root, "bin/careerrat.mjs"), "search", ...args],
      { env: ctx.env, encoding: "utf8" }
    );
    assert.notEqual(result.status, 0);
  }
  assert.equal(existsSync(join(ctx.env.CAREERRAT_HOME, "db")), false);
});

for (const cancel of [false, true])
  test(cancel
    ? "terminal session shutdown stops its actual detached scanner"
    : "search continues after the launching CLI exits and leaves a complete result artifact", {
    timeout: 15000,
  }, async (t) => {
    const ctx = fixture(t);
    if (cancel) ctx.env.CAREERRAT_TUI_SESSION = "session-cancel-proof";
    candidateSetupInitialize(ctx);
    sourceConfigPut({
      ...ctx,
      name: "search-sources",
      data: {
        searches: [
          {
            provider: "Custom RSS",
            source_type: "rss",
            rssUrl: "https://93.184.216.34/synthetic.xml",
            enabled: true,
          },
        ],
      },
    });
    const release = join(ctx.env.CAREERRAT_HOME, "release-search");
    const fetchStarted = join(ctx.env.CAREERRAT_HOME, "fetch-started");
    const preload = join(ctx.env.CAREERRAT_HOME, "synthetic-fetch.mjs");
    writeFileSync(
      preload,
      `
    import { existsSync, writeFileSync } from "node:fs";
    globalThis.fetch = async () => {
      writeFileSync(${JSON.stringify(fetchStarted)}, "yes");
      const deadline = Date.now() + 5000;
      while (!existsSync(${JSON.stringify(release)}) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response('<rss version="2.0"><channel></channel></rss>', { headers: { "content-type": "application/rss+xml" } });
    };
  `
    );
    ctx.env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
    const receipt = JSON.parse(cli(ctx, ["start", "--json"]));
    t.after(() => {
      try {
        process.kill(receipt.workerPid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    });
    assert.equal(receipt.detached, true);
    assert.equal(receipt.run.status, "running");
    for (let attempt = 0; attempt < 100 && !existsSync(fetchStarted); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      existsSync(fetchStarted),
      true,
      "the worker must actually scan the held-open source"
    );
    process.kill(receipt.workerPid, 0);
    if (cancel) {
      await stopTerminalSessionSearches({ ...ctx, sessionId: "session-cancel-proof" });
      assert.equal(
        sourcingRunGet({ ...ctx, id: receipt.run.id }).run.error.code,
        "SEARCH_CANCELLED"
      );
      assert.throws(() => process.kill(receipt.workerPid, 0), { code: "ESRCH" });
      return;
    }
    writeFileSync(release, "continue");
    let result;
    for (let attempt = 0; attempt < 200; attempt++) {
      result = sourcingRunGet({ ...ctx, id: receipt.run.id }).run;
      if (result.status !== "running" && existsSync(receipt.handoffPath)) break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(result.status, "completed");
    const { readFileSync } = await import("node:fs");
    const handoff = JSON.parse(readFileSync(receipt.handoffPath, "utf8"));
    assert.ok(handoff.resultPath);
    assert.ok(Array.isArray(JSON.parse(readFileSync(handoff.resultPath, "utf8")).offers));
  });
