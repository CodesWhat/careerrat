import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const repo = join(import.meta.dirname, "..");
const dirs = [];
function lint(...args) {
  return spawnSync(process.execPath, ["src/cli/lint-placeholders.mjs", ...args], {
    cwd: repo,
    env: { ...process.env, CAREERRAT_NO_UPDATE_CHECK: "1" },
    encoding: "utf8",
  });
}
function draft(name, text) {
  const dir = mkdtempSync(join(tmpdir(), "careerrat-lint-"));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("a path that does not exist is noted and skipped, not a failure", () => {
  const missing = join(tmpdir(), "careerrat-lint-no-such-draft.md");
  const result = lint(missing);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /does not exist, nothing to lint/);
  assert.doesNotMatch(result.stdout, /No unresolved placeholders/);
});

test("a missing path next to a real draft still lints the draft", () => {
  const bad = draft("bad.md", "Dear [Hiring Manager],\n");
  const result = lint(join(tmpdir(), "careerrat-lint-no-such-dir"), bad);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /does not exist/);
  assert.match(result.stdout, /Hiring Manager/);
});

test("real bracketed content is not flagged, template brackets are", () => {
  const ok = lint(draft("ok.md", "skills: [Python, SQL]\nSee [Appendix A] and [SQL] and [x].\n"));
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  for (const text of ["[Your Name]", "[NAME]", "[COMPANY NAME]", "[Insert date]", "[Company]"]) {
    const bad = lint(draft("bad.md", `Hello ${text}\n`));
    assert.equal(bad.status, 1, text);
  }
});

test("bracketed fill-in tokens are caught, markdown links and checkboxes are not", () => {
  const bad = lint(draft("bad.md", "Dear [Hiring Manager],\nThanks.\n"));
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /Hiring Manager/);
  const ok = lint(
    draft(
      "ok.md",
      "See [the posting](https://example.com/job) and [Docs][1].\n- [x] done\n\n[1]: https://example.com\n"
    )
  );
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});

test("a file type the linter cannot read is reported, not passed silently", () => {
  const result = lint(draft("draft.pdf", "[Hiring Manager]"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported file type/);
});
