import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function* textFiles(directory, pattern) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* textFiles(path, pattern);
    else if (entry.isFile() && pattern.test(entry.name)) yield path;
  }
}

const RETIRED_PATHS = [
  "apps/web",
  "apps/desktop",
  "src/cli/tracker-dev.mjs",
  ".github/workflows/desktop-release.yml",
];

// A mention within two lines of a retirement word is allowed. QA-ACCEPTANCE.md
// is a historical ledger with its own retired banner, so it is skipped.
// A line that says the entry point is retired is allowed to name it.
const RETIRED_MENTION =
  /\b(?:retired|retire|removed|no longer|history|historical|ended|do not|don't|never)\b/i;
const ADVERTISED = /start --browser|tracker-dev|localhost:7777/;

test("the retired browser and desktop product paths stay deleted", () => {
  for (const path of RETIRED_PATHS) {
    assert.equal(existsSync(join(ROOT, path)), false, `${path} must stay deleted`);
  }
});

test("operational docs do not advertise the retired browser workspace", () => {
  const files = [
    join(ROOT, "README.md"),
    join(ROOT, "AGENTS.md"),
    join(ROOT, "templates/AGENTS.md"),
    ...textFiles(join(ROOT, "docs"), /\.md$/).filter((path) => !path.endsWith("QA-ACCEPTANCE.md")),
    ...textFiles(join(ROOT, "apps/docs/content"), /\.mdx?$/),
  ].filter((path) => existsSync(path));

  for (const path of files) {
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!ADVERTISED.test(line)) return;
      const context = lines.slice(Math.max(0, index - 2), index + 3).join("\n");
      if (RETIRED_MENTION.test(context)) return;
      assert.fail(`${path}:${index + 1} advertises a retired browser entry point: ${line.trim()}`);
    });
  }
});

test("the README keeps the note that the Mac app ended at v0.19.2", () => {
  assert.match(read("README.md"), /Mac app ended at v0\.19\.2/);
});
