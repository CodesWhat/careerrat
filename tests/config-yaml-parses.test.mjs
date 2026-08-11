import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parseYaml } from "../src/core/profile/yaml.mjs";

// Every YAML file CareerRat ships (config defaults, onboarding templates, example
// candidate) is read at runtime via parseYaml — a malformed one ships green
// through the suite and only fails when a user hits that code path (broken
// onboarding, blank dashboard identity). This guard parses every tracked .yml so
// a syntax slip is caught at commit time, the same cheap structural insurance as
// the embedded-CSS and embedded-JS template guards.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function trackedYamlFiles() {
  const out = execFileSync("git", ["ls-files", "*.yml", "*.yaml"], {
    cwd: root,
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

describe("shipped YAML config parses", () => {
  const files = trackedYamlFiles();

  it("finds YAML files to check", () => {
    assert.ok(files.length > 0, "expected at least one tracked .yml/.yaml file");
  });

  for (const rel of files) {
    it(`parses ${rel}`, () => {
      const text = readFileSync(join(root, rel), "utf8");
      assert.doesNotThrow(
        () => parseYaml(text),
        `${rel} is not valid YAML — it would break the code path that reads it`
      );
    });
  }
});
