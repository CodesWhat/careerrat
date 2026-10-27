import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadSubmitMode } from "../src/core/automation/consent.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import { candidateConfigGet, candidateSetupInitialize } from "../src/core/db/verbs/candidate.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("automation CLI saves an explicit Playwright session in a DB workspace", () => {
  const careerratHome = mkdtempSync(join(tmpdir(), "careerrat-automation-cli-"));
  const env = { ...process.env, CAREERRAT_HOME: careerratHome };
  try {
    candidateSetupInitialize({ repoRoot, env });
    closeAll();

    const result = spawnSync(
      process.execPath,
      ["src/cli/automation.mjs", "session", "playwright", "--write", "--json"],
      { cwd: repoRoot, env, encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).written, true);
    assert.equal(candidateConfigGet({ repoRoot, env }).automation.session.provider, "playwright");
  } finally {
    closeAll();
    rmSync(careerratHome, { recursive: true, force: true });
  }
});

function runAutomation(args, env, root = repoRoot) {
  return spawnSync(process.execPath, ["src/cli/automation.mjs", ...args, "--root", root], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}

test("automation submit is a dry run without --write and sets submit with it in a DB workspace", () => {
  const careerratHome = mkdtempSync(join(tmpdir(), "careerrat-automation-submit-db-"));
  const env = { ...process.env, CAREERRAT_HOME: careerratHome };
  try {
    candidateSetupInitialize({ repoRoot, env });
    closeAll();

    const dry = runAutomation(["submit", "manual", "--json"], env);
    assert.equal(dry.status, 0, dry.stderr || dry.stdout);
    const dryJson = JSON.parse(dry.stdout);
    assert.equal(dryJson.dryRun, true);
    assert.equal(dryJson.written, false);
    assert.equal(dryJson.value, "manual");
    assert.equal(loadSubmitMode({ root: repoRoot, env }), "auto");
    closeAll();

    const status = runAutomation(["status"], env);
    assert.match(status.stdout, /Final submit: auto/);

    const written = runAutomation(["submit", "manual", "--write", "--json"], env);
    assert.equal(written.status, 0, written.stderr || written.stdout);
    assert.equal(JSON.parse(written.stdout).written, true);
    assert.equal(loadSubmitMode({ root: repoRoot, env }), "manual");
    closeAll();

    const after = runAutomation(["status", "--json"], env);
    assert.equal(JSON.parse(after.stdout).submit, "manual");

    const back = runAutomation(["submit", "auto", "--write"], env);
    assert.equal(back.status, 0, back.stderr || back.stdout);
    assert.equal(loadSubmitMode({ root: repoRoot, env }), "auto");
  } finally {
    closeAll();
    rmSync(careerratHome, { recursive: true, force: true });
  }
});

test("automation submit writes candidate/automation.yml in a legacy workspace", () => {
  const legacyRoot = mkdtempSync(join(tmpdir(), "careerrat-automation-submit-legacy-"));
  const env = { ...process.env };
  delete env.CAREERRAT_HOME;
  try {
    mkdirSync(join(legacyRoot, "candidate"), { recursive: true });
    mkdirSync(join(legacyRoot, "templates"), { recursive: true });
    mkdirSync(join(legacyRoot, "config"), { recursive: true });
    cpSync(
      join(repoRoot, "templates/automation.example.yml"),
      join(legacyRoot, "templates/automation.example.yml")
    );
    cpSync(
      join(repoRoot, "config/automation.schema.json"),
      join(legacyRoot, "config/automation.schema.json")
    );

    const written = runAutomation(["submit", "manual", "--write", "--json"], env, legacyRoot);
    assert.equal(written.status, 0, written.stderr || written.stdout);
    assert.equal(JSON.parse(written.stdout).written, true);
    assert.match(
      readFileSync(join(legacyRoot, "candidate", "automation.yml"), "utf8"),
      /^submit: manual$/m
    );
    assert.equal(loadSubmitMode({ root: legacyRoot, env }), "manual");
  } finally {
    closeAll();
    rmSync(legacyRoot, { recursive: true, force: true });
  }
});

test("automation submit rejects values other than auto and manual", () => {
  for (const value of ["sometimes", "AUTO", ""]) {
    const args = value === "" ? ["submit"] : ["submit", value];
    const result = runAutomation([...args, "--write"], process.env);
    assert.equal(result.status, 1, `value ${JSON.stringify(value)}`);
    assert.match(result.stderr, /Usage: submit <auto\|manual>/);
  }
});
