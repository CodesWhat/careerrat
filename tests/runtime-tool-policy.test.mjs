// Tests for src/core/ai/runtime-tool-policy.mjs.
//
// The AI runtime's file-access allowlist used to hand-roll
// join(repoRoot, "candidate"|"workspace"|"config") and block the literal
// ".careerrat" segment everywhere. Once workspace.mjs's privateDataRoot()
// stopped always anchoring under repoRoot (installed packages now anchor at
// ~/.careerrat, or any CAREERRAT_HOME), those hardcoded roots stopped
// matching where the resolver actually put the user's data — the runtime
// denied Read/Glob/Grep on the user's own candidate/workspace files. These
// tests exercise both the legacy top-level layout and the .careerrat-anchored
// layout (including one entirely outside repoRoot, standing in for the
// installed-package/home-anchored case), and prove internal state, the
// sqlite db, and secrets stay denied in both.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRuntimeToolPolicy } from "../src/core/ai/runtime-tool-policy.mjs";

function writeSkill(repoRoot, skill) {
  const skillDir = join(repoRoot, ".agents/skills", skill);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${skill}\n---\n# ${skill}\n`, "utf8");
}

function writeShippedAssets(repoRoot, skill) {
  writeSkill(repoRoot, skill);
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  writeFileSync(join(repoRoot, "config", "ai.example.json"), "{}", "utf8");
  mkdirSync(join(repoRoot, "templates"), { recursive: true });
  writeFileSync(join(repoRoot, "templates", "resume.md"), "# template", "utf8");
  writeFileSync(join(repoRoot, "AGENTS.md"), "# agents", "utf8");
}

async function canRead(policy, filePath) {
  return (await policy.canUseTool("Read", { file_path: filePath })).behavior;
}

