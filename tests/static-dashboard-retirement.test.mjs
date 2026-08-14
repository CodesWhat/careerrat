import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

test("operational docs do not advertise the retired static tracker dashboard", () => {
  for (const path of [
    "README.md",
    "AGENTS.md",
    "docs/SETUP.md",
    "docs/foundations-spec.md",
    "apps/docs/content/docs/getting-started/dashboard.mdx",
    "apps/docs/content/docs/advanced/data-model.mdx",
    "apps/docs/content/docs/advanced/agent-contract.mdx",
    "apps/docs/content/docs/guides/applying.mdx",
  ]) {
    assert.doesNotMatch(read(path), /workspace\/tracker\.html/i, path);
    assert.doesNotMatch(read(path), /re-render(?:s|ed|ing)? (?:the )?dashboard/i, path);
  }

  const roadmap = read("docs/ROADMAP.md");
  assert.doesNotMatch(roadmap, /classic dashboard remains reachable/i);
  assert.doesNotMatch(roadmap, /classic dashboard retirement[^\n]*left/i);
  assert.doesNotMatch(roadmap, /dependency-free static dashboard/i);
  assert.doesNotMatch(roadmap, /same server-derived view model as the classic dashboard/i);
  assert.doesNotMatch(roadmap, /classic dashboard parity/i);

  const skillRoot = join(ROOT, ".agents", "skills");
  for (const entry of readdirSync(skillRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(skillRoot, entry.name, "SKILL.md");
    assert.doesNotMatch(readFileSync(path, "utf8"), /workspace\/tracker\.html/i, path);
  }
});
