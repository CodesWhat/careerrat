// install-skills --soft crashed on a read-only install and the TUI bridge threw
// the result away (stdio ignored), so the agent started with no CareerRat skills
// and no message. Runs the real installer against a tree where .claude can't be
// created.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { skillsInstallIssue } from "../src/core/tui/textual-bridge.mjs";

const repo = join(import.meta.dirname, "..");
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// A minimal tree: the real installer, one skill, and a FILE where .claude
// should be, so creating the shim fails the way a locked install does.
function blockedTree() {
  const root = mkdtempSync(join(tmpdir(), "careerrat-skills-install-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync(join(repo, "scripts/install-skills.mjs"), join(root, "scripts/install-skills.mjs"));
  mkdirSync(join(root, ".agents/skills/demo"), { recursive: true });
  writeFileSync(join(root, ".agents/skills/demo/SKILL.md"), "# demo\n");
  writeFileSync(join(root, ".claude"), "not a directory");
  return root;
}

test("install-skills --soft reports the failure and exits 0", () => {
  const root = blockedTree();
  const result = spawnSync(process.execPath, [join(root, "scripts/install-skills.mjs"), "--soft"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /Could not install skills/);
  assert.doesNotMatch(result.stderr, /at .*\.mjs:\d+/, "no stack trace");
});

test("without --soft the same failure exits non-zero", () => {
  const root = blockedTree();
  const result = spawnSync(process.execPath, [join(root, "scripts/install-skills.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
});

test("the TUI bridge turns a failed install into a reason for the notice", () => {
  const reason = skillsInstallIssue(blockedTree());
  assert.match(reason, /skills could not be installed/);
});

test("the TUI bridge reports nothing when the skills are in place", () => {
  const root = mkdtempSync(join(tmpdir(), "careerrat-skills-ok-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync(join(repo, "scripts/install-skills.mjs"), join(root, "scripts/install-skills.mjs"));
  mkdirSync(join(root, ".agents/skills/demo"), { recursive: true });
  writeFileSync(join(root, ".agents/skills/demo/SKILL.md"), "# demo\n");
  assert.equal(skillsInstallIssue(root), null);
});
