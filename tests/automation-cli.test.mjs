import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { closeAll } from "../src/core/db/connection.mjs";
import { candidateConfigGet, candidateSetupInitialize } from "../src/core/db/verbs/candidate.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("automation CLI saves an explicit Playwright session in a DB workspace", () => {
  const careerratHome = mkdtempSync(join(tmpdir(), "careerrat-automation-cli-"));
  const env = { ...process.env, CAREERRAT_HOME: careerratHome };
  try {
    candidateSetupInitialize({ repoRoot, env });
    closeAll();

    const result = spawnSync(
      process.execPath,
      ["src/cli/automation.mjs", "session", "playwright", "--write", "--json"],
      { cwd: repoRoot, env, encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).written, true);
    assert.equal(candidateConfigGet({ repoRoot, env }).automation.session.provider, "playwright");
  } finally {
    closeAll();
    rmSync(careerratHome, { recursive: true, force: true });
  }
});
