// Tests for src/core/ai/runtime-path-policy.mjs, the path-containment
// primitive used by runtime-tool-policy.mjs's general Read/Glob/Grep
// allowlist. This suite pins the primitive's own behavior directly, then
// proves the tool policy still agrees with it on the same containment question
// (a literal dot-prefixed name like "..bar" is a real child of root, not a
// parent-traversal escape).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isWithinRuntimePath } from "../src/core/ai/runtime-path-policy.mjs";
import { createRuntimeToolPolicy } from "../src/core/ai/runtime-tool-policy.mjs";

test("isWithinRuntimePath: root, direct child, and parent-traversal escapes", () => {
  const root = join("/repo", "workspace");
  assert.equal(isWithinRuntimePath(root, root), true);
  assert.equal(isWithinRuntimePath(root, join(root, "jobs", "role.md")), true);
  assert.equal(isWithinRuntimePath(root, "/repo/workspace-other"), false);
  assert.equal(isWithinRuntimePath(root, "/repo"), false);
  assert.equal(isWithinRuntimePath(root, join(root, "..")), false);
  assert.equal(isWithinRuntimePath(root, join(root, "..", "escaped")), false);
});

test("isWithinRuntimePath: a literal dot-prefixed child name is contained, not treated as escape", () => {
  const root = join("/repo", "workspace");
  // "..bar" is a real directory name that happens to start with two dots —
  // it is not the ".." parent-traversal token, so it must resolve as within
  // root. (The pre-dedup runtime-tool-policy.mjs copy of this check got
  // this wrong: it treated any relative path starting with the two
  // characters ".." as an escape, denying legitimate paths like this one.)
  assert.equal(isWithinRuntimePath(root, join(root, "..bar")), true);
  assert.equal(isWithinRuntimePath(root, join(root, "..bar", "file.md")), true);
});

function writeShippedAssets(repoRoot, skill) {
  const skillDir = join(repoRoot, ".agents/skills", skill);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${skill}\n---\n# ${skill}\n`, "utf8");
}

test("the tool policy agrees with isWithinRuntimePath on a dot-prefixed-child containment case", async () => {
  // runtime-tool-policy.mjs's Read decision, via a
  // workspace/..bar/note.md file — allowed only because "..bar" resolves
  // as contained within the approved workspace root.
  const policyRepoRoot = mkdtempSync(join(tmpdir(), "careerrat-path-policy-tool-"));
  try {
    writeShippedAssets(policyRepoRoot, "evaluate-job");
    mkdirSync(join(policyRepoRoot, "candidate"), { recursive: true });
    writeFileSync(join(policyRepoRoot, "candidate", "profile.yml"), "name: test", "utf8");
    // A file under workspace/jobs is what makes resolveUserPaths recognize
    // this as the legacy top-level layout (legacyWorkspaceExists) and anchor
    // workspaceDir at repoRoot/workspace rather than the .careerrat-nested
    // default — otherwise the dotted fixture below would land outside the
    // root this test means to exercise.
    mkdirSync(join(policyRepoRoot, "workspace", "jobs"), { recursive: true });
    writeFileSync(join(policyRepoRoot, "workspace", "jobs", "role.md"), "# role", "utf8");
    const dottedWorkspaceDir = join(policyRepoRoot, "workspace", "..bar");
    mkdirSync(dottedWorkspaceDir, { recursive: true });
    const workspaceTarget = join(dottedWorkspaceDir, "note.md");
    writeFileSync(workspaceTarget, "# note", "utf8");

    const policy = createRuntimeToolPolicy({
      repoRoot: policyRepoRoot,
      skill: "evaluate-job",
      tools: ["Read"],
      env: {},
    });
    const toolPolicyDecision = (await policy.canUseTool("Read", { file_path: workspaceTarget }))
      .behavior;

    const directDecision = isWithinRuntimePath(dottedWorkspaceDir, workspaceTarget)
      ? "allow"
      : "deny";

    assert.equal(directDecision, "allow");
    assert.equal(toolPolicyDecision, "allow");
  } finally {
    rmSync(policyRepoRoot, { recursive: true, force: true });
  }
});
