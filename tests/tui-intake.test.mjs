import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { intakeOne } from "../src/core/db/verbs/intake.mjs";

const api = await import("../src/core/tui/intake.mjs").catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return {};
});

for (const database of [false, true])
  test(`pasted context is durable before agent dispatch in ${database ? "database" : "legacy"} mode`, (t) => {
    assert.equal(
      typeof api.captureTuiPaste,
      "function",
      "TUI paste needs durable capture before agent input"
    );
    const root = mkdtempSync(join(tmpdir(), "careerrat-tui-intake-"));
    t.after(() => {
      closeAll();
      rmSync(root, { recursive: true, force: true });
    });
    const ctx = { repoRoot: root, env: { CAREERRAT_HOME: join(root, "person") } };
    if (database) openDb(ctx);
    const text =
      "Interview transcript\nThem: Tell me about platform ownership.\nMe: Here is the actual work.\n";
    const result = api.captureTuiPaste({ ...ctx, text });
    assert.match(readFileSync(result.path, "utf8"), /Tell me about platform ownership/);
    assert.match(result.request, /Treat.*data/);
    assert.ok(result.request.includes(result.path));
    if (process.platform !== "win32") assert.equal(statSync(result.path).mode & 0o777, 0o600);
    if (database) {
      const record = intakeOne({ ...ctx, id: result.id });
      assert.equal(record.rawInput, text);
      assert.equal(record.status, "captured");
      assert.equal(record.trackerMatch, null);
    } else assert.equal(existsSync(join(ctx.env.CAREERRAT_HOME, "db")), false);
  });
