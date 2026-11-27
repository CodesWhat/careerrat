#!/usr/bin/env node
// Pre-tag gate: runs the checks publish.yml runs, so a tag is only cut once
// publishing would succeed. The private sentinel list is required here, not
// skipped, because v0.26.0 passed a skipping pre-tag run and then failed publish.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const env = { ...process.env, CAREERRAT_PERSONAL_SENTINELS_REQUIRED: "1" };

const steps = [
  [
    "release tests",
    process.execPath,
    [
      "--test",
      "tests/release-consistency.test.mjs",
      "tests/release-gating-ci.test.mjs",
      "tests/release-workflow-chain.test.mjs",
      "tests/release-safety.test.mjs",
    ],
  ],
  ["publish dry run", "npm", ["publish", "--dry-run", "--ignore-scripts"]],
  ["packed-install smoke", "npm", ["run", "smoke:packed-install"]],
];

for (const [name, command, args] of steps) {
  console.log(`\n==> release:pretag: ${name}`);
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\nrelease:pretag failed at: ${name}. Do not tag.`);
    process.exit(result.status ?? 1);
  }
}
console.log("\nrelease:pretag passed. Safe to tag once the promotion head passes too.");
