// tests/evaluate-page.test.mjs
// node:test suite for the Productization Phase 0, P0-5 headline slice: GET
// /evaluate (src/core/ai/evaluate-page.mjs, mounted by tracker-dev.mjs) and
// GET /api/runtime/config (src/cli/skill-run-route.mjs). Covers the page's
// structural hooks, the allowlist route's shape, and a `new Function()`
// syntax check on the inline <script> — the same guard client-script.test.mjs
// uses for DASHBOARD_SCRIPT, since this page's JS is never executed by tests.
// Does not re-test POST /api/skill/run's SSE/abort/status-code mechanics —
// that's tests/skill-run-route.test.mjs's job; this file only confirms
// mounting the new routes didn't disturb it.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDevServer } from "../src/cli/tracker-dev.mjs";
import { EVALUATE_PAGE_HTML } from "../src/core/ai/evaluate-page.mjs";
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
// GET /evaluate
// ---------------------------------------------------------------------------

test("GET /evaluate returns HTML with the expected structural hooks", async () => {
  const repoRoot = tempRepoWithSkills(["evaluate-job"]);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/evaluate`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    const html = await res.text();
    for (const hook of [
      'data-hook="jd-input"',
      'data-hook="run-btn"',
      'data-hook="feed-section"',
      'data-hook="event-feed"',
      'data-hook="verdict-card"',
      'data-hook="fit-score"',
      'data-hook="gate-line"',
      'data-hook="fit-line"',
      'data-hook="comp-line"',
      'data-hook="comp-anchor-line"',
      'data-hook="action-line"',
      'data-hook="error-box"',
      'data-hook="decision-apply"',
      'data-hook="decision-save"',
      'data-hook="decision-pass"',
    ]) {
      assert.ok(html.includes(hook), `expected ${hook} in the page`);
    }
    // Decision buttons ship disabled by default until the client confirms
    // track-outcomes is in the allowlist.
    assert.match(html, /id="decision-apply"[^>]*disabled/);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("GET /evaluate serves the same byte-static page regardless of repo state", async () => {
  const repoRoot = tempRepoWithSkills([]);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/evaluate`);
    const html = await res.text();
    assert.equal(html, EVALUATE_PAGE_HTML);
  } finally {
    teardown(dev, repoRoot);
  }
});

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
// M3 — ?url= prefill from /search's "Evaluate" links
// ---------------------------------------------------------------------------

test("the inline script reads location.search's url param and prefills without auto-running", () => {
  assert.match(EVALUATE_PAGE_HTML, /prefillFromQuery/);
  assert.match(EVALUATE_PAGE_HTML, /URLSearchParams\(window\.location\.search\)/);
  assert.match(EVALUATE_PAGE_HTML, /params\.get\("url"\)/);
});

// ---------------------------------------------------------------------------
// Inline <script> — syntax-only guard, never executed (see client-script.test.mjs)
// ---------------------------------------------------------------------------

test("evaluate-page.mjs inline <script> parses as valid JavaScript (no syntax error)", () => {
  const match = /<script>([\s\S]*?)<\/script>/.exec(EVALUATE_PAGE_HTML);
  assert.ok(match, "expected an inline <script> block in the page");
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new-func
    new Function(match[1]);
  }, "evaluate-page.mjs's inline script has a JS syntax error — it would break the live page");
});

// ---------------------------------------------------------------------------
// Mounting /evaluate + /api/runtime/config didn't disturb the existing routes
// ---------------------------------------------------------------------------

test("existing API routes still work alongside the new /evaluate + /api/runtime/config routes", async () => {
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
