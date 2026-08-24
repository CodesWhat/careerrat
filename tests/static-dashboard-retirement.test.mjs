import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) yield path;
  }
}

const RETIRED_STATIC_DASHBOARD_FILES = [
  "src/core/tracker/dashboard-shell.html",
  "src/core/tracker/styles.mjs",
  "src/core/tracker/client-script.mjs",
  "scripts/tokenize-dashboard.mjs",
  "scripts/verify-themes.mjs",
  "scripts/shot-cards.mjs",
  "scripts/shot-funnel.mjs",
  "scripts/shot-status.mjs",
  "scripts/capture-demo-frames.mjs",
  "scripts/record-demo-video.mjs",
  "tests/styles.test.mjs",
  "tests/client-script.test.mjs",
  "src/core/scoring/sourced-intake.mjs",
  "tests/sourced-intake.test.mjs",
];

test("the retired static dashboard implementation cannot return", () => {
  for (const path of RETIRED_STATIC_DASHBOARD_FILES) {
    assert.equal(existsSync(join(ROOT, path)), false, `${path} must stay deleted`);
  }

  assert.equal(existsSync(join(ROOT, "src/core/tracker/dashboard.mjs")), true);
  assert.equal(existsSync(join(ROOT, "src/core/tracker/dashboard-data.js")), true);

  for (const path of sourceFiles(join(ROOT, "tests"))) {
    if (!path.endsWith(".test.mjs")) continue;
    if (path === fileURLToPath(import.meta.url)) continue;
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /dashboard-shell\.html|tracker-theme-|DASHBOARD_(?:CSS|SCRIPT)/,
      path
    );
  }

  assert.doesNotMatch(
    read("scripts/scan-sourced.mjs"),
    /tracker\.html|--format=tracker|--intake|--timestamped|\bintake\s*=|\btimestamped\s*=/,
    "the sourced scanner must not retain compatibility-only output modes or no-op flags"
  );

  const retainedWorkspaceMarker = join(ROOT, "src/core/paths/workspace.mjs");
  for (const directory of [join(ROOT, "src"), join(ROOT, "scripts")]) {
    for (const path of sourceFiles(directory)) {
      const source = readFileSync(path, "utf8");
      assert.doesNotMatch(source, /dashboard-shell|DASHBOARD_(?:CSS|SCRIPT)|tracker-theme-/, path);
      if (path !== retainedWorkspaceMarker) {
        assert.doesNotMatch(source, /tracker\.html/, path);
      }
    }
  }
});

test("operational docs do not advertise the retired static tracker dashboard", () => {
  for (const path of [
    "README.md",
    "AGENTS.md",
    "docs/ARCHITECTURE.md",
    "docs/SETUP.md",
    "docs/foundations-spec.md",
    "apps/docs/content/docs/getting-started/dashboard.mdx",
    "apps/docs/content/docs/advanced/data-model.mdx",
    "apps/docs/content/docs/advanced/agent-contract.mdx",
    "apps/docs/content/docs/guides/applying.mdx",
  ]) {
    const source = read(path);
    assert.doesNotMatch(source, /workspace\/tracker\.html/i, path);
    assert.doesNotMatch(source, /re-render(?:s|ed|ing)? (?:the )?dashboard/i, path);
    assert.doesNotMatch(source, /scan:sourced[^\n]*--(?:intake|timestamped)/i, path);
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
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /workspace\/tracker\.html/i, path);
    assert.doesNotMatch(source, /scan:sourced[^\n]*--(?:intake|timestamped)/i, path);
  }
});

test("scanner-owning skills consume complete structured output instead of the bounded summary", () => {
  for (const relativePath of [
    ".agents/skills/search-jobs/SKILL.md",
    ".agents/skills/discover-companies/SKILL.md",
  ]) {
    const source = read(relativePath);
    const scanCommands = source.match(/npm run scan:sourced[^\n`]*/g) || [];
    assert.ok(scanCommands.length > 0, `${relativePath} must retain its scanner handoff`);
    for (const command of scanCommands) {
      assert.doesNotMatch(command, /--summary/, `${relativePath} must consume full JSON`);
    }
  }
});
