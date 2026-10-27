import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  defaultAutomation,
  loadSubmitMode,
  resolveSubmitMode,
} from "../src/core/automation/consent.mjs";
import { validate } from "../src/core/profile/schema-validator.mjs";
import { parseYaml } from "../src/core/profile/yaml.mjs";

const root = join(new URL("..", import.meta.url).pathname);

function legacyRoot(automationYaml) {
  const dir = mkdtempSync(join(tmpdir(), "careerrat-submit-mode-"));
  if (automationYaml !== undefined) {
    mkdirSync(join(dir, "candidate"), { recursive: true });
    writeFileSync(join(dir, "candidate", "automation.yml"), automationYaml);
  }
  return dir;
}

test("resolveSubmitMode defaults to auto when the key or config is absent", () => {
  assert.equal(resolveSubmitMode(undefined), "auto");
  assert.equal(resolveSubmitMode(null), "auto");
  assert.equal(resolveSubmitMode({}), "auto");
  assert.equal(resolveSubmitMode(defaultAutomation()), "auto");
  assert.equal(resolveSubmitMode({ setup_mode: "basic" }), "auto");
});

test("resolveSubmitMode returns manual only when explicitly set", () => {
  assert.equal(resolveSubmitMode({ submit: "manual" }), "manual");
  assert.equal(resolveSubmitMode({ submit: "auto" }), "auto");
});

test("resolveSubmitMode rejects any other value with a clear error", () => {
  for (const value of ["AUTO", "yes", "", true, 1, null, "manual "]) {
    assert.throws(
      () => resolveSubmitMode({ submit: value }),
      /submit must be "auto" or "manual"/,
      `value ${JSON.stringify(value)}`
    );
  }
});

test("loadSubmitMode reads candidate/automation.yml and defaults to auto without the file", () => {
  assert.equal(loadSubmitMode({ root: legacyRoot(), env: {} }), "auto");
  assert.equal(loadSubmitMode({ root: legacyRoot("version: 1\n"), env: {} }), "auto");
  assert.equal(
    loadSubmitMode({ root: legacyRoot("version: 1\nsubmit: manual\n"), env: {} }),
    "manual"
  );
  assert.throws(
    () => loadSubmitMode({ root: legacyRoot("version: 1\nsubmit: sometimes\n"), env: {} }),
    /submit must be "auto" or "manual"/
  );
});

test("the automation schema validates the submit key and the template documents it", () => {
  const schema = JSON.parse(readFileSync(join(root, "config/automation.schema.json"), "utf8"));
  assert.equal(validate({ version: 1, submit: "manual" }, schema).valid, true);
  assert.equal(validate({ version: 1, submit: "auto" }, schema).valid, true);
  assert.equal(validate({ version: 1, submit: "later" }, schema).valid, false);
  const template = readFileSync(join(root, "templates/automation.example.yml"), "utf8");
  assert.equal(parseYaml(template).submit, "auto");
  assert.equal(validate(parseYaml(template), schema).valid, true);
});
