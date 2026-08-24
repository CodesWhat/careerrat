// GET /api/runtime/config exposes the installed, enabled skill allowlist used
// by the React app. POST /api/skill/run mechanics remain covered separately in
// skill-run-route.test.mjs.

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
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-runtime-config-"));
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

test("GET /api/runtime/config returns only the two direct exact-read skills by default", async () => {
  const repoRoot = tempRepoWithSkills([
    "intake-extract",
    "resume-extract",
    "evaluate-job",
    "track-outcomes",
  ]);
  const dev = await bootServer(repoRoot, { env: {} });
  try {
    const res = await fetch(`${baseUrl(dev)}/api/runtime/config`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    const body = await res.json();
    assert.deepEqual(body.skills, ["intake-extract", "resume-extract"]);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("GET /api/runtime/config never advertises app workflows through the raw skill route", async () => {
  const repoRoot = tempRepoWithSkills(["resume-extract", "evaluate-job", "track-outcomes"]);
  const dev = await bootServer(repoRoot, {
    env: { CAREERRAT_RUNTIME_SKILLS: "evaluate-job,track-outcomes,resume-extract" },
  });
  try {
    const res = await fetch(`${baseUrl(dev)}/api/runtime/config`);
    const body = await res.json();
    assert.deepEqual(body.skills, ["resume-extract"]);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("GET /api/runtime/config never lists a direct skill directory without a SKILL.md", async () => {
  const repoRoot = tempRepoWithSkills(["intake-extract"]);
  const dev = await bootServer(repoRoot, {
    env: { CAREERRAT_RUNTIME_SKILLS: "intake-extract,resume-extract,not-a-real-skill" },
  });
  try {
    const res = await fetch(`${baseUrl(dev)}/api/runtime/config`);
    const body = await res.json();
    assert.deepEqual(body.skills, ["intake-extract"]);
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
