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

// GET /answer was intentionally removed from tracker-dev.mjs by a85a9e96
// ("retire the static-HTML dashboard and /evaluate, /answer, /packet,
// /search, /onboard, /tracker compat pages ... Electron only loads /app") —
// apps/web's SPA at /app is the canonical answer surface now.
// ANSWER_PAGE_HTML itself still exists as an orphaned export (content still
// checked below), it's just no longer mounted, so the two HTTP-serving tests
// that used to live here are dead and deleted.

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
  assert.match(script, /renderAnswer/);
  assert.match(script, /excludedQuestionIds/);
  assert.match(script, /sourceLineEl/);
  assert.match(script, /durableLineEl/);
  assert.match(script, /persistedLineEl/);
  assert.doesNotMatch(script, /\/api\/skill\/run/);
  assert.doesNotMatch(script, /answer-question/);
  assert.doesNotMatch(script, /answerQuestionAllowed|ROLESTER_RUNTIME_SKILLS/);
});

// ---------------------------------------------------------------------------
// Mounting /answer didn't disturb the existing routes
// ---------------------------------------------------------------------------

// "existing routes still work alongside the new /answer route" deleted — it
// asserted GET /evaluate 200, retired by a85a9e96 alongside /answer itself.
// /api/health coverage already lives in api-server.test.mjs.
