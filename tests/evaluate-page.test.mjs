// tests/evaluate-page.test.mjs
// node:test suite for GET /api/runtime/config (src/cli/skill-run-route.mjs) —
// the allowlist route the SPA's evaluate flow polls to decide which decision
// actions can run. Covers the route's shape and confirms mounting it didn't
// disturb other routes. Does not re-test POST /api/skill/run's SSE/abort/
// status-code mechanics — that's tests/skill-run-route.test.mjs's job.
//
// The legacy GET /evaluate static compatibility page (src/core/ai/
// evaluate-page.mjs) this file used to also cover was retired; its
// page-specific tests were removed with it.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDevServer } from "../src/cli/tracker-dev.mjs";
import { resolveUserPaths } from "../src/core/paths/workspace.mjs";

// A fresh repoRoot with its workspace dir pre-created plus fake SKILL.md
// directories for each name in `skillNames` — same convention
// tests/skill-runtime.test.mjs's tempRepoWithSkill() uses, just multi-skill.
function tempRepoWithSkills(skillNames = []) {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-evaluate-page-"));
  mkdirSync(resolveUserPaths({ repoRoot }).workspaceDir, { recursive: true });
  for (const name of skillNames) {
    const dir = join(repoRoot, ".agents/skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n# ${name}\n`, "utf8");
  }
  return repoRoot;
}

function bootServer(repoRoot, opts = {}) {
  const dev = createDevServer({ repoRoot, ...opts });
  dev.startWatching();
  return new Promise((resolve) => {
    dev.server.listen(0, () => resolve(dev));
  });
}

function baseUrl(dev) {
  return `http://localhost:${dev.server.address().port}`;
}

function teardown(dev, repoRoot) {
  dev.closeClients();
  dev.stopWatching();
  dev.server.close();
  rmSync(repoRoot, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// GET /api/runtime/config
// ---------------------------------------------------------------------------

test("GET /api/runtime/config returns the evaluate-job-only default allowlist", async () => {
  const repoRoot = tempRepoWithSkills(["evaluate-job", "track-outcomes"]);
  const dev = await bootServer(repoRoot, { env: {} });
  try {
    const res = await fetch(`${baseUrl(dev)}/api/runtime/config`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    const body = await res.json();
    assert.deepEqual(body.skills, ["evaluate-job"]);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("GET /api/runtime/config reflects ROLESTER_RUNTIME_SKILLS opting more skills in", async () => {
  const repoRoot = tempRepoWithSkills(["evaluate-job", "track-outcomes"]);
  const dev = await bootServer(repoRoot, {
    env: { ROLESTER_RUNTIME_SKILLS: "evaluate-job,track-outcomes" },
  });
  try {
    const res = await fetch(`${baseUrl(dev)}/api/runtime/config`);
    const body = await res.json();
    assert.deepEqual(body.skills, ["evaluate-job", "track-outcomes"]);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("GET /api/runtime/config never lists a skill directory without a SKILL.md", async () => {
  const repoRoot = tempRepoWithSkills(["evaluate-job"]);
  const dev = await bootServer(repoRoot, {
    env: { ROLESTER_RUNTIME_SKILLS: "evaluate-job,not-a-real-skill" },
  });
  try {
    const res = await fetch(`${baseUrl(dev)}/api/runtime/config`);
    const body = await res.json();
    assert.deepEqual(body.skills, ["evaluate-job"]);
  } finally {
    teardown(dev, repoRoot);
  }
});

// ---------------------------------------------------------------------------
// Mounting /api/runtime/config didn't disturb the existing routes
// ---------------------------------------------------------------------------

test("existing API routes still work alongside /api/runtime/config", async () => {
  const repoRoot = tempRepoWithSkills(["evaluate-job"]);
  const dev = await bootServer(repoRoot);
  try {
    const health = await fetch(`${baseUrl(dev)}/api/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);
  } finally {
    teardown(dev, repoRoot);
  }
});
