import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);

function read(relativePath) {
  return readFileSync(new URL(relativePath, ROOT), "utf8");
}

const PRODUCT_FILES = [
  "config/form-defaults.schema.json",
  "config/automation.schema.json",
  "src/core/profile/candidate-defaults.mjs",
  "src/core/apply/form-fill.mjs",
  "src/core/apply/apply-driver.mjs",
  "src/core/automation/consent.mjs",
  "src/core/tracker/settings-snapshot.mjs",
  "src/core/agent/workspace-agent.mjs",
  ".agents/skills/apply-job/SKILL.md",
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

const PROSE_FILES = [
  "AGENTS.md",
  "templates/AGENTS.md",
  "apps/website/public/AGENTS.md",
  "README.md",
  "docs/ARCHITECTURE.md",
  "docs/BROWSER.md",
  "docs/DISCLAIMER.md",
  "docs/DATA_CONTRACT.md",
  "docs/foundations-spec.md",
  ".agents/skills/apply-job/SKILL.md",
  ".agents/skills/tailor-application/SKILL.md",
  ".agents/skills/ingest-profile/SKILL.md",
  "apps/docs/content/docs/advanced/browser-automation.mdx",
  "apps/docs/content/docs/getting-started/dashboard.mdx",
  "apps/docs/content/docs/getting-started/install.mdx",
  "apps/docs/content/docs/guides/applying.mdx",
  "apps/docs/content/docs/reference/disclaimer.mdx",
  "apps/docs/content/docs/reference/skills.mdx",
];

test("automation schema defines submit as auto or manual, defaulting to auto", () => {
  const schema = JSON.parse(read("config/automation.schema.json"));
  const submit = schema.properties.submit;

  assert.deepEqual(submit.enum, ["auto", "manual"]);
  assert.equal(submit.default, "auto");
});

test("final submission has no legacy setting, compatibility branch, or one-click capability", () => {
  for (const relativePath of PRODUCT_FILES) {
    const source = read(relativePath);
    assert.doesNotMatch(source, /auto_submit|shouldAutoSubmit|one[_ -]?click apply/i, relativePath);
  }
});

test("docs never say the person always presses Submit outside a manual-mode sentence", () => {
  const pattern =
    /you (still )?press submit|only the user can submit|never submits? (the|an) application/gi;

  for (const relativePath of PROSE_FILES) {
    const source = read(relativePath);
    for (const match of source.matchAll(pattern)) {
      const start = source.lastIndexOf("\n\n", match.index) + 2;
      const endIndex = source.indexOf("\n\n", match.index);
      const paragraph = source.slice(start, endIndex === -1 ? source.length : endIndex);
      assert.match(
        paragraph,
        /manual/i,
        `${relativePath}: "${match[0]}" needs a manual-mode context`
      );
    }
  }
});

test("the entry docs and apply-job skill explain how to get manual submit", () => {
  for (const relativePath of [
    "AGENTS.md",
    "README.md",
    "docs/BROWSER.md",
    ".agents/skills/apply-job/SKILL.md",
  ]) {
    assert.match(read(relativePath), /submit: manual|automation submit manual/, relativePath);
  }
});

test("prose points people at the submit command, not at hand-editing automation.yml", () => {
  for (const relativePath of [
    "README.md",
    "AGENTS.md",
    "templates/AGENTS.md",
    "apps/website/public/AGENTS.md",
    "docs/DISCLAIMER.md",
    "apps/docs/content/docs/guides/applying.mdx",
    "apps/docs/content/docs/reference/disclaimer.mdx",
    "src/core/agent/workspace-agent.mjs",
    "apps/web/src/chat-first/conversation-surfaces.jsx",
  ]) {
    assert.doesNotMatch(
      read(relativePath),
      /[Ss]et `?submit: manual`? in `?automation\.yml/,
      relativePath
    );
  }
  assert.match(read("README.md"), /careerrat automation submit manual --write/);
  assert.match(read("src/cli/automation.mjs"), /submit <auto\|manual> \[--write\]/);
});

test("onboarding does not ask about submit mode or persist a submission setting", () => {
  const skill = read(".agents/skills/ingest-profile/SKILL.md");

  assert.doesNotMatch(skill, /auto_submit|shouldAutoSubmit/i);
  assert.doesNotMatch(skill, /(ask|choose|pick|select)[^.\n]{0,40}submit (mode|setting)/i);
  assert.match(skill, /Don't ask about it during setup/);
});