test("legacy top-level layout: candidate/workspace files readable, internal/db/env/form-defaults denied", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-tool-policy-legacy-"));
  try {
    writeShippedAssets(repoRoot, "evaluate-job");

    // Pre-existing legacy data makes resolveUserPaths anchor candidate/
    // workspace directly under repoRoot instead of repoRoot/.careerrat.
    mkdirSync(join(repoRoot, "candidate"), { recursive: true });
    writeFileSync(join(repoRoot, "candidate", "profile.yml"), "name: test", "utf8");
    writeFileSync(join(repoRoot, "candidate", "form-defaults.yml"), "secret: 1", "utf8");
    mkdirSync(join(repoRoot, "workspace", "jobs"), { recursive: true });
    writeFileSync(join(repoRoot, "workspace", "settings.json"), "{}", "utf8");
    writeFileSync(join(repoRoot, "workspace", "jobs", "role.md"), "# role", "utf8");
    mkdirSync(join(repoRoot, ".internal"), { recursive: true });
    writeFileSync(join(repoRoot, ".internal", "ai.env"), "KEY=secret", "utf8");
    writeFileSync(join(repoRoot, ".env"), "SECRET=1", "utf8");

    const policy = createRuntimeToolPolicy({
      repoRoot,
      skill: "evaluate-job",
      tools: ["Read", "Glob", "Grep"],
      env: {},
    });

    assert.equal(await canRead(policy, join(repoRoot, "candidate/profile.yml")), "allow");
    assert.equal(await canRead(policy, join(repoRoot, "workspace/jobs/role.md")), "allow");

    assert.equal(await canRead(policy, join(repoRoot, "candidate/form-defaults.yml")), "deny");
    assert.equal(await canRead(policy, join(repoRoot, ".internal/ai.env")), "deny");
    assert.equal(await canRead(policy, join(repoRoot, ".env")), "deny");
    // The sqlite db always lives under privateDataRoot()/db regardless of
    // whether candidate/workspace resolved to the legacy top-level layout.
    assert.equal(await canRead(policy, join(repoRoot, ".careerrat/db/careerrat.db")), "deny");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test(".careerrat-anchored layout (fresh install, no legacy data): candidate/workspace under .careerrat readable, internal/db denied, stale legacy paths denied", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-tool-policy-dotdir-"));
  try {
    writeShippedAssets(repoRoot, "evaluate-job");
    // No top-level candidate/ or workspace/ — resolveUserPaths anchors under
    // repoRoot/.careerrat instead. Files exist only under .careerrat here;
    // they don't need to physically exist for the policy decision, but
    // writing them makes the fixture read like a real installed workspace.
    mkdirSync(join(repoRoot, ".careerrat/candidate"), { recursive: true });
    writeFileSync(join(repoRoot, ".careerrat/candidate", "profile.yml"), "name: test", "utf8");
    writeFileSync(join(repoRoot, ".careerrat/candidate", "form-defaults.yml"), "secret: 1", "utf8");
    mkdirSync(join(repoRoot, ".careerrat/workspace/jobs"), { recursive: true });
    writeFileSync(join(repoRoot, ".careerrat/workspace/jobs", "role.md"), "# role", "utf8");
    // "internal" (no leading dot) is the real directory name under the
    // .careerrat root — the pre-fix BLOCKED_SEGMENTS entry ".internal" never
    // matched this, which was bug #2: removing the blanket ".careerrat"
    // block had to come with a root-containment check for this exact case.
    mkdirSync(join(repoRoot, ".careerrat/internal"), { recursive: true });
    writeFileSync(join(repoRoot, ".careerrat/internal", "ai.env"), "KEY=secret", "utf8");
    mkdirSync(join(repoRoot, ".careerrat/db"), { recursive: true });
    writeFileSync(join(repoRoot, ".careerrat/db", "careerrat.db"), "", "utf8");

    const policy = createRuntimeToolPolicy({
      repoRoot,
      skill: "evaluate-job",
      tools: ["Read", "Glob", "Grep"],
      env: {},
    });

    assert.equal(
      await canRead(policy, join(repoRoot, ".careerrat/candidate/profile.yml")),
      "allow"
    );
    assert.equal(
      await canRead(policy, join(repoRoot, ".careerrat/workspace/jobs/role.md")),
      "allow"
    );

    assert.equal(
      await canRead(policy, join(repoRoot, ".careerrat/candidate/form-defaults.yml")),
      "deny"
    );
    assert.equal(await canRead(policy, join(repoRoot, ".careerrat/internal/ai.env")), "deny");
    assert.equal(await canRead(policy, join(repoRoot, ".careerrat/db/careerrat.db")), "deny");

    // The old, now-stale legacy path is correctly denied in this layout:
    // the data doesn't live there, so it must never be treated as readable
    // just because it shares a leaf name with an allowed root.
    assert.equal(await canRead(policy, join(repoRoot, "candidate/profile.yml")), "deny");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("data root anchored entirely outside repoRoot (installed-package/home-anchor stand-in): shipped assets stay install-root-anchored, data reads follow CAREERRAT_HOME, internal/db still denied", async () => {
  // A real installed package sits under a literal node_modules parent
  // (workspace.mjs's isPackageInstall detection) and its data anchors at
  // homedir()/.careerrat. Reproducing that exact shape here (repoRoot under
  // node_modules) without touching the real developer home directory: point
  // CAREERRAT_HOME at a throwaway temp dir instead, which exercises the same
  // "dataRoot lives entirely outside repoRoot" code path the fix has to
  // handle, and also proves the install-root-anchored allowlist (skills,
  // config, templates, AGENTS.md) survives repoRoot having "node_modules" as
  // one of its own path segments — the bug this test would have caught if
  // the fix had scanned BLOCKED_SEGMENTS against the whole absolute path
  // instead of only the suffix under a matched root.
  const workRoot = mkdtempSync(join(tmpdir(), "careerrat-tool-policy-installed-"));
  const repoRoot = join(workRoot, "node_modules", "careerrat");
  const dataHome = mkdtempSync(join(tmpdir(), "careerrat-tool-policy-home-"));
  try {
    mkdirSync(repoRoot, { recursive: true });
    writeShippedAssets(repoRoot, "evaluate-job");

    mkdirSync(join(dataHome, "candidate"), { recursive: true });
    writeFileSync(join(dataHome, "candidate", "profile.yml"), "name: test", "utf8");
    writeFileSync(join(dataHome, "candidate", "form-defaults.yml"), "secret: 1", "utf8");
    mkdirSync(join(dataHome, "workspace/jobs"), { recursive: true });
    writeFileSync(join(dataHome, "workspace/jobs", "role.md"), "# role", "utf8");
    mkdirSync(join(dataHome, "internal"), { recursive: true });
    writeFileSync(join(dataHome, "internal", "ai.env"), "KEY=secret", "utf8");
    mkdirSync(join(dataHome, "db"), { recursive: true });
    writeFileSync(join(dataHome, "db", "careerrat.db"), "", "utf8");

    const policy = createRuntimeToolPolicy({
      repoRoot,
      skill: "evaluate-job",
      tools: ["Read", "Glob", "Grep"],
      env: { CAREERRAT_HOME: dataHome },
    });

    // Shipped assets: anchored to the install root regardless of where the
    // data root resolved, and readable even though repoRoot itself sits
    // under a literal "node_modules" directory.
    assert.equal(
      await canRead(policy, join(repoRoot, ".agents/skills/evaluate-job/SKILL.md")),
      "allow"
    );
    assert.equal(await canRead(policy, join(repoRoot, "config/ai.example.json")), "allow");
    assert.equal(await canRead(policy, join(repoRoot, "templates/resume.md")), "allow");
    assert.equal(await canRead(policy, join(repoRoot, "AGENTS.md")), "allow");

    // User data: readable at the home-anchored root, entirely outside repoRoot.
    assert.equal(await canRead(policy, join(dataHome, "candidate/profile.yml")), "allow");
    assert.equal(await canRead(policy, join(dataHome, "workspace/jobs/role.md")), "allow");

    // Still denied at the home-anchored root.
    assert.equal(await canRead(policy, join(dataHome, "candidate/form-defaults.yml")), "deny");
    assert.equal(await canRead(policy, join(dataHome, "internal/ai.env")), "deny");
    assert.equal(await canRead(policy, join(dataHome, "db/careerrat.db")), "deny");

    // node_modules itself stays denied as a segment, even nested under an
    // otherwise-approved root.
    assert.equal(await canRead(policy, join(dataHome, "workspace/node_modules/evil.js")), "deny");
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
    rmSync(dataHome, { recursive: true, force: true });
  }
});

test("Grep denies sweeping the candidate root itself because it would sweep in form-defaults.yml, in both layouts", async () => {
  for (const legacy of [true, false]) {
    const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-tool-policy-grepsweep-"));
    try {
      writeShippedAssets(repoRoot, "evaluate-job");
      const candidateDir = legacy
        ? join(repoRoot, "candidate")
        : join(repoRoot, ".careerrat/candidate");
      mkdirSync(candidateDir, { recursive: true });
      writeFileSync(join(candidateDir, "profile.yml"), "name: test", "utf8");
      writeFileSync(join(candidateDir, "form-defaults.yml"), "secret: 1", "utf8");

      const policy = createRuntimeToolPolicy({
        repoRoot,
        skill: "evaluate-job",
        tools: ["Grep"],
        env: {},
      });

      assert.equal(
        (await policy.canUseTool("Grep", { path: candidateDir, pattern: "x" })).behavior,
        "deny",
        `legacy=${legacy}`
      );
      assert.equal(
        (
          await policy.canUseTool("Grep", {
            path: join(candidateDir, "profile.yml"),
            pattern: "x",
          })
        ).behavior,
        "allow",
        `legacy=${legacy}`
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }
});

test("Grep denies a directory sweep when an approved workspace contains a nested env file", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-tool-policy-grep-env-"));
  try {
    writeShippedAssets(repoRoot, "evaluate-job");
    const workspaceDir = join(repoRoot, "workspace");
    const jobsDir = join(workspaceDir, "jobs");
    mkdirSync(jobsDir, { recursive: true });
    writeFileSync(join(jobsDir, "role.md"), "# role", "utf8");
    writeFileSync(join(jobsDir, ".env.local"), "SECRET=1", "utf8");

    const policy = createRuntimeToolPolicy({
      repoRoot,
      skill: "evaluate-job",
      tools: ["Grep"],
      env: {},
    });

    assert.equal(
      (await policy.canUseTool("Grep", { path: workspaceDir, pattern: "SECRET" })).behavior,
      "deny"
    );
    assert.equal(
      (
        await policy.canUseTool("Grep", {
          path: join(jobsDir, "role.md"),
          pattern: "role",
        })
      ).behavior,
      "allow"
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
