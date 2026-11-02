import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { executeWorkspaceIntent } from "../src/core/agent/workspace-agent.mjs";
import { workspaceThreadRead } from "../src/core/agent/workspace-thread.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import { candidateConfigGet, jobThreadMessageAppend } from "../src/core/db/verbs.mjs";

const roots = [];
const env = { ...process.env };
delete env.CAREERRAT_HOME;
delete env.CAREERRAT_PERSON;

function cli(root, args, { ok = true, home } = {}) {
  const result = spawnSync(
    process.execPath,
    ["src/cli/data.mjs", "--root", root, "--json", ...args],
    {
      cwd: join(import.meta.dirname, ".."),
      env: home ? { ...env, CAREERRAT_HOME: home } : env,
      encoding: "utf8",
    }
  );
  assert.equal(result.status, ok ? 0 : 1, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

function root() {
  const value = mkdtempSync(join(tmpdir(), "careerrat-cli-threads-"));
  roots.push(value);
  cli(value, ["init"]);
  return value;
}

after(() => {
  closeAll();
  for (const value of roots) rmSync(value, { recursive: true, force: true });
});

test("CLI appends durable job history, reads it after restart, and reuses message IDs", () => {
  const repoRoot = root();
  cli(repoRoot, [
    "app",
    "upsert",
    "--data",
    JSON.stringify({ id: "app-1", company: "Example", role: "Engineer", status: "awaiting" }),
  ]);
  const payload = {
    id: "cli-result-1",
    role: "assistant",
    kind: "text",
    text: "Saved the interview prep.",
    artifacts: [{ kind: "document", path: "workspace/interview-prep/example.md" }],
  };
  const appended = cli(repoRoot, ["thread", "append", "app-1", "--data", JSON.stringify(payload)]);
  assert.equal(appended.message.text, payload.text);
  assert.equal(
    cli(repoRoot, ["thread", "append", "app-1", "--data", JSON.stringify(payload)]).reused,
    true
  );
  const saved = cli(repoRoot, ["thread", "read", "app-1"]);
  assert.equal(saved.thread.applicationId, "app-1");
  assert.equal(saved.thread.messages.length, 1);
  assert.deepEqual(saved.thread.messages[0].artifacts, payload.artifacts);
  for (let index = 0; index < 65; index++) {
    jobThreadMessageAppend({
      repoRoot,
      env: {},
      applicationId: "app-1",
      role: "assistant",
      text: `Result ${index}`,
    });
  }
  const complete = cli(repoRoot, ["thread", "read", "app-1"]);
  assert.equal(complete.thread.messages.length, 66);
  assert.equal(complete.thread.messages[0].id, payload.id);
  assert.equal(complete.thread.messages.at(-1).text, "Result 64");
  assert.equal(cli(repoRoot, ["thread", "read", "unknown"], { ok: false }).ok, false);
});

test("CLI workspace history is isolated by data root and no-database reads fail closed", () => {
  const repoRoot = root();
  cli(repoRoot, [
    "thread",
    "append",
    "workspace",
    "--data",
    JSON.stringify({ role: "assistant", text: "Owner's result." }),
  ]);
  assert.equal(cli(repoRoot, ["thread", "read", "workspace"]).messages[0].text, "Owner's result.");
  const other = root();
  cli(repoRoot, ["init"], { home: join(other, "person") });
  assert.deepEqual(
    cli(repoRoot, ["thread", "read", "workspace"], { home: join(other, "person") }).messages,
    []
  );
  assert.equal(
    cli(repoRoot, ["thread", "read", "workspace"], { home: join(other, "missing"), ok: false }).ok,
    false
  );
});

test("CLI lists stored changes and undoes by reference, refusing stale and repeated undo", async () => {
  const repoRoot = root();
  const change = async (value) => {
    await executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: {
        type: "settings.apply",
        entity: { type: "workspace", id: "workspace-main" },
        input: { change: { kind: "profile", section: "fit-floor", value } },
      },
    });
    return workspaceThreadRead({ repoRoot, env: {} }).messages.at(-1);
  };
  const first = await change(70);
  const second = await change(80);
  const changes = cli(repoRoot, ["changes", "list"]);
  assert.equal(changes.changes.length, 2);
  assert.equal(changes.changes[0].messageId, second.id);
  assert.equal(changes.changes[0].at, second.createdAt);
  assert.equal(changes.changes[1].at, first.createdAt);
  assert.equal(changes.changes[0].entry.after, 80);
  cli(repoRoot, ["changes", "undo", first.id, "1"]);
  assert.equal(candidateConfigGet({ repoRoot, env: {} }).targeting.fit_bands.fit_floor, 80);
  cli(repoRoot, ["changes", "undo", second.id, "1"]);
  assert.equal(candidateConfigGet({ repoRoot, env: {} }).targeting.fit_bands.fit_floor, 70);
  assert.equal(cli(repoRoot, ["changes", "list"]).changes[0].reverted, true);
  cli(repoRoot, ["changes", "undo", second.id, "1"]);
  assert.equal(candidateConfigGet({ repoRoot, env: {} }).targeting.fit_bands.fit_floor, 70);
  for (const index of ["-1", "1junk", "1.5"]) {
    assert.equal(cli(repoRoot, ["changes", "undo", second.id, index], { ok: false }).ok, false);
  }
});
