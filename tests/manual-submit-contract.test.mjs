import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);

function read(relativePath) {
  return readFileSync(new URL(relativePath, ROOT), "utf8");
}

test("final submission has no setting, compatibility branch, or one-click capability", () => {
  const ownedRuntimeAndConfig = [
    "config/form-defaults.schema.json",
    "config/automation.schema.json",
    "src/core/profile/candidate-defaults.mjs",
    "src/core/apply/form-fill.mjs",
    "src/core/apply/apply-driver.mjs",
    "src/core/automation/consent.mjs",
    "src/core/tracker/settings-snapshot.mjs",
    "src/core/agent/workspace-agent.mjs",
    "templates/form-defaults.example.yml",
    "templates/automation.example.yml",
    "README.md",
    "AGENTS.md",
    "templates/AGENTS.md",
    "docs/ARCHITECTURE.md",
    "docs/BROWSER.md",
    "docs/DISCLAIMER.md",
    "docs/foundations-spec.md",
    "apps/docs/content/docs/advanced/browser-automation.mdx",
    "apps/docs/content/docs/guides/applying.mdx",
    "apps/docs/content/docs/reference/disclaimer.mdx",
    "apps/docs/content/docs/reference/skills.mdx",
    "apps/website/public/AGENTS.md",
    "examples/demo-workspace/candidate/form-defaults.yml",
    "examples/sample-candidate/form-defaults.yml",
    "examples/sample-candidate/README.md",
  ];

  for (const relativePath of ownedRuntimeAndConfig) {
    const source = read(relativePath);
    assert.doesNotMatch(source, /auto_submit|shouldAutoSubmit|one[_ -]?click apply/i, relativePath);
  }
});
