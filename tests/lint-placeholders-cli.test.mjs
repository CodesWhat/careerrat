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

test("a path that does not exist fails instead of reporting a clean draft", () => {
  const result = lint(join(tmpdir(), "careerrat-lint-no-such-draft.md"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /path not found/);
  assert.doesNotMatch(result.stdout, /No unresolved placeholders/);
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
