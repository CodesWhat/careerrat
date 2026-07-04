import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

async function readText(relPath) {
  return readFile(join(root, relPath), "utf8");
}

test("desktop dist builds the SPA before staging the packaged runtime", async () => {
  const pkg = JSON.parse(await readText("apps/desktop/package.json"));
  const dist = pkg.scripts?.dist || "";

  const buildAt = dist.search(
    /(?:app:build|--workspace\s+apps\/web\s+run\s+build|run\s+build\s+--workspace\s+apps\/web)/
  );
  const stageAt = dist.indexOf("stage");

  assert.ok(buildAt >= 0, "desktop dist must build apps/web before packaging");
  assert.ok(stageAt >= 0, "desktop dist must stage the runtime before electron-builder");
  assert.ok(buildAt < stageAt, "apps/web build must run before staging copies apps/web/dist");
});

test("desktop staging validates web dist and mirrors agent skills for Claude-style discovery", async () => {
  const stageScript = await readText("apps/desktop/scripts/stage.mjs");

  assert.match(
    stageScript,
    /apps\/web\/dist\/index\.html/,
    "stage must fail fast when the SPA dist is missing"
  );
  assert.match(stageScript, /\.agents\/skills/, "stage must copy the canonical agent skills");
  assert.match(
    stageScript,
    /\.claude\/skills/,
    "stage must mirror skills to .claude/skills for Claude-compatible lookup"
  );
});

test("electron-builder embeds the full staged runtime, including hidden skill dirs and SDK node_modules", async () => {
  const config = await readText("apps/desktop/electron-builder.yml");

  assert.match(
    config,
    /from:\s+staging\/rolester[\s\S]*filter:/,
    "main staged runtime must use explicit filters"
  );
  for (const pattern of ["**/*", ".agents/**", ".claude/**", "apps/web/dist/**"]) {
    assert.match(
      config,
      new RegExp(`-\\s+["']?${escapeRegExp(pattern)}["']?`),
      `${pattern} must be included in extraResources`
    );
  }
  assert.match(
    config,
    /from:\s+staging\/rolester\/node_modules[\s\S]*to:\s+rolester\/node_modules/,
    "node_modules must be copied as its own FileSet because electron-builder filters root node_modules directories"
  );
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
