// Tests for src/core/ai/runtime-path-policy.mjs, the path-containment
// primitive shared by runtime-tool-policy.mjs's general Read/Glob/Grep
// allowlist and installed-runtimes.mjs's exact-read staged-upload boundary.
// Those two files used to each carry their own copy of this check, and the
// copies had quietly drifted (only installed-runtimes.mjs's version
// correctly treated a literal dot-prefixed name like "..bar" as a real
// child of root rather than a parent-traversal escape). This suite pins the
// primitive's own behavior directly, then proves both consumers still agree
// with each other and with the primitive on the same containment question —
// so a future edit to either file's copy can't silently reintroduce drift,
// because there's only one copy left to edit.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildInstalledRuntimeInvocation } from "../src/core/ai/installed-runtimes.mjs";
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

test("both consumer entry points agree with isWithinRuntimePath and with each other on the same dot-prefixed-child containment case", async () => {
  // Entry point 1: runtime-tool-policy.mjs's Read decision, via a
  // workspace/..bar/note.md file — allowed only because "..bar" resolves
  // as contained within the approved workspace root.
  const policyRepoRoot = mkdtempSync(join(tmpdir(), "careerrat-path-policy-tool-"));
  // Entry point 2: installed-runtimes.mjs's exact-read boundary for
  // resume-extract, via workspace/intake/resume-uploads/..bar/resume.pdf —
  // allowed only under the identical containment answer.
  const installedRepoRoot = mkdtempSync(join(tmpdir(), "careerrat-path-policy-installed-"));
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

    writeShippedAssets(installedRepoRoot, "resume-extract");
    const dottedUploadDir = join(
      installedRepoRoot,
      "workspace",
      "intake",
      "resume-uploads",
      "..bar"
    );
    mkdirSync(dottedUploadDir, { recursive: true });
    const uploadTarget = join(dottedUploadDir, "resume.pdf");
    writeFileSync(uploadTarget, "resume", "utf8");

    let installedRuntimeDecision;
    try {
      buildInstalledRuntimeInvocation({
        runtimeId: "claude",
        executablePath: "/safe/claude",
        repoRoot: installedRepoRoot,
        approvedReadPaths: [uploadTarget],
        tools: ["Read", "Skill"],
        skill: "resume-extract",
      });
      installedRuntimeDecision = "allow";
    } catch (error) {
      installedRuntimeDecision = error?.code === "RUNTIME_READ_BOUNDARY_INVALID" ? "deny" : "error";
    }

    const directDecision = isWithinRuntimePath(dottedWorkspaceDir, workspaceTarget)
      ? "allow"
      : "deny";

    assert.equal(directDecision, "allow");
    assert.equal(toolPolicyDecision, "allow");
    assert.equal(installedRuntimeDecision, "allow");
  } finally {
    rmSync(policyRepoRoot, { recursive: true, force: true });
    rmSync(installedRepoRoot, { recursive: true, force: true });
  }
});
