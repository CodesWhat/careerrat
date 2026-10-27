import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CAPABILITIES, loadSubmitMode, mayRun } from "../src/core/automation/consent.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import { candidateConfigGet, candidateSetupInitialize } from "../src/core/db/verbs/candidate.mjs";
import { parseYaml } from "../src/core/profile/yaml.mjs";

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

test("automation CLI: a fresh DB workspace is all on, retired verbs are no-ops, and disable turns one capability off", () => {
  const careerratHome = mkdtempSync(join(tmpdir(), "careerrat-automation-onoff-db-"));
  const env = { ...process.env, CAREERRAT_HOME: careerratHome };
  try {
    candidateSetupInitialize({ repoRoot, env });
    closeAll();

    const fresh = JSON.parse(runAutomation(["status", "--json"], env).stdout);
    assert.equal(Object.hasOwn(fresh, "mode"), false);
    assert.equal(Object.hasOwn(fresh, "consent"), false);
    assert.ok(fresh.capabilities.every((cap) => cap.enabled));
    assert.ok(fresh.capabilities.every((cap) => cap.platforms.every((p) => p.allowed)));
    const text = runAutomation(["status"], env).stdout;
    assert.match(text, /Every capability is on unless you turn it off/);
    assert.doesNotMatch(text, /consent|Setup mode/i);

    const storedBefore = candidateConfigGet({ repoRoot, env }).automation;
    closeAll();
    for (const args of [
      ["consent", "linkedin", "--write"],
      ["revoke", "linkedin", "--write"],
      ["mode", "basic", "--write"],
      ["mode", "advanced", "--write"],
    ]) {
      const result = runAutomation(args, env);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /consent and setup mode were retired/);
      assert.match(result.stdout, /on unless disabled/);
    }
    assert.deepEqual(candidateConfigGet({ repoRoot, env }).automation, storedBefore);
    closeAll();

    const disabled = runAutomation(["disable", "mail_access", "--write", "--json"], env);
    assert.equal(disabled.status, 0, disabled.stderr || disabled.stdout);
    assert.equal(JSON.parse(disabled.stdout).written, true);
    closeAll();

    const after = JSON.parse(runAutomation(["status", "--json"], env).stdout);
    for (const cap of after.capabilities) {
      assert.equal(cap.enabled, cap.capability !== "mail_access", cap.capability);
    }
    const stored = candidateConfigGet({ repoRoot, env }).automation;
    assert.equal(stored.capabilities_default, "on");
    closeAll();
    const denied = mayRun({ capability: "mail_access", platform: "gmail", root: repoRoot, env });
    assert.equal(denied.allowed, false);
    assert.match(denied.reasons.join(" "), /careerrat automation enable mail_access --write/);
    assert.equal(
      mayRun({ capability: "messaging", platform: "linkedin", root: repoRoot, env }).allowed,
      true
    );
    closeAll();

    const back = runAutomation(["enable", "mail_access", "--write"], env);
    assert.equal(back.status, 0, back.stderr || back.stdout);
    closeAll();
    assert.equal(
      mayRun({ capability: "mail_access", platform: "gmail", root: repoRoot, env }).allowed,
      true
    );
  } finally {
    closeAll();
    rmSync(careerratHome, { recursive: true, force: true });
  }
});

test("automation CLI: a legacy all-off file reads as on without being written, and disable migrates it", () => {
  const legacyRoot = mkdtempSync(join(tmpdir(), "careerrat-automation-onoff-legacy-"));
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
    const file = join(legacyRoot, "candidate", "automation.yml");
    const legacyText = `version: 1
setup_mode: basic
submit: manual
consent:
  linkedin: false
capabilities:
  messaging:
    enabled: false
    platforms:
      linkedin: false
      wellfound: false
session:
  provider: playwright
  profile_root: null
`;
    writeFileSync(file, legacyText);

    const status = JSON.parse(runAutomation(["status", "--json"], env, legacyRoot).stdout);
    assert.ok(status.capabilities.every((cap) => cap.enabled));
    assert.equal(status.submit, "manual");
    assert.equal(readFileSync(file, "utf8"), legacyText, "reading must not write");

    const retired = runAutomation(["consent", "linkedin", "--write"], env, legacyRoot);
    assert.equal(retired.status, 0, retired.stderr || retired.stdout);
    assert.match(retired.stdout, /retired/);
    assert.equal(readFileSync(file, "utf8"), legacyText, "retired verbs must not write");

    const written = runAutomation(
      ["disable", "messaging", "linkedin", "--write", "--json"],
      env,
      legacyRoot
    );
    assert.equal(written.status, 0, written.stderr || written.stdout);
    const doc = parseYaml(readFileSync(file, "utf8"));
    assert.equal(doc.capabilities_default, "on");
    assert.equal(doc.capabilities.messaging.platforms.linkedin, false);
    assert.equal(doc.capabilities.messaging.platforms.wellfound, true);
    assert.equal(doc.submit, "manual");
    assert.equal(doc.session.provider, "playwright");
    assert.equal(Object.hasOwn(doc, "setup_mode"), false);
    assert.equal(Object.hasOwn(doc, "consent"), false);
    for (const [cap, def] of Object.entries(CAPABILITIES)) {
      if (cap === "messaging") continue;
      assert.equal(doc.capabilities[cap].enabled, true, cap);
      for (const platform of def.platforms) {
        assert.equal(doc.capabilities[cap].platforms[platform], true, `${cap}.${platform}`);
      }
    }
    const denied = mayRun({ capability: "messaging", platform: "linkedin", root: legacyRoot, env });
    assert.equal(denied.allowed, false);
    assert.match(
      denied.reasons.join(" "),
      /careerrat automation enable messaging linkedin --write/
    );
    assert.equal(
      mayRun({ capability: "messaging", platform: "wellfound", root: legacyRoot, env }).allowed,
      true
    );

    const again = runAutomation(["session", "orca", "--write"], env, legacyRoot);
    assert.equal(again.status, 0, again.stderr || again.stdout);
    assert.equal(
      parseYaml(readFileSync(file, "utf8")).capabilities.messaging.platforms.linkedin,
      false,
      "a later write keeps the explicit off"
    );
  } finally {
    closeAll();
    rmSync(legacyRoot, { recursive: true, force: true });
  }
});
