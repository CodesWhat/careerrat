import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { refreshUpdateCacheInBackground } from "../src/core/update/update-core.mjs";

async function waitForFile(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("refreshUpdateCacheInBackground forces Electron's detached child into Node mode", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-update-core-"));
  const careerratHome = join(repoRoot, "careerrat-home");
  const resultPath = join(repoRoot, "electron-run-as-node.txt");

  try {
    mkdirSync(join(repoRoot, "scripts"), { recursive: true });
    writeFileSync(
      join(repoRoot, "scripts/update-check.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(resultPath)}, String(process.env.ELECTRON_RUN_AS_NODE ?? ""));\n`
    );

    const pathCtx = {
      repoRoot,
      env: { ...process.env, ROLESTER_HOME: careerratHome },
    };
    refreshUpdateCacheInBackground(pathCtx, repoRoot);

    await waitForFile(resultPath);
    assert.equal(readFileSync(resultPath, "utf8"), "1");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
