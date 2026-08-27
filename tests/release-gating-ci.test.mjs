import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("real Chromium application preparation is an explicit required CI context", async () => {
  const [workflow, protection, liveApply] = await Promise.all([
    source(".github/workflows/ci-verify.yml"),
    source("scripts/protect-main.sh"),
    source("tests/playwright-live.test.mjs"),
  ]);
  const job = workflow.slice(
    workflow.indexOf("  browser-application-prep:"),
    workflow.indexOf("  qlty:")
  );

  assert.match(job, /name:\s*browser-application-prep/);
  assert.match(job, /CAREERRAT_LIVE_BROWSER:\s*["']?1/);
  assert.match(job, /playwright install --with-deps chromium/);
  assert.match(job, /tests\/playwright-live\.test\.mjs/);
  assert.match(job, /tests\/playwright-live-dropdowns\.test\.mjs/);
  assert.doesNotMatch(job, /ANTHROPIC|OPENAI|CLAUDE|CODEX/);
  assert.match(protection, /"context": "browser-application-prep"/);
  assert.match(liveApply, /assert\.notEqual\(result\.state, "applied"\)/);
  assert.match(liveApply, /clicked\.includes\("Submit application"\), false/);
});

test("all deterministic product builds are declared as protected contexts", async () => {
  const [workflow, protection] = await Promise.all([
    source(".github/workflows/ci-verify.yml"),
    source("scripts/protect-main.sh"),
  ]);
  for (const context of [
    "web-build",
    "website-build",
    "windows-package-smoke",
    "browser-application-prep",
  ]) {
    assert.match(workflow, new RegExp(`name:\\s*${context}`));
    assert.match(protection, new RegExp(`"context": "${context}"`));
  }
  assert.doesNotMatch(workflow, /web-build, website-build, and windows-package-smoke[^\n]*don't/i);
  assert.doesNotMatch(workflow, /Non-gating for now/i);
});

test("pre-tag and packaged release verification both require the four live-search receipts", async () => {
  const [rootPackage, desktopVerify, desktopWorkflow] = await Promise.all([
    source("package.json"),
    source("apps/desktop/scripts/verify-release.mjs"),
    source(".github/workflows/desktop-release.yml"),
  ]);
  const pkg = JSON.parse(rootPackage);

  assert.equal(pkg.scripts?.["release:pretag"], "node scripts/verify-live-search-receipts.mjs");
  assert.match(desktopVerify, /verifyLiveSearchReceiptDirectory/);
  assert.match(desktopWorkflow, /Verify current live-search receipts/);
  assert.match(desktopWorkflow, /npm run release:pretag/);
});
