import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditLockfile } from "../scripts/check-lockfile.mjs";

const script = fileURLToPath(new URL("../scripts/check-lockfile.mjs", import.meta.url));
const badFixture = fileURLToPath(
  new URL("./fixtures/lockfile/known-bad-package-lock.json", import.meta.url)
);
const realLock = fileURLToPath(new URL("../package-lock.json", import.meta.url));

test("the known-bad fixture is rejected for every kind of problem", () => {
  const problems = auditLockfile(JSON.parse(readFileSync(badFixture, "utf8")));
  assert.equal(problems.length, 4);
  assert.match(problems.join("\n"), /no-integrity: missing or weak integrity/);
  assert.match(problems.join("\n"), /from-git: resolves outside the npm registry/);
  assert.match(problems.join("\n"), /other-host: resolves outside the npm registry/);
  assert.match(problems.join("\n"), /plain-http: resolves outside the npm registry/);
});

test("the CLI exits non-zero on the known-bad fixture", () => {
  const result = spawnSync(process.execPath, [script, badFixture], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /4 problem/);
});

test("the real package-lock.json passes", () => {
  const result = spawnSync(process.execPath, [script, realLock], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
