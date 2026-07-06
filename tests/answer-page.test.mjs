// tests/answer-page.test.mjs
// node:test suite for the Interactive Q&A slice (POC apply-packet item 3):
// GET /answer (src/core/ai/answer-page.mjs, mounted by tracker-dev.mjs). Mirrors
// tests/evaluate-page.test.mjs's approach exactly — structural hooks, byte-static
// serving, and a `new Function()` syntax check on the inline <script> (never
// executed, the same guard client-script.test.mjs uses for DASHBOARD_SCRIPT).
// Does not re-test POST /api/skill/run's SSE/abort/status-code mechanics —
// that's tests/skill-run-route.test.mjs's job; this file only confirms
// mounting the new route didn't disturb the existing ones, and that
// /api/runtime/config reflects answer-question the same way it does
// evaluate-job.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDevServer } from "../src/cli/tracker-dev.mjs";
import { ANSWER_PAGE_HTML } from "../src/core/ai/answer-page.mjs";
import { resolveUserPaths } from "../src/core/paths/workspace.mjs";

// A fresh repoRoot with its workspace dir pre-created plus fake SKILL.md
// directories for each name in `skillNames` — same convention
// tests/evaluate-page.test.mjs's tempRepoWithSkills() uses.
function tempRepoWithSkills(skillNames = []) {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-answer-page-"));
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
// GET /answer
// ---------------------------------------------------------------------------

test("GET /answer returns HTML with the expected structural hooks", async () => {
  const repoRoot = tempRepoWithSkills(["answer-question"]);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/answer`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    const html = await res.text();
    for (const hook of [
      'data-hook="question-input"',
      'data-hook="context-input"',
      'data-hook="run-btn"',
      'data-hook="run-status"',
      'data-hook="feed-section"',
      'data-hook="event-feed"',
      'data-hook="error-box"',
      'data-hook="answer-card"',
      'data-hook="answer-text"',
      'data-hook="source-line"',
      'data-hook="durable-line"',
      'data-hook="persisted-line"',
      'data-hook="meta-duration"',
      'data-hook="meta-usage"',
      'data-hook="meta-cost"',
    ]) {
      assert.ok(html.includes(hook), `expected ${hook} in the page`);
    }
  } finally {
    teardown(dev, repoRoot);
  }
});

test("GET /answer serves the same byte-static page regardless of repo state", async () => {
  const repoRoot = tempRepoWithSkills([]);
  const dev = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(dev)}/answer`);
    const html = await res.text();
    assert.equal(html, ANSWER_PAGE_HTML);
  } finally {
    teardown(dev, repoRoot);
  }
});

// ---------------------------------------------------------------------------
// GET /api/runtime/config — answer-question reflected the same way evaluate-job is
// ---------------------------------------------------------------------------

test("GET /api/runtime/config includes answer-question in the default allowlist", async () => {
  const repoRoot = tempRepoWithSkills(["evaluate-job", "answer-question"]);
  const dev = await bootServer(repoRoot, { env: {} });
  try {
    const res = await fetch(`${baseUrl(dev)}/api/runtime/config`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    const body = await res.json();
    assert.deepEqual(body.skills, ["evaluate-job", "answer-question"]);
  } finally {
    teardown(dev, repoRoot);
  }
});

test("GET /api/runtime/config omits answer-question when its SKILL.md isn't discoverable", async () => {
  const repoRoot = tempRepoWithSkills(["evaluate-job"]);
  const dev = await bootServer(repoRoot, { env: {} });
  try {
    const res = await fetch(`${baseUrl(dev)}/api/runtime/config`);
    const body = await res.json();
    assert.deepEqual(body.skills, ["evaluate-job"]);
  } finally {
    teardown(dev, repoRoot);
  }
});

// ---------------------------------------------------------------------------
// Inline <script> — syntax-only guard, never executed (see client-script.test.mjs)
// ---------------------------------------------------------------------------

test("answer-page.mjs inline <script> parses as valid JavaScript (no syntax error)", () => {
  const match = /<script>([\s\S]*?)<\/script>/.exec(ANSWER_PAGE_HTML);
  assert.ok(match, "expected an inline <script> block in the page");
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new-func
    new Function(match[1]);
  }, "answer-page.mjs's inline script has a JS syntax error — it would break the live page");
});

test("answer page drafts through the local packet answers API by default", () => {
  const match = /<script>([\s\S]*?)<\/script>/.exec(ANSWER_PAGE_HTML);
  assert.ok(match);
  const script = match[1];
  assert.match(script, /fetch\("\/api\/packet\/answers"/);
  assert.doesNotMatch(script, /\/api\/skill\/run/);
  assert.doesNotMatch(script, /answer-question/);
  assert.doesNotMatch(script, /answerQuestionAllowed|ROLESTER_RUNTIME_SKILLS/);
});

// ---------------------------------------------------------------------------
// Mounting /answer didn't disturb the existing routes
// ---------------------------------------------------------------------------

test("existing routes still work alongside the new /answer route", async () => {
  const repoRoot = tempRepoWithSkills(["answer-question"]);
  const dev = await bootServer(repoRoot);
  try {
    const health = await fetch(`${baseUrl(dev)}/api/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);

    const evaluate = await fetch(`${baseUrl(dev)}/evaluate`);
    assert.equal(evaluate.status, 200);
  } finally {
    teardown(dev, repoRoot);
  }
});
